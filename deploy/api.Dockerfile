# syntax=docker/dockerfile:1
# API image: Express + Socket.IO + the in-process jobs worker, plus the database CLI for migrations.
#
#   docker build -f deploy/api.Dockerfile --build-arg APP_VERSION="$(git describe --tags --always)" -t erp-api:TAG .
#   docker run --rm --env-file .env erp-api:TAG node dist/infrastructure/database/cli.js migrate
#
# Build context: the repository root (see /.dockerignore). Runs as the unprivileged `node` user.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- npm manifests only, so the dependency layers stay cached until a manifest changes ----
FROM ${NODE_IMAGE} AS manifests
WORKDIR /srv/erp
# npm ci validates every workspace of the root package.json against the lockfile, so all workspace
# manifests are copied even though only @erp/shared and backend are installed.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/
COPY app/package.json app/
COPY e2e/package.json e2e/
COPY load/package.json load/

# ---- build: full dependencies of @erp/shared + backend, then compile both ----
FROM manifests AS build
# --ignore-scripts: skips the root postinstall (it builds @erp/shared, done explicitly below); no
# runtime dependency needs an install script.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund -w @erp/shared -w backend
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY backend/ backend/
RUN npm run build -w @erp/shared && npm run build -w backend

# ---- production dependencies only ----
FROM manifests AS prod-deps
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w @erp/shared -w backend \
    && mkdir -p backend/node_modules packages/shared/node_modules

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
# ffmpeg converts uploaded lectures to HLS; without it videos stream as progressive MP4
# (transcodeStatus "unavailable"). Build with --build-arg INSTALL_FFMPEG=false for a smaller image.
ARG INSTALL_FFMPEG=true
RUN if [ "$INSTALL_FFMPEG" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends ffmpeg \
      && rm -rf /var/lib/apt/lists/*; \
    fi

ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="erp-api" \
      org.opencontainers.image.description="Coaching ERP/LMS API" \
      org.opencontainers.image.version="${APP_VERSION}"

# STORAGE_LOCAL_ROOT is the media volume; TMPDIR keeps upload staging, HLS work dirs and generated PDFs
# on the api-tmp volume (backend/tmp also holds multer and chunked-upload staging) instead of the
# container's writable layer.
ENV NODE_ENV=production \
    PORT=4000 \
    APP_VERSION=${APP_VERSION} \
    STORAGE_DRIVER=local \
    STORAGE_LOCAL_ROOT=/var/lib/erp/storage \
    TMPDIR=/srv/erp/backend/tmp

WORKDIR /srv/erp
COPY --from=prod-deps /srv/erp/package.json ./
COPY --from=prod-deps /srv/erp/node_modules ./node_modules
# backend resolves @erp/shared through the node_modules/@erp/shared -> packages/shared workspace symlink.
COPY --from=build /srv/erp/packages/shared/package.json packages/shared/
COPY --from=build /srv/erp/packages/shared/dist packages/shared/dist
COPY --from=prod-deps /srv/erp/packages/shared/node_modules packages/shared/node_modules
COPY --from=build /srv/erp/backend/package.json backend/
COPY --from=build /srv/erp/backend/dist backend/dist
COPY --from=prod-deps /srv/erp/backend/node_modules backend/node_modules

RUN mkdir -p /var/lib/erp/storage /srv/erp/backend/tmp \
    && chown node:node /var/lib/erp/storage /srv/erp/backend/tmp

USER node
WORKDIR /srv/erp/backend
VOLUME ["/var/lib/erp/storage"]
EXPOSE 4000

# The slim image has no curl: probe readiness (database, migrations, storage) with Node's fetch.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
