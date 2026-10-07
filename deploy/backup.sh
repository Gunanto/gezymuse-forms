#!/usr/bin/env bash
# Backup harian database GezyForm (VACUUM INTO = salinan konsisten,
# aman dijalankan saat aplikasi sedang berjalan). Retensi 14 hari.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/gezyform/data}"
BACKUP_DIR="${BACKUP_DIR:-/opt/gezyform/backup}"
RETENSI=14

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%F_%H%M)
sqlite3 "$DATA_DIR/gezyform.db" "VACUUM INTO '$BACKUP_DIR/gezyform-$STAMP.db'"
find "$BACKUP_DIR" -name 'gezyform-*.db' -mtime +$RETENSI -delete
echo "Backup OK: $BACKUP_DIR/gezyform-$STAMP.db"

# Contoh cron harian (jalankan sebagai user aplikasi):
# 0 2 * * * /opt/gezyform/gezymuse-forms/deploy/backup.sh >> /opt/gezyform/backup/backup.log 2>&1
