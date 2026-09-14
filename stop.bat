@echo off
REM Stop AntiPrint backend (port 8301) + print agent + frontend dev server.
REM The real logic lives in stop.ps1 (cmd quoting of inline PowerShell is fragile).
REM NOTE: keep this file pure ASCII + CRLF.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
echo AntiPrint stopped.
