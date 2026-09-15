// UI 验收：用户头像（我的配置页上传/移除 + 侧栏显示 + 刷新后仍在）
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test24.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const ORIGIN = 'http://127.0.0.1:8301'
const API = ORIGIN
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

const tag = String(Date.now()).slice(-6)
const UNAME = 'ava' + tag
const UT = (await (await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})).json()).token
const UH = { Authorization: 'Bearer ' + UT }
const profile = async () => (await (await fetch(API + '/api/profile', { headers: UH })).json()).profile

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))

try {
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.getByLabel('用户名').fill(UNAME)
  await page.getByLabel('密码').fill('Test123456')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2400)
  await page.goto(ORIGIN + '/profile', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1600)

  console.log('\n1. 「我的配置」里有头像卡，默认首字母占位')
  const body = await page.locator('body').innerText()
  check('头像卡片存在', /头像/.test(body) && /支持 png \/ jpg \/ gif \/ webp/.test(body), '')
  check('默认没有头像图（首字母占位）', (await page.locator('img[alt="当前头像"]').count()) === 0, '')
  check('侧栏也是首字母占位', (await page.locator('aside img').count()) === 0, '')

  console.log('\n2. 选一张图 → 立刻上传并显示预览')
  await page.locator('input[type=file][accept*="image/png"]').setInputFiles([PNG])
  await page.waitForTimeout(2500)
  const img = page.locator('img[alt="当前头像"]')
  check('配置页出现头像预览（blob）', (await img.count()) === 1 && (await img.getAttribute('src')).startsWith('blob:'), '')
  check('提示「头像已更新」', /头像已更新/.test(await page.locator('body').innerText()), '')
  const saved = await profile()
  check('服务端已记录头像', !!saved.avatar, saved.avatar)
  check('侧栏也换成了头像图', (await page.locator('aside img').count()) === 1, '')
  await page.screenshot({ path: `${SHOTS}/V1-avatar-set.png`, fullPage: false })

  console.log('\n3. 刷新后头像还在')
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(2200)
  check('配置页头像仍在', (await page.locator('img[alt="当前头像"]').count()) === 1, '')
  check('侧栏头像仍在', (await page.locator('aside img').count()) === 1, '')

  console.log('\n4. 移除头像 → 回到首字母占位')
  await page.getByRole('button', { name: '移除头像' }).click()
  await page.waitForTimeout(2000)
  check('预览消失', (await page.locator('img[alt="当前头像"]').count()) === 0, '')
  check('提示已移除', /头像已移除/.test(await page.locator('body').innerText()), '')
  check('服务端 avatar 清空', (await profile()).avatar === '', '')
  check('侧栏回到首字母占位', (await page.locator('aside img').count()) === 0, '')
  await page.screenshot({ path: `${SHOTS}/V2-avatar-removed.png`, fullPage: false })
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
} finally {
  await browser.close()
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 用户头像：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`截图目录：${SHOTS}`)
process.exit(fail.length || jsErrors.length ? 1 : 0)
