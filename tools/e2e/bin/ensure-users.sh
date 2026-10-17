#!/usr/bin/env bash
# Creates (idempotently) the four Cognito accounts the browser walkthrough signs in with, and
# (re)sets their permanent password. No e-mail is sent (--message-action SUPPRESS).
#
#   pnpm --filter @seatrelay/e2e ensure-users
#   E2E_PREFIX=walkthrough SEATRELAY_TEST_PASSWORD=<private> POOL_ID=ap-southeast-1_ZZ7UsL6Ib bash tools/e2e/bin/ensure-users.sh
#
# The password comes from E2E_PASSWORD or SEATRELAY_TEST_PASSWORD; the repository is public, so the
# local stack's documented default is refused here.
#
# The display names carry "(staged)": every screen the walkthrough captures shows the signed-in
# account's name in the top bar, so the screenshots and the video label themselves as staged.
set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-1}"
PREFIX="${E2E_PREFIX:-walkthrough}"
PASSWORD="${E2E_PASSWORD:-${SEATRELAY_TEST_PASSWORD:-}}"
if [[ -z "$PASSWORD" || "$PASSWORD" == "Passw0rd!" ]]; then
  echo "set SEATRELAY_TEST_PASSWORD (or E2E_PASSWORD) to a private password; the documented default is public" >&2
  exit 1
fi
POOL_ID="${POOL_ID:-}"
if [[ -z "$POOL_ID" ]]; then
  POOL_ID="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "${AUTH_STACK:-seatrelay-auth}" \
    --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)"
fi
if [[ -z "$POOL_ID" || "$POOL_ID" == "None" ]]; then
  echo "no user pool id (set POOL_ID or deploy seatrelay-auth)" >&2
  exit 1
fi

declare -A NAMES=(
  [organiser]="Organiser (staged)"
  [alice]="Alice (staged)"
  [bob]="Bob (staged)"
  [carol]="Carol (staged)"
)

for who in organiser alice bob carol; do
  email="${PREFIX}-${who}@example.com"
  if aws cognito-idp admin-get-user --region "$REGION" --user-pool-id "$POOL_ID" --username "$email" >/dev/null 2>&1; then
    state="exists"
  else
    aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$POOL_ID" --username "$email" \
      --message-action SUPPRESS \
      --user-attributes Name=email,Value="$email" Name=email_verified,Value=true Name=name,Value="${NAMES[$who]}" \
      >/dev/null
    state="created"
  fi
  aws cognito-idp admin-set-user-password --region "$REGION" --user-pool-id "$POOL_ID" --username "$email" \
    --password "$PASSWORD" --permanent
  echo "$email  ${NAMES[$who]}  ($state, password set)"
done
