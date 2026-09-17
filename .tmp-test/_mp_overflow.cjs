// 横向溢出检查：把预览生成的 HTML 逐个加载，找出右边缘超出 375px 的元素
const { createRequire } = require('module')
const fs = require('fs')
const path = require('path')
const req = createRequire('file:///D:/anticraft/index/')
const { chromium } = req('playwright-core')

const SHOTS = 'D:/anticraft/AntiPrint/.tmp-test/shots/miniprogram'
const lines = []

;(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/86133/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
    args: ['--no-sandbox'],
  })
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  const targets = process.argv.length > 2 ? process.argv.slice(2) : ['login', 'submit', 'jobs', 'balance', 'profile']
  for (const name of targets) {
    const file = path.join(SHOTS, `${name}.html`)
    if (!fs.existsSync(file)) {
      lines.push(`${name}: 缺少 ${file}`)
      continue
    }
    await page.goto(`file:///${file.replace(/\\/g, '/')}`)
    const report = await page.evaluate(() => {
      const bad = []
      for (const el of document.querySelectorAll('.sim-screen *')) {
        const rect = el.getBoundingClientRect()
        if (rect.right > 375.5) bad.push(`${el.className || el.tagName}@${Math.round(rect.right)}`)
      }
      return { count: bad.length, bad: bad.slice(0, 5), docWidth: document.documentElement.scrollWidth }
    })
    lines.push(
      report.count === 0
        ? `${name}: 无横向溢出 ✓`
        : `${name}: 溢出 ${report.count} 处 → ${report.bad.join('; ')}（文档宽 ${report.docWidth}）`,
    )
  }
  await browser.close()
  fs.writeFileSync(path.join(SHOTS, '_overflow.txt'), lines.join('\n'), 'utf8')
  console.log(lines.join('\n'))
})()
