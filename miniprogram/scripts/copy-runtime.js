// 构建后处理（npm run build 的第二步）：
//   1. 把 kbone 运行时（miniprogram-render / miniprogram-element）放进 dist/miniprogram_npm/
//      —— 等价于开发者工具的「构建 npm」，但用本工程已装好的版本、离线可重复
//   2. 把 dist/common/app.wxss 内联进 dist/app.wxss，并删掉那个被 @import 的文件
//      —— 不依赖 wxss 的 @import 解析（import 落在 400 行之后，且曾出现「找不到」的编译报错）
//   3. 清掉插件生成的 package.json / node_modules/.miniprogram 标记与历史遗留样式文件
//   4. 顺手删掉老构建留下的 dist/images/antiprint-logo.png（logo 现在内联在 src/asset.ts 里，
//      不能再走文件路径 —— kbone 会把 <img> 的绝对路径补成 origin 网络地址，见 asset.ts 注释）
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
// dist/ 本身就是小程序项目根（开发者工具导入 miniprogram/dist）
const mpRoot = path.join(root, 'dist')

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

function removeDir(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
}

if (!fs.existsSync(mpRoot)) {
  console.error(`没有找到构建产物：${mpRoot}（先跑 webpack）`)
  process.exit(1)
}

// ── 1. kbone 运行时 ──
const npmDir = path.join(mpRoot, 'miniprogram_npm')
removeDir(npmDir)
for (const name of ['miniprogram-render', 'miniprogram-element']) {
  const distDir = path.join(root, 'node_modules', name, 'dist')
  if (!fs.existsSync(distDir)) {
    console.error(`缺少运行时包：${distDir}（先跑 npm install）`)
    process.exit(1)
  }
  copyDir(distDir, path.join(npmDir, name))
}

// ── 2. 清理老构建留下的文件 logo（现在内联在 src/asset.ts，见该文件注释）──
fs.rmSync(path.join(mpRoot, 'images', 'antiprint-logo.png'), { force: true })

// ── 3. 内联 app.wxss（去掉 @import）──
const appWxssPath = path.join(mpRoot, 'app.wxss')
let appWxss = fs.readFileSync(appWxssPath, 'utf8')
appWxss = appWxss.replace(/@import\s+"([^"]+)"\s*;/g, (raw, target) => {
  const filePath = path.resolve(mpRoot, target)
  if (!fs.existsSync(filePath)) {
    console.warn(`app.wxss 里的 ${target} 不存在，跳过`)
    return raw
  }
  return `/* 内联自 ${target}（构建脚本处理，源文件在 miniprogram/src/app.css） */\n${fs.readFileSync(filePath, 'utf8')}`
})
fs.writeFileSync(appWxssPath, appWxss)

// ── 4. 本地设置：默认关掉域名校验（开发者工具用 project.private.config.json 存「本地设置」，
//      它优先于 project.config.json）—— 不关的话 http/https 域名不在白名单时请求会被拦，
//      真机/发布仍然必须在微信公众平台登记域名，见 README 与包里的「导入说明.txt」 ──
fs.writeFileSync(
  path.join(mpRoot, 'project.private.config.json'),
  JSON.stringify(
    {
      description: '本地设置（由构建脚本生成）：开发期关闭域名校验',
      projectname: 'AntiPrint',
      libVersion: '2.32.3',
      condition: {},
      setting: { urlCheck: false },
    },
    null,
    2,
  ) + "\n",
)

// ── 5. 清理 ──
// 插件会生成 package.json 与 node_modules/.miniprogram 标记，指向 npm install 流程；
// 这里已经有构建好的 miniprogram_npm，直接清掉以免开发者工具反复提示
fs.rmSync(path.join(mpRoot, 'package.json'), { force: true })
removeDir(path.join(mpRoot, 'node_modules'))
// 样式已内联进 app.wxss，common/ 下的样式文件是多余的（清掉免得占包体积、混淆排查）
const commonDir = path.join(mpRoot, 'common')
if (fs.existsSync(commonDir)) {
  for (const name of fs.readdirSync(commonDir)) {
    if (name.endsWith('.css') || name.endsWith('.wxss')) {
      fs.rmSync(path.join(commonDir, name), { force: true })
      console.log(`清掉多余样式文件：common/${name}（已内联进 app.wxss）`)
    }
  }
}

console.log('构建后处理完成：miniprogram_npm 运行时 + app.wxss 内联样式（logo 已内联在 src/asset.ts）')
