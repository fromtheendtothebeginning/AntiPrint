// UI 验收：手机端「点任务 → 底部详情抽屉 + 底部操作按钮」
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test21.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { adminTokenCached } from './lib/admin-token.mjs'

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

/** 轮询等某个元素进入指定的 CSS 动画（退场动画只播 ~200ms，直接断言会踩空） */
async function waitForAnimation(page, selector, expect, ms = 1500) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const name = await page.evaluate((sel) => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el).animationName : ''
    }, selector)
    if (name === expect) return name
    await page.waitForTimeout(25)
  }
  return ''
}

const tag = String(Date.now()).slice(-6)
const UNAME = 'sheet' + tag
const UT = (await (await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})).json()).token
const AH = { Authorization: 'Bearer ' + (await (await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json()).token }

// 计费：新账号余额为 0，管理员先充 100 元（否则提交会被 402 拦住）
const me = await (await fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + UT } })).json()
await fetch(`${API}/api/users/${me.id}/balance`, {
  method: 'POST', headers: { ...AH, 'Content-Type': 'application/json' }, body: JSON.stringify({ delta: '100' }),
})

// 造一条带完整信息的任务（地址 + 备注 + 设置），供抽屉展示断言
const body = new FormData()
body.append('address', '三教 305 讲台旁，门口找张老师')
body.append('delivery_mode', '配送')
body.append('note', '抽屉验收备注')
body.append('settings', JSON.stringify([{ copies: 2, paper: 'A3', nup: '2,2', scale: 'fit', pages: '1-2' }]))
body.append('files', new Blob([fs.readFileSync(PDF)], { type: 'application/pdf' }), 'test-print.pdf')
const job = (await (await fetch(API + '/api/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + UT }, body })).json()).job

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))

async function login(target) {
  await target.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await target.waitForTimeout(600)
  await target.getByLabel('用户名').fill('admin')
  await target.getByLabel('密码').fill('admin123')
  await target.getByRole('button', { name: /登\s*录/ }).first().click()
  await target.waitForTimeout(2400)
}

try {
  await login(page)
  await page.goto(ORIGIN + '/queue', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1600)

  console.log('\n1. 点任务行 → 底部弹详情抽屉')
  const row = page.locator('tr', { hasText: '#' + job.id }).first()
  check('详情抽屉默认不显示', !/提交时间/.test(await page.locator('body').innerText()), '')
  await row.click()
  await page.waitForTimeout(800)
  const sheet = page.locator('div.fixed.inset-0.z-50').last()
  const sheetText = await sheet.innerText()
  check('抽屉打开并显示任务号与状态', new RegExp('#' + job.id).test(sheetText) && /待审核/.test(sheetText),
        sheetText.split('\n').slice(0, 3).join(' | '))
  check('显示提交人', sheetText.includes(UNAME), '')
  check('显示提交时间（日期 + 时分）', /提交时间 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.test(sheetText), '')
  check('显示配送方式与完整地址', sheetText.includes('配送') && sheetText.includes('三教 305 讲台旁，门口找张老师'), '')
  check('显示备注', sheetText.includes('抽屉验收备注'), '')
  check('显示文件与设置（2 份 / A3）',
        sheetText.includes('test-print.pdf') && /2 份/.test(sheetText) && sheetText.includes('A3'), '')

  console.log('\n2. 操作按钮在屏幕下方的拇指区、且够大')
  const viewport = page.viewportSize()
  const approve = sheet.getByRole('button', { name: '同意' })
  const approveBox = await approve.boundingBox()
  check(`「同意」位于屏幕下半部（y=${Math.round(approveBox.y)}）`, approveBox.y > viewport.height / 2, '')
  check(`按钮够高（${Math.round(approveBox.height)}px ≥ 44）`, approveBox.height >= 44, '')
  const delBox = await sheet.getByRole('button', { name: '删除' }).boundingBox()
  check('「删除」与「同意」在同一底部操作区', Math.abs(delBox.y - approveBox.y) < 60, `y=${Math.round(delBox.y)}`)
  // 弹出动画：抽屉面板从下沿滑入、遮罩淡入（Modal 弹窗是 pop-in）
  const anim = await page.evaluate(() => {
    const sheetPanel = document.querySelector('div.absolute.inset-x-0.bottom-0')
    const backdrop = document.querySelector('div.fixed.inset-0.z-50 > div.absolute.inset-0')
    return {
      sheet: sheetPanel ? getComputedStyle(sheetPanel).animationName : '',
      sheetDur: sheetPanel ? getComputedStyle(sheetPanel).animationDuration : '',
      backdrop: backdrop ? getComputedStyle(backdrop).animationName : '',
    }
  })
  check(`抽屉面板有滑入动画（${anim.sheet} ${anim.sheetDur}）`, anim.sheet === 'sheet-up', JSON.stringify(anim))
  check('抽屉遮罩有淡入动画', anim.backdrop === 'fade-in', anim.backdrop)

  const panel = await sheet.locator('div.absolute.inset-x-0.bottom-0').boundingBox()
  check(`抽屉贴着屏幕下沿（底边距屏幕底 ${Math.round(viewport.height - (panel.y + panel.height))}px）`,
        viewport.height - (panel.y + panel.height) <= 2, '')
  await page.screenshot({ path: `${SHOTS}/S1-task-sheet.png`, fullPage: false })

  console.log('\n3. 抽屉里操作生效并自动关闭')
  await approve.click()
  // 退场动画只播 ~230ms：点完立刻抓，抓完再等接口与刷新
  const closingAnim = await waitForAnimation(page, 'div.absolute.inset-x-0.bottom-0', 'sheet-down')
  await page.waitForTimeout(2400)
  const after = await (await fetch(`${API}/api/jobs/${job.id}`, { headers: AH })).json()
  check('点「同意」后任务变已通过', after.job.status === '已通过', after.job.status)
  check(`收起时有下滑动画（sheet-down）`, closingAnim === 'sheet-down', closingAnim || '(没抓到)')
  await page.waitForTimeout(400)
  check('动画播完抽屉卸载', (await page.locator('div.absolute.inset-x-0.bottom-0').count()) === 0, '')

  console.log('\n4. 抽屉里删除仍走二次确认')
  await row.click()
  await page.waitForTimeout(800)
  const sheet2 = page.locator('div.fixed.inset-0.z-50').last()
  check('已通过状态不再显示「同意」', (await sheet2.getByRole('button', { name: '同意' }).count()) === 0, '')
  await sheet2.getByRole('button', { name: '删除' }).click()
  await page.waitForTimeout(900)
  const confirm = page.locator('.fixed.inset-0.z-50').last()
  check('「删除」打开二次确认弹窗（盖在抽屉之上）', /确认删除/.test(await confirm.innerText()), '')
  const modalAnim = await page.evaluate(() => {
    const panel2 = document.querySelector('div[role="dialog"]')
    const mask = panel2?.parentElement
    return {
      panel: panel2 ? getComputedStyle(panel2).animationName : '',
      mask: mask ? getComputedStyle(mask).animationName : '',
    }
  })
  check('弹窗面板有弹出动画（pop-in）', modalAnim.panel === 'pop-in', JSON.stringify(modalAnim))
  check('弹窗遮罩有淡入动画（fade-in）', modalAnim.mask === 'fade-in', '')
  await confirm.locator('.mt-6').getByRole('button', { name: '取消' }).click()
  const modalClosing = await waitForAnimation(page, 'div[role="dialog"]', 'pop-out')
  check('弹窗收起时也有动画（pop-out）', modalClosing === 'pop-out', modalClosing || '(没抓到)')
  await page.waitForTimeout(400)
  await ctx.close()

  console.log('\n5. 桌面端不受影响（点行不弹抽屉，操作仍在行内）')
  const desktop = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
  desktop.on('pageerror', (e) => jsErrors.push('桌面端：' + e.message))
  await login(desktop)
  await desktop.goto(ORIGIN + '/queue', { waitUntil: 'networkidle' })
  await desktop.waitForTimeout(1600)
  const dRow = desktop.locator('tr', { hasText: '#' + job.id }).first()
  // 该任务在步骤 3 已被同意（已通过状态只剩「删除」），用删除验证桌面端内联操作还在
  check('桌面端行内有内联操作按钮（删除）', await dRow.getByRole('button', { name: '删除' }).isVisible(), '')
  check('桌面端不显示「详情」按钮', (await dRow.getByRole('button', { name: /查看任务详情与操作/ }).count()) === 0, '')
  await dRow.click()
  await desktop.waitForTimeout(700)
  check('桌面端点行不弹抽屉', !/提交时间/.test(await desktop.locator('body').innerText()), '')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
} finally {
  await browser.close()
}

// 清理
for (const j of (await (await fetch(API + '/api/jobs', { headers: AH })).json()).jobs.filter((j) => j.username === UNAME)) {
  await fetch(`${API}/api/jobs/${j.id}`, { method: 'DELETE', headers: AH })
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 手机端任务详情抽屉：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`截图目录：${SHOTS}`)
process.exit(fail.length || jsErrors.length ? 1 : 0)
