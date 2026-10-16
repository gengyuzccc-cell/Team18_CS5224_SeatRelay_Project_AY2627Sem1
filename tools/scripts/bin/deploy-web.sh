#!/usr/bin/env bash
# Build the SPA for a stage and publish it to the stage's S3 bucket + CloudFront (plan §2.4 web stack).
#   STAGE=dev tools/scripts/bin/deploy-web.sh
# Hashed assets are uploaded as immutable (1 year); index.html and env.js are no-cache; then
# CloudFront is invalidated for /index.html and /env.js only.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require aws; require pnpm

APP_STACK="seatrelay-app-${STAGE}"; WEB_STACK="seatrelay-web-${STAGE}"; AUTH_STACK="${AUTH_STACK:-seatrelay-auth}"
BUCKET="$(stack_output "$WEB_STACK" BucketName)"
DIST_ID="$(stack_output "$WEB_STACK" DistributionId)"
WEB_URL="$(stack_output "$WEB_STACK" WebUrl)"
API_URL="$(stack_output "$APP_STACK" ApiUrl)"
ISSUER="$(stack_output "$AUTH_STACK" Issuer)"
CLIENT_ID="$(stack_output "$AUTH_STACK" WebClientId)"
HOSTED_UI="$(stack_output "$AUTH_STACK" HostedUiDomain)"
log "stage=$STAGE bucket=$BUCKET dist=$DIST_ID web=$WEB_URL api=$API_URL"

# Runtime configuration is injected as /env.js so the SAME build works for CloudFront and nginx.
mkdir -p "$ROOT/apps/web/public"
cat > "$ROOT/apps/web/public/env.js" <<EOT
window.__SEATRELAY_ENV__ = {
  provider: 'cognito',
  authority: '${ISSUER}',
  clientId: '${CLIENT_ID}',
  hostedUiDomain: '${HOSTED_UI}',
  apiBaseUrl: '${API_URL}',
  stage: '${STAGE}'
};
EOT
(cd "$ROOT" && pnpm --filter @seatrelay/web build)

DIST="$ROOT/apps/web/dist"
aws s3 sync "$DIST/assets" "s3://$BUCKET/assets" --delete \
  --cache-control "public,max-age=31536000,immutable"
aws s3 sync "$DIST" "s3://$BUCKET" --exclude "assets/*" --exclude "index.html" --exclude "env.js" \
  --cache-control "public,max-age=3600"
aws s3 cp "$DIST/index.html" "s3://$BUCKET/index.html" --cache-control "no-cache,no-store,must-revalidate" --content-type "text/html"
aws s3 cp "$DIST/env.js" "s3://$BUCKET/env.js" --cache-control "no-cache,no-store,must-revalidate" --content-type "application/javascript"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/index.html" "/env.js" "/" >/dev/null
log "published: $WEB_URL"
