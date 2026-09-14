// AntiPrint 前端 UI 端到端测试 v2（临时脚本，不属于交付代码）
// 修正 v1 的选择器错误（配送地址输入框无 type 属性，v1 误填进了备注 textarea）。
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test2.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:3010'
const CHROME = 'C:/Users/86133/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const SHOTS = 'D:/anticraft/AntiPrint/.tmp-test/shots'
const PDF = 'D:/anticraft/AntiPrint/.tmp-test/test-print.pdf'
fs.mkdirSync(SHOTS, { recursive: true })

const pass = []
const fail = []
const check = (name, cond, extra = '') => {
  ;(cond ? pass : fail).push(name)
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + (extra ? '  ' + extra : ''))
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
const http404 = []

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('  [页面 JS 错误] ' + e.message))
  page.on('response', (r) => {
    if (r.status() >= 400) http404.push(`${r.status()} ${r.url()}`)
  })
  return page
}

const addrA = '三教 305 教室靠窗第一排（UI 测试-同意）'
const addrB = '5 号宿舍楼 402（UI 测试-驳回）'
let uname = ''

try {
  // ── 用户侧：注册 → 提交两次 ──
  console.log('\n1. 用户注册并提交打印任务')
  const userPage = await newPage()
  await userPage.goto(BASE + '/', { waitUntil: 'networkidle' })
  await userPage.waitForTimeout(700)
  check('首页重定向到登录页', userPage.url().includes('/login'), userPage.url())
  await shot(userPage, '10-login')

  uname = 'ui' + Date.now().toString().slice(-8)
  await userPage.getByText('注册', { exact: false }).first().click()
  await userPage.waitForTimeout(400)
  const regInputs = userPage.locator('.card input')
  await regInputs.nth(0).fill(uname)
  await regInputs.nth(1).fill('Test123456')
  if ((await regInputs.count()) > 2) await regInputs.nth(2).fill('Test123456')
  await userPage.getByRole('button', { name: '注册并登录' }).click().catch(async () => {
    await userPage.getByRole('button', { name: /注\s*册/ }).last().click()
  })
  await userPage.waitForTimeout(2500)
  check('注册后进入提交页', userPage.url().includes('/submit'), userPage.url())

  for (const addr of [addrA, addrB]) {
    await userPage.locator('input[type=file]').first().setInputFiles(PDF)
    await userPage.waitForTimeout(400)
    await userPage.locator('input[name=address]').fill(addr)
    await userPage.locator('#submit-note').fill('UI 自动化测试，请忽略')
    await shot(userPage, '11-submit-form')
    await userPage.getByRole('button', { name: '提交打印任务' }).click()
    await userPage.waitForTimeout(2200)
    const t = await userPage.locator('body').innerText()
    check(`提交成功卡片出现（${addr.slice(0, 6)}…）`, /提交成功/.test(t) && /待审核/.test(t), '')
    await shot(userPage, '12-submit-success')
    const again = userPage.getByRole('button', { name: '再提交一单' })
    if (await again.count()) await again.click()
    await userPage.waitForTimeout(600)
  }

  await userPage.goto(BASE + '/mine', { waitUntil: 'networkidle' })
  await userPage.waitForTimeout(1500)
  const mineText = await userPage.locator('body').innerText()
  check('我的任务列出两次提交', (mineText.match(/待审核/g) || []).length >= 2, `待审核出现 ${(mineText.match(/待审核/g) || []).length} 次`)
  await shot(userPage, '13-mine-pending')

  // ── 管理侧：同意 A、驳回 B ──
  console.log('\n2. 管理员审核（同意 / 驳回必填理由）')
  const adminPage = await newPage()
  await adminPage.goto(BASE + '/login', { waitUntil: 'networkidle' })
  await adminPage.locator('.card input').first().fill('admin')
  await adminPage.locator('input[type=password]').first().fill('admin123')
  await adminPage.getByRole('button', { name: /登\s*录/ }).first().click()
  await adminPage.waitForTimeout(2500)
  check('管理员登录进入管理页', adminPage.url().includes('/admin'), adminPage.url())

  const adminText0 = await adminPage.locator('body').innerText()
  check('管理页显示代理在线', /在线/.test(adminText0) && !/代理离线/.test(adminText0), '')
  check('提交人列显示新用户名', adminText0.includes(uname), uname)
  await shot(adminPage, '14-admin-queue')

  const rowA = adminPage.locator('tr', { hasText: 'UI 测试-同意' }).first()
  check('找到待同意的任务行', (await rowA.count()) > 0, '')
  await rowA.getByRole('button', { name: '同意' }).click()
  await adminPage.waitForTimeout(2200)
  check('同意后状态变已通过', /已通过/.test(await rowA.innerText().catch(() => '')), '')

  const rowB = adminPage.locator('tr', { hasText: 'UI 测试-驳回' }).first()
  await rowB.getByRole('button', { name: '驳回' }).click()
  await adminPage.waitForTimeout(800)
  await shot(adminPage, '15-reject-modal')
  const emptyDisabled = await adminPage.getByRole('button', { name: '确认驳回' }).isDisabled()
  check('驳回理由为空时按钮禁用', emptyDisabled === true, `disabled=${emptyDisabled}`)
  await adminPage.locator('.modal textarea').first().fill('内容是乱码，请重新上传清晰文件')
  await adminPage.waitForTimeout(400)
  const filledDisabled = await adminPage.getByRole('button', { name: '确认驳回' }).isDisabled()
  check('填写理由后按钮可用', filledDisabled === false, `disabled=${filledDisabled}`)
  await adminPage.getByRole('button', { name: '确认驳回' }).click()
  await adminPage.waitForTimeout(2200)
  const adminText1 = await adminPage.locator('body').innerText()
  check('驳回后出现「已驳回」与理由', /已驳回/.test(adminText1) && /乱码/.test(adminText1), '')
  await shot(adminPage, '16-admin-after-review')

  // ── 用户侧复查驳回理由 ──
  await userPage.goto(BASE + '/mine', { waitUntil: 'networkidle' })
  await userPage.waitForTimeout(1600)
  const mineText2 = await userPage.locator('body').innerText()
  check('提交人可见驳回理由与重提入口', /乱码/.test(mineText2) && /重新提交|修改/.test(mineText2), '')
  await shot(userPage, '17-mine-rejected')

  // ── 预览 ──
  console.log('\n3. 管理端文件预览')
  await adminPage.getByRole('button', { name: '预览' }).first().click()
  await adminPage.waitForTimeout(2500)
  check('预览弹窗渲染 iframe（PDF）', (await adminPage.locator('iframe').count()) > 0, '')
  await shot(adminPage, '18-preview')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
} finally {
  await browser.close()
}

const realProblems = http404.filter((u) => !/favicon/.test(u))
console.log('\nHTTP 4xx/5xx：')
;(http404.length ? http404 : ['  无']).slice(0, 12).forEach((u) => console.log('  ' + u))
console.log(`\n===== UI v2 结果：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
if (fail.length) {
  console.log('失败项：')
  fail.forEach((f) => console.log('  - ' + f))
}
if (realProblems.length) console.log(`注意：存在 ${realProblems.length} 个非 favicon 的 4xx/5xx 请求`)
console.log('截图目录：' + SHOTS)
process.exit(fail.length ? 1 : 0)
