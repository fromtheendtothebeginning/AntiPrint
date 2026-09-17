#!/usr/bin/env bash
# AntiPrint 虚拟打印机 —— 启动（macOS / Linux）
#
# 优先用同目录的**可执行文件**（免装 Python 的分发包解压出来就有），
# 没有再退回用 python3 跑源码。Windows 上对应的是 start-vprinter.bat。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -x "$HERE/AntiPrintVPrinter" ]; then
  nohup "$HERE/AntiPrintVPrinter" >/dev/null 2>&1 &
  echo "[INFO] 已启动 AntiPrintVPrinter（托盘图标在菜单栏/状态栏里）"
  echo "[INFO] 打开配置界面：点托盘图标 →「打开配置界面」，或运行：\"$HERE/AntiPrintVPrinter\" --settings"
  exit 0
fi

if command -v python3 >/dev/null 2>&1; then
  nohup python3 "$HERE/virtual_printer.py" >/dev/null 2>&1 &
  echo "[INFO] 已用 python3 启动（日志：~/.antiprint-vprinter/log/vprinter.log）"
  exit 0
fi

echo "[ERROR] 既没有 AntiPrintVPrinter 可执行文件，也没有 python3。" >&2
echo "        免装 Python：用分发包（解压出来就带可执行文件）；" >&2
echo "        用源码：先装 Python 3.9+，再 pip install -r requirements.txt" >&2
exit 1
