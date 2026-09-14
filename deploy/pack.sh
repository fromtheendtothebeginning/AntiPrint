#!/usr/bin/env bash
# AntiPrint 一键更新部署：正确打包（排除本机凭据/数据/依赖）→ 上传 → 解包 → 重启服务 → 自测
#
# 用法（在仓库根目录，Git Bash）：
#   bash deploy/pack.sh                # 打包 + 上传 + 重启 + 自测
#   bash deploy/pack.sh --dry-run      # 只打包并列出包内文件，不连接服务器
#
# 关键点：**必须排除 backend/data（上传文件）、backend/log、backend/db_config.json（库凭据）、
# .venv、__pycache__** —— 2026-09-14 实测踩过两次坑：
#   1) 漏排除 db_config.json → 线上库凭据被本机凭据覆盖，服务立刻 db:error；
#   2) 漏排除 backend/data → 本机 uploads 覆盖线上，残留目录与新任务号撞名，
#      提交时报「文件保存失败，请重试」（os.rename Errno 39 Directory not empty）。
set -euo pipefail

SERVER="${SERVER:-root@47.100.125.150}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/antiprint}"
SERVICE="${SERVICE:-antiprint-api}"
BASE_URL="${BASE_URL:-https://print.anticraft.top}"
PKG="${PKG:-/tmp/antiprint-deploy.tar.gz}"

cd "$(dirname "$0")/.."
echo "[1/5] 打包（含排除清单）"
tar czf "$PKG" \
  --exclude='__pycache__' \
  --exclude='.venv' \
  --exclude='backend/data' \
  --exclude='backend/log' \
  --exclude='backend/db_config.json' \
  --exclude='frontend/node_modules' \
  backend frontend/dist README.md AGENTS.md docs
tar tzf "$PKG" | grep -E 'db_config\.json|/data/|\.venv' && { echo "包内出现了不该有的文件，已中止"; exit 1; } || true
echo "      包内文件数：$(tar tzf "$PKG" | wc -l)"

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "[dry-run] 包已生成：$PKG（未上传）"
  exit 0
fi

echo "[2/5] 上传到 $SERVER"
scp -q "$PKG" "$SERVER:/tmp/"

echo "[3/5] 解包到 $REMOTE_DIR（保留线上 db_config.json 与 data）"
ssh "$SERVER" "tar xzf /tmp/antiprint-deploy.tar.gz -C $REMOTE_DIR && ls $REMOTE_DIR/frontend/dist/assets | head -3"

echo "[4/5] 重启 $SERVICE"
ssh "$SERVER" "systemctl restart $SERVICE && sleep 6 && systemctl is-active $SERVICE"

echo "[5/5] 自测"
ssh "$SERVER" "curl -s --max-time 8 http://127.0.0.1:8301/api/health; echo"
curl -s --max-time 15 -o /dev/null -w "      ${BASE_URL}/ → HTTP %{http_code}\n" "$BASE_URL/" || true
echo "完成。"
