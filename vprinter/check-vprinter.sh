#!/usr/bin/env bash
# AntiPrint 虚拟打印机 —— 自检（macOS / Linux）
# 打印「配置 / 服务器登录 / 收件目录 / 队列 / 托盘」逐项结论，再打一份状态 JSON。
# 出问题把这个窗口的输出发给运维。Windows 上对应的是 check-vprinter.bat。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -x "$HERE/AntiPrintVPrinter" ]; then
  RUN=("$HERE/AntiPrintVPrinter")
elif command -v python3 >/dev/null 2>&1; then
  RUN=(python3 "$HERE/virtual_printer.py")
else
  echo "[ERROR] 既没有 AntiPrintVPrinter 可执行文件，也没有 python3。" >&2
  exit 1
fi

echo "=== self test ==="
"${RUN[@]}" --selftest
echo
echo "=== status ==="
"${RUN[@]}" --status
