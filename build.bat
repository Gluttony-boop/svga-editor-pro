@echo off
setlocal enabledelayedexpansion

echo ==========================================
echo   SVGA Editor Pro - Build Script (Windows)
echo ==========================================

echo.
echo [1/3] Installing dependencies...
call npm install --registry=https://registry.npmmirror.com
if %errorlevel% neq 0 (
    echo Install failed! Trying default registry...
    call npm install
    if %errorlevel% neq 0 (
        echo Install failed!
        exit /b 1
    )
)

echo.
echo [2/3] Building frontend...
call npm run build:web
if %errorlevel% neq 0 (
    echo Frontend build failed!
    exit /b 1
)

echo.
echo [3/3] Building for Windows (x64)...
call npm run build:win
if %errorlevel% neq 0 (
    echo Build failed!
    exit /b 1
)

echo.
echo ==========================================
echo   Build complete!
echo   Output: src-tauri\target\x86_64-pc-windows-msvc\release\bundle\
echo ==========================================

endlocal
