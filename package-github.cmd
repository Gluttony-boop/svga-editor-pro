@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 exit /b 1

call npm run package:github -- %*
set "SVGA_PACKAGE_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%SVGA_PACKAGE_EXIT_CODE%"=="0" echo Packaging failed with exit code %SVGA_PACKAGE_EXIT_CODE%.
echo Press any key to close this window.
pause >nul
exit /b %SVGA_PACKAGE_EXIT_CODE%
