#!/usr/bin/env bash
# certbot deploy hook: copies an issued/renewed certificate into deploy/certs and reloads nginx.
#
#   certbot certonly --webroot -w /srv/erp/deploy/acme-webroot -d app.example.com \
#     --deploy-hook /srv/erp/deploy/certbot/deploy-hook.sh
#
# certbot exports RENEWED_LINEAGE (/etc/letsencrypt/live/<name>) and RENEWED_DOMAINS (space separated).
# Each domain of the certificate is mapped to a directory that erp-certs (inside the web container) reads:
#   SERVER_NAME      -> certs/platform/
#   *.SITES_DOMAIN   -> certs/sites/_wildcard/   (wildcards need the DNS-01 challenge)
#   other host names -> certs/sites/<host>/      (institute custom domains)
# Then `erp-certs --reload` validates the certificates, tests the nginx configuration and reloads nginx.
#
# Environment: SERVER_NAME, SITES_DOMAIN and ERP_CERTS_DIR (default: read from ERP_ENV_FILE, default
# deploy/.env; certificates default to deploy/certs), ERP_COMPOSE_FILE (default deploy/docker-compose.yml),
# ERP_COMPOSE_PROJECT (default: the compose file's name, "erp"), ERP_SKIP_RELOAD=1 to only copy.
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${ERP_ENV_FILE:-$DEPLOY_DIR/.env}
COMPOSE_FILE=${ERP_COMPOSE_FILE:-$DEPLOY_DIR/docker-compose.yml}

log() { echo "erp deploy-hook: $*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

# Reads KEY from the compose env file (last assignment wins; surrounding quotes removed).
env_value() {
  local value
  [[ -f "$ENV_FILE" ]] || return 0
  value=$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n 1)
  value=${value%"${value##*[![:space:]]}"}
  value=${value#\"}
  value=${value%\"}
  value=${value#\'}
  value=${value%\'}
  printf '%s' "$value"
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

[[ -n "${RENEWED_LINEAGE:-}" && -n "${RENEWED_DOMAINS:-}" ]] ||
  die 'RENEWED_LINEAGE and RENEWED_DOMAINS are not set (run as certbot --deploy-hook)'
[[ -f "$RENEWED_LINEAGE/fullchain.pem" && -f "$RENEWED_LINEAGE/privkey.pem" ]] ||
  die "no fullchain.pem/privkey.pem in $RENEWED_LINEAGE"

SERVER_NAME=$(lower "${SERVER_NAME:-$(env_value SERVER_NAME)}")
SITES_DOMAIN=$(lower "${SITES_DOMAIN:-$(env_value SITES_DOMAIN)}")
[[ -n "$SERVER_NAME" ]] || die "SERVER_NAME is not set and not found in $ENV_FILE"

# Same directory as the web service's certificate mount: relative paths are relative to deploy/, as in Compose.
CERTS_DIR=${ERP_CERTS_DIR:-$(env_value ERP_CERTS_DIR)}
CERTS_DIR=${CERTS_DIR:-./certs}
[[ "$CERTS_DIR" == /* ]] || CERTS_DIR=$DEPLOY_DIR/${CERTS_DIR#./}

# Copies the pair into DIR atomically (temporary files in the same directory, then rename).
install_into() {
  local dir=$1
  mkdir -p "$dir"
  chmod 0700 "$dir"
  (
    umask 077
    cp -L "$RENEWED_LINEAGE/fullchain.pem" "$dir/.fullchain.pem.new"
    cp -L "$RENEWED_LINEAGE/privkey.pem" "$dir/.privkey.pem.new"
  )
  mv -f "$dir/.fullchain.pem.new" "$dir/fullchain.pem"
  mv -f "$dir/.privkey.pem.new" "$dir/privkey.pem"
  log "installed $RENEWED_LINEAGE into $dir"
}

installed=0
for domain in $RENEWED_DOMAINS; do
  domain=$(lower "$domain")
  if [[ "$domain" == "$SERVER_NAME" ]]; then
    install_into "$CERTS_DIR/platform"
  elif [[ -n "$SITES_DOMAIN" && "$domain" == "*.$SITES_DOMAIN" ]]; then
    install_into "$CERTS_DIR/sites/_wildcard"
  elif [[ "$domain" == \*.* ]]; then
    log "skipping $domain: only the *.SITES_DOMAIN wildcard is supported"
    continue
  elif [[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
    install_into "$CERTS_DIR/sites/$domain"
  else
    log "skipping $domain: not a valid host name"
    continue
  fi
  installed=$((installed + 1))
done
((installed > 0)) || die "none of the domains ($RENEWED_DOMAINS) could be installed"

if [[ "${ERP_SKIP_RELOAD:-0}" == 1 ]]; then
  log 'ERP_SKIP_RELOAD=1: not reloading nginx'
  exit 0
fi
compose=(docker compose -f "$COMPOSE_FILE")
if [[ -f "$ENV_FILE" ]]; then compose+=(--env-file "$ENV_FILE"); fi
if [[ -n "${ERP_COMPOSE_PROJECT:-}" ]]; then compose+=(-p "$ERP_COMPOSE_PROJECT"); fi
"${compose[@]}" exec -T web erp-certs --reload
