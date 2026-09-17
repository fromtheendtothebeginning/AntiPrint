#!/usr/bin/env bash
# AntiPrint 虚拟打印机 —— macOS / Linux 安装脚本（把 CUPS 后端 + ANTIPRINT 队列装好）。
#
# 用法：sudo bash setup-cups.sh
# 卸载：sudo bash uninstall-cups.sh
#
# 做完这两件事：
#   1) 把 cups-backend-antiprint 装进 CUPS 的 backend 目录，并建好收件目录（默认 /var/spool/antiprint）
#   2) 用 lpadmin 建一台名叫 ANTIPRINT 的队列，设备指向 antiprint:/
# 之后任何程序打印时都能在打印对话框里选到「ANTIPRINT」，数据会被投给桌面端的守护进程
# （virtual_printer.py），由它转成 PDF 提交到 AntiPrint 网站。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# 队列名从程序那边读出来（驼峰 + 版本号，如 AntiPrint-1.0.0），免得手抄一个和程序对不上的名字；
# 读不到就退回不带版本号的 AntiPrint。想自己定名：ANTIPRINT_QUEUE=xxx sudo -E bash setup-cups.sh
# 版本号：优先问源码（python3），没有 Python 就问同目录的可执行文件（免装 Python 的分发包）
VERSION="$(python3 -c "import sys;sys.path.insert(0,'$HERE/..');import vp_config;print(vp_config.VERSION)" 2>/dev/null || true)"
if [ -z "${VERSION:-}" ] && [ -x "$HERE/../AntiPrintVPrinter" ]; then
  VERSION="$("$HERE/../AntiPrintVPrinter" --status 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*//p' | head -1)"
fi
QUEUE="${ANTIPRINT_QUEUE:-AntiPrint${VERSION:+-$VERSION}}"
SPOOL="${ANTIPRINT_SPOOL:-/var/spool/antiprint}"
BACKEND_SCRIPT="$HERE/cups-backend-antiprint"
PPD_FILE="$HERE/antiprint.ppd"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

say() { printf '%s\n' "$*"; }
die() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

[ -f "$BACKEND_SCRIPT" ] || die "找不到 $BACKEND_SCRIPT（请在 vprinter/install 目录里运行本脚本）"
command -v lpadmin >/dev/null 2>&1 || die "没有 lpadmin：请先装 CUPS（Ubuntu/Debian: sudo apt install cups）"

# ---- 1. 后端目录 --------------------------------------------------------------------
BACKEND_DIR=""
for dir in /usr/local/libexec/cups/backend /usr/libexec/cups/backend /usr/lib/cups/backend \
           /opt/homebrew/libexec/cups/backend; do
  if [ -d "$dir" ]; then BACKEND_DIR="$dir"; break; fi
done
[ -n "$BACKEND_DIR" ] || die "找不到 CUPS backend 目录"
say "[INFO] CUPS backend 目录：$BACKEND_DIR"
$SUDO install -m 0755 "$BACKEND_SCRIPT" "$BACKEND_DIR/antiprint"

# ---- 2. 收件目录 --------------------------------------------------------------------
# 后端以 root/lp 身份写，桌面用户要把文件读走（移动），所以目录必须两方都能写。
$SUDO mkdir -p "$SPOOL"
$SUDO chmod 0777 "$SPOOL"
say "[INFO] 收件目录：$SPOOL（0777，见 cups-backend-antiprint 顶部说明）"

# ---- 3. 队列 ------------------------------------------------------------------------
if command -v lpinfo >/dev/null 2>&1; then
  if ! lpinfo -v 2>/dev/null | grep -qi 'antiprint'; then
    say "[WARN] CUPS 还没认到 antiprint 后端（lpinfo -v 里没有）。如果装完打印没反应，"
    say "       请确认 cupsd 的 ServerBin 包含 $BACKEND_DIR，或直接重启 CUPS：sudo systemctl restart cups"
  fi
fi

$SUDO lpadmin -x "$QUEUE" >/dev/null 2>&1 || true        # 已存在就先删掉重建（幂等）
created=""
if $SUDO lpadmin -p "$QUEUE" -E -v antiprint:/ -m raw -D "AntiPrint 虚拟打印机" \
     -o printer-is-shared=false 2>/dev/null; then
  created="raw"
elif [ -f "$PPD_FILE" ] && $SUDO lpadmin -p "$QUEUE" -E -v antiprint:/ -P "$PPD_FILE" \
     -D "AntiPrint 虚拟打印机" -o printer-is-shared=false 2>/dev/null; then
  created="ppd"
fi
[ -n "$created" ] || die "lpadmin 建队列失败，请手动执行：sudo lpadmin -p $QUEUE -E -v antiprint:/ -m raw"
$SUDO cupsenable "$QUEUE" 2>/dev/null || true
$SUDO cupsaccept "$QUEUE" 2>/dev/null || true
say "[INFO] 队列已建立：$QUEUE（$created）"

# ---- 4. PS → PDF 检查 ---------------------------------------------------------------
if command -v gs >/dev/null 2>&1; then
  say "[INFO] 找到 Ghostscript：$(command -v gs)"
elif command -v cupsfilter >/dev/null 2>&1; then
  say "[INFO] 没有 Ghostscript，但系统有 cupsfilter，转换仍然可用"
else
  say "[WARN] 没有 Ghostscript / cupsfilter：如果打印出来的不是 PDF，转换会失败。"
  say "       Ubuntu/Debian: sudo apt install ghostscript ；macOS: brew install ghostscript"
fi

cat <<EOF

下一步（在桌面用户的会话里，不要用 sudo）：
  1) 启动守护进程：python3 "$HERE/../virtual_printer.py"
     （在配置界面里填服务器地址与账号，并勾选「开机自动启动」）
  2) 自检：python3 "$HERE/../virtual_printer.py" --selftest
  3) 随便找个文档按 Cmd+P / Ctrl+P，选「$QUEUE」打印，几秒后网页上就会出现待审核任务。

手动测后端（不经过打印对话框）：
  ANTIPRINT_SPOOL=/tmp/antiprint-test sh "$BACKEND_SCRIPT" 1 "\$USER" "测试文档" 1 "" /path/to/test.pdf
EOF
