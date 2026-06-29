#!/usr/bin/env bash
# CodeCrawler production DB restore.
# DESTRUCTIVE: replaces DB contents from a gzip'd pg_dump backup.
#
# Usage:  scripts/restore-db.sh <backup_file>
# Env:
#   DB_CONTAINER       If set, restore via `podman exec -i $DB_CONTAINER psql`.
#                      Otherwise via `podman compose -f $DB_COMPOSE_FILE exec -T db psql`.
#   DB_COMPOSE_FILE    Prod compose file (default: docker-compose.prod.yml).
#   BACKUP_MODE=host   Use a local psql (reads DATABASE_URL / ~/.pgpass).
#   POSTGRES_USER      DB role (default: codecrawler).
#   POSTGRES_DB        DB name  (default: codecrawler).
#   FORCE_RESTORE=1    Skip the interactive confirmation (non-interactive use).
#   RESTORE_DROP_SCHEMA=1  DROP SCHEMA public first for a clean slate
#                      (recommended when overwriting an existing DB).
#
# Restore flow:
#   1. Stop API + worker (so nothing writes during restore):
#        podman compose -f docker-compose.prod.yml stop api worker
#   2. scripts/restore-db.sh backups/codecrawler-20260101-020000.sql.gz
#   3. Re-run migrations to reconcile, then restart:
#        bun run db:migrate   # or inside the api container
#        podman compose -f docker-compose.prod.yml up -d api worker
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <backup_file>" >&2
  exit 64
fi

BACKUP="$1"
[[ -f "$BACKUP" ]] || { echo "ERROR: backup file not found: $BACKUP" >&2; exit 66; }

POSTGRES_USER="${POSTGRES_USER:-codecrawler}"
POSTGRES_DB="${POSTGRES_DB:-codecrawler}"
DB_COMPOSE_FILE="${DB_COMPOSE_FILE:-docker-compose.prod.yml}"

# Destructive action — require explicit confirmation unless forced.
if [[ "${FORCE_RESTORE:-0}" != "1" ]]; then
  echo "!! This will OVERWRITE the '$POSTGRES_DB' database from: $BACKUP"
  echo "!! Stop api + worker first. Type the DB name ('$POSTGRES_DB') to confirm:"
  printf "> "
  read -r confirm
  if [[ "$confirm" != "$POSTGRES_DB" ]]; then
    echo "Aborted (no match)."
    exit 1
  fi
fi

# Resolve how to reach psql inside the running prod DB.
psql_exec() {
  local args=(psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 "$@")
  if [[ "${BACKUP_MODE:-}" == "host" ]]; then
    "${args[@]}"
  elif [[ -n "${DB_CONTAINER:-}" ]]; then
    podman exec -i "$DB_CONTAINER" "${args[@]}"
  else
    (cd "$(dirname "$0")/.." && podman compose -f "$DB_COMPOSE_FILE" exec -T db "${args[@]}")
  fi
}

if [[ "${RESTORE_DROP_SCHEMA:-0}" == "1" ]]; then
  echo "[restore] dropping & recreating public schema..."
  psql_exec -c "DROP SCHEMA public CASCADE;" \
            -c "CREATE SCHEMA public;" \
            -c "GRANT ALL ON SCHEMA public TO ${POSTGRES_USER};" \
            -c "GRANT ALL ON SCHEMA public TO public;"
fi

echo "[restore] loading $BACKUP into $POSTGRES_DB..."
gunzip -c "$BACKUP" | psql_exec
echo "[restore] done. Run \`bun run db:migrate\` to reconcile migrations, then restart api + worker."
