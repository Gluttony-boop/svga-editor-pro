# SVGA Editor Pro 打包说明

本文档记录当前项目的打包方法。项目已经使用 Tauri 作为桌面端打包方案，主要命令以 `package.json` 中的 `tauri build` 脚本为准。

## 一、环境要求

打包前请确认本机已安装以下环境：

1. Node.js 18 或更高版本，推荐 Node.js 20。
2. npm，随 Node.js 一起安装。
3. Rust 工具链，包含 `rustc` 和 `cargo`。
4. Tauri 对应平台依赖。

Windows 打包建议安装：

- Microsoft C++ Build Tools 或 Visual Studio Build Tools。
- Windows WebView2 Runtime。

macOS 打包建议安装：

- Xcode Command Line Tools。

## 二、安装依赖

首次拉取项目后，在项目根目录执行：

```bash
npm install
```

如果在国内网络环境安装较慢，可以临时使用镜像源：

```bash
npm install --registry=https://registry.npmmirror.com
```

## 三、开发运行

普通 Web 开发模式：

```bash
npm run dev
```

Tauri 桌面端开发模式：

```bash
npm run dev:tauri
```

## 四、打包命令

### 1. 打包当前平台

在当前操作系统上打包对应平台安装包：

```bash
npm run build
```

该命令等价于：

```bash
tauri build
```

Tauri 会在打包前自动执行 `npm run build:web`，因为 `src-tauri/tauri.conf.json` 中配置了：

```json
{
  "build": {
    "beforeBuildCommand": "npm run build:web",
    "frontendDist": "../dist"
  }
}
```

### 2. 仅构建前端 Web 产物

如果只需要生成前端静态资源：

```bash
npm run build:web
```

输出目录：

```text
dist/
```

### 3. Windows 打包

在 Windows 环境中执行：

```bash
npm run build:win
```

该命令会执行：

```bash
tauri build --target x86_64-pc-windows-msvc
```

常见输出目录：

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/
```

如果直接执行 `npm run build`，常见输出目录为：

```text
src-tauri/target/release/bundle/
```

Windows 产物通常在以下子目录中：

```text
src-tauri/target/**/release/bundle/nsis/
src-tauri/target/**/release/bundle/msi/
```

### 4. macOS 打包

在 macOS 环境中执行：

```bash
npm run build:mac
```

该命令会执行：

```bash
tauri build --target universal-apple-darwin
```

常见输出目录：

```text
src-tauri/target/universal-apple-darwin/release/bundle/
```

macOS 产物通常在以下子目录中：

```text
src-tauri/target/**/release/bundle/dmg/
src-tauri/target/**/release/bundle/macos/
```

## 五、推荐打包流程

### Windows

```bash
npm install
npm run build:win
```

打包完成后，到以下目录查找安装包：

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/
```

### macOS

```bash
npm install
npm run build:mac
```

打包完成后，到以下目录查找安装包：

```text
src-tauri/target/universal-apple-darwin/release/bundle/
```

### 当前平台

```bash
npm install
npm run build
```

打包完成后，到以下目录查找安装包：

```text
src-tauri/target/release/bundle/
```

## 六、版本号与应用信息

打包版本号主要来自：

```text
package.json
src-tauri/tauri.conf.json
src-tauri/Cargo.toml
```

发布前建议保持以下字段一致：

- `package.json` 中的 `version`
- `src-tauri/tauri.conf.json` 中的 `version`
- `src-tauri/Cargo.toml` 中的 `version`

当前应用信息：

```text
productName: SVGA Editor Pro
identifier: com.svga.editor.pro
version: 2.0.0
```

## 七、注意事项

1. Windows 安装包建议在 Windows 机器上打包。
2. macOS 安装包建议在 macOS 机器上打包。
3. `npm run build:web` 只生成前端 `dist/`，不会生成桌面安装包。
4. Tauri 桌面安装包不在 `dist/` 中，而是在 `src-tauri/target/**/release/bundle/` 中。
5. 当前 `package.json` 未配置 `build:all` 脚本，如果旧脚本中提示执行 `npm run build:all`，需要先补充该脚本或改用 `npm run build:win` / `npm run build:mac`。
6. `build.bat`、`build.sh`、`build-mac.sh` 包含较早的打包流程说明，当前推荐优先使用 `package.json` 中的 Tauri 打包命令。

## 八、常见问题

### npm install 失败

可以尝试切换 npm 镜像源：

```bash
npm config set registry https://registry.npmmirror.com
npm install
```

### Windows 打包失败

检查是否安装了：

- Rust 工具链。
- Microsoft C++ Build Tools。
- Windows WebView2 Runtime。

也可以先单独验证前端是否能构建：

```bash
npm run build:web
```

### macOS 打包失败

检查是否安装了 Xcode Command Line Tools：

```bash
xcode-select --install
```

### 找不到安装包

不要只看 `dist/` 目录。Tauri 安装包一般在：

```text
src-tauri/target/**/release/bundle/
```
