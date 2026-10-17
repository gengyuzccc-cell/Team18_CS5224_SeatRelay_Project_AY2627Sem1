#!/usr/bin/env bash
# Sets the permanent password of every test account in the stages' Cognito pool to
# $SEATRELAY_TEST_PASSWORD and signs them out everywhere (revokes their refresh tokens).
#
#   SEATRELAY_TEST_PASSWORD='<private>' tools/scripts/bin/reset-test-passwords.sh
#
# Test accounts are the synthetic ones the tools create: e-mail @example.com, or the SES mailbox
# simulator (@simulator.amazonses.com) the pilot rehearsal uses. Anyone else in the pool (a team
# member's or a pilot participant's own account) is left alone. The repository is public, so the
# local stack's documented default is refused. ID tokens already issued stay valid until they
# expire (12 h): API Gateway's JWT authorizer checks signature, expiry and audience only.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require aws; require jq
PASSWORD="${SEATRELAY_TEST_PASSWORD:-}"
if [[ -z "$PASSWORD" || "$PASSWORD" == "Passw0rd!" ]]; then
  echo "set SEATRELAY_TEST_PASSWORD to a private password (the documented default is public)" >&2
  exit 1
fi
POOL_ID="${POOL_ID:-$(stack_output "${AUTH_STACK:-seatrelay-auth}" UserPoolId)}"
if [[ -z "$POOL_ID" || "$POOL_ID" == "None" ]]; then
  echo "no user pool id (set POOL_ID or deploy seatrelay-auth)" >&2
  exit 1
fi

# username<TAB>email of every user whose e-mail is synthetic (list-users paginates on its own)
mapfile -t USERS < <(aws cognito-idp list-users --user-pool-id "$POOL_ID" --output json |
  jq -r '.Users[] | [.Username, ((.Attributes // [])[] | select(.Name == "email") | .Value)] | @tsv' |
  awk -F '\t' '$2 ~ /@(example\.com|simulator\.amazonses\.com)$/')
log "pool $POOL_ID: ${#USERS[@]} test accounts"
for row in "${USERS[@]}"; do
  username="${row%%$'\t'*}"
  aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" --username "$username" \
    --password "$PASSWORD" --permanent
  aws cognito-idp admin-user-global-sign-out --user-pool-id "$POOL_ID" --username "$username"
done
log "reset ${#USERS[@]} passwords and signed the accounts out; delete tools/loadtest/.token-cache.*.json to mint fresh tokens"
