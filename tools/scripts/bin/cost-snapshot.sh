#!/usr/bin/env bash
# Daily cost snapshot (plan §3 step 24). Writes results/cost/snapshots/<date>.json with
# (a) Cost Explorer unblended + net costs by service for the last 30 days (net = after credits, shows 0
#     while credits last), and (b) raw usage quantities by usage type, which the pricing model uses.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require aws; require jq
OUT="$ROOT/results/cost/snapshots"; mkdir -p "$OUT"
END="$(date -u +%Y-%m-%d)"; START="$(date -u -d "$END -30 days" +%Y-%m-%d 2>/dev/null || date -u -v-30d +%Y-%m-%d)"
F="$OUT/$END.json"
aws ce get-cost-and-usage --time-period "Start=$START,End=$END" --granularity DAILY \
  --metrics UnblendedCost NetUnblendedCost UsageQuantity \
  --group-by Type=DIMENSION,Key=SERVICE \
  --filter '{"Tags":{"Key":"Project","Values":["SeatRelay"]}}' > "$F.byservice.tmp" || \
aws ce get-cost-and-usage --time-period "Start=$START,End=$END" --granularity DAILY \
  --metrics UnblendedCost NetUnblendedCost UsageQuantity --group-by Type=DIMENSION,Key=SERVICE > "$F.byservice.tmp"
aws ce get-cost-and-usage --time-period "Start=$START,End=$END" --granularity DAILY \
  --metrics UsageQuantity UnblendedCost --group-by Type=DIMENSION,Key=USAGE_TYPE > "$F.byusage.tmp"
jq -n --slurpfile s "$F.byservice.tmp" --slurpfile u "$F.byusage.tmp" \
  '{capturedAt: (now|todate), byService: $s[0], byUsageType: $u[0]}' > "$F"
rm -f "$F.byservice.tmp" "$F.byusage.tmp"
log "wrote $F"
