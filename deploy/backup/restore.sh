#!/usr/bin/env bash
# Restores a backup made by backup.sh. Checksums and archive integrity are verified before anything
# is touched; non-empty targets are refused unless --force is given.
#
# Usage: restore.sh [options] <backup-dir | latest>
#   --target-db NAME   database to restore into (created if missing)
#   --target-dir DIR   directory to extract the media into (created if missing)
#   --force            replace a non-empty target: DROP + CREATE the database, empty the directory
#   --db-only          restore only the database
#   --media-only       restore only the media
#   --verify-only      only verify checksums and archive integrity, then exit
#   latest             the newest backup of DB_NAME in BACKUP_DIR
#
# Exit codes: 0 ok, 1 error, 2 usage, 3 refused (non-empty target without --force), 4 verification failed.
#
# Environment: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD or DB_PASSWORD_FILE, DB_SSL_MODE, DB_SSL_CA,
# MYSQL_BIN_DIR and BACKUP_TMPDIR as for backup.sh; DB_NAME and BACKUP_DIR are only used for "latest".
# The DB user needs CREATE/DROP on the target database. Stop the API (it also runs the jobs worker)
# before restoring over the live database or storage directory.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"
LOG_TAG=restore

usage() { sed -n '/^set -euo/q; 2,$ s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; }
usage_error() {
  log "$*"
  usage >&2
  exit 2
}
refuse() {
  log "REFUSED: $* (pass --force to replace it)"
  exit 3
}
fail_verify() {
  log "VERIFICATION FAILED: $*"
  exit 4
}

FORCE=0
DO_DB=1
DO_MEDIA=1
VERIFY_ONLY=0
TARGET_DB=''
TARGET_DIR=''
SRC=''
while [[ $# -gt 0 ]]; do
  case $1 in
    --target-db)
      [[ $# -ge 2 ]] || usage_error '--target-db needs a value'
      TARGET_DB=$2
      shift
      ;;
    --target-db=*) TARGET_DB=${1#*=} ;;
    --target-dir)
      [[ $# -ge 2 ]] || usage_error '--target-dir needs a value'
      TARGET_DIR=$2
      shift
      ;;
    --target-dir=*) TARGET_DIR=${1#*=} ;;
    --force) FORCE=1 ;;
    --db-only) DO_MEDIA=0 ;;
    --media-only) DO_DB=0 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) usage_error "unknown option: $1" ;;
    *)
      [[ -z "$SRC" ]] || usage_error 'only one backup can be restored at a time'
      SRC=$1
      ;;
  esac
  shift
done
[[ -n "$SRC" ]] || usage_error 'missing backup directory (or "latest")'
((DO_DB || DO_MEDIA)) || usage_error '--db-only and --media-only are mutually exclusive'

if [[ "$SRC" == latest ]]; then
  DB_NAME=${DB_NAME:-erp_coaching}
  valid_db_name "$DB_NAME" || die "invalid DB_NAME: $DB_NAME"
  SRC=$(latest_backup "${BACKUP_DIR:-./backups}" "$DB_NAME")
  [[ -n "$SRC" ]] || die "no backup of $DB_NAME found in ${BACKUP_DIR:-./backups}"
fi
[[ -d "$SRC" ]] || die "backup directory not found: $SRC"
SRC=$(cd "$SRC" && pwd)
MANIFEST="$SRC/manifest.json"

verify_backup() {
  local hash name actual seen=' '
  [[ -f "$SRC/SHA256SUMS" ]] || fail_verify "SHA256SUMS is missing in $SRC"
  [[ -f "$MANIFEST" ]] || fail_verify "manifest.json is missing in $SRC"
  while read -r hash name; do
    [[ -n "$hash" ]] || continue
    case $name in
      db.sql.gz | media.tar.gz | manifest.json) ;;
      *) fail_verify "unexpected entry in SHA256SUMS: $name" ;;
    esac
    [[ -f "$SRC/$name" ]] || fail_verify "$name is listed in SHA256SUMS but missing"
    actual=$(sha256_file "$SRC/$name")
    [[ "$actual" == "$hash" ]] || fail_verify "checksum mismatch for $name"
    seen="$seen$name "
  done <"$SRC/SHA256SUMS"
  [[ "$seen" == *' db.sql.gz '* && "$seen" == *' manifest.json '* ]] ||
    fail_verify 'SHA256SUMS must cover db.sql.gz and manifest.json'
  if [[ -f "$SRC/media.tar.gz" && "$seen" != *' media.tar.gz '* ]]; then
    fail_verify 'media.tar.gz is not covered by SHA256SUMS'
  fi
  [[ "$(manifest_value "$MANIFEST" format)" == erp-backup/v1 ]] || fail_verify 'unsupported manifest format'
  gzip -t "$SRC/db.sql.gz" || fail_verify 'db.sql.gz failed the gzip integrity check'
  if [[ -f "$SRC/media.tar.gz" ]]; then
    tar -tzf "$SRC/media.tar.gz" >/dev/null || fail_verify 'media.tar.gz cannot be read'
  fi
  log "verified $SRC (created $(manifest_value "$MANIFEST" createdAt), app $(manifest_value "$MANIFEST" appVersion), database $(manifest_value "$MANIFEST" database), $(manifest_array "$MANIFEST" migrations | grep -c . || true) migrations, $(manifest_value "$MANIFEST" mediaFileCount) media files)"
}

verify_backup
if ((VERIFY_ONLY)); then exit 0; fi

if ((DO_MEDIA)) && [[ ! -f "$SRC/media.tar.gz" ]]; then
  log 'backup contains no media archive; skipping media'
  DO_MEDIA=0
fi
if ((DO_DB)); then
  [[ -n "$TARGET_DB" ]] || usage_error '--target-db is required (or pass --media-only)'
  valid_db_name "$TARGET_DB" || die "--target-db must match [A-Za-z0-9_]{1,64}: $TARGET_DB"
fi
if ((DO_MEDIA)); then
  [[ -n "$TARGET_DIR" ]] || usage_error '--target-dir is required (or pass --db-only)'
  [[ ! -e "$TARGET_DIR" || -d "$TARGET_DIR" ]] || die "--target-dir is not a directory: $TARGET_DIR"
fi

if ((DO_DB)); then
  load_db_env
  MYSQL=$(mysql_bin mysql)
  warn_if_mariadb_client "$MYSQL"
  trap cleanup_work_dir EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  init_work_dir
  sql 'SELECT 1' >/dev/null || die "cannot connect to MySQL at $DB_HOST:$DB_PORT as $DB_USER"
fi

# Check every target before modifying anything.
if ((DO_DB)) && db_exists "$TARGET_DB"; then
  objects=$(db_object_count "$TARGET_DB")
  if ((objects > 0 && !FORCE)); then refuse "database $TARGET_DB is not empty ($objects objects)"; fi
fi
if ((DO_MEDIA)) && [[ -d "$TARGET_DIR" && -n "$(ls -A "$TARGET_DIR")" && $FORCE -eq 0 ]]; then
  refuse "directory $TARGET_DIR is not empty"
fi

restore_db() {
  local charset collation expected actual tables
  charset=$(manifest_value "$MANIFEST" dbCharset)
  collation=$(manifest_value "$MANIFEST" dbCollation)
  [[ "$charset" =~ ^[A-Za-z0-9_]+$ ]] || charset=utf8mb4
  [[ "$collation" =~ ^[A-Za-z0-9_]+$ ]] || collation=utf8mb4_unicode_ci
  if db_exists "$TARGET_DB"; then
    if (($(db_object_count "$TARGET_DB") > 0)); then
      log "dropping and recreating database $TARGET_DB (--force)"
      sql "DROP DATABASE \`$TARGET_DB\`"
      sql "CREATE DATABASE \`$TARGET_DB\` CHARACTER SET $charset COLLATE $collation"
    fi
  else
    sql "CREATE DATABASE \`$TARGET_DB\` CHARACTER SET $charset COLLATE $collation"
  fi
  log "loading db.sql.gz into $TARGET_DB"
  gzip -dc "$SRC/db.sql.gz" |
    "$MYSQL" --defaults-file="$DEFAULTS_FILE" --default-character-set=utf8mb4 --max-allowed-packet=1G \
      --database="$TARGET_DB"

  expected=$(manifest_array "$MANIFEST" migrations)
  actual=''
  if table_exists "$TARGET_DB" SequelizeMeta; then
    actual=$(sql "SELECT name FROM \`$TARGET_DB\`.\`SequelizeMeta\` ORDER BY name")
  fi
  [[ "$expected" == "$actual" ]] || die "migration history in $TARGET_DB does not match the manifest"
  tables=$(sql "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$TARGET_DB' AND TABLE_TYPE = 'BASE TABLE'")
  [[ "$tables" == "$(manifest_value "$MANIFEST" tableCount)" ]] ||
    die "restored $tables tables but the manifest lists $(manifest_value "$MANIFEST" tableCount)"
  log "database restored: $tables tables, $(printf '%s\n' "$actual" | grep -c . || true) migrations applied"
}

restore_media() {
  local dir files expected
  mkdir -p "$TARGET_DIR"
  dir=$(cd "$TARGET_DIR" && pwd -P)
  [[ "$dir" != / ]] || die 'refusing to restore media into /'
  if [[ -n "$(ls -A "$dir")" ]]; then
    log "emptying $dir (--force)"
    find "$dir" -mindepth 1 -delete
  fi
  log "extracting media.tar.gz into $dir"
  tar --numeric-owner -xzf "$SRC/media.tar.gz" -C "$dir"
  files=$(find "$dir" -type f | wc -l)
  files=$((files))
  expected=$(manifest_value "$MANIFEST" mediaFileCount)
  [[ "$files" == "$expected" ]] || die "restored $files media files but the manifest lists $expected"
  log "media restored: $files files"
}

if ((DO_DB)); then restore_db; fi
if ((DO_MEDIA)); then restore_media; fi
log "restore of $SRC complete"
