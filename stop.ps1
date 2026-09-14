# Stop AntiPrint processes only (backend on port 8301, print agent, frontend dev server).
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads non-BOM files as ANSI).
$ErrorActionPreference = 'SilentlyContinue'

$ids = @()

# 1) backend: authoritative - whoever is listening on our port
$ids += (Get-NetTCPConnection -LocalPort 8301 -State Listen).OwningProcess

# 2) print agent: python process whose command line mentions print_agent
$ids += Get-CimInstance Win32_Process |
  Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*print_agent*' } |
  ForEach-Object ProcessId

# 3) venv launcher wrappers of this project (pythonw.exe may spawn a child interpreter)
$ids += Get-CimInstance Win32_Process |
  Where-Object { $_.Name -like 'python*' -and $_.ExecutablePath -like '*AntiPrint*' } |
  ForEach-Object ProcessId

# 4) frontend dev server (vite)
$ids += Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*AntiPrint*' } |
  ForEach-Object ProcessId

$ids = $ids | Where-Object { $_ } | Sort-Object -Unique
if (-not $ids) {
  Write-Host 'nothing running to stop'
  exit 0
}
foreach ($procId in $ids) {
  Stop-Process -Id $procId -Force
  Write-Host ('stopped PID ' + $procId)
}
exit 0
