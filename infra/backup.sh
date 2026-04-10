#!/usr/bin/env bash
# infra/backup.sh — Automated PostgreSQL backup with optional S3 upload
# Usage: ./backup.sh                    (local only)
#        AWS_S3_BUCKET=my-bucket ./backup.sh  (local + S3)
#
# Cron example (daily at 2 AM):
#   0 2 * * * /opt/openclaw/infra/backup.sh >> /var/log/openclaw-backup.log 2>&1

set -euo pipefail

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${BACKUP_DIR:-/backups}"
FILENAME="openclaw_${TIMESTAMP}.sql.gz"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

# PostgreSQL connection (defaults match docker-compose.yml)
PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-nora}"
PGPASSWORD="${PGPASSWORD:-nora}"
PGDATABASE="${PGDATABASE:-nora}"

export PGPASSWORD

mkdir -p "$BACKUP_DIR"

echo "[$(date -Iseconds)] Starting backup → ${FILENAME}"

pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$PGDATABASE" \
  --no-owner --no-privileges --clean --if-exists \
  | gzip > "${BACKUP_DIR}/${FILENAME}"

SIZE=$(du -h "${BACKUP_DIR}/${FILENAME}" | cut -f1)
echo "[$(date -Iseconds)] Backup created: ${SIZE}"

# ── Optional S3 upload ────────────────────────────────────────────
if [[ -n "${AWS_S3_BUCKET:-}" ]]; then
  echo "[$(date -Iseconds)] Uploading to s3://${AWS_S3_BUCKET}/backups/${FILENAME}"
  aws s3 cp "${BACKUP_DIR}/${FILENAME}" "s3://${AWS_S3_BUCKET}/backups/${FILENAME}" --quiet
  echo "[$(date -Iseconds)] S3 upload complete"
fi

# ── Prune old local backups ───────────────────────────────────────
PRUNED=$(find "$BACKUP_DIR" -name "openclaw_*.sql.gz" -mtime +"$RETENTION_DAYS" -delete -print | wc -l)
if [[ "$PRUNED" -gt 0 ]]; then
  echo "[$(date -Iseconds)] Pruned ${PRUNED} backup(s) older than ${RETENTION_DAYS} days"
fi

echo "[$(date -Iseconds)] Backup complete ✓"
