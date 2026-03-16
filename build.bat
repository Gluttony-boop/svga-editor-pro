@echo off
chcp 65001 >nul
echo ========================================
echo SVGA Editor - Windows Build Script
echo ========================================
echo.
echo [Info] Building Windows version only
echo        For macOS, use GitHub Actions or build on Mac
echo ========================================
echo.

:: Check node_modules
if exist "node_modules" (
    echo [Tip] Dependencies exist, skip install
    echo       Delete node_modules folder to reinstall
) else (
    echo [1/3] Installing dependencies...
    call npm install --registry=https://registry.npmmirror.com
    if errorlevel 1 (
        echo Install failed!
        pause
        exit /b 1
    )
)

echo.
echo [2/3] Preparing and obfuscating code...
node build.js
if errorlevel 1 (
    echo Code preparation failed!
    pause
    exit /b 1
)

echo.
echo [3/3] Building Windows application...
call npm run build:win

echo.
echo ========================================
echo Build Complete!
echo Output folder: dist\
echo ========================================
echo.
echo Generated files:
echo   - SVGA Setup 1.0.0.exe (Installer)
echo   - SVGA 1.0.0.exe (Portable)
echo ========================================
pause
