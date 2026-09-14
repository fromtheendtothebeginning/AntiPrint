// AntiPrint 前端 UI 测试 v3（临时脚本）：管理端驳回流程 + 预览 + 代理在线状态
// v2 教训：Modal 内理由框是 #reject-reason（不是 .modal textarea）；代理在线状态应与接口 agent_online 比对。
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test3.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:3010'
const API = 'http://127.0.0.1:8301'
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

// 先问接口要权威的代理在线状态，避免拿「我以为的」当断言
const loginRes = await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})
const adminToken = (await loginRes.json()).token
const jobsRes = await fetch(API + '/api/jobs', { headers: { Authorization: 'Bearer ' + adminToken } })
const apiData = await jobsRes.json()
const onlineFromApi = apiData.agent_online
const pendingFromApi = apiData.jobs.filter((j) => j.status === '待审核')
console.log(`\n接口侧：agent_online=${onlineFromApi}，待审核任务 ${pendingFromApi.length} 个：${pendingFromApi.map((j) => '#' + j.id).join(' ')}`)

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('  [页面 JS 错误] ' + e.message))

try {
  console.log('\n1. 管理员登录并查看队列')
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' })
  await page.locator('.card input').first().fill('admin')
  await page.locator('input[type=password]').first().fill('admin123')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2500)
  check('管理员登录进入 /admin', page.url().includes('/admin'), page.url())

  const bodyText = await page.locator('body').innerText()
  const showsOnline = /打印代理在线/.test(bodyText)
  const showsOffline = /打印代理离线/.test(bodyText)
  check('代理状态与接口一致', showsOnline === onlineFromApi && !showsOffline, `页面=在线:${showsOnline} 接口=${onlineFromApi}`)
  check('页面显示代理名与打印机信息', /print-agent-1/.test(bodyText), '')
  await shot(page, '20-admin-online')

  console.log('\n2. 驳回流程（理由为空禁用 → 填写后可提交）')
  const target = pendingFromApi[0]
  if (target) {
    const row = page.locator('tr', { hasText: '#' + target.id }).first()
    check(`找到待审核任务行 #${target.id}`, (await row.count()) > 0, '')
    await row.getByRole('button', { name: '驳回' }).click()
    await page.waitForTimeout(900)
    await shot(page, '21-reject-modal')
    const reasonBox = page.locator('#reject-reason')
    check('驳回理由输入框存在', (await reasonBox.count()) === 1, '')
    const confirm = page.getByRole('button', { name: '确认驳回' })
    check('理由为空时按钮禁用', (await confirm.isDisabled()) === true, '')
    await reasonBox.fill('UI v3 测试：文件内容无法辨认，请重新上传')
    await page.waitForTimeout(400)
    check('填写理由后按钮可用', (await confirm.isDisabled()) === false, '')
    await confirm.click()
    await page.waitForTimeout(2200)
    const afterText = await page.locator('body').innerText()
    check('列表出现「已驳回」与理由', /已驳回/.test(afterText) && /无法辨认/.test(afterText), '')
    await shot(page, '22-after-reject')

    const jobApi = await (
      await fetch(`${API}/api/jobs/${target.id}`, { headers: { Authorization: 'Bearer ' + adminToken } })
    ).json()
    check('接口侧状态=已驳回且带理由', jobApi.job.status === '已驳回' && !!jobApi.job.reject_reason, jobApi.job.status)
  } else {
    check('存在待审核任务可测驳回', false, '没有待审核任务')
  }

  console.log('\n3. 文件预览（同源鉴权 blob → iframe）')
  const previewBtn = page.getByRole('button', { name: '预览' }).first()
  check('预览按钮存在', (await previewBtn.count()) > 0, '')
  if (await previewBtn.count()) {
    await previewBtn.click()
    await page.waitForTimeout(2600)
    check('预览弹窗渲染 iframe', (await page.locator('iframe').count()) > 0, '')
    await shot(page, '23-preview')
  }

  console.log('\n4. 打印设置区块（启动器 / 打印机下拉 / 份数 / 演练开关 / 令牌）')
  const settingsText = await page.locator('body').innerText()
  check('设置区出现启动器与打印机配置', /启动器|SumatraPDF/.test(settingsText) && /打印机/.test(settingsText), '')
  check('打印机下拉含 P1106 或代理上报队列', /P1106/.test(settingsText), '')
  check('代理令牌可查看与复制', /令牌/.test(settingsText) && /复制/.test(settingsText), '')
  check('演练模式开关可见', /演练/.test(settingsText), '')
  await shot(page, '24-settings')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error3')
} finally {
  await browser.close()
}

console.log(`\n===== UI v3 结果：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
if (fail.length) {
  console.log('失败项：')
  fail.forEach((f) => console.log('  - ' + f))
}
console.log('截图目录：' + SHOTS)
process.exit(fail.length ? 1 : 0)
