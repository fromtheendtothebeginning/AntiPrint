@echo off
setlocal
rem AntiPrint virtual printer - diagnostics.
rem Runs the built-in self test (config -> server login -> spool folder -> queue -> autostart -> tray)
rem and prints the current status as JSON. Send the output of this window to whoever runs the server.

set "VP_DIR=%~dp0"
for %%I in ("%VP_DIR%.") do set "VP_DIR=%%~fI"

if exist "%VP_DIR%\AntiPrintVPrinter.exe" (
  echo === self test ===
  "%VP_DIR%\AntiPrintVPrinter.exe" --selftest
  echo.
  echo === status ===
  "%VP_DIR%\AntiPrintVPrinter.exe" --status
  echo.
  pause
  endlocal & exit /b 0
)

set "PY=%VP_DIR%\runtime\python.exe"
if not exist "%PY%" set "PY=%VP_DIR%\..\backend\.venv\Scripts\python.exe"
if not exist "%PY%" for %%I in (python.exe) do set "PY=%%~$PATH:I"
if not exist "%PY%" (
  echo [ERROR] Neither AntiPrintVPrinter.exe nor python.exe was found.
  echo         Use the distributed zip, or install Python 3.9+ and re-run.
  pause
  exit /b 1
)

echo === self test ===
"%PY%" "%VP_DIR%\virtual_printer.py" --selftest
echo.
echo === status ===
"%PY%" "%VP_DIR%\virtual_printer.py" --status
echo.
pause
endlocal
