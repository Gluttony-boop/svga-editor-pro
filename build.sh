#!/bin/bash
set -e

echo "=========================================="
echo "  SVGA Editor Pro - Build Script"
echo "=========================================="

# 安装依赖
echo ""
echo "[1/3] Installing dependencies..."
npm install

# 构建前端
echo ""
echo "[2/3] Building frontend..."
npm run build:web

# 检测平台并打包
OS="$(uname -s)"
case "$OS" in
  Darwin*)
    echo ""
    echo "[3/3] Building for macOS (universal)..."
    npm run build:mac
    echo ""
    echo "Build complete! Output: src-tauri/target/universal-apple-darwin/release/bundle/"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    echo ""
    echo "[3/3] Building for Windows (x64)..."
    npm run build:win
    echo ""
    echo "Build complete! Output: src-tauri/target/x86_64-pc-windows-msvc/release/bundle/"
    ;;
  Linux*)
    echo ""
    echo "[3/3] Building for Linux..."
    npm run build
    echo ""
    echo "Build complete! Output: src-tauri/target/release/bundle/"
    ;;
  *)
    echo "Unsupported platform: $OS"
    exit 1
    ;;
esac
