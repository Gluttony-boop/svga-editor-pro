@echo off
setlocal

cd /d "%~dp0"

echo ==========================================
echo   SVGA Editor Pro - One Click Package
echo ==========================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-win.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo Package failed. Exit code: %EXIT_CODE%
  pause
  exit /b %EXIT_CODE%
)

echo Package completed successfully.
pause
exit /b 0
