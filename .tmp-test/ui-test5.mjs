// AntiPrint UI 测试 v5（临时脚本）：anticraft 跳转授权登录全流程
// 浏览器直连 8301（后端单进程托管 dist），授权页由 mock anticraft（8302）扮演。
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const ORIGIN = 'http://127.0.0.1:8301'
const API = ORIGIN
const MOCK = 'http://127.0.0.1:8302'
const REAL = 'https://anticraft.top'
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

const tag = String(Date.now()).slice(-6)
const CLIENT_ID = 'ac_ui' + tag
const CLIENT_SECRET = 'acs_ui' + tag
// 每次跑用全新的 anticraft 用户 ID，避免复用上一轮的账号（后端按 anticraft_id 认定同一人，会保留原用户名）
const AC_ID = 40000 + Math.floor(Math.random() * 20000)
const AC_NAME = 'oauthui' + tag

const adminToken = (await (await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json()).token
const AH = { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' }

await fetch(MOCK + '/api/__set_app', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    redirect_uris: [`${ORIGIN}/api/oauth/anticraft/callback`], name: 'AntiPrint 远程打印',
  }),
})
await fetch(API + '/api/settings', {
  method: 'POST', headers: AH,
  body: JSON.stringify({ anticraft_base: MOCK, anticraft_client_id: CLIENT_ID, anticraft_client_secret: CLIENT_SECRET }),
})
await fetch(MOCK + '/api/__config', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user_id: AC_ID, username: AC_NAME }),
})
console.log(`\n已配置 mock 绑定应用（${CLIENT_ID}）与 anticraft 用户 ${AC_NAME}（id=${AC_ID}）`)

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('  [页面 JS 错误] ' + e.message))

try {
  console.log('\n1. 登录页：anticraft Tab 与跳转按钮')
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.getByText('anticraft 登录', { exact: false }).first().click()
  await page.waitForTimeout(800)
  const redirectBtn = page.getByRole('button', { name: /跳转授权/ })
  check('出现「用 anticraft 登录（跳转授权）」按钮', (await redirectBtn.count()) > 0, '')
  check('按钮为可用状态（已配置绑定应用）', (await redirectBtn.isDisabled().catch(() => true)) === false, '')
  const tabText = await page.locator('body').innerText()
  check('保留备用密码方式说明', /备用方式/.test(tabText), '')
  await shot(page, '40-anticraft-tab-oauth')

  console.log('\n2. 点击跳转 → 授权页 → 回跳 → 自动登录')
  await redirectBtn.click()
  await page.waitForURL(/login\/anticraft\/callback/, { timeout: 25000 })
  await page.waitForTimeout(300)
  await shot(page, '41-callback-landing')
  await page.waitForURL(/\/submit/, { timeout: 25000 })
  check('最终进入提交页（已登录）', page.url().includes('/submit'), page.url())
  await shot(page, '42-after-oauth-login')

  const token = await page.evaluate(() => localStorage.getItem('token'))
  const user = await page.evaluate(() => localStorage.getItem('user'))
  check('本地已保存登录态', !!token && !!user, String(user))
  if (token) {
    const me = await (await fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + token } })).json()
    check('登录态对应用户名 = anticraft 用户名', me.username === AC_NAME, JSON.stringify(me))
  }

  const navText = await page.locator('body').innerText()
  check('顶栏显示用户名（已登录界面）', navText.includes(AC_NAME), '')
  check('已登录用户看不到登录入口', !/登\s*录/.test(navText.split('\n')[0]), '')

  console.log('\n3. 未配置绑定应用时的引导（正是需要管理员去 anticraft 登记的信息）')
  await fetch(API + '/api/settings', {
    method: 'POST', headers: AH, body: JSON.stringify({ anticraft_client_id: '' }),
  })
  const page2 = await ctx.newPage()
  await page2.context().clearCookies()
  await page2.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page2.waitForTimeout(500)
  await page2.evaluate(() => localStorage.clear())
  await page2.reload({ waitUntil: 'networkidle' })
  await page2.waitForTimeout(600)
  await page2.getByText('anticraft 登录', { exact: false }).first().click()
  await page2.waitForTimeout(900)
  const hintText = await page2.locator('body').innerText()
  check('提示管理员去 anticraft 后台登记', /登记/.test(hintText), '')
  check('提示里给出需要登记的回调地址',
        hintText.includes(`${ORIGIN}/api/oauth/anticraft/callback`), '')
  await shot(page2, '43-not-configured-hint')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error5')
} finally {
  await browser.close()
}

// 收尾：恢复真实地址 + 清空绑定配置 + 清理测试账号
await fetch(API + '/api/settings', { method: 'POST', headers: AH, body: JSON.stringify({ anticraft_base: REAL }) })
await fetch(API + '/api/settings', { method: 'POST', headers: AH, body: JSON.stringify({ anticraft_client_id: '' }) })
console.log('\n收尾：已恢复 anticraft_base = ' + REAL + '（client_id 清空需直接改库，见测试脚本收尾）')

console.log(`\n===== UI v5 结果：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log('截图目录：' + SHOTS)
process.exit(fail.length ? 1 : 0)
