# SVGA Editor Pro — Tauri + PixiJS 迁移方案

> 作者：AI Assistant | 日期：2026-04-23 | 状态：Draft

---

## 一、当前架构痛点分析

### 1.1 Electron 瓶颈

| 痛点 | 影响 |
|------|------|
| **包体巨大** | Electron 运行时 ~150MB+，打包后 200MB+ |
| **内存占用高** | Chromium 多进程架构，空闲时也占 200MB+ |
| **启动慢** | Chromium 初始化耗时 2-5s |
| **CPU 占用** | Node.js 主进程 + Chromium 渲染进程 双重开销 |
| **跨平台差异** | Windows/macOS 行为不一致，无框窗口处理复杂 |

### 1.2 渲染层瓶颈

| 痛点 | 代码位置 | 影响 |
|------|----------|------|
| **三套渲染器共存** | `renderer.ts` / `renderer.high-performance.ts` / `renderer.official.ts` | 维护成本高，切换有闪烁 |
| **Canvas 2D 瓶颈** | 所有渲染器基于 Canvas 2D API | 无法利用 GPU 加速，大量精灵时掉帧 |
| **帧缓存 LRU 30 帧** | `CanvasRenderer` 帧缓存 | 复杂动画（100+图层 × 300帧）内存爆炸 |
| **离屏 Canvas 拷贝** | 每帧 drawImage 从离屏到主 Canvas | GPU→CPU→GPU 往返，性能浪费 |
| **requestAnimationFrame 驱动** | `CanvasPreview.tsx` | 与 React 渲染周期耦合，帧率不稳定 |

### 1.3 UI 层瓶颈

| 痛点 | 代码位置 | 影响 |
|------|----------|------|
| **CustomEvent 通信** | `svga-frame-update` / `svga-manual-frame` / `svga-fps-update` | 类型不安全，事件泄漏风险 |
| **Zustand 高频更新** | `editorStore.ts` 21KB 单一大 Store | 播放时 store 更新触发 React 重渲染 |
| **Timeline 虚拟化缺失** | `Timeline.tsx` 直接渲染所有帧 | 300帧 = 300个 DOM 节点，卡顿 |
| **时间轴和预览联动** | `PlaybackControls.tsx` 本地 state + CustomEvent | 状态分散，同步问题 |

---

## 二、新架构设计

### 2.1 技术选型

| 层面 | 选型 | 理由 |
|------|------|------|
| **桌面框架** | **Tauri v2** | Rust 后端，包体 ~5MB，内存 ~30MB，原生 WebView |
| **前端框架** | **React 18** | 保持现有 React 生态，团队熟悉 |
| **渲染引擎** | **PixiJS v8** | WebGL 优先，Canvas 2D 降级，精灵批量渲染 |
| **状态管理** | **Zustand** (优化用法) | 保持现有，拆分 Store 减少重渲染 |
| **构建工具** | **Vite** | 保持现有，Tauri 官方推荐 |
| **样式** | **TailwindCSS** | 保持现有 |
| **类型** | **TypeScript** | 保持现有 |

### 2.2 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        Tauri Window                         │
│                    (WebView2/WebKitGTK)                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────────────────────────────┐ │
│  │   React UI   │  │          PixiJS Application          │ │
│  │              │  │                                      │ │
│  │  ┌────────┐  │  │  ┌──────────┐  ┌──────────────────┐ │ │
│  │  │ Panels │  │  │  │  Stage   │  │  Sprite Pool     │ │ │
│  │  │ Layers │  │  │  │          │  │  (批量渲染)       │ │ │
│  │  │ Props  │  │  │  │ ┌──────┐ │  │                  │ │ │
│  │  │ Slots  │  │  │  │ │Canvas│ │  │  ┌────────────┐  │ │ │
│  │  │ Export │  │  │  │ │ View │ │  │  │ Sprite[]   │  │ │ │
│  │  └────────┘  │  │  │ └──────┘ │  │  │ (GPU加速)  │  │ │ │
│  │              │  │  │          │  │  └────────────┘  │ │ │
│  │  ┌────────┐  │  │  │ ┌──────┐ │  │                  │ │ │
│  │  │Timeline│  │  │  │ │Time- │ │  │  ┌────────────┐  │ │ │
│  │  │(Canvas)│  │  │  │ │line  │ │  │  │ Filters    │  │ │ │
│  │  └────────┘  │  │  │ │Layer │ │  │  │ (BlendMode)│  │ │ │
│  │              │  │  │ └──────┘ │  │  └────────────┘  │ │ │
│  │  ┌────────┐  │  │  └──────────┘  └──────────────────┘ │ │
│  │  │Playback│  │  │                                      │ │
│  │  │Controls│  │  │  ┌──────────────────────────────────┐│ │
│  │  └────────┘  │  │  │       Ticker (RAF Loop)          ││ │
│  │              │  │  │  固定帧率 / 自适应 / 手动步进    ││ │
│  └──────────────┘  │  └──────────────────────────────────┘│ │
│         │          │                    │                  │ │
│         │  Store   │            Frame State               │ │
│         │ (Zustand)│           (内部状态)                 │ │
│         └────┬─────┘                    │                  │ │
│              │                          │                  │ │
│              └──────── IPC ─────────────┘                  │ │
│                    (Tauri Commands)                         │ │
├─────────────────────────────────────────────────────────────┤
│                     Rust Backend                            │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ File I/O     │  │ SVGA Parser  │  │ Image Process    │  │
│  │ (异步读写)   │  │ (Protobuf)   │  │ (压缩/缩放/WebP) │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ SVGA Builder │  │ Optimizer    │  │ Exporter         │  │
│  │ (合并/新建)  │  │ (压缩/精简)  │  │ (SVGA/PNG/WebP) │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 核心设计原则

1. **渲染与 UI 分离**：PixiJS Application 独立运行，React 只管理面板/控件
2. **Rust 处理重计算**：Protobuf 编解码、图片处理、文件 I/O 全部在 Rust 侧
3. **GPU 优先渲染**：PixiJS WebGL 批量渲染精灵，避免逐帧 Canvas 2D 绘制
4. **虚拟化时间轴**：Canvas 绘制时间轴，只渲染可视区域
5. **增量状态更新**：Store 拆分，播放帧状态不进全局 Store

---

## 三、模块迁移映射

### 3.1 前端 → 前端 (WebView 侧)

| 当前模块 | 迁移后 | 变化说明 |
|----------|--------|----------|
| `src/core/parser.ts` | **删除** → Tauri Command | 解析移至 Rust |
| `src/core/renderer.ts` | **删除** → PixiJS 渲染器 | Canvas 2D → WebGL |
| `src/core/renderer.high-performance.ts` | **删除** → PixiJS 渲染器 | 合并为单一渲染器 |
| `src/core/renderer.official.ts` | **删除** → PixiJS 渲染器 | 合并为单一渲染器 |
| `src/core/renderer.worker.ts` | **删除** | 不再需要 Worker |
| `src/core/animation-engine.ts` | **保留** | 前端仍需要插值计算 |
| `src/core/layer-factory.ts` | **保留** | 编辑态图层创建 |
| `src/core/resource-preloader.ts` | **简化** | PixiJS 内置纹理加载 |
| `src/core/audio-manager.ts` | **保留** | 前端 Web Audio API |
| `src/stores/editorStore.ts` | **拆分** | 拆为多个 Store |
| `src/components/editor/CanvasPreview.tsx` | **重写** | Canvas → PixiJS Stage |
| `src/components/editor/Timeline.tsx` | **重写** | DOM → Canvas 绘制 |
| `src/components/editor/PlaybackControls.tsx` | **优化** | 细粒度订阅 + 事件 |
| `src/components/panels/*` | **保留** | 仅调整数据源 |
| `src/components/ui/*` | **保留** | 无变化 |
| `src/types/svga.ts` | **保留** | 核心类型不变 |

### 3.2 后端 → Rust (Tauri 侧)

| 当前模块 | Rust 对应 | 说明 |
|----------|-----------|------|
| `src/core/parser.ts` | `src-tauri/src/parser.rs` | protobuf 解码 + 图片提取 |
| `src/core/exporter.ts` | `src-tauri/src/exporter.rs` | SVGA/PNG/WebP 导出 |
| `src/core/svga-builder.ts` | `src-tauri/src/builder.rs` | SVGA 构建/合并 |
| `src/core/optimizer.ts` | `src-tauri/src/optimizer.rs` | 图片压缩/帧精简 |
| `src/core/svga-proto.ts` | `src-tauri/proto/svga.proto` | Protobuf 定义 |
| `src/core/svga-proto-lite.ts` | (合并到 proto) | Lite 版合并 |
| Electron IPC | Tauri Commands | 文件对话框/读写/窗口控制 |

### 3.3 通信方式

| 场景 | 方式 | 说明 |
|------|------|------|
| 前端 → Rust (解析) | `invoke('parse_svga', { buffer })` | 异步 Command |
| 前端 → Rust (导出) | `invoke('export_svga', { config })` | 异步 Command |
| Rust → 前端 (进度) | `emit('export-progress', { percent })` | 事件推送 |
| 前端 ↔ PixiJS | 直接引用 + 事件 | 同一 WebView 内 |
| React ↔ PixiJS | Store + ref callback | Zustand bridge |

---

## 四、PixiJS 渲染器设计

### 4.1 核心架构

```typescript
// src/rendering/svga-pixi-renderer.ts

export class SVGAPixiRenderer {
  private app: Application
  private stage: Container
  private spritePool: Map<string, Sprite>     // 精灵池
  private textureCache: Map<string, Texture>   // 纹理缓存
  private frameCache: Map<number, Container>   // 帧缓存（可选）

  // 核心渲染流程
  async renderFrame(frameIndex: number): void {
    // 1. 清空 Stage
    this.stage.removeChildren()

    // 2. 遍历 sprites，更新精灵属性
    for (const sprite of this.videoItem.movie.sprites) {
      const frame = sprite.frames[frameIndex]
      if (!frame || frame.alpha <= 0) continue

      // 3. 从池中获取/创建 PixiJS Sprite
      let pixiSprite = this.spritePool.get(sprite.imageKey)
      if (!pixiSprite) {
        const texture = this.textureCache.get(sprite.imageKey)
        pixiSprite = new Sprite(texture)
        this.spritePool.set(sprite.imageKey, pixiSprite)
      }

      // 4. 应用变换矩阵
      if (frame.transform) {
        const { a, b, c, d, tx, ty } = frame.transform
        pixiSprite.transform.setFromMatrix(new Matrix(a, b, c, d, tx, ty))
      }

      // 5. 应用 Layout
      if (frame.layout) {
        pixiSprite.x = frame.layout.x
        pixiSprite.y = frame.layout.y
        pixiSprite.width = frame.layout.width
        pixiSprite.height = frame.layout.height
      }

      // 6. Alpha + BlendMode
      pixiSprite.alpha = frame.alpha ?? 1
      if (frame.blendMode) {
        pixiSprite.blendMode = mapBlendMode(frame.blendMode)
      }

      // 7. 添加到 Stage
      this.stage.addChild(pixiSprite)
    }
  }
}
```

### 4.2 PixiJS vs Canvas 2D 性能对比

| 维度 | Canvas 2D (当前) | PixiJS WebGL (新) |
|------|------------------|-------------------|
| 精灵渲染 | 逐个 `drawImage` | 批量 `gl.drawArrays` |
| 变换矩阵 | JS 计算 + `setTransform` | GPU 矩阵运算 |
| Alpha 混合 | CPU 逐像素 | GPU Blend |
| 纹理管理 | 手动 Image 预加载 | TextureAtlas + 缓存 |
| 帧缓存 | Canvas → ImageData → LRU | GPU 纹理常驻 |
| 批量渲染 | 不支持 | ParticleContainer / BatchRenderer |

### 4.3 关键性能优化

1. **Sprite 批量渲染**：使用 `@pixi/sprite-tiling` 或 `ParticleContainer`
2. **纹理预加载**：所有图片在解析时一次性转为 PixiJS Texture
3. **脏标记**：仅重绘发生变化的图层
4. **帧预计算**：所有帧变换数据预计算为 Float32Array
5. **WebGL 降级**：自动降级到 Canvas 2D（PixiJS 内置）

---

## 五、Tauri Rust 后端设计

### 5.1 核心模块

```rust
// src-tauri/src/main.rs

mod parser;      // SVGA 解析
mod exporter;    // SVGA 导出
mod builder;     // SVGA 构建/合并
mod optimizer;   // SVGA 优化

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            parser::parse_svga,
            parser::parse_svga_from_file,
            exporter::export_svga,
            exporter::export_png_sequence,
            builder::build_svga,
            builder::merge_svga,
            optimizer::optimize_svga,
            commands::open_file_dialog,
            commands::save_file_dialog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 5.2 Rust 解析器

```rust
// src-tauri/src/parser.rs

use prost::Message;

#[tauri::command]
pub async fn parse_svga(buffer: Vec<u8>) -> Result<SvgaData, String> {
    // 1. 检测文件头
    let (version, data) = detect_header(&buffer)?;

    // 2. 解压缩
    let decompressed = decompress(data, version)?;

    // 3. Protobuf 解码
    let movie = MovieEntity::decode(&decompressed[..])
        .map_err(|e| e.to_string())?;

    // 4. 提取图片（转为 base64 传给前端）
    let images = extract_images(&movie);

    Ok(SvgaData {
        version: movie.version,
        params: movie.params.into(),
        sprites: movie.sprites.into_iter().map(|s| s.into()).collect(),
        images,
    })
}
```

### 5.3 数据传输优化

| 方案 | 适用场景 | 性能 |
|------|----------|------|
| `Vec<u8>` 直接传 | 小文件 (<10MB) | 中等，需序列化 |
| **临时文件 + URL** | 大文件/图片 | 最优，零拷贝 |
| SharedArrayBuffer | 需要前端处理 buffer | 好但需 COOP/COEP |

**推荐方案**：大图片通过临时文件路径传递，前端用 `PIXI.Texture.from(url)` 加载。

---

## 六、Store 拆分设计

### 6.1 当前问题

`editorStore.ts` 21KB 单一大 Store，所有状态更新触发订阅者重渲染。播放时 `currentFrame` 每秒更新 24-60 次，导致面板组件不必要的重渲染。

### 6.2 拆分方案

```typescript
// stores/fileStore.ts — 文件状态（低频）
interface FileStore {
  currentSource: string | null
  sourceType: 'file' | 'url' | null
  videoItem: VideoItem | null
  originalBuffer: ArrayBuffer | null
  isDirty: boolean
}

// stores/animationStore.ts — 动画参数（低频）
interface AnimationStore {
  params: MovieParams | null
  customFps: number | null
  customFrames: number | null
}

// stores/layerStore.ts — 图层状态（中频）
interface LayerStore {
  layers: Layer[]
  selectedLayerId: string | null
}

// stores/resourceStore.ts — 资源状态（低频）
interface ResourceStore {
  imageResources: Map<string, ImageResource>
  audioResources: Map<string, AudioResource>
}

// stores/playbackStore.ts — 播放状态（高频，独立）
// 不触发 React 重渲染，通过 PixiJS Ticker 更新
interface PlaybackStore {
  isPlaying: boolean
  currentFrame: number   // 不走 React 渲染
  totalFrames: number
  fps: number
  loop: boolean
  speed: number
}

// stores/exportStore.ts — 导出配置（低频）
interface ExportStore {
  compressionConfig: CompressionConfig
  optimizationConfig: OptimizationConfig
  isExporting: boolean
  exportProgress: number
}

// stores/slotStore.ts — 插槽配置（低频）
interface SlotStore {
  slotConfigs: Record<string, SlotConfig>
  detectedSlots: string[]
}

// stores/uiStore.ts — UI 状态（中频）
interface UIStore {
  zoom: number
  canvasOffset: { x: number; y: number }
  showGrid: boolean
  showOnionSkin: boolean
  rendererMode: string
}
```

### 6.3 播放帧状态方案

播放时的帧更新**不走 React 状态**，而是通过 PixiJS 的 `Ticker` 驱动：

```
Ticker (60fps)
  → 更新 playbackStore.currentFrame (不触发 React)
  → PixiJS 渲染当前帧 (GPU)
  → 每 4 帧发一次 CustomEvent 更新 UI (帧计数器/时间轴)
```

---

## 七、时间轴 Canvas 化

### 7.1 当前问题

`Timeline.tsx` 使用 DOM 渲染：
- 300 帧 = 300+ 个 `<div>` 节点
- 帧刻度、网格线、播放头、关键帧标记全是 DOM 元素
- 滚动时 React 重新计算布局

### 7.2 Canvas 时间轴方案

```typescript
// src/components/editor/TimelineCanvas.tsx

class TimelineCanvasRenderer {
  private ctx: CanvasRenderingContext2D
  private viewportStart: number = 0  // 可视区起始帧
  private viewportEnd: number = 50   // 可视区结束帧

  render(state: TimelineState): void {
    const { ctx } = this
    ctx.clearRect(0, 0, this.width, this.height)

    // 只渲染可视区域的帧
    for (let f = this.viewportStart; f <= this.viewportEnd; f++) {
      this.drawFrameTick(f)
      this.drawKeyframeMarkers(f, state.keyframes)
    }

    this.drawPlayhead(state.currentFrame)
    this.drawLayerTracks(state.layers)
  }
}
```

**优势**：
- 帧数再多也只渲染 ~50 帧的可视区域
- 滚动 = 改变 viewportStart/End + 重绘
- 关键帧标记、拖拽交互用 Canvas hitTest

---

## 八、迁移路径（分阶段）

### Phase 1：Tauri 骨架 + Rust 解析器（2-3 天）

1. 初始化 Tauri v2 项目结构
2. Rust 端实现 SVGA 解析器（Protobuf 解码 + 图片提取）
3. 定义 Tauri Commands（`parse_svga`, `open_file`, `save_file`）
4. 前端接入 Tauri API 替换 Electron API
5. **验证**：能打开并解析 SVGA 文件

### Phase 2：PixiJS 渲染器（3-4 天）

1. 集成 PixiJS v8，创建 Application
2. 实现 `SVGAPixiRenderer`（精灵渲染 + 变换矩阵 + Alpha + BlendMode）
3. 实现纹理预加载（解析后一次性创建 Texture）
4. 实现 Ticker 驱动动画循环
5. **验证**：SVGA 动画流畅播放，FPS 稳定

### Phase 3：Store 拆分 + 播放优化（2 天）

1. 拆分 `editorStore` 为 7 个独立 Store
2. 播放帧状态走 PixiJS Ticker，不进 React
3. 面板组件细粒度订阅
4. **验证**：播放时面板无卡顿

### Phase 4：Canvas 时间轴（2 天）

1. 实现 `TimelineCanvasRenderer`
2. 虚拟化帧渲染（只绘制可视区域）
3. 关键帧拖拽交互（Canvas hitTest）
4. **验证**：300 帧时间轴流畅滚动

### Phase 5：Rust 导出/优化器（2-3 天）

1. Rust 端实现 SVGA 导出（Protobuf 编码 + 压缩）
2. Rust 端实现图片优化（压缩/缩放/格式转换）
3. PNG 序列导出（Rust 端渲染 + 打包）
4. **验证**：导出文件与原版一致

### Phase 6：完善 + 测试（2 天）

1. 插槽系统迁移
2. 图层编辑 + 动画预设
3. 窗口管理 + 菜单
4. 跨平台测试 (Windows / macOS)
5. 打包体积优化

**总工期估计：13-16 天**

---

## 九、风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| Rust Protobuf 生态不如 JS | 解析可能有兼容问题 | 优先用 `prost` + 手写 proto；紧急时走 JS 前端解析 |
| PixiJS 变换矩阵与 SVGA 不一致 | 渲染位置偏移 | 仔细对照 SVGA 的 a/b/c/d/tx/ty 与 PixiJS Matrix |
| Tauri v2 尚在 beta | API 可能变化 | 锁定版本，关注 changelog |
| 图片大文件传输 | 前后端传输瓶颈 | 临时文件路径 + URL 方案 |
| macOS WebView 差异 | 渲染/布局问题 | WebView2 (Win) / WebKit (mac) 分别测试 |

---

## 十、包体与性能预期

| 指标 | Electron (当前) | Tauri + PixiJS (预期) | 改善 |
|------|-----------------|----------------------|------|
| 安装包大小 | ~200MB | ~15MB | **93%↓** |
| 运行时内存 | ~250MB | ~50MB | **80%↓** |
| 冷启动时间 | ~3s | ~0.5s | **83%↓** |
| 播放 FPS (100层) | ~15-20 FPS | ~55-60 FPS | **3x↑** |
| 解析时间 (5MB SVGA) | ~800ms | ~100ms (Rust) | **8x↑** |
| 导出时间 | ~2s | ~200ms (Rust) | **10x↑** |

---

## 十一、目录结构（迁移后）

```
d:/CompanyProject/svga-editer/
├── src-tauri/                          # Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json               # Tauri 权限配置
│   ├── src/
│   │   ├── main.rs                     # 入口
│   │   ├── parser.rs                   # SVGA 解析
│   │   ├── exporter.rs                 # SVGA 导出
│   │   ├── builder.rs                  # SVGA 构建/合并
│   │   ├── optimizer.rs               # SVGA 优化
│   │   └── commands.rs                 # 通用 Commands
│   └── proto/
│       └── svga.proto                  # Protobuf 定义
│
├── src/                                # 前端
│   ├── main.tsx                        # React 入口
│   ├── App.tsx                         # 主布局
│   │
│   ├── rendering/                      # 🆕 PixiJS 渲染层
│   │   ├── index.ts
│   │   ├── svga-pixi-renderer.ts       # 核心渲染器
│   │   ├── sprite-pool.ts             # 精灵池管理
│   │   ├── texture-manager.ts         # 纹理管理
│   │   ├── animation-ticker.ts        # 动画 Ticker
│   │   └── blend-mode-map.ts          # 混合模式映射
│   │
│   ├── core/                           # 前端核心逻辑
│   │   ├── animation-engine.ts         # 保留：插值计算
│   │   ├── layer-factory.ts           # 保留：图层工厂
│   │   ├── audio-manager.ts           # 保留：音频管理
│   │   ├── resource-manager.ts        # 保留：资源管理
│   │   ├── svga-proto.ts             # 保留：前端 Protobuf (备用)
│   │   └── index.ts
│   │
│   ├── stores/                         # 拆分后的 Store
│   │   ├── fileStore.ts               # 🆕 文件状态
│   │   ├── animationStore.ts          # 🆕 动画参数
│   │   ├── layerStore.ts             # 🆕 图层状态
│   │   ├── resourceStore.ts          # 🆕 资源状态
│   │   ├── playbackStore.ts          # 🆕 播放状态
│   │   ├── exportStore.ts            # 🆕 导出配置
│   │   ├── slotStore.ts              # 🆕 插槽配置
│   │   ├── uiStore.ts               # 🆕 UI 状态
│   │   └── index.ts
│   │
│   ├── components/
│   │   ├── editor/
│   │   │   ├── CanvasPreview.tsx      # 重写：PixiJS Stage
│   │   │   ├── TimelineCanvas.tsx     # 🆕 Canvas 时间轴
│   │   │   ├── PlaybackControls.tsx   # 优化：细粒度订阅
│   │   │   └── index.ts
│   │   ├── panels/                     # 保留：调整数据源
│   │   └── ui/                         # 保留：无变化
│   │
│   ├── types/                          # 保留
│   ├── utils/                          # 保留
│   └── styles/                         # 保留
│
├── index.html
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
└── package.json
```

---

## 十二、立即行动清单

- [ ] 安装 Tauri v2 CLI：`npm install -g @tauri-apps/cli@next`
- [ ] 初始化 `src-tauri/` 目录：`tauri init`
- [ ] 添加 PixiJS v8：`npm install pixi.js@^8`
- [ ] 创建 `src/rendering/` 目录
- [ ] 实现 `SVGAPixiRenderer` 骨架
- [ ] 实现 Rust Protobuf 解析器
- [ ] 验证端到端流程：打开文件 → 解析 → 渲染 → 播放
