#!/usr/bin/env bash
# Automated backup -> restore round trip. Creates (or uses, or restores from a backup) a source database
# and media directory, runs backup.sh, restores into a different scratch database and directory with
# restore.sh and verifies that tables, schema, exact row counts, CHECKSUM TABLE values, AUTO_INCREMENT
# counters, migration/seeder history and per-file media checksums all match. Also checks that a tampered
# backup fails verification, that non-empty targets are refused without --force, and that retention
# pruning keeps the newest backup.
# Scratch databases and files are always removed (unless --keep); exits non-zero on any mismatch.
#
# Usage: restore-test.sh [--source-db NAME] [--source-dir DIR] [--keep]
#        restore-test.sh --from-backup <backup-dir | latest> [--keep]
#   --source-db NAME   back up this existing database instead of creating and seeding a scratch one
#                      (only read, never modified or dropped; nothing may write to it during the test,
#                      so use --from-backup rather than a live production database)
#   --source-dir DIR   back up this existing media directory instead of generating sample files
#   --from-backup B    restore drill: first restore backup B (a backup.sh directory, or "latest" = the
#                      newest backup of DB_NAME in BACKUP_DIR) into a scratch database and directory, then
#                      use those as the source; logs how long that restore took
#   --keep             keep the scratch databases and work dir for inspection
#
# Environment:
#   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD or DB_PASSWORD_FILE, DB_SSL_MODE, DB_SSL_CA, MYSQL_BIN_DIR
#                                     as for backup.sh; the user needs CREATE/DROP on PREFIX_* databases
#   DB_NAME, BACKUP_DIR               only used to find "--from-backup latest", as for restore.sh
#   RESTORE_TEST_PREFIX (erp_restore_test)  name prefix of the scratch databases
#   RESTORE_TEST_WORK_DIR             scratch directory (must not exist yet; default: a unique directory
#                                     under BACKUP_TMPDIR, TMPDIR or /tmp); removed afterwards
#   BACKEND_DIR (<repo>/backend)      backend used to create, migrate and seed the scratch source DB
#   RESTORE_TEST_CLI (auto)           how to run the backend DB CLI: tsx (src), dist (compiled) or auto
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"
LOG_TAG=restore-test

usage() { sed -n '/^set -euo/q; 2,$ s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; }

SOURCE_DB=''
SOURCE_DIR=''
FROM_BACKUP=''
KEEP=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --source-db)
      [[ $# -ge 2 ]] || die '--source-db needs a value'
      SOURCE_DB=$2
      shift
      ;;
    --source-dir)
      [[ $# -ge 2 ]] || die '--source-dir needs a value'
      SOURCE_DIR=$2
      shift
      ;;
    --from-backup)
      [[ $# -ge 2 ]] || die '--from-backup needs a value'
      FROM_BACKUP=$2
      shift
      ;;
    --keep) KEEP=1 ;;
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
PREFIX=${RESTORE_TEST_PREFIX:-erp_restore_test}
RUN_ID="$(date -u +%H%M%S)_$$"
SRC_DB=${SOURCE_DB:-${PREFIX}_src_$RUN_ID}
DST_DB=${PREFIX}_dst_$RUN_ID
valid_db_name "$SRC_DB" || die "invalid source database name: $SRC_DB"
valid_db_name "$DST_DB" || die "invalid scratch database name (shorten RESTORE_TEST_PREFIX): $DST_DB"
BACKEND_DIR=${BACKEND_DIR:-$SCRIPT_DIR/../../backend}
if [[ -n "$SOURCE_DIR" ]]; then
  [[ -d "$SOURCE_DIR" ]] || die "--source-dir does not exist: $SOURCE_DIR"
  SOURCE_DIR=$(cd "$SOURCE_DIR" && pwd)
fi
if [[ -n "$FROM_BACKUP" ]]; then
  [[ -z "$SOURCE_DB" && -z "$SOURCE_DIR" ]] || die '--from-backup cannot be combined with --source-db or --source-dir'
  if [[ "$FROM_BACKUP" == latest ]]; then
    FROM_BACKUP=$(latest_backup "${BACKUP_DIR:-./backups}" "$DB_NAME")
    [[ -n "$FROM_BACKUP" ]] || die "no backup of $DB_NAME found in ${BACKUP_DIR:-./backups}"
  fi
  [[ -d "$FROM_BACKUP" ]] || die "backup directory not found: $FROM_BACKUP"
  FROM_BACKUP=$(cd "$FROM_BACKUP" && pwd)
fi

if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD=(shasum -a 256)
else
  die 'sha256sum or shasum is required'
fi
command -v diff >/dev/null 2>&1 || die 'diff is required'
MYSQL=$(mysql_bin mysql)
warn_if_mariadb_client "$MYSQL"

TEST_DIR=${RESTORE_TEST_WORK_DIR:-${BACKUP_TMPDIR:-${TMPDIR:-/tmp}}/erp-restore-test.$$}
TEST_DIR=${TEST_DIR%/}
[[ ! -e "$TEST_DIR" ]] || die "work dir already exists: $TEST_DIR"
mkdir -p "$(dirname "$TEST_DIR")"
(umask 077 && mkdir "$TEST_DIR")
TEST_DIR=$(cd "$TEST_DIR" && pwd)
# backup.sh and restore.sh create their option files inside the work dir too.
BACKUP_TMPDIR=$TEST_DIR
export BACKUP_TMPDIR

CREATED_DBS=()
FAILURES=0
cleanup() {
  local rc=$? db
  if ((KEEP)); then
    log "keeping work dir $TEST_DIR and databases: ${CREATED_DBS[*]+${CREATED_DBS[*]}}"
  else
    for db in ${CREATED_DBS[@]+"${CREATED_DBS[@]}"}; do
      sql "DROP DATABASE IF EXISTS \`$db\`" || log "WARNING: could not drop scratch database $db"
    done
  fi
  cleanup_work_dir
  if ((!KEEP)); then rm -rf "$TEST_DIR"; fi
  if ((rc == 0)); then log 'restore test PASSED'; else log "restore test FAILED (exit $rc)"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
init_work_dir
sql 'SELECT 1' >/dev/null || die "cannot connect to MySQL at $DB_HOST:$DB_PORT as $DB_USER"
log "MySQL $(sql 'SELECT VERSION()') at $DB_HOST:$DB_PORT; client: $("$MYSQL" --version)"

run_cli() {
  local mode=${RESTORE_TEST_CLI:-auto} tsx=''
  [[ -d "$BACKEND_DIR" ]] || die "backend not found at $BACKEND_DIR (set BACKEND_DIR or pass --source-db)"
  for tsx in "$BACKEND_DIR/node_modules/.bin/tsx" "$BACKEND_DIR/../node_modules/.bin/tsx" ''; do
    [[ -z "$tsx" || -x "$tsx" ]] && break
  done
  if [[ "$mode" == auto ]]; then
    if [[ -n "$tsx" ]]; then mode=tsx; else mode=dist; fi
  fi
  (
    cd "$BACKEND_DIR"
    # The backend reads DB_PASSWORD from its environment (as in production); demo data gives every
    # module's core tables some rows.
    export NODE_ENV=development LOG_LEVEL=warn SEED_DEMO_DATA=true DB_HOST DB_PORT DB_USER DB_PASSWORD
    export DB_NAME="$SRC_DB"
    case $mode in
      tsx)
        [[ -n "$tsx" ]] || die 'tsx not found; run npm ci or set RESTORE_TEST_CLI=dist'
        "$tsx" src/infrastructure/database/cli.ts "$@"
        ;;
      dist)
        [[ -f dist/infrastructure/database/cli.js ]] || die 'backend/dist is missing; run npm run build -w backend'
        node dist/infrastructure/database/cli.js "$@"
        ;;
      *) die "RESTORE_TEST_CLI must be tsx, dist or auto" ;;
    esac
  )
}

create_source_db() {
  db_exists "$SRC_DB" && die "scratch database $SRC_DB already exists"
  CREATED_DBS+=("$SRC_DB")
  log "creating, migrating and seeding source database $SRC_DB"
  run_cli create
  run_cli migrate
  run_cli seed
  # Values the app tables may not contain yet: 4-byte UTF-8, quotes/backslashes/control characters,
  # binary, JSON, decimals, fractional timestamps, NULLs and an AUTO_INCREMENT gap.
  sql "CREATE TABLE \`$SRC_DB\`.\`zz_restore_test_fixture\` (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      label VARCHAR(191) NOT NULL,
      payload JSON NULL,
      data VARBINARY(64) NULL,
      body LONGTEXT NULL,
      amount DECIMAL(12,2) NULL,
      at DATETIME(3) NULL,
      flag TINYINT(1) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    INSERT INTO \`$SRC_DB\`.\`zz_restore_test_fixture\` (label, payload, data, body, amount, at, flag) VALUES
      ('emoji 🎓 देवनागरी Ünïcödé', JSON_OBJECT('k', 'v', 'n', 1, 'nested', JSON_ARRAY(1, 'x')), UNHEX('00FF10E200'), REPEAT('long text ', 20000), 1234.56, '2026-01-02 03:04:05.678', 1),
      ('quotes '' \" and \\\\ backslash; -- not a comment', NULL, NULL, NULL, NULL, NULL, 0),
      ('control\\nchars\\there\\r', JSON_ARRAY(), X'', '', -0.01, '1970-01-01 00:00:01.000', 0),
      ('deleted row', NULL, NULL, NULL, NULL, NULL, 0);
    DELETE FROM \`$SRC_DB\`.\`zz_restore_test_fixture\` WHERE label = 'deleted row';"
}

create_sample_media() {
  local dir=$1
  mkdir -p "$dir/institutes/1/files/2026/11" "$dir/institutes/2/lms/hls/abc" "$dir/empty-dir"
  head -c 262144 /dev/urandom >"$dir/institutes/1/files/2026/11/random.bin"
  printf 'hello world\n' >"$dir/institutes/1/files/2026/11/file with spaces.txt"
  printf 'unicode name\n' >"$dir/institutes/2/lms/hls/abc/नमस्ते-ü.txt"
  printf '#EXTM3U\n' >"$dir/institutes/2/lms/hls/abc/index.m3u8"
  : >"$dir/institutes/2/lms/hls/abc/empty.ts"
  printf 'dotfile\n' >"$dir/.hidden"
}

snapshot_db() { # db outdir
  local db=$1 out=$2 t list='' counts=''
  mkdir -p "$out"
  sql "SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COLLATION, ROW_FORMAT FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = '$db' ORDER BY TABLE_NAME" >"$out/tables.tsv"
  sql "SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, IFNULL(COLUMN_DEFAULT, '<null>'),
      EXTRA, IFNULL(CHARACTER_SET_NAME, ''), IFNULL(COLLATION_NAME, '')
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '$db' ORDER BY TABLE_NAME, ORDINAL_POSITION" >"$out/columns.tsv"
  sql "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, IFNULL(COLUMN_NAME, ''), IFNULL(SUB_PART, ''), INDEX_TYPE
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = '$db'
    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX" >"$out/indexes.tsv"
  sql "SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME,
      k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA = '$db' AND k.REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION" >"$out/foreign-keys.tsv"
  # A never-used counter can read NULL on the source but 1 on the restored copy (same next id).
  sql "SET SESSION information_schema_stats_expiry = 0;
    SELECT t.TABLE_NAME, IFNULL(t.AUTO_INCREMENT, 1) FROM information_schema.TABLES t
    WHERE t.TABLE_SCHEMA = '$db' AND t.TABLE_TYPE = 'BASE TABLE' AND EXISTS (
      SELECT 1 FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA
        AND c.TABLE_NAME = t.TABLE_NAME AND c.EXTRA LIKE '%auto_increment%')
    ORDER BY t.TABLE_NAME" >"$out/auto-increment.tsv"
  sql "SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = '$db' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME" >"$TEST_DIR/table-names.txt"
  while IFS= read -r t; do
    [[ "$t" =~ ^[A-Za-z0-9_]+$ ]] || die "unexpected table name in $db: $t"
    [[ -z "$list" ]] || list+=', '
    list+="\`$db\`.\`$t\`"
    [[ -z "$counts" ]] || counts+=' UNION ALL '
    counts+="SELECT '$t', COUNT(*) FROM \`$db\`.\`$t\`"
  done <"$TEST_DIR/table-names.txt"
  [[ -n "$list" ]] || die "database $db has no tables"
  sql "$counts" >"$out/row-counts.tsv"
  sql "CHECKSUM TABLE $list" | sed "s/^$db\\.//" >"$out/checksums.tsv"
  : >"$out/migrations.tsv"
  : >"$out/seeders.tsv"
  if table_exists "$db" SequelizeMeta; then
    sql "SELECT name FROM \`$db\`.\`SequelizeMeta\` ORDER BY name" >"$out/migrations.tsv"
  fi
  if table_exists "$db" SequelizeData; then
    sql "SELECT name FROM \`$db\`.\`SequelizeData\` ORDER BY name" >"$out/seeders.tsv"
  fi
}

# macOS bsdtar extracts non-ASCII names in decomposed form (NFD) and APFS treats both forms as the
# same file, so names are compared in composed form there. GNU tar on Linux keeps the exact bytes.
normalize_names() {
  if [[ "$(uname -s)" == Darwin ]] && command -v iconv >/dev/null 2>&1; then
    iconv -f UTF-8-MAC -t UTF-8
  else
    cat
  fi
}

snapshot_media() { # dir outdir
  mkdir -p "$2"
  (cd "$1" && find . -type f -print0 | xargs -0 -r "${SHA_CMD[@]}") | normalize_names | sort -k 2 \
    >"$2/media-files.sha256"
  (cd "$1" && find . -type d) | normalize_names | sort >"$2/media-dirs.txt"
}

compare_snapshots() { # label src dst
  local f name
  for f in "$2"/*; do
    name=${f##*/}
    if ! diff -u "$f" "$3/$name" >"$TEST_DIR/diff.out"; then
      log "MISMATCH ($1) in $name:"
      head -n 40 "$TEST_DIR/diff.out" >&2
      FAILURES=$((FAILURES + 1))
    fi
  done
}

expect_exit() { # expected-code description command...
  local expected=$1 what=$2 rc=0
  shift 2
  "$@" || rc=$?
  if ((rc == expected)); then
    log "ok: $what (exit $rc)"
  else
    log "FAIL: $what: expected exit $expected, got $rc"
    FAILURES=$((FAILURES + 1))
  fi
}

# 1. Source database and media.
MEDIA_SRC=${SOURCE_DIR:-$TEST_DIR/media-src}
DRILL_SECONDS=''
if [[ -n "$FROM_BACKUP" ]]; then
  db_exists "$SRC_DB" && die "scratch database $SRC_DB already exists"
  CREATED_DBS+=("$SRC_DB")
  log "restore drill: restoring $FROM_BACKUP into $SRC_DB and $MEDIA_SRC"
  SECONDS=0
  bash "$SCRIPT_DIR/restore.sh" --target-db "$SRC_DB" --target-dir "$MEDIA_SRC" "$FROM_BACKUP"
  DRILL_SECONDS=$SECONDS
  log "restore drill: restored ${FROM_BACKUP##*/} in ${DRILL_SECONDS}s"
  # A --no-media backup has no media archive.
  mkdir -p "$MEDIA_SRC"
elif [[ -n "$SOURCE_DB" ]]; then
  db_exists "$SRC_DB" || die "source database $SRC_DB does not exist"
  log "using existing source database $SRC_DB (read-only)"
else
  create_source_db
fi
if [[ -z "$SOURCE_DIR" && -z "$FROM_BACKUP" ]]; then create_sample_media "$MEDIA_SRC"; fi
MEDIA_DST=$TEST_DIR/media-restored
BACKUPS=$TEST_DIR/backups
snapshot_db "$SRC_DB" "$TEST_DIR/snap-src"
snapshot_media "$MEDIA_SRC" "$TEST_DIR/snap-src"
grep -q . "$TEST_DIR/snap-src/migrations.tsv" || log 'WARNING: source database has no SequelizeMeta rows'

# 2. Backup.
SECONDS=0
BACKUP=$(DB_NAME=$SRC_DB STORAGE_DIR=$MEDIA_SRC BACKUP_DIR=$BACKUPS BACKUP_KEEP_COUNT=0 BACKUP_KEEP_DAYS=0 \
  APP_VERSION=restore-test bash "$SCRIPT_DIR/backup.sh")
BACKUP_SECONDS=$SECONDS
[[ -d "$BACKUP" ]] || die "backup.sh did not print a backup directory"

# 3. A corrupted copy must fail verification (exit 4) before anything is restored.
cp -R "$BACKUP" "$TEST_DIR/tampered"
printf 'x' >>"$TEST_DIR/tampered/db.sql.gz"
expect_exit 4 'tampered backup is rejected' bash "$SCRIPT_DIR/restore.sh" --verify-only "$TEST_DIR/tampered"
rm -rf "$TEST_DIR/tampered"

# 4. Restore into a different database and directory, then compare.
CREATED_DBS+=("$DST_DB")
db_exists "$DST_DB" && die "scratch database $DST_DB already exists"
SECONDS=0
bash "$SCRIPT_DIR/restore.sh" --target-db "$DST_DB" --target-dir "$MEDIA_DST" "$BACKUP"
RESTORE_SECONDS=$SECONDS
snapshot_db "$DST_DB" "$TEST_DIR/snap-dst"
snapshot_media "$MEDIA_DST" "$TEST_DIR/snap-dst"
compare_snapshots 'first restore' "$TEST_DIR/snap-src" "$TEST_DIR/snap-dst"

# 5. Non-empty targets are refused without --force (exit 3).
expect_exit 3 'non-empty target database is refused' \
  bash "$SCRIPT_DIR/restore.sh" --db-only --target-db "$DST_DB" "$BACKUP"
# The media of a DB-only drill source is empty; the directory must not be for this check.
if [[ -z "$(ls -A "$MEDIA_DST")" ]]; then printf 'existing\n' >"$MEDIA_DST/existing-file.txt"; fi
expect_exit 3 'non-empty target directory is refused' \
  bash "$SCRIPT_DIR/restore.sh" --media-only --target-dir "$MEDIA_DST" "$BACKUP"

# 6. A second backup with BACKUP_KEEP_COUNT=1 prunes the first; --force restores "latest" over the targets.
sleep 1
DB_NAME=$SRC_DB STORAGE_DIR=$MEDIA_SRC BACKUP_DIR=$BACKUPS BACKUP_KEEP_COUNT=1 BACKUP_KEEP_DAYS=0 \
  APP_VERSION=restore-test bash "$SCRIPT_DIR/backup.sh" >/dev/null
if [[ -d "$BACKUP" ]]; then
  log "FAIL: retention did not prune $BACKUP"
  FAILURES=$((FAILURES + 1))
fi
printf 'stale\n' >"$MEDIA_DST/stale-file-from-before.txt"
DB_NAME=$SRC_DB BACKUP_DIR=$BACKUPS bash "$SCRIPT_DIR/restore.sh" --force \
  --target-db "$DST_DB" --target-dir "$MEDIA_DST" latest
rm -rf "$TEST_DIR/snap-dst"
snapshot_db "$DST_DB" "$TEST_DIR/snap-dst"
snapshot_media "$MEDIA_DST" "$TEST_DIR/snap-dst"
compare_snapshots 'forced restore of latest' "$TEST_DIR/snap-src" "$TEST_DIR/snap-dst"

TABLES=$(grep -c . "$TEST_DIR/snap-src/row-counts.tsv" || true)
ROWS=0
while IFS=$'\t' read -r _ count; do ROWS=$((ROWS + count)); done <"$TEST_DIR/snap-src/row-counts.tsv"
MEDIA_COUNT=$(grep -c . "$TEST_DIR/snap-src/media-files.sha256" || true)
MIGRATION_COUNT=$(grep -c . "$TEST_DIR/snap-src/migrations.tsv" || true)
log "compared $TABLES tables, $ROWS rows, $MIGRATION_COUNT migrations, $MEDIA_COUNT media files;${DRILL_SECONDS:+ drill restore ${DRILL_SECONDS}s,} backup ${BACKUP_SECONDS}s, restore ${RESTORE_SECONDS}s"
if ((FAILURES > 0)); then die "$FAILURES check(s) failed"; fi
