#!/usr/bin/env bash
# AntiPrint 打印代理分发包：把 agent/ 打成一个「解压即用」的 zip（自带 Python 运行环境 + requests）。
#
# 用法（在仓库根目录，Git Bash）：
#   bash deploy/pack-agent.sh
# 产物：dist/AntiPrintAgent-<版本>.zip —— 直接发给「需要在接打印机的那台机器上装代理」的人，
#       对方解压 → 双击 install-agent.bat → 双击 check-agent.bat → 双击 start-agent.bat。
#
# 关键点：
#   1) 内置 runtime 用 python.org 的 embeddable 包（首次运行才下载，缓存在 dist/.cache）；
#      版本取后端 venv 的版本，保证与从 venv 复制的 requests 等纯 Python 依赖 ABI 一致。
#   2) **绝不把 agent/config.json（含真实代理令牌）打进包里**：脚本会校验，发现即中止。
#   3) .bat 与 README 统一转成 CRLF（+BOM），否则记事本打开可能连成一行 / 中文乱码。
set -euo pipefail

cd "$(dirname "$0")/.."
AGENT_DIR="agent"
DIST="dist"
STAGE="$DIST/AntiPrintAgent"
CACHE="$DIST/.cache"
DEP_PACKAGES=(requests urllib3 certifi charset_normalizer idna)

VERSION="$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$AGENT_DIR/print_agent.py" | head -1)"
if [ -z "$VERSION" ]; then
  echo "无法从 $AGENT_DIR/print_agent.py 读到 VERSION，已中止"
  exit 1
fi

VENV_PY="backend/.venv/Scripts/python.exe"
VENV_SITE="backend/.venv/Lib/site-packages"
if [ ! -x "$VENV_PY" ]; then
  echo "未找到后端 venv：$VENV_PY（先跑 setup.bat 建好 venv 再打包）"
  exit 1
fi
PY_VERSION="$("$VENV_PY" -c 'import sys;print("%d.%d.%d"%sys.version_info[:3])')"
EMBED_NAME="python-$PY_VERSION-embed-amd64.zip"
EMBED_ZIP="$CACHE/$EMBED_NAME"
# python.org 在国内实测只有几十 KB/s（会一直卡住），所以先试镜像，最后才回官方源
EMBED_URLS=(
  "https://registry.npmmirror.com/-/binary/python/$PY_VERSION/$EMBED_NAME"
  "https://mirrors.huaweicloud.com/python/$PY_VERSION/$EMBED_NAME"
  "https://www.python.org/ftp/python/$PY_VERSION/$EMBED_NAME"
)
ZIP_PATH="$DIST/AntiPrintAgent-$VERSION.zip"

echo "[1/6] 准备目录（代理版本 $VERSION，内置 Python $PY_VERSION）"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$CACHE"

echo "[2/6] 内置 Python 运行环境"
if [ ! -f "$EMBED_ZIP" ]; then
  DOWNLOADED=""
  for url in "${EMBED_URLS[@]}"; do
    echo "      下载 $url"
    if curl -fsSL --max-time 300 -o "$EMBED_ZIP" "$url"; then
      DOWNLOADED="1"
      break
    fi
    rm -f "$EMBED_ZIP"
  done
  if [ -z "$DOWNLOADED" ]; then
    echo "      下载失败：请手动下载 $EMBED_NAME 放到 $EMBED_ZIP 后重跑（离线环境同样处理）"
    exit 1
  fi
fi
unzip -q -o "$EMBED_ZIP" -d "$STAGE/runtime"

# 依赖装在 runtime/Lib/site-packages，必须写进 ._pth 才会被 import（embeddable 不读 site-packages）
PTH_FILE="$(ls "$STAGE/runtime"/python*._pth | head -1)"
STDLIB_ZIP="$(cd "$STAGE/runtime" && ls python*.zip | head -1)"
printf '%s\n.\nLib\\site-packages\n' "$STDLIB_ZIP" > "$PTH_FILE"
mkdir -p "$STAGE/runtime/Lib/site-packages"
for pkg in "${DEP_PACKAGES[@]}"; do
  cp -r "$VENV_SITE/$pkg" "$STAGE/runtime/Lib/site-packages/"
done
find "$STAGE/runtime/Lib" -type d -name __pycache__ -prune -exec rm -rf {} +
cat > "$STAGE/runtime/THIRD-PARTY.txt" <<'EOF'
runtime 目录内的第三方组件（随本分发包一起分发）：
  Python            PSF License      https://www.python.org/
  requests          Apache-2.0
  urllib3           MIT
  certifi           MPL-2.0
  charset_normalizer MIT
  idna              BSD-3-Clause
完整许可证文本见各项目官方仓库。
EOF

echo "[3/6] 复制代理程序与脚本"
for name in print_agent.py config.example.json requirements.txt README.txt apply-config.ps1; do
  cp "$AGENT_DIR/$name" "$STAGE/$name"
done
for name in "$AGENT_DIR"/*.bat; do
  cp "$name" "$STAGE/"
done

# 文本文件统一 CRLF；README 额外加 UTF-8 BOM（记事本识别中文）
for name in "$STAGE"/*.bat "$STAGE/README.txt"; do
  sed -i 's/\r*$/\r/' "$name"
done
sed -i '1s/^/\xef\xbb\xbf/' "$STAGE/README.txt"

echo "[4/6] 校验：包内不得出现本机配置或真实令牌"
if [ -e "$STAGE/config.json" ]; then
  echo "      包内出现了 config.json（含真实代理令牌），已中止"
  exit 1
fi
if [ -f "$AGENT_DIR/config.json" ]; then
  TOKEN="$("$VENV_PY" -c 'import json,sys;print(json.load(open(sys.argv[1],encoding="utf-8-sig")).get("agent_token",""))' "$AGENT_DIR/config.json" 2>/dev/null || true)"
  if [ -n "$TOKEN" ] && grep -rqF -- "$TOKEN" "$STAGE"; then
    echo "      包内出现了真实代理令牌，已中止"
    exit 1
  fi
fi

echo "[5/6] 打包"
rm -f "$ZIP_PATH"
if command -v zip >/dev/null 2>&1; then
  (cd "$DIST" && zip -qr "$(basename "$ZIP_PATH")" AntiPrintAgent)
else
  powershell -NoProfile -Command "Compress-Archive -Path '$(cygpath -w "$STAGE")' -DestinationPath '$(cygpath -w "$ZIP_PATH")' -Force"
fi

echo "[6/6] 自检（用包内 runtime 实跑）"
"$STAGE/runtime/python.exe" -c "import sys,requests;print('      runtime OK：Python %s，requests %s' % (sys.version.split()[0], requests.__version__))"
"$STAGE/runtime/python.exe" "$STAGE/print_agent.py" --version

echo
echo "完成：$ZIP_PATH（$(du -h "$ZIP_PATH" | cut -f1)）"
echo "发出去时把这个 zip 整个发给对方即可；对方解压后双击 install-agent.bat 按提示填服务器地址与代理令牌。"
