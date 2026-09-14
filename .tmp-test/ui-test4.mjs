// AntiPrint UI 测试 v4（临时脚本）：anticraft 登录 Tab + 自动建号提示 + 管理页服务地址
// 用 mock anticraft（127.0.0.1:8302）测成功路径：真实 anticraft.top 上我没有可用账号。
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:3010'
const API = 'http://127.0.0.1:8301'
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

const adminLogin = await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})
const adminToken = (await adminLogin.json()).token
const AH = { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' }

const tag = String(Date.now()).slice(-6)
const newUser = 'uiacct' + tag
await fetch(MOCK + '/api/__set_account', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: newUser, password: 'Ui123456' }),
})
await fetch(API + '/api/settings', { method: 'POST', headers: AH, body: JSON.stringify({ anticraft_base: MOCK }) })
console.log(`\n已把 anticraft_base 指向 mock；将用新账号 ${newUser} 测自动建号`)

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('  [页面 JS 错误] ' + e.message))

try {
  console.log('\n1. 登录页出现 anticraft 登录入口')
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const loginText = await page.locator('body').innerText()
  check('登录页有「anticraft 登录」Tab', /anticraft/.test(loginText), '')
  await shot(page, '30-login-tabs')

  console.log('\n2. 用 anticraft 账号登录（本地无账号 → 自动注册）')
  await page.getByText('anticraft 登录', { exact: false }).first().click()
  await page.waitForTimeout(500)
  const tabText = await page.locator('body').innerText()
  check('说明文案提示会自动创建账号', /自动创建|自动注册/.test(tabText), '')
  await shot(page, '31-anticraft-tab')

  const inputs = page.locator('.card input')
  await inputs.nth(0).fill(newUser)
  await inputs.nth(1).fill('Ui123456')
  await page.getByRole('button', { name: /anticraft 登录/ }).click()
  await page.waitForTimeout(1200)
  const noticeText = await page.locator('body').innerText()
  check('显示「已自动创建 AntiPrint 账号」提示', /已自动创建/.test(noticeText), '')
  await shot(page, '32-auto-registered-notice')

  await page.waitForTimeout(2500)
  check('自动跳转到提交页', page.url().includes('/submit'), page.url())
  await shot(page, '33-after-anticraft-login')

  console.log('\n3. 本地账号来源与密码一致性（接口侧核对）')
  const me = await (await fetch(API + '/api/me', {
    headers: { Authorization: 'Bearer ' + JSON.parse(await page.evaluate(() => localStorage.getItem('token') ? JSON.stringify({ t: localStorage.getItem('token') }) : '{}')).t },
  })).json()
  check('登录态对应用户名正确', me.username === newUser, JSON.stringify(me))

  const localLogin = await fetch(API + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: newUser, password: 'Ui123456' }),
  })
  check('同一密码可通过 AntiPrint 登录页登录（密码一致）', localLogin.status === 200, String(localLogin.status))

  console.log('\n4. 管理页出现 anticraft 服务地址设置项')
  const adminPage = await ctx.newPage()
  await adminPage.goto(BASE + '/login', { waitUntil: 'networkidle' })
  await adminPage.waitForTimeout(500)
  await adminPage.getByRole('button', { name: /退出|登出/ }).first().click().catch(() => {})
  await adminPage.goto(BASE + '/login', { waitUntil: 'networkidle' })
  await adminPage.waitForTimeout(600)
  await adminPage.locator('.card input').first().fill('admin')
  await adminPage.locator('input[type=password]').first().fill('admin123')
  await adminPage.getByRole('button', { name: /登\s*录/ }).first().click()
  await adminPage.waitForTimeout(2500)
  const adminText = await adminPage.locator('body').innerText()
  check('管理页显示 anticraft 服务地址设置项', /anticraft 服务地址/.test(adminText), '')
  const inputValue = await adminPage.locator('#setting-anticraft-base').inputValue().catch(() => '')
  check('设置项回显当前服务地址（mock）', inputValue === MOCK, inputValue)
  await shot(adminPage, '34-admin-anticraft-base')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error4')
} finally {
  await browser.close()
}

// 收尾：恢复真实服务地址 + 清理测试账号
await fetch(API + '/api/settings', { method: 'POST', headers: AH, body: JSON.stringify({ anticraft_base: REAL }) })
console.log('\n收尾：anticraft_base 已恢复为 ' + REAL)

console.log(`\n===== UI v4 结果：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log('截图目录：' + SHOTS)
process.exit(fail.length ? 1 : 0)
