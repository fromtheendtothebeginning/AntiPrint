// UI 验收：管理设置页的二级菜单 + 管理员名单 / 免费白名单表格
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test22.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')
import { adminTokenCached } from './lib/admin-token.mjs'

const ORIGIN = 'http://127.0.0.1:8301'
const API = ORIGIN
const CHROME = 'C:/Users/86133/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const SHOTS = 'D:/anticraft/AntiPrint/.tmp-test/shots'
fs.mkdirSync(SHOTS, { recursive: true })

const pass = []
const fail = []
const check = (name, cond, extra = '') => {
  ;(cond ? pass : fail).push(name)
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + (extra ? '  ' + extra : ''))
}

const tag = String(Date.now()).slice(-6)
const WHITE = 'whitelist' + tag      // 白名单里加它
const ANTI = 'antiadmin' + tag       // 管理员名单里加它
const AH = { Authorization: 'Bearer ' + (await adminTokenCached(API)) }
const settings = async () => (await (await fetch(API + '/api/settings', { headers: AH })).json()).settings

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))

try {
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码').fill('admin123')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2400)
  await page.goto(ORIGIN + '/admin', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1600)

  console.log('\n1. 二级菜单')
  const tabs = ['打印设置', '打印计费', 'anticraft 绑定', '打印代理']
  const nav = page.getByRole('navigation', { name: '管理设置子菜单' })
  let found = 0
  for (const name of tabs) found += await nav.getByRole('button', { name }).count()
  check('四个分栏入口都在（两个名单类分栏已挪走/取消）', found === tabs.length, `${found}/${tabs.length}`)
  const body = await page.locator('body').innerText()
  check('默认在「打印设置」（能看到启动器/份数，看不到名单表格）',
        /启动器/.test(body) && /份数/.test(body),
        body.replace(/\n/g, ' | ').slice(-70))
  check('「打印设置」不含 anticraft client_id', !/client_id/.test(body), '')

  console.log('\n2. 打印计费分栏：只有单价，没有名单')
  await nav.getByRole('button', { name: '打印计费' }).click()
  await page.waitForTimeout(600)
  const billing = await page.locator('body').innerText()
  check('显示单价输入框', (await page.locator('#settings-price').count()) === 1, '')
  check('计费分栏里没有白名单输入框', (await page.locator('#settings-free-users').count()) === 0, '')

  console.log('\n3. 免费白名单已挪到「用户管理」（管理设置里不该再有）')
  check('分栏里没有「免费白名单」', (await nav.getByRole('button', { name: '免费白名单' }).count()) === 0, '')
  await nav.getByRole('button', { name: '打印计费' }).click()
  await page.waitForTimeout(600)
  check('计费分栏提示去「用户管理」开关免费账号',
        /「用户管理」页按账号开关/.test(await page.locator('body').innerText()), '')
  check('管理设置里没有白名单输入框', (await page.locator('#settings-free-users').count()) === 0, '')

  console.log('\n4. 管理员名单分栏也已取消')
  check('分栏里没有「管理员名单」', (await nav.getByRole('button', { name: '管理员名单' }).count()) === 0, '')
  check('anticraft 账号的管理员授权走「用户管理」的设为管理员按钮',
        !(await page.locator('input[placeholder="输入 anticraft 用户名"]').count()), '')

  console.log('\n5. 其余分栏')
  await nav.getByRole('button', { name: 'anticraft 绑定' }).click()
  await page.waitForTimeout(600)
  check('anticraft 绑定分栏有 client_id / client_secret / 授权来源',
        (await page.locator('#setting-anticraft-client-id').count()) === 1
        && (await page.locator('#setting-anticraft-client-secret').count()) === 1
        && (await page.locator('#setting-anticraft-origins').count()) === 1, '')
  await nav.getByRole('button', { name: '打印代理' }).click()
  await page.waitForTimeout(600)
  const agentText = await page.locator('body').innerText()
  check('打印代理分栏有代理状态、断开连接与令牌',
        /打印代理/.test(agentText) && /代理令牌/.test(agentText) && /重置令牌/.test(agentText), '')
  await page.screenshot({ path: `${SHOTS}/A2-admin-agent-tab.png`, fullPage: true })
  await nav.getByRole('button', { name: '打印设置' }).click()
  await page.waitForTimeout(600)
  check('切回打印设置仍能看到打印机下拉', (await page.locator('#setting-printer').count()) === 1, '')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
} finally {
  await browser.close()
  // 兜底：别把测试名字留在名单里
  const s = await settings()
  const clean = (v, name) => (v || '').split(',').map((x) => x.trim()).filter((x) => x && x !== name).join(',')
  await fetch(API + '/api/settings', {
    method: 'POST', headers: { ...AH, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      free_users: clean(s.free_users, WHITE),
      anticraft_admin_users: clean(s.anticraft_admin_users, ANTI),
    }),
  })
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 管理页二级菜单与名单表格：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`截图目录：${SHOTS}`)
process.exit(fail.length || jsErrors.length ? 1 : 0)
