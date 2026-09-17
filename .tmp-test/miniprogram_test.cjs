// 微信小程序（kbone）静态冒烟测试：用 Node 跑 kbone 的 miniprogram-render 运行时，
// 把 webpack 产物里的 5 个页面真的挂起来，断言 React 渲染出的文本与登录兜底行为。
// 说明：这里验的是「React + kbone DOM」这一层；真机/开发者工具的 wxss 与组件投影仍需人工跑一遍。
// 用法：node .tmp-test/miniprogram_test.cjs
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram', 'dist')   // dist/ 就是小程序项目根

let passed = 0
let failed = 0

function check(name, condition, extra) {
  if (condition) {
    passed++
    console.log(`  [OK] ${name}`)
  } else {
    failed++
    console.log(`  [FAIL] ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

// ── wx 运行时桩（只要能满足 kbone 与页面代码的调用即可） ──
let storage = {}
let redirects = []
let toasts = []
let apiCalls = []
let responses = {}
let requestDelay = 0
let uploads = []
let downloads = []
let modals = []
let toasts2 = []
let uploadStatus = 200
let requestStatus = 200
let uploadBody = { job: { id: 33, status: '待审核', address: '24 号楼 1016', delivery_mode: '配送', copies: 1, charge: '0.10', files: [{ id: 7, filename: '报告.docx', size: 2048, sha256: 'c' }] } }
let modalConfirm = false
let chosenFiles = [{ path: '/tmp/report.docx', name: '报告.docx', size: 2048 }]

const PROFILE = {
  id: 1,
  username: 'tester',
  role: 'user',
  source: 'local',
  anticraft_bound: false,
  anticraft_id: null,
  default_address: '24 号楼 1016',
  default_delivery: '配送',
  balance: '1.00',
  billable: true,
  free_reason: '',
  price: '0.1 元/张',
  avatar: '',
}

const JOBS = [
  {
    id: 12,
    user_id: 1,
    username: 'tester',
    status: '待审核',
    address: '24 号楼 1016',
    note: '单面打印',
    reject_reason: null,
    print_error: null,
    copies: 2,
    delivery_mode: '配送',
    created_at: '2026-09-16 10:00:00',
    updated_at: '2026-09-16 10:00:00',
    printed_at: null,
    finished_at: null,
    charge: '0.20',
    files: [{ id: 5, filename: '实验报告.docx', size: 20480, sha256: 'a'.repeat(64), print_options: { copies: 2, paper: 'A3' } }],
  },
  {
    id: 11,
    user_id: 1,
    username: 'tester',
    status: '待取件',
    address: '',
    note: null,
    reject_reason: null,
    print_error: null,
    copies: 1,
    delivery_mode: '取件',
    created_at: '2026-09-15 09:00:00',
    updated_at: '2026-09-15 12:00:00',
    printed_at: '2026-09-15 11:00:00',
    finished_at: null,
    files: [{ id: 4, filename: '课件.pdf', size: 1024, sha256: 'b'.repeat(64) }],
  },
]

const BALANCE = {
  balance: '1.00',
  billable: true,
  free_reason: '',
  price: '0.1 元/张',
  recharge_enabled: false,
  logs: [
    { id: 2, delta: '-0.20', balance_after: '1.00', reason: '提交任务扣费', job_id: 12, actor: null, created_at: '2026-09-16 10:00:00' },
    { id: 1, delta: '2.00', balance_after: '1.20', reason: '管理员调账', job_id: null, actor: 'end', created_at: '2026-09-15 08:00:00' },
  ],
}

global.wx = {
  env: { USER_DATA_PATH: '/tmp/miniprogram-user-data' },
  getStorageSync: (key) => (key in storage ? storage[key] : ''),
  setStorageSync: (key, value) => {
    storage[key] = value
  },
  removeStorageSync: (key) => {
    delete storage[key]
  },
  clearStorageSync: () => {
    storage = {}
  },
  getStorageInfoSync: () => ({ keys: Object.keys(storage), currentSize: 0, limitSize: 10240 }),
  getSystemInfoSync: () => ({
    screenWidth: 375,
    screenHeight: 667,
    windowWidth: 375,
    windowHeight: 667,
    pixelRatio: 2,
    platform: 'devtools',
    SDKVersion: '2.32.3',
  }),
  createSelectorQuery: () => ({ in: () => ({ select: () => ({ boundingClientRect: () => ({ exec: () => undefined }) }), exec: () => undefined }) }),
  createIntersectionObserver: () => ({ relativeTo: () => ({ observe: () => undefined, disconnect: () => undefined }) }),
  setNavigationBarTitle: () => undefined,
  pageScrollTo: () => undefined,
  stopPullDownRefresh: () => undefined,
  showToast: (options) => toasts.push(options && options.title),
  hideToast: () => undefined,
  showLoading: () => undefined,
  hideLoading: () => undefined,
  hideShareMenu: () => undefined,
  reLaunch: (options) => redirects.push(options && options.url),
  switchTab: (options) => redirects.push(options && options.url),
  navigateTo: (options) => redirects.push(options && options.url),
  redirectTo: (options) => redirects.push(options && options.url),
  request: (options) => {
    apiCalls.push(options.url)
    const url = options.url.replace(/^https?:\/\/[^/]+/, '')
    const payload = responses[url]
    setTimeout(() => {
      if (requestStatus === 401) {
        options.success({ statusCode: 401, data: { detail: '登录已过期' } })
      } else if (payload === undefined) {
        options.success({ statusCode: 404, data: { detail: `没有桩数据：${url}` } })
      } else {
        options.success({ statusCode: 200, data: payload })
      }
    }, requestDelay)
    return { abort: () => undefined }
  },
  showModal: (options) => {
    modals.push(options && options.title)
    options.success && options.success({ confirm: modalConfirm, cancel: !modalConfirm })
  },
  chooseMessageFile: (options) => options.success && options.success({ tempFiles: chosenFiles }),
  chooseMedia: (options) => options.success && options.success({ tempFiles: chosenFiles }),
  uploadFile: (options) => {
    uploads.push(options)
    setTimeout(() => options.success({ statusCode: uploadStatus, data: JSON.stringify(uploadBody) }), 0)
    return { abort: () => undefined }
  },
  downloadFile: (options) => {
    downloads.push(options)
    setTimeout(() => options.success({ statusCode: 200, tempFilePath: '/tmp/miniprogram-user-data/报告.docx' }), 0)
    return { abort: () => undefined }
  },
  openDocument: (options) => options.success && options.success({}),
  previewImage: (options) => options.success && options.success({}),
}

// ── 小程序全局 ──
let capturedComponent = null
global.Component = (options) => {
  capturedComponent = options
}
global.Page = global.Component
global.App = () => undefined
global.getCurrentPages = () => []
global.getApp = () => ({})

// ── kbone DOM 文本抽取 ──
function textOf(node) {
  if (!node) return ''
  if (node.nodeType === 3) return node.textContent || ''
  let out = ''
  const children = node.childNodes || []
  for (const child of children) out += textOf(child)
  return out
}

/** 收集所有 input/textarea 的 value（kbone 的 value 是属性，不在文本里） */
function inputValues(node, out) {
  const values = out || []
  if (!node || node.nodeType === 3) return values
  const tag = (node.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea') values.push(node.value || '')
  for (const child of node.childNodes || []) inputValues(child, values)
  return values
}

function elementCount(node, className) {
  if (!node || node.nodeType === 3) return 0
  let count = (node.className || '').split(/\s+/).includes(className) ? 1 : 0
  for (const child of node.childNodes || []) count += elementCount(child, className)
  return count
}

function hasInput(node) {
  if (!node || node.nodeType === 3) return false
  const tag = (node.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea') return true
  return (node.childNodes || []).some((child) => hasInput(child))
}

// ── 交互助手：kbone 的 CustomEvent 是冒泡事件，dispatchEvent 后会走到 React 的容器监听 ──
// 后序遍历：返回「最内层」匹配的节点（外层容器文本里也含同样文字，不能提前命中）
function findNode(node, predicate) {
  if (!node || node.nodeType === 3) return null
  for (const child of node.childNodes || []) {
    const hit = findNode(child, predicate)
    if (hit) return hit
  }
  return predicate(node) ? node : null
}

const byText = (text) => (node) => textOf(node).includes(text)
const byClass = (cls) => (node) => String(node.className || '').split(/\s+/).includes(cls)

function click(window, node) {
  if (!node) throw new Error('要点击的节点不存在')
  node.dispatchEvent(new window.CustomEvent('click', { bubbles: true, cancelable: true }))
}

// ── 页面挂载：模拟小程序把 Component 生命周期跑一遍 ──
function loadPage(name) {
  capturedComponent = null
  const pageFile = path.join(MP, 'pages', name, 'index.js')
  delete require.cache[require.resolve(pageFile)]
  require(pageFile)
  if (!capturedComponent) throw new Error(`${name} 页面没有注册 Component`)

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
  // kbone 的页面模板把 base 展开在顶层：{...baseConfig.base, methods: {...}} —— 没有 .base 字段
  const base = capturedComponent.base || capturedComponent
  const methods = capturedComponent.methods
  base.lifetimes.attached.call(instance)
  methods.onLoad.call(instance, {})
  return instance
}

const flush = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function run() {
  // ── 登录页：未登录状态（app 启动时的真实场景） ──
  storage = {}
  redirects = []
  responses = {}

  console.log('\n[1] 登录页（未登录）')
  const login = loadPage('login')
  await flush(50)
  let text = textOf(login.document.body)
  check('渲染出品牌标题', text.includes('AntiPrint 远程打印'), text.slice(0, 80))
  check('有登录 / 注册两个入口', text.includes('登录') && text.includes('注册'))
  check('渲染出用户名与密码输入框', hasInput(login.document.body))
  check('没有令牌时不跳转', redirects.length === 0, redirects.join(','))
  check('未登录时不发请求（登录页免鉴权）', apiCalls.length === 0, apiCalls.join(','))
  check('根节点带 page-root 样式类', elementCount(login.document.body, 'page-root') === 1)

  // 已登录再进登录页 → 自动回提交页（走 kbone 的 location，内部用 wx.switchTab）
  storage = { antiprint_token: 'fake-token', antiprint_user: { id: 1, username: 'tester', role: 'user' } }
  redirects = []
  console.log('\n[1b] 登录页（已登录时自动跳提交页）')
  const login2 = loadPage('login')
  await flush(50)
  check(
    '已登录时跳提交页（switchTab，且 URL 不带 query —— 带 query 微信会报「url 不支持 queryString」）',
    redirects.includes('/pages/submit/index'),
    redirects.join(','),
  )

  // 后续页面都在「已登录」状态下跑
  apiCalls = []
  responses = {
    '/api/profile': { profile: PROFILE },
    '/api/jobs/mine': { jobs: JOBS },
    '/api/balance': BALANCE,
  }

  console.log('\n[2] 提交页')
  apiCalls = []
  const submit = loadPage('submit')
  await flush(60)
  text = textOf(submit.document.body)
  check('渲染出「提交打印」标题', text.includes('提交打印'))
  check('读取了我的配置（默认地址回填）', apiCalls.includes('https://print.anticraft.top/api/profile'), apiCalls.join(','))
  check('显示计费提示（单价 + 余额）', text.includes('0.1 元/张') && text.includes('1.00'), text.slice(0, 120))
  const submitInputs = inputValues(submit.document.body)
  check('默认从配置带出配送方式与地址', text.includes('配送上门') && submitInputs.includes('24 号楼 1016'), submitInputs.join('|'))
  check('有选文件入口（聊天记录 + 拍照/相册）', text.includes('选择文件（聊天记录里选）') && text.includes('拍照或从相册选图片'))
  check('提示了「手机里的文件」怎么选', text.includes('文件传输助手'))
  check('有份数设置', text.includes('份数'))
  check('纸张固定 A4（不再让用户选）', text.includes('纸张固定 A4') && !text.includes('A5') && !text.includes('Letter'))
  check(
    '有页面范围输入',
    text.includes('页面范围') &&
      !!findNode(submit.document.body, (node) => (node.tagName || '').toLowerCase() === 'input' && String(node.placeholder || '').includes('1-3,5')),
  )

  console.log('\n[3] 我的任务')
  apiCalls = []
  const jobs = loadPage('jobs')
  await flush(60)
  text = textOf(jobs.document.body)
  check('拉取了我的任务', apiCalls.includes('https://print.anticraft.top/api/jobs/mine'), apiCalls.join(','))
  check('渲染任务号与状态徽章', text.includes('任务 #12') && text.includes('待审核'))
  check('渲染文件名与逐文件设置（2 份 · A3）', text.includes('实验报告.docx') && text.includes('2 份') && text.includes('A3'))
  check('渲染配送地址与备注', text.includes('24 号楼 1016') && text.includes('单面打印'))
  check('待取件任务显示取件提示', text.includes('到打印点自取'))
  check(
    '状态徽章配色生效（待审核=amber、待取件=violet）',
    elementCount(jobs.document.body, 'badge-amber') >= 1 && elementCount(jobs.document.body, 'badge-violet') >= 1,
  )
  check('可撤回任务有撤回按钮（并带上任务详情）', text.includes('撤回'))
  check('任务文件有「预览文件」按钮', text.includes('预览文件'))

  console.log('\n[4] 我的余额')
  apiCalls = []
  const balance = loadPage('balance')
  await flush(60)
  text = textOf(balance.document.body)
  check('拉取了余额', apiCalls.includes('https://print.anticraft.top/api/balance'), apiCalls.join(','))
  check('渲染余额金额', text.includes('1.00'))
  check('渲染流水（扣费 + 调账）', text.includes('提交任务扣费') && text.includes('-0.20') && text.includes('管理员调账') && text.includes('+2.00'))
  check('提示充值暂未开放', text.includes('充值暂未开放'))

  console.log('\n[5] 我的配置')
  apiCalls = []
  const profile = loadPage('profile')
  await flush(60)
  text = textOf(profile.document.body)
  check('拉取了我的配置', apiCalls.includes('https://print.anticraft.top/api/profile'), apiCalls.join(','))
  check('显示账号信息与角色', text.includes('tester') && text.includes('普通用户'))
  check('默认地址已载入表单', inputValues(profile.document.body).includes('24 号楼 1016'), inputValues(profile.document.body).join('|'))
  check('有退出登录按钮', text.includes('退出登录'))
  check('有界面字号档位（标准/大/特大）', text.includes('界面字号') && text.includes('特大'))

  // 选「大」→ 存进本地 + 页面根元素的 class 立刻变成 scale-lg（wxss 靠它覆盖字号变量）
  click(profile.window, findNode(profile.document.body, byText('特大')))
  await flush(30)
  check('选特大后写入本地', wx.getStorageSync('antiprint_scale') === 'xl', String(wx.getStorageSync('antiprint_scale')))
  check('选特大后页面根元素带上 scale-xl', String(profile.document.body.className).includes('scale-xl'), String(profile.document.body.className))

  console.log('\n[5b] 提交任务（点选文件 → 提交 → 成功卡片）')
  uploads = []
  toasts = []
  uploadStatus = 200
  const submit2 = loadPage('submit')
  await flush(60)
  click(submit2.window, findNode(submit2.document.body, byText('选择文件（聊天记录里选）')))
  await flush(30)
  text = textOf(submit2.document.body)
  check('选中文件后显示文件名与大小', text.includes('报告.docx') && text.includes('2 KB'), text.slice(0, 120))

  // 预览自己选的文件（图片走 previewImage、其余走 openDocument）
  opened = []
  global.wx.openDocument = (options) => {
    opened.push('openDocument')
    options.success && options.success({})
  }
  click(submit2.window, findNode(submit2.document.body, byText('预览文件')))
  await flush(30)
  check('可以预览已选文件（明显的「预览文件」按钮）', opened.includes('openDocument'), opened.join(','))

  // 页面范围：设置 input.value + 触发 input 事件（React 从 event.target.value 读值）
  const rangeInput = findNode(
    submit2.document.body,
    (node) => (node.tagName || '').toLowerCase() === 'input' && String(node.placeholder || '').includes('1-3,5'),
  )
  // 用 setAttribute 改值（走属性、不经过 React 的 value 追踪器）——React 的 onChange 只在「追踪值与当前值不一致」时触发，
  // 直接赋 node.value 会被追踪器当成「React 自己设的」而不触发（真实输入由浏览器内核改值，等价于走属性这条路）
  rangeInput.setAttribute('value', '1-2')
  rangeInput.dispatchEvent(new submit2.window.CustomEvent('input', { bubbles: true }))
  await flush(30)
  check('页面范围输入生效（按钮文案跟随）', textOf(submit2.document.body).includes('第 1-2 页'), textOf(submit2.document.body).slice(0, 200))

  click(submit2.window, findNode(submit2.document.body, byText('提交打印任务')))
  await flush(60)
  check('提交走 multipart 上传（字段名 files）', uploads.length === 1 && uploads[0].name === 'files', JSON.stringify(uploads.map((item) => item.name)))
  const form = (uploads[0] || {}).formData || {}
  check(
    '带上配送方式 / 地址 / 份数 / 纸张 / 页面范围',
    form.delivery_mode === '配送' && form.address === '24 号楼 1016' && form.copies === '1' && form.paper === 'A4' && form.pages === '1-2',
    JSON.stringify(form),
  )
  check('上传地址指向 /api/jobs', String((uploads[0] || {}).url || '').endsWith('/api/jobs'), String((uploads[0] || {}).url))
  text = textOf(submit2.document.body)
  check('显示成功卡片（任务号 / 状态 / 扣费）', text.includes('提交成功') && text.includes('任务 #33') && text.includes('0.10'), text.slice(0, 160))
  check('提交成功有提示', toasts.includes('提交成功，等待管理员审核'), toasts.join(','))

  // tabBar 页用 switchTab 切换不会重建页面：切回来（wxshow）应回到表单首页，而不是停在成功卡片
  submit2.window.$$trigger('wxshow')
  await flush(30)
  text = textOf(submit2.document.body)
  check(
    '切回提交页回到表单首页（不再停在提交成功）',
    !text.includes('提交成功') && text.includes('选择文件（聊天记录里选）') && text.includes('提交打印任务'),
    text.slice(0, 120),
  )

  console.log('\n[5c] 余额不足（402）→ 付款码占位提示')
  uploadStatus = 402
  uploadBody = { detail: { code: 'insufficient_balance', message: '余额不足', cost: '0.10', balance: '0.00', sheets: 1 } }
  const submit3 = loadPage('submit')
  await flush(60)
  click(submit3.window, findNode(submit3.document.body, byText('选择文件（聊天记录里选）')))
  await flush(30)
  click(submit3.window, findNode(submit3.document.body, byText('提交打印任务')))
  await flush(60)
  text = textOf(submit3.document.body)
  check('提示余额不足与应付金额', text.includes('余额不足') && text.includes('应付 0.10 元') && text.includes('当前余额 0.00 元'), text.slice(0, 200))
  check('提示付款码暂未开放', text.includes('付款码暂未开放'))

  console.log('\n[5d] 撤回任务（二次确认 → 调接口 → 提示）')
  modalConfirm = true
  apiCalls = []
  responses['/api/jobs/12/withdraw'] = { job: Object.assign({}, JOBS[0], { status: '已撤回' }) }
  toasts = []
  const jobs2 = loadPage('jobs')
  await flush(60)
  click(jobs2.window, findNode(jobs2.document.body, byText('撤回')))
  await flush(60)
  check('弹出二次确认', modals.includes('撤回任务 #12'), modals.join(','))
  check('调用了撤回接口', apiCalls.includes('https://print.anticraft.top/api/jobs/12/withdraw'), apiCalls.join(','))
  check('撤回后给出提示', toasts.includes('任务 #12 已撤回'), toasts.join(','))

  console.log('\n[5e] 预览任务文件（点文件名 → 下载 → 打开）')
  downloads = []
  const jobs3 = loadPage('jobs')
  await flush(60)
  click(jobs3.window, findNode(jobs3.document.body, byText('实验报告.docx')))
  await flush(60)
  check(
    '下载任务文件（带令牌）',
    downloads.length === 1 && String(downloads[0].url).endsWith('/api/jobs/12/files/5'),
    JSON.stringify(downloads.map((item) => item.url)),
  )
  check('下载请求带 Authorization 头', !!(downloads[0] && downloads[0].header && downloads[0].header.Authorization))

  console.log('\n[5f] 登录态过期（401）→ 自动回登录页')
  storage = { antiprint_token: 'expired-token', antiprint_user: { id: 1, username: 'tester', role: 'user' } }
  requestStatus = 401
  redirects = []
  loadPage('jobs')
  await flush(60)
  check('401 时调用 reLaunch 回登录页', redirects.includes('/pages/login/index'), redirects.join(','))
  check('401 后本地令牌被清掉', wx.getStorageSync('antiprint_token') === '', String(wx.getStorageSync('antiprint_token')))
  requestStatus = 200

  console.log('\n[5g] 字号档位在新页面里继续生效')
  // 模拟「上次已经存过档位」：直接读本地缓存里的值，进页面时应自动套用
  wx.setStorageSync('antiprint_scale', 'xl')
  const scaled = loadPage('submit')
  await flush(60)
  check(
    '重新进页面仍套用「特大」',
    String(scaled.document.body.className).includes('scale-xl'),
    String(scaled.document.body.className),
  )
  wx.removeStorageSync('antiprint_scale')

  console.log('\n[6] 登录兜底：没有令牌时跳登录页')
  storage = {}
  apiCalls = []
  redirects = []
  const guarded = loadPage('jobs')
  await flush(30)
  const bodyText = textOf(guarded.document.body)
  check('未登录不渲染页面内容', !bodyText.includes('任务 #12'), bodyText.slice(0, 60))
  check('未登录未发任何接口请求', apiCalls.length === 0, apiCalls.join(','))
  check('location 被改写为 /login', guarded.window.location.href.indexOf('/login') >= 0, guarded.window.location.href)

  console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
  process.exit(failed ? 1 : 0)
}

run().catch((error) => {
  console.error('\n冒烟测试异常：', error)
  process.exit(1)
})
