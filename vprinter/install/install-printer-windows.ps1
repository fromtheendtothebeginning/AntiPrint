# AntiPrint virtual printer - create the "ANTIPRINT" queue on Windows.
#
# NOTE: the green/portable AntiPrintVPrinter.exe can do exactly the same thing from its own
# UI ("安装虚拟打印机队列" / --install-printer, it asks for UAC itself). This script is for
# people who prefer a script, and for batch/offline installs.
#
# What this does (run it from an ELEVATED PowerShell; the -DryRun switch works unelevated):
#   1) creates the spool folder (default C:\ProgramData\AntiPrint\spool) and grants the Users
#      group read/modify: the spooler writes the PDF there as SYSTEM, while the tray app runs
#      as the logged-on user and has to read + clean it up;
#   2) creates a *local port* whose name is a fixed file path - the print driver then writes
#      the PDF straight into that file, so no "save as" dialog ever shows up;
#   3) creates the queue with the built-in "Microsoft Print To PDF" driver.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-printer-windows.ps1
#   powershell -ExecutionPolicy Bypass -File install-printer-windows.ps1 -Name ANTIPRINT -DryRun
#   powershell -ExecutionPolicy Bypass -File install-printer-windows.ps1 -SpoolDir D:\spool
#
# Uninstall: uninstall-printer-windows.ps1 (same folder).
# This file is ASCII-only on purpose (PowerShell 5.1 reads BOM-less files as ANSI).

param(
  [string]$Name = 'AntiPrint',
  [string]$SpoolDir = '',
  [string]$DriverName = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $SpoolDir) { $SpoolDir = Join-Path $env:ProgramData 'AntiPrint\spool' }
$port = Join-Path $SpoolDir "$Name.pdf"

function Info($text) { Write-Host "[INFO] $text" }
function Warn($text) { Write-Host "[WARN] $text" }
function Fail($text) { Write-Host "[ERROR] $text"; exit 1 }

# ---- 1. pick the print-to-PDF driver -------------------------------------------------
$driver = $DriverName
if (-not $driver) {
  $found = @(Get-PrinterDriver | Where-Object { $_.Name -match 'Print To PDF' -and $_.PrinterEnvironment -eq 'Windows x64' })
  if ($found.Count -eq 0) { $found = @(Get-PrinterDriver | Where-Object { $_.Name -match 'Print To PDF' }) }
  if ($found.Count -eq 0) {
    Fail "No 'Microsoft Print To PDF' driver found. Add the 'Microsoft Print to PDF' feature in Windows optional features, then re-run."
  }
  $driver = $found[0].Name
}

Info "queue : $Name"
Info "driver: $driver"
Info "port  : $port  (the PDF lands here, the tray app picks it up)"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($DryRun) {
  Info 'dry run - nothing is changed.'
  if (Test-Path $SpoolDir) { Info "spool folder already exists: $SpoolDir" } else { Info "spool folder would be created: $SpoolDir" }
  $existingPort = @(Get-PrinterPort | Select-Object -ExpandProperty Name)
  if ($existingPort -contains $port) { Info 'port already exists' } else { Info 'port would be created' }
  if (Get-Printer -Name $Name -ErrorAction SilentlyContinue) { Info 'queue already exists (would be updated)' } else { Info 'queue would be created' }
  if (-not $isAdmin) { Warn 'not running elevated - a real run needs "Run as administrator".' }
  exit 0
}

if (-not $isAdmin) {
  Fail 'Run this script from an elevated PowerShell (right click the Start entry -> Run as administrator).'
}

# ---- 2. spool folder + permissions ---------------------------------------------------
if (-not (Test-Path $SpoolDir)) {
  New-Item -ItemType Directory -Force -Path $SpoolDir | Out-Null
  Info "created spool folder $SpoolDir"
}
# S-1-5-32-545 = built-in Users. Without this the tray app cannot read the spooled PDF.
& icacls $SpoolDir /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "icacls failed on $SpoolDir - set 'Modify' permission for Users manually." }
Info 'granted Users:Modify on the spool folder'

# ---- 3. port + queue -----------------------------------------------------------------
$existingPorts = @(Get-PrinterPort | Select-Object -ExpandProperty Name)
if ($existingPorts -notcontains $port) {
  Add-PrinterPort -Name $port | Out-Null
  Info 'created the local port'
} else {
  Info 'local port already exists'
}

if (Get-Printer -Name $Name -ErrorAction SilentlyContinue) {
  Set-Printer -Name $Name -DriverName $driver -PortName $port
  Info 'updated the existing queue (driver/port)'
} else {
  Add-Printer -Name $Name -DriverName $driver -PortName $port -Comment 'AntiPrint virtual printer (PDF -> website)'
  Info 'created the queue'
}

$queue = Get-Printer -Name $Name
Write-Host ''
Write-Host "queue  : $($queue.Name)"
Write-Host "driver : $($queue.DriverName)"
Write-Host "port   : $($queue.PortName)"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1) run start-vprinter.bat (tray icon appears next to the clock), then check-vprinter.bat'
Write-Host '  2) print any document and pick the "ANTIPRINT" printer - it becomes a PDF and is'
Write-Host '     submitted to the AntiPrint website, where the admin reviews it as usual.'
Write-Host ''
Write-Host 'Note: keep printing one document at a time. The file port reuses a single file, so two'
Write-Host '      jobs spooled at the same moment can overwrite each other.'
