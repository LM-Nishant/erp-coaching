# syntax=docker/dockerfile:1
# Backup/restore tooling image used by the `backup` and `restore` services of deploy/docker-compose.yml.
# Based on the MySQL server image so mysqldump/mysql always match the server's major version.
# Build context: deploy/backup.
ARG MYSQL_IMAGE=mysql:8.4
FROM ${MYSQL_IMAGE}

# The Oracle Linux based image lacks tar and diff; gzip/findutils are listed to make the dependency explicit.
RUN microdnf install -y tar gzip findutils diffutils && microdnf clean all

COPY --chmod=0755 lib.sh backup.sh restore.sh restore-test.sh /opt/erp/backup/

ENV PATH=/opt/erp/backup:$PATH \
    BACKUP_DIR=/backups \
    STORAGE_DIR=/var/lib/erp/storage

WORKDIR /backups
# Replace the MySQL server entrypoint; CMD must be set after ENTRYPOINT (setting ENTRYPOINT resets it).
ENTRYPOINT []
CMD ["backup.sh"]
