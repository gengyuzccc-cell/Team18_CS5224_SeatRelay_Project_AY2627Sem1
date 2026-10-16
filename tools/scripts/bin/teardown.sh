#!/usr/bin/env bash
# Delete a stage's app + web stacks (NEVER the auth stack). Empties the S3 bucket first, otherwise
# CloudFormation cannot delete it (plan §2.4).  STAGE=dev tools/scripts/bin/teardown.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require aws
[[ "$STAGE" == "dev" || "$STAGE" == "pilot" ]] || { echo "STAGE must be dev|pilot" >&2; exit 1; }
WEB_STACK="seatrelay-web-${STAGE}"; APP_STACK="seatrelay-app-${STAGE}"
if BUCKET="$(stack_output "$WEB_STACK" BucketName 2>/dev/null)" && [[ -n "$BUCKET" && "$BUCKET" != "None" ]]; then
  log "emptying s3://$BUCKET"; aws s3 rm "s3://$BUCKET" --recursive >/dev/null || true
  log "deleting $WEB_STACK"; aws cloudformation delete-stack --stack-name "$WEB_STACK"
  aws cloudformation wait stack-delete-complete --stack-name "$WEB_STACK"
fi
if [[ "$STAGE" == "pilot" ]]; then
  log "pilot table has deletion protection; disabling it first"
  aws dynamodb update-table --table-name "seatrelay-pilot" --no-deletion-protection-enabled >/dev/null || true
fi
log "deleting $APP_STACK"; aws cloudformation delete-stack --stack-name "$APP_STACK"
aws cloudformation wait stack-delete-complete --stack-name "$APP_STACK"
log "done (auth stack kept)"
