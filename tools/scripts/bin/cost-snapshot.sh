#!/usr/bin/env bash
# Daily cost snapshot (plan §3 step 24). Writes results/cost/snapshots/<date>.json with
# (a) Cost Explorer unblended + net costs by service for the last 30 days (net = after credits, shows 0
#     while credits last), and (b) raw usage quantities by usage type, which the pricing model uses.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require aws; require jq
OUT="$ROOT/results/cost/snapshots"; mkdir -p "$OUT"
END="$(date -u +%Y-%m-%d)"; START="$(date -u -d "$END -30 days" +%Y-%m-%d 2>/dev/null || date -u -v-30d +%Y-%m-%d)"
F="$OUT/$END.json"
# Both queries are filtered to the cost allocation tag Project=SeatRelay so that other workloads of
# the account do not inflate the measured usage. Before the tag is active (24 h after activation)
# the filtered call fails; the query then falls back to the whole account, and the snapshot
# records which queries were filtered ("filter" block; cost/model.py --from-snapshot reports it).
TAG_FILTER='{"Tags":{"Key":"Project","Values":["SeatRelay"]}}'
ce() { aws ce get-cost-and-usage --time-period "Start=$START,End=$END" --granularity DAILY "$@"; }
SERVICE_FILTERED=true
ce --metrics UnblendedCost NetUnblendedCost UsageQuantity --group-by Type=DIMENSION,Key=SERVICE \
  --filter "$TAG_FILTER" > "$F.byservice.tmp" || {
  SERVICE_FILTERED=false
  log "byService: the Project=SeatRelay tag filter failed (tag not active?); querying the whole account"
  ce --metrics UnblendedCost NetUnblendedCost UsageQuantity --group-by Type=DIMENSION,Key=SERVICE > "$F.byservice.tmp"
}
USAGE_FILTERED=true
ce --metrics UsageQuantity UnblendedCost --group-by Type=DIMENSION,Key=USAGE_TYPE \
  --filter "$TAG_FILTER" > "$F.byusage.tmp" || {
  USAGE_FILTERED=false
  log "byUsageType: the Project=SeatRelay tag filter failed (tag not active?); querying the whole account"
  ce --metrics UsageQuantity UnblendedCost --group-by Type=DIMENSION,Key=USAGE_TYPE > "$F.byusage.tmp"
}
jq -n --slurpfile s "$F.byservice.tmp" --slurpfile u "$F.byusage.tmp" \
  --argjson sf "$SERVICE_FILTERED" --argjson uf "$USAGE_FILTERED" \
  '{capturedAt: (now|todate), filter: {tag: "Project=SeatRelay", byService: $sf, byUsageType: $uf},
    byService: $s[0], byUsageType: $u[0]}' > "$F"
rm -f "$F.byservice.tmp" "$F.byusage.tmp"
log "wrote $F"
