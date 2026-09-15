// UI 验收：拖入文件后投放区变成预览面板（内嵌预览）+ 我的任务 / 队列预览
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test11.mjs
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
const UNAME = 'inline' + tag
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
  console.log('\n1. 拖入/选择文件后，投放区变成预览面板')
  await login(UNAME, 'Test123456')
  const form = page.locator('form')
  check('初始是虚线投放区', /点击选择文件，或将文件拖拽到这里/.test(await form.innerText()), '')
  await page.locator('input[type=file]').first().setInputFiles(PDF)
  await page.waitForTimeout(1200)
  const formText = await form.innerText()
  check('投放提示消失（已切换成预览面板）', !/点击选择文件，或将文件拖拽到这里/.test(formText), '')
  check('面板显示「正在预览」与文件名', /正在预览/.test(formText) && /test-print\.pdf/.test(formText), '')
  check('PDF 内嵌预览渲染 iframe', (await page.locator('form iframe').count()) > 0, '')
  check('面板提供继续添加 / 清空 / 放大查看', /继续添加/.test(formText) && /清空/.test(formText) && /放大查看/.test(formText), '')
  await shot(page, '94-inline-preview-pdf')

  console.log('\n2. 再拖入图片：点文件名切换预览（图 → img，PDF 的 iframe 让位）')
  await page.locator('input[type=file]').first().setInputFiles(PNG)
  await page.waitForTimeout(1000)
  // chips 里点图片文件名切预览
  await page.getByRole('button', { name: /预览 test-image\.png/ }).click()
  await page.waitForTimeout(900)
  const imgCount = await page.locator('form img').count()
  check('切到图片后渲染 img', imgCount > 0, `img=${imgCount}`)
  check('切到图片后 PDF 的 iframe 已移除', (await page.locator('form iframe').count()) === 0, '')
  check('面板提示已选 2 个文件', /已选 2 个文件/.test(await form.innerText()), '')
  await shot(page, '95-inline-preview-image')

  console.log('\n3. 「放大查看」走弹窗预览')
  await page.getByRole('button', { name: '放大查看' }).click()
  await page.waitForTimeout(1200)
  const modalText = await page.locator('body').innerText()
  check('弹窗标题带当前文件名', /预览：test-image\.png/.test(modalText), '')
  await shot(page, '96-inline-zoom-modal')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)

  console.log('\n4. 「清空」回到投放区')
  await page.getByRole('button', { name: '清空' }).click()
  await page.waitForTimeout(800)
  check('清空后回到虚线投放区', /点击选择文件，或将文件拖拽到这里/.test(await form.innerText()), '')

  console.log('\n5. 提交后「我的任务」预览与管理员队列预览仍可用')
  await page.locator('input[type=file]').first().setInputFiles(PDF)
  await page.waitForTimeout(800)
  await page.locator('input[name=address]').fill('内嵌预览验收（可删除）')
  await page.getByRole('button', { name: '提交打印任务' }).click()
  await page.waitForTimeout(2200)
  await nav(/我的任务/).click()
  await page.waitForTimeout(1600)
  await page.getByRole('button', { name: /预览.*test-print\.pdf/ }).first().click()
  await page.waitForTimeout(2000)
  check('我的任务弹窗预览渲染 iframe', (await page.locator('iframe').count()) > 0, '')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  await login('admin', 'admin123')
  await nav(/任务队列/).click()
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: /test-print\.pdf/ }).first().click()
  await page.waitForTimeout(2000)
  check('管理员队列预览渲染 iframe', (await page.locator('iframe').count()) > 0, '')
  await shot(page, '97-queue-preview')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error11')
} finally {
  await browser.close()
}

// 清理：删任务与测试账号
const adminToken = (await (await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json()).token
const jobs = (await (await fetch(API + '/api/jobs', { headers: { Authorization: 'Bearer ' + adminToken } })).json()).jobs
for (const job of jobs.filter((j) => j.username === UNAME)) {
  await fetch(`${API}/api/jobs/${job.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + adminToken } })
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 内嵌预览 UI：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`（测试账号 ${UNAME} 的任务已清理，账号由收尾脚本删除）`)
console.log('截图目录：' + SHOTS)
process.exit(fail.length || jsErrors.length ? 1 : 0)
