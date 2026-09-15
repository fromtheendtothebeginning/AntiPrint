// UI 验收：管理设置页的「断开连接 / 重新连接」打印代理
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test18.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

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
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })

const adminToken = (await (await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json()).token
const AH = { Authorization: 'Bearer ' + adminToken }
const AGENT = (await (await fetch(API + '/api/settings', { headers: AH })).json()).settings.agent_token
const GH = { 'X-Agent-Token': AGENT, 'Content-Type': 'application/json' }

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))
// 请求日志：定位「谁在什么时候调了 agent-link」（排查断开状态被意外改回）
const t0 = Date.now()
page.on('request', (req) => {
  if (req.url().includes('/api/settings')) {
    console.log(`    [请求 +${((Date.now() - t0) / 1000).toFixed(1)}s] ${req.method()} ${req.url().replace(ORIGIN, '')} ${req.postData() ?? ''}`)
  }
})

try {
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码').fill('admin123')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2400)
  await page.goto(ORIGIN + '/admin', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1800)

  console.log('\n1. 代理区默认状态与按钮')
  const card = page.locator('section', { hasText: '打印代理' }).first()
  const before = await card.innerText()
  check('默认显示在线/离线（未断开）', /打印代理在线|打印代理离线/.test(before) && !/已断开/.test(before), before.replace(/\n/g, ' | ').slice(0, 50))
  check('有「断开连接」按钮', (await card.getByRole('button', { name: '断开连接' }).count()) === 1, '')

  console.log('\n2. 点「断开连接」→ 二次确认弹窗')
  await card.getByRole('button', { name: '断开连接' }).click()
  await page.waitForTimeout(700)
  const modal = page.locator('.fixed.inset-0.z-50').last()
  const modalText = await modal.innerText()
  check('弹窗标题说明断开影响', /断开打印代理连接/.test(modalText) && /不会.*出纸|不会有任何任务出纸/.test(modalText), modalText.replace(/\n/g, ' | ').slice(0, 60))
  await shot(page, 'L1-disconnect-confirm')
  await modal.getByRole('button', { name: '断开连接' }).click()
  await page.waitForTimeout(1800)

  console.log('\n3. 断开后的界面与服务端行为')
  const after = await card.innerText()
  check('状态变成「打印代理已断开」', /打印代理已断开/.test(after), after.replace(/\n/g, ' | ').slice(0, 40))
  check('给出断开说明（不领任务 / 排队等待 / 可恢复）',
        /已通过的任务只是排队等待/.test(after) && /重新连接/.test(after), '')
  check('按钮变成「重新连接」', (await card.getByRole('button', { name: '重新连接' }).count()) === 1, '')
  const r = await fetch(API + '/api/agent/claim', { method: 'POST', headers: GH, body: '{}' })
  check('服务端确实拒绝代理领取（403）', r.status === 403, String(r.status))
  const enabled = (await (await fetch(API + '/api/settings', { headers: AH })).json()).settings.agent_enabled
  check('设置里 agent_enabled = 0', String(enabled) === '0', String(enabled))
  await shot(page, 'L2-disconnected')

  console.log('\n4. 点「重新连接」恢复')
  await card.getByRole('button', { name: '重新连接' }).click()
  await page.waitForTimeout(2000)
  const restored = await card.innerText()
  check('状态回到在线/离线（不再是已断开）', /打印代理在线|打印代理离线/.test(restored) && !/已断开/.test(restored), restored.replace(/\n/g, ' | ').slice(0, 40))
  check('断开提示消失', !/已通过的任务只是排队等待/.test(restored), '')
  check('按钮变回「断开连接」', (await card.getByRole('button', { name: '断开连接' }).count()) === 1, '')
  const r2 = await fetch(API + '/api/agent/claim', { method: 'POST', headers: GH, body: '{}' })
  check('服务端恢复接受代理请求', r2.status === 200, String(r2.status))
  await shot(page, 'L3-reconnected')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error18')
} finally {
  await browser.close()
  // 无论成败都把连接恢复，别把本机后端留在「已断开」
  await fetch(API + '/api/settings/agent-link', {
    method: 'POST', headers: { ...AH, 'Content-Type': 'application/json' }, body: JSON.stringify({ connected: true }),
  })
}

// 收尾断言：跑完必须回到「已连接」，否则把本机后端留成断开状态会连累其它用例
const finalState = (await (await fetch(API + '/api/settings', { headers: AH })).json()).settings.agent_enabled
check('用例结束时代理处于已连接状态（不留残留）', String(finalState) === '1', String(finalState))

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 代理断开/重连 UI：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`截图目录：${SHOTS}`)
process.exit(fail.length || jsErrors.length ? 1 : 0)
