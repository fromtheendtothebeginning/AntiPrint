// UI 验收：用户管理 = 账号操作中心（免费账户开关 / 加收管理员 / 调整余额 / 删除账号）
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test23.mjs
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
const PAID = 'paiduser' + tag      // 普通账号：试免费开关、删除
const AH = { Authorization: 'Bearer ' + (await adminTokenCached(API)) }
const UT = (await (await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: PAID, password: 'Test123456' }),
})).json()).token
const PAID_ID = (await (await fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + UT } })).json()).id
const freeUsers = async () => (await (await fetch(API + '/api/settings', { headers: AH })).json()).settings.free_users || ''

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
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

try {
  console.log('\n1. 用户列表（普通管理员也能进，能看到所有账号）')
  await loginAs('admin', 'admin123')
  await page.goto(ORIGIN + '/users', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1800)
  const row = page.locator('tr', { hasText: PAID }).first()
  const rowText = await row.innerText()
  check('列表里有该账号与余额列', /0\.00 元/.test(rowText), rowText.replace(/\n/g, ' | ').slice(0, 70))
  check('普通账号显示「设为免费」按钮', (await row.getByRole('button', { name: '设为免费' }).count()) === 1, '')
  check('管理员也能看到「删除」按钮（余额为 0 时可用）', (await row.getByRole('button', { name: '删除' }).count()) === 1, '')
  check('管理员看到的加管理员按钮是禁用的（仅 root）',
        await row.getByRole('button', { name: '设为管理员' }).isDisabled(), '')

  console.log('\n2. 免费账户开关（写进 settings.free_users）')
  await row.getByRole('button', { name: '设为免费' }).click()
  await page.waitForTimeout(1600)
  check('服务端白名单已加入', (await freeUsers()).includes(PAID), await freeUsers())
  const afterText = await page.locator('tr', { hasText: PAID }).first().innerText()
  check('行里出现「免费」徽章与「取消免费」按钮', /免费/.test(afterText) && (await page.locator('tr', { hasText: PAID }).first().getByRole('button', { name: '取消免费' }).count()) === 1, '')
  await page.screenshot({ path: `${SHOTS}/U1-users-free-on.png`, fullPage: true })
  await page.locator('tr', { hasText: PAID }).first().getByRole('button', { name: '取消免费' }).click()
  await page.waitForTimeout(1600)
  check('取消免费后服务端也移出', !(await freeUsers()).includes(PAID), await freeUsers())

  console.log('\n2b. 批量添加免费账号（可预登记还没注册的名字）')
  const batchNames = ['batchA' + tag, 'batchB' + tag, 'xy']   // 最后一个长度不合规（<3）
  await page.locator('#batch-free-users').fill(batchNames.join('\n'))
  await page.getByRole('button', { name: '批量加入白名单' }).click()
  await page.waitForTimeout(1800)
  const batchNotice = await page.locator('body').innerText()
  check('提示已加入 2 个并说明不合规的 1 个',
        /已加入 2 个账号/.test(batchNotice) && /长度不合规/.test(batchNotice),
        batchNotice.split('\n').find((line) => line.includes('已加入')) || '')
  const freeNow = await freeUsers()
  check('两个名字都写进服务端白名单',
        freeNow.includes(batchNames[0]) && freeNow.includes(batchNames[1]), freeNow)
  check('不合规的名字没写进去', !freeNow.split(',').includes('xy'), '')
  check('「名单里还没注册的名字」里能看到它们',
        /名单里还没注册的名字/.test(batchNotice) && batchNotice.includes(batchNames[0]), '')

  console.log('\n2c. 预登记的名字注册后自动免费')
  await fetch(API + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: batchNames[0], password: 'Test123456' }),
  })
  const batchToken = (await (await fetch(API + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: batchNames[0], password: 'Test123456' }),
  })).json()).token
  const batchProfile = (await (await fetch(API + '/api/profile', {
    headers: { Authorization: 'Bearer ' + batchToken },
  })).json()).profile
  check('新注册的账号自动就是免费账号',
        batchProfile.billable === false && /白名单/.test(batchProfile.free_reason), batchProfile.free_reason)

  console.log('\n3. 余额不为 0 时删除被禁用')
  await page.locator('tr', { hasText: PAID }).first().getByRole('button', { name: '调整余额' }).click()
  await page.waitForTimeout(700)
  await page.locator('#balance-delta').fill('3')
  await page.locator('.fixed.inset-0.z-50').last().getByRole('button', { name: '确认调整' }).click()
  await page.waitForTimeout(1800)
  // 删除只有 root 能做：先退出当前登录，再以 root 登入（已登录时 /login 会直接跳走）
  await page.getByRole('button', { name: /退出/ }).click()
  await page.waitForTimeout(1400)
  await loginAs('roottest', 'Test123456')
  await page.goto(ORIGIN + '/users', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1800)
  const rootRow = page.locator('tr', { hasText: PAID }).first()
  check('扣费后的余额显示为 3.00 元', /3\.00 元/.test(await rootRow.innerText()), (await rootRow.innerText()).replace(/\n/g, ' | ').slice(0, 60))
  check('余额不为 0 → 「删除」按钮禁用', await rootRow.getByRole('button', { name: '删除' }).isDisabled(), '')

  console.log('\n4. 扣到 0 后可以删除')
  await rootRow.getByRole('button', { name: '调整余额' }).click()
  await page.waitForTimeout(700)
  await page.locator('#balance-delta').fill('-3')
  await page.locator('.fixed.inset-0.z-50').last().getByRole('button', { name: '确认调整' }).click()
  await page.waitForTimeout(1800)
  const rootRow2 = page.locator('tr', { hasText: PAID }).first()
  check('余额回到 0.00 元', /0\.00 元/.test(await rootRow2.innerText()), '')
  const delBtn = rootRow2.getByRole('button', { name: '删除' })
  check('root 的「删除」按钮可用', !(await delBtn.isDisabled()), '')
  await delBtn.click()
  await page.waitForTimeout(800)
  const confirm = page.locator('.fixed.inset-0.z-50').last()
  const confirmText = await confirm.innerText()
  check('确认弹窗说清后果（任务/流水保留、余额须为 0）', /余额必须为 0/.test(confirmText) && /流水会保留/.test(confirmText), confirmText.replace(/\n/g, ' | ').slice(0, 80))
  await page.screenshot({ path: `${SHOTS}/U2-users-delete-confirm.png`, fullPage: true })
  await confirm.getByRole('button', { name: '确认删除' }).click()
  await page.waitForTimeout(2000)
  check('删除后列表里没有该账号', (await page.locator('tr', { hasText: PAID }).count()) === 0, '')
  const users = (await (await fetch(API + '/api/users', { headers: AH })).json()).users
  check('服务端也删掉了', !users.some((u) => u.username === PAID), '')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
} finally {
  await browser.close()
  // 兜底清理
  const s = await (await fetch(API + '/api/settings', { headers: AH })).json()
  const drop = ['batchA' + tag, 'batchB' + tag, 'xy']
  const names = (s.settings.free_users || '').split(',').map((x) => x.trim()).filter((x) => x && x !== PAID && !drop.includes(x))
  await fetch(API + '/api/settings', {
    method: 'POST', headers: { ...AH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ free_users: names.join(',') }),
  })
  const users = (await (await fetch(API + '/api/users', { headers: AH })).json()).users
  const row = users.find((u) => u.username === PAID)
  if (row) {
    await fetch(`${API}/api/users/${row.id}/balance`, {
      method: 'POST', headers: { ...AH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta: String(-Number(row.balance || 0)), note: '测试收尾' }),
    })
    const root = (await (await fetch(API + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'roottest', password: 'Test123456' }),
    })).json()).token
    await fetch(`${API}/api/users/${row.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + root } })
  }
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 用户账号操作中心：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`截图目录：${SHOTS}`)
process.exit(fail.length || jsErrors.length ? 1 : 0)
