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
ssh "$SERVER" "tar xzf /tmp/antiprint-deploy.tar.gz -C $REMOTE_DIR && ls $REMOTE_DIR/frontend/dist/assets | head -3
# 清理上次构建残留的资源（只保留 index.html 引用到的），避免 dist/assets 越积越多
cd $REMOTE_DIR/frontend/dist/assets
for f in \$(ls -1); do grep -q \"\$f\" ../index.html || { rm -f \"\$f\"; echo \"  已删未引用资源 \$f\"; }; done"

echo "[4/5] 重启 $SERVICE"
ssh "$SERVER" "systemctl restart $SERVICE && sleep 6 && systemctl is-active $SERVICE"

echo "[4b/5] 上传虚拟打印机安装包（「虚拟打印机」页的下载用它）"
# 安装包 23MB，不进上面那个 tar（backend/data 本来就是排除项），单独 scp 到线上 data/downloads/
# 本地没打过分发包就跳过 —— 页面上会诚实显示「服务器上还没放安装包」
VP_ZIP=$(ls -1t dist/AntiPrintVPrinter-*.zip 2>/dev/null | head -1 || true)
if [[ -n "$VP_ZIP" ]]; then
  REMOTE_DL="$REMOTE_DIR/backend/data/downloads"
  ssh "$SERVER" "mkdir -p $REMOTE_DL"
  scp -q "$VP_ZIP" "$SERVER:$REMOTE_DL/"
  # 只留最新一份：旧版本的包页面就不该再下到，免得用户装错版本
  ssh "$SERVER" "cd $REMOTE_DL && ls -1t AntiPrintVPrinter-*.zip 2>/dev/null | tail -n +2 | xargs -r rm -f; ls -lh $REMOTE_DL | tail -3"
  echo "      已上传 $(basename "$VP_ZIP")（$(du -h "$VP_ZIP" | cut -f1)）"
else
  echo "      本机 dist/ 里没有 AntiPrintVPrinter-*.zip，跳过（要先跑 bash deploy/pack-vprinter.sh）"
fi

echo "[5/5] 自测"
ssh "$SERVER" "curl -s --max-time 8 http://127.0.0.1:8301/api/health; echo"
curl -s --max-time 15 -o /dev/null -w "      ${BASE_URL}/ → HTTP %{http_code}\n" "$BASE_URL/" || true
echo "完成。"
