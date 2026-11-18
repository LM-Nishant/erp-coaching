# shellcheck shell=bash
# Shared helpers for backup.sh, restore.sh and restore-test.sh. Sourced, never executed.
# Must stay compatible with bash 3.2 (macOS /bin/bash): no mapfile, associative arrays or ${x,,}.

LC_ALL=C
export LC_ALL

# Client programs read ~/.mylogin.cnf even with --defaults-file; point them at a path that never exists.
MYSQL_TEST_LOGIN_FILE=/nonexistent/erp-backup-no-login-path
export MYSQL_TEST_LOGIN_FILE

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOG_TAG:-backup}" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

valid_db_name() { [[ "$1" =~ ^[A-Za-z0-9_]{1,64}$ ]]; }

# DB_* use the backend's variable names so the API env file can be reused as-is.
load_db_env() {
  DB_HOST=${DB_HOST:-127.0.0.1}
  DB_PORT=${DB_PORT:-3306}
  DB_USER=${DB_USER:-root}
  DB_NAME=${DB_NAME:-erp_coaching}
  if [[ -z "${DB_PASSWORD:-}" && -n "${DB_PASSWORD_FILE:-}" ]]; then
    [[ -r "$DB_PASSWORD_FILE" ]] || die "DB_PASSWORD_FILE is not readable: $DB_PASSWORD_FILE"
    DB_PASSWORD=$(cat "$DB_PASSWORD_FILE")
  fi
  DB_PASSWORD=${DB_PASSWORD:-}
  [[ "$DB_PORT" =~ ^[0-9]+$ ]] || die "DB_PORT must be numeric: $DB_PORT"
  valid_db_name "$DB_NAME" || die "DB_NAME must match [A-Za-z0-9_]{1,64}: $DB_NAME"
  case $DB_PASSWORD in *$'\n'*) die 'DB_PASSWORD must not contain newlines' ;; esac
}

# Prints the path of a MySQL client binary, honouring MYSQL_BIN_DIR.
mysql_bin() {
  if [[ -n "${MYSQL_BIN_DIR:-}" ]]; then
    [[ -x "$MYSQL_BIN_DIR/$1" ]] || die "$MYSQL_BIN_DIR/$1 is missing or not executable"
    printf '%s\n' "$MYSQL_BIN_DIR/$1"
  else
    command -v "$1" || die "$1 not found on PATH (set MYSQL_BIN_DIR to the MySQL client bin directory)"
  fi
}

# Escapes a value for a double-quoted MySQL option-file value.
cnf_quote() {
  local v=$1
  v=${v//\\/\\\\}
  v=${v//\"/\\\"}
  printf '"%s"' "$v"
}

# Creates a private (0700) scratch dir holding a 0600 client option file with the credentials, so the
# password never appears on a command line or in the client processes' environment.
# Sets WORK_DIR and DEFAULTS_FILE; the caller's EXIT trap must call cleanup_work_dir.
init_work_dir() {
  local base=${BACKUP_TMPDIR:-${TMPDIR:-/tmp}}
  base=${base%/}
  [[ -d "$base" ]] || die "scratch base dir does not exist: $base (set BACKUP_TMPDIR)"
  WORK_DIR="$base/erp-backup.$$.${RANDOM}${RANDOM}"
  (umask 077 && mkdir "$WORK_DIR") || die "cannot create scratch dir $WORK_DIR"
  DEFAULTS_FILE="$WORK_DIR/client.cnf"
  (
    umask 077
    {
      printf '[client]\n'
      printf 'host=%s\n' "$(cnf_quote "$DB_HOST")"
      printf 'port=%s\n' "$DB_PORT"
      printf 'user=%s\n' "$(cnf_quote "$DB_USER")"
      printf 'password=%s\n' "$(cnf_quote "$DB_PASSWORD")"
      if [[ -n "${DB_SSL_MODE:-}" ]]; then printf 'ssl-mode=%s\n' "$DB_SSL_MODE"; fi
      if [[ -n "${DB_SSL_CA:-}" ]]; then printf 'ssl-ca=%s\n' "$(cnf_quote "$DB_SSL_CA")"; fi
    } >"$DEFAULTS_FILE"
  )
}

cleanup_work_dir() {
  if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then rm -rf "$WORK_DIR"; fi
}

# sql "QUERY" -> tab-separated rows without a header. Always use fully qualified table names.
sql() {
  "$MYSQL" --defaults-file="$DEFAULTS_FILE" --batch --skip-column-names --default-character-set=utf8mb4 -e "$1"
}

db_exists() {
  [[ "$(sql "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '$1'")" != 0 ]]
}

# Number of tables, views, routines and events in a schema.
db_object_count() {
  sql "SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$1')
    + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = '$1')
    + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = '$1')"
}

table_exists() { # db table
  [[ "$(sql "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$1' AND TABLE_NAME = '$2'")" != 0 ]]
}

warn_if_mariadb_client() {
  local version
  version=$("$1" --version 2>&1 || true)
  case $version in
    *MariaDB*) log "WARNING: $1 is a MariaDB client; use MySQL 8.x client binaries (set MYSQL_BIN_DIR)" ;;
  esac
}

sha256_file() {
  local out
  if command -v sha256sum >/dev/null 2>&1; then
    out=$(sha256sum "$1")
  elif command -v shasum >/dev/null 2>&1; then
    out=$(shasum -a 256 "$1")
  else
    out=$(openssl dgst -sha256 -r "$1")
  fi
  printf '%s\n' "${out%% *}"
}

file_size() { printf '%s\n' "$(($(wc -c <"$1")))"; }

is_gnu_tar() {
  local version
  version=$(tar --version 2>/dev/null || true)
  [[ "$version" == *'GNU tar'* ]]
}

stamp_now() { date -u +%Y%m%dT%H%M%SZ; }

stamp_from_epoch() {
  date -u -d "@$1" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -r "$1" +%Y%m%dT%H%M%SZ
}

json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  s=${s//$'\n'/\\n}
  printf '"%s"' "$s"
}

# Reads newline-separated values on stdin and prints a JSON array with one element per line (also when
# empty), which is the layout manifest_array relies on.
json_lines_array() {
  local first=1 line
  printf '['
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if ((first)); then printf '\n'; else printf ',\n'; fi
    printf '    %s' "$(json_str "$line")"
    first=0
  done
  printf '\n  ]'
}

# Reads a top-level scalar from a manifest written by backup.sh: manifest_value FILE KEY
manifest_value() {
  sed -n "s/^  \"$2\": \"\\{0,1\\}\\([^\",]*\\)\"\\{0,1\\},\\{0,1\\}\$/\\1/p" "$1" | head -n 1
}

# Reads a top-level string array from a manifest written by backup.sh: manifest_array FILE KEY
manifest_array() {
  sed -n "/^  \"$2\": \[\$/,/^  \]/p" "$1" | sed -n 's/^    "\(.*\)",\{0,1\}$/\1/p'
}

# Newest complete backup directory of a database (empty output if there is none).
latest_backup() { # backup_dir db_name
  local d latest=''
  for d in "$1/$2"-*; do
    [[ -d "$d" && -f "$d/manifest.json" ]] || continue
    [[ "${d##*/}" =~ ^[A-Za-z0-9_]+-[0-9]{8}T[0-9]{6}Z$ ]] || continue
    latest=$d
  done
  printf '%s\n' "$latest"
}
