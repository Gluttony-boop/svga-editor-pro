
# SVGA Editor

一款专业的 SVGA 动画编辑桌面应用，基于 Electron 构建。

## 功能特性

- **加载 SVGA** - 支持 URL 或本地文件加载
- **FPS 与时长调整** - 修改帧率和动画时长，实时预览效果
- **插槽配置** - 支持文本插槽（setText）和图片插槽（setImage）
- **SVGA 分解** - 提取内嵌图片资源，缩略图预览
- **图片处理**
  - 尺寸缩减：按百分比缩小图片尺寸，减小文件体积
  - 智能压缩：WebP 转换、PNG 索引色压缩（256/128/64色）
- **导出功能** - 导出修改后的 SVGA 文件或图片资源包（ZIP）

## 安装使用

### 下载安装包

前往 [Releases](../../releases) 页面下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| Windows | `SVGA Setup 1.0.0.exe`（安装版）或 `SVGA 1.0.0.exe`（便携版）|
| macOS | `SVGA-1.0.0.dmg` |

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/你的用户名/svga-editor.git
cd svga-editor

# 安装依赖
npm install

# 运行开发模式
npm start

# 构建 Windows 版本
npm run build:win

# 构建 macOS 版本
npm run build:mac

# 构建所有平台
npm run build:all
```

## 使用指南

1. **载入 SVGA** - 输入 URL 或选择本地 `.svga` 文件
2. **调整参数** - 设置 FPS（帧率）和动画时长
3. **配置插槽** - 点击「查询插槽」获取可用的插槽名，选择文本或图片模式进行配置
4. **图片处理**（可选）- 启用尺寸缩减或图片压缩
5. **导出** - 导出修改后的 SVGA 文件

## 技术栈

- [Electron](https://www.electronjs.org/) - 跨平台桌面应用框架
- [SVGA.js](https://github.com/svga/SVGAPlayer-Web) - SVGA 动画播放器
- [JSZip](https://stuk.github.io/jszip/) - ZIP 文件处理
- [Protobuf.js](https://protobufjs.github.io/protobuf.js/) - Protocol Buffers 编解码
- [UPNG.js](https://github.com/photopea/UPNG.js/) - PNG 图片压缩

## 开发相关

### 项目结构

```
svga-editor/
├── main.js          # Electron 主进程
├── preload.js       # 预加载脚本
├── index.html       # 应用界面
├── assets/          # 静态资源
├── build.js         # 构建脚本
└── dist/            # 构建输出
```

### 自动构建

项目配置了 GitHub Actions，推送 tag 时自动构建并发布：

```bash
git tag v1.0.0
git push --tags
```

## 许可证

[MIT](LICENSE)

## 致谢

基于 [博客文章](https://www.cnblogs.com/yalong/p/19702246) 的思路开发，增加了 FPS 调整、时长修改、图片尺寸缩减、智能压缩等功能。

---

**作者**: 郑任光
