// UI 验收：任务队列的移动端改造（操作常显 / 文件与设置收成图标弹窗 / 确认按钮放大）
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test19.mjs
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
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })

const tag = String(Date.now()).slice(-6)
const UNAME = 'mob19' + tag
const UT = (await (await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})
).json()).token
const AH = { Authorization: 'Bearer ' + (await (await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json()).token }

// 计费：新账号余额为 0 → 管理员先充 100 元（充值功能待实现，管理员可手工代记）
const CREDIT_ADMIN = { Authorization: 'Bearer ' + (await adminTokenCached(API)) }
const CREDIT_ID = ((await (await fetch(API + '/api/users', { headers: CREDIT_ADMIN })).json()).users
  .find((u) => u.username === UNAME) || {}).id
if (CREDIT_ID) {
  await fetch(`${API}/api/users/${CREDIT_ID}/balance`, {
    method: 'POST', headers: { ...CREDIT_ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ delta: '100', note: '测试充值' }),
  })
}

// 造一条带设置的任务，供队列断言
const body = new FormData()
body.append('address', '移动端队列验收（可删除）')
body.append('delivery_mode', '配送')
body.append('settings', JSON.stringify([{ copies: 2, paper: 'A3', nup: '2,2', scale: 'fit', pages: '1-2' }]))
body.append('files', new Blob([fs.readFileSync(PDF)], { type: 'application/pdf' }), 'test-print.pdf')
const job = (await (await fetch(API + '/api/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + UT }, body })).json()).job
console.log(`测试任务 #${job.id}`)


const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const jsErrors = []

async function login(page) {
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码').fill('admin123')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2300)
}

try {
  // ══ 手机端 390×844 ══
  console.log('\n1. 手机端：操作按钮一直显示（不必悬停）')
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => jsErrors.push('手机端：' + e.message))
  await login(page)
  await page.goto(ORIGIN + '/queue', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1600)

  const row = page.locator('tr', { hasText: '#' + job.id }).first()
  const opsOpacity = await row.locator('td').last().locator('div').first().evaluate((el) => getComputedStyle(el).opacity)
  check('操作区不透明（无需 hover 即可见）', opsOpacity === '1', `opacity=${opsOpacity}`)
  // 手机端：行内操作收进「详情」抽屉，行里只留一个「详情」按钮（详情与操作见 ui-test21）
  check('手机端行里有「详情」入口', (await row.getByRole('button', { name: /查看任务详情与操作/ }).count()) === 1, '')
  check('手机端不再平铺行内操作按钮（同意/驳回隐藏）', !(await row.getByRole('button', { name: '同意' }).isVisible()), '')

  console.log('\n2. 手机端：「文件与设置」收成一个图标，点了弹窗看明细')
  const filesIcon = row.getByRole('button', { name: /查看文件与设置/ })
  check('行里有「查看文件与设置」图标按钮', (await filesIcon.count()) === 1, '')
  check('手机端不直接显示文件名（内联列表隐藏）', !(await row.getByRole('button', { name: /test-print\.pdf/ }).isVisible().catch(() => false)), '')
  await filesIcon.click()
  await page.waitForTimeout(700)
  const filesModal = page.locator('.fixed.inset-0.z-50').last()
  const filesText = await filesModal.innerText()
  check('弹窗标题是任务号 + 文件与设置', new RegExp(`任务 #${job.id} 的文件与设置`).test(filesText), filesText.split('\n')[0])
  check('弹窗里有文件名与设置摘要（2 份 / A3）', /test-print\.pdf/.test(filesText) && /2 份/.test(filesText) && /A3/.test(filesText), '')
  const okBtn = filesModal.getByRole('button', { name: '知道了' })
  const okBox = await okBtn.boundingBox()
  check(`「知道了」按钮放大（高 ${Math.round(okBox.height)}px，整行宽 ${Math.round(okBox.width)}px）`,
        okBox.height >= 40 && okBox.width > 200, `${Math.round(okBox.width)}x${Math.round(okBox.height)}`)
  await shot(page, 'M1-queue-mobile-files-modal')

  console.log('\n3. 手机端：弹窗里点文件名可直接预览')
  await filesModal.getByRole('button', { name: /test-print\.pdf/ }).click()
  await page.waitForTimeout(1500)
  const previewModal = page.locator('.fixed.inset-0.z-50').last()
  check('打开的是预览弹窗（PDF iframe）', (await previewModal.locator('iframe').count()) === 1, '')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)

  console.log('\n4. 手机端：删除确认按钮放大（操作在详情抽屉底部）')
  await row.click()                       // 手机端行内操作已收进详情抽屉
  await page.waitForTimeout(800)
  await page.locator('div.fixed.inset-0.z-50').last().getByRole('button', { name: '删除' }).click()
  await page.waitForTimeout(800)
  const delModal = page.locator('.fixed.inset-0.z-50').last()
  const confirmBtn = delModal.getByRole('button', { name: '确认删除' })
  const confirmBox = await confirmBtn.boundingBox()
  const cancelBox = await delModal.locator('.mt-6').getByRole('button', { name: '取消' }).boundingBox()
  check(`「确认删除」放大（高 ${Math.round(confirmBox.height)}px，整行宽 ${Math.round(confirmBox.width)}px）`,
        confirmBox.height >= 40 && confirmBox.width > 100, `${Math.round(confirmBox.width)}x${Math.round(confirmBox.height)}`)
  check('「取消」同样放大且与确认并排', cancelBox.height >= 40, `${Math.round(cancelBox.width)}x${Math.round(cancelBox.height)}`)
  await shot(page, 'M2-queue-mobile-confirm')
  await delModal.locator('.mt-6').getByRole('button', { name: '取消' }).click()
  await page.waitForTimeout(500)

  console.log('\n5. 手机端：页面本身不横向溢出（表格在卡片内滚动）')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check('无页面级横向溢出', overflow <= 1, `${overflow}px`)
  const tableW = await page.locator('table').evaluate((el) => Math.round(el.getBoundingClientRect().width))
  check(`表格收窄后仍比屏幕宽（${tableW}px，靠容器内滚动）`, tableW > 390, `${tableW}px`)
  await ctx.close()

  // ══ 桌面端 1600 ══
  console.log('\n6. 桌面端：文件与设置仍是内联文字，操作常显，确认按钮不撑满')
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page2 = await ctx2.newPage()
  page2.on('pageerror', (e) => jsErrors.push('桌面端：' + e.message))
  await login(page2)
  await page2.goto(ORIGIN + '/queue', { waitUntil: 'networkidle' })
  await page2.waitForTimeout(1600)
  const row2 = page2.locator('tr', { hasText: '#' + job.id }).first()
  const opsOpacity2 = await row2.locator('td').last().locator('div').first().evaluate((el) => getComputedStyle(el).opacity)
  check('桌面端操作区同样常显', opsOpacity2 === '1', `opacity=${opsOpacity2}`)
  check('桌面端仍直接显示文件名', await row2.getByRole('button', { name: /test-print\.pdf/ }).isVisible(), '')
  check('桌面端不显示手机图标按钮', (await row2.getByRole('button', { name: /查看文件与设置/ }).count()) === 0
        || !(await row2.getByRole('button', { name: /查看文件与设置/ }).isVisible()), '')
  await row2.getByRole('button', { name: '删除' }).click()
  await page2.waitForTimeout(700)
  const delModal2 = page2.locator('.fixed.inset-0.z-50').last()
  const confirmBox2 = await delModal2.getByRole('button', { name: '确认删除' }).boundingBox()
  check('桌面端确认按钮保持原大小（不整行宽）', confirmBox2.width < 200, `${Math.round(confirmBox2.width)}x${Math.round(confirmBox2.height)}`)
  await delModal2.locator('.mt-6').getByRole('button', { name: '取消' }).click()
  await page2.waitForTimeout(500)
  await shot(page2, 'M3-queue-desktop-after-mobile')
  await ctx2.close()
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
console.log(`\n===== 队列移动端改造：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`（测试账号 ${UNAME} 的任务已清理）截图目录：${SHOTS}`)
process.exit(fail.length || jsErrors.length ? 1 : 0)
