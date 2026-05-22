# SVGA 编辑器 - 打包说明

## 功能特点

✅ **源码保护** - 通过代码混淆和加密保护源代码  
✅ **跨平台支持** - 支持 Windows 和 macOS  
✅ **一键运行** - 用户无需安装Node.js或其他环境，直接运行  
✅ **两种分发方式**：
   - 安装包：用户安装后使用
   - 便携版：解压即用，无需安装

## 快速开始

### 前置要求

1. 安装 Node.js (建议 v18 或以上)
   - 下载地址: https://nodejs.org/

### Windows 用户

双击运行 `build.bat`，按提示操作即可。

或手动执行：
```bash
npm install
node build.js
npm run build:win
```

### macOS 用户

```bash
chmod +x build.sh
./build.sh
```

或手动执行：
```bash
npm install
node build.js
npm run build:mac
```

## 打包命令说明

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式运行，支持热更新 |
| `npm run build:web` | 仅构建 Web 版本 |
| `npm run build` | 打包当前平台 |
| `npm run build:win` | 仅打包 Windows 版本 |
| `npm run build:mac` | 仅打包 macOS 版本 |

## 输出文件

打包完成后，在 `dist/` 目录下会生成：

### Windows
- `SVGA编辑器 Setup x.x.x.exe` - 安装包（推荐分发）
- `SVGA编辑器 x.x.x.exe` - 便携版（解压即用）

### macOS
- `SVGA编辑器-x.x.x.dmg` - macOS 安装包
- `SVGA编辑器-x.x.x-mac.zip` - macOS 便携版

## 源码保护措施

1. **代码混淆** - 所有JavaScript代码会被混淆
   - 变量名替换为无意义字符
   - 控制流扁平化
   - 字符串加密编码
   - 死代码注入

2. **禁止调试**
   - 禁用开发者工具 (F12)
   - 禁用右键菜单
   - 禁用快捷键 (Ctrl+Shift+I/J/C, Ctrl+U)

3. **ASAR打包** - 源码打包成asar格式，不易查看

4. **代码保护** - 启用自保护机制，检测代码格式化

## 自定义图标（可选）

### Windows
放置 `icon.ico` 文件到 `assets/` 目录  
推荐尺寸: 256x256 像素

### macOS  
放置 `icon.icns` 文件到 `assets/` 目录  
推荐尺寸: 512x512 像素

### 通用
放置 `icon.png` 文件到 `assets/` 目录  
推荐尺寸: 512x512 像素

## 分发给用户

将打包好的文件发给用户：

- **Windows**: 发送 `SVGA编辑器 Setup x.x.x.exe`
- **macOS**: 发送 `SVGA编辑器-x.x.x.dmg`

用户无需安装任何环境，直接运行即可使用。

## 注意事项

1. 打包Windows版本需要在Windows系统上进行
2. 打包macOS版本需要在macOS系统上进行
3. macOS可能需要签名才能在其他电脑上运行（未签名也可运行，但需要用户在系统设置中允许）
4. 如需分发给更多用户，建议申请开发者证书进行签名

## 文件大小预估

- Windows 安装包: ~150-200MB
- Windows 便携版: ~150MB
- macOS DMG: ~200MB

## 故障排查

### 问题: npm install 失败
- 检查网络连接
- 尝试使用国内镜像: `npm config set registry https://registry.npmmirror.com`

### 问题: 打包失败
- 确保有足够的磁盘空间（至少2GB）
- 确保已安装完整的Node.js（非精简版）

### 问题: 运行时白屏
- 检查 `dist/index.html` 是否存在
- 检查控制台是否有错误（开发模式下）
