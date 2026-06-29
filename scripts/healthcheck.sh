#!/usr/bin/env bash
# CodeCrawler health probe for external monitors (UptimeRobot / cron / Caddy).
# Hits /api/health and exits non-zero if it is unreachable or not "ok".
#
# Usage:  scripts/healthcheck.sh [url]
# Env:
#   HEALTHCHECK_URL        Default URL if no argument given
#                          (default: https://codecrawler.merckel.dev/api/health)
#   HEALTHCHECK_TIMEOUT_S  curl timeout in seconds (default: 10)
#
# Exit codes: 0 = healthy, 1 = degraded (bad body), 2 = unreachable (curl error).
#
# Cron example (every 5 min, alert on failure):
#   */5 * * * * /opt/codecrawler/scripts/healthcheck.sh || \
#     /usr/bin/mail -s "[CodeCrawler] health DOWN" ops@merckel.dev < /dev/null
#
# With UptimeRobot: point a "keyword" monitor at the URL and watch for "ok".
set -euo pipefail

URL="${1:-${HEALTHCHECK_URL:-https://codecrawler.merckel.dev/api/health}}"
TIMEOUT="${HEALTHCHECK_TIMEOUT_S:-10}"

# -f: fail on HTTP 4xx/5xx, -S: show errors, -s: silent progress.
body="$(curl -fsS --max-time "$TIMEOUT" -H 'accept: application/json' "$URL" 2>&1)" \
  || { echo "[health] CRITICAL: request failed ($URL): $body" >&2; exit 2; }

# /api/health returns {"status":"ok","ts":...} — tolerate whitespace variants.
if printf '%s' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  echo "[health] OK: $URL -> $body"
  exit 0
fi

echo "[health] DEGRADED: unexpected body from $URL -> $body" >&2
exit 1
