
# SVGA Editor Pro

一款专业的 SVGA 动画编辑桌面应用，基于 Electron + React 构建。

## 功能特性

- **加载 SVGA** - 支持 URL 或本地文件加载，支持拖放
- **实时预览** - 高性能 Canvas 渲染，帧缓存 + 预计算，流畅播放
- **FPS 与帧数调整** - 修改帧率和动画帧数，实时预览效果
- **图层管理** - 查看所有精灵图层，支持新增/删除/复制/排序
- **资源面板** - 提取内嵌图片资源，缩略图预览
- **插槽配置** - 支持文本插槽（setText）和图片插槽（setImage）
- **图片压缩** - WebP 转换、智能压缩、尺寸缩减
- **优化预设** - 内置多种优化预设（无损/均衡/高压缩/自定义）
- **多格式导出** - SVGA / PNG 序列 / WebP
- **快捷键** - Ctrl+O 打开文件、Ctrl+S 保存、Ctrl+E 导出、空格播放暂停

## 安装使用

### 下载安装包

前往 [Releases](../../releases) 页面下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| Windows | `SVGA Editor Pro Setup x.x.x.exe`（安装版）或便携版 |
| macOS | `SVGA Editor Pro-x.x.x.dmg` |

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/你的用户名/svga-editer.git
cd svga-editer

# 安装依赖
npm install

# 运行开发模式
npm run dev

# 构建 Web 版本
npm run build:web

# 构建 Windows 版本
npm run build:win

# 构建 macOS 版本
npm run build:mac

# 构建当前平台
npm run build
```

## 使用指南

1. **载入 SVGA** - 文件菜单打开、Ctrl+O、或拖放 `.svga` 文件
2. **预览动画** - 空格键播放/暂停，拖动时间轴逐帧查看
3. **调整参数** - 在右侧属性面板设置 FPS（帧率）和帧数
4. **配置插槽** - 在插槽面板查询可用插槽名，配置文本或图片
5. **导出** - 在右侧导出面板选择格式和优化配置，或 Ctrl+E 快捷导出

## 技术栈

- [Electron](https://www.electronjs.org/) 28 - 跨平台桌面应用框架
- [React](https://react.dev/) 18 - UI 组件框架
- [TypeScript](https://www.typescriptlang.org/) - 类型安全
- [Vite](https://vitejs.dev/) 5 - 构建工具
- [Zustand](https://zustand-demo.pmnd.rs/) - 状态管理
- [Tailwind CSS](https://tailwindcss.com/) - 样式框架
- [Protobuf.js](https://protobufjs.github.io/protobuf.js/) - Protocol Buffers 编解码
- [pako](https://github.com/nicedoc/pako) - zlib 压缩/解压
- [JSZip](https://stuk.github.io/jszip/) - ZIP 文件处理

## 开发相关

### 项目结构

```
svga-editer/
├── electron/              # Electron 主进程
│   ├── main.ts            # 主进程入口
│   └── preload.ts         # 预加载脚本（IPC 桥接）
├── src/
│   ├── main.tsx           # React 应用入口
│   ├── App.tsx            # 主应用组件
│   ├── components/        # UI 组件
│   │   ├── editor/        # 编辑器核心组件（预览/播放控制/时间轴）
│   │   ├── panels/        # 功能面板（图层/资源/属性/插槽/导出/时间轴）
│   │   └── ui/            # 基础 UI 组件（按钮/输入/滑块/面板/图标）
│   ├── core/              # 核心逻辑
│   │   ├── parser.ts      # SVGA 文件解析
│   │   ├── exporter.ts    # SVGA 导出引擎
│   │   ├── renderer.*.ts  # 多种渲染器（标准/高性能/官方）
│   │   ├── optimizer.ts   # 优化引擎
│   │   ├── svga-builder.ts# SVGA 构建器
│   │   ├── svga-proto.ts  # Protobuf 协议
│   │   ├── animation-engine.ts # 动画引擎
│   │   ├── layer-factory.ts    # 图层工厂
│   │   └── resource-*.ts  # 资源管理/预加载
│   ├── stores/            # Zustand 状态管理
│   │   └── editorStore.ts # 编辑器全局状态
│   ├── types/             # TypeScript 类型定义
│   ├── utils/             # 工具函数
│   └── styles/            # 全局样式
├── public/                # 静态资源
├── docs/                  # 设计文档
├── index.html             # HTML 入口
├── vite.config.ts         # Vite 配置
├── tailwind.config.js     # Tailwind 配置
├── tsconfig.json          # TypeScript 配置
└── package.json
```

### 自动构建

项目配置了 GitHub Actions，推送 tag 时自动构建并发布：

```bash
git tag v2.0.0
git push --tags
```

## 许可证

[MIT](LICENSE)

## 致谢

基于 [博客文章](https://www.cnblogs.com/yalong/p/19702246) 的思路开发，升级为 React + TypeScript + Vite 模块化架构。

---

**作者**: 郑任光
**版本**: 2.0.0
