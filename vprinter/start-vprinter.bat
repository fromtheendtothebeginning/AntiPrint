@echo off
setlocal
rem AntiPrint virtual printer - start it in the background (tray icon, no console window).
rem
rem Two ways to run:
rem   1) distributed zip: AntiPrintVPrinter.exe sits next to this script (no Python needed)
rem   2) straight from the repo: ..\backend\.venv\Scripts\pythonw.exe or pythonw.exe in PATH
rem
rem The app logs to %USERPROFILE%\.antiprint-vprinter\log\vprinter.log.
rem Only one instance can run; starting it twice just prints a message.

set "VP_DIR=%~dp0"
for %%I in ("%VP_DIR%.") do set "VP_DIR=%%~fI"

if exist "%VP_DIR%\AntiPrintVPrinter.exe" (
  start "" "%VP_DIR%\AntiPrintVPrinter.exe"
  echo [INFO] Started AntiPrintVPrinter.exe. Look for the icon next to the clock.
  echo [INFO] Settings window: right click the tray icon -^> the first menu item.
  echo [INFO] Self test: check-vprinter.bat
  endlocal & exit /b 0
)

set "PYW=%VP_DIR%\runtime\pythonw.exe"
if not exist "%PYW%" set "PYW=%VP_DIR%\..\backend\.venv\Scripts\pythonw.exe"
if not exist "%PYW%" for %%I in (pythonw.exe) do set "PYW=%%~$PATH:I"
if not exist "%PYW%" (
  echo [ERROR] Neither AntiPrintVPrinter.exe nor pythonw.exe was found.
  echo         Use the distributed zip, or install Python 3.9+ and re-run.
  pause
  exit /b 1
)

start "" "%PYW%" "%VP_DIR%\virtual_printer.py"
echo [INFO] Started via pythonw. Look for the icon next to the clock.
echo [INFO] Log: %USERPROFILE%\.antiprint-vprinter\log\vprinter.log
endlocal
