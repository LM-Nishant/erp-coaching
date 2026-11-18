#!/usr/bin/env bash
# End-to-end smoke test of the production stack (deploy/docker-compose.yml) for CI and anyone with
# Docker + Compose v2. Builds the images, starts mysql/migrate/api/web under a separate project name with
# throwaway secrets and a throwaway certificate authority, then checks everything through nginx:
#   health/readiness, http->https redirect, ACME webroot, SPA (fallback, caching, security headers,
#   report-only CSP), API headers and request ids, CORS for the Capacitor origin, Socket.IO polling
#   handshake and WebSocket upgrade, institute websites on a custom domain (per-SNI certificate), a
#   *.SITES_DOMAIN subdomain and a domain without certificate, super admin seeding (weak password
#   refused, strong accepted) and login, migration status, nginx config test + certificate reload,
#   a 503 while the api is down and recovery after its restart, log redaction, and a backup + verify +
#   restore drill (restore-test.sh --from-backup latest) in the backup image.
# The stack and its volumes are always removed at exit (docker compose down -v); on failure the service
# logs are printed first.
#
# Usage: deploy/smoke-test.sh [--prepare-only]
#   --prepare-only   only generate the certificates, secrets and env file (no Docker needed) and keep them
#
# Environment (default):
#   SMOKE_PROJECT (erp-smoke)        compose project name
#   SMOKE_HTTP_PORT (8080), SMOKE_HTTPS_PORT (8443)   host ports
#   SMOKE_IMAGE_TAG (smoke)          tag of the erp-api/erp-web/erp-backup images
#   SMOKE_NO_BUILD (0)               1: use already built images instead of `up --build`
#   SMOKE_WAIT_TIMEOUT (600)         seconds to wait for the stack to become healthy
#   SMOKE_WORK_DIR (deploy/.smoke-<pid>)   scratch directory (certificates, env file, backups)
#   SMOKE_SKIP_BACKUP (0)            1: skip the backup/verify/restore-drill step
#   SMOKE_KEEP (0)                   1: leave the stack running and keep the work dir for debugging
set -euo pipefail

# Compose gives exported shell variables precedence over --env-file: drop every variable the compose file
# interpolates (before the script assigns its own, unexported, values to some of the same names).
for v in ERP_REGISTRY ERP_IMAGE_TAG ERP_ENV_FILE ERP_SECRETS_DIR ERP_CERTS_DIR ERP_ACME_DIR BACKUP_HOST_DIR \
  BACKUP_UID BACKUP_GID BACKUP_KEEP_COUNT BACKUP_KEEP_DAYS DB_NAME DB_USER DB_PASSWORD SERVER_NAME PUBLIC_URL \
  PUBLIC_WEB_URL SITES_DOMAIN HTTP_PORT HTTPS_PORT CORS_EXTRA_ORIGINS MAX_UPLOAD_MB SPA_CSP_MODE SPA_CSP_REPORT_URI \
  TLS_SELF_SIGNED_FALLBACK COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES; do
  unset "$v"
done

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE=$REPO_ROOT/deploy/docker-compose.yml

PROJECT=${SMOKE_PROJECT:-erp-smoke}
HTTP_PORT=${SMOKE_HTTP_PORT:-8080}
HTTPS_PORT=${SMOKE_HTTPS_PORT:-8443}
IMAGE_TAG=${SMOKE_IMAGE_TAG:-smoke}
NO_BUILD=${SMOKE_NO_BUILD:-0}
WAIT_TIMEOUT=${SMOKE_WAIT_TIMEOUT:-600}
WORK=${SMOKE_WORK_DIR:-$REPO_ROOT/deploy/.smoke-$$}
SKIP_BACKUP=${SMOKE_SKIP_BACKUP:-0}
KEEP=${SMOKE_KEEP:-0}

SERVER=localhost
SITES_DOMAIN=sites.example.test
SITE_HOST=somesite.example.test
SUBDOMAIN_HOST=demo.$SITES_DOMAIN
NOCERT_HOST=nocert.example.test
ADMIN_MOBILE=9000000001
BASE=https://$SERVER:$HTTPS_PORT
HTTP_BASE=http://$SERVER:$HTTP_PORT

usage() { sed -n '/^set -euo/q; 2,$ s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; }

PREPARE_ONLY=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --prepare-only) PREPARE_ONLY=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

log() { printf '[smoke] %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}
section() { printf '\n== %s\n' "$*"; }

FAILURES=0
FAILED_CHECKS=''
pass() { printf '  ok    %s\n' "$*"; }
fail() {
  printf '  FAIL  %s\n' "$*"
  FAILURES=$((FAILURES + 1))
  FAILED_CHECKS="$FAILED_CHECKS
  - $*"
}
# check DESCRIPTION COMMAND...: runs COMMAND (which explains failures on stderr) and records the result.
check() {
  local desc=$1
  shift
  if "$@"; then pass "$desc"; else fail "$desc"; fi
}

for tool in curl openssl; do
  command -v "$tool" >/dev/null || die "$tool is required"
done
if [[ $PREPARE_ONLY == 0 ]]; then
  command -v docker >/dev/null || die 'docker is required'
  docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 (docker compose) is required'
fi
[[ $HTTP_PORT =~ ^[0-9]+$ && $HTTPS_PORT =~ ^[0-9]+$ ]] || die 'SMOKE_HTTP_PORT/SMOKE_HTTPS_PORT must be numbers'
[[ ! -e $WORK ]] || die "work dir already exists: $WORK"

STACK_STARTED=0
cleanup() {
  local status=$?
  set +e
  if [[ $STACK_STARTED == 1 ]]; then
    if [[ $status != 0 || $FAILURES != 0 ]]; then
      section 'service status and logs (failure)'
      compose --profile ops ps -a
      compose --profile ops logs --no-color --timestamps --tail 300
    fi
    if [[ $KEEP == 1 ]]; then
      log "SMOKE_KEEP=1: stack $PROJECT left running; remove it with:"
      log "  docker compose -p $PROJECT -f $COMPOSE_FILE --env-file $WORK/smoke.env --profile ops down -v"
    else
      compose --profile ops --profile redis down -v --remove-orphans >/dev/null 2>&1 ||
        log "WARNING: 'docker compose down' failed"
    fi
  fi
  if [[ $KEEP != 1 && $PREPARE_ONLY != 1 && -d $WORK ]]; then rm -rf "$WORK"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$WORK/smoke.env" "$@"; }

# ------------------------------------------------------------------ certificates, secrets, env file
section "preparing $WORK"
PKI=$WORK/pki
OUT=$WORK/http
mkdir -p "$WORK"
chmod 700 "$WORK"
mkdir -p "$PKI" "$OUT" "$WORK/secrets" "$WORK/certs" "$WORK/acme/.well-known/acme-challenge" "$WORK/backups"

quiet() { # quiet COMMAND...: runs COMMAND, showing its output only if it fails
  "$@" >"$PKI/last.log" 2>&1 || {
    cat "$PKI/last.log" >&2
    die "failed: $*"
  }
}

# A throwaway CA, so that curl can verify every certificate strictly (--cacert) and per-SNI selection is
# actually tested: the platform certificate does not cover the institute domains.
quiet openssl req -new -newkey rsa:2048 -nodes -subj '/CN=ERP smoke test CA' \
  -keyout "$PKI/ca.key" -out "$PKI/ca.csr"
printf '%s\n' 'basicConstraints=critical,CA:TRUE' 'keyUsage=critical,keyCertSign,cRLSign' \
  'subjectKeyIdentifier=hash' >"$PKI/ca.ext"
quiet openssl x509 -req -in "$PKI/ca.csr" -signkey "$PKI/ca.key" -days 2 -sha256 -extfile "$PKI/ca.ext" \
  -out "$PKI/ca.pem"

issue() { # issue DIR CN SUBJECT_ALT_NAMES
  mkdir -p "$1"
  quiet openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$2" -keyout "$1/privkey.pem" -out "$PKI/leaf.csr"
  printf '%s\n' 'basicConstraints=CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' \
    'extendedKeyUsage=serverAuth' "subjectAltName=$3" 'authorityKeyIdentifier=keyid' >"$PKI/leaf.ext"
  quiet openssl x509 -req -in "$PKI/leaf.csr" -CA "$PKI/ca.pem" -CAkey "$PKI/ca.key" \
    -set_serial "0x$(openssl rand -hex 8)" -days 2 -sha256 -extfile "$PKI/leaf.ext" -out "$PKI/leaf.pem"
  cat "$PKI/leaf.pem" "$PKI/ca.pem" >"$1/fullchain.pem"
  chmod 600 "$1/privkey.pem"
}
issue "$WORK/certs/platform" "$SERVER" "DNS:$SERVER,IP:127.0.0.1"
issue "$WORK/certs/sites/$SITE_HOST" "$SITE_HOST" "DNS:$SITE_HOST"
issue "$WORK/certs/sites/_wildcard" "*.$SITES_DOMAIN" "DNS:*.$SITES_DOMAIN"

openssl rand -hex 24 | tr -d '\n' >"$WORK/secrets/mysql_root_password"
chmod 600 "$WORK/secrets/mysql_root_password"
ADMIN_PASSWORD="Smoke-$(openssl rand -hex 10)-Aa1!"

{
  echo '# Generated by deploy/smoke-test.sh: throwaway values for a disposable stack.'
  printf '%s=%s\n' \
    ERP_IMAGE_TAG "$IMAGE_TAG" \
    ERP_ENV_FILE "$WORK/smoke.env" \
    ERP_SECRETS_DIR "$WORK/secrets" \
    ERP_CERTS_DIR "$WORK/certs" \
    ERP_ACME_DIR "$WORK/acme" \
    BACKUP_HOST_DIR "$WORK/backups" \
    BACKUP_UID "$(id -u)" \
    BACKUP_GID "$(id -g)" \
    SERVER_NAME "$SERVER" \
    PUBLIC_URL "$BASE" \
    SITES_DOMAIN "$SITES_DOMAIN" \
    HTTP_PORT "$HTTP_PORT" \
    HTTPS_PORT "$HTTPS_PORT" \
    TLS_SELF_SIGNED_FALLBACK false \
    DB_NAME erp_coaching \
    DB_USER erp \
    DB_PASSWORD "$(openssl rand -hex 24)" \
    JWT_ACCESS_SECRET "$(openssl rand -base64 48 | tr -d '\n')" \
    ENCRYPTION_KEY "$(openssl rand -base64 32)" \
    FILE_URL_SECRET "$(openssl rand -hex 32)" \
    LOG_LEVEL info \
    SEED_DEMO_DATA false
} >"$WORK/smoke.env"
chmod 600 "$WORK/smoke.env"

echo "smoke-acme-$$" >"$WORK/acme/.well-known/acme-challenge/smoke-token"
log "certificates, secrets and env file written"

if [[ $PREPARE_ONLY == 1 ]]; then
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    compose config --quiet && log 'docker compose config: ok'
  fi
  log "prepared $WORK (kept). Start the stack with:"
  log "  docker compose -p $PROJECT -f $COMPOSE_FILE --env-file $WORK/smoke.env up -d --build --wait"
  exit 0
fi

# ------------------------------------------------------------------ start the stack
section "starting stack $PROJECT"
compose config --quiet
STACK_STARTED=1
up_args=(up -d --wait --wait-timeout "$WAIT_TIMEOUT")
if [[ $NO_BUILD != 1 ]]; then up_args+=(--build); fi
compose "${up_args[@]}"
compose ps

# ------------------------------------------------------------------ HTTP helpers
CURL_COMMON=(-sS --max-time 30 --cacert "$PKI/ca.pem"
  --resolve "$SERVER:$HTTPS_PORT:127.0.0.1" --resolve "$SERVER:$HTTP_PORT:127.0.0.1"
  --resolve "$SITE_HOST:$HTTPS_PORT:127.0.0.1" --resolve "$SUBDOMAIN_HOST:$HTTPS_PORT:127.0.0.1"
  --resolve "$NOCERT_HOST:$HTTPS_PORT:127.0.0.1")

# fetch NAME URL [CURL_ARGS...]: saves NAME.status, NAME.headers and NAME.body under $OUT.
fetch() {
  local name=$1 url=$2
  shift 2
  if ! curl "${CURL_COMMON[@]}" -D "$OUT/$name.headers" -o "$OUT/$name.body" -w '%{http_code}' "$@" "$url" \
    >"$OUT/$name.status" 2>"$OUT/$name.err"; then
    printf '000' >"$OUT/$name.status"
    touch "$OUT/$name.headers" "$OUT/$name.body"
  fi
}
header() { # header NAME HEADER: value of the last HEADER in the response (case-insensitive)
  tr -d '\r' <"$OUT/$1.headers" | awk -v h="$2" '
    { name = tolower(substr($0, 1, index($0, ":") - 1)) }
    index($0, ":") && name == tolower(h) { v = substr($0, index($0, ":") + 1); sub(/^[ \t]+/, "", v); last = v }
    END { printf "%s", last }'
}
expect() { # expect NAME STATUS [BODY_REGEX]
  local got
  got=$(cat "$OUT/$1.status")
  if [[ $got != "$2" ]]; then
    echo "        $1: HTTP $got, expected $2 $(head -c 300 "$OUT/$1.err" "$OUT/$1.body" 2>/dev/null | tr '\n' ' ')"
    return 1
  fi
  if [[ $# -ge 3 ]] && ! grep -Eq -- "$3" "$OUT/$1.body"; then
    echo "        $1: body does not match /$3/: $(head -c 300 "$OUT/$1.body" | tr '\n' ' ')"
    return 1
  fi
}
expect_header() { # expect_header NAME HEADER REGEX
  local value
  value=$(header "$1" "$2")
  if ! [[ $value =~ $3 ]]; then
    echo "        $1: $2: '$value' does not match /$3/"
    return 1
  fi
}
expect_no_header() { # expect_no_header NAME HEADER
  local value
  value=$(header "$1" "$2")
  if [[ -n $value ]]; then
    echo "        $1: unexpected header $2: $value"
    return 1
  fi
}
# retry SECONDS COMMAND...: retries COMMAND every 2 seconds until it succeeds or SECONDS have passed.
retry() {
  local deadline=$((SECONDS + $1))
  shift
  until "$@" >/dev/null; do
    if ((SECONDS >= deadline)); then
      "$@"
      return 1
    fi
    sleep 2
  done
}
served_cn() { # served_cn SNI_HOST: CN of the certificate nginx presents for that SNI name
  openssl s_client -connect "127.0.0.1:$HTTPS_PORT" -servername "$1" </dev/null 2>/dev/null |
    openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*CN *= *\([^,/]*\).*/\1/p'
}
expect_cn() { # expect_cn SNI_HOST CN
  local cn
  cn=$(served_cn "$1")
  if [[ $cn != "$2" ]]; then
    echo "        SNI $1: certificate CN '$cn', expected '$2'"
    return 1
  fi
}
health_ok() {
  fetch health_retry "$BASE/api/health"
  expect health_retry 200 '"status":"ok"'
}
expect_host_only_hsts() { # expect_host_only_hsts NAME: exactly one HSTS header, without includeSubDomains
  local lines
  lines=$(tr -d '\r' <"$OUT/$1.headers" | grep -i '^strict-transport-security:' || true)
  if [[ $(printf '%s\n' "$lines" | grep -c .) != 1 || $lines == *[Ii]nclude[Ss]ub[Dd]omains* ]]; then
    echo "        $1: Strict-Transport-Security headers: ${lines:-none}"
    return 1
  fi
}

# ------------------------------------------------------------------ platform host
section 'API through nginx'
fetch health "$BASE/api/health" -H 'X-Request-Id: smoke-health-0001'
check 'GET /api/health -> 200 {"status":"ok"}' expect health 200 '"status":"ok"'
check 'request id forwarded to the api and echoed in X-Request-Id' \
  expect_header health x-request-id '^smoke-health-0001$'
check 'api keeps its own headers (helmet CSP, not the SPA report-only CSP)' \
  expect_header health content-security-policy "default-src 'self'"
check 'no SPA headers added to /api/' expect_no_header health content-security-policy-report-only

fetch ready "$BASE/api/ready"
check 'GET /api/ready -> 200 {"status":"ready"} (database, migrations, storage)' expect ready 200 '"status":"ready"'
check "readiness reports version $IMAGE_TAG" expect ready 200 "\"version\":\"$IMAGE_TAG\""

fetch cors "$BASE/api/health" -X OPTIONS -H 'Origin: capacitor://localhost' \
  -H 'Access-Control-Request-Method: GET'
check 'CORS preflight allows the Capacitor origin' \
  expect_header cors access-control-allow-origin '^capacitor://localhost$'

section 'http, ACME and TLS'
fetch redirect "$HTTP_BASE/some/page?x=1"
check 'http -> https redirect (301, path and query kept)' expect redirect 301
check 'redirect target is the public https origin' \
  expect_header redirect location "^https://$SERVER:$HTTPS_PORT/some/page\\?x=1\$"
fetch acme "$HTTP_BASE/.well-known/acme-challenge/smoke-token"
check 'ACME HTTP-01 webroot served over http' expect acme 200 "^smoke-acme-$$\$"
fetch tls_old "$BASE/api/health" --tlsv1.1 --tls-max 1.1
check 'TLS 1.1 refused' expect tls_old 000
check 'platform certificate presented for the platform host' expect_cn "$SERVER" "$SERVER"

section 'single-page app'
fetch spa "$BASE/"
check 'GET / -> 200 index.html' expect spa 200 '<div id="app">'
check 'SPA: Content-Security-Policy-Report-Only' expect_header spa content-security-policy-report-only "default-src 'self'"
check 'SPA: no enforced CSP by default' expect_no_header spa content-security-policy
check 'SPA: HSTS' expect_header spa strict-transport-security 'max-age=[0-9]+'
check 'SPA: X-Content-Type-Options nosniff' expect_header spa x-content-type-options '^nosniff$'
check 'SPA: X-Frame-Options' expect_header spa x-frame-options '^SAMEORIGIN$'
check 'SPA: Referrer-Policy' expect_header spa referrer-policy '^strict-origin-when-cross-origin$'
check 'SPA: Permissions-Policy' expect_header spa permissions-policy 'camera=\(self\)'
check 'SPA: index.html is not cached' expect_header spa cache-control '^no-cache$'
fetch deep "$BASE/students/123/profile"
check 'deep link falls back to index.html' expect deep 200 '<div id="app">'
asset=$(grep -Eo '/assets/[^"]+\.js' "$OUT/spa.body" | head -n 1 || true)
if [[ -n $asset ]]; then
  fetch asset "$BASE$asset"
  check "hashed asset $asset -> 200" expect asset 200
  check 'hashed assets are cached immutably' expect_header asset cache-control 'max-age=31536000, immutable'
else
  fail 'index.html references no /assets/*.js'
fi
fetch asset_missing "$BASE/assets/does-not-exist-smoke.js"
check 'missing asset -> 404 (not index.html)' expect asset_missing 404

section 'live classes (Socket.IO)'
fetch sio "$BASE/api/live-classes/socket.io/?EIO=4&transport=polling"
check 'Socket.IO polling handshake' expect sio 200 '^0\{"sid":'
ws_key=$(openssl rand -base64 16)
curl "${CURL_COMMON[@]}" --http1.1 --max-time 5 -o /dev/null -D "$OUT/ws.headers" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H "Sec-WebSocket-Key: $ws_key" "$BASE/api/live-classes/socket.io/?EIO=4&transport=websocket" \
  2>/dev/null || true
ws_upgraded() {
  if ! tr -d '\r' <"$OUT/ws.headers" | grep -Eq '^HTTP/1\.1 101'; then
    echo "        no 101 response: $(head -c 300 "$OUT/ws.headers" | tr '\r\n' '  ')"
    return 1
  fi
}
check 'WebSocket upgrade through nginx -> 101 Switching Protocols' ws_upgraded

# ------------------------------------------------------------------ institute websites
section 'institute websites (Host-based resolution)'
fetch site "https://$SITE_HOST:$HTTPS_PORT/" -H 'X-Request-Id: smoke-site-0001'
check "custom domain $SITE_HOST: own certificate via SNI (strict TLS)" expect_cn "$SITE_HOST" "$SITE_HOST"
check "custom domain $SITE_HOST -> api _host resolver (JSON 404 NOT_FOUND)" expect site 404 '"NOT_FOUND"'
check 'site response is JSON from the api, not the SPA' expect_header site content-type '^application/json'
check 'site hosts: HSTS for the host only (no includeSubDomains)' expect_host_only_hsts site
fetch site_api "https://$SITE_HOST:$HTTPS_PORT/api/health"
check 'site hosts never expose the platform API (/api/health is a site path)' \
  expect site_api 404 '"code":"(ROUTE_)?NOT_FOUND"'
fetch subdomain "https://$SUBDOMAIN_HOST:$HTTPS_PORT/"
check "subdomain $SUBDOMAIN_HOST: wildcard certificate + JSON 404" expect subdomain 404 '"NOT_FOUND"'
fetch nocert "https://$NOCERT_HOST:$HTTPS_PORT/" -k
check "domain without certificate ($NOCERT_HOST) gets the platform certificate" expect_cn "$NOCERT_HOST" "$SERVER"
check "domain without certificate still reaches the resolver" expect nocert 404 '"NOT_FOUND"'
head -c 2000000 /dev/zero >"$OUT/2mb.bin"
fetch site_big "https://$SITE_HOST:$HTTPS_PORT/contact" -X POST --data-binary "@$OUT/2mb.bin" \
  -H 'Content-Type: application/octet-stream'
check 'site hosts reject bodies over 1 MB (413)' expect site_big 413

# ------------------------------------------------------------------ first-deploy bootstrap
section 'bootstrap: super admin seeding and login'
seed() { # seed PASSWORD: runs the seeder like the runbook does (no demo data)
  SEED_SUPERADMIN_PASSWORD=$1 compose run --rm --no-deps -T \
    -e SEED_DEMO_DATA=false -e SEED_SUPERADMIN_MOBILE="$ADMIN_MOBILE" -e SEED_SUPERADMIN_PASSWORD \
    migrate node dist/infrastructure/database/cli.js seed
}
weak_refused() {
  if seed 'Admin@12345' >"$OUT/seed-weak.log" 2>&1; then
    echo '        the seeder accepted the default password in production'
    return 1
  fi
  grep -q 'SEED_SUPERADMIN_PASSWORD' "$OUT/seed-weak.log" || {
    echo "        unexpected seeder error: $(tail -n 5 "$OUT/seed-weak.log")"
    return 1
  }
}
check 'production seeding refuses the default/weak super admin password' weak_refused
strong_accepted() {
  seed "$ADMIN_PASSWORD" >"$OUT/seed.log" 2>&1 || {
    tail -n 30 "$OUT/seed.log"
    return 1
  }
}
check 'seeding with SEED_DEMO_DATA=false and a strong password succeeds' strong_accepted
login_body=$(printf '{"identifier":"%s","password":"%s","device":{"uid":"smoke-test-device-0001","name":"smoke test","platform":"web"}}' \
  "$ADMIN_MOBILE" "$ADMIN_PASSWORD")
fetch login "$BASE/api/auth/login" -X POST -H 'Content-Type: application/json' --data-binary "$login_body"
check 'super admin can log in' expect login 200 '"status":"authenticated"'
check 'login returns an access token' expect login 200 '"accessToken":"[^"]+'

migrations_applied() {
  compose run --rm --no-deps -T migrate node dist/infrastructure/database/cli.js migrate:status \
    >"$OUT/migrate-status.log" 2>&1 || {
    tail -n 20 "$OUT/migrate-status.log"
    return 1
  }
  grep -q '^pending: \[\]' "$OUT/migrate-status.log" || {
    echo "        $(grep '^pending' "$OUT/migrate-status.log")"
    return 1
  }
}
check 'migrate:status: no pending migrations' migrations_applied

# ------------------------------------------------------------------ operations
section 'nginx operations'
check 'nginx -t' compose exec -T web nginx -t -q
reload_certs() { compose exec -T web erp-certs --reload >"$OUT/erp-certs.log" 2>&1 || {
  cat "$OUT/erp-certs.log"
  return 1
}; }
check 'erp-certs --reload (validate, test config, graceful reload)' reload_certs
check 'still serving after the reload' retry 30 health_ok
check "custom domain certificate still selected after the reload" expect_cn "$SITE_HOST" "$SITE_HOST"

section 'api restart (nginx keeps running)'
api_id=$(compose ps -q api)
docker stop "$api_id" >/dev/null
fetch down "$BASE/api/health"
check 'api down -> 503 JSON SERVICE_UNAVAILABLE from nginx' expect down 503 '"SERVICE_UNAVAILABLE"'
check 'api down -> Retry-After' expect_header down retry-after '^10$'
docker start "$api_id" >/dev/null
api_healthy() {
  [[ $(docker inspect -f '{{.State.Health.Status}}' "$api_id") == healthy ]] || {
    echo "        api health: $(docker inspect -f '{{.State.Health.Status}}' "$api_id")"
    return 1
  }
}
check 'api healthy again after restart' retry 180 api_healthy
check 'nginx routes to the restarted api (re-resolved upstream)' retry 60 health_ok

section 'logs'
fetch signed "$BASE/api/files/signed/smokesecrettoken0123456789/file.pdf?sig=smokesig"
compose logs --no-color --no-log-prefix web >"$OUT/web.log" 2>&1 || true
compose logs --no-color --no-log-prefix api >"$OUT/api.log" 2>&1 || true
nginx_json_log() {
  grep -q '"source":"nginx","requestId":"smoke-site-0001"' "$OUT/web.log" || {
    echo '        no JSON access log entry with requestId smoke-site-0001'
    return 1
  }
}
check 'nginx writes JSON access logs with the request id' nginx_json_log
api_request_id_log() {
  grep -q 'smoke-site-0001' "$OUT/api.log" || {
    echo '        the api log has no entry with request id smoke-site-0001'
    return 1
  }
}
check 'the api logs the request id forwarded by nginx' api_request_id_log
tokens_redacted() {
  if grep -Eq 'smokesecrettoken0123456789|smokesig' "$OUT/web.log"; then
    echo '        the signed-URL token or query string appears in the nginx log'
    return 1
  fi
  grep -q '/api/files/signed/\[redacted\]/file.pdf' "$OUT/web.log" || {
    echo '        no redacted signed-URL entry in the nginx log'
    return 1
  }
}
check 'nginx log redacts signed-URL tokens and query strings' tokens_redacted

if [[ $SKIP_BACKUP != 1 ]]; then
  section 'backup (ops profile)'
  run_backup() {
    compose --profile ops run --rm -T backup >"$OUT/backup.out" 2>"$OUT/backup.err" || {
      tail -n 30 "$OUT/backup.err"
      return 1
    }
    local dir
    dir=$(tail -n 1 "$OUT/backup.out")
    dir=$WORK/backups/${dir#/backups/}
    for f in db.sql.gz media.tar.gz manifest.json SHA256SUMS; do
      [[ -s $dir/$f ]] || {
        echo "        $dir/$f is missing or empty"
        return 1
      }
    done
  }
  check 'backup service writes database + media archives, manifest and checksums' run_backup
  verify_backup() {
    compose --profile ops run --rm -T restore --verify-only latest >"$OUT/verify.log" 2>&1 || {
      tail -n 30 "$OUT/verify.log"
      return 1
    }
  }
  check 'restore --verify-only latest' verify_backup
  # Full restore + round trip inside the backup image: the documented restore drill.
  restore_drill() {
    compose --profile ops run --rm -T --entrypoint restore-test.sh backup --from-backup latest \
      >"$OUT/restore-drill.log" 2>&1 || {
      tail -n 40 "$OUT/restore-drill.log"
      return 1
    }
  }
  check 'restore drill: restore-test.sh --from-backup latest' restore_drill
fi

# ------------------------------------------------------------------ result
section 'result'
if [[ $FAILURES != 0 ]]; then
  printf '%s check(s) failed:%s\n' "$FAILURES" "$FAILED_CHECKS"
  exit 1
fi
echo 'all smoke checks passed'
