#!/usr/bin/env bash
# Backs up the ERP database (logical mysqldump) and the local-disk media storage into a timestamped
# directory: BACKUP_DIR/<DB_NAME>-<YYYYmmddTHHMMSSZ>/{db.sql.gz,media.tar.gz,manifest.json,SHA256SUMS}.
# Prints the backup directory path as the last line on stdout; logs go to stderr.
#
# Usage: backup.sh [--no-media] [--no-prune]
#
# Environment (default):
#   DB_HOST (127.0.0.1)  DB_PORT (3306)  DB_USER (root)  DB_NAME (erp_coaching)
#   DB_PASSWORD or DB_PASSWORD_FILE   never passed on a command line (a 0600 option file is used)
#   DB_SSL_MODE, DB_SSL_CA            optional TLS settings for the MySQL clients
#   STORAGE_DIR                       media root = the API's STORAGE_LOCAL_ROOT (required unless --no-media)
#   BACKUP_DIR (./backups)            destination; created with mode 0700, archives are 0600
#   BACKUP_KEEP_COUNT (14)            keep at most N backups of this DB (0 = unlimited)
#   BACKUP_KEEP_DAYS (30)             delete backups older than D days (0 = no age limit)
#   MYSQL_BIN_DIR                     directory of the mysql/mysqldump binaries (default: PATH)
#   APP_VERSION                       recorded in the manifest
#   BACKUP_TMPDIR (TMPDIR or /tmp)    where the private scratch dir with the option file is created
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"
LOG_TAG=backup

usage() { sed -n '/^set -euo/q; 2,$ s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; }

INCLUDE_MEDIA=1
PRUNE=1
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-media) INCLUDE_MEDIA=0 ;;
    --no-prune) PRUNE=0 ;;
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

load_db_env
BACKUP_DIR=${BACKUP_DIR:-./backups}
KEEP_COUNT=${BACKUP_KEEP_COUNT:-14}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-30}
[[ "$KEEP_COUNT" =~ ^[0-9]+$ ]] || die "BACKUP_KEEP_COUNT must be a non-negative integer"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || die "BACKUP_KEEP_DAYS must be a non-negative integer"
if ((INCLUDE_MEDIA)); then
  [[ -n "${STORAGE_DIR:-}" ]] || die "STORAGE_DIR is not set (the API's STORAGE_LOCAL_ROOT); pass --no-media to skip media"
  [[ -d "$STORAGE_DIR" ]] || die "STORAGE_DIR does not exist: $STORAGE_DIR"
  STORAGE_DIR=$(cd "$STORAGE_DIR" && pwd)
fi

MYSQL=$(mysql_bin mysql)
MYSQLDUMP=$(mysql_bin mysqldump)
warn_if_mariadb_client "$MYSQLDUMP"

umask 077
mkdir -p "$BACKUP_DIR"
BACKUP_DIR=$(cd "$BACKUP_DIR" && pwd)

STAMP=$(stamp_now)
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FINAL="$BACKUP_DIR/$DB_NAME-$STAMP"
PARTIAL="$FINAL.partial"
COMPLETED=0

on_exit() {
  local rc=$?
  if ((!COMPLETED)) && [[ -d "$PARTIAL" ]]; then rm -rf "$PARTIAL"; fi
  cleanup_work_dir
  if ((rc != 0)); then log "backup FAILED (exit $rc)"; fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

init_work_dir
[[ ! -e "$FINAL" && ! -e "$PARTIAL" ]] || die "$FINAL already exists"
mkdir "$PARTIAL"

sql 'SELECT 1' >/dev/null || die "cannot connect to MySQL at $DB_HOST:$DB_PORT as $DB_USER"
db_exists "$DB_NAME" || die "database $DB_NAME does not exist"
SERVER_VERSION=$(sql 'SELECT VERSION()')
DUMP_CLIENT=$("$MYSQLDUMP" --version 2>&1 || true)
DUMP_CLIENT=${DUMP_CLIENT%%$'\n'*}
SCHEMA_INFO=$(sql "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '$DB_NAME'")
DB_CHARSET=${SCHEMA_INFO%%$'\t'*}
DB_COLLATION=${SCHEMA_INFO#*$'\t'}
TABLE_COUNT=$(sql "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$DB_NAME' AND TABLE_TYPE = 'BASE TABLE'")

# --single-transaction gives a consistent InnoDB snapshot without locking writers; --no-tablespaces avoids
# needing the PROCESS privilege; no --databases so the dump can be restored under any database name.
DUMP_OPTS=(--single-transaction --routines --triggers --events --no-tablespaces --hex-blob
  --default-character-set=utf8mb4 --max-allowed-packet=1G)
DUMP_HELP=$("$MYSQLDUMP" --help 2>/dev/null || true)
if [[ "$DUMP_HELP" == *--set-gtid-purged* ]]; then DUMP_OPTS+=(--set-gtid-purged=OFF); fi

log "dumping database $DB_NAME ($TABLE_COUNT tables, MySQL $SERVER_VERSION) from $DB_HOST:$DB_PORT"
"$MYSQLDUMP" --defaults-file="$DEFAULTS_FILE" "${DUMP_OPTS[@]}" "$DB_NAME" | gzip -c >"$PARTIAL/db.sql.gz"
LAST_LINE=$(gzip -dc "$PARTIAL/db.sql.gz" | tail -n 1)
[[ "$LAST_LINE" == '-- Dump completed'* ]] || die "database dump looks truncated (no 'Dump completed' trailer)"

MIGRATIONS=''
SEEDERS=''
if table_exists "$DB_NAME" SequelizeMeta; then
  MIGRATIONS=$(sql "SELECT name FROM \`$DB_NAME\`.\`SequelizeMeta\` ORDER BY name")
fi
if table_exists "$DB_NAME" SequelizeData; then
  SEEDERS=$(sql "SELECT name FROM \`$DB_NAME\`.\`SequelizeData\` ORDER BY name")
fi

MEDIA_FILES=0
if ((INCLUDE_MEDIA)); then
  log "archiving media from $STORAGE_DIR"
  TAR_OPTS=(--numeric-owner)
  if is_gnu_tar; then TAR_OPTS+=(--warning=no-file-changed --warning=no-file-removed); fi
  rc=0
  tar "${TAR_OPTS[@]}" -czf "$PARTIAL/media.tar.gz" -C "$STORAGE_DIR" . || rc=$?
  # GNU tar exits 1 when files changed while being read (uploads during the backup); the archive is
  # still valid, those files are just captured in whatever state they were in.
  if ((rc == 1)) && is_gnu_tar; then
    log 'WARNING: some media files changed while they were archived'
  elif ((rc != 0)); then
    die "tar failed with exit code $rc"
  fi
  gzip -t "$PARTIAL/media.tar.gz" || die 'media archive failed the gzip integrity check'
  tar -tvzf "$PARTIAL/media.tar.gz" >"$WORK_DIR/media.list" || die 'media archive cannot be listed'
  MEDIA_FILES=$(grep -c '^-' "$WORK_DIR/media.list" || true)
fi

log 'writing manifest and checksums'
FILES_JSON=''
SUMS=''
for f in db.sql.gz media.tar.gz; do
  [[ -f "$PARTIAL/$f" ]] || continue
  hash=$(sha256_file "$PARTIAL/$f")
  size=$(file_size "$PARTIAL/$f")
  [[ -z "$FILES_JSON" ]] || FILES_JSON+=$',\n'
  FILES_JSON+="    {\"name\": \"$f\", \"bytes\": $size, \"sha256\": \"$hash\"}"
  SUMS+="$hash  $f"$'\n'
done
MEDIA_INCLUDED=false
if ((INCLUDE_MEDIA)); then MEDIA_INCLUDED=true; fi

{
  printf '{\n'
  printf '  "format": "erp-backup/v1",\n'
  printf '  "createdAt": %s,\n' "$(json_str "$CREATED_AT")"
  printf '  "completedAt": %s,\n' "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  printf '  "appVersion": %s,\n' "$(json_str "${APP_VERSION:-unknown}")"
  printf '  "database": %s,\n' "$(json_str "$DB_NAME")"
  printf '  "dbHost": %s,\n' "$(json_str "$DB_HOST:$DB_PORT")"
  printf '  "dbServerVersion": %s,\n' "$(json_str "$SERVER_VERSION")"
  printf '  "dbCharset": %s,\n' "$(json_str "$DB_CHARSET")"
  printf '  "dbCollation": %s,\n' "$(json_str "$DB_COLLATION")"
  printf '  "dumpClient": %s,\n' "$(json_str "$DUMP_CLIENT")"
  printf '  "tableCount": %s,\n' "$TABLE_COUNT"
  printf '  "mediaIncluded": %s,\n' "$MEDIA_INCLUDED"
  printf '  "mediaSourceDir": %s,\n' "$(json_str "${STORAGE_DIR:-}")"
  printf '  "mediaFileCount": %s,\n' "$MEDIA_FILES"
  printf '  "files": [\n%s\n  ],\n' "$FILES_JSON"
  printf '  "migrations": %s,\n' "$(printf '%s\n' "$MIGRATIONS" | json_lines_array)"
  printf '  "seeders": %s\n' "$(printf '%s\n' "$SEEDERS" | json_lines_array)"
  printf '}\n'
} >"$PARTIAL/manifest.json"
SUMS+="$(sha256_file "$PARTIAL/manifest.json")  manifest.json"$'\n'
printf '%s' "$SUMS" >"$PARTIAL/SHA256SUMS"

mv "$PARTIAL" "$FINAL"
COMPLETED=1
log "backup complete: $FINAL ($(du -sk "$FINAL" | cut -f1) KiB, $MEDIA_FILES media files)"

prune() {
  local now cutoff='' stale_cutoff d base stamp i kept=0
  local -a backups=()
  now=$(date -u +%s)
  if ((KEEP_DAYS > 0)); then cutoff=$(stamp_from_epoch $((now - KEEP_DAYS * 86400))); fi
  stale_cutoff=$(stamp_from_epoch $((now - 86400)))
  for d in "$BACKUP_DIR/$DB_NAME"-*; do
    [[ -d "$d" ]] || continue
    base=${d##*/}
    stamp=${base#"$DB_NAME"-}
    if [[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z\.partial$ ]]; then
      if [[ "${stamp%.partial}" < "$stale_cutoff" ]]; then
        log "removing stale partial backup $base"
        rm -rf "$d"
      fi
      continue
    fi
    [[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ && -f "$d/manifest.json" ]] || continue
    backups+=("$d")
  done
  # The glob is sorted oldest first; walk newest first and never delete the backup just written.
  for ((i = ${#backups[@]} - 1; i >= 0; i--)); do
    d=${backups[$i]}
    base=${d##*/}
    stamp=${base#"$DB_NAME"-}
    if [[ "$d" == "$FINAL" ]]; then
      kept=$((kept + 1))
    elif ((KEEP_COUNT > 0 && kept >= KEEP_COUNT)); then
      log "pruning $base (more than $KEEP_COUNT backups)"
      rm -rf "$d"
    elif [[ -n "$cutoff" && "$stamp" < "$cutoff" ]]; then
      log "pruning $base (older than $KEEP_DAYS days)"
      rm -rf "$d"
    else
      kept=$((kept + 1))
    fi
  done
}
if ((PRUNE)); then prune; fi

printf '%s\n' "$FINAL"
