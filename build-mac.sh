#!/bin/bash

echo "========================================"
echo "SVGA 编辑器 - macOS 构建脚本"
echo "========================================"
echo ""

# 检查 node_modules 是否存在
if [ -d "node_modules" ]; then
    echo "[提示] 依赖已存在，跳过安装"
    echo "       如需重新安装，请删除 node_modules 文件夹后重试"
else
    echo "[1/3] 安装依赖..."
    npm install --registry=https://registry.npmmirror.com
    if [ $? -ne 0 ]; then
        echo "依赖安装失败！"
        exit 1
    fi
fi

echo ""
echo "[2/3] 准备和混淆代码..."
node build.js
if [ $? -ne 0 ]; then
    echo "代码准备失败！"
    exit 1
fi

echo ""
echo "[3/3] 打包应用程序..."
echo ""
echo "请选择打包平台:"
echo "1. macOS (当前系统推荐)"
echo "2. Windows"
echo "3. 两者都打包"
echo ""
read -p "请输入选择 (1/2/3): " choice

case $choice in
    1)
        npm run build:mac
        ;;
    2)
        npm run build:win
        ;;
    3)
        npm run build:all
        ;;
    *)
        echo "无效选择，默认打包 macOS 版本"
        npm run build:mac
        ;;
esac

echo ""
echo "========================================"
echo "构建完成！"
echo "输出文件夹: dist/"
echo "========================================"
