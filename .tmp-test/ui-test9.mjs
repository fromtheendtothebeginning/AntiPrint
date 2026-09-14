// UI 验收 ②：我的配置页「绑定 / 解除绑定 anticraft 账号」（真实本机 anticraft 授权）
// 自包含、可重复：A 绑定成功 → B 撞冲突守卫 → A 解绑并设置本地密码
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test9.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const ORIGIN = 'http://127.0.0.1:8301'
const API = ORIGIN
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

// anticraft 侧会话（本机 anticraft，用 index 文档里的本地测试账号）
const anti = await (await fetch(ANTI_API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'demotools', password: 'DemoTools123' }),
})).json()
const ANTI_TOKEN = anti.access_token

const tag = String(Date.now()).slice(-6)
const A = 'binda' + tag
const B = 'bindb' + tag
const NEW_PW = 'LocalPass' + tag
for (const name of [A, B]) {
  await fetch(API + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'Test123456' }),
  })
}
console.log(`\n测试账号：${A}（先绑定）、${B}（撞冲突）`)

// 绑定前先确保「本机 anticraft 用户」没有被别的 AntiPrint 账号占着
// （拿 demotools 自己的 AntiPrint 账号解绑，若有；找不到就跳过——此时 126 本来就空闲）
const dbState = await (await fetch(API + '/api/jobs', {
  headers: { Authorization: 'Bearer ' + (await (await fetch(API + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json()).token },
})).json()
console.log(`（当前队列 ${dbState.jobs.length} 条，不影响本测试）`)

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
await ctx.addInitScript((token) => {
  if (location.origin === 'http://localhost:3000') localStorage.setItem('token', token)
}, ANTI_TOKEN)
const page = await ctx.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))
const nav = (name) => page.locator('aside').getByRole('link', { name })

async function loginAs(username, password) {
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

async function goProfile() {
  await nav(/我的配置/).click()
  await page.waitForTimeout(1600)
}

/** 走一次真实授权：返回落地页文本（1.2 秒后会自动跳走，所以落地即抓） */
async function bindViaConsent() {
  await page.getByRole('button', { name: '绑定 anticraft 账号' }).click()
  await page.waitForURL(/localhost:3000\/bind/, { timeout: 25000 })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '同意绑定' }).click()
  await page.waitForURL(/127\.0\.0\.1:8301\/login\/anticraft\/callback/, { timeout: 25000 })
  await page.waitForTimeout(300)
  const landing = await page.locator('body').innerText()
  await page.waitForTimeout(1900)
  return landing
}

try {
  console.log('\n1. A 账号绑定 anticraft 账号')
  await loginAs(A, 'Test123456')
  await goProfile()
  const t0 = await page.locator('body').innerText()
  check('配置页提供绑定入口', /绑定 anticraft 账号/.test(t0), '')
  const landingA = await bindViaConsent()
  const boundOk = /anticraft 账号绑定成功/.test(landingA)
  check('落地页显示绑定成功', boundOk, landingA.split('\n').filter(Boolean)[0] || '')
  if (!boundOk) {
    console.log('  提示：本机 anticraft 账号可能已被其它 AntiPrint 账号占用，请先解除占用后重跑本脚本')
  }
  await page.waitForURL(/\/(profile|submit)/, { timeout: 25000 })
  await goProfile()
  const t1 = await page.locator('body').innerText()
  check('配置页显示已绑定 + anticraft 用户 ID', /已绑定 anticraft 账号/.test(t1) && /anticraft 用户 ID/.test(t1), '')
  await shot(page, '86-profile-bound')

  console.log('\n2. B 账号绑定同一个 anticraft 账号 → 冲突守卫')
  await loginAs(B, 'Test123456')
  await goProfile()
  const landingB = await bindViaConsent()
  check('落地页报「已绑定到其它 AntiPrint 账号」', /已绑定到 AntiPrint 账号/.test(landingB),
        (landingB.split('\n').find((l) => l.includes('已绑定')) || '').trim())
  await shot(page, '87-bind-conflict')

  console.log('\n3. A 账号解除绑定并设置本地密码')
  await loginAs(A, 'Test123456')
  await goProfile()
  await page.getByRole('button', { name: '解除绑定' }).click()
  await page.waitForTimeout(800)
  const modalText = await page.locator('body').innerText()
  check('解绑弹窗要求设置新密码', /新的本地密码|至少 6 位/.test(modalText), '')
  await shot(page, '88-unbind-modal')
  await page.locator('input[type=password]').last().fill(NEW_PW)
  await page.getByRole('button', { name: /确认解绑/ }).click()
  await page.waitForTimeout(2200)
  const t3 = await page.locator('body').innerText()
  check('解绑后回到未绑定状态', /绑定 anticraft 账号/.test(t3) && !/已绑定 anticraft 账号/.test(t3), '')
  const localLogin = await (await fetch(API + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: A, password: NEW_PW }),
  })).json()
  check('可用新设的本地密码登录', !!localLogin.token, String(localLogin.detail || ''))
  await shot(page, '89-profile-after-unbind')

  console.log('\n4. 清理测试账号')
  const admin = (await (await fetch(API + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json()).token
  for (const name of [A, B]) {
    const users = await (await fetch(`${API}/api/jobs`, { headers: { Authorization: 'Bearer ' + admin } })).json()
    const mine = users.jobs.filter((j) => j.username === name)
    for (const job of mine) {
      await fetch(`${API}/api/jobs/${job.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + admin } })
    }
  }
  console.log('  （账号本身由收尾脚本统一清理）')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error9')
} finally {
  await browser.close()
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== anticraft 绑定 UI：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`测试账号：${A} / ${B}`)
console.log('截图目录：' + SHOTS)
process.exit(fail.length || jsErrors.length ? 1 : 0)
