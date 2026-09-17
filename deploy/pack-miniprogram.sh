#!/usr/bin/env bash
# 打包微信小程序（kbone）分发包 → dist/AntiPrintMiniProgram-<版本>.zip
#
# 收包的人**不需要 Node / Python**，只要有「微信开发者工具」：
# 解压后直接导入（项目根就是解压出来的文件夹），或用它上传代码。
#
# 用法：bash deploy/pack-miniprogram.sh [--skip-build]
#   --skip-build  不重新构建，直接用现有的 miniprogram/dist
set -euo pipefail

# 用 Windows 形式路径（pwd -W）：Git Bash 的 /d/... 路径喂给 Windows 版 Python 会报「找不到文件」
ROOT="$(cd "$(dirname "$0")/.." && { pwd -W 2>/dev/null || pwd; })"
MP="$ROOT/miniprogram"
DIST="$ROOT/dist"
SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

# Windows 上 npm 脚本被 ExecutionPolicy 禁用 → 一律 npm.cmd
NPM="npm"
command -v npm.cmd >/dev/null 2>&1 && NPM="npm.cmd"
# 打包用 Python 的 zipfile（Git Bash 里的 zip 是 MiKTeX 的，对绝对路径处理不靠谱）
PY="$ROOT/backend/.venv/Scripts/python.exe"
[ -x "$PY" ] || PY="$(command -v python3 || command -v python)"

command -v "$NPM" >/dev/null 2>&1 || { echo "没有找到 npm（构建小程序需要 Node.js）" >&2; exit 1; }
command -v "$PY" >/dev/null 2>&1 || { echo "没有找到 python（打 zip 用）" >&2; exit 1; }

VERSION=$("$PY" -c "import json;print(json.load(open(r'$MP/package.json'))['version'])")
NAME="AntiPrintMiniProgram-$VERSION"
ZIP="$DIST/$NAME.zip"

# ── 1. 构建（webpack + 构建后处理：kbone 运行时 / logo / 样式内联）──
if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "==> 构建小程序（$NPM run build）"
  ( cd "$MP" && "$NPM" run build )
fi

MP_DIST="$MP/dist"
[ -f "$MP_DIST/project.config.json" ] || { echo "构建产物不完整：$MP_DIST/project.config.json 不存在" >&2; exit 1; }
[ -f "$MP_DIST/app.json" ] || { echo "构建产物不完整：$MP_DIST/app.json 不存在" >&2; exit 1; }

# ── 2. 组装（只动自己的产物目录，绝不删 dist 整个目录）──
STAGE="$DIST/.miniprogram-pack"
rm -rf "$STAGE"
mkdir -p "$STAGE/$NAME"
cp -r "$MP_DIST/." "$STAGE/$NAME/"
rm -rf "$STAGE/$NAME/node_modules"          # 构建后处理已清过，这里再兜一层
find "$STAGE/$NAME" -name "*.log" -delete
find "$STAGE/$NAME" -name "*.map" -delete          # 源码映射不进包（kbone 运行时会带 .map）

cat > "$STAGE/$NAME/导入说明.txt" <<'TXT'
AntiPrint 微信小程序 · 导入说明
================================

这个包里是**已经编译好的小程序代码**：只要一台装了「微信开发者工具」的电脑就能用，
不需要安装 Node.js，也不需要 Python。

一、本地运行（在开发者工具里看效果）
1. 解压这个压缩包（例如解压到 D:\AntiPrintMiniProgram）。
2. 打开微信开发者工具 → 导入项目 → 目录选**解压出来的那个文件夹**
   （判断有没有选对：这个文件夹里**直接就有 app.json**；如果还要再点进一层才有，就是选错了）。
3. AppID：先用「测试号」，或保持包里的 touristappid；要用真机预览、上传代码，
   必须换成自己的小程序 AppID。
4. 详情 → 本地设置 → 勾上「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」
   （不勾的话，小程序访问 https://print.anticraft.top 会被拦下来，控制台会报
     「https://print.anticraft.top 不在以下 request 合法域名列表中」）。
   包里的 project.private.config.json 已经默认关掉了校验；如果工具把它重置了，手动勾一次即可。
5. 点「编译」。首页是登录页：用本站账号登录即可（管理员/root/白名单账号免费）。

二、发布（给别人用）
1. 到「微信公众平台」注册小程序，拿到 AppID，填进 project.config.json（或导入项目时填）。
2. 公众平台（mp.weixin.qq.com）→ 开发管理 → 开发设置 → 服务器域名：
   把 https://print.anticraft.top 加进 **request 合法域名 / uploadFile 合法域名 / downloadFile 合法域名**
   （三项都要加：登录/查任务用 request，提交文件用 uploadFile，预览文件用 downloadFile）。
   注意：**真机上这个白名单是硬性的**，开发者工具里的「不校验合法域名」只对本地调试有效；
   而且只有「自己的 AppID」能配置自定义域名（touristappid 游客模式只能用官方那几条 tcB-api 域名）。
3. 开发者工具点「上传」→ 公众平台「版本管理」里提交审核 → 通过后发布。

三、能做什么
- 提交打印：从聊天记录选文件或从相册选图片（PDF / 图片 / Word / PPT，单个 ≤10MB），
  可选份数、页面范围（如 1-3,5），纸张固定 A4；配送方式支持「配送上门 / 到打印点自取」。
- 我的任务：看审核与出纸进度（四步进度条）、预览已提交的文件、出纸前可撤回。
- 我的余额：余额、单价、消费流水。我的配置：默认配送方式与地址。

四、说明
- 服务器地址固定指向 https://print.anticraft.top，包里没有开关，也不该改。
- 审核、出纸、任务队列仍是网站管理员在网页端操作；小程序只面向提交打印的用户。
- 任务信息页（每次出纸前打印的那张纸）由网站那台的打印代理负责，与小程序无关。
TXT

# 导入说明.txt 用 UTF-8 BOM + CRLF，Windows 记事本打开不乱码
"$PY" - "$STAGE/$NAME/导入说明.txt" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
text = p.read_text(encoding='utf-8').replace('\r\n', '\n').replace('\n', '\r\n')
p.write_bytes(b'\xef\xbb\xbf' + text.encode('utf-8'))
PYEOF

# ── 3. 打 zip（Python zipfile，固定时间戳好比对）──
rm -f "$ZIP"
"$PY" - "$STAGE" "$NAME" "$ZIP" <<'PYEOF'
import os, sys, zipfile, pathlib
stage, name, out = sys.argv[1], sys.argv[2], sys.argv[3]
base = pathlib.Path(stage)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for path in sorted(base.rglob('*')):
        if path.is_file():
            zf.write(path, path.relative_to(base).as_posix())
print(f'   写入 {out}')
PYEOF

# ── 4. 校验：不该出现的东西一个都不能有 ──
"$PY" - "$ZIP" "$NAME" <<'PYEOF'
import sys, zipfile
zip_path, name = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path) as zf:
    names = zf.namelist()
    bad = [n for n in names if 'node_modules/' in n or n.endswith(('.log', '.map'))]
    assert not bad, f'包里出现不该有的文件：{bad[:5]}'
    need = [f'{name}/project.config.json', f'{name}/app.json', f'{name}/app.wxss', f'{name}/pages/login/index.js',
            f'{name}/miniprogram_npm/miniprogram-render/index.js', f'{name}/miniprogram_npm/miniprogram-element/index.json',
            f'{name}/images/antiprint-logo.png', f'{name}/导入说明.txt']
    missing = [n for n in need if n not in names]
    assert not missing, f'包里缺少：{missing}'
    assert not [n for n in names if n.endswith('package.json') and '/miniprogram_npm/' not in n], '包里不该有 package.json'
    size = sum(info.file_size for info in zf.infolist()) / 1024 / 1024
    print(f'   校验通过：{len(names)} 个文件，解压后约 {size:.1f}MB')
PYEOF

rm -rf "$STAGE"
echo
echo "打包完成：$ZIP"
ls -lh "$ZIP" | awk '{print "   文件大小：" $5}'
