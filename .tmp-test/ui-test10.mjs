// UI 验收：文件预览（「我的任务」/ 管理员队列）——提交前预览由两步向导的第一步预览面板覆盖（见 ui-test13）
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test10.mjs
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
const UNAME = 'prev' + tag
await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
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
  console.log('\n1. 走两步流程提交一个任务')
  await login(UNAME, 'Test123456')
  await page.locator('input[type=file]').first().setInputFiles(PDF)
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: '下一步：填写配送信息' }).click()
  await page.waitForTimeout(800)
  await page.locator('input[name=address]').fill('预览回归（可删除）')
  await page.getByRole('button', { name: '提交打印任务' }).click()
  await page.waitForTimeout(2400)
  check('提交成功', /提交成功/.test(await page.locator('body').innerText()), '')

  console.log('\n2. 「我的任务」点文件名弹窗预览')
  await nav(/我的任务/).click()
  await page.waitForTimeout(1600)
  check('我的任务里有可点击的文件名', /test-print\.pdf/.test(await page.locator('body').innerText()), '')
  await page.getByRole('button', { name: /预览.*test-print\.pdf/ }).first().click()
  await page.waitForTimeout(2000)
  check('我的任务预览弹窗渲染 iframe', (await page.locator('iframe').count()) > 0, '')
  await shot(page, '92-mine-preview')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)

  console.log('\n3. 管理员队列预览')
  await login('admin', 'admin123')
  await nav(/任务队列/).click()
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: /test-print\.pdf/ }).first().click()
  await page.waitForTimeout(2000)
  check('队列预览弹窗渲染 iframe', (await page.locator('iframe').count()) > 0, '')
  await shot(page, '93-queue-preview')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error10')
} finally {
  await browser.close()
}

const adminToken = (await (await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json()).token
for (const j of (await (await fetch(API + '/api/jobs', { headers: { Authorization: 'Bearer ' + adminToken } })).json()).jobs.filter((j) => j.username === UNAME)) {
  await fetch(`${API}/api/jobs/${j.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + adminToken } })
}
console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 预览 UI：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`（测试账号 ${UNAME} 的任务已清理）`)
process.exit(fail.length || jsErrors.length ? 1 : 0)
