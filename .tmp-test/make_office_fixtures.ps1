# 用本机 Microsoft Office 生成测试用的 Word / PPT 文件（仅造测试件，与产品运行时无关）
$ErrorActionPreference = 'Stop'
$dir = 'D:\anticraft\AntiPrint\.tmp-test'

# ── Word：多段中文内容（应能排出 1~2 页） ──
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
  $doc = $word.Documents.Add()
  $lines = @(
    'AntiPrint 打印测试文档',
    '这是一份用于验证 Word 转 PDF 与静默打印链路的测试文档。',
    '第二段：确认段落、标点与中文排版是否正常，例如「引号」、（括号）与 1234 数字。',
    '第三段：本行之后应当能看到，说明转换没有截断内容。'
  )
  $doc.Content.Text = ($lines -join "`r")
  $doc.SaveAs([ref]"$dir\test-word.docx", [ref]12)
  $doc.Close()
  Write-Host '已生成 test-word.docx'
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}

# ── PowerPoint：3 页幻灯片 ──
$ppt = New-Object -ComObject PowerPoint.Application
try {
  $pres = $ppt.Presentations.Add(0)
  for ($i = 1; $i -le 3; $i++) {
    $slide = $pres.Slides.Add($i, 2)      # ppLayoutText
    $slide.Shapes.Title.TextFrame.TextRange.Text = "第 $i 页标题"
    $slide.Shapes.Item(2).TextFrame.TextRange.Text = "这是第 $i 页的正文内容，用于验证 PPT 转 PDF。"
  }
  $pres.SaveAs("$dir\test-ppt.pptx")
  $pres.Close()
  Write-Host '已生成 test-ppt.pptx'
} finally {
  $ppt.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
}
