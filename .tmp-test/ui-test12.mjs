// 预览高度验收（临时脚本）：内嵌预览与放大弹窗的高度都变高
import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')
const ORIGIN = 'http://127.0.0.1:8301'
const PDF = 'D:/anticraft/AntiPrint/.tmp-test/test-print.pdf'
const CHROME = 'C:/Users/86133/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const SHOTS = 'D:/anticraft/AntiPrint/.tmp-test/shots'
fs.mkdirSync(SHOTS, { recursive: true })
const pass = [], fail = []
const check = (n, c, e = '') => { (c ? pass : fail).push(n); console.log((c ? '  [PASS] ' : '  [FAIL] ') + n + (e ? '  ' + e : '')) }
const tag = String(Date.now()).slice(-6)
const UNAME = 'h' + tag
await fetch(ORIGIN + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: UNAME, password: 'Test123456' }) })
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage()
try {
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.getByLabel('用户名').fill(UNAME)
  await page.getByLabel('密码').fill('Test123456')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2300)
  await page.locator('input[type=file]').first().setInputFiles(PDF)
  await page.waitForTimeout(1200)
  const inline = await page.locator('form iframe').first().boundingBox()
  check('内嵌预览 iframe 高度 ≥ 460px', !!inline && inline.height >= 460, inline ? `${Math.round(inline.height)}px` : '无 iframe')
  await page.screenshot({ path: `${SHOTS}/98-inline-taller.png`, fullPage: true })
  await page.getByRole('button', { name: '放大查看' }).click()
  await page.waitForTimeout(1500)
  const modal = await page.locator('iframe').last().boundingBox()
  check('放大弹窗 iframe 高度 ≥ 700px', !!modal && modal.height >= 700, modal ? `${Math.round(modal.height)}px` : '无 iframe')
  await page.screenshot({ path: `${SHOTS}/99-modal-taller.png` })
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 200))
} finally { await browser.close() }
const adminToken = (await (await fetch(ORIGIN + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).json()).token
for (const j of (await (await fetch(ORIGIN + '/api/jobs', { headers: { Authorization: 'Bearer ' + adminToken } })).json()).jobs.filter((j) => j.username === UNAME)) {
  await fetch(`${ORIGIN}/api/jobs/${j.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + adminToken } })
}
console.log(`\n===== 预览高度：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
console.log(`（测试账号 ${UNAME} 的任务已清理）`)
process.exit(fail.length ? 1 : 0)
