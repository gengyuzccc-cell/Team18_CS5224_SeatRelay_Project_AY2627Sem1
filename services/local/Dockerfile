# syntax=docker/dockerfile:1.7
# SeatRelay on-premise reference (plan §2.7). Build context = the repository root
# (docker-compose.yml: `context: ../..`, `target: server | web`).
#
#   base      node:22-alpine + pnpm, workspace install (frozen lockfile), sources
#   server    the Fastify API + in-process worker/timer/sweep/notifier/janitor loops, port 3000
#   webbuild  `vite build` of apps/web (one SPA build for CloudFront and nginx)
#   web       nginx:1.27-alpine serving that build; /env.js is generated at container start

ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine
ARG PNPM_VERSION=10.28.0

# ------------------------------------------------------------------------------ base
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION

# Behind a TLS-intercepting proxy: any *.crt / *.pem dropped into
# services/local/docker/ca-certificates/ is appended to the system bundle (used by wget) and
# handed to Node (corepack, pnpm) through NODE_EXTRA_CA_CERTS. No-op when the folder is empty.
COPY services/local/docker/ca-certificates/ /usr/local/share/ca-certificates/extra/
RUN for f in /usr/local/share/ca-certificates/extra/*; do \
      case "$f" in *.crt|*.pem) cat "$f" >> /etc/ssl/certs/ca-certificates.crt ;; esac; \
    done
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /app
ENV CI=true

# Manifests first so that the dependency layer is cached until a manifest or the lockfile changes.
# Every workspace package's manifest is needed: a frozen install checks the whole workspace.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/service/package.json packages/service/
COPY services/aws/package.json services/aws/
COPY services/local/package.json services/local/
COPY apps/web/package.json apps/web/
COPY tools/experiments/package.json tools/experiments/
COPY tools/loadtest/package.json tools/loadtest/
COPY tools/replay/package.json tools/replay/
COPY tools/scripts/package.json tools/scripts/
RUN pnpm install --frozen-lockfile --filter "@seatrelay/local..." --filter "@seatrelay/web..."

# Sources (libraries are consumed from source: no build step, CONVENTIONS §2).
COPY packages ./packages
COPY services/local ./services/local
COPY apps/web ./apps/web

# ------------------------------------------------------------------------------ server
FROM base AS server
WORKDIR /app/services/local
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=10 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
USER node
# tsx registered as a loader: one Node process (signals reach the graceful shutdown in main.ts).
CMD ["node", "--import", "tsx", "src/main.ts"]

# ------------------------------------------------------------------------------ web
FROM base AS webbuild
RUN pnpm --filter @seatrelay/web build

FROM ${NGINX_IMAGE} AS web
COPY --from=webbuild /app/apps/web/dist /usr/share/nginx/html
COPY services/local/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 services/local/nginx/entrypoint.sh /entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
