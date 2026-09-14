// AntiPrint 换肤验收（临时脚本）：
// 1) 功能回归：注册 → 提交任务 → 我的任务 → 管理员登录/驳回弹窗/预览 → 退出
// 2) 逐页截图（浅色 + 深色），供人工确认暖色仪表盘风格是否落地
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test6.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const ORIGIN = 'http://127.0.0.1:8301'
const API = ORIGIN
const CHROME = 'C:/Users/86133/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const PDF = 'D:/anticraft/AntiPrint/.tmp-test/test-print.pdf'
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

const tag = String(Date.now()).slice(-6)
const USERNAME = 'style' + tag
const ADDRESS = '三教 305 教室靠窗第一排（换肤验收）'

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
const page = await ctx.newPage()
const jsErrors = []
const httpErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))
page.on('response', (r) => {
  if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`)
})

/** 切主题：写 localStorage 后重载（ThemeToggle 是循环三态，测试里直接置值更稳） */
async function setTheme(value) {
  await page.evaluate((v) => localStorage.setItem('theme', v), value)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
}

try {
  console.log('\n1. 登录页（浅色 / 深色）')
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const loginText = await page.locator('body').innerText()
  check('登录页渲染三个 Tab', /登录/.test(loginText) && /注册/.test(loginText) && /anticraft 登录/.test(loginText), '')
  check('登录页出现品牌名', /AntiPrint/.test(loginText), '')
  await shot(page, '50-login-light')
  await setTheme('dark')
  await shot(page, '51-login-dark')
  await setTheme('light')

  console.log('\n2. 注册并提交打印任务')
  await page.getByText('注册', { exact: true }).first().click()
  await page.waitForTimeout(400)
  await page.getByLabel('用户名').fill(USERNAME)
  await page.getByLabel('密码').fill('Test123456')
  await page.getByRole('button', { name: /注册并登录|注\s*册/ }).last().click()
  await page.waitForTimeout(2500)
  check('注册后进入提交页', page.url().includes('/submit'), page.url())
  await shot(page, '52-submit-light')

  await page.locator('input[type=file]').first().setInputFiles(PDF)
  await page.waitForTimeout(400)
  await page.locator('input[name=address]').fill(ADDRESS)
  await page.locator('#submit-note').fill('换肤验收用，可忽略')
  await page.getByRole('button', { name: '提交打印任务' }).click()
  await page.waitForTimeout(2000)
  const okText = await page.locator('body').innerText()
  check('提交成功卡片出现（含任务号与「待审核」）', /提交成功/.test(okText) && /待审核/.test(okText), '')
  await shot(page, '53-submit-success')

  console.log('\n3. 我的任务')
  await page.getByRole('link', { name: /我的任务/ }).first().click()
  await page.waitForTimeout(1500)
  const mineText = await page.locator('body').innerText()
  check('我的任务列出任务与状态徽章', /待审核/.test(mineText) && mineText.includes(ADDRESS.slice(0, 6)), '')
  await shot(page, '54-mine-light')
  await setTheme('dark')
  await shot(page, '55-mine-dark')
  await setTheme('light')

  console.log('\n4. 管理后台（需要管理员）')
  await page.getByRole('button', { name: /退出/ }).click()
  await page.waitForTimeout(1200)
  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码').fill('admin123')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2500)
  check('管理员进入 /admin', page.url().includes('/admin'), page.url())
  const adminText = await page.locator('body').innerText()
  check('代理状态与队列渲染', /打印代理(在线|离线)/.test(adminText) && /任务队列/.test(adminText), '')
  check('表格列头齐全', /任务号/.test(adminText) && /提交人/.test(adminText) && /配送地址/.test(adminText), '')
  check('提交人显示为本次注册用户', adminText.includes(USERNAME), USERNAME)
  check('操作按钮齐全', /预览/.test(adminText) && /同意/.test(adminText) && /驳回/.test(adminText), '')
  check('打印设置区（含 anticraft 三项）', /anticraft 服务地址/.test(adminText) && /允许的授权来源/.test(adminText) && /保存设置/.test(adminText), '')
  await shot(page, '56-admin-light')
  await setTheme('dark')
  await shot(page, '57-admin-dark')
  await setTheme('light')

  console.log('\n5. 驳回弹窗（理由为空禁用 → 填写后可用）')
  const row = page.locator('tr', { hasText: USERNAME }).first()
  await row.getByRole('button', { name: '驳回' }).click()
  await page.waitForTimeout(800)
  const confirm = page.getByRole('button', { name: '确认驳回' })
  check('驳回理由为空时按钮禁用', (await confirm.isDisabled()) === true, '')
  await shot(page, '58-reject-modal')
  await page.locator('#reject-reason').fill('换肤验收：测试驳回理由')
  await page.waitForTimeout(300)
  check('填写理由后按钮可用', (await confirm.isDisabled()) === false, '')
  await confirm.click()
  await page.waitForTimeout(2000)
  const afterReject = await page.locator('body').innerText()
  check('列表出现「已驳回」与理由', /已驳回/.test(afterReject) && /测试驳回理由/.test(afterReject), '')

  console.log('\n6. PDF 预览弹窗')
  await page.getByRole('button', { name: '预览' }).first().click()
  await page.waitForTimeout(2500)
  check('预览弹窗渲染 iframe', (await page.locator('iframe').count()) > 0, '')
  await shot(page, '59-preview-modal')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  console.log('\n7. 登录页（未配置绑定应用时的提示条）')
  await page.getByRole('button', { name: /退出/ }).click()
  await page.waitForTimeout(1200)
  await page.getByText('anticraft 登录', { exact: false }).first().click()
  await page.waitForTimeout(900)
  const acText = await page.locator('body').innerText()
  check('anticraft Tab 显示跳转授权按钮', /跳转授权/.test(acText), '')
  // 断言跟着实际配置走：配了就不该显示登记引导，没配才显示（避免脚本假设过期）
  const acStatus = await (await fetch(API + '/api/oauth/anticraft/status')).json()
  check(
    acStatus.enabled ? '已配置绑定应用：不再显示登记引导' : '未配置：显示登记引导',
    acStatus.enabled ? !/尚未配置/.test(acText) : /登记/.test(acText),
    `enabled=${acStatus.enabled}`,
  )
  await shot(page, '60-anticraft-tab')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error6')
} finally {
  await browser.close()
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
const realHttp = httpErrors.filter((u) => !/favicon/.test(u))
console.log('=== HTTP 4xx/5xx ===')
console.log(realHttp.length ? realHttp.slice(0, 8).join('\n') : '  无')

// 清理：删掉本次注册用户的任务与账号，设置改回真实地址
await fetch(API + '/api/settings', {
  method: 'POST', headers: { ...AH, 'Content-Type': 'application/json' },
  body: JSON.stringify({ anticraft_base: 'https://anticraft.top' }),
})
console.log('\n提示：测试账号 ' + USERNAME + ' 及其任务需在收尾脚本里清理')

console.log(`\n===== 换肤验收：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log('截图目录：' + SHOTS)
process.exit(fail.length || jsErrors.length ? 1 : 0)
