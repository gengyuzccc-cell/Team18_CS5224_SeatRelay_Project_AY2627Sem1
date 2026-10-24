#!/usr/bin/env bash
# One-shot deployment of a stage: lambda bundles -> app stack -> web stack -> SPA upload -> auth callback URLs.
#   STAGE=dev ALARM_EMAIL=team@example.com tools/scripts/bin/deploy-all.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require aws; require sam; require pnpm
AUTH_STACK="${AUTH_STACK:-seatrelay-auth}"
cd "$ROOT/services/aws"
if ! aws cloudformation describe-stacks --stack-name "$AUTH_STACK" >/dev/null 2>&1; then
  log "deploying $AUTH_STACK (first time)"
  sam deploy --config-env auth --parameter-overrides "MonthlyBudgetUsd=20 AnnualBudgetUsd=60 ${SENDER_EMAIL:+SenderEmail=$SENDER_EMAIL} ${BUDGET_EMAIL:+BudgetEmail=$BUDGET_EMAIL}"
fi
log "building lambda bundles"; (cd "$ROOT" && pnpm --filter @seatrelay/aws build)
log "deploying web stack seatrelay-web-$STAGE"; sam deploy --config-env "web-$STAGE"
WEB_URL="$(stack_output "seatrelay-web-$STAGE" WebUrl)"
log "deploying app stack seatrelay-app-$STAGE (WebOrigin=$WEB_URL)"
EXTRA="Stage=$STAGE WebOrigin=$WEB_URL ${ALARM_EMAIL:+AlarmEmail=$ALARM_EMAIL}"
if [[ "$STAGE" == "dev" ]]; then EXTRA="$EXTRA AllowFaultFlags=true EmailEnabled=${EMAIL_ENABLED:-true}"; else EXTRA="$EXTRA AllowFaultFlags=false EmailEnabled=${EMAIL_ENABLED:-true}"; fi
sam deploy --config-env "$STAGE" --parameter-overrides $EXTRA
log "registering $WEB_URL as Cognito callback/logout URL"
EXISTING_CB="$(aws cloudformation describe-stacks --stack-name "$AUTH_STACK" --query "Stacks[0].Parameters[?ParameterKey=='WebCallbackUrls'].ParameterValue" --output text)"
EXISTING_LO="$(aws cloudformation describe-stacks --stack-name "$AUTH_STACK" --query "Stacks[0].Parameters[?ParameterKey=='WebLogoutUrls'].ParameterValue" --output text)"
CB="$EXISTING_CB"; [[ "$CB" == *"$WEB_URL/callback"* ]] || CB="$CB,$WEB_URL/callback"
LO="$EXISTING_LO"; [[ "$LO" == *"$WEB_URL/"* ]] || LO="$LO,$WEB_URL/"
if [[ "$CB" != "$EXISTING_CB" || "$LO" != "$EXISTING_LO" ]]; then
  sam deploy --config-env auth --parameter-overrides "WebCallbackUrls=$CB" "WebLogoutUrls=$LO" \
    "MonthlyBudgetUsd=20" "AnnualBudgetUsd=60" ${SENDER_EMAIL:+SenderEmail=$SENDER_EMAIL} ${BUDGET_EMAIL:+BudgetEmail=$BUDGET_EMAIL}
fi
STAGE="$STAGE" "$ROOT/tools/scripts/bin/deploy-web.sh"
log "API: $(stack_output "seatrelay-app-$STAGE" ApiUrl)"; log "WEB: $WEB_URL"
