#!/usr/bin/env bash
# 每日数据库备份到 COS。放进 crontab：
#   10 3 * * * /opt/photo-spot-share/deploy/scripts/backup-db.sh >> /var/log/spot-backup.log 2>&1
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/photo-spot-share/deploy}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/spot}"
KEEP_DAYS="${KEEP_DAYS:-14}"
COS_BUCKET="${COS_BUCKET:-}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$BACKUP_DIR/spot-$STAMP.sql.gz"

docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-spot}" "${POSTGRES_DB:-spot}" | gzip > "$FILE"

echo "[backup] 已生成 $FILE"

if [[ -n "$COS_BUCKET" ]] && command -v coscmd >/dev/null 2>&1; then
  coscmd upload "$FILE" "/db-backups/" && echo "[backup] 已上传到 COS"
else
  echo "[backup] 未配置 COS（COS_BUCKET 为空或未安装 coscmd），仅保留本地副本"
fi

find "$BACKUP_DIR" -name 'spot-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
echo "[backup] 已清理 $KEEP_DAYS 天前的本地备份"

