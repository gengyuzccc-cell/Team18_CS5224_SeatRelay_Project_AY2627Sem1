#!/usr/bin/env bash
# Run every Table 3 experiment (plan §4) against one target, three runs each, sequentially so that
# no experiment disturbs another's latency numbers; then the k6 performance matrix.
#   TARGET=dev tools/experiments/bin/run-table3.sh            # all rows
#   TARGET=dev ONLY="backfill expiry-race" tools/experiments/bin/run-table3.sh
#   SKIP_K6=1 TARGET=local tools/experiments/bin/run-table3.sh
# Each experiment writes results/<date>-<name>/ itself; this script only records the overall log
# and a one-line status per experiment in results/<date>-table3-<target>.status.
set -uo pipefail
TARGET="${TARGET:-dev}"
RUNS="${RUNS:-3}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DATE="$(date -u +%Y-%m-%d)"
STATUS="$ROOT/results/${DATE}-table3-${TARGET}.status"
export AWS_REGION="${AWS_REGION:-ap-southeast-1}"
cd "$ROOT"
mkdir -p results

ALL="correctness preference-order concurrency repeat-execution expiry-race failure-recovery access-control backfill"
LIST="${ONLY:-$ALL}"

declare -A ARGS=(
  [correctness]=""
  [preference-order]=""
  [concurrency]="--accounts 50"
  [repeat-execution]=""
  [expiry-race]="--hold 60"
  [failure-recovery]="--outage 60"
  [access-control]=""
  [backfill]="--offers 100"
)

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
echo "# Table 3 run on ${TARGET}, started $(date -u +%FT%TZ), commit $(git rev-parse --short HEAD)" >> "$STATUS"

for exp in $LIST; do
  log "=== ${exp} (target ${TARGET}, runs ${RUNS}) ==="
  start=$(date +%s)
  # shellcheck disable=SC2086
  pnpm --filter @seatrelay/experiments "$exp" --target "$TARGET" --runs "$RUNS" ${ARGS[$exp]:-}
  rc=$?
  printf '%s\t%s\texit=%s\t%ss\n' "$(date -u +%FT%TZ)" "$exp" "$rc" "$(( $(date +%s) - start ))" >> "$STATUS"
  log "=== ${exp} finished exit=${rc} ==="
done

if [[ -z "${SKIP_K6:-}" && -z "${ONLY:-}" ]]; then
  log "=== k6 performance matrix (target ${TARGET}) ==="
  start=$(date +%s)
  pnpm --filter @seatrelay/loadtest prepare-scenario -- --target "$TARGET" && \
    pnpm --filter @seatrelay/loadtest run-matrix -- --target "$TARGET"
  rc=$?
  printf '%s\t%s\texit=%s\t%ss\n' "$(date -u +%FT%TZ)" "k6-matrix" "$rc" "$(( $(date +%s) - start ))" >> "$STATUS"
  log "=== k6 matrix finished exit=${rc} ==="
fi
log "done; status in ${STATUS}"
