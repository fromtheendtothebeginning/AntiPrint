// UI 验收：① API 文档页（Markdown 渲染 + 管理员编辑/保存/恢复默认 + 非管理员不能编辑）
//          ② 虚拟打印机页（三种平台卡片、只开 Windows x86-64、真实下载 zip、四步说明与常见问题）
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test-docs-vprinter.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { adminTokenCached } from './lib/admin-token.mjs'

const require = createRequire('file:///D:/anticraft/index/')
const { chromium } = require('playwright-core')

const ORIGIN = 'http://127.0.0.1:8301'
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
const UNAME = 'docs' + tag
const reg = await (await fetch(ORIGIN + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})).json()
if (!reg.token) throw new Error('注册失败：' + JSON.stringify(reg).slice(0, 120))
const ADMIN = { Authorization: 'Bearer ' + (await adminTokenCached(ORIGIN)) }

// 收尾用：先把文档恢复成出厂（用例会改它）
const resetDocs = () => fetch(ORIGIN + '/api/docs/api', {
  method: 'PUT', headers: { ...ADMIN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: '' }),
})
await resetDocs()

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
const page = await ctx.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))

const login = async (username, password) => {
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.evaluate(() => localStorage.clear())
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(1800)
}

try {
  console.log('\n1. 普通用户看 API 文档：能读，不能改')
  await login(UNAME, 'Test123456')
  await page.getByRole('link', { name: /API 文档/ }).first().click()
  await page.waitForTimeout(900)
  const h1 = await page.locator('.md-body h1').first().innerText()
  check('文档页渲染出 Markdown 标题', h1.includes('AntiPrint 打印 API'), h1)
  check('渲染出参数表格（markdown 表格转 table）', await page.locator('.md-body table').count() >= 2,
    (await page.locator('.md-body table').count()) + ' 个表')
  check('渲染出代码块（Python 示例）', await page.locator('.md-body pre code').count() >= 2,
    (await page.locator('.md-body pre code').count()) + ' 个代码块')
  check('文档里能看到 POST /api/jobs 与 requests 示例',
    (await page.locator('.md-body').innerText()).includes('POST /api/jobs') &&
    (await page.locator('.md-body').innerText()).includes('requests'))
  check('普通用户看不到「编辑文档」按钮', await page.getByRole('button', { name: /编辑文档/ }).count() === 0)
  check('标明了这是出厂默认文档',
    (await page.locator('body').innerText()).includes('出厂默认文档'))
  await page.screenshot({ path: `${SHOTS}/docs-user.png`, fullPage: true })

  console.log('\n2. 管理员改文档：编辑 → 保存 → 落库 → 恢复默认')
  await login('admin', 'admin123')
  await page.goto(ORIGIN + '/apidocs', { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  check('管理员能看到「编辑文档」按钮', await page.getByRole('button', { name: /编辑文档/ }).count() === 1)
  await page.getByRole('button', { name: /编辑文档/ }).click()
  await page.waitForTimeout(400)
  const marker = `## 用例标记 ${tag}`
  await page.locator('textarea').fill(marker + '\n\n这一段是用例写进去的。\n')
  await page.getByRole('button', { name: /^保存$/ }).click()
  await page.waitForTimeout(1200)
  check('保存后有提示', (await page.locator('body').innerText()).includes('文档已保存'))
  check('保存后页面渲染出新内容', (await page.locator('.md-body').innerText()).includes(`用例标记 ${tag}`))
  check('页头改标成「本站自定义文档」', (await page.locator('body').innerText()).includes('本站自定义文档'))
  const onDisk = await (await fetch(ORIGIN + '/api/docs/api', { headers: ADMIN })).json()
  check('服务端确实存下了（custom=true）', onDisk.custom === true && onDisk.content.includes(`用例标记 ${tag}`),
    `updated_by=${onDisk.updated_by}`)
  await page.screenshot({ path: `${SHOTS}/docs-admin-custom.png`, fullPage: true })

  await page.getByRole('button', { name: /恢复默认/ }).click()
  await page.waitForTimeout(1200)
  check('恢复默认后回到出厂文档（h1 又是 AntiPrint 打印 API）',
    (await page.locator('.md-body h1').first().innerText()).includes('AntiPrint 打印 API'))
  check('恢复默认后 custom=false', (await (await fetch(ORIGIN + '/api/docs/api', { headers: ADMIN })).json()).custom === false)

  console.log('\n3. 虚拟打印机页：三种平台卡片 + 只开 Windows x86-64')
  await page.getByRole('link', { name: /虚拟打印机/ }).first().click()
  await page.waitForTimeout(1200)
  const body = await page.locator('body').innerText()
  check('页面说明「打印=提交任务」这件事', body.includes('AntiPrint-1.0.0') && body.includes('Ctrl'))
  check('Windows 卡片可下载（有「下载 zip」按钮）', await page.getByRole('button', { name: /下载 zip/ }).count() === 1)
  check('macOS 卡片标「暂未开放」', body.includes('macOS') && body.includes('暂未开放'))
  check('Linux 卡片也在（同样暂未开放）',
    body.includes('Linux') && (body.match(/暂未开放/g) || []).length >= 2)
  check('写明了使用四步', body.includes('1. 下载并解压') && body.includes('4. 打印 = 提交任务'))
  check('常见问题里有「找不到图标 / 彻底退出 / 开机自启」',
    body.includes('右下角找不到图标') && body.includes('彻底退出/开机自动启动'))
  check('提示了下载需要登录', body.includes('下载需要登录'))
  check('SHA-256 指纹有展示', /SHA-256\s+[0-9a-f]{16}/.test(body))

  console.log('\n4. 真下载那个 zip（23MB）')
  const expected = Number((await (await fetch(ORIGIN + '/api/downloads', { headers: ADMIN })).json())
    .packages.find((p) => p.id === 'windows-x64').size)
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.getByRole('button', { name: /下载 zip/ }).click(),
  ])
  const target = path.join(os.tmpdir(), `vp-dl-${tag}.zip`)
  await download.saveAs(target)
  const got = fs.statSync(target).size
  check('浏览器真的下载到 zip 且大小与清单一致', got === expected, `${download.suggestedFilename()} ${got} 字节 / 期望 ${expected}`)
  check('下载完成后页面给出提示', (await page.locator('body').innerText()).includes('已开始保存'))
  fs.unlinkSync(target)
  await page.screenshot({ path: `${SHOTS}/vprinter-page.png`, fullPage: true })

  console.log('\n5. 手机端（390 宽）不横向溢出')
  await page.setViewportSize({ width: 390, height: 844 })
  for (const [name, url] of [['虚拟打印机', '/vprinter'], ['API 文档', '/apidocs']]) {
    await page.goto(ORIGIN + url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(900)
    const over = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }))
    check(`手机端「${name}」页无横向溢出`, over.scroll <= over.client + 1, `${over.scroll}/${over.client}`)
  }
  await page.screenshot({ path: `${SHOTS}/vprinter-mobile.png`, fullPage: true })
} finally {
  await resetDocs()
  check('页面 JS 错误为 0', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '))
  await browser.close()
  // 清掉用例账号（余额为 0 才能删；新账号本来就是 0）
  const uid = ((await (await fetch(ORIGIN + '/api/users', { headers: ADMIN })).json()).users
    .find((u) => u.username === UNAME) || {}).id
  if (uid) {
    const del = await fetch(`${ORIGIN}/api/users/${uid}`, { method: 'DELETE', headers: ADMIN })
    console.log(`  清理用例账号 ${UNAME}：HTTP ${del.status}`)
  }
}

console.log(`\n结果：${pass.length} 项通过，${fail.length} 项失败`)
if (fail.length) console.log('失败项：\n - ' + fail.join('\n - '))
process.exit(fail.length ? 1 : 0)
