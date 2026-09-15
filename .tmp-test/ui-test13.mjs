// UI 验收：两步提交 + 逐文件打印设置 + 按设置预览（新流程）
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test13.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const ORIGIN = 'http://127.0.0.1:8301'
const API = ORIGIN
const PDF = 'D:/anticraft/AntiPrint/.tmp-test/test-print.pdf'
const PNG = 'D:/anticraft/AntiPrint/.tmp-test/test-image.png'
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
const UNAME = 'wiz' + tag
const reg = await (await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})).json()
const UT = reg.token

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))

try {
  console.log('\n1. 第一步：选文件 → 逐文件设置 → 按设置预览')
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.getByLabel('用户名').fill(UNAME)
  await page.getByLabel('密码').fill('Test123456')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2300)

  const step1Text = await page.locator('body').innerText()
  check('第一步是「打印文件与设置」且看不到配送地址', /打印文件/.test(step1Text) && !/配送地址/.test(step1Text), '')
  check('第二步入口按钮存在（无文件时禁用）',
        (await page.getByRole('button', { name: '下一步：填写配送信息' }).isDisabled()) === true, '')

  await page.locator('input[type=file]').first().setInputFiles([PDF, PNG])
  await page.waitForTimeout(1400)
  const listText = await page.locator('body').innerText()
  check('文件列表出现两个文件行', /test-print\.pdf/.test(listText) && /test-image\.png/.test(listText), '')
  check('默认预览该 PDF（iframe 带 #page=1）',
        /#page=1/.test((await page.locator('#file-preview iframe').getAttribute('src')) ?? ''), '')
  check('预览说明行含文件名与设置摘要', /预览：test-print\.pdf/.test(listText) && /A4/.test(listText), '')
  await shot(page, 'A1-step1-default')

  console.log('\n2. 给第一个文件改设置：份数/纸张/页面范围/每张页数 → 预览随之变化')
  await page.locator('#file-settings-copies').fill('2')
  await page.selectOption('#file-settings-paper', 'A3')
  await page.locator('#file-settings-pages').fill('2-3')
  await page.selectOption('#file-settings-nup', '2,2')
  await page.waitForTimeout(900)
  const src2 = (await page.locator('#file-preview iframe').getAttribute('src')) ?? ''
  check('页面范围生效：预览跳到第 2 页', /#page=2/.test(src2), src2.slice(-24))
  const step1b = await page.locator('body').innerText()
  check('提示按 N 页/张排版（预览为单页视图）', /打印时按 4 页\/张排版/.test(step1b), '')
  check('设置摘要里出现「2 份」与「A3」', /2 份/.test(step1b) && /A3/.test(step1b), '')
  await shot(page, 'A2-step1-settings-applied')

  console.log('\n3. 切到第二个文件：用的是它自己的设置，预览变成图片')
  await page.getByRole('button', { name: /选中文件 test-image\.png/ }).click()
  await page.waitForTimeout(900)
  check('切换后份数回到该文件的默认 1', (await page.locator('#file-settings-copies').inputValue()) === '1', '')
  check('切换后纸张回到该文件的默认 A4', (await page.locator('#file-settings-paper').inputValue()) === 'A4', '')
  check('预览切换为图片（img 出现、iframe 消失）',
        (await page.locator('#file-preview img').count()) > 0 && (await page.locator('#file-preview iframe').count()) === 0, '')
  // 再切回 PDF，设置应保留
  await page.getByRole('button', { name: /选中文件 test-print\.pdf/ }).click()
  await page.waitForTimeout(800)
  check('切回 PDF 后设置仍保留（2 份 / A3 / 2-3）',
        (await page.locator('#file-settings-copies').inputValue()) === '2' && (await page.locator('#file-settings-paper').inputValue()) === 'A3'
        && (await page.locator('#file-settings-pages').inputValue()) === '2-3', '')

  console.log('\n4. 第二步：配送方式与备注（可来回切换且不丢状态）')
  await page.getByRole('button', { name: '下一步：填写配送信息' }).click()
  await page.waitForTimeout(900)
  const step2Text = await page.locator('body').innerText()
  check('进入第二步（出现配送地址输入）', (await page.locator('input[name=address]').count()) > 0, '')
  check('第二步汇总「已选 2 个文件」', /已选 2 个文件/.test(step2Text), '')
  check('第一步的设置区已隐藏', (await page.locator('#file-settings-copies').count()) === 0, '')
  await page.getByRole('button', { name: '返回修改打印设置' }).click()
  await page.waitForTimeout(800)
  check('返回第一步后设置仍在', (await page.locator('#file-settings-copies').inputValue()) === '2', '')
  await page.getByRole('button', { name: '下一步：填写配送信息' }).click()
  await page.waitForTimeout(800)
  await page.locator('input[name=address]').fill('两步提交验收（可删除）')
  await page.locator('#submit-note').fill('逐文件设置')
  await shot(page, 'A3-step2')
  await page.getByRole('button', { name: '提交打印任务' }).click()
  await page.waitForTimeout(2600)

  const okText = await page.locator('body').innerText()
  check('提交成功卡片出现', /提交成功/.test(okText), '')
  check('成功卡片逐文件列出设置', /test-print\.pdf：/.test(okText) && /2 份/.test(okText) && /A3/.test(okText), '')
  await shot(page, 'A4-success')

  console.log('\n5. 后端确实按文件存了两套设置')
  const jobs = (await (await fetch(API + '/api/jobs/mine', { headers: { Authorization: 'Bearer ' + UT } })).json()).jobs
  const job = jobs[0]
  const files = job.files
  check('任务有 2 个文件且各自带 print_options', files.length === 2
        && files[0].print_options?.paper === 'A3' && files[0].print_options?.copies === 2 && files[0].print_options?.pages === '2-3'
        && files[0].print_options?.nup === '2,2' && files[1].print_options?.paper === 'A4',
        JSON.stringify(files.map((f) => f.print_options)))
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error13')
} finally {
  await browser.close()
}

// 清理
const adminToken = (await (await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json()).token
for (const j of (await (await fetch(API + '/api/jobs', { headers: { Authorization: 'Bearer ' + adminToken } })).json()).jobs.filter((j) => j.username === UNAME)) {
  await fetch(`${API}/api/jobs/${j.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + adminToken } })
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 两步提交 + 逐文件设置：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`（测试账号 ${UNAME} 的任务已清理）`)
console.log('截图目录：' + SHOTS)
process.exit(fail.length || jsErrors.length ? 1 : 0)
