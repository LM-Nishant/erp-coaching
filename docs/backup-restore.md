# Backup and restore

The system's state lives in two places: the MySQL database, and the media files (uploads, lecture videos, documents) on
the `storage` volume. Three scripts in [`deploy/backup/`](../deploy/backup) protect them:

- `backup.sh` dumps the database and archives the media into a timestamped, checksummed directory, then deletes old
  backups;
- `restore.sh` verifies a backup and restores it into a database and a directory of your choice;
- `restore-test.sh` backs up, restores and compares everything automatically. CI runs it, and you can run it on your
  own backups as a restore drill.

They run in the `backup` and `restore` services of the compose stack (profile `ops`, image `erp-backup` with the
MySQL 8.4 client tools), or directly on any host with bash and the MySQL 8 clients. Unless stated otherwise, the
commands below run in `deploy/` on the server, as in [deployment.md](deployment.md).

- [What is backed up](#what-is-backed-up)
- [What is not backed up](#what-is-not-backed-up)
- [Taking a backup](#taking-a-backup)
- [Schedule](#schedule)
- [Retention and disk space](#retention-and-disk-space)
- [Offsite copies](#offsite-copies)
- [Restore](#restore)
- [Restore test](#restore-test)
- [RPO and RTO](#rpo-and-rto)

## What is backed up

Each backup is a directory named after the database and the UTC start time, for example
`backups/erp_coaching-20261118T021500Z/`:

| File            | Contents                                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db.sql.gz`     | The database as a gzipped `mysqldump`: schema and data, with the migration history (`SequelizeMeta`) and the seeder history (`SequelizeData`). It has no `CREATE DATABASE` or `USE` statement, so it can be restored under any database name         |
| `media.tar.gz`  | The media directory (the API's `STORAGE_LOCAL_ROOT`, the `storage` volume), with numeric owners and file modes. Not present in `--no-media` backups                                                                                                  |
| `manifest.json` | Start and end time; `appVersion` (`ERP_IMAGE_TAG` at backup time); the database name, charset and collation; the MySQL server and client versions; the table and media file counts; each file's size and SHA-256; the applied migrations and seeders |
| `SHA256SUMS`    | SHA-256 checksums of the other three files, in `sha256sum -c` format                                                                                                                                                                                 |

How a backup is made:

- **Database:** `mysqldump --single-transaction` reads a consistent snapshot of all tables as of the start of the dump,
  without locking the application out. It also dumps routines, triggers and events, writes binary columns in hex, uses
  utf8mb4, and skips tablespace statements and, when the client supports it, the GTID state. The dump must end with
  mysqldump's `-- Dump completed` line, otherwise the backup fails.
- **Media:** archived with tar after the dump. The archive must pass `gzip -t` and must be listable.
- **All or nothing:** the files are written into `<name>.partial`, which is renamed once everything is complete. A
  failed run deletes its partial directory and exits non-zero. Partial directories left behind by killed runs are
  deleted after a day.
- **Private:** directories are created with mode 0700 and files with mode 0600.
- **Output:** the log goes to stderr, with UTC timestamps. The last line on stdout is the path of the new backup.

### Consistency between the database and the media

The database snapshot is taken when the dump starts, and the media are archived after the dump ends, while the app keeps
running. Changes in between can leave:

- files without a database row (uploaded after the snapshot). They are harmless, since nothing refers to them;
- database rows without their file (the file was deleted after the snapshot). These files are missing after a restore;
- a file that was being written while tar read it. The log then warns that some media files changed while they were
  archived, and the file is archived as it was at that moment.

Schedule backups for quiet hours. For a fully consistent backup, for example before a risky manual change, stop the api
for the duration. nginx answers 503 meanwhile:

```sh
docker compose stop api && docker compose --profile ops run --rm backup; docker compose start api
```

Don't take backups while migrations run: DDL statements wait for the dump to finish, or the dump fails. The
[upgrade procedure](deployment.md#upgrades) takes its backup before migrating.

## What is not backed up

Keep these elsewhere. You need them to restore onto a new server:

- **Secrets and configuration:** `deploy/.env`, `deploy/secrets/` (or `ERP_SECRETS_DIR`), and the host-specific
  `docker-compose.override.yml` and `deploy/local/`. Keep them in a password manager or secret vault, never next to the
  backups ([secrets](deployment.md#secrets)).
  - Above all, keep `ENCRYPTION_KEY`. The integration credentials stored in the database (payment, notification and AI
    settings, offline LMS keys) can only be decrypted with the key that encrypted them. After
    [rotating it](deployment.md#rotating-the-encryption-key), keep the old key as long as you keep backups made before
    the rotation.
- **TLS certificates:** `deploy/certs/` (or `ERP_CERTS_DIR`) and certbot's `/etc/letsencrypt`. They can be issued
  again, but with many custom domains Let's Encrypt's rate limits slow that down. Include both directories in the
  encrypted [offsite copies](#offsite-copies); they contain private keys.
- **MySQL users and grants:** the `mysql` container creates `DB_USER`, with all privileges on `DB_NAME`, when it
  initialises an empty volume. Grants are stored by database name, so they survive a restore over the same database.
- **Everything else:** the `api-tmp` and `redis-data` volumes, the MySQL binary logs, the container logs, and the
  images. Keep the release images in your registry ([building images](deployment.md#building-images)).

## Taking a backup

```sh
docker compose --profile ops run --rm backup              # database and media
docker compose --profile ops run --rm backup --no-media   # database only
docker compose --profile ops run --rm backup --no-prune   # don't delete old backups this time
```

The `backup` service connects as the MySQL `root` user, with the password from `secrets/mysql_root_password`. It mounts
the `storage` volume read-only and writes into `BACKUP_HOST_DIR`. Its image, `erp-backup`, is built or pulled with the
other images.

| Variable (`deploy/.env`)   | Default     | Meaning                                                                                                     |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `BACKUP_HOST_DIR`          | `./backups` | Host directory of the backups, relative to `deploy/`. Prefer an absolute path on a disk other than Docker's |
| `BACKUP_KEEP_COUNT`        | `14`        | Keep at most this many backups (`0`: no limit)                                                              |
| `BACKUP_KEEP_DAYS`         | `30`        | Delete backups older than this many days (`0`: no limit)                                                    |
| `BACKUP_UID`, `BACKUP_GID` | `0`         | Owner of the backup files on the host                                                                       |

With a non-root `BACKUP_UID`, that user needs write access to `BACKUP_HOST_DIR` and read access to
`secrets/mysql_root_password`. Compose mounts secret files with their host owner and mode, so for example run
`chgrp <BACKUP_GID> secrets/mysql_root_password && chmod 640 secrets/mysql_root_password`. The api creates the media
files readable by everyone, so they need no change.

### Without Docker

`backup.sh` and `restore.sh` also run directly on a host, for example against a managed MySQL server. They need bash,
gzip, tar, `sha256sum` or `shasum`, and the MySQL 8 `mysql` and `mysqldump` clients. MariaDB's clients are not
supported, and the scripts warn when they find them. The variables have the same names as the backend's:

```sh
DB_HOST=db.internal DB_USER=erp_backup DB_PASSWORD_FILE=/etc/erp/backup-db-password DB_NAME=erp_coaching \
  STORAGE_DIR=/var/lib/erp/storage BACKUP_DIR=/srv/backups/erp deploy/backup/backup.sh
```

| Variable                                   | Default                                     | Meaning                                                                                      |
| ------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME` | `127.0.0.1`, `3306`, `root`, `erp_coaching` | The database to back up                                                                      |
| `DB_PASSWORD` or `DB_PASSWORD_FILE`        |                                             | The password, or a file that contains it. Prefer the file in scheduled jobs                  |
| `DB_SSL_MODE`, `DB_SSL_CA`                 |                                             | TLS to MySQL, for example `VERIFY_IDENTITY` and the CA certificate file                      |
| `STORAGE_DIR`                              |                                             | The media directory, the API's `STORAGE_LOCAL_ROOT`. Required unless `--no-media`            |
| `BACKUP_DIR`                               | `./backups`                                 | Where the backups go                                                                         |
| `BACKUP_KEEP_COUNT`, `BACKUP_KEEP_DAYS`    | `14`, `30`                                  | [Retention](#retention-and-disk-space)                                                       |
| `MYSQL_BIN_DIR`                            | `PATH`                                      | Directory of the `mysql` and `mysqldump` binaries to use, for example `/usr/local/mysql/bin` |
| `APP_VERSION`                              | `unknown`                                   | Recorded in the manifest                                                                     |
| `BACKUP_TMPDIR`                            | `TMPDIR` or `/tmp`                          | Where the temporary client option file is created                                            |

The password never appears on a command line, where `ps` would show it. The scripts write it into a temporary option
file (mode 0600, in a private directory) and pass that file with `--defaults-file`, so other option files and
`~/.mylogin.cnf` are ignored.

A dedicated backup user only needs read privileges. With `--single-transaction` and `--no-tablespaces`, mysqldump
needs neither `LOCK TABLES` nor `PROCESS`:

```sql
CREATE USER 'erp_backup'@'%' IDENTIFIED BY '<password>';
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON erp_coaching.* TO 'erp_backup'@'%';
```

The schema has no stored procedures or functions. If it ever gets some, also grant the global `SHOW_ROUTINE`
privilege. Restores need all privileges on the target database, which is why the compose services use `root`.

## Schedule

Take a full backup every night with cron on the host, and copy it offsite right after it ([offsite
copies](#offsite-copies)). For example, in `/etc/cron.d/erp-backup`:

```crontab
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Daily full backup at 02:15, server time.
15 2 * * * root cd /srv/erp/deploy && flock -n /run/lock/erp-backup-daily.lock docker compose --profile ops run --rm -T backup >>/var/log/erp-backup.log 2>&1
# Optional: hourly database-only backups, kept for two days.
45 * * * * root cd /srv/erp/deploy && BACKUP_HOST_DIR=./backups/hourly BACKUP_KEEP_COUNT=48 BACKUP_KEEP_DAYS=2 flock -n /run/lock/erp-backup-hourly.lock docker compose --profile ops run --rm -T backup --no-media >>/var/log/erp-backup.log 2>&1
```

- `-T` runs the container without a terminal, as cron has none. `flock -n` skips a run while the previous one is still
  going.
- Variables set on the command line take precedence over `deploy/.env`. The hourly job writes into a subdirectory
  of the daily directory, which the daily retention never touches. If `BACKUP_HOST_DIR` is an absolute path, use a
  subdirectory of that path. To restore an hourly backup, prefix the restore command with the same `BACKUP_HOST_DIR`.
  Hourly backups contain no media, so restoring one leaves the media as they are.
- Rotate `/var/log/erp-backup.log` with logrotate.

Alert when backups stop:

- **No recent backup:** the backup directory's name ends in `Z` only once the backup is complete. This check fails when
  no backup has completed in the last 26 hours:

  ```sh
  find /srv/erp/deploy/backups -maxdepth 1 -type d -name 'erp_coaching-*Z' -mmin -1560 | grep -q .
  ```

- **Heartbeat:** alternatively, append `&& curl -fsS --retry 3 <heartbeat URL>` to the cron command, and let your
  heartbeat monitor alert when the pings stop.
- **Failures:** a failed run logs `backup FAILED (exit N)`.
- **Offsite copies:** alert on the age of the newest offsite copy as well.

A logical backup can't lose less than the interval between two backups. For a lower [RPO](#rpo-and-rto), consider:

- point-in-time recovery from the MySQL binary logs, which MySQL 8.4 writes by default. These scripts don't record the
  binary log position or copy the logs, so this needs a dedicated tool;
- a replica on another server;
- a managed MySQL service with point-in-time recovery;
- syncing the `storage` volume offsite more often than nightly.

## Retention and disk space

After each successful backup, `backup.sh` deletes the backups of the same database in `BACKUP_DIR`:

- the oldest ones beyond the newest `BACKUP_KEEP_COUNT`;
- the ones older than `BACKUP_KEEP_DAYS`.

The backup just written always counts as kept. A failed run deletes nothing. Other files and directories in
`BACKUP_DIR` are left alone. The defaults (14 backups, 30 days) keep two weeks of daily backups. Keep weekly and
monthly backups in the offsite storage instead.

Disk space:

- **Every full backup contains all the media.** There are no incremental backups. Plan for `BACKUP_KEEP_COUNT` times
  (compressed dump + media archive), plus room for the next backup.
- **Videos don't compress,** so the media archive is about as large as the `storage` volume. `docker system df -v` shows
  the volume sizes.
- **Large media:** take the daily backups with `--no-media`, and back up the `storage` volume with an incremental,
  deduplicating tool such as restic or borg instead. Its files are in `/var/lib/docker/volumes/erp_storage/_data`
  (see `docker volume inspect erp_storage`). A restore then combines `restore.sh --db-only` with that tool's restore.
- **Separate disk:** keep the backups on a different disk from the database (an absolute `BACKUP_HOST_DIR`), so that
  one failed or full disk doesn't take both. Local backups don't protect against losing the server; offsite copies do.

The backups contain all the personal data in the system. Data deleted in the app stays in the backups until they
expire, so align the local and offsite retention with your data protection policy.

## Offsite copies

Copy every backup to another location right after it is taken:

- **Where:** object storage (S3, R2, B2 or similar) or a server in another location, in an account that the
  production server can't administer.
- **Encryption:** encrypt the backups on the server, before upload. They contain personal data and password hashes.
  restic and borg encrypt, deduplicate and apply retention policies; rclone does it with a `crypt` remote.
- **Write-only access:** someone who takes over the server must not be able to delete the copies. Use an append-only
  repository (restic's rest-server with `--append-only`, borg's `append_only` mode) or a bucket with object lock or
  versioning. Prune from a separate, trusted machine.
- **Keys:** keep the repository's password in the vault, with `.env`. Without it, the copies are useless.
- **Checks:** from time to time, fetch a copy onto another machine and run the [restore drill](#restore-drill) on it. At
  the least, run `deploy/backup/restore.sh --verify-only <dir>`, which only needs bash, gzip, tar and `sha256sum`.

For example with restic, after the nightly backup (with `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` and the storage
credentials in the environment):

```sh
restic backup --exclude '*.partial' /srv/erp/deploy/backups /srv/erp/deploy/certs /etc/letsencrypt
restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune   # on the trusted machine if append-only
```

## Restore

### How restore.sh works

`restore.sh` checks the backup before it changes anything:

- every file in `SHA256SUMS` matches its checksum, and the list covers `db.sql.gz`, `manifest.json` and, if present,
  `media.tar.gz`, and nothing else;
- the manifest has the expected format;
- the dump passes `gzip -t`, and the media archive can be read.

It refuses to restore into a database that contains any table, view, routine or event, or into a non-empty directory,
unless you pass `--force`. With `--force`, it drops and recreates the database, with the charset and collation from the
manifest, and empties the directory. After loading, it checks that the migration history and the table count match the
manifest, and that the expected number of media files was restored.

| Option                      | Meaning                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--target-db NAME`          | Database to restore into, created if it doesn't exist. Required unless `--media-only`                                    |
| `--target-dir DIR`          | Directory to extract the media into, created if it doesn't exist. Required unless `--db-only` or the backup has no media |
| `--force`                   | Replace a non-empty database or directory                                                                                |
| `--db-only`, `--media-only` | Restore only one of the two                                                                                              |
| `--verify-only`             | Only check the backup                                                                                                    |
| `<dir>` or `latest`         | The backup directory, or the newest backup of `DB_NAME` in `BACKUP_DIR`                                                  |

| Exit code | Meaning                                                                          |
| --------- | -------------------------------------------------------------------------------- |
| 0         | Restored (or verified)                                                           |
| 1         | Error: no connection, a missing file, or a check after the restore failed        |
| 2         | Wrong usage                                                                      |
| 3         | Refused: the target is not empty and `--force` wasn't given. Nothing was changed |
| 4         | Verification failed: the backup is damaged or incomplete. Nothing was changed    |

In the `restore` service, the backups are under `/backups` (the host's `BACKUP_HOST_DIR`), so pass
`/backups/erp_coaching-20261118T021500Z` or `latest`. The backup directories belong to `BACKUP_UID`, so list them on
the host as that user or root.

### Verifying a backup

```sh
docker compose --profile ops run --rm restore --verify-only latest
docker compose --profile ops run --rm restore --verify-only /backups/erp_coaching-20261118T021500Z
```

The log shows the backup's creation time, app version, database, and migration and media counts.

### Restoring production in place

Use this after data loss or corruption, or when the [migration rollback plan](deployment.md#migration-rollback-plan)
calls for the pre-upgrade backup. Everything written after the backup is lost.

1. Choose the backup and verify it, as above. Note its `appVersion`.
2. Make sure no scheduled backup runs during the restore: comment out the cron entries.
3. Stop the api. It also runs the jobs worker, and nothing may write during the restore. Stop any separate worker
   containers as well ([jobs and workers](deployment.md#jobs-and-workers)). nginx answers 503 meanwhile:

   ```sh
   docker compose stop api
   ```

4. Optionally, back up the current state first, for later analysis or to recover single records from it. Pass
   `--no-prune`, so that this extra backup doesn't delete the oldest one, which might be the one you need:

   ```sh
   docker compose --profile ops run --rm backup --no-prune
   ```

5. Restore. Name the backup directory explicitly: after step 4, `latest` is the safety backup. Use your `DB_NAME` if it
   isn't `erp_coaching`:

   ```sh
   docker compose --profile ops run --rm restore --force \
     --target-db erp_coaching --target-dir /var/lib/erp/storage /backups/erp_coaching-20261118T021500Z
   ```

6. Requeue the jobs that were running when the backup was taken. No worker is running now, so all of them are stale
   ([background jobs](deployment.md#background-jobs)). The api would reclaim them by itself, but it fails any job that
   was on its last attempt, so requeue them all now:

   ```sh
   docker compose exec mysql mysql -uroot -p erp_coaching -e \
     "UPDATE jobs SET status = 'pending', locked_at = NULL, run_at = UTC_TIMESTAMP() WHERE status = 'running'"
   ```

7. Choose the release:
   - to return to the state before a failed upgrade, set `ERP_IMAGE_TAG` to the backup's `appVersion`
     ([rollback](deployment.md#rollback));
   - otherwise, keep the current release. `migrate` applies its newer migrations to the restored database.
8. Start the stack with `docker compose up -d --wait`. Check `/api/ready`, sign in, and spot-check recent records and
   files. Then re-enable the cron entries.

The restore runs as root, so the media files get their original owners back, including the api's `node` user. When you
run `restore.sh` on a host instead, run it as root too, or `chown` the media directory to the api's user afterwards.
Otherwise `/api/ready` reports the storage as not writable.

### Restoring into a separate database

To look at old data or recover single records, restore into another database and copy what you need:

```sh
docker compose --profile ops run --rm restore --db-only --target-db erp_coaching_restore \
  /backups/erp_coaching-20261118T021500Z
docker compose exec mysql mysql -uroot -p erp_coaching_restore
```

Copy rows with `INSERT … SELECT` across the two databases. Mind foreign keys and ids that were reused since the backup.
Drop the copy afterwards with `DROP DATABASE erp_coaching_restore;`.

For single files, restore the media with `--media-only --target-dir /backups/restore-media`, which appears on the host
in `BACKUP_HOST_DIR`. Copy the files you need back with `docker compose cp -a <file> api:/var/lib/erp/storage/<path>`,
then delete the directory, which contains personal data.

### Restoring onto a new server

1. Prepare the server ([prerequisites](deployment.md#prerequisites)), clone the repository to `/srv/erp` and check out
   the release that took the backup (the manifest's `appVersion`), or a newer one.
2. Restore `deploy/.env`, `deploy/secrets/` and any host-specific files from the vault. The secrets in the backup
   decrypt only with the keys configured when it was taken: use them as `ENCRYPTION_KEY` and
   `ENCRYPTION_PREVIOUS_KEYS`, or keep a newer `ENCRYPTION_KEY`, list the backup's keys in `ENCRYPTION_PREVIOUS_KEYS`
   and [re-encrypt](deployment.md#rotating-the-encryption-key) after the restore. Set `ERP_IMAGE_TAG` to the release
   you checked out.
3. Build or pull the images ([building images](deployment.md#building-images)).
4. Fetch the backup into `BACKUP_HOST_DIR`, for example with `restic restore`, and verify it:

   ```sh
   docker compose --profile ops run --rm restore --verify-only latest
   ```

   This also starts MySQL, which initialises its empty volume with the users and passwords from `.env` and `secrets/`.

5. Restore. `--force` isn't needed, because the database that MySQL created and the new `storage` volume are empty:

   ```sh
   docker compose --profile ops run --rm restore --target-db erp_coaching --target-dir /var/lib/erp/storage latest
   ```

6. Requeue the stale jobs, as in step 6 of the in-place restore.
7. Restore `deploy/certs/` and `/etc/letsencrypt` from the offsite copy. Without a copy, set
   `TLS_SELF_SIGNED_FALLBACK=true` for now, so that nginx can start, and issue new certificates once DNS points at the
   new server ([TLS certificates](deployment.md#tls-certificates)).
8. Start the stack with `docker compose up -d --wait`.
9. Point DNS at the new server: the platform host and the wildcard record. Custom domains that are `CNAME`s of the
   platform host follow automatically. Those with `A` records must be changed by the institutes; a reserved IP address
   that you can move to the new server avoids this.
10. Check the deployment ([first deployment](deployment.md#first-deployment), step 7). Set
    `TLS_SELF_SIGNED_FALLBACK=false` again if you changed it, and schedule the backups again.

### After a restore

- **Lost changes:** data and files created after the backup are gone. Tell the users. Reconcile what happened outside
  the system during that time, such as payments received and messages sent.
- **Jobs:** the jobs that were queued when the backup was taken run again, so some notifications may be sent twice.
- **Sessions:** password changes, sign-ins, sign-outs and device revocations since the backup are undone. Users who
  signed in after the backup must sign in again, and sessions or devices that were revoked after the backup work again
  until they expire. After a security incident, revoke all sessions and rotate `JWT_ACCESS_SECRET`
  ([rotating secrets](deployment.md#rotating-secrets)):

  ```sql
  UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE revoked_at IS NULL;
  ```

## Restore test

`restore-test.sh` proves end to end that the backups can be restored:

1. It creates a scratch source database with the backend's database CLI (create, migrate, and seed with demo data). It
   adds a table of edge cases: 4-byte UTF-8, quotes, backslashes and control characters, binary data, JSON, decimals,
   fractional-second timestamps, NULLs and an AUTO_INCREMENT gap. It also generates sample media files: binary and
   empty files, names with spaces and non-ASCII characters, a dotfile and an empty directory.
2. It backs them up with `backup.sh`.
3. It damages a copy of the backup. `restore.sh --verify-only` must reject the copy with exit code 4.
4. It restores into a second scratch database and directory, and compares them with the source:
   - the tables (type, engine, collation, row format), columns, indexes and foreign keys;
   - the AUTO_INCREMENT counters, the exact row counts, and `CHECKSUM TABLE` of every table;
   - the migration and seeder history;
   - the SHA-256 of every media file, and the list of directories.
5. Restoring again without `--force` must be refused (exit code 3), for both the database and the directory.
6. A second backup with `BACKUP_KEEP_COUNT=1` must delete the first one. A `--force` restore of `latest` over the
   targets is then compared again.
7. It drops the scratch databases and deletes its files, also when it fails, and exits non-zero if any check failed.

### Running the test

It needs:

- bash, `diff`, `sha256sum` or `shasum`, and the MySQL 8 clients;
- Node.js 22, with `npm ci` run in the repository. The backend CLI runs from source with tsx. With
  `RESTORE_TEST_CLI=dist`, it uses `backend/dist` instead, after `npm run build -w backend`;
- a MySQL 8 server, and a user who may create and drop the scratch databases.

```sh
npm ci
DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD_FILE=~/.erp-test-db-password deploy/backup/restore-test.sh
```

It takes about a minute, most of it for seeding.

| Option or variable                | Meaning                                                                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--keep`                          | Keep the scratch databases and the work directory for inspection                                                                                                                                                                         |
| `--source-db NAME`                | Back up this existing database instead of seeding one. It is only read, but nothing else may write to it during the test, so never use it on the production database: use the [drill](#restore-drill)                                    |
| `--source-dir DIR`                | Back up this directory instead of sample files                                                                                                                                                                                           |
| `--from-backup <dir or latest>`   | The [restore drill](#restore-drill)                                                                                                                                                                                                      |
| `DB_HOST`, `DB_USER` and so on    | As for [`backup.sh`](#without-docker)                                                                                                                                                                                                    |
| `RESTORE_TEST_PREFIX`             | Prefix of the scratch database names (default `erp_restore_test`, giving `<prefix>_src_<time>_<pid>` and `<prefix>_dst_<time>_<pid>`, at most 64 characters). Set it when the MySQL user may only create databases with a certain prefix |
| `RESTORE_TEST_WORK_DIR`           | Scratch directory, which must not exist yet. By default, a new directory under `BACKUP_TMPDIR`, `TMPDIR` or `/tmp`                                                                                                                       |
| `BACKEND_DIR`, `RESTORE_TEST_CLI` | The backend to seed with (default `backend/`), and how to run its CLI: `tsx`, `dist` or `auto` (the default)                                                                                                                             |

If the `mysql` on the `PATH` is MariaDB's (`mysql --version` shows it), point `MYSQL_BIN_DIR` at the MySQL 8 clients,
for example `/usr/local/mysql/bin`.

### Restore drill

The drill runs the test on a real backup:

```sh
docker compose --profile ops run --rm --entrypoint restore-test.sh backup --from-backup latest
```

It restores the newest backup into a scratch database and directory, and logs how long that took: this is the restore
part of your [RTO](#rpo-and-rto). Then it runs the round trip (steps 2 to 7 above) on that copy. It only reads the
backup, and never touches the production database or the `storage` volume.

Before you run it, check the resources:

- **MySQL:** the drill holds two extra copies of the database while it runs, and loads the dump three times. MySQL 8.4
  keeps binary logs for 30 days by default (`binlog_expire_logs_seconds`), so each drill also adds roughly three times
  the database size to the binary logs. If nothing uses them (no replica, no point-in-time recovery), you can free the
  space after the drill with `PURGE BINARY LOGS BEFORE NOW();`.
- **Work directory:** it needs up to four times the size of the media, plus twice the compressed dump. By default it is
  in the container's `/tmp`, on Docker's disk. To use the backup disk instead, add
  `-e RESTORE_TEST_WORK_DIR=/backups/restore-test-work` before `--entrypoint`.
- **Load:** the drill competes with the application for MySQL and disk I/O, so run it off-peak. Alternatively, copy a
  backup to another server and run `deploy/backup/restore-test.sh --from-backup <dir>` there, against a scratch MySQL
  server. The drill doesn't need Node.js.

Run the drill monthly, after major upgrades and when the data has grown a lot, and record the results
([drill log](#drill-log)).

### In CI

- The `backup-restore` job runs `deploy/backup/restore-test.sh` against a `mysql:8.4` service with the runner's MySQL
  8.0 clients.
- The smoke test in the `deploy` job takes a backup in the compose stack, verifies it, and runs the restore drill in
  the `erp-backup` image ([CI and local checks](deployment.md#ci-and-local-checks)).

## RPO and RTO

- **RPO** (recovery point objective): how much data, measured in time, you can afford to lose.
- **RTO** (recovery time objective): how long the system may be down until it is restored.

Agree the targets with the business, then check them with drills. Until then, they are placeholders:

| Objective                    | Target | With the defaults                                                                  | How to measure                                                                                                                             |
| ---------------------------- | ------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| RPO, server still available  | TBD    | Up to 24 hours (daily backups), or 1 hour for the database with the hourly backups | The age of the newest local backup when an incident happens. [Monitor it](#schedule) continuously                                          |
| RPO, server lost             | TBD    | As above, plus the delay until the offsite copy is complete                        | The age of the newest offsite copy                                                                                                         |
| RTO, restore in place        | TBD    | Not measured yet                                                                   | A timed drill: from the decision to restore until `/api/ready` reports ready. The drill restore time is the largest part for big databases |
| RTO, new server              | TBD    | Not measured yet                                                                   | A timed rehearsal of [restoring onto a new server](#restoring-onto-a-new-server), including fetching the backup, DNS and certificates      |
| Backup frequency             | TBD    | Daily full, optionally hourly database-only                                        | The cron schedule                                                                                                                          |
| Retention, local and offsite | TBD    | 14 backups or 30 days locally; offsite as configured                               | `BACKUP_KEEP_COUNT`, `BACKUP_KEEP_DAYS` and the offsite policy                                                                             |

A restore returns the database to the moment the dump started, shortly after the manifest's `createdAt`. The media
return to a moment after the dump ended. In the worst case, you lose the interval between two backups plus the time a
backup takes.

The RTO adds up:

| Step                                                             | In place | New server |
| ---------------------------------------------------------------- | -------- | ---------- |
| Detect the problem and decide to restore                         | TBD      | TBD        |
| Provision the server, install Docker, check out, restore secrets | n/a      | TBD        |
| Fetch the backup from offsite (size divided by bandwidth)        | n/a      | TBD        |
| Verify and restore (the drill's `drill restore` time)            | TBD      | TBD        |
| Start the stack (`docker compose up -d --wait`)                  | TBD      | TBD        |
| DNS (record TTL) and certificates                                | n/a      | TBD        |
| **Total**                                                        | TBD      | TBD        |

The restore time grows with the size of the database and the media, because a single client replays the dump. The
seeded test database (about 150 tables) restores in a few seconds; only a drill on your own backups gives a real
number. If the measured RTO is too long, consider physical backups (Percona XtraBackup or MySQL Enterprise Backup), a
replica that you can promote, or a managed MySQL service.

### Drill log

Record every drill and real restore:

| Date | Backup (`createdAt`) | Sizes (`db.sql.gz`, `media.tar.gz`) | Drill restore | Total drill time | Result and issues | By  |
| ---- | -------------------- | ----------------------------------- | ------------- | ---------------- | ----------------- | --- |
| TBD  |                      |                                     |               |                  |                   |     |
