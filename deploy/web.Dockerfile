# syntax=docker/dockerfile:1
# Web image: the built Vue/Ionic SPA served by nginx, which also terminates TLS, proxies /api/ and the
# live-class WebSocket to the API, and serves institute websites (custom domains / subdomains).
#
#   docker build -f deploy/web.Dockerfile --build-arg VITE_API_URL=https://app.example.com -t erp-web:TAG .
#
# VITE_API_URL must be the absolute public origin: the app builds request URLs with
# `new URL(VITE_API_URL + '/api/...')`, so an empty/relative value does not work. The image is therefore
# specific to one public origin. Runtime settings (SERVER_NAME, SITES_DOMAIN, ...) are documented in
# deploy/nginx/entrypoint/18-erp-config.envsh and docs/deployment.md. Build context: the repository root.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:1.30-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /srv/erp
# npm ci validates every workspace against the lockfile, so all workspace manifests are needed.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/
COPY app/package.json app/
COPY e2e/package.json e2e/
COPY load/package.json load/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund -w @erp/shared -w app
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY app/ app/
ARG VITE_API_URL
RUN case "${VITE_API_URL:-}" in \
      http://* | https://*) ;; \
      *) echo "VITE_API_URL build arg must be the absolute public origin, e.g. https://app.example.com" >&2; exit 1 ;; \
    esac \
    && npm run build -w @erp/shared \
    && npm run build -w app

FROM ${NGINX_IMAGE} AS runtime
RUN apk add --no-cache openssl \
    && rm -f /etc/nginx/conf.d/default.conf \
    && rm -rf /usr/share/nginx/html/* \
    && mkdir -p /etc/nginx/erp /etc/nginx/erp-generated /etc/nginx/certs /var/www/acme

COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/templates/ /etc/nginx/templates/
# .envsh hooks are only sourced by the image entrypoint when they are executable.
COPY --chmod=0755 deploy/nginx/entrypoint/ /docker-entrypoint.d/
COPY --chmod=0755 deploy/nginx/erp-certs.sh /usr/local/bin/erp-certs
COPY --from=build /srv/erp/app/dist/ /usr/share/nginx/html/

ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="erp-web" \
      org.opencontainers.image.description="Coaching ERP/LMS web app and reverse proxy" \
      org.opencontainers.image.version="${APP_VERSION}"

# Templates render into /etc/nginx/erp; only the variables below are substituted, so nginx's own
# $variables are left alone. 15-local-resolvers.envsh exports NGINX_LOCAL_RESOLVERS (Docker DNS).
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/erp \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENVSUBST_FILTER="^(SERVER_NAME|SITES_SERVER_NAME|API_UPSTREAM|CLIENT_MAX_BODY_SIZE|HTTPS_PORT_SUFFIX|SPA_CSP|SPA_CSP_HEADER|HSTS_HEADER|NGINX_LOCAL_RESOLVERS)\$" \
    TLS_SELF_SIGNED_FALLBACK=false

EXPOSE 80 443
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/nginx-health || exit 1
