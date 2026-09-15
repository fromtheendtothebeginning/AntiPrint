// UI 验收：手机端适配（390×844 视口）——无横向溢出、侧栏变抽屉、全流程可用
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test14.mjs
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
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` })
/** 页面级横向溢出检测：文档宽 > 视口宽 即视为溢出（表格在容器内滚动不算） */
async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement
    return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth }
  })
}

const tag = String(Date.now()).slice(-6)
const UNAME = 'mob' + tag
await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
})
const page = await ctx.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))

async function login(username, password) {
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  if (!page.url().includes('/login')) {
    // 已登录时先退出（退出按钮在小屏顶栏可见）
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
  console.log('\n1. 登录页（手机）')
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  let m = await overflow(page)
  check('登录页无横向溢出', m.scrollWidth <= m.innerWidth + 1, `${m.scrollWidth} / ${m.innerWidth}`)
  await shot(page, 'M1-login')

  console.log('\n2. 登录后：侧栏默认收起（抽屉）')
  await login(UNAME, 'Test123456')
  await page.waitForTimeout(600)
  const asideBox = await page.locator('aside').boundingBox()
  check('小屏侧栏默认在屏幕外（抽屉收起）', !asideBox || asideBox.x < 0, asideBox ? `x=${Math.round(asideBox.x)}` : '不可见')
  m = await overflow(page)
  check('提交页（第一步）无横向溢出', m.scrollWidth <= m.innerWidth + 1, `${m.scrollWidth} / ${m.innerWidth}`)
  await shot(page, 'M2-submit-step1-empty')

  console.log('\n3. 手机端完整走一遍两步提交')
  await page.locator('input[type=file]').first().setInputFiles(PDF)
  await page.waitForTimeout(1200)
  const step1 = await page.locator('body').innerText()
  check('第一步显示文件与设置（手机竖排）', /打印文件/.test(step1) && /test-print\.pdf/.test(step1), '')
  check('手机端预览区高度已降为 300px',
        (await page.locator('#file-preview iframe').boundingBox())?.height <= 320, '')
  m = await overflow(page)
  check('第一步有内容时也无横向溢出', m.scrollWidth <= m.innerWidth + 1, `${m.scrollWidth} / ${m.innerWidth}`)
  await shot(page, 'M3-submit-step1-file')

  await page.getByRole('button', { name: '下一步：填写配送信息' }).click()
  await page.waitForTimeout(900)
  await page.locator('input[name=address]').fill('手机端适配验收（可删除）')
  m = await overflow(page)
  check('第二步无横向溢出', m.scrollWidth <= m.innerWidth + 1, `${m.scrollWidth} / ${m.innerWidth}`)
  await shot(page, 'M4-submit-step2')
  await page.getByRole('button', { name: '提交打印任务' }).click()
  await page.waitForTimeout(2400)
  check('手机端提交成功', /提交成功/.test(await page.locator('body').innerText()), '')
  await shot(page, 'M5-submit-success')

  console.log('\n4. 手机端打开侧栏抽屉并切页')
  await page.getByRole('button', { name: '折叠或展开侧栏' }).click()
  await page.waitForTimeout(700)
  const openBox = await page.locator('aside').boundingBox()
  check('点汉堡后侧栏滑出（x≈0）', !!openBox && Math.abs(openBox.x) < 2, openBox ? `x=${Math.round(openBox.x)}` : '不可见')
  await shot(page, 'M6-drawer-open')
  await page.locator('aside').getByRole('link', { name: /我的任务/ }).click()
  await page.waitForTimeout(1500)
  const closedBox = await page.locator('aside').boundingBox()
  check('点导航后抽屉自动收起', !closedBox || closedBox.x < 0, closedBox ? `x=${Math.round(closedBox.x)}` : '不可见')
  m = await overflow(page)
  check('我的任务无横向溢出', m.scrollWidth <= m.innerWidth + 1, `${m.scrollWidth} / ${m.innerWidth}`)
  await shot(page, 'M7-mine-cards')

  console.log('\n5. 管理员页（队列表格在小屏内横向滚动，不撑破页面）')
  await login('admin', 'admin123')
  await page.goto(ORIGIN + '/queue', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  m = await overflow(page)
  check('任务队列无页面级横向溢出', m.scrollWidth <= m.innerWidth + 1, `${m.scrollWidth} / ${m.innerWidth}`)
  const tbl = await page.locator('table').first().boundingBox()
  check('表格比屏幕宽（靠容器内滚动查看）', !!tbl && tbl.width > 390, tbl ? `${Math.round(tbl.width)}px` : '')
  check('小屏有「左右滑动」提示', /左右滑动查看完整表格/.test(await page.locator('body').innerText()), '')
  await shot(page, 'M8-queue-table')

  await page.goto(ORIGIN + '/admin', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1800)
  m = await overflow(page)
  check('管理设置无横向溢出', m.scrollWidth <= m.innerWidth + 1, `${m.scrollWidth} / ${m.innerWidth}`)
  await shot(page, 'M9-admin-settings')

  await page.goto(ORIGIN + '/profile', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1600)
  m = await overflow(page)
  check('我的配置无横向溢出', m.scrollWidth <= m.innerWidth + 1, `${m.scrollWidth} / ${m.innerWidth}`)
  await shot(page, 'M10-profile')

  await page.goto(ORIGIN + '/users', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1600)
  m = await overflow(page)
  check('用户管理无横向溢出', m.scrollWidth <= m.innerWidth + 1, `${m.scrollWidth} / ${m.innerWidth}`)
  await shot(page, 'M11-users')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error14')
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
console.log(`\n===== 手机端适配：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`（测试账号 ${UNAME} 的任务已清理）截图目录：${SHOTS}`)
process.exit(fail.length || jsErrors.length ? 1 : 0)
