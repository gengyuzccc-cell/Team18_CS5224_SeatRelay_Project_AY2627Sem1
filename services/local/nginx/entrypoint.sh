#!/bin/sh
# Generate /env.js from VITE_* variables so that one SPA build serves both deployments.
set -eu
cat > /usr/share/nginx/html/env.js <<EOT
window.__SEATRELAY_ENV__ = {
  provider: '${VITE_OIDC_PROVIDER:-keycloak}',
  authority: '${VITE_OIDC_AUTHORITY:-http://localhost:8080/realms/seatrelay}',
  clientId: '${VITE_OIDC_CLIENT_ID:-seatrelay-web}',
  hostedUiDomain: '${VITE_HOSTED_UI_DOMAIN:-}',
  apiBaseUrl: '${VITE_API_BASE_URL:-http://localhost:3000}',
  stage: 'local'
};
EOT
exec nginx -g 'daemon off;'
