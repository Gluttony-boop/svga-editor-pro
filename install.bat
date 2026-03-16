@echo off
chcp 65001 >nul
echo ========================================
echo 安装依赖中...
echo ========================================
echo.

npm install --registry=https://registry.npmmirror.com

if errorlevel 1 (
    echo.
    echo ========================================
    echo 安装失败！请检查网络连接
    echo ========================================
) else (
    echo.
    echo ========================================
    echo 安装成功！
    echo 现在可以运行 build.bat 进行打包了
    echo ========================================
)

pause
