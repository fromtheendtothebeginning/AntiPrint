// UI 验收：Word / PPT 提交前先转 PDF → 预览、提交、我的任务与管理队列预览
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test17.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { adminTokenCached } from './lib/admin-token.mjs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const ORIGIN = 'http://127.0.0.1:8301'
const API = ORIGIN
const DOCX = 'D:/anticraft/AntiPrint/.tmp-test/test-word.docx'
const PPTX = 'D:/anticraft/AntiPrint/.tmp-test/test-ppt.pptx'
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
const UNAME = 'off' + tag
const UT = (await (await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})
).json()).token
const adminToken = (await (await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json()).token
const AH = { Authorization: 'Bearer ' + adminToken }

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

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))

try {
  console.log('\n1. 提交页：选 Word → 服务端转 PDF → 右栏预览出 PDF')
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.getByLabel('用户名').fill(UNAME)
  await page.getByLabel('密码').fill('Test123456')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2300)

  const hint = await page.locator('body').innerText()
  check('投放区提示支持 Word/PPT 且说明会先转 PDF', /支持 PDF \/ 图片 \/ Word \/ PPT/.test(hint) && /先转成 PDF/.test(hint), '')

  await page.locator('input[type=file]').first().setInputFiles([DOCX])
  await page.waitForTimeout(900)
  const converting = await page.locator('#file-preview').innerText()
  check('转换中显示「正在把 Word/PPT 转成 PDF…」（或已转完）', /正在把 Word\/PPT 转成 PDF/.test(converting) || (await page.locator('#file-preview iframe').count()) > 0,
        converting.replace(/\n/g, ' ').slice(0, 40))

  await page.locator('#file-preview iframe').first().waitFor({ timeout: 60000 })
  const src = (await page.locator('#file-preview iframe').getAttribute('src')) ?? ''
  check('预览渲染 PDF（iframe 指向 blob）', src.startsWith('blob:'), src.slice(0, 30))
  const previewText = await page.locator('body').innerText()
  check('预览说明标注「Word/PPT 已转 PDF」', /（Word\/PPT 已转 PDF）/.test(previewText), '')
  await shot(page, 'O1-submit-word')

  console.log('\n2. 第二步：加一个 PPT 一起提交')
  await page.locator('input[type=file]').first().setInputFiles([DOCX, PPTX])
  await page.waitForTimeout(1500)
  await page.locator('#file-preview iframe').first().waitFor({ timeout: 60000 })
  const listText = await page.locator('body').innerText()
  check('两个 Office 文件都在列表里', /test-word\.docx/.test(listText) && /test-ppt\.pptx/.test(listText), '')
  await page.getByRole('button', { name: '下一步：填写配送信息' }).click()
  await page.waitForTimeout(900)
  await page.locator('input[name=address]').fill('Office 转换 UI 验收（可删除）')
  await page.locator('#submit-note').fill('Word + PPT')
  await page.getByRole('button', { name: '提交打印任务' }).click()
  // 提交时服务端要现场转换 PPT（本机 Office COM 约 20 秒），耐心等成功卡片
  let submitted = true
  await page.getByText('提交成功').first().waitFor({ timeout: 180000 }).catch(() => { submitted = false })
  const okText = await page.locator('body').innerText()
  check('提交成功（后端已在提交时转好两份 PDF）', submitted && /提交成功/.test(okText), okText.replace(/\n/g, ' ').slice(0, 60))

  console.log('\n3. 「我的任务」：点文件名预览的是转换后的 PDF')
  await page.goto(ORIGIN + '/mine', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1600)
  await page.getByRole('button', { name: /test-word\.docx/ }).first().click()
  await page.waitForTimeout(1600)
  const modal = page.locator('.fixed.inset-0.z-50').last()
  check('弹窗标题是原文件名', /预览：test-word\.docx/.test(await modal.innerText()), '')
  check('弹窗里是 PDF 预览（iframe 且有页面跳转链接）',
        (await modal.locator('iframe').count()) === 1 && !/不支持.*预览/.test(await modal.innerText()), '')
  await shot(page, 'O2-myjobs-preview')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)

  console.log('\n4. 管理队列：同意后仍能预览 PDF（代理将打印这份 PDF）')
  const jobs = (await (await fetch(API + '/api/jobs/mine', { headers: { Authorization: 'Bearer ' + UT } })).json()).jobs
  const job = jobs[0]
  // 队列页只对管理员开放：先退出，换 admin 登录
  await page.getByRole('button', { name: /退出/ }).click()
  await page.waitForTimeout(1400)
  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码').fill('admin123')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2400)
  await page.goto(ORIGIN + '/queue', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1800)
  await page.locator('tr', { hasText: '#' + job.id }).first().getByRole('button', { name: /test-word\.docx/ }).click()
  await page.waitForTimeout(1600)
  const queueModal = page.locator('.fixed.inset-0.z-50').last()
  check('队列预览也是 PDF（iframe）', (await queueModal.locator('iframe').count()) === 1, '')
  await shot(page, 'O3-queue-preview')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)

  await page.locator('tr', { hasText: '#' + job.id }).first().getByRole('button', { name: '同意' }).click()
  await page.waitForTimeout(2400)
  const after = (await (await fetch(`${API}/api/jobs/${job.id}`, { headers: AH })).json()).job
  check('同意后状态变已通过', after.status === '已通过', after.status)

  console.log('\n5. 代理领取时拿到的是 .pdf（print_name）与 PDF 字节')
  const AGENT = (await (await fetch(API + '/api/settings', { headers: AH })).json()).settings.agent_token
  const GH = { 'X-Agent-Token': AGENT, 'Content-Type': 'application/json' }
  let claimed = null
  const borrowed = []
  for (let i = 0; i < 10; i++) {
    const got = (await (await fetch(API + '/api/agent/claim', { method: 'POST', headers: GH, body: '{}' })).json()).job
    if (!got) break
    if (got.id === job.id) { claimed = got; break }
    borrowed.push(got.id)
    await fetch(`${API}/api/agent/jobs/${got.id}/result`, { method: 'POST', headers: GH, body: JSON.stringify({ ok: false, error: '临时占用（Office UI 测试）' }) })
  }
  check('代理领取到该任务', claimed !== null, `借用过 ${borrowed.join(',') || '无'}`)
  const word = claimed?.files.find((f) => f.filename === 'test-word.docx')
  check('claim 的 print_name = test-word.pdf', word?.print_name === 'test-word.pdf', JSON.stringify(claimed?.files.map((f) => [f.filename, f.print_name])))
  const dl = await fetch(API + (word?.url ?? ''), { headers: GH })
  const bytes = Buffer.from(await dl.arrayBuffer())
  check('代理下载的字节是 PDF', bytes.slice(0, 4).toString() === '%PDF', `${bytes.length}B`)
  await fetch(`${API}/api/agent/jobs/${job.id}/result`, { method: 'POST', headers: GH, body: JSON.stringify({ ok: true, error: null }) })
  for (const other of borrowed) await fetch(`${API}/api/jobs/${other}/retry`, { method: 'POST', headers: AH })
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error17')
} finally {
  await browser.close()
}

// 清理
for (const j of (await (await fetch(API + '/api/jobs', { headers: AH })).json()).jobs.filter((j) => j.username === UNAME)) {
  await fetch(`${API}/api/jobs/${j.id}`, { method: 'DELETE', headers: AH })
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== Office 转 PDF（UI）：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`（测试账号 ${UNAME} 的任务已清理）截图目录：${SHOTS}`)
process.exit(fail.length || jsErrors.length ? 1 : 0)
