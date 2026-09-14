// AntiPrint × 本机 anticraft 真实跳转授权验收（临时脚本）
// 与 ui-test5 的区别：这里不再用 mock，授权页是真正跑在本机的 anticraft（localhost:3000），
// 所以它同时验证了两边的实现与「回调地址精确匹配」这条硬规则。
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test7.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const ORIGIN = 'http://127.0.0.1:8301'          // 本项目（登记的回调地址就是它的 /api/oauth/anticraft/callback）
const ANTI = 'http://localhost:3000'            // 本机跑着的 anticraft（Vite 3000 + 后端 8000）
const ANTI_API = 'http://127.0.0.1:8000'
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

// 直接在 anticraft 侧取一个登录态（用 index 文档里长期保留的本地测试账号），
// 通过 addInitScript 注入其 localStorage，省去驱动它自己的登录界面
const antiLogin = await (await fetch(ANTI_API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'demotools', password: 'DemoTools123' }),
})).json()
const ANTI_TOKEN = antiLogin.access_token
const ANTI_USER = antiLogin.user.username
console.log(`\nanticraft 侧用户：${ANTI_USER}（已取到令牌）`)

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
await ctx.addInitScript((token) => {
  if (location.origin === 'http://localhost:3000') localStorage.setItem('token', token)
}, ANTI_TOKEN)
const page = await ctx.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))

try {
  console.log('\n1. 从本项目发起跳转授权')
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await page.getByText('anticraft 登录', { exact: false }).first().click()
  await page.waitForTimeout(900)
  const btn = page.getByRole('button', { name: /跳转授权/ })
  check('跳转按钮可用（已配置绑定应用）', (await btn.isEnabled()) === true, '')
  await btn.click()

  console.log('\n2. 本机 anticraft 授权页')
  await page.waitForURL(/localhost:3000\/bind/, { timeout: 25000 })
  await page.waitForTimeout(1500)
  const consentText = await page.locator('body').innerText()
  check('授权页展示申请方应用名', /antiprintlocal/.test(consentText), '')
  check('授权页未报白名单/回调地址错误', !/白名单|回调地址与登记值不一致/.test(consentText), '')
  await shot(page, '70-anticraft-consent')

  console.log('\n3. 点「同意绑定」并回跳本项目')
  await page.getByRole('button', { name: '同意绑定' }).click()
  await page.waitForURL(/127\.0\.0\.1:8301\/login\/anticraft\/callback/, { timeout: 25000 })
  await page.waitForTimeout(400)
  await shot(page, '71-callback-landing')
  await page.waitForURL(/127\.0\.0\.1:8301\/submit/, { timeout: 25000 })
  check('回跳后自动登录并进入提交页', page.url().includes('/submit'), page.url())
  await shot(page, '72-after-real-oauth')

  const user = await page.evaluate(() => localStorage.getItem('user'))
  check('登录身份 = anticraft 用户', !!user && user.includes(ANTI_USER), String(user))
  const token = await page.evaluate(() => localStorage.getItem('token'))
  if (token) {
    const me = await (await fetch(ORIGIN + '/api/me', { headers: { Authorization: 'Bearer ' + token } })).json()
    check('本地 /api/me 对应该用户', me.username === ANTI_USER, JSON.stringify(me))
  }

  console.log('\n4. 本地账号与绑定关系')
  // 侧栏用户名（外壳底部）与顶栏都要显示该用户
  const shellText = await page.locator('body').innerText()
  check('侧栏/顶栏显示该用户', shellText.includes(ANTI_USER), '')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 400))
  await shot(page, 'zz-error7')
} finally {
  await browser.close()
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 真实跳转授权：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log('截图目录：' + SHOTS)
process.exit(fail.length || jsErrors.length ? 1 : 0)
