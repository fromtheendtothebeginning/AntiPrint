// AntiPrint 前端 UI 端到端测试（临时脚本，不属于交付代码）
// 复用 index 项目已装的 playwright-core + 本机 chromium，避免给项目加测试依赖。
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test.mjs
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
function check(name, cond, extra = '') {
  ;(cond ? pass : fail).push(name)
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + (extra ? '  ' + extra : ''))
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log('  [页面 JS 错误] ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [控制台错误] ' + m.text())
})

try {
  console.log('\n1. 打开首页并重定向到登录页')
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  check('首页可访问且跳转到 /login', page.url().includes('/login'), page.url())
  await shot(page, '01-login')

  console.log('\n2. 管理员登录')
  await page.getByLabel(/用户名|账号/).first().fill('admin').catch(async () => {
    await page.locator('input').first().fill('admin')
  })
  await page.locator('input[type=password]').first().fill('admin123')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2500)
  check('登录后进入管理页', page.url().includes('/admin'), page.url())
  await shot(page, '02-admin')

  const adminText = await page.locator('body').innerText()
  check('管理页显示代理在线状态', /代理/.test(adminText) && /(在线|离线)/.test(adminText), '')
  check('管理页显示任务表格', /任务号|提交人|配送地址/.test(adminText), '')
  check('提交人列有用户名（非空）', /testuser\d+/.test(adminText), (adminText.match(/testuser\d+/) || [''])[0])
  check('状态徽章渲染中文状态', /(待审核|已通过|已打印|已驳回|打印失败)/.test(adminText), '')

  console.log('\n3. PDF 预览（同源鉴权 + iframe）')
  const previewBtn = page.getByRole('button', { name: /预览/ }).first()
  if (await previewBtn.count()) {
    await previewBtn.click()
    await page.waitForTimeout(2500)
    const iframeCount = await page.locator('iframe').count()
    check('预览弹窗出现 iframe/pdf 内容', iframeCount > 0, `iframe=${iframeCount}`)
    await shot(page, '03-preview')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
  } else {
    check('预览按钮存在', false, '未找到预览按钮')
  }

  console.log('\n4. 普通用户提交打印任务（两次：一次驳回、一次通过）')
  await page.getByRole('button', { name: /退出|登出/ }).first().click().catch(() => {})
  await page.waitForTimeout(800)
  await page.goto(BASE + '/register', { waitUntil: 'networkidle' }).catch(() => {})
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const uname = 'ui' + Date.now().toString().slice(-8)
  // 切到注册 Tab
  const regTab = page.getByText(/注册/).first()
  if (await regTab.count()) {
    await regTab.click()
    await page.waitForTimeout(400)
  }
  const inputs = page.locator('input')
  await inputs.nth(0).fill(uname)
  await inputs.nth(1).fill('Test123456')
  if ((await inputs.count()) > 2) await inputs.nth(2).fill('Test123456')
  await page.getByRole('button', { name: /^注册|注册并登录|注\s*册/ }).last().click()
  await page.waitForTimeout(2500)
  check('注册后进入提交页或已登录', page.url().includes('/submit') || page.url().includes('/admin'), page.url())

  for (const addr of ['上海市徐汇区测试路 1 号（UI 测试 A）', '上海市徐汇区测试路 2 号（UI 测试 B）']) {
    await page.goto(BASE + '/submit', { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    const fileInput = page.locator('input[type=file]').first()
    await fileInput.setInputFiles(PDF)
    await page.waitForTimeout(500)
    const addrInput = page.locator('input[type=text], textarea').first()
    await addrInput.fill(addr)
    await shot(page, '04-submit-form')
    await page.getByRole('button', { name: /提交/ }).first().click()
    await page.waitForTimeout(2200)
    const t = await page.locator('body').innerText()
    check(`UI 提交成功（${addr.slice(-8)}）`, /(提交成功|待审核|任务号|#\d+)/.test(t), '')
  }
  await shot(page, '05-submit-done')

  console.log('\n5. 管理页审核：驳回必填理由 + 同意')
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' })
  await page.locator('input').first().fill('admin')
  await page.locator('input[type=password]').first().fill('admin123')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2500)
  await page.goto(BASE + '/admin', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await shot(page, '06-admin-with-pending')

  const rejectBtn = page.getByRole('button', { name: /驳回/ }).first()
  if (await rejectBtn.count()) {
    await rejectBtn.click()
    await page.waitForTimeout(700)
    const modalText = await page.locator('body').innerText()
    check('驳回弹窗出现', /驳回|理由/.test(modalText), '')
    await shot(page, '07-reject-modal')
    const confirmBtn = page.getByRole('button', { name: /确定|确认|提交|驳回/ }).last()
    const disabled = await confirmBtn.isDisabled().catch(() => null)
    check('理由为空时确认按钮禁用', disabled === true, `disabled=${disabled}`)
    const reasonBox = page.locator('.modal textarea, .modal input[type=text], textarea').first()
    await reasonBox.fill('测试驳回：打印内容不清晰，请重新上传')
    await page.waitForTimeout(300)
    const confirm2 = page.getByRole('button', { name: /确定|确认|提交|驳回/ }).last()
    const disabled2 = await confirm2.isDisabled().catch(() => null)
    check('填写理由后确认按钮可用', disabled2 === false, `disabled=${disabled2}`)
    await confirm2.click()
    await page.waitForTimeout(2000)
    const afterReject = await page.locator('body').innerText()
    check('驳回后列表出现「已驳回」与理由', /已驳回/.test(afterReject) && /不清晰/.test(afterReject), '')
  } else {
    check('驳回按钮存在', false, '未找到驳回按钮')
  }

  const approveBtn = page.getByRole('button', { name: /同意|通过/ }).first()
  if (await approveBtn.count()) {
    await approveBtn.click()
    await page.waitForTimeout(2000)
    const afterApprove = await page.locator('body').innerText()
    check('同意后出现「已通过」', /已通过/.test(afterApprove), '')
  } else {
    check('同意按钮存在', false, '未找到同意按钮')
  }
  await shot(page, '08-after-review')

  console.log('\n6. 我的任务页（用户视角）')
  await page.goto(BASE + '/mine', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const mineText = await page.locator('body').innerText()
  check('我的任务页可访问且列出任务', /我的任务|配送地址|已驳回|已通过|待审核/.test(mineText), '')
  check('驳回理由对提交人可见', /不清晰|理由/.test(mineText), '')
  await shot(page, '09-mine')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error')
} finally {
  await browser.close()
}

console.log(`\n===== UI 结果：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
if (fail.length) {
  console.log('失败项：')
  fail.forEach((f) => console.log('  - ' + f))
}
console.log('截图目录：' + SHOTS)
process.exit(fail.length ? 1 : 0)
