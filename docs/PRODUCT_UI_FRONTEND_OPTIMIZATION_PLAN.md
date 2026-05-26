# SVGA Editor Pro 产品、UI 与前端优化执行文档

> 目标：把当前项目从“具备核心 SVGA 处理能力的编辑工具”推进到“可放心用于生产的专业 SVGA 编辑器”。
>
> 本文档用于后续交给 Codex 分阶段执行修改。每个任务都尽量写清楚：为什么要改、改哪些文件、怎么改、验收标准是什么。

## 0. 当前项目判断

当前项目已经具备比较完整的工程基础：

- Tauri 2 + React + TypeScript + Vite 桌面应用架构已经成型。
- 支持 SVGA 文件加载、URL 加载、拖拽加载、Tauri 文件关联启动。
- 已有多套渲染器：Canvas、高性能 Canvas、官方兼容、Pixi/WebGL。
- 已有图层面板、资源面板、属性面板、插槽面板、导出面板、播放控制、时间轴。
- 已有 SVGA 解析、构建、导出、优化、资源管理、音频管理等核心模块。
- 当前质量闸门通过：`typecheck`、`lint`、`test:run`、`build:web` 均可通过。

但从产品完成度看，目前仍有几个明显短板：

- 编辑安全感不足：没有撤销/重做、未保存保护、保存前风险确认。
- 时间轴更偏展示，不够像真正的动画编辑器。
- 右侧属性面板混合了图层属性、画布属性、压缩设置，信息架构需要重组。
- 部分能力已有底层状态或工厂函数，但缺少 UI 入口，例如文本图层、音频、洋葱皮。
- 导出能力强，但缺少导出前预估、兼容性检查、风险提示。
- 文档体系缺失，`docs` 目录为空，README 仍有历史架构描述不一致的问题。

---

## 1. 第一阶段：编辑器安全感与基础工作流

优先级最高。建议先完成这一阶段，再继续扩展复杂功能。

### 1.1 增加撤销 / 重做

#### 问题

当前以下操作都会改变项目状态，但没有统一历史记录：

- 图层新增、删除、复制、排序、重命名。
- 图层可见性、锁定、位置、尺寸、缩放、旋转、透明度修改。
- 资源新增、删除、替换、重命名。
- 插槽文本和图片配置。
- FPS、总帧数修改。
- 动画预设应用和关键帧修改。

专业编辑器必须支持撤销/重做，否则用户不敢进行探索式编辑。

#### 涉及文件

- `src/stores/editorStore.ts`
- `src/App.tsx`
- `src/components/ui/Icon.tsx`
- `src/components/ui/Button.tsx`
- `src/components/panels/LayerPanel.tsx`
- `src/components/panels/PropertyPanel.tsx`
- `src/components/panels/ResourcePanel.tsx`
- `src/components/panels/SlotPanel.tsx`
- `src/components/panels/ExportPanel.tsx`
- 新增：`src/stores/history.ts` 或 `src/stores/editorHistory.ts`
- 新增测试：`src/stores/editorStore.history.test.ts`

#### 具体改法

1. 在 store 中抽离“可持久化编辑状态”：

   需要纳入历史的字段：

   - `params`
   - `customFps`
   - `customFrames`
   - `layers`
   - `selectedLayerId`
   - `imageResources`
   - `audioResources`
   - `slotConfigs`
   - `detectedSlots`
   - `compressionConfig`
   - `optimizationConfig`
   - `selectedPresetId`

   不建议纳入历史的字段：

   - `playback`
   - `zoom`
   - `canvasOffset`
   - `showGrid`
   - `showOnionSkin`
   - `rendererMode`
   - `optimizationStats`
   - `loading` 类 UI 状态

2. 新增 history 状态：

   ```ts
   history: {
     past: EditorSnapshot[]
     future: EditorSnapshot[]
     maxDepth: number
     isApplyingHistory: boolean
   }
   canUndo: boolean
   canRedo: boolean
   undo: () => void
   redo: () => void
   commitHistory: (label?: string) => void
   clearHistory: () => void
   ```

3. 每个编辑 action 在写入前或写入后提交快照。

   建议采用统一 helper：

   ```ts
   const withHistory = (set, get, updater, label) => {
     const before = createSnapshot(get())
     set(updater)
     const after = createSnapshot(get())
     if (!isSameSnapshot(before, after)) pushHistory(before, label)
   }
   ```

   注意：

   - 连续拖动 slider 不要每一帧都入栈，需要 debounce 或在 pointer up 时提交。
   - 文本输入可以在 blur 或 Enter 时提交。
   - 删除、复制、应用预设这类离散操作可以立即提交。

4. 在 `App.tsx` 快捷键中增加：

   - `Ctrl+Z` / `Cmd+Z`：撤销
   - `Ctrl+Shift+Z` / `Cmd+Shift+Z`：重做
   - Windows 也可支持 `Ctrl+Y`：重做

5. 顶部工具栏增加撤销/重做图标按钮。

   当前工具栏在 `App.tsx`：

   - 打开文件
   - 打开 URL

   建议改为：

   - 打开
   - 保存
   - 撤销
   - 重做
   - 导出

6. `Icon.tsx` 里已有 `undo`、`redo` 图标，可直接复用。

7. 当 `setVideoItem` 或 `reset` 时清空历史。

#### 验收标准

- 修改图层位置后，按 `Ctrl+Z` 能恢复原位置。
- 删除图层后，按 `Ctrl+Z` 能恢复图层、资源引用和选择状态。
- 修改插槽文本后，按 `Ctrl+Z` 能恢复旧文本。
- 连续拖动透明度 slider 不会产生几十个历史节点。
- 打开新文件后不能撤销回上一个文件的状态。
- `npm run typecheck`、`npm run lint`、`npm run test:run` 通过。

---

### 1.2 增加未保存保护

#### 问题

项目已有 `isDirty`，但未形成完整保护链路。用户在以下行为中可能丢失修改：

- 打开新文件。
- 拖入新 SVGA。
- 打开 URL。
- 关闭窗口。
- 应用启动文件关联加载新文件。

#### 涉及文件

- `src/stores/editorStore.ts`
- `src/App.tsx`
- `src/lib/tauri-api.ts`
- `src-tauri/src/lib.rs`
- `src-tauri/src/commands.rs`
- `src/components/ui/Modal.tsx`

#### 具体改法

1. 在 `App.tsx` 增加统一的确认函数：

   ```ts
   async function confirmDiscardUnsavedChanges(): Promise<'save' | 'discard' | 'cancel'>
   ```

2. 对以下入口统一包一层确认：

   - `handleOpenFile`
   - `handleOpenUrl`
   - `handleDrop`
   - `loadSVGAFromFilePath`
   - 开发模式自动加载测试文件前

3. 弹窗文案建议：

   - 标题：`保存当前修改？`
   - 内容：`当前 SVGA 还有未保存修改，继续操作会丢失这些修改。`
   - 按钮：`取消`、`不保存`、`保存`

4. 如果用户选“保存”，调用 `handleSave()`，保存成功后继续原操作。

5. Tauri 关闭窗口保护：

   - 前端监听窗口 close requested。
   - 若 `isDirty` 为 true，阻止关闭，弹出确认弹窗。
   - 用户确认后再调用真实 close。

   Tauri 2 可在前端使用 `getCurrentWebviewWindow().onCloseRequested(...)`。

6. 状态栏未保存提示增强：

   当前状态栏在 `StatusBar`。建议显示：

   - 未打开文件：`等待文件`
   - 已打开且未修改：`已保存`
   - 已修改：`未保存`

7. 顶部标题文件名后显示 `*`，但需要配合 tooltip 或状态栏解释。

#### 验收标准

- 修改任一图层属性后，打开新文件会弹出保存确认。
- 选择取消时，不会打开新文件。
- 选择不保存时，会打开新文件且旧修改丢弃。
- 选择保存时，保存成功后再打开新文件。
- 点击窗口关闭按钮时也触发保护。

---

### 1.3 区分保存、另存为、导出

#### 问题

当前 `handleSave` 和 `handleExport` 的语义已经有区别，但 UI 上还不够明确：

- 保存：应该尽量覆盖当前文件。
- 另存为：保存为一个新的 SVGA。
- 导出：允许选择优化配置和其他格式。

#### 涉及文件

- `src/App.tsx`
- `src/components/panels/ExportPanel.tsx`
- `src/core/exporter.ts`
- `src/lib/tauri-api.ts`

#### 具体改法

1. 在菜单栏 `file` 菜单里新增：

   - `保存`：`Ctrl+S`
   - `另存为...`：`Ctrl+Shift+S`
   - `导出...`：`Ctrl+E`

2. 在 `App.tsx` 新增 `handleSaveAs`。

   逻辑：

   - 永远弹出保存对话框。
   - 默认文件名取当前文件名或 `export.svga`。
   - 保存成功后更新 `currentSource` 和 `sourceType`。
   - 设置 `isDirty = false`。

3. `handleSave`：

   - 如果是本地文件来源，覆盖当前文件。
   - 如果是 URL 或浏览器文件来源，自动走 `handleSaveAs`。

4. `ExportPanel` 中的“导出 SVGA”应更名为“优化导出 SVGA”。

5. “导出原始 SVGA”文案建议改为“按当前编辑导出 SVGA（不额外优化）”，避免误解为完全原文件。

#### 验收标准

- 本地打开文件后，`Ctrl+S` 覆盖当前文件。
- URL 加载文件后，`Ctrl+S` 弹出另存为。
- `Ctrl+Shift+S` 总是弹出另存为。
- 导出不会改变当前文件路径，除非明确另存为。

---

## 2. 第二阶段：属性面板与信息架构重构

### 2.1 拆分画布属性、图层属性、导出压缩

#### 问题

当前 `PropertyPanel.tsx` 混合了：

- 图层 Key
- 图层位置
- 图层尺寸
- 图层旋转
- 图层透明度
- 画布尺寸
- FPS / 总帧数
- 压缩配置

这会让用户困惑：压缩属于导出设置，不属于当前图层属性。

#### 涉及文件

- `src/components/panels/PropertyPanel.tsx`
- `src/components/panels/ExportPanel.tsx`
- `src/App.tsx`
- `src/stores/editorStore.ts`
- 可新增：`src/components/panels/CanvasPanel.tsx`

#### 具体改法

1. 新增 `CanvasPanel.tsx`，负责：

   - 画布宽度
   - 画布高度
   - FPS
   - 总帧数
   - 时长
   - 原始文件信息：来源、大小、资源数量、图层数量

2. `PropertyPanel.tsx` 只处理当前选中图层：

   - 未选中图层：显示空状态 `选择一个图层以编辑属性`
   - 图层基础：名称、Key、类型、起始帧、持续帧
   - 变换：X、Y、宽、高、缩放 X、缩放 Y、锁定比例、旋转
   - 外观：透明度、混合模式、可见性、锁定
   - 动画：当前属性是否有关键帧，添加关键帧按钮

3. 压缩配置全部移入 `ExportPanel.tsx`。

4. 右侧面板建议结构：

   ```tsx
   <CanvasPanel collapsible defaultCollapsed={false} />
   <PropertyPanel collapsible defaultCollapsed={false} />
   <SlotPanel collapsible defaultCollapsed={true} />
   <ExportPanel collapsible defaultCollapsed={true} />
   ```

5. 如果右侧高度不足，使用可滚动区域，避免面板互相挤压。

#### 验收标准

- 未选中图层时，属性面板不显示图层字段。
- 画布 FPS / 总帧数在 CanvasPanel 中编辑。
- 压缩设置只出现在 ExportPanel。
- 修改位置、尺寸、旋转、透明度仍能实时预览。

---

### 2.2 FPS / 总帧数修改增加模式选择

#### 问题

当前修改 FPS 和总帧数可能只改元数据，用户容易误以为动画已自动变速或重采样。

#### 涉及文件

- `src/components/panels/CanvasPanel.tsx`
- `src/stores/editorStore.ts`
- `src/core/exporter.ts`
- `src/core/svga-builder.ts`

#### 具体改法

短期先做 UI 风险提示：

1. 在 FPS 字段下提示：

   `修改 FPS 会影响播放速度，当前不会自动重采样每一帧。`

2. 在总帧数字段下提示：

   `修改总帧数仅改变动画时长，原始图层帧数据不会自动拉伸。`

中期增加模式：

- `metadataOnly`：只改元数据。
- `trimOrPad`：不足补空帧，超出裁剪。
- `resample`：按比例重采样每个 sprite frames。

store 增加：

```ts
timelineResizeMode: 'metadataOnly' | 'trimOrPad' | 'resample'
setTimelineResizeMode: (...)
```

导出时根据模式处理：

- `metadataOnly`：保持现有逻辑。
- `trimOrPad`：对每个 sprite.frames 做裁剪或复制最后一帧补齐。
- `resample`：按比例映射新帧到旧帧。

#### 验收标准

- UI 明确提示修改帧数的影响。
- 用户能选择总帧数处理模式。
- 对 24 帧改 48 帧，`trimOrPad` 会补齐到 48 帧。
- 对 48 帧改 24 帧，`trimOrPad` 会裁剪到 24 帧。
- `resample` 下播放节奏保持相对一致。

---

## 3. 第三阶段：时间轴编辑能力

### 3.1 支持图层 Clip 起止编辑

#### 问题

当前时间轴显示图层轨道和关键帧点，但不能直接拖动图层片段的开始、结束和整体位置。

#### 涉及文件

- `src/components/editor/Timeline.tsx`
- `src/stores/editorStore.ts`
- `src/types/svga.ts`
- `src/core/svga-builder.ts`

#### 具体改法

1. 在 `LayerTrack` 中用一个可视化 clip bar 表示：

   - `left = layer.clip.startFrame * frameWidth`
   - `width = layer.clip.duration * frameWidth`

2. clip bar 三个可交互区域：

   - 左边缘：调整开始帧。
   - 中间：整体拖动。
   - 右边缘：调整结束帧。

3. store 增加：

   ```ts
   updateLayerClip(layerId, clip: Partial<{ startFrame: number; duration: number }>)
   ```

4. 拖动时：

   - 限制 startFrame >= 0。
   - 限制 duration >= 1。
   - 限制 startFrame + duration <= totalFrames。
   - 支持按住 Shift 吸附到 5 帧刻度。

5. 拖动结束后提交历史。

#### 验收标准

- 可以拖动图层片段改变出现时间。
- 可以拖动左右边界改变持续时长。
- 导出后图层 clip 生效。
- 撤销/重做可恢复 clip 修改。

---

### 3.2 支持关键帧拖动、选择、删除

#### 问题

当前关键帧主要由动画预设生成或属性变化生成，时间轴上的点不可编辑。

#### 涉及文件

- `src/components/editor/Timeline.tsx`
- `src/stores/editorStore.ts`
- `src/core/animation-engine.ts`
- `src/types/svga.ts`

#### 具体改法

1. `LayerTrack` 中按 track 类型渲染关键帧：

   - position：蓝色
   - scale：绿色
   - rotation：黄色
   - alpha：紫色

2. 点击关键帧：

   - 单选：选中当前关键帧。
   - Shift / Ctrl：多选。

3. 拖动关键帧：

   - 更新 `frameIndex`。
   - 保持同一 track 内按帧排序。
   - 限制在 0 到 totalFrames - 1。

4. 键盘删除：

   - `Delete` 或 `Backspace` 删除选中关键帧。

5. store 增加：

   ```ts
   selectedTimelineItems: Array<{ layerId: string; trackKey: keyof LayerTracks; keyframeId: string }>
   selectTimelineKeyframe(...)
   moveLayerKeyframe(...)
   deleteSelectedKeyframes()
   ```

#### 验收标准

- 时间轴可以选中关键帧。
- 拖动关键帧后动画预览变化。
- 删除关键帧后动画恢复对应默认值或相邻插值。
- 撤销/重做可恢复关键帧操作。

---

### 3.3 增加关键帧添加入口

#### 涉及文件

- `src/components/panels/PropertyPanel.tsx`
- `src/stores/editorStore.ts`

#### 具体改法

在图层属性每个属性组右侧增加关键帧按钮：

- 位置：添加 position keyframe
- 缩放：添加 scale keyframe
- 旋转：添加 rotation keyframe
- 透明度：添加 alpha keyframe

点击后：

- 使用当前播放帧 `playback.currentFrame`
- 使用当前 default/current value
- 如果同一帧已有关键帧，则更新该关键帧而不是新增重复项

#### 验收标准

- 当前帧点击位置关键帧按钮，时间轴出现 position 关键帧。
- 同一帧重复点击不会产生重复 keyframe。
- 播放时属性按关键帧插值。

---

## 4. 第四阶段：画布交互升级

### 4.1 增加画布选择框和直接拖动图层

#### 问题

当前图层主要通过面板选择和数值编辑，画布缺少直接操作能力。

#### 涉及文件

- `src/components/editor/CanvasPreview.tsx`
- `src/core/renderer.ts`
- `src/core/renderer.high-performance.ts`
- `src/rendering/svga-pixi-renderer.ts`
- `src/stores/editorStore.ts`

#### 具体改法

1. 在 CanvasPreview 上叠加一个 HTML overlay 层。

2. 计算选中图层在当前帧的 bounding box：

   - 优先使用 frame.layout。
   - 叠加 transform、scale、rotation。
   - 考虑 zoom 和 canvasOffset。

3. 绘制选中框：

   - 8 个 resize handles。
   - 旋转 handle。
   - 中心点。

4. 支持拖动：

   - 拖动主体改变 position。
   - 拖动角点改变 scale 或 width/height。
   - 拖动旋转手柄改变 rotation。

5. 如果图层 locked，则不能操作，并显示锁定提示。

#### 验收标准

- 点击图层后画布显示选中框。
- 拖动图层能实时改变位置。
- 锁定图层不能拖动。
- 修改结果同步到属性面板和导出结果。

---

### 4.2 洋葱皮功能产品化

#### 问题

store 中已有 `showOnionSkin`，但 UI 和渲染未完整体现。

#### 涉及文件

- `src/stores/editorStore.ts`
- `src/components/editor/CanvasPreview.tsx`
- `src/components/editor/PlaybackControls.tsx`
- `src/core/renderer.ts`
- `src/core/renderer.high-performance.ts`

#### 具体改法

1. store 增加配置：

   ```ts
   onionSkin: {
     enabled: boolean
     beforeFrames: number
     afterFrames: number
     opacity: number
   }
   ```

2. 画布底部工具栏增加洋葱皮按钮。

3. 点击按钮旁边下拉设置：

   - 前 N 帧
   - 后 N 帧
   - 透明度

4. 渲染逻辑：

   - 当前帧正常渲染。
   - 前后帧低透明度叠加。
   - 前帧可用冷色，后帧可用暖色。

#### 验收标准

- 开启洋葱皮后，当前帧前后画面可见。
- 参数调整立即生效。
- 关闭后恢复正常单帧显示。

---

## 5. 第五阶段：资源、插槽、文本、音频

### 5.1 文本图层完整入口

#### 问题

`LayerFactory.createTextLayer` 已存在，但 UI 中没有完整的添加文本图层体验。

#### 涉及文件

- `src/core/layer-factory.ts`
- `src/stores/editorStore.ts`
- `src/components/panels/LayerPanel.tsx`
- `src/components/panels/PropertyPanel.tsx`
- `src/components/editor/CanvasPreview.tsx`
- `src/core/svga-builder.ts`

#### 具体改法

1. 在图层面板 header 增加添加按钮菜单：

   - 添加图片图层
   - 添加文本图层

2. store 增加：

   ```ts
   addTextLayer(text: string, options?: ...)
   ```

3. Layer 类型补充文本字段：

   ```ts
   text?: {
     content: string
     fontFamily: string
     fontSize: number
     fontWeight: string
     color: string
     align: 'left' | 'center' | 'right'
   }
   ```

4. 属性面板中对 text layer 显示：

   - 文本内容
   - 字体
   - 字号
   - 颜色
   - 对齐
   - 行高

5. 导出策略：

   短期建议把文本渲染为 PNG 资源并插入 SVGA images/sprites。

   - 用 canvas 根据文本样式绘制 PNG。
   - 生成 image key：`text_${layer.id}`。
   - 按普通图片图层导出。

#### 验收标准

- 用户可以添加文本图层。
- 文本可在画布预览。
- 修改文字、颜色、字号实时生效。
- 导出 SVGA 后文本仍可播放显示。

---

### 5.2 资源面板增加搜索、筛选、批量操作

#### 涉及文件

- `src/components/panels/ResourcePanel.tsx`
- `src/stores/editorStore.ts`

#### 具体改法

1. 资源面板顶部增加搜索输入框：

   - 按 key 搜索。
   - 按 mime 类型筛选。
   - 筛选新资源/原始资源/已替换资源。

2. 增加资源右键菜单：

   - 添加为图层
   - 替换
   - 重命名 Key
   - 导出图片
   - 删除资源
   - 复制 Key

3. 批量操作：

   - 多选资源。
   - 批量导出。
   - 批量删除新增资源。

#### 验收标准

- 资源数量超过 50 时仍可快速查找。
- 搜索不会破坏当前虚拟列表性能。
- 批量删除只允许删除新增资源，原始资源需要禁用或二次确认。

---

### 5.3 插槽配置导入 / 导出

#### 涉及文件

- `src/components/panels/SlotPanel.tsx`
- `src/stores/editorStore.ts`
- `src/core/exporter.ts`

#### 具体改法

1. SlotPanel header 增加：

   - 导入配置
   - 导出配置
   - 清空配置

2. JSON 格式：

   ```json
   {
     "version": 1,
     "slots": {
       "avatar": {
         "type": "image",
         "scaleMode": "fit"
       },
       "nickname": {
         "type": "text",
         "text": "用户昵称",
         "fontSize": 24,
         "color": "#ffffff"
       }
     }
   }
   ```

3. 图片 slot 的导入可先只导入元数据，不导入本地图片二进制。

4. 增加 scaleMode：

   - fit
   - fill
   - stretch
   - center

#### 验收标准

- 能导出当前 slotConfigs 为 JSON。
- 能导入 JSON 并恢复文本插槽。
- 图片插槽导入后能提示需要重新选择图片。

---

### 5.4 音频能力产品化

#### 问题

项目中已有 `audioResources` 和 `audio-manager.ts`，但 UI 没有完整音频工作流。

#### 涉及文件

- `src/core/audio-manager.ts`
- `src/stores/editorStore.ts`
- `src/components/editor/Timeline.tsx`
- `src/components/panels/ResourcePanel.tsx`
- 可新增：`src/components/panels/AudioPanel.tsx`

#### 具体改法

1. 新增 `AudioPanel.tsx`：

   - 音频列表
   - 播放/暂停
   - 删除
   - 起始时间
   - 音量

2. 时间轴增加音频轨：

   - 显示音频片段位置。
   - 可拖动起始帧。
   - 可调整 duration。

3. 播放控制联动音频：

   - 播放动画时同步音频。
   - seek 到某帧时音频 seek。
   - 暂停时音频暂停。

4. 明确导出兼容性：

   - 如果 SVGA 目标运行时不支持音频，应提示。
   - 导出时保留或移除音频可配置。

#### 验收标准

- 加载带音频 SVGA 后能看到音频资源。
- 播放时音频和画面同步。
- 导出后音频字段按配置保留。

---

## 6. 第六阶段：导出、优化与兼容性

### 6.1 导出前预检

#### 问题

当前导出失败主要通过 catch 报错。专业工具应在导出前告诉用户潜在问题。

#### 涉及文件

- `src/components/panels/ExportPanel.tsx`
- `src/core/exporter.ts`
- `src/core/svga-builder.ts`
- 新增：`src/core/export-preflight.ts`
- 新增测试：`src/core/export-preflight.test.ts`

#### 具体改法

新增 `runExportPreflight(state)`，检查：

- 是否有 `videoItem`。
- 是否有 `originalBuffer`。
- sprite 引用的 imageKey 是否存在。
- 新增图层是否有 imageResource 数据。
- slot 图片是否可加载。
- 总帧数是否小于任一图层结束帧。
- 是否存在空图层。
- 是否存在重复 key。
- 是否存在超大图片。
- 是否存在 WebP 兼容性风险。

返回：

```ts
interface ExportPreflightResult {
  level: 'ok' | 'warning' | 'error'
  items: Array<{
    level: 'warning' | 'error'
    code: string
    message: string
    fixHint?: string
  }>
}
```

ExportPanel 展示：

- 错误：禁止导出。
- 警告：允许导出，但展示确认。

#### 验收标准

- 缺失图片引用时导出按钮禁用并说明原因。
- 有超大图片时显示警告但允许导出。
- 测试覆盖重复 key、缺失 image、clip 超界。

---

### 6.2 导出体积预估与优化对比

#### 涉及文件

- `src/components/panels/ExportPanel.tsx`
- `src/core/optimizer.ts`

#### 具体改法

1. 增加“预估体积”按钮。

2. 点击后：

   - 构建当前 SVGA Blob。
   - 按当前优化配置 dry-run 或实际优化到内存。
   - 展示原始大小、优化后大小、减少百分比。

3. 导出完成后展示：

   - 原始大小
   - 导出大小
   - 优化耗时
   - 图片优化数量
   - 跳过数量

4. ExportPanel 中将“一键导出”和“按配置导出”的区别解释清楚：

   - 一键导出：根据文件大小自动选择预设。
   - 按配置导出：使用当前高级配置。

#### 验收标准

- 用户导出前能看到预估大小。
- 导出后能看到优化统计。
- 取消保存时不会显示导出成功。

---

### 6.3 Pixi 动态加载

#### 问题

`build:web` 提示 `vendor-pixi` 超过 500KB。Pixi 不一定需要首屏加载。

#### 涉及文件

- `src/components/editor/CanvasPreview.tsx`
- `src/rendering/svga-pixi-renderer.ts`
- `vite.config.ts`

#### 具体改法

1. 不在 CanvasPreview 顶部静态 import Pixi renderer。

   当前：

   ```ts
   import { SVGAPixiRenderer } from '@/rendering/svga-pixi-renderer'
   ```

   改为动态加载：

   ```ts
   const { SVGAPixiRenderer } = await import('@/rendering/svga-pixi-renderer')
   ```

2. rendererRef 类型需要调整为接口类型，而不是直接依赖 class instance。

3. 切换到 Pixi 时显示加载状态：

   `正在加载 WebGL 渲染器...`

4. Vite manualChunks 保留 React、core、Pixi 分包。

#### 验收标准

- 首屏 bundle 不包含完整 Pixi。
- 切换 WebGL 后能正常加载渲染。
- `npm run build:web` 不再出现 Pixi 首屏 chunk 超限，或至少 Pixi 变为懒加载 chunk。

---

## 7. 第七阶段：UI 视觉系统升级

### 7.1 调整配色为专业工具风格

#### 问题

当前颜色偏深蓝紫 + 红色强调，容易显得单一。专业编辑器需要更中性、更耐看的工作台风格。

#### 涉及文件

- `tailwind.config.js`
- `src/styles/globals.css`
- 所有使用 `bg-*`、`border-*`、`accent` 的组件

#### 具体改法

建议新色板：

```js
colors: {
  'bg-primary': '#101114',
  'bg-secondary': '#17191f',
  'bg-tertiary': '#20232b',
  'bg-elevated': '#262a33',
  'accent': '#4f8cff',
  'accent-hover': '#6ea1ff',
  'text-primary': '#f4f7fb',
  'text-secondary': '#b8c0cc',
  'text-muted': '#7d8794',
  'success': '#2ecc71',
  'warning': '#f6c343',
  'error': '#ff5d5d',
  'border': '#303541',
  'border-light': '#424957'
}
```

注意：

- 危险操作不要用 accent，用 error。
- 成功状态不要只用文字，结合背景色和图标。
- 选中态需要足够清晰，但不要大面积高饱和。

#### 验收标准

- 主界面不再被单一深蓝紫支配。
- 图层选中、按钮 hover、错误、警告、成功状态区分明显。
- 文本对比度满足可读性。

---

### 7.2 用 lucide-react 替换手写 Icon

#### 问题

`src/components/ui/Icon.tsx` 手写 path 太多，维护成本高，风格也不完全统一。

#### 涉及文件

- `package.json`
- `src/components/ui/Icon.tsx`
- 全部使用 `<Icon name="...">` 的组件

#### 具体改法

1. 安装：

   ```bash
   npm install lucide-react
   ```

2. 改造 `Icon.tsx`：

   - 保持现有 API：`name`、`size`、`className`。
   - 内部用 map 映射到 lucide icon。
   - 对没有映射的业务图标保留少量自定义 SVG。

3. 建议映射：

   - `play` -> `Play`
   - `pause` -> `Pause`
   - `folder-open` -> `FolderOpen`
   - `globe` -> `Globe`
   - `export` / `download` -> `Download`
   - `layer` -> `Layers`
   - `image` -> `Image`
   - `settings` -> `Settings`
   - `timeline` -> `ChartNoAxesGantt` 或 `Activity`
   - `magic` -> `WandSparkles`
   - `sparkles` -> `Sparkles`
   - `undo` -> `Undo2`
   - `redo` -> `Redo2`

4. 清理重复 path。

#### 验收标准

- 所有原有 icon name 都能正常显示。
- 没有图标回退到错误的 info 图标。
- 视觉风格统一。
- `npm run typecheck` 通过。

---

### 7.3 统一 Tooltip

#### 问题

当前大量 icon button 依赖 HTML `title`，体验简陋且不可控。

#### 涉及文件

- 新增：`src/components/ui/Tooltip.tsx`
- `src/components/ui/index.ts`
- `src/components/ui/Button.tsx`
- `src/components/editor/CanvasPreview.tsx`
- `src/components/editor/PlaybackControls.tsx`
- `src/components/panels/LayerPanel.tsx`
- `src/components/panels/ResourcePanel.tsx`

#### 具体改法

1. 新增 Tooltip 组件：

   - hover 延迟 300ms。
   - 支持 placement：top、bottom、left、right。
   - 支持快捷键显示。

2. icon button 包 Tooltip：

   ```tsx
   <Tooltip content="撤销" shortcut="Ctrl+Z">
     <Button ...>
       <Icon name="undo" />
     </Button>
   </Tooltip>
   ```

3. 去掉多数 `title`，避免浏览器原生 tooltip 和自定义 tooltip 同时出现。

#### 验收标准

- 播放控制、画布工具栏、图层操作按钮都有统一 tooltip。
- Tooltip 不遮挡关键内容。
- 键盘用户仍可通过 aria-label 理解按钮作用。

---

## 8. 第八阶段：文档体系

### 8.1 修复 README 与架构说明

#### 问题

README 中仍有历史 Electron 描述，但当前项目是 Tauri。`docs` 目录为空，原有 docs 文件在 git 状态里显示为删除。

#### 涉及文件

- `README.md`
- `PACKAGE_README.md`
- 新增：`docs/ARCHITECTURE.md`
- 新增：`docs/USER_GUIDE.md`
- 新增：`docs/EXPORT_COMPATIBILITY.md`
- 新增：`docs/DEVELOPMENT.md`
- 新增：`docs/RELEASE.md`

#### 具体改法

1. README 只保留用户和开发者最常用信息：

   - 项目简介
   - 功能列表
   - 安装运行
   - 构建
   - 快捷键
   - 文档入口

2. `ARCHITECTURE.md`：

   - Tauri 前后端分工
   - React 组件结构
   - Zustand 状态结构
   - 渲染器差异
   - 导出链路

3. `EXPORT_COMPATIBILITY.md`：

   - SVGA 1.0 / 2.0 支持情况
   - 是否带 SVGA header
   - 图片格式支持
   - 文本和音频导出策略
   - WebP 风险

4. `USER_GUIDE.md`：

   - 打开文件
   - 编辑图层
   - 替换资源
   - 配置插槽
   - 导出

5. `DEVELOPMENT.md`：

   - 环境要求
   - 常用命令
   - 测试
   - 代码风格
   - 常见问题

#### 验收标准

- README 不再提 Electron。
- 新开发者能按文档启动项目。
- 用户能按 USER_GUIDE 完成一次导入、编辑、导出。

---

## 9. 建议执行顺序

建议不要一次性全改。推荐按下面顺序执行：

1. 撤销 / 重做。
2. 未保存保护。
3. 保存 / 另存为 / 导出语义拆分。
4. 属性面板拆分：CanvasPanel + PropertyPanel + ExportPanel。
5. FPS / 总帧数风险提示。
6. 时间轴 Clip 编辑。
7. 关键帧选择、拖动、删除。
8. 文本图层完整入口。
9. 导出前预检。
10. 导出体积预估。
11. Pixi 动态加载。
12. UI 视觉系统升级。
13. Tooltip 统一。
14. 文档体系重建。

---

## 10. 每次修改后的通用验证命令

每个阶段完成后都应执行：

```bash
npm run typecheck
npm run lint
npm run test:run
npm run build:web
```

如果涉及 Tauri 后端或桌面能力，还应执行：

```bash
npm run dev:tauri
```

并手动验证：

- 打开本地 SVGA 文件。
- 拖拽打开 SVGA 文件。
- 播放、暂停、逐帧。
- 修改图层属性。
- 替换资源。
- 配置插槽。
- 保存。
- 另存为。
- 导出优化 SVGA。
- 导出 PNG 序列。
- 导出当前帧 WebP。

---

## 11. 当前已知风险清单

### 11.1 大量工作区文件已有未提交改动

当前 `git status` 显示许多文件已修改或删除，包括：

- `.github/workflows/build.yml`
- `.gitignore`
- `build.bat`
- `index.html`
- `package.json`
- 多个 `src` 文件
- 多个旧 assets / docs / public / sample tools 文件删除

后续 Codex 执行修改时必须注意：

- 不要重置工作区。
- 不要恢复或覆盖用户已有改动。
- 每次修改前先读相关文件当前内容。
- 如果某个文件已有用户改动，基于当前内容增量修改。

### 11.2 终端显示中文乱码

PowerShell 输出中中文显示为乱码，但 Node 读取 `package.json` 可正常显示中文。判断主要是终端编码显示问题，不一定是文件本身损坏。

后续如果需要批量处理中文文案，应使用编辑器或 Node 脚本确认 UTF-8 内容，避免因终端乱码误改。

### 11.3 Pixi 包体警告

`npm run build:web` 当前有 chunk 体积警告：

- `vendor-pixi` 约 538KB

不是构建失败，但建议后续通过动态 import 优化。

### 11.4 protobufjs eval 警告

构建出现：

`Use of eval in node_modules/@protobufjs/inquire/index.js is strongly discouraged`

这是依赖内部警告。短期可接受，长期可以评估：

- 是否能使用 protobufjs minimal build。
- 是否能预编译 proto。
- 是否能减少运行时 protobuf 解析。

---

## 12. 给 Codex 的执行提示词模板

后续可以按阶段对 Codex 下达类似指令：

```text
请按照 docs/PRODUCT_UI_FRONTEND_OPTIMIZATION_PLAN.md 的 1.1 节实现撤销/重做。
要求：
1. 只实现 1.1，不做无关重构。
2. 修改前检查当前 git 状态，不覆盖已有用户改动。
3. 补充必要测试。
4. 完成后运行 npm run typecheck、npm run lint、npm run test:run。
5. 输出修改文件、实现说明、验证结果。
```

或者：

```text
请按照 docs/PRODUCT_UI_FRONTEND_OPTIMIZATION_PLAN.md 的 2.1 节拆分 CanvasPanel、PropertyPanel、ExportPanel。
要求保持现有功能可用，不改变导出逻辑。
```

