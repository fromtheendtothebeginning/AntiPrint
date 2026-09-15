// UI 验收：账户余额与打印计费
//   - 用户管理页（root）显示余额并可调账
//   - 「我的余额」页：余额/单价/账号类型/消费记录
//   - 提交页：计费提示、成功后显示本次扣费、余额不足弹「付款码（暂未开放）」占位
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test20.mjs（需先有 root 测试账号，见 README 里的前置命令）
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const ORIGIN = 'http://127.0.0.1:8301'
const API = ORIGIN
const PDF = 'D:/anticraft/AntiPrint/.tmp-test/test-print.pdf'
const CHROME = 'C:/Users/86133/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const SHOTS = 'D:/anticraft/AntiPrint/.tmp-test/shots'
const ROOT_USER = process.env.ROOT_USER || 'rootui'
const ROOT_PW = process.env.ROOT_PW || 'Root123456'
fs.mkdirSync(SHOTS, { recursive: true })

const pass = []
const fail = []
const check = (name, cond, extra = '') => {
  ;(cond ? pass : fail).push(name)
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + (extra ? '  ' + extra : ''))
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })

const tag = String(Date.now()).slice(-6)
const UNAME = 'pay' + tag
const UT = (await (await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})).json()).token
const UH = { Authorization: 'Bearer ' + UT }

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))

async function loginAs(username, password) {
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2400)
}

async function logout() {
  await page.getByRole('button', { name: /退出/ }).click()
  await page.waitForTimeout(1400)
}

try {
  console.log('\n1. root 在「用户管理」给账号调账')
  await loginAs(ROOT_USER, ROOT_PW)
  // 硬刷新到 /users 会被应用弹回队列页；点侧栏导航进入最接近真实用法
  await page.getByRole('link', { name: /用户管理/ }).click()
  await page.waitForTimeout(1600)
  const row = page.locator('tr', { hasText: UNAME }).first()
  check('用户列表显示余额列（0.00 元）', (await row.innerText()).includes('0.00 元'), (await row.innerText()).replace(/\n/g, ' | ').slice(0, 60))
  await row.getByRole('button', { name: '调整余额' }).click()
  await page.waitForTimeout(700)
  const modal = page.locator('.fixed.inset-0.z-50').last()
  await page.locator('#balance-delta').fill('1')
  await page.locator('#balance-note').fill('UI 验收充值')
  await shot(page, 'P1-adjust-balance')
  await modal.getByRole('button', { name: '确认调整' }).click()
  await page.waitForTimeout(1800)
  const afterText = await page.locator('tr', { hasText: UNAME }).first().innerText()
  check('调账后余额显示 1.00 元', afterText.includes('1.00 元'), afterText.replace(/\n/g, ' | ').slice(0, 60))

  console.log('\n2. 用户侧「我的余额」页')
  await logout()
  await loginAs(UNAME, 'Test123456')
  await page.goto(ORIGIN + '/balance', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const body = await page.locator('body').innerText()
  check('导航里有「我的余额」入口', /我的余额/.test(body), '')
  check('显示余额 1.00 与计费单价', /¥1\.00/.test(body) && /计费账号/.test(body) && /0\.1 元\/张/.test(body), '')
  check('提示充值暂未开放', /充值功能暂未开放/.test(body), '')
  check('消费记录里有管理员调账 +1.00', /管理员调账|UI 验收充值/.test(body) && /\+¥1\.00/.test(body), '')
  await shot(page, 'P2-balance-page')

  console.log('\n3. 提交页：计费提示 → 提交成功显示扣费')
  await page.goto(ORIGIN + '/submit', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.locator('input[type=file]').first().setInputFiles([PDF])
  await page.waitForTimeout(1200)
  const step1 = await page.locator('body').innerText()
  check('第一步提示按张计费与当前余额', /按 0\.1 元\/张 计费/.test(step1) && /当前余额 1\.00 元/.test(step1), '')
  await page.getByRole('button', { name: '下一步：填写配送信息' }).click()
  await page.waitForTimeout(800)
  await page.locator('input[name=address]').fill('计费 UI 验收（可删除）')
  await page.getByRole('button', { name: '提交打印任务' }).click()
  await page.waitForTimeout(3500)
  const done = await page.locator('body').innerText()
  check('提交成功卡片显示本次扣费 0.10 元与余额 0.90 元',
        /本次扣费/.test(done) && /0\.10 元/.test(done) && /余额 0\.90 元/.test(done), done.replace(/\n/g, ' | ').slice(-90))
  await shot(page, 'P3-submit-charged')

  console.log('\n4. 余额不足：弹「付款码（暂未开放）」占位')
  await logout()
  await loginAs(ROOT_USER, ROOT_PW)
  // 硬刷新到 /users 会被应用弹回队列页；点侧栏导航进入最接近真实用法
  await page.getByRole('link', { name: /用户管理/ }).click()
  await page.waitForTimeout(1500)
  await page.locator('tr', { hasText: UNAME }).first().getByRole('button', { name: '调整余额' }).click()
  await page.waitForTimeout(700)
  await page.locator('#balance-delta').fill('-0.9')
  await page.locator('.fixed.inset-0.z-50').last().getByRole('button', { name: '确认调整' }).click()
  await page.waitForTimeout(1800)
  await logout()
  await loginAs(UNAME, 'Test123456')
  await page.goto(ORIGIN + '/submit', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.locator('input[type=file]').first().setInputFiles([PDF])
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '下一步：填写配送信息' }).click()
  await page.waitForTimeout(800)
  await page.locator('input[name=address]').fill('余额不足验收（可删除）')
  await page.getByRole('button', { name: '提交打印任务' }).click()
  await page.waitForTimeout(2500)
  const payModal = page.locator('.fixed.inset-0.z-50').last()
  const payText = await payModal.innerText()
  check('弹出余额不足弹窗并显示应付金额与余额',
        /余额不足/.test(payText) && /本单应付/.test(payText) && /0\.10 元/.test(payText) && /当前余额/.test(payText), payText.replace(/\n/g, ' | ').slice(0, 80))
  check('付款码占位（暂未开放）', /付款码暂未开放/.test(payText), '')
  await shot(page, 'P4-insufficient-paywall')
  await payModal.getByRole('link', { name: '去我的余额' }).click()
  await page.waitForTimeout(1500)
  check('「去我的余额」跳到我的余额页', /我的余额/.test(await page.locator('body').innerText()), '')

  console.log('\n5. 免费账号（管理员）不显示计费提示')
  await logout()
  await loginAs('admin', 'admin123')
  await page.goto(ORIGIN + '/submit', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.locator('input[type=file]').first().setInputFiles([PDF])
  await page.waitForTimeout(1200)
  const adminText = await page.locator('body').innerText()
  check('管理员账号提示「免费账号」而不是按张计费', /免费账号/.test(adminText) && !/按 0\.1 元\/张 计费/.test(adminText),
        adminText.replace(/\n/g, ' | ').slice(-80))
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error20')
} finally {
  await browser.close()
}

// 清理：删掉本次账号的任务
const AH = { Authorization: 'Bearer ' + (await (await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json()).token }
for (const j of (await (await fetch(API + '/api/jobs', { headers: AH })).json()).jobs.filter((j) => j.username === UNAME)) {
  await fetch(`${API}/api/jobs/${j.id}`, { method: 'DELETE', headers: AH })
}
await fetch(API + '/api/settings', {
  method: 'POST', headers: { ...AH, 'Content-Type': 'application/json' }, body: JSON.stringify({ print_price: '0.1' }),
})

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 余额计费 UI：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`截图目录：${SHOTS}`)
process.exit(fail.length || jsErrors.length ? 1 : 0)
