// UI 验收：队列页「重新打印 / 删除」+ 我的任务「撤回」
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test15.mjs
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

const tag = String(Date.now()).slice(-6)
const UNAME = 'wdr' + tag
const reg = await (await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})).json()
const UT = reg.token
const UH = { Authorization: 'Bearer ' + UT }
const adminToken = (await (await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json()).token
const AH = { Authorization: 'Bearer ' + adminToken }
const AGENT = (await (await fetch(API + '/api/settings', { headers: AH })).json()).settings.agent_token
const Gh = { 'X-Agent-Token': AGENT, 'Content-Type': 'application/json' }

/** 走接口造一个任务并让它变成「已打印」 */
async function makePrintedJob(address) {
  const body = new FormData()
  body.append('address', address)
  body.append('delivery_mode', '配送')
  body.append('note', '按钮验收')
  body.append('files', new Blob([fs.readFileSync(PDF)], { type: 'application/pdf' }), 'test-print.pdf')
  const job = (await (await fetch(API + '/api/jobs', { method: 'POST', headers: UH, body })).json()).job
  await fetch(`${API}/api/jobs/${job.id}/approve`, { method: 'POST', headers: AH })
  await fetch(`${API}/api/agent/claim`, { method: 'POST', headers: Gh, body: '{}' })
  await fetch(`${API}/api/agent/jobs/${job.id}/result`, { method: 'POST', headers: Gh, body: JSON.stringify({ ok: true, error: null }) })
  return job.id
}

const printedId = await makePrintedJob('按钮验收-已打印（可删除）')

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
const page = await ctx.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))
const nav = (name) => page.locator('aside').getByRole('link', { name })

async function login(username, password) {
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  if (!page.url().includes('/login')) {
    await page.getByRole('button', { name: /退出/ }).click()
    await page.waitForTimeout(1300)
    await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
  }
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2300)
}

try {
  console.log('\n1. 我的任务：撤回按钮（两步提交一单，再撤回）')
  await login(UNAME, 'Test123456')
  await page.locator('input[type=file]').first().setInputFiles(PDF)
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: '下一步：填写配送信息' }).click()
  await page.waitForTimeout(800)
  await page.locator('input[name=address]').fill('撤回验收（可删除）')
  await page.getByRole('button', { name: '提交打印任务' }).click()
  await page.waitForTimeout(2400)

  await nav(/我的任务/).click()
  await page.waitForTimeout(1600)
  check('待审核任务显示「撤回」按钮', (await page.getByRole('button', { name: '撤回' }).count()) > 0, '')
  await page.getByRole('button', { name: '撤回' }).first().click()
  await page.waitForTimeout(900)
  const modalText = await page.locator('body').innerText()
  check('撤回确认弹窗出现', /撤回任务 #\d+/.test(modalText) && /需要重新提交才能打印/.test(modalText), '')
  await shot(page, 'W1-withdraw-modal')
  await page.getByRole('button', { name: '确认撤回' }).click()
  await page.waitForTimeout(2200)
  const mineText = await page.locator('body').innerText()
  check('撤回后状态变「已撤回」', /已撤回/.test(mineText), '')
  check('撤回后不再显示撤回按钮', (await page.getByRole('button', { name: '撤回' }).count()) === 0, '')
  await shot(page, 'W2-mine-withdrawn')

  console.log('\n2. 任务队列：重新打印')
  await login('admin', 'admin123')
  await nav(/任务队列/).click()
  await page.waitForTimeout(2200)
  const row = page.locator('tr', { hasText: '#' + printedId }).first()
  check('已打印任务行出现「重新打印」', (await row.getByRole('button', { name: '重新打印' }).count()) > 0, '')
  await shot(page, 'W3-queue-buttons')
  await row.getByRole('button', { name: '重新打印' }).click()
  await page.waitForTimeout(2400)
  const afterReprint = await (await fetch(`${API}/api/jobs/${printedId}`, { headers: AH })).json()
  check('重新打印后回到「已通过」（重新入队）', afterReprint.job.status === '已通过', afterReprint.job.status)
  const rowText = await page.locator('tr', { hasText: '#' + printedId }).first().innerText()
  check('重新入队后不再显示「重新打印」（已通过阶段）', !/重新打印/.test(rowText), '')

  console.log('\n3. 任务队列：删除（二次确认）')
  const delRow = page.locator('tr', { hasText: '#' + printedId }).first()
  check('每行都有「删除」按钮', (await delRow.getByRole('button', { name: '删除' }).count()) > 0, '')
  await delRow.getByRole('button', { name: '删除' }).click()
  await page.waitForTimeout(900)
  const delModal = await page.locator('body').innerText()
  check('删除确认弹窗提示不可恢复', /删除任务 #\d+/.test(delModal) && /不可恢复/.test(delModal), '')
  await shot(page, 'W4-delete-modal')
  await page.getByRole('button', { name: '确认删除' }).click()
  await page.waitForTimeout(2400)
  check('删除后列表里该任务消失', (await page.locator('tr', { hasText: '#' + printedId }).count()) === 0, '')
  const gone = await fetch(`${API}/api/jobs/${printedId}`, { headers: AH })
  check('接口侧该任务已 404', gone.status === 404, String(gone.status))
  await shot(page, 'W5-queue-after-delete')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error15')
} finally {
  await browser.close()
}

// 清理
for (const j of (await (await fetch(API + '/api/jobs', { headers: AH })).json()).jobs.filter((j) => j.username === UNAME)) {
  await fetch(`${API}/api/jobs/${j.id}`, { method: 'DELETE', headers: AH })
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 撤回 / 重新打印 / 删除 UI：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`（测试账号 ${UNAME} 的任务已清理）截图目录：${SHOTS}`)
process.exit(fail.length || jsErrors.length ? 1 : 0)
