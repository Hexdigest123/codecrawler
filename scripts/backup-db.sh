#!/usr/bin/env bash
# CodeCrawler production DB backup.
# Dumps the prod Postgres DB to a timestamped gzip file and retains the last N.
#
# Usage:  scripts/backup-db.sh [output_dir]
# Env:
#   DB_CONTAINER       If set, run pg_dump via `podman exec $DB_CONTAINER`
#                      (a single named container). Otherwise run via
#                      `podman compose -f $DB_COMPOSE_FILE exec -T db pg_dump`.
#   DB_COMPOSE_FILE    Prod compose file (default: docker-compose.prod.yml).
#   BACKUP_MODE=host   Bypass podman and use a local pg_dump (reads DATABASE_URL
#                      or ~/.pgpass / PGPASSWORD). Use only with managed Postgres.
#   POSTGRES_USER      DB role (default: codecrawler).
#   POSTGRES_DB        DB name  (default: codecrawler).
#   BACKUP_RETENTION   Number of backups to keep (default: 14).
#   BACKUP_DIR         Default output dir if no argument is passed.
#
# The DB password is NEVER baked into this script. pg_dump runs INSIDE the
# container, where Postgres trusts the local socket (POSTGRES_PASSWORD already
# in the container env). For host mode, export PGPASSWORD or use ~/.pgpass.
#
# Cron example (daily at 02:00 UTC, log to /var/log):
#   0 2 * * * /opt/codecrawler/scripts/backup-db.sh >> /var/log/codecrawler-backup.log 2>&1
set -euo pipefail

OUTPUT_DIR="${1:-${BACKUP_DIR:-/opt/codecrawler/backups}}"
KEEP="${BACKUP_RETENTION:-14}"
POSTGRES_USER="${POSTGRES_USER:-codecrawler}"
POSTGRES_DB="${POSTGRES_DB:-codecrawler}"
DB_COMPOSE_FILE="${DB_COMPOSE_FILE:-docker-compose.prod.yml}"

mkdir -p "$OUTPUT_DIR"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
FILE="$OUTPUT_DIR/codecrawler-${STAMP}.sql.gz"

# pg_dump flags: -U role, -d db, clean ordering for restore.
DUMP_ARGS=(pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB")

run_dump() {
  if [[ "${BACKUP_MODE:-}" == "host" ]]; then
    # Host pg_dump (managed Postgres). No password on the command line.
    "${DUMP_ARGS[@]}"
  elif [[ -n "${DB_CONTAINER:-}" ]]; then
    podman exec "$DB_CONTAINER" "${DUMP_ARGS[@]}"
  else
    # Compose service (default). -T disables TTY so the pipe works under cron.
    (cd "$(dirname "$0")/.." && podman compose -f "$DB_COMPOSE_FILE" exec -T db "${DUMP_ARGS[@]}")
  fi
}

echo "[backup] dumping -> $FILE"
run_dump | gzip > "$FILE"

# Sanity check: a non-empty, valid gzip.
if [[ ! -s "$FILE" ]] || ! gzip -t "$FILE" 2>/dev/null; then
  echo "[backup] ERROR: dump failed or empty — removing $FILE" >&2
  rm -f "$FILE"
  exit 1
fi

# Retain the newest $KEEP backups; prune the rest.
# shellcheck disable=SC2012
ls -1t "$OUTPUT_DIR"/codecrawler-*.sql.gz 2>/dev/null \
  | tail -n +"$((KEEP + 1))" \
  | while IFS= read -r old; do
      rm -f "$old"
      echo "[backup] pruned $(basename "$old")"
    done

SIZE="$(du -h "$FILE" | cut -f1)"
echo "[backup] OK: wrote $FILE ($SIZE); retaining newest $KEEP in $OUTPUT_DIR"
