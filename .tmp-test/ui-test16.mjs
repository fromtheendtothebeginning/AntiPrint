// UI 验收：任务队列改成「一行式」——除地址外所有信息压在一行，操作按钮不换行
// 运行：node D:/anticraft/AntiPrint/.tmp-test/ui-test16.mjs
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
const UNAME = 'row' + tag
const UT = (await (await fetch(API + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: UNAME, password: 'Test123456' }),
})).json()).token
const UH = { Authorization: 'Bearer ' + UT }
const adminToken = (await (await fetch(API + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json()).token
const AH = { Authorization: 'Bearer ' + adminToken }
const AGENT = (await (await fetch(API + '/api/settings', { headers: AH })).json()).settings.agent_token
const Gh = { 'X-Agent-Token': AGENT, 'Content-Type': 'application/json' }

/** 造一条任务（可带 1~2 个文件与逐文件设置） */
async function makeJob({ address, note = '一行式验收', files = [PDF], settings }) {
  const body = new FormData()
  body.append('address', address)
  body.append('delivery_mode', '配送')
  body.append('note', note)
  if (settings) body.append('settings', JSON.stringify(settings))
  files.forEach((path, i) => {
    const name = path.endsWith('.png') ? `test-image-${i}.png` : 'test-print.pdf'
    const type = path.endsWith('.png') ? 'image/png' : 'application/pdf'
    body.append('files', new Blob([fs.readFileSync(path)], { type }), name)
  })
  const res = await fetch(API + '/api/jobs', { method: 'POST', headers: UH, body })
  return (await res.json()).job
}

// ① 待审核（短地址 + 设置）
const jPending = await makeJob({ address: '三教 305 讲台旁', settings: [{ copies: 2, paper: 'A3', nup: '2,2', scale: 'fit', pages: '1-2' }] })
// ② 已打印（两个文件、地址短）
const jPrinted = await makeJob({
  address: '5 号宿舍楼 402',
  files: [PDF, PNG],
  settings: [{ copies: 1, paper: 'A4', nup: '1,1', scale: 'fit', pages: '' }, { copies: 3, paper: 'A5', nup: '2,1', scale: 'fit', pages: '' }],
})
await fetch(`${API}/api/jobs/${jPrinted.id}/approve`, { method: 'POST', headers: AH })
await fetch(`${API}/api/agent/claim`, { method: 'POST', headers: Gh, body: '{}' })
await fetch(`${API}/api/agent/jobs/${jPrinted.id}/result`, { method: 'POST', headers: Gh, body: JSON.stringify({ ok: true, error: null }) })
// ③ 已驳回（带较长理由，检查是否被截断成一行）
const jRejected = await makeJob({ address: '图书馆一楼服务台' })
await fetch(`${API}/api/jobs/${jRejected.id}/reject`, {
  method: 'POST', headers: { ...AH, 'Content-Type': 'application/json' },
  body: JSON.stringify({ reason: '文件里包含无法静默打印的格式，请转成 PDF 后重新提交，谢谢配合' }),
})
// ④ 长地址任务（这一列允许换行）
const jLong = await makeJob({ address: '上海市徐汇区某某路 100 号 3 号楼 502 室（进门左手第二个门，找王老师）' })

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
const page = await ctx.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))

try {
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码').fill('admin123')
  await page.getByRole('button', { name: /登\s*录/ }).first().click()
  await page.waitForTimeout(2400)
  await page.goto(ORIGIN + '/queue', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)

  console.log('\n1. 表头合并成 5 列')
  const headText = await page.locator('thead').innerText()
  check('表头是「任务 / 文件与设置 / 配送方式与地址 / 状态 / 操作」',
        /任务/.test(headText) && /文件与设置/.test(headText) && /配送方式与地址/.test(headText) && /状态/.test(headText) && /操作/.test(headText)
        && !/提交人|提交时间|打印设置/.test(headText), headText.replace(/\n/g, ' | '))

  console.log('\n2. 单行高度：除长地址外，每行都在一行内')
  const rowBox = async (id) => page.locator('tr', { hasText: '#' + id }).first().boundingBox()
  const b1 = await rowBox(jPending.id)
  const b2 = await rowBox(jPrinted.id)
  const b3 = await rowBox(jRejected.id)
  const b4 = await rowBox(jLong.id)
  check(`待审核行单行（高 ${Math.round(b1.height)}px）`, b1.height < 64, `${Math.round(b1.height)}px`)
  check(`已打印（两个文件）行单行（高 ${Math.round(b2.height)}px）`, b2.height < 64, `${Math.round(b2.height)}px`)
  check(`已驳回（长理由已截断）行单行（高 ${Math.round(b3.height)}px）`, b3.height < 64, `${Math.round(b3.height)}px`)
  check(`长地址行允许更高（高 ${Math.round(b4.height)}px）`, b4.height >= 44, `${Math.round(b4.height)}px`)

  console.log('\n3. 行内信息与操作')
  const rowText = await page.locator('tr', { hasText: '#' + jPrinted.id }).first().innerText()
  check('任务号/提交人/时间在同一行文本里', new RegExp(`#${jPrinted.id}[\\s\\S]*${UNAME}`).test(rowText), rowText.split('\n')[0])
  check('文件与其设置同行展示（份数/纸张可见）', /test-print\.pdf/.test(rowText) && /3 份/.test(rowText) && /A5/.test(rowText), '')
  check('配送方式徽章与地址同格', /配送/.test(rowText) && /5 号宿舍楼 402/.test(rowText), '')
  const rejectedText = await page.locator('tr', { hasText: '#' + jRejected.id }).first().innerText()
  check('驳回理由被截断成一行并带省略号', /理由|\.\.\.|…/.test(rejectedText) && !/谢谢配合/.test(rejectedText), rejectedText.replace(/\n/g, ' | '))
  await shot(page, 'Q1-queue-oneline')

  console.log('\n4. 操作按钮不换行（横向一列）')
  const opsCell = page.locator('tr', { hasText: '#' + jPrinted.id }).first().locator('td').last()
  const actionsBox = await opsCell.locator('div').first().boundingBox()
  check(`已打印行的操作区高度单行（${Math.round(actionsBox.height)}px）`, actionsBox.height < 40, `${actionsBox.height}px`)
  const pendingOps = page.locator('tr', { hasText: '#' + jPending.id }).first().locator('td').last()
  const ys = []
  for (const b of await pendingOps.getByRole('button').all()) {
    const box = await b.boundingBox()
    if (box) ys.push(Math.round(box.y))
  }
  check('待审核行的同意/驳回/删除在同一水平线', new Set(ys).size <= 1, `y 坐标: ${ys.join(', ')}`)

  console.log('\n4b. 除地址列外，内容超出即省略号（不撑破列宽）')
  const ids = [jPending.id, jPrinted.id, jRejected.id, jLong.id]
  const overflow = await page.evaluate((wanted) => {
    const bad = []
    for (const tr of document.querySelectorAll('tbody tr')) {
      if (!wanted.some((id) => tr.innerText.includes('#' + id))) continue
      tr.querySelectorAll(':scope > td').forEach((td, i) => {
        if (i === 2) return // 地址列允许换行，不参与
        if (td.scrollWidth > td.clientWidth + 1) bad.push(`第 ${i + 1} 列 ${td.scrollWidth}>${td.clientWidth}`)
      })
    }
    return bad
  }, ids)
  check('非地址列内容不溢出（超出部分省略号）', overflow.length === 0, overflow.join('，'))

  console.log('\n4c. 操作列装得下最宽的一组按钮')
  const opsFits = await page.evaluate((id) => {
    const tr = [...document.querySelectorAll('tbody tr')].find((t) => t.innerText.includes('#' + id))
    const td = tr.querySelectorAll(':scope > td')[4]
    return { scroll: td.firstElementChild.scrollWidth, client: td.clientWidth }
  }, jPrinted.id)
  check(`「重新打印 / 待配送 / 删除」不溢出（${opsFits.scroll} ≤ ${opsFits.client}）`, opsFits.scroll <= opsFits.client + 1, `${opsFits.scroll}/${opsFits.client}`)

  console.log('\n5. 新布局下操作仍可用：同意待审核任务')
  await page.locator('tr', { hasText: '#' + jPending.id }).first().getByRole('button', { name: '同意' }).click()
  await page.waitForTimeout(2200)
  const after = await (await fetch(`${API}/api/jobs/${jPending.id}`, { headers: AH })).json()
  check('点「同意」后状态变已通过', after.job.status === '已通过', after.job.status)
  await shot(page, 'Q2-queue-after-approve')

  console.log('\n6. 管理员常见分辨率 1920 下不出现横向滚动（操作按钮无需拖动即可见）')
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.waitForTimeout(900)
  const fit = await page.evaluate(() => {
    const scrollBox = document.querySelector('table').parentElement
    const table = document.querySelector('table')
    const opsHeader = [...document.querySelectorAll('thead th')].pop()
    const right = table.getBoundingClientRect().right
    return {
      hScroll: scrollBox.scrollWidth - scrollBox.clientWidth,
      opsRight: Math.round(opsHeader.getBoundingClientRect().right),
      boxRight: Math.round(scrollBox.getBoundingClientRect().right),
      tableW: Math.round(table.getBoundingClientRect().width),
      right,
    }
  })
  check(`表格宽度不超容器（${fit.tableW}px，无横向滚动 ${fit.hScroll}px）`, fit.hScroll <= 1, `横向溢出 ${fit.hScroll}px`)
  check('「操作」列完整落在可视区内', fit.opsRight <= fit.boxRight + 1, `操作列右缘 ${fit.opsRight} / 容器右缘 ${fit.boxRight}`)
  await shot(page, 'Q3-queue-1920')
} catch (e) {
  check('测试脚本无异常', false, String(e).slice(0, 300))
  await shot(page, 'zz-error16')
} finally {
  await browser.close()
}

// 清理
for (const j of (await (await fetch(API + '/api/jobs', { headers: AH })).json()).jobs.filter((j) => j.username === UNAME)) {
  await fetch(`${API}/api/jobs/${j.id}`, { method: 'DELETE', headers: AH })
}

console.log('\n=== 页面 JS 错误 ===')
console.log(jsErrors.length ? jsErrors.slice(0, 5).join('\n') : '  无')
console.log(`\n===== 队列一行式布局：通过 ${pass.length} 项，失败 ${fail.length} 项 =====`)
fail.forEach((f) => console.log('  - 失败：' + f))
console.log(`（测试账号 ${UNAME} 的任务已清理）截图目录：${SHOTS}`)
process.exit(fail.length || jsErrors.length ? 1 : 0)
