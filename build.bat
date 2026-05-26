@echo off
setlocal enabledelayedexpansion

echo ==========================================
echo   SVGA Editor Pro - Build Script (Windows)
echo ==========================================

echo.
echo [1/3] Loading MSVC build environment...
where link >nul 2>nul
if errorlevel 1 (
    set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
    if not exist "!VSWHERE!" (
        echo Visual Studio Build Tools not found.
        echo Please install Visual Studio 2022 Build Tools with "Desktop development with C++".
        exit /b 1
    )

    for /f "usebackq tokens=*" %%i in (`"!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
        set "VSINSTALL=%%i"
    )

    if not defined VSINSTALL (
        for /f "usebackq tokens=*" %%i in (`"!VSWHERE!" -latest -products * -property installationPath`) do (
            set "VSINSTALL=%%i"
        )
    )

    if not defined VSINSTALL (
        if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" (
            set "VSINSTALL=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools"
        )
    )

    if not defined VSINSTALL (
        echo Visual C++ build tools not found.
        echo Please open Visual Studio Installer and install "Desktop development with C++".
        exit /b 1
    )

    set "VSDEVCMD=!VSINSTALL!\Common7\Tools\VsDevCmd.bat"
    if not exist "!VSDEVCMD!" (
        echo VsDevCmd.bat not found: !VSDEVCMD!
        exit /b 1
    )

    call "!VSDEVCMD!" -arch=x64 -host_arch=x64
    if errorlevel 1 (
        echo Failed to load Visual Studio build environment.
        exit /b 1
    )
)

where link >nul 2>nul
if errorlevel 1 (
    echo link.exe still not found after loading Visual Studio build environment.
    exit /b 1
)

echo MSVC build environment ready.

echo.
echo [2/3] Installing dependencies...
call npm install --registry=https://registry.npmmirror.com
if errorlevel 1 (
    echo Install failed! Trying default registry...
    call npm install
    if errorlevel 1 (
        echo Install failed!
        exit /b 1
    )
)

echo.
echo [3/3] Building for Windows (x64)...
call npm run build:win
if errorlevel 1 (
    echo Build failed!
    exit /b 1
)

echo.
echo ==========================================
echo   Build complete!
echo   Output: src-tauri\target\x86_64-pc-windows-msvc\release\bundle\
echo ==========================================

endlocal
