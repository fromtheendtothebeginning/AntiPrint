// UI 验收 ①：任务队列页（交接勾选）+ 用户配置页（默认地址/默认配送方式）+ 提交页预填
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test8.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const ORIGIN = 'http://127.0.0.1:8301'
const API = ORIGIN
const PDF = 'D:/anticraft/AntiPrint/.tmp-test/test-print.pdf'
const CHROME = 'C:/Users/86133/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const SHOTS = 'D:/anticraft/AntiPrint/.tmp-test/shots'
fs.mkdirSync(SHOTS, { recursive: true })

const pass = []
const fail = []
const check = (name, cond, extra = '') => {
  ;(cond ? pass : fail).push(name)
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + (extra ? '  ' + extra : ''))
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })

const adminLogin = await (await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json()
const AT = adminLogin.token
const AH = { Authorization: 'Bearer ' + AT, 'Content-Type': 'application/json' }
const settings = await (await fetch(API + '/api/settings', { headers: AH })).json()
const AGENT = settings.settings.agent_token

const tag = String(Date.now()).slice(-6)
const UNAME = 'queue' + tag
const UADDR = '三教 305 教室靠窗第一排（队列验收）'

const reg = await (await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})).json()
const UT = reg.token
console.log(`\n测试用户 ${UNAME} 已注册`)

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
const page = await ctx.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))

/** 导航点击限定在侧栏，避免与页面内的「我的配置 / 任务队列」等提示链接重名 */
const nav = (name) => page.locator('aside').getByRole('link', { name })

async function login(role) {
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  if (!page.url().includes('/login')) {
    // 已登录会被重定向走：先退出，再进登录页
    await page.getByRole('button', { name: /退出/ }).click()
    await page.waitForTimeout(1300)
    await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
  }
  await page.getByLabel('用户名').fill(role === 'admin' ? 'admin' : UNAME)
  await page.getByLabel('密码').fill(role === 'admin' ? 'admin123' : 'Test123456')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2200)
}

try {
  console.log('\n1. 用户配置页：默认地址 + 默认配送方式')
  await login('user')
  await nav(/我的配置/).click()
  await page.waitForTimeout(1500)
  check('进入 /profile', page.url().includes('/profile'), page.url())
  const profileText = await page.locator('body').innerText()
  check('配置页出现三项内容', /默认配送方式/.test(profileText) && /默认配送地址/.test(profileText) && /anticraft/.test(profileText), '')
  await page.getByRole('radio', { name: /取件/ }).click().catch(async () => {
    await page.getByText('取件', { exact: false }).first().click()
  })
  await page.getByLabel('默认配送地址').fill(UADDR)
  await shot(page, '80-profile-form')
  await page.getByRole('button', { name: '保存配置' }).click()
  await page.waitForTimeout(1500)
  const saved = await (await fetch(API + '/api/profile', { headers: { Authorization: 'Bearer ' + UT } })).json()
  check('默认配置已写入后端', saved.profile.default_delivery === '取件' && saved.profile.default_address === UADDR,
        `${saved.profile.default_delivery} / ${saved.profile.default_address}`)

  console.log('\n2. 提交页按默认配置预填（取件 → 地址非必填）')
  await nav(/提交打印/).click()
  await page.waitForTimeout(1600)
  // 现在提交是两步：先选文件 → 下一步，才到配送信息（默认地址在这一步预填）
  await page.locator('input[type=file]').first().setInputFiles(PDF)
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: '下一步：填写配送信息' }).click()
  await page.waitForTimeout(900)
  const addrValue = await page.locator('input[name=address]').inputValue()
  check('默认地址已预填', addrValue === UADDR, addrValue)
  const checkedPickup = await page.getByRole('radio', { name: /取件/ }).isChecked().catch(() => null)
  check('默认配送方式预选为「取件」', checkedPickup === true, String(checkedPickup))
  await shot(page, '81-submit-prefilled')

  console.log('\n3. 提交一个「配送」单并让代理打出来（走接口，避免真出纸）')
  const form = new FormData()
  form.append('address', '测试楼 101（队列验收）')
  form.append('note', '队列交接验收')
  form.append('delivery_mode', '配送')
  form.append('files', new Blob([fs.readFileSync(PDF)], { type: 'application/pdf' }), 'test-print.pdf')
  const created = await (await fetch(API + '/api/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + UT }, body: form })).json()
  const jobId = created.job.id
  check(`任务 #${jobId} 已创建（配送单）`, created.job.delivery_mode === '配送', created.job.delivery_mode)
  await fetch(`${API}/api/jobs/${jobId}/approve`, { method: 'POST', headers: AH })
  await fetch(`${API}/api/agent/claim`, { method: 'POST', headers: { 'X-Agent-Token': AGENT, 'Content-Type': 'application/json' }, body: '{}' })
  await fetch(`${API}/api/agent/jobs/${jobId}/result`, {
    method: 'POST', headers: { 'X-Agent-Token': AGENT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, error: null }),
  })
  const printed = await (await fetch(`${API}/api/jobs/${jobId}`, { headers: { Authorization: 'Bearer ' + UT } })).json()
  check('任务已到「已打印」', printed.job.status === '已打印', printed.job.status)

  console.log('\n4. 任务队列页：勾选「待配送」→「已完成」')
  await login('admin')
  await nav(/任务队列/).click()
  await page.waitForTimeout(2000)
  check('进入 /queue', page.url().includes('/queue'), page.url())
  const queueText = await page.locator('body').innerText()
  check('表格含配送方式列与状态筛选', /配送方式/.test(queueText) && /全部/.test(queueText), '')
  const row = page.locator('tr', { hasText: '#' + jobId }).first()
  check('找到目标任务行', (await row.count()) > 0, '')
  await shot(page, '82-queue-before')

  await row.getByLabel('待配送').click()
  await page.waitForTimeout(2200)
  const afterDelivery = await (await fetch(`${API}/api/jobs/${jobId}`, { headers: { Authorization: 'Bearer ' + UT } })).json()
  check('勾选后状态=待配送', afterDelivery.job.status === '待配送', afterDelivery.job.status)
  const row2 = page.locator('tr', { hasText: '#' + jobId }).first()
  await shot(page, '83-queue-await-delivery')
  check('行内出现「已完成」勾选', (await row2.locator('text=已完成').count()) > 0, '')

  await row2.getByLabel('已完成').click()
  await page.waitForTimeout(2200)
  const done = await (await fetch(`${API}/api/jobs/${jobId}`, { headers: { Authorization: 'Bearer ' + UT } })).json()
  check('再次勾选后状态=已完成且有时间', done.job.status === '已完成' && !!done.job.finished_at, `${done.job.status} / ${done.job.finished_at}`)
  await shot(page, '84-queue-done')

  console.log('\n5. 用户侧看到交接状态')
  await login('user')            // 上一步是管理员登录，这里换回提交人自己看
  await page.goto(ORIGIN + '/mine', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1600)
  const mineText = await page.locator('body').innerText()
  check('我的任务显示配送方式与完成时间', /配送方式/.test(mineText) && /已完成/.test(mineText), '')
  await shot(page, '85-mine-done')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error8')
} finally {
  await browser.close()
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 队列/配置 UI：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log('截图目录：' + SHOTS)
process.exit(fail.length || jsErrors.length ? 1 : 0)
