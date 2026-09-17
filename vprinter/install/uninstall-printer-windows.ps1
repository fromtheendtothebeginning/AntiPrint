# AntiPrint virtual printer - remove the "ANTIPRINT" queue on Windows.
#
# Usage (elevated PowerShell):
#   powershell -ExecutionPolicy Bypass -File uninstall-printer-windows.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall-printer-windows.ps1 -Purge
#
# -Purge also deletes the local port and the spooled PDF / folder.
# The tray app itself is not touched: quit it from its tray menu and remove the
# "AntiPrintVPrinter" value in the Run key (or uncheck the checkbox in the settings window).
# This file is ASCII-only on purpose (PowerShell 5.1 reads BOM-less files as ANSI).

param(
  [string]$Name = 'AntiPrint',
  [string]$SpoolDir = '',
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'

if (-not $SpoolDir) { $SpoolDir = Join-Path $env:ProgramData 'AntiPrint\spool' }
$port = Join-Path $SpoolDir "$Name.pdf"

function Info($text) { Write-Host "[INFO] $text" }
function Fail($text) { Write-Host "[ERROR] $text"; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Run this script from an elevated PowerShell.' }

if (Get-Printer -Name $Name -ErrorAction SilentlyContinue) {
  Remove-Printer -Name $Name
  Info "removed queue $Name"
} else {
  Info "queue $Name does not exist"
}

if ($Purge) {
  if (@(Get-PrinterPort | Select-Object -ExpandProperty Name) -contains $port) {
    Remove-PrinterPort -Name $port
    Info "removed port $port"
  }
  if (Test-Path $SpoolDir) {
    Remove-Item -Recurse -Force $SpoolDir
    Info "removed $SpoolDir"
  }
} else {
  Info "kept the port and $SpoolDir (add -Purge to delete them)"
}
