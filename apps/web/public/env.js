/* global window */
// Runtime configuration for `pnpm dev` (local docker-compose stack: Keycloak + Fastify API).
// Deployments overwrite this file: tools/scripts/bin/deploy-web.sh (Cognito + API Gateway) and
// services/local/nginx/entrypoint.sh (VITE_* variables). Fields:
//   provider        'cognito' | 'keycloak'   logout flow (Cognito has no end_session_endpoint)
//   authority       OIDC issuer (discovery at <authority>/.well-known/openid-configuration)
//   clientId        public PKCE client id; also the `aud` the API checks on the ID token
//   hostedUiDomain  Cognito hosted UI base URL (https://...amazoncognito.com); '' for Keycloak
//   apiBaseUrl      API origin without trailing slash
//   stage           label shown in the header badge ('local' | 'dev' | 'pilot')
window.__SEATRELAY_ENV__ = {
  provider: 'keycloak',
  authority: 'http://localhost:8080/realms/seatrelay',
  clientId: 'seatrelay-web',
  hostedUiDomain: '',
  apiBaseUrl: 'http://localhost:3000',
  stage: 'local',
};
