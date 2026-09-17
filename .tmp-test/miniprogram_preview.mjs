// 小程序「本地预览」：把 kbone 跑出来的 DOM 序列化成 HTML，套上真实编译产物里的 app.wxss，
// 再模拟出导航栏与 tabBar，用 chromium 截图 —— 在没有微信开发者工具的环境里看页面长什么样。
// 运行：node .tmp-test/miniprogram_preview.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const requireFromIndex = createRequire('file:///D:/anticraft/index/')
const requireHere = createRequire(import.meta.url)
const { chromium } = requireFromIndex('playwright-core')

const CHROME = 'C:/Users/86133/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const ROOT = 'D:/anticraft/AntiPrint'
const MP = path.join(ROOT, 'miniprogram/dist')
const SHOTS = path.join(ROOT, '.tmp-test/shots/miniprogram')
fs.mkdirSync(SHOTS, { recursive: true })

// ── wx 运行时桩 ──
const SCALE = process.env.MP_SCALE || ''   // 空 = 标准；lg / xl = 字号档位（验证缩放）
let storage = { antiprint_token: 'preview-token', antiprint_user: { id: 1, username: 'tester', role: 'user' } }
if (SCALE) storage.antiprint_scale = SCALE
const PROFILE = {
  id: 1, username: 'tester', role: 'user', source: 'local', anticraft_bound: false, anticraft_id: null,
  default_address: '24 号楼 1016', default_delivery: '配送', balance: '1.00', billable: true, free_reason: '', price: '0.1 元/张', avatar: '',
}
const JOBS = [
  {
    id: 12, user_id: 1, username: 'tester', status: '待审核', address: '24 号楼 1016', note: '单面打印', reject_reason: null,
    print_error: null, copies: 2, delivery_mode: '配送', created_at: '2026-09-16 10:00:00', updated_at: '2026-09-16 10:00:00',
    printed_at: null, finished_at: null, charge: '0.20',
    files: [{ id: 5, filename: '251184Y332-尤天浩-实验二.docx', size: 20480, sha256: 'a'.repeat(64), print_options: { copies: 2, paper: 'A3' } }],
  },
  {
    id: 11, user_id: 1, username: 'tester', status: '待取件', address: '', note: null, reject_reason: null, print_error: null,
    copies: 1, delivery_mode: '取件', created_at: '2026-09-15 09:00:00', updated_at: '2026-09-15 12:00:00',
    printed_at: '2026-09-15 11:00:00', finished_at: null, charge: '0.10',
    files: [{ id: 4, filename: '课件.pdf', size: 1024, sha256: 'b'.repeat(64) }],
  },
  {
    id: 10, user_id: 1, username: 'tester', status: '已驳回', address: '24 号楼 1016', note: null,
    reject_reason: '文件内容不清晰，请重新上传', print_error: null, copies: 1, delivery_mode: '配送',
    created_at: '2026-09-14 18:00:00', updated_at: '2026-09-15 09:00:00', printed_at: null, finished_at: null,
    files: [{ id: 3, filename: '报告.pdf', size: 3072, sha256: 'c'.repeat(64) }],
  },
  {
    id: 9, user_id: 1, username: 'tester', status: '已完成', address: '24 号楼 1016', note: null, reject_reason: null,
    print_error: null, copies: 1, delivery_mode: '配送', created_at: '2026-09-13 10:00:00', updated_at: '2026-09-13 16:00:00',
    printed_at: '2026-09-13 15:00:00', finished_at: '2026-09-13 16:20:00', charge: '0.10',
    files: [{ id: 2, filename: '实验报告.pdf', size: 5120, sha256: 'd'.repeat(64) }],
  },
]
const BALANCE = {
  balance: '1.00', billable: true, free_reason: '', price: '0.1 元/张', recharge_enabled: false,
  logs: [
    { id: 3, delta: '-0.20', balance_after: '1.00', reason: '驳回退费', job_id: 12, actor: null, created_at: '2026-09-16 12:00:00' },
    { id: 2, delta: '-0.20', balance_after: '1.20', reason: '提交任务扣费', job_id: 12, actor: null, created_at: '2026-09-16 10:00:00' },
    { id: 1, delta: '2.00', balance_after: '1.40', reason: '管理员调账', job_id: null, actor: 'end', created_at: '2026-09-15 08:00:00' },
  ],
}

global.wx = {
  env: { USER_DATA_PATH: '/tmp/x' },
  getStorageSync: (key) => (key in storage ? storage[key] : ''),
  setStorageSync: () => undefined,
  removeStorageSync: () => undefined,
  getSystemInfoSync: () => ({ screenWidth: 375, windowWidth: 375, windowHeight: 812, platform: 'devtools', SDKVersion: '2.32.3' }),
  createSelectorQuery: () => ({ in: () => ({ select: () => ({ boundingClientRect: () => ({ exec: () => undefined }) }), exec: () => undefined }) }),
  createIntersectionObserver: () => ({ relativeTo: () => ({ observe: () => undefined, disconnect: () => undefined }) }),
  setNavigationBarTitle: () => undefined,
  pageScrollTo: () => undefined,
  hideShareMenu: () => undefined,
  showToast: () => undefined,
  stopPullDownRefresh: () => undefined,
  switchTab: () => undefined,
  redirectTo: () => undefined,
  navigateTo: () => undefined,
  showModal: () => undefined,
  request: (options) => {
    const url = String(options.url).replace(/^https?:\/\/[^/]+/, '')
    const canned = { '/api/profile': { profile: PROFILE }, '/api/jobs/mine': { jobs: JOBS }, '/api/balance': BALANCE }
    setTimeout(() => options.success({ statusCode: canned[url] ? 200 : 404, data: canned[url] || { detail: 'no stub' } }), 0)
  },
}

let captured = null
global.Component = (options) => {
  captured = options
}
global.Page = global.Component
global.App = () => undefined
global.getCurrentPages = () => []
global.getApp = () => ({})

// ── kbone DOM → HTML ──
const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (text) => escapeHtml(text).replace(/"/g, '&quot;')
// 图片转 data URI：about:blank 文档里加载 file:// 子资源会被 Chromium 拦掉
const imageCache = new Map()
const imagePath = (src) => {
  const file = path.join(MP, String(src).replace(/^\//, ''))
  if (!imageCache.has(file)) {
    const data = fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : ''
    imageCache.set(file, data ? `data:image/png;base64,${data}` : '')
  }
  return imageCache.get(file)
}

function serialize(node) {
  if (!node) return ''
  if (node.nodeType === 3) return escapeHtml(node.textContent || '')
  const tag = String(node.tagName || 'div').toLowerCase()
  const cls = node.className ? ` class="${escapeAttr(node.className)}"` : ''
  if (tag === 'input') {
    const value = node.value ? ` value="${escapeAttr(node.value)}"` : ''
    const placeholder = node.placeholder ? ` placeholder="${escapeAttr(node.placeholder)}"` : ''
    const type = node.type === 'password' ? ' type="password"' : ''
    return `<input${cls}${type}${value}${placeholder} />`
  }
  if (tag === 'textarea') {
    return `<textarea${cls} placeholder="${escapeAttr(node.placeholder || '')}">${escapeHtml(node.value || '')}</textarea>`
  }
  if (tag === 'img') {
    return `<img${cls} src="${imagePath(node.src || '')}" />`
  }
  const children = (node.childNodes || []).map(serialize).join('')
  if (tag === 'body') return children
  return `<${tag}${cls}>${children}</${tag}>`
}

function mountPage(name) {
  captured = null
  const pageFile = path.join(MP, 'pages', name, 'index.js')
  delete requireHere.cache[requireHere.resolve(pageFile)]
  requireHere(pageFile)
  const instance = {
    route: `pages/${name}/index`,
    data: {},
    setData(data) {
      Object.assign(this.data, data)
    },
    selectOwnerComponent: () => null,
    getTabBar: () => null,
    getOpenerEventChannel: () => ({}),
  }
  const base = captured.base || captured
  base.lifetimes.attached.call(instance)
  captured.methods.onLoad.call(instance, {})
  return instance
}

// ── 真实 wxss（编译产物，样式已内联进 app.wxss）──
const appWxss = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8')
const htmlCss = appWxss.replace(/^page\s*\{/m, 'body {').replace(/\npage\s*\{/g, '\nbody {')

const NAV_TITLE = { login: '登录', submit: '提交打印', jobs: '我的任务', balance: '我的余额', profile: '我的配置' }
const TAB_PAGES = { submit: true, jobs: true, balance: true, profile: true }
// tabBar 图标路径从构建产物的 app.json 里读（插件会按文件 md5 重命名）
const appJson = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'))
const TABS = (appJson.tabBar.list || []).map((item) => ({
  key: item.pagePath.split('/')[1],
  text: item.text,
  icon: String(item.iconPath || '').replace(/^\.\//, ''),
  iconOn: String(item.selectedIconPath || '').replace(/^\.\//, ''),
}))

// 注意：这里**不要**写 * { box-sizing: border-box } —— wxss 不支持 * 选择器，
// 预览必须按真实规则来（样式里的 box-sizing 都写在各个类上），否则会掩盖「按钮右端顶出屏幕」这类问题
const SHELL_CSS = `
  html, body { margin: 0; padding: 0; }
  /* 用 body.h5-body 提高优先级：kbone 的 .h5-body{display:block} 会盖掉纯 body 选择器的 flex */
  body.h5-body { width: 375px; height: 812px; display: flex; flex-direction: column; overflow: hidden;
         font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .sim-nav { flex: none; height: 44px; background: #4a9d9a; color: #fff; display: flex; align-items: center;
             justify-content: center; font-size: 17px; font-weight: 500; }
  .sim-screen { flex: 1; min-height: 0; overflow-y: auto; position: relative; }   /* min-height:0 否则 flex 子项不会收缩，tabBar 被顶到屏幕外 */
  .sim-tabbar { flex: none; height: 50px; background: #fff; border-top: 1px solid #e6e2db; display: flex; }
  .sim-tab { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; }
  .sim-tab img { width: 22px; height: 22px; }
  .sim-tab span { font-size: 10px; color: #8a8a86; }
  .sim-tab.on span { color: #4a9d9a; }
  input, textarea { border: none; outline: none; font: inherit; color: inherit; background: transparent; resize: none; }
  .h5-body { display: block; }
  img.hero-logo { display: block; }
`

function buildHtml(pageName, inner) {
  const isTab = !!TAB_PAGES[pageName]
  const tabbar = isTab
    ? `<div class="sim-tabbar">${TABS.map(
        (tab) => `<div class="sim-tab${tab.key === pageName ? ' on' : ''}">
          <img src="${imagePath(tab.key === pageName ? tab.iconOn : tab.icon)}" />
          <span>${tab.text}</span>
        </div>`,
      ).join('')}</div>`
    : ''
  // 小程序里 position:fixed 的 bottom 是「页面视口底部」（tabBar 之上），预览里手动让出 tabBar 高度
  const fixedFix = isTab ? '.bottom-bar { bottom: 50px; }' : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>${SHELL_CSS}\n${htmlCss}\n${fixedFix}</style></head>
<body class="h5-body miniprogram-root">
  <div class="sim-nav">${NAV_TITLE[pageName] || ''}</div>
  <div class="sim-screen">${inner}</div>
  ${tabbar}
</body></html>`
}

const flush = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 })

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['login', 'submit', 'jobs', 'balance', 'profile']
for (const name of targets) {
  const instance = mountPage(name)
  await flush(140)
  const html = buildHtml(name, serialize(instance.document.body))
  const suffix = SCALE ? `-${SCALE}` : ''
  fs.writeFileSync(path.join(SHOTS, `${name}${suffix}.html`), html)
  const page = await ctx.newPage()
  await page.setContent(html, { waitUntil: 'load' })
  // 横向溢出检查：任何元素的右边缘超过 375 都算（按钮右端顶出屏幕就是这种）
  const overflow = await page.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('.sim-screen *')) {
      const right = el.getBoundingClientRect().right
      if (right > 375.5) bad.push(`${el.className || el.tagName}@${Math.round(right)}`)
    }
    return { badCount: bad.length, bad: bad.slice(0, 4) }
  })
  await page.screenshot({ path: path.join(SHOTS, `${name}${suffix}.png`) })
  await page.close()
  const detail = overflow.badCount ? `  ⚠ 溢出 ${overflow.badCount} 处：${overflow.bad.join('; ')}` : ''
  console.log(`  截图：${name}${suffix}.png${detail}`)
}

await browser.close()
console.log(`\n预览图在 ${SHOTS}`)
