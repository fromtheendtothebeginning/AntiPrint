#!/usr/bin/env bash
# AntiPrint 虚拟打印机分发包：把 vprinter/ 打成一个**单文件 exe** 的 zip（Windows 用户解压即用，不需要装 Python）。
#
# 用法（在仓库根目录，Git Bash）：
#   bash deploy/pack-vprinter.sh            # 打包（首次会 pip 装 PyInstaller，约 100MB）
#   bash deploy/pack-vprinter.sh --skip-build   # 跳过 PyInstaller，只用上次的 exe 重新组包（调 README/bat 时快）
# 产物：dist/AntiPrintVPrinter-<版本>.zip
#       解开后有：AntiPrintVPrinter.exe + install/（建队列脚本）+ README.txt + config.example.json
#                + start/check/stop-vprinter.bat（内部自动优先用 exe）
#
# 关键点：
#   1) 单文件 exe（PyInstaller --onefile --windowed）：双击不弹黑窗，托盘常驻；
#      从命令行跑 --selftest/--status 时会自己 AttachConsole 挂到调用方的控制台，输出照常看得到。
#   2) **绝不把 ~/.antiprint-vprinter/config.json（含账号密码/令牌）打进包里**：脚本会校验，发现即中止。
#      运行数据本来就在用户目录，不在程序目录，所以正常情况下包里不会有。
#   3) README/bat 统一 CRLF（+README 加 BOM），否则记事本打开会连成一行 / 中文乱码。
set -euo pipefail

cd "$(dirname "$0")/.."
VP_DIR="vprinter"
DIST="dist"
STAGE="$DIST/AntiPrintVPrinter"
BUILD="$DIST/.vprinter-build"
# ── 解释器与平台 ──
# 构建脚本要在三个平台上都能跑：Windows 用后端 venv，macOS/Linux 用 venv 的 bin/python 或系统 python3。
VENV_PY="backend/.venv/Scripts/python.exe"
[ -x "$VENV_PY" ] || VENV_PY="backend/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  VENV_PY="$(command -v python3 || command -v python || true)"
fi

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PLATFORM=windows ;;
  Darwin)               PLATFORM=macos ;;
  *)                    PLATFORM=linux ;;
esac
EXE_SUFFIX="";      [ "$PLATFORM" = windows ] && EXE_SUFFIX=".exe"
DATA_SEP=":";       [ "$PLATFORM" = windows ] && DATA_SEP=";"
NAME_SUFFIX="";     [ "$PLATFORM" = macos ] && NAME_SUFFIX="-macos"
[ "$PLATFORM" = linux ] && NAME_SUFFIX="-linux"

winpath() {                     # 只在 Git Bash 里需要转换；其它平台原样返回
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

ROOT="$(pwd)"      # PyInstaller 的 --icon/--version-file 会相对 spec 目录解析，所以一律传绝对路径
SKIP_BUILD="${1:-}"

if [ -z "${VENV_PY:-}" ] || ! "$VENV_PY" -c "import sys" >/dev/null 2>&1; then
  echo "找不到可用的 Python 解释器（Windows 用 backend/.venv/Scripts/python.exe；"
  echo "macOS/Linux 用 backend/.venv/bin/python 或系统 python3，并 pip install -r vprinter/requirements.txt）"
  exit 1
fi

VERSION="$("$VENV_PY" -c 'import sys;sys.path.insert(0,"vprinter");import vp_config;print(vp_config.VERSION)')"
[ -n "$VERSION" ] || { echo "读不到 vprinter/vp_config.py 里的 VERSION，已中止"; exit 1; }
ZIP_PATH="$DIST/AntiPrintVPrinter-$VERSION$NAME_SUFFIX.zip"

if [ "$SKIP_BUILD" != "--skip-build" ]; then
  echo "[1/5] 准备构建环境（版本 $VERSION）"
  if ! "$VENV_PY" -m PyInstaller --version >/dev/null 2>&1; then
    echo "      安装 PyInstaller（构建用，不进分发包）"
    "$VENV_PY" -m pip install -i https://mirrors.aliyun.com/pypi/simple/ pyinstaller
  fi
  echo "      PyInstaller $("$VENV_PY" -m PyInstaller --version)"
  mkdir -p "$BUILD"

  if [ "$PLATFORM" != windows ]; then
    echo "[2/5] 生成图标（非 Windows：不生成 .ico/版本信息，PyInstaller 用默认图标）"
    mkdir -p "$BUILD/assets"
    "$VENV_PY" - "$ROOT/$BUILD/assets" "$ROOT" <<'PY'
import pathlib
import shutil
import sys
assets = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
site_logo = root / "frontend" / "public" / "apple-touch-icon.png"
if site_logo.is_file():
    shutil.copy2(site_logo, assets / "antiprint-logo.png")
    print("      图标：网站 logo（供运行时托盘/界面使用）")
else:
    sys.path.insert(0, "vprinter")
    from vp_tray import BRAND, make_image
    make_image(BRAND, 180).save(assets / "antiprint-logo.png")
    print("      图标：程序画的兜底图标")
PY
  else
  echo "[2/5] 生成图标与版本信息"
  # 图标用网站那份 logo（frontend/public/apple-touch-icon.png，由 frontend/scripts/make_favicon.py 生成）：
  # exe 的图标 + 托盘/界面图标都跟网站一致；弄不到就退回程序画的兜底图标。
  "$VENV_PY" - "$(cygpath -w "$ROOT/$BUILD")" "$(cygpath -w "$ROOT")" <<'PY'
import shutil
import sys
from pathlib import Path

build = Path(sys.argv[1])
root = Path(sys.argv[2])
site_logo = root / "frontend" / "public" / "apple-touch-icon.png"

assets = build / "assets"
assets.mkdir(parents=True, exist_ok=True)
logo = assets / "antiprint-logo.png"

sys.path.insert(0, "vprinter")
from vp_tray import BRAND, load_logo, make_image      # noqa: E402

if site_logo.is_file():
    shutil.copy2(site_logo, logo)                     # 原样带上（exe 里也用它当运行时图标）
    print(f"      图标：网站 logo（{site_logo.relative_to(root)}）")
else:
    make_image(BRAND, 180).save(logo)
    print("      图标：没找到网站 logo，用程序画的兜底图标")

from PIL import Image                                 # noqa: E402
base = Image.open(logo).convert("RGBA").resize((256, 256), Image.LANCZOS)
base.save(build / "antiprint.ico",
          sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

import vp_config                                      # noqa: E402
v = tuple(int(x) for x in vp_config.VERSION.split(".")) + (0,)
ver = f"{v[0]}.{v[1]}.{v[2]}.0"
(build / "version-info.txt").write_text(f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers=({v[0]},{v[1]},{v[2]},0), prodvers=({v[0]},{v[1]},{v[2]},0),
                    mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0,0)),
  kids=[
    StringFileInfo([StringTable('080404B0', [
      StringStruct('CompanyName', 'AntiPrint'),
      StringStruct('FileDescription', 'AntiPrint 虚拟打印机'),
      StringStruct('FileVersion', '{ver}'),
      StringStruct('InternalName', 'AntiPrintVPrinter'),
      StringStruct('OriginalFilename', 'AntiPrintVPrinter.exe'),
      StringStruct('ProductName', 'AntiPrint 虚拟打印机'),
      StringStruct('ProductVersion', '{ver}'),
      StringStruct('Comments', '打印到 ANTIPRINT 队列 = 转成 PDF 并提交到 AntiPrint 网站'),
    ])]),
    VarFileInfo([VarStruct('Translation', [2052, 1200])]),
  ],
)
""", encoding="utf-8")
print("      图标与版本信息已生成")
PY
  fi

  WIN_BUILD="$(winpath "$ROOT/$BUILD")"   # Git Bash 会把 /d/... 与 ; 转换错，Windows 上给 PyInstaller 传 Windows 路径
  echo "[3/5] PyInstaller 打包（单文件、无控制台窗口；平台 $PLATFORM）"
  rm -rf "$BUILD/work" "$BUILD/out"
  EXTRA_ARGS=()
  if [ "$PLATFORM" = windows ]; then
    EXTRA_ARGS+=(--icon "$WIN_BUILD/antiprint.ico" --version-file "$WIN_BUILD/version-info.txt")
    EXTRA_ARGS+=(--hidden-import pystray._win32)
  fi
  [ "$PLATFORM" = macos ] && EXTRA_ARGS+=(--osx-bundle-identifier com.antiprint.vprinter)
  "$VENV_PY" -m PyInstaller \
    --noconfirm --clean --onefile --windowed \
    --name AntiPrintVPrinter \
    --add-data "$WIN_BUILD/assets/antiprint-logo.png${DATA_SEP}assets" \
    --collect-submodules pystray \
    "${EXTRA_ARGS[@]}" \
    --distpath "$WIN_BUILD/out" --workpath "$WIN_BUILD/work" --specpath "$WIN_BUILD" \
    "$VP_DIR/virtual_printer.py" > "$BUILD/pyinstaller.log" 2>&1 \
    || { echo "      PyInstaller 失败，日志末尾："; tail -25 "$BUILD/pyinstaller.log"; exit 1; }
  if [ -d "$BUILD/out/AntiPrintVPrinter.app" ]; then
    du -sh "$BUILD/out/AntiPrintVPrinter.app" | awk '{print "      生成 "$2"（"$1"）"}'
  else
    ls -lh "$BUILD/out/AntiPrintVPrinter$EXE_SUFFIX" | awk '{print "      生成 "$9"（"$5"）"}'
  fi
else
  echo "[1/5] --skip-build：复用 $BUILD/out 里已有的 exe"
fi

echo "[4/5] 组装分发包"
# 只清「我们自己的产物」，**不要 rm -rf 整个 $STAGE**：
# 绿色版用户很可能就在 dist/AntiPrintVPrinter/ 里双击 exe 用着，那目录下还有他的数据目录
# （AntiPrintVPrinter-data：账号配置/日志/提交记录）——整目录删掉会把人家的配置一起毁了（2026-09-16 踩过）。
mkdir -p "$STAGE"
rm -rf "$STAGE/install" "$STAGE/AntiPrintVPrinter.exe" "$STAGE/AntiPrintVPrinter-data.bak"
rm -f "$STAGE/README.txt" "$STAGE/config.example.json" "$STAGE/requirements.txt"
rm -f "$STAGE"/*.bat
if [ -d "$BUILD/out/AntiPrintVPrinter.app" ]; then
  # macOS 上 --windowed 产出的是 .app 目录（双击即用），整包拷进去
  cp -R "$BUILD/out/AntiPrintVPrinter.app" "$STAGE/"
else
  cp "$BUILD/out/AntiPrintVPrinter$EXE_SUFFIX" "$STAGE/"
fi
cp -r "$VP_DIR/install" "$STAGE/install"
# 分发包里的 Windows 安装脚本：默认队列名写成「驼峰+版本号」（exe 自己的默认名也是这个），
# 免得手跑脚本建出来的队列名和程序配置里的对不上（仓库里那份保持不带版本的 AntiPrint）
"$VENV_PY" - "$ROOT/$STAGE/install" "$VERSION" <<'PY'
import pathlib
import sys

install = pathlib.Path(sys.argv[1])
version = sys.argv[2]
old, new = "$Name = 'AntiPrint',", f"$Name = 'AntiPrint-{version}',"
changed = 0
for path in sorted(install.glob("*.ps1")):
    text = path.read_text(encoding="utf-8")
    if old in text:
        path.write_text(text.replace(old, new), encoding="utf-8")
        changed += 1
print(f"      安装脚本默认队列名 → AntiPrint-{version}（{changed} 个文件）")
assert changed == 2, "应该替换 install/uninstall 两个 ps1"
PY
for name in README.txt config.example.json requirements.txt; do
  cp "$VP_DIR/$name" "$STAGE/$name"
done
for name in start-vprinter.sh check-vprinter.sh 快速开始.txt; do
  cp "$VP_DIR/$name" "$STAGE/$name"
done
chmod +x "$STAGE"/*.sh 2>/dev/null || true
for name in start-vprinter.bat check-vprinter.bat stop-vprinter.bat; do
  cp "$VP_DIR/$name" "$STAGE/$name"
done
# 文本统一 CRLF；README 加 UTF-8 BOM（记事本识别中文）。
# 用 Python 转而不是 sed：Git Bash 的 sed 对「已带 BOM」的文件不做行尾转换（实测），
# 于是 README 会停在 LF —— 这里显式读写字节，结果可预期。
"$VENV_PY" - "$ROOT/$STAGE" <<'PY'
import pathlib
import sys

stage = pathlib.Path(sys.argv[1])
for path in sorted(stage.glob("*.bat")) + [stage / "README.txt"]:
    raw = path.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    path.write_bytes(raw.replace(b"\n", b"\r\n"))
readme = stage / "README.txt"
raw = readme.read_bytes()
if not raw.startswith(b"\xef\xbb\xbf"):
    readme.write_bytes(b"\xef\xbb\xbf" + raw)
print("      行尾已转 CRLF，README 已加 BOM")
PY

# 组包用的干净副本：**绝不能碰 $STAGE 里已有的数据目录** ——
# 绿色版用户很可能就在 dist/AntiPrintVPrinter/ 里双击 exe 用着，那里面是他的账号配置与提交记录。
# 所以不删原件，而是复制一份出来、在副本里丢掉数据目录再压缩。
PACK="$DIST/.vprinter-pack"
rm -rf "$PACK"
mkdir -p "$PACK/AntiPrintVPrinter"
# **白名单复制**（不是整目录复制）：① 绝不把用户的数据目录带进去；② 用户可能正在跑这份副本，
# 它的 vprinter.lock 被占用，整目录复制会直接报 "Device or resource busy" 把打包打断（2026-09-16 踩过）。
if [ -d "$STAGE/AntiPrintVPrinter.app" ]; then
  cp -R "$STAGE/AntiPrintVPrinter.app" "$PACK/AntiPrintVPrinter/"
else
  cp -R "$STAGE/AntiPrintVPrinter$EXE_SUFFIX" "$PACK/AntiPrintVPrinter/"
fi
cp -R "$STAGE/install" "$PACK/AntiPrintVPrinter/install"
for name in README.txt config.example.json requirements.txt 快速开始.txt; do
  cp "$STAGE/$name" "$PACK/AntiPrintVPrinter/$name"
done
for path in "$STAGE"/*.bat "$STAGE"/*.sh; do
  [ -e "$path" ] && cp "$path" "$PACK/AntiPrintVPrinter/"
done
if [ -d "$STAGE/AntiPrintVPrinter-data" ]; then
  echo "      注意到 $STAGE/AntiPrintVPrinter-data（你正在用的绿色数据），不入包、也不动它"
fi

echo "      校验：包内不得出现配置/令牌/日志"
for bad in config.json log inbox sent failed vprinter.lock .admin-token.json AntiPrintVPrinter-data; do
  if [ -e "$PACK/AntiPrintVPrinter/$bad" ]; then
    echo "      包内出现了 $bad（可能含账号密码或令牌），已中止"
    exit 1
  fi
done
if grep -rqE 'eyJ[A-Za-z0-9_-]{10,}\.' "$PACK" --include='*' 2>/dev/null; then
  echo "      包内出现了疑似 JWT 令牌，已中止"
  exit 1
fi

echo "[5/5] 压缩"
rm -f "$ZIP_PATH"
# 用 Python 的 zipfile 而不是外部 zip/Compress-Archive：路径与排除规则可预期，任何平台都一样
# （Git Bash 里的 zip 是 MiKTeX 带的，对 Windows 绝对路径 + 反斜杠的处理出过问题）
"$VENV_PY" - "$ROOT/$PACK" "$ROOT/$ZIP_PATH" <<'PY'
import pathlib
import sys
import zipfile

pack = pathlib.Path(sys.argv[1])
zip_path = pathlib.Path(sys.argv[2])
root = pack / "AntiPrintVPrinter"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            archive.write(path, pathlib.Path("AntiPrintVPrinter") / path.relative_to(root))
print(f"      已压缩 {sum(1 for _ in root.rglob('*') if _.is_file())} 个文件")
PY

# 自检用临时 HOME 跑：绿色模式的 exe 会在自己旁边建数据目录，别脏了分发包。
# 注意只删临时 HOME —— $STAGE 旁边那可能正是用户的绿色数据，绝对不能碰。
echo "      自检：跑一下包内的 exe（数据写在临时目录）"
ANTIPRINT_VPRINTER_HOME="$BUILD/selftest-home" "$STAGE/AntiPrintVPrinter$EXE_SUFFIX" --selftest | tail -12 || true
rm -rf "$BUILD/selftest-home"

echo
echo "完成：$ZIP_PATH（$(du -h "$ZIP_PATH" | cut -f1)）"
echo "发给对方后：解压 → 管理员 PowerShell 跑 install\\install-printer-windows.ps1 建队列 → 双击 start-vprinter.bat → 托盘里填账号。"
