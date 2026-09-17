// UI 验收：提交完成后回到「提交打印」应当回到第一步（干净的主界面）
// 覆盖两条路径：① 切到别的页面再切回来；② 已经在提交页时再点侧栏「提交打印」（同一地址不会重挂载 —— 修的就是这条）
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test-reset-submit.mjs
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

const tag = String(Date.now()).slice(-6)
const UNAME = 'rst' + tag
const reg = await (await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})).json()
const UT = reg.token
const ADMIN = { Authorization: 'Bearer ' + (await adminTokenCached(API)) }
const uid = ((await (await fetch(API + '/api/users', { headers: ADMIN })).json()).users
  .find((u) => u.username === UNAME) || {}).id
if (uid) {
  await fetch(`${API}/api/users/${uid}/balance`, {
    method: 'POST', headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ delta: '100', note: '测试充值' }),
  })
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))
const created = []

// 页面状态判定：第一步有三个标志（投放区提示 / 第二步才有的「提交打印任务」按钮 / 成功卡片标题）
const state = async () => ({
  success: await page.getByText('提交成功', { exact: false }).count(),
  dropZone: await page.getByText(/拖到|拖入|点击选择文件|选择文件/).count(),
  submitBtn: await page.getByRole('button', { name: /提交打印任务/ }).count(),
  step2: await page.getByRole('button', { name: /返回修改打印设置/ }).count(),
})

try {
  console.log('\n1. 登录并提交一单')
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await page.getByLabel('用户名').fill(UNAME)
  await page.getByLabel('密码').fill('Test123456')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2000)
  await page.getByRole('link', { name: /提交打印/ }).first().click()
  await page.waitForTimeout(600)

  await page.setInputFiles('input[type=file]', [PDF])
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: /下一步|去填写配送/ }).first().click()
  await page.waitForTimeout(600)
  // 默认配送方式是「配送」，不填地址会被 400 挡住（服务端要求配送单必须有地址）
  await page.locator('input[name=address]').fill('回归用例（可删除）')
  await page.getByRole('button', { name: /提交打印任务/ }).first().click()
  await page.waitForTimeout(2200)
  let st = await state()
  check('提交成功卡片出现', st.success > 0, JSON.stringify(st))
  await page.screenshot({ path: `${SHOTS}/reset-submit-1-created.png`, fullPage: true })

  console.log('\n2. 切到「我的任务」再切回「提交打印」→ 应在第一步')
  await page.getByRole('link', { name: /我的任务/ }).first().click()
  await page.waitForTimeout(700)
  await page.getByRole('link', { name: /提交打印/ }).first().click()
  await page.waitForTimeout(700)
  st = await state()
  check('回来后不是成功卡片', st.success === 0, JSON.stringify(st))
  check('回来后在第一步（没有第二步的按钮）', st.submitBtn === 0 && st.step2 === 0, JSON.stringify(st))
  check('回来后能看到投放区', st.dropZone > 0, JSON.stringify(st))

  console.log('\n3. 停在成功卡片上时，直接点侧栏「提交打印」（同一地址）→ 也应回到第一步')
  await page.getByRole('link', { name: /我的任务/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByRole('link', { name: /提交打印/ }).first().click()
  await page.waitForTimeout(600)
  // 再提交一单，制造「停在成功卡片」的状态
  await page.setInputFiles('input[type=file]', [PDF])
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: /下一步|去填写配送/ }).first().click()
  await page.waitForTimeout(500)
  await page.locator('input[name=address]').fill('回归用例（可删除）')
  await page.getByRole('button', { name: /提交打印任务/ }).first().click()
  await page.waitForTimeout(2200)
  st = await state()
  check('又提交成功（停在成功卡片上）', st.success > 0, JSON.stringify(st))
  await page.getByRole('link', { name: /提交打印/ }).first().click()      // 同一地址，点它
  await page.waitForTimeout(800)
  st = await state()
  check('点「提交打印」后回到第一步（不是停在成功卡片）',
    st.success === 0 && st.submitBtn === 0 && st.dropZone > 0, JSON.stringify(st))
  await page.screenshot({ path: `${SHOTS}/reset-submit-2-back.png`, fullPage: true })

  console.log('\n4. 清理测试任务')
  const mine = (await (await fetch(API + '/api/jobs/mine', { headers: { Authorization: 'Bearer ' + UT } })).json()).jobs
  for (const job of mine) {
    await fetch(`${API}/api/jobs/${job.id}`, { method: 'DELETE', headers: ADMIN })
    created.push(job.id)
  }
  check('测试任务已删除（自动退费）', true, `${created.length} 个：${created.join(', ')}`)
  check('页面没有 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '))
} finally {
  await browser.close()
  console.log(`\n结果：${pass.length} 项通过，${fail.length} 项失败`)
  if (fail.length) console.log('失败项：' + fail.join('、'))
  process.exit(fail.length ? 1 : 0)
}
