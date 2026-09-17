#!/usr/bin/env bash
# AntiPrint 虚拟打印机 —— macOS / Linux 卸载脚本：删掉 ANTIPRINT 队列与 CUPS 后端。
#
# 用法：sudo bash uninstall-cups.sh          只删队列与后端
#       sudo bash uninstall-cups.sh --purge  连同收件目录里的待处理文件一起删掉
# 守护进程（托盘程序）不在这里处理：从托盘菜单退出，并取消「开机自动启动」勾选。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# 版本号：优先问源码（python3），没有 Python 就问同目录的可执行文件（免装 Python 的分发包）
VERSION="$(python3 -c "import sys;sys.path.insert(0,'$HERE/..');import vp_config;print(vp_config.VERSION)" 2>/dev/null || true)"
if [ -z "${VERSION:-}" ] && [ -x "$HERE/../AntiPrintVPrinter" ]; then
  VERSION="$("$HERE/../AntiPrintVPrinter" --status 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*//p' | head -1)"
fi
QUEUE="${ANTIPRINT_QUEUE:-AntiPrint${VERSION:+-$VERSION}}"
SPOOL="${ANTIPRINT_SPOOL:-/var/spool/antiprint}"
PURGE="${1:-}"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

if lpadmin -x "$QUEUE" 2>/dev/null || $SUDO lpadmin -x "$QUEUE" 2>/dev/null; then
  echo "[INFO] 已删除队列 $QUEUE"
else
  echo "[INFO] 队列 $QUEUE 不存在"
fi

for dir in /usr/local/libexec/cups/backend /usr/libexec/cups/backend /usr/lib/cups/backend \
           /opt/homebrew/libexec/cups/backend; do
  if [ -f "$dir/antiprint" ]; then
    $SUDO rm -f "$dir/antiprint"
    echo "[INFO] 已删除后端 $dir/antiprint"
  fi
done

if [ "$PURGE" = "--purge" ]; then
  $SUDO rm -rf "$SPOOL"
  echo "[INFO] 已删除收件目录 $SPOOL"
else
  echo "[INFO] 保留收件目录 $SPOOL（加 --purge 可删除）"
fi
