/**
 * 编辑器状态管理
 * 使用 Zustand 进行状态管理
 */

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { 
  VideoItem, 
  MovieParams, 
  Layer, 
  SlotConfig, 
  Keyframe, 
  PlaybackState,
  CompressionConfig,
  ImageResource,
  AudioResource,
  AnimationPreset,
  LayerTracks,
  CanvasTransform,
  EasingType
} from '@/types'
import type { OptimizationConfig, OptimizationStats } from '@/core/optimizer'
import { getPreset } from '@/core/optimizer'
import { v4 as uuid } from 'uuid'
import { normalizeCanvasTransform } from '@/core/layer-transform'
import { getSelectedLayerIds, selectionForLayers } from '@/utils/layer-selection'
import { planLayerLayout, type LayoutOperation } from '@/core/layer-layout'
import { LAYOUT_LABELS } from '@/utils/layout-labels'
import { planLayerTiming, type TimingRequest } from '@/core/timing-plan'
import {
  cloneAnimationTracks, getAnimationLayerError, getKeyframeEditError, getLayerDuplicateError,
  isEditableTrack, isSupportedEasing, isValidAnimationValue, resolveCanvasTransform,
  sampleAnimationValues, TRACK_LABELS, upsertAnimationValue,
  type AnimationValue, type KeyframeEditResult
} from '@/core/keyframe-editing'
import { getLayerSourceFrame } from '@/core/layer-time'
import { getCanvasSizeError, replaceCanvasSize } from '@/core/canvas-size'
import { captureExportInputs, sameExportInputs } from '@/core/export-preview'
import type { ProjectDocument } from '@/types/project'
import { previewFileName } from '@/utils/preview-view'
import { buildSlotCatalog } from '@/utils/slot-catalog'
import { mergeSlotTextConfig } from '@/utils/slot-config'
import { normalizeTextConfig } from '@/core/text-preview'

interface EditorSnapshot {
  videoItem: VideoItem | null
  params: MovieParams | null
  customFps: number | null
  customFrames: number | null
  layers: Layer[]
  selectedLayerId: string | null
  selectedLayerIds: string[]
  keyframes: Keyframe[]
  selectedKeyframeIds: string[]
  imageResources: Map<string, ImageResource>
  audioResources: Map<string, AudioResource>
  slotConfigs: Record<string, SlotConfig>
  detectedSlots: string[]
  compressionConfig: CompressionConfig
  optimizationConfig: OptimizationConfig
  selectedPresetId: string
}

interface EditorHistoryState {
  past: Array<{ snapshot: EditorSnapshot; label?: string }>
  future: Array<{ snapshot: EditorSnapshot; label?: string }>
  maxDepth: number
  isApplyingHistory: boolean
  baseLabel?: string
  snapshots?: Array<{ id: string; name: string; snapshot: EditorSnapshot }>
  activeSnapshotId?: string | null
  activeSnapshotLabel?: string
  timelineSnapshot?: EditorSnapshot | null
}

interface EditorStore {
  // 文件状态
  currentSource: string | null
  sourceType: 'url' | 'file' | null
  videoItem: VideoItem | null
  originalBuffer: ArrayBuffer | null
  projectName: string | null
  projectFilePath: string | null
  // 表示工程编辑数据尚未保存；导出 SVGA 不等于保存可继续编辑的工程。
  isDirty: boolean

  // 动画参数
  params: MovieParams | null
  customFps: number | null
  customFrames: number | null

  // 图层
  layers: Layer[]
  selectedLayerId: string | null
  selectedLayerIds: string[]

  // 资源库（新增）
  imageResources: Map<string, ImageResource>
  audioResources: Map<string, AudioResource>

  // 插槽
  slotConfigs: Record<string, SlotConfig>
  detectedSlots: string[]

  // 播放
  playback: PlaybackState

  // 时间轴
  keyframes: Keyframe[]
  selectedKeyframeIds: string[]

  // UI
  zoom: number
  canvasOffset: { x: number; y: number }
  previewBackgroundColor: string
  showGrid: boolean
  showOnionSkin: boolean
  rendererMode: 'high-performance' | 'official' | 'pixi'
  canvasKeepRatio: boolean
  transformEditMode: 'whole' | 'keyframe'

  // 导出配置
  compressionConfig: CompressionConfig
  
  // 优化配置
  optimizationConfig: OptimizationConfig
  selectedPresetId: string
  optimizationStats: OptimizationStats | null

  // 历史记录
  history: EditorHistoryState
  canUndo: boolean
  canRedo: boolean
  isCanvasTransforming: boolean
  isSlotConfigEditing: boolean

  // Actions
  setVideoItem: (videoItem: VideoItem | null) => void
  setSource: (source: string | null, type: 'url' | 'file' | null) => void
  setOriginalBuffer: (buffer: ArrayBuffer | null) => void
  captureProjectDocument: () => ProjectDocument
  captureProjectRecovery: () => ProjectDocument | null
  restoreProjectDocument: (document: ProjectDocument, filePath: string | null, displayName: string) => void
  markProjectSaved: (expectedInputs: readonly unknown[], filePath: string | null, displayName: string) => boolean
  setParams: (params: MovieParams | null) => void
  setCanvasSize: (width: number, height: number) => { changed: boolean; error?: string }
  setCustomFps: (fps: number | null) => void
  setCustomFrames: (frames: number | null) => void
  
  // 图层操作
  setLayers: (layers: Layer[]) => void
  selectLayer: (layerId: string | null, additive?: boolean) => void
  selectLayers: (layerIds: string[]) => void
  updateLayer: (layerId: string, updates: Partial<Layer>) => void
  updateCanvasTransform: (layerId: string, transform: Partial<CanvasTransform>) => void
  beginCanvasTransform: (layerId: string) => boolean
  beginCanvasTransforms: (layerIds: string[]) => boolean
  previewCanvasTransform: (layerId: string, transform: CanvasTransform) => void
  previewCanvasTransforms: (transforms: Record<string, CanvasTransform>) => void
  arrangeLayers: (operation: LayoutOperation, target: 'selection' | 'canvas') => ReturnType<typeof planLayerLayout>
  arrangeLayerTiming: (request: TimingRequest) => ReturnType<typeof planLayerTiming>
  endCanvasTransform: (commit: boolean) => void
  reorderLayers: (fromIndex: number, toIndex: number) => void
  addLayer: (layer: Omit<Layer, 'id'>) => string
  deleteLayer: (layerId: string) => void
  operateLayers: (ids: readonly string[], operation: 'delete' | 'show' | 'hide' | 'lock' | 'unlock', expectedInputs?: readonly unknown[]) => { changed: boolean; error?: string }
  duplicateLayer: (layerId: string) => string | null

  // 图层轨道默认值操作
  updateLayerTrackDefaultValue: (layerId: string, trackKey: keyof LayerTracks, value: any) => void

  // 资源操作（新增）
  addImageResource: (resource: ImageResource) => void
  removeImageResource: (key: string) => void
  getImageResource: (key: string) => ImageResource | undefined
  renameImageKey: (layerId: string, newKey: string) => void
  renameImageResourceKey: (oldKey: string, newKey: string) => boolean

  // 音频资源操作
  addAudioResource: (resource: AudioResource) => void
  removeAudioResource: (key: string) => void
  getAudioResource: (key: string) => AudioResource | undefined
  setAudioResources: (resources: Map<string, AudioResource>) => void

  // 插槽操作
  setSlotConfig: (key: string, config: SlotConfig) => void
  applySlotTextValues: (values: Record<string, string>, expectedInputs: readonly unknown[]) => { changed: boolean; error?: string }
  removeSlotConfig: (key: string) => void
  beginSlotConfigEdit: (key: string) => boolean
  previewSlotConfig: (key: string, config: SlotConfig) => void
  endSlotConfigEdit: (commit: boolean) => void
  setDetectedSlots: (slots: string[]) => void

  // 播放控制
  setPlaying: (playing: boolean) => void
  setCurrentFrame: (frame: number) => void
  toggleLoop: () => void
  setSpeed: (speed: number) => void

  // 关键帧操作
  addKeyframe: (keyframe: Omit<Keyframe, 'id'>) => void
  updateKeyframe: (id: string, updates: Partial<Keyframe>) => void
  deleteKeyframe: (id: string) => void
  selectKeyframe: (id: string, multi?: boolean) => void
  
  // 图层关键帧操作（新增）
  addLayerKeyframe: (layerId: string, trackKey: keyof LayerTracks, keyframe: Omit<Keyframe, 'id'>) => void
  updateLayerKeyframe: (layerId: string, trackKey: keyof LayerTracks, keyframeId: string, updates: Partial<Keyframe>) => void
  deleteLayerKeyframe: (layerId: string, trackKey: keyof LayerTracks, keyframeId: string) => void
  applyAnimationPreset: (layerId: string, preset: AnimationPreset, startFrame: number) => void

  // 用户附加关键帧不覆盖原始动画及已有预设。
  insertAnimationKeyframes: (layerIds: string[], tracks: (keyof LayerTracks)[], outputFrame?: number) => KeyframeEditResult
  setAnimationValue: (layerId: string, track: keyof LayerTracks, value: AnimationValue, outputFrame?: number) => KeyframeEditResult
  moveAnimationKeyframe: (layerId: string, track: keyof LayerTracks, id: string, outputFrame: number) => KeyframeEditResult
  deleteAnimationKeyframes: (layerId: string, track: keyof LayerTracks, ids: string[]) => KeyframeEditResult
  setAnimationEasing: (layerId: string, track: keyof LayerTracks, ids: string[], easing: EasingType) => KeyframeEditResult

  // UI 操作
  setZoom: (zoom: number) => void
  setCanvasOffset: (offset: { x: number; y: number }) => void
  setPreviewBackgroundColor: (color: string) => void
  toggleGrid: () => void
  toggleOnionSkin: () => void
  setRendererMode: (mode: 'high-performance' | 'official' | 'pixi') => void
  setCanvasKeepRatio: (value: boolean) => void
  setTransformEditMode: (mode: 'whole' | 'keyframe') => void

  // 导出配置
  setCompressionConfig: (config: Partial<CompressionConfig>) => void
  
  // 优化配置
  setOptimizationConfig: (config: Partial<OptimizationConfig>) => void
  setSelectedPresetId: (id: string) => void
  setOptimizationStats: (stats: OptimizationStats | null) => void

  // 历史操作
  undo: () => void
  redo: () => void
  jumpToHistory: (index: number) => void
  deleteHistoryState: (index: number) => void
  initializeHistory: () => void
  createHistorySnapshot: (name?: string) => string
  restoreHistorySnapshot: (id: string) => void
  renameHistorySnapshot: (id: string, name: string) => void
  deleteHistorySnapshot: (id: string) => void
  commitHistory: (label?: string) => void
  clearHistory: () => void

  // 重置
  reset: () => void
}

const initialPlayback: PlaybackState = {
  isPlaying: false,
  currentFrame: 0,
  totalFrames: 0,
  fps: 24,
  loop: true,
  speed: 1
}

const initialCompression: CompressionConfig = {
  enabled: false,
  mode: 'smart',
  quality: 80,
  resizeEnabled: false,
  resizePercent: 100
}

const initialOptimization: OptimizationConfig = structuredClone(getPreset('balanced')!.config)

const cloneParams = (params: MovieParams | null): MovieParams | null =>
  params ? { ...params } : null

const cloneLayer = (layer: Layer): Layer => ({
  ...layer,
  canvasTransform: layer.canvasTransform ? { ...layer.canvasTransform } : undefined,
  animationTracks: layer.animationTracks ? cloneAnimationTracks(layer.animationTracks) : undefined,
  clip: { ...layer.clip },
  imageSource: layer.imageSource ? { ...layer.imageSource, file: undefined } : undefined,
  audioSource: layer.audioSource ? { ...layer.audioSource, file: undefined } : undefined,
  tracks: {
    position: {
      ...layer.tracks.position,
      currentValue: { ...layer.tracks.position.currentValue },
      defaultValue: { ...layer.tracks.position.defaultValue },
      keyframes: layer.tracks.position.keyframes.map((kf) => ({
        ...kf,
        value: { ...kf.value },
        bezierControlPoints: kf.bezierControlPoints ? { ...kf.bezierControlPoints } : undefined
      }))
    },
    scale: {
      ...layer.tracks.scale,
      currentValue: { ...layer.tracks.scale.currentValue },
      defaultValue: { ...layer.tracks.scale.defaultValue },
      keyframes: layer.tracks.scale.keyframes.map((kf) => ({
        ...kf,
        value: { ...kf.value },
        bezierControlPoints: kf.bezierControlPoints ? { ...kf.bezierControlPoints } : undefined
      }))
    },
    rotation: {
      ...layer.tracks.rotation,
      keyframes: layer.tracks.rotation.keyframes.map((kf) => ({
        ...kf,
        bezierControlPoints: kf.bezierControlPoints ? { ...kf.bezierControlPoints } : undefined
      }))
    },
    alpha: {
      ...layer.tracks.alpha,
      keyframes: layer.tracks.alpha.keyframes.map((kf) => ({
        ...kf,
        bezierControlPoints: kf.bezierControlPoints ? { ...kf.bezierControlPoints } : undefined
      }))
    }
  },
  sprites: layer.sprites
    ? {
        ...layer.sprites,
        frames: layer.sprites.frames.map((frame) => ({
          ...frame,
          layout: frame.layout ? { ...frame.layout } : frame.layout,
          transform: frame.transform ? { ...frame.transform } : frame.transform,
          shapes: frame.shapes ? structuredClone(frame.shapes) : undefined
        }))
      }
    : undefined
})

const cloneImageResource = (resource: ImageResource): ImageResource => ({
  ...resource,
  data: new Uint8Array(resource.data),
  source: resource.source ? { ...resource.source, file: undefined } : undefined,
  bitmap: undefined
})

const cloneAudioResource = (resource: AudioResource): AudioResource => ({
  ...resource,
  data: new Uint8Array(resource.data),
  source: resource.source ? { ...resource.source, file: undefined } : undefined,
  audioBuffer: undefined
})

const cloneImageResources = (resources: Map<string, ImageResource>) =>
  new Map(Array.from(resources.entries()).map(([key, value]) => [key, cloneImageResource(value)]))

const cloneAudioResources = (resources: Map<string, AudioResource>) =>
  new Map(Array.from(resources.entries()).map(([key, value]) => [key, cloneAudioResource(value)]))

const cloneSlotConfigs = (configs: Record<string, SlotConfig>) =>
  Object.fromEntries(Object.entries(configs).map(([key, value]) => [
    key,
    {
      ...value,
      imageConfig: value.imageConfig ? { ...value.imageConfig } : undefined,
      textConfig: value.textConfig ? { ...value.textConfig } : undefined
    }
  ]))

const cloneOptimizationConfig = (config: OptimizationConfig): OptimizationConfig => ({
  image: { ...config.image },
  frames: { ...config.frames },
  compression: { ...config.compression },
  enabled: config.enabled
})

const cloneCompressionConfig = (config: CompressionConfig): CompressionConfig => ({ ...config })

/** 工程保留来源名称，但不把本地目录、带鉴权参数的 URL 或临时 Blob 地址写入工程名。 */
const projectBaseName = (source: string | null, fallback = '未命名动画'): string => {
  if (!source || /^(blob|data):/i.test(source)) return fallback
  if (/^https?:\/\//i.test(source)) {
    try { new URL(source) } catch { return fallback }
  }
  const name = previewFileName(source).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim()
  return name && name !== '.' && name !== '..' ? name : fallback
}

/** HTMLImageElement 仅供预览共享；可修改的帧数据与字节必须与异步保存任务隔离。 */
const cloneProjectVideo = (videoItem: VideoItem): VideoItem => ({
  movie: structuredClone(videoItem.movie),
  images: { ...videoItem.images },
  buffers: Object.fromEntries(Object.entries(videoItem.buffers).map(([key, buffer]) => [key, buffer.slice(0)]))
})

/** 纯快照构建器：手动保存和后台恢复共享数据格式，但不共享提交输入或暂停播放的副作用。 */
const captureProjectState = (state: EditorStore): ProjectDocument | null => {
  if (!state.videoItem || !state.params || !state.originalBuffer) return null
  return {
    formatVersion: 1,
    name: projectBaseName(state.currentSource),
    originalBuffer: state.originalBuffer.slice(0),
    videoItem: cloneProjectVideo(state.videoItem),
    params: { ...state.params },
    customFps: state.customFps,
    customFrames: state.customFrames,
    layers: state.layers.map(cloneLayer),
    imageResources: cloneImageResources(state.imageResources),
    audioResources: cloneAudioResources(state.audioResources),
    slotConfigs: cloneSlotConfigs(state.slotConfigs),
    detectedSlots: [...state.detectedSlots],
    compressionConfig: cloneCompressionConfig(state.compressionConfig),
    optimizationConfig: cloneOptimizationConfig(state.optimizationConfig),
    selectedPresetId: state.selectedPresetId,
    currentFrame: state.playback.currentFrame,
    ...selectionForLayers(getSelectedLayerIds(state), state.layers)
  }
}

const createSnapshot = (state: EditorStore): EditorSnapshot => ({
  // 原始解码资源按不可变引用共享；重命名会替换 videoItem，撤回时须一同恢复资源键。
  videoItem: state.videoItem,
  params: cloneParams(state.params),
  customFps: state.customFps,
  customFrames: state.customFrames,
  layers: state.layers.map(cloneLayer),
  selectedLayerId: state.selectedLayerId,
  selectedLayerIds: getSelectedLayerIds(state),
  keyframes: structuredClone(state.keyframes),
  selectedKeyframeIds: [...state.selectedKeyframeIds],
  imageResources: cloneImageResources(state.imageResources),
  audioResources: cloneAudioResources(state.audioResources),
  slotConfigs: cloneSlotConfigs(state.slotConfigs),
  detectedSlots: [...state.detectedSlots],
  compressionConfig: cloneCompressionConfig(state.compressionConfig),
  optimizationConfig: cloneOptimizationConfig(state.optimizationConfig),
  selectedPresetId: state.selectedPresetId
})

const serializeSnapshot = (snapshot: EditorSnapshot, includeSelection = true) => JSON.stringify({
  ...snapshot,
  videoItem: undefined,
  selectedLayerId: includeSelection ? snapshot.selectedLayerId : undefined,
  selectedLayerIds: includeSelection ? snapshot.selectedLayerIds : undefined,
  selectedKeyframeIds: includeSelection ? snapshot.selectedKeyframeIds : undefined,
  imageResources: Array.from(snapshot.imageResources.entries()).map(([key, value]) => [
    key,
    { ...value, data: Array.from(value.data) }
  ]),
  audioResources: Array.from(snapshot.audioResources.entries()).map(([key, value]) => [
    key,
    { ...value, data: Array.from(value.data) }
  ])
})

const isSameSnapshot = (a: EditorSnapshot, b: EditorSnapshot) =>
  a.videoItem === b.videoItem && serializeSnapshot(a) === serializeSnapshot(b)

const isSameDocumentSnapshot = (a: EditorSnapshot, b: EditorSnapshot) =>
  a.videoItem === b.videoItem && serializeSnapshot(a, false) === serializeSnapshot(b, false)

export const useEditorStore = create<EditorStore>()(
  subscribeWithSelector((set, get) => {
    let canvasEdit: {
      before: EditorSnapshot; layerIds: string[]; video: VideoItem | null; buffer: ArrayBuffer | null
      originalLayers: Layer[]; latestLayers: Layer[]; dirty: boolean
      mode: 'whole' | 'keyframe'; outputFrame: number
    } | null = null
    let slotEdit: {
      before: EditorSnapshot
      key: string
      video: VideoItem
      buffer: ArrayBuffer | null
      originalSlotConfigs: Record<string, SlotConfig>
      latestSlotConfigs: Record<string, SlotConfig>
      dirty: boolean
    } | null = null
    const applySnapshot = (snapshot: EditorSnapshot, history: EditorHistoryState, current: EditorSnapshot) => {
      const sameDocument = isSameDocumentSnapshot(current, snapshot)
      set((state) => {
        const totalFrames = snapshot.params ? snapshot.customFrames ?? snapshot.params.frames : state.playback.totalFrames
        const fps = snapshot.params ? snapshot.customFps ?? snapshot.params.fps : state.playback.fps
        const currentFrame = snapshot.params
          ? Math.max(0, Math.min(state.playback.currentFrame, Math.max(0, totalFrames - 1)))
          : state.playback.currentFrame
        const sameSelection = state.selectedLayerId === snapshot.selectedLayerId
          && JSON.stringify(state.selectedLayerIds) === JSON.stringify(snapshot.selectedLayerIds)
          && JSON.stringify(state.selectedKeyframeIds) === JSON.stringify(snapshot.selectedKeyframeIds)
        const samePlayback = !state.playback.isPlaying && state.playback.totalFrames === totalFrames
          && state.playback.fps === fps && state.playback.currentFrame === currentFrame
        return {
          // 只切换历史选中项不算编辑；同内容恢复也不重建资源或触发无谓的渲染。
          ...(sameDocument ? {} : {
            videoItem: snapshot.videoItem,
            params: cloneParams(snapshot.params),
            customFps: snapshot.customFps,
            customFrames: snapshot.customFrames,
            layers: snapshot.layers.map(cloneLayer),
            keyframes: structuredClone(snapshot.keyframes),
            imageResources: cloneImageResources(snapshot.imageResources),
            audioResources: cloneAudioResources(snapshot.audioResources),
            slotConfigs: cloneSlotConfigs(snapshot.slotConfigs),
            detectedSlots: [...snapshot.detectedSlots],
            compressionConfig: cloneCompressionConfig(snapshot.compressionConfig),
            optimizationConfig: cloneOptimizationConfig(snapshot.optimizationConfig),
            selectedPresetId: snapshot.selectedPresetId
          }),
          ...(sameSelection ? {} : {
            selectedLayerId: snapshot.selectedLayerId,
            selectedLayerIds: [...snapshot.selectedLayerIds],
            selectedKeyframeIds: [...snapshot.selectedKeyframeIds]
          }),
          playback: samePlayback ? state.playback : { ...state.playback, isPlaying: false, totalFrames, fps, currentFrame },
          isDirty: sameDocument ? state.isDirty : true,
          isCanvasTransforming: false,
          isSlotConfigEditing: false,
          history,
          canUndo: Boolean(history.timelineSnapshot) || history.past.length > 0,
          canRedo: !history.timelineSnapshot && history.future.length > 0
        }
      })
    }

    const pushHistory = (snapshot: EditorSnapshot, label = '修改编辑内容') => {
      const state = get()
      if (state.history.isApplyingHistory) return

      // 浏览快照时仍保留旧时间线；只有真实编辑才从该快照另起分支。
      const detached = Boolean(state.history.timelineSnapshot)
      const entries = [...(detached ? [] : state.history.past), { snapshot, label }]
      const dropped = Math.max(0, entries.length - state.history.maxDepth)
      const past = entries.slice(dropped)
      const baseLabel = dropped > 0 ? entries[dropped - 1].label
        : detached ? state.history.activeSnapshotLabel || '快照' : state.history.baseLabel
      set({
        history: {
          ...state.history, past, future: [], baseLabel,
          activeSnapshotId: null, activeSnapshotLabel: undefined, timelineSnapshot: null
        },
        canUndo: past.length > 0,
        canRedo: false
      })
    }

    const ownSlotConfig = (configs: Record<string, SlotConfig>, key: string) =>
      Object.prototype.hasOwnProperty.call(configs, key) ? configs[key] : undefined
    const slotConfigSignature = (config: SlotConfig | undefined) => {
      if (!config) return 'null'
      const sortedFields = (fields: object | undefined) => fields
        ? Object.entries(fields).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)) : null
      return JSON.stringify([config.type, config.name, config.value, sortedFields(config.imageConfig), sortedFields(config.textConfig)])
    }

    const isKnownSlotKey = (state: EditorStore, key: string) => {
      if (!key || !state.videoItem) return false
      if (Object.prototype.hasOwnProperty.call(state.slotConfigs, key)) return true
      if (state.detectedSlots.includes(key)) return true
      if (state.imageResources.has(key)) return true
      if (state.videoItem.images && Object.prototype.hasOwnProperty.call(state.videoItem.images, key)) return true
      if (state.videoItem.buffers && Object.prototype.hasOwnProperty.call(state.videoItem.buffers, key)) return true
      if (Object.prototype.hasOwnProperty.call(state.videoItem.movie.images || {}, key)) return true
      return state.layers.some(layer => layer.imageKey === key)
        || state.videoItem.movie.sprites.some(sprite => sprite.imageKey === key || sprite.matteKey === key)
    }

    // 文本面板的输入只在失焦时写入一次历史；期间所有预览均属于可取消草稿。
    const finishSlotConfigEdit = (commit: boolean) => {
      const edit = slotEdit
      if (!edit) return
      slotEdit = null
      const state = get()
      if (state.videoItem !== edit.video || state.originalBuffer !== edit.buffer
        || state.slotConfigs !== edit.latestSlotConfigs) {
        set({ isSlotConfigEditing: false })
        return
      }

      const changed = slotConfigSignature(ownSlotConfig(state.slotConfigs, edit.key))
        !== slotConfigSignature(ownSlotConfig(edit.before.slotConfigs, edit.key))
      if (!commit || !changed) {
        set({ slotConfigs: edit.originalSlotConfigs, isDirty: edit.dirty, isSlotConfigEditing: false })
        return
      }

      set({ isDirty: true, isSlotConfigEditing: false })
      pushHistory(edit.before, `模拟文字：${edit.key}`)
    }

    const withHistory = (updater: Parameters<typeof set>[0], label?: string) => {
      finishSlotConfigEdit(true)
      finishCanvasEdit(true)
      const state = get()
      const before = createSnapshot(state)
      set(updater)
      const after = createSnapshot(get())
      if (!isSameSnapshot(before, after)) {
        pushHistory(before, label)
      } else if (get().isDirty !== state.isDirty) {
        set({ isDirty: state.isDirty })
      }
    }

    // 一次拖动仅保存一个快照；逐帧预览不复制全部图片或累加撤销条目。
    const finishCanvasEdit = (commit: boolean) => {
      const edit = canvasEdit
      if (!edit) return
      canvasEdit = null
      const state = get()
      set({ isCanvasTransforming: false })
      if (state.videoItem !== edit.video || state.originalBuffer !== edit.buffer || state.layers !== edit.latestLayers) return
      const ids = new Set(edit.layerIds)
      const before = edit.originalLayers.filter(layer => ids.has(layer.id)).map(layer => [layer.id, normalizeCanvasTransform(layer.canvasTransform), layer.animationTracks])
      const after = state.layers.filter(layer => ids.has(layer.id)).map(layer => [layer.id, normalizeCanvasTransform(layer.canvasTransform), layer.animationTracks])
      const changed = JSON.stringify(before) !== JSON.stringify(after)
      if (!commit || !changed) {
        set({ layers: edit.originalLayers, isDirty: edit.dirty })
      } else {
        pushHistory(edit.before, edit.layerIds.length > 1 ? `整体变换：${edit.layerIds.length} 个图层` : `${edit.mode === 'keyframe' ? '关键帧变换' : '画布变换'}：${state.layers.find(layer => layer.id === edit.layerIds[0])?.name || edit.layerIds[0]}`)
      }
    }

    const clearHistoryState = () => {
      finishSlotConfigEdit(true)
      finishCanvasEdit(true)
      set((state) => ({
        history: {
          ...state.history, past: [], future: [], isApplyingHistory: false,
          baseLabel: '清空后的状态', activeSnapshotId: null,
          activeSnapshotLabel: undefined, timelineSnapshot: null
        },
        canUndo: false,
        canRedo: false
      }))
    }

    const moveToHistory = (index: number, deleteFollowing = false) => {
      const initial = get()
      const total = initial.history.past.length + initial.history.future.length
      if (!Number.isInteger(index) || index < 0 || index > total) return
      finishSlotConfigEdit(false)
      finishCanvasEdit(false)
      const state = get()
      const history = state.history
      if (!deleteFollowing && !history.timelineSnapshot && index === history.past.length) {
        if (state.playback.isPlaying) set({ playback: { ...state.playback, isPlaying: false } })
        return
      }

      // past 保存操作前状态，future 保存操作后状态；先还原完整时间线再一次性切分。
      const current = createSnapshot(state)
      const snapshots = [
        ...history.past.map(entry => entry.snapshot),
        history.timelineSnapshot ?? current,
        ...history.future.map(entry => entry.snapshot)
      ]
      const labels = [...history.past, ...history.future].map(entry => entry.label)
      const past = labels.slice(0, index).map((label, position) => ({ snapshot: snapshots[position], label }))
      const future = deleteFollowing ? [] : labels.slice(index).map((label, position) => ({
        snapshot: snapshots[index + position + 1], label
      }))
      applySnapshot(snapshots[index], {
        ...history, past, future, isApplyingHistory: false,
        activeSnapshotId: null, activeSnapshotLabel: undefined, timelineSnapshot: null
      }, current)
    }

    const prepareAnimationEdit = () => {
      finishCanvasEdit(true)
      get().setPlaying(false)
      return get()
    }

    const saveAnimationLayers = (layers: Layer[], label: string): KeyframeEditResult => {
      if (layers.every((layer, index) => layer === get().layers[index])) return { changed: false }
      withHistory({ layers, isDirty: true }, label)
      return { changed: true }
    }

    return ({
    // 初始状态
    currentSource: null,
    sourceType: null,
    videoItem: null,
    originalBuffer: null,
    projectName: null,
    projectFilePath: null,
    isDirty: false,

    params: null,
    customFps: null,
    customFrames: null,

    layers: [],
    selectedLayerId: null,
    selectedLayerIds: [],

    // 新增：资源库
    imageResources: new Map<string, ImageResource>(),
    audioResources: new Map<string, AudioResource>(),

    slotConfigs: {},
    detectedSlots: [],

    playback: initialPlayback,
    keyframes: [],
    selectedKeyframeIds: [],

    zoom: 1,
    canvasOffset: { x: 0, y: 0 },
    previewBackgroundColor: 'transparent',
    showGrid: true,
    showOnionSkin: false,
    rendererMode: 'official' as const,

    compressionConfig: initialCompression,
    
    optimizationConfig: initialOptimization,
    selectedPresetId: 'balanced',
    optimizationStats: null,
    history: {
      past: [],
      future: [],
      maxDepth: 100,
      isApplyingHistory: false,
      baseLabel: '打开',
      snapshots: [],
      activeSnapshotId: null,
      timelineSnapshot: null
    },
    canUndo: false,
    canRedo: false,
    isCanvasTransforming: false,
    isSlotConfigEditing: false,
    canvasKeepRatio: true,
    transformEditMode: 'whole',

    // Actions
    setVideoItem: (videoItem) => {
      const previous = get()
      if (videoItem === previous.videoItem) return
      canvasEdit = null
      // 切换文件后，旧面板事件不得把草稿写回新文件。
      slotEdit = null
      const params = videoItem?.movie.params ?? null
      set({
        videoItem, isDirty: false, isCanvasTransforming: false, isSlotConfigEditing: false,
        projectName: null, projectFilePath: null,
        originalBuffer: null, params, customFps: null, customFrames: null,
        layers: [], imageResources: new Map<string, ImageResource>(),
        audioResources: new Map<string, AudioResource>(), slotConfigs: {}, detectedSlots: [],
        keyframes: [], selectedKeyframeIds: [],
        selectedLayerId: null, selectedLayerIds: [],
        playback: {
          ...previous.playback, isPlaying: false, currentFrame: 0,
          totalFrames: params?.frames ?? 0, fps: params?.fps ?? initialPlayback.fps
        },
        history: {
          past: [], future: [], maxDepth: previous.history.maxDepth, isApplyingHistory: false,
          baseLabel: '打开', snapshots: [], activeSnapshotId: null, timelineSnapshot: null
        },
        canUndo: false, canRedo: false
      })
      // 初始化图层数据（扩展版，包含动画轨道）
      if (videoItem?.movie.sprites) {
        const layers: Layer[] = videoItem.movie.sprites.map((sprite, index) => ({
          id: String(index),
          name: sprite.imageKey || `Layer ${index + 1}`,
          type: 'image' as const,
          visible: true,
          locked: false,
          expanded: true,
          opacity: 1,
          blendMode: 'normal' as const,
          imageKey: sprite.imageKey,
          sprites: sprite,
          editableIndex: index,
          clip: {
            startFrame: 0,
            duration: videoItem.movie.params?.frames || 0
          },
          // 初始化动画轨道
          tracks: {
            position: {
              keyframes: [],
              currentValue: { x: 0, y: 0 },
              defaultValue: { x: 0, y: 0 }
            },
            scale: {
              keyframes: [],
              currentValue: { scaleX: 1, scaleY: 1 },
              defaultValue: { scaleX: 1, scaleY: 1 }
            },
            rotation: {
              keyframes: [],
              currentValue: 0,
              defaultValue: 0
            },
            alpha: {
              keyframes: [],
              currentValue: 1,
              defaultValue: 1
            }
          }
        }))
        
        // 初始化图片资源库
        const imageResources = new Map<string, ImageResource>()
        if (videoItem.images) {
          Object.entries(videoItem.images).forEach(([key, img]) => {
            imageResources.set(key, {
              key,
              data: new Uint8Array(), // 实际数据在 buffers 中
              width: img.width,
              height: img.height,
              mimeType: 'image/png'
            })
          })
        }
        
        set({ layers, selectedLayerId: null, selectedLayerIds: [], imageResources })
      }
    },

    setSource: (source, type) => {
      set({ currentSource: source, sourceType: type })
    },

    setOriginalBuffer: (buffer) => {
      set({ originalBuffer: buffer })
    },

    captureProjectDocument: () => {
      finishSlotConfigEdit(true)
      finishCanvasEdit(true)
      get().setPlaying(false)
      // 暂停回调会同步真实绘制帧，必须在暂停后获取文档与游标。
      const document = captureProjectState(get())
      if (!document) {
        throw new Error('工程数据不完整，请先打开一个有效的 SVGA 文件。')
      }
      return document
    },

    captureProjectRecovery: () => {
      const state = get()
      // 草稿可能随后被 Esc 取消；自动恢复不能擅自提交草稿、打断手势或暂停动画。
      if (state.isCanvasTransforming || state.isSlotConfigEditing) return null
      return captureProjectState(state)
    },

    restoreProjectDocument: (document, filePath, displayName) => {
      // 解码、校验和图片水化完成后才进入此方法；构建新状态期间不触碰正在编辑的文件。
      const previous = get()
      const layers = document.layers.map(cloneLayer)
      const selection = selectionForLayers(document.selectedLayerIds, layers)
      if (document.selectedLayerId && layers.some(layer => layer.id === document.selectedLayerId)) {
        selection.selectedLayerIds = [...selection.selectedLayerIds.filter(id => id !== document.selectedLayerId), document.selectedLayerId]
        selection.selectedLayerId = document.selectedLayerId
      }
      const totalFrames = document.customFrames ?? document.params.frames
      const fps = document.customFps ?? document.params.fps
      const currentFrame = Math.max(0, Math.min(Number.isFinite(document.currentFrame) ? Math.floor(document.currentFrame) : 0, Math.max(0, totalFrames - 1)))
      const restored = {
        currentSource: projectBaseName(document.name),
        // 工程中的来源只有名称，不能当作可覆盖的原始 SVGA 路径。
        sourceType: null,
        projectName: projectBaseName(displayName, '未命名工程.svgaproj'),
        projectFilePath: filePath,
        // 每次打开均建立新文档引用，旧文件的异步保存和草稿回调不能命中新文件。
        videoItem: cloneProjectVideo(document.videoItem),
        originalBuffer: document.originalBuffer.slice(0),
        params: { ...document.params },
        customFps: document.customFps,
        customFrames: document.customFrames,
        layers,
        ...selection,
        imageResources: cloneImageResources(document.imageResources),
        audioResources: cloneAudioResources(document.audioResources),
        slotConfigs: cloneSlotConfigs(document.slotConfigs),
        detectedSlots: [...document.detectedSlots],
        compressionConfig: cloneCompressionConfig(document.compressionConfig),
        optimizationConfig: cloneOptimizationConfig(document.optimizationConfig),
        selectedPresetId: document.selectedPresetId,
        optimizationStats: null,
        playback: { ...previous.playback, isPlaying: false, totalFrames, fps, currentFrame },
        keyframes: [],
        selectedKeyframeIds: [],
        isDirty: false,
        isCanvasTransforming: false,
        isSlotConfigEditing: false,
        canUndo: false,
        canRedo: false
      }
      const snapshot = createSnapshot({ ...previous, ...restored })
      canvasEdit = null
      slotEdit = null
      set({
        ...restored,
        history: {
          past: [], future: [], maxDepth: previous.history.maxDepth, isApplyingHistory: false,
          baseLabel: '打开工程', snapshots: [{ id: uuid(), name: '打开工程', snapshot }],
          activeSnapshotId: null, timelineSnapshot: null
        }
      })
    },

    markProjectSaved: (expectedInputs, filePath, displayName) => {
      const state = get()
      if (!state.videoItem || !state.params || !state.originalBuffer
        || !sameExportInputs(expectedInputs, captureExportInputs(state))) return false
      // 新手势还未修改数据时也不结束用户输入；避免取消草稿恢复旧的 dirty 标记。
      if (canvasEdit || slotEdit) return false
      set({ isDirty: false, projectName: projectBaseName(displayName, '未命名工程.svgaproj'), projectFilePath: filePath })
      return true
    },

    setParams: (params) => {
      withHistory({ params, isDirty: true }, '修改动画参数')
      if (params) {
        set({
          playback: {
            ...get().playback,
            totalFrames: params.frames,
            fps: params.fps
          }
        })
      }
    },

    setCanvasSize: (width, height) => {
      const size = { width, height }
      const error = getCanvasSizeError(size)
      if (error) return { changed: false, error }
      const current = get()
      if (!current.params || !current.videoItem) return { changed: false, error: '请先打开 SVGA 文件。' }
      if (current.params.viewBoxWidth === width && current.params.viewBoxHeight === height) return { changed: false }

      finishCanvasEdit(true)
      get().setPlaying(false)
      const state = get()
      if (!state.params || !state.videoItem) return { changed: false, error: '当前文件已关闭。' }
      const nextParams = replaceCanvasSize(state.params, size)
      // 渲染器、手柄命中与画布排版都读取 movie.params；不可原地改共享对象，否则污染撤销快照。
      const nextVideoItem = {
        ...state.videoItem,
        movie: { ...state.videoItem.movie, params: replaceCanvasSize(state.videoItem.movie.params, size) }
      }
      withHistory({ params: nextParams, videoItem: nextVideoItem, isDirty: true }, `修改画布尺寸：${width} × ${height}`)
      return { changed: true }
    },

    setCustomFps: (fps) => {
      withHistory({ customFps: fps, isDirty: true }, '修改帧率')
      const state = get()
      const nextFps = fps ?? state.params?.fps ?? state.playback.fps
      set({
        playback: {
          ...state.playback,
          fps: nextFps
        }
      })
    },

    setCustomFrames: (frames) => {
      withHistory({ customFrames: frames, isDirty: true }, '修改总帧数')
      const state = get()
      const nextFrames = frames ?? state.params?.frames ?? state.playback.totalFrames
      set({
        playback: {
          ...state.playback,
          totalFrames: nextFrames,
          currentFrame: Math.min(state.playback.currentFrame, Math.max(0, nextFrames - 1))
        }
      })
    },

    // 图层操作
    setLayers: (layers) => {
      withHistory({ layers, ...selectionForLayers(getSelectedLayerIds(get()), layers), isDirty: true }, '更新图层')
    },

    selectLayer: (layerId, additive = false) => {
      const selected = getSelectedLayerIds(get())
      const ids = !layerId ? [] : !additive ? [layerId] : selected.includes(layerId) ? selected.filter(id => id !== layerId) : [...selected, layerId]
      get().selectLayers(ids)
    },

    selectLayers: (layerIds) => {
      const next = selectionForLayers(layerIds, get().layers)
      if (JSON.stringify(getSelectedLayerIds(get())) !== JSON.stringify(next.selectedLayerIds)) finishCanvasEdit(true)
      set(next)
    },

    updateCanvasTransform: (layerId, transform) => {
      const layer = get().layers.find(layer => layer.id === layerId)
      if (!layer || layer.locked || !layer.visible) return
      const next = normalizeCanvasTransform({ ...normalizeCanvasTransform(layer.canvasTransform), ...transform })
      if (JSON.stringify(next) === JSON.stringify(normalizeCanvasTransform(layer.canvasTransform))) return
      withHistory(state => ({ layers: state.layers.map(layer => layer.id === layerId ? { ...layer, canvasTransform: next } : layer), isDirty: true }), `画布变换：${layer.name}`)
    },

    beginCanvasTransform: (layerId) => {
      return get().beginCanvasTransforms([layerId])
    },

    beginCanvasTransforms: (layerIds) => {
      finishSlotConfigEdit(true)
      finishCanvasEdit(true)
      let state = get()
      const ids = [...new Set(layerIds)]
      // 拒绝不完整或含锁定/隐藏项的集合，避免用户以为整个选区都已移动。
      if (!ids.length || !state.videoItem || ids.some(id => { const layer = state.layers.find(item => item.id === id); return !layer || layer.locked || !layer.visible })) return false
      if (state.transformEditMode === 'keyframe' && ids.length !== 1) return false
      state.setPlaying(false)
      // 暂停可能同步播放器的实际帧；关键帧必须写入这一帧而非暂停前的旧状态。
      state = get()
      if (state.transformEditMode === 'keyframe' && getKeyframeEditError(state.layers.find(layer => layer.id === ids[0])!, state.playback.currentFrame, state.playback.totalFrames)) return false
      canvasEdit = { before: createSnapshot(state), layerIds: ids, video: state.videoItem, buffer: state.originalBuffer, originalLayers: state.layers, latestLayers: state.layers, dirty: state.isDirty, mode: state.transformEditMode, outputFrame: state.playback.currentFrame }
      set({ isCanvasTransforming: true })
      return true
    },

    previewCanvasTransform: (layerId, transform) => {
      if (!canvasEdit || canvasEdit.layerIds.length !== 1 || canvasEdit.layerIds[0] !== layerId) { finishCanvasEdit(false); return }
      const edit = canvasEdit
      const state = get()
      if (state.layers !== edit.latestLayers || state.videoItem !== edit.video || state.originalBuffer !== edit.buffer) { finishCanvasEdit(false); return }
      if (!Object.values(transform).every(Number.isFinite)) return
      const original = edit.originalLayers.find(layer => layer.id === layerId)!
      const baseline = normalizeCanvasTransform(original.canvasTransform)
      if (edit.mode === 'whole') {
        const animation = sampleAnimationValues(original, edit.outputFrame)
        const stable = (value: number, originalValue: number) => Math.abs(value - originalValue) <= 1e-9 ? originalValue : value
        // 缩到零时仍可移动/旋转；不能通过除零把整段缩放改为无效值。
        if ((animation.scale.scaleX === 0 && transform.scaleX !== 0) || (animation.scale.scaleY === 0 && transform.scaleY !== 0)) return
        get().previewCanvasTransforms({ [layerId]: {
          x: stable(transform.x - animation.position.x, baseline.x), y: stable(transform.y - animation.position.y, baseline.y),
          scaleX: animation.scale.scaleX === 0 ? baseline.scaleX : stable(transform.scaleX / animation.scale.scaleX, baseline.scaleX),
          scaleY: animation.scale.scaleY === 0 ? baseline.scaleY : stable(transform.scaleY / animation.scale.scaleY, baseline.scaleY),
          rotation: stable(transform.rotation - animation.rotation * Math.PI / 180, baseline.rotation)
        } })
        return
      }
      const initial = resolveCanvasTransform(original, edit.outputFrame)
      const differs = (a: number, b: number) => Math.abs(a - b) > 1e-9
      let updated = original
      if (differs(initial.x, transform.x) || differs(initial.y, transform.y)) {
        updated = upsertAnimationValue(updated, 'position', { x: transform.x - baseline.x, y: transform.y - baseline.y }, edit.outputFrame, uuid, true)
      }
      if (differs(initial.scaleX, transform.scaleX) || differs(initial.scaleY, transform.scaleY)) {
        if (baseline.scaleX === 0 || baseline.scaleY === 0) return
        const scale = { scaleX: transform.scaleX / baseline.scaleX, scaleY: transform.scaleY / baseline.scaleY }
        if (!isValidAnimationValue('scale', scale)) return
        updated = upsertAnimationValue(updated, 'scale', scale, edit.outputFrame, uuid, true)
      }
      if (differs(initial.rotation, transform.rotation)) {
        updated = upsertAnimationValue(updated, 'rotation', (transform.rotation - baseline.rotation) * 180 / Math.PI, edit.outputFrame, uuid, true)
      }
      const layers = state.layers.map(layer => layer.id === layerId ? updated : layer)
      edit.latestLayers = layers
      set({ layers, isDirty: updated === original ? edit.dirty : true })
    },

    previewCanvasTransforms: (transforms) => {
      const edit = canvasEdit
      const state = get()
      if (!edit || state.layers !== edit.latestLayers || state.videoItem !== edit.video || state.originalBuffer !== edit.buffer) { finishCanvasEdit(false); return }
      if (edit.mode !== 'whole' || Object.values(transforms).some(transform => !Object.values(transform).every(Number.isFinite))) return
      const ids = new Set(edit.layerIds)
      if (Object.keys(transforms).length !== ids.size || edit.layerIds.some(id => !Object.prototype.hasOwnProperty.call(transforms, id))) { finishCanvasEdit(false); return }
      const layers = state.layers.map(layer => ids.has(layer.id) ? { ...layer, canvasTransform: normalizeCanvasTransform(transforms[layer.id]) } : layer)
      edit.latestLayers = layers
      set({ layers, isDirty: true })
    },

    endCanvasTransform: (commit) => {
      // 既有保存/导出入口会调用此方法，必须先收束当前文字草稿。
      // 画布自身的取消/卸载不得连带取消另一个面板的输入。
      if (commit) finishSlotConfigEdit(true)
      finishCanvasEdit(commit)
    },

    arrangeLayers: (operation, target) => {
      finishCanvasEdit(true)
      get().setPlaying(false)
      // 暂停回调会同步实际绘制帧，必须在其后重新读取状态和几何。
      const state = get()
      const ids = new Set(getSelectedLayerIds(state))
      const selected = state.layers.filter(layer => ids.has(layer.id))
      const plan = planLayerLayout(selected, state.playback.currentFrame, state.videoItem, state.imageResources, operation, target)
      if ('error' in plan || !plan.changed) return plan
      withHistory(current => ({
        layers: current.layers.map(layer => Object.prototype.hasOwnProperty.call(plan.transforms, layer.id)
          ? { ...layer, canvasTransform: plan.transforms[layer.id] } : layer),
        isDirty: true
      }), `${LAYOUT_LABELS[operation]}：${selected.length} 个图层（${target === 'canvas' ? '画布' : '选区'}）`)
      return plan
    },

    arrangeLayerTiming: (request) => {
      finishCanvasEdit(true)
      get().setPlaying(false)
      const state = get()
      const selectedIds = getSelectedLayerIds(state)
      const plan = planLayerTiming(state.layers, selectedIds, state.videoItem, state.playback.totalFrames, request)
      if ('error' in plan || !plan.changed) return plan
      const label = request.mode === 'reset' ? '重置时间偏移' : request.mode === 'stagger' ? '依次错开图层' : request.frames < 0 ? '提前图层' : '延后图层'
      withHistory(current => ({
        layers: current.layers.map(layer => Object.prototype.hasOwnProperty.call(plan.offsets, layer.id)
          ? { ...layer, timeOffsetFrames: plan.offsets[layer.id] } : layer),
        customFrames: plan.totalFrames === current.playback.totalFrames ? current.customFrames : plan.totalFrames,
        playback: { ...current.playback, totalFrames: plan.totalFrames },
        isDirty: true
      }), `${label}：${selectedIds.length} 个图层`)
      return plan
    },

    updateLayer: (layerId, updates) => {
      const action = updates.name !== undefined ? '重命名图层'
        : updates.visible !== undefined ? (updates.visible ? '显示图层' : '隐藏图层')
        : updates.locked !== undefined ? (updates.locked ? '锁定图层' : '解锁图层') : '修改图层属性'
      withHistory((state) => ({
        layers: state.layers.map((layer) =>
          layer.id === layerId ? { ...layer, ...updates } : layer
        ),
        isDirty: true
      }), `${action}：${get().layers.find(layer => layer.id === layerId)?.name || layerId}`)
    },

    updateLayerTrackDefaultValue: (layerId, trackKey, value) => {
      withHistory((state) => ({
        layers: state.layers.map((layer) => {
          if (layer.id !== layerId) return layer
          const track = layer.tracks[trackKey]
          return {
            ...layer,
            tracks: {
              ...layer.tracks,
              [trackKey]: { ...track, defaultValue: value, currentValue: value }
            }
          }
        }),
        isDirty: true
      }), `调整${({ position: '位置', scale: '缩放', rotation: '旋转', alpha: '透明度' })[trackKey]}：${get().layers.find(layer => layer.id === layerId)?.name || layerId}`)
    },

    reorderLayers: (fromIndex, toIndex) => {
      withHistory((state) => {
        const layers = [...state.layers]
        const [removed] = layers.splice(fromIndex, 1)
        layers.splice(toIndex, 0, removed)
        return { layers, isDirty: true }
      }, '调整图层顺序')
    },

    addLayer: (layer) => {
      const id = uuid()
      withHistory((state) => ({
        layers: [...state.layers, { ...layer, id }],
        selectedLayerId: id,
        selectedLayerIds: [id],
        isDirty: true
      }), `新增图层：${layer.name}`)
      return id
    },

    operateLayers: (ids, operation, expectedInputs) => {
      const state = get()
      if (!state.videoItem || expectedInputs && !sameExportInputs(expectedInputs, captureExportInputs(state))) {
        return { changed: false, error: '工程内容已变化，请重新选择图层后操作。' }
      }
      if (state.isCanvasTransforming || state.isSlotConfigEditing) return { changed: false, error: '请先结束当前编辑，再操作图层。' }
      const targets = new Set(ids)
      if (!targets.size || [...targets].some(id => !state.layers.some(layer => layer.id === id))) return { changed: false, error: '没有有效的图层选区，请重新选择。' }
      const chosen = state.layers.filter(layer => targets.has(layer.id))
      if (operation === 'delete' && chosen.some(layer => layer.locked)) {
        return { changed: false, error: '选区包含锁定图层，请先解锁；本次未删除任何图层。' }
      }
      const labels = { delete: '批量删除', show: '批量显示', hide: '批量隐藏', lock: '批量锁定', unlock: '批量解锁' }
      if (!Object.prototype.hasOwnProperty.call(labels, operation)) return { changed: false, error: '不支持的图层操作。' }
      const layers = operation === 'delete' ? state.layers.filter(layer => !targets.has(layer.id)) : state.layers.map(layer => {
        if (!targets.has(layer.id)) return layer
        const field = operation === 'lock' || operation === 'unlock' ? 'locked' : 'visible'
        const value = operation === 'lock' || operation === 'show'
        return layer[field] === value ? layer : { ...layer, [field]: value }
      })
      if (operation === 'delete') {
        const keyOf = (layer: Layer) => layer.imageKey ?? layer.sprites?.imageKey
        const removedKeys = new Set(chosen.map(keyOf).filter(Boolean))
        const keptKeys = new Set(layers.map(keyOf).filter(Boolean))
        const brokenMatte = layers.some(layer => {
          const sprite = layer.sprites ?? (!layer.isNew && layer.editableIndex !== undefined ? state.videoItem?.movie.sprites[layer.editableIndex] : undefined)
          return sprite?.matteKey && removedKeys.has(sprite.matteKey) && !keptKeys.has(sprite.matteKey)
        })
        if (brokenMatte) return { changed: false, error: '选区包含其他图层仍在使用的遮罩，请连同依赖图层一起选择；本次未删除。' }
      }
      if (layers.length === state.layers.length && layers.every((layer, index) => layer === state.layers[index])) return { changed: false }
      withHistory({ layers, ...selectionForLayers(getSelectedLayerIds(state), layers), isDirty: true }, `${labels[operation]}：${targets.size} 个图层`)
      return { changed: true }
    },

    deleteLayer: (layerId) => {
      withHistory((state) => ({
        layers: state.layers.filter((l) => l.id !== layerId),
        ...selectionForLayers(getSelectedLayerIds(state).filter(id => id !== layerId), state.layers),
        isDirty: true
      }), `删除图层：${get().layers.find(layer => layer.id === layerId)?.name || layerId}`)
    },

    duplicateLayer: (layerId) => {
      finishCanvasEdit(true)
      const state = get()
      const layer = state.layers.find((l) => l.id === layerId)
      if (!layer || getLayerDuplicateError(layer, state.layers, state.videoItem)) return null

      const newId = uuid()
      const duplicated: Layer = {
        ...cloneLayer(layer),
        id: newId,
        name: `${layer.name} (副本)`,
        isNew: true,
        tracks: cloneAnimationTracks(layer.tracks, uuid),
        animationTracks: layer.animationTracks ? cloneAnimationTracks(layer.animationTracks, uuid) : undefined
      }

      withHistory((state) => ({
        layers: [...state.layers, duplicated],
        selectedLayerId: newId,
        selectedLayerIds: [newId],
        isDirty: true
      }), `复制图层：${layer.name}`)

      return newId
    },

    // 资源操作
    addImageResource: (resource) => {
      withHistory((state) => {
        const newResources = new Map(state.imageResources)
        newResources.set(resource.key, resource)
        return { imageResources: newResources, isDirty: true }
      }, `添加图片资源：${resource.key}`)
    },

    removeImageResource: (key) => {
      withHistory((state) => {
        const newResources = new Map(state.imageResources)
        const removedResource = newResources.get(key)
        newResources.delete(key)
        const { [key]: _, ...slotConfigs } = state.slotConfigs
        const shouldRemoveLayers = Boolean(removedResource?.isNew)
        const layers = shouldRemoveLayers
          ? state.layers.filter((layer) => layer.imageKey !== key)
          : state.layers

        return {
          imageResources: newResources,
          slotConfigs,
          layers,
          ...selectionForLayers(getSelectedLayerIds(state), layers),
          isDirty: true
        }
      }, `删除图片资源：${key}`)
    },

    getImageResource: (key) => {
      return get().imageResources.get(key)
    },

    renameImageKey: (layerId, newKey) => {
      const state = get()
      const layer = state.layers.find((l) => l.id === layerId)
      if (!layer || !layer.imageKey) return

      const oldKey = layer.imageKey
      if (oldKey === newKey) return
      if (!newKey.trim()) return
      get().renameImageResourceKey(oldKey, newKey)
    },

    renameImageResourceKey: (oldKey, newKey) => {
      const trimmedKey = newKey.trim()
      if (!oldKey || !trimmedKey) return false
      if (oldKey === trimmedKey) return true

      const state = get()
      const keyConflict = state.layers.some(
        (layer) => layer.imageKey === trimmedKey && layer.imageKey !== oldKey
      ) ||
        state.imageResources.has(trimmedKey) ||
        Boolean(state.videoItem?.buffers?.[trimmedKey]) ||
        Boolean(state.videoItem?.images?.[trimmedKey]) ||
        Boolean(state.slotConfigs[trimmedKey])

      if (keyConflict) {
        console.warn(`[renameImageResourceKey] Key "${trimmedKey}" already exists, aborting`)
        return false
      }

      const hasSource =
        state.layers.some((layer) => layer.imageKey === oldKey) ||
        state.imageResources.has(oldKey) ||
        Boolean(state.videoItem?.buffers?.[oldKey]) ||
        Boolean(state.videoItem?.images?.[oldKey]) ||
        Boolean(state.slotConfigs[oldKey])

      if (!hasSource) {
        return false
      }

      withHistory((state) => {
        const layers = state.layers.map((layer) => {
          if (layer.imageKey !== oldKey) return layer
          return {
            ...layer,
            imageKey: trimmedKey,
            name: layer.name === oldKey ? trimmedKey : layer.name,
            sprites: layer.sprites
              ? {
                  ...layer.sprites,
                  imageKey: layer.sprites.imageKey === oldKey ? trimmedKey : layer.sprites.imageKey,
                  matteKey: layer.sprites.matteKey === oldKey ? trimmedKey : layer.sprites.matteKey
                }
              : undefined
          }
        })

        let videoItem = state.videoItem
        if (videoItem) {
          const movie = { ...videoItem.movie }
          movie.sprites = movie.sprites.map((sprite) => ({
            ...sprite,
            imageKey: sprite.imageKey === oldKey ? trimmedKey : sprite.imageKey,
            matteKey: sprite.matteKey === oldKey ? trimmedKey : sprite.matteKey
          }))

          const buffers = { ...videoItem.buffers }
          if (buffers[oldKey] !== undefined) {
            buffers[trimmedKey] = buffers[oldKey]
            delete buffers[oldKey]
          }

          const images = { ...videoItem.images }
          if (images[oldKey] !== undefined) {
            images[trimmedKey] = images[oldKey]
            delete images[oldKey]
          }

          videoItem = { ...videoItem, movie, buffers, images }
        }

        const imageResources = new Map(state.imageResources)
        const resource = imageResources.get(oldKey)
        if (resource) {
          imageResources.delete(oldKey)
          imageResources.set(trimmedKey, { ...resource, key: trimmedKey })
        }

        let slotConfigs = state.slotConfigs
        if (slotConfigs[oldKey]) {
          const { [oldKey]: slotConfig, ...rest } = slotConfigs
          slotConfigs = { ...rest, [trimmedKey]: { ...slotConfig, name: trimmedKey } }
        }

        const detectedSlots = state.detectedSlots.map((slot) =>
          slot === oldKey ? trimmedKey : slot
        )

        return {
          layers,
          videoItem,
          imageResources,
          slotConfigs,
          detectedSlots,
          isDirty: true
        }
      }, `重命名图片资源：${oldKey} → ${trimmedKey}`)

      return true
    },

    // 音频资源操作
    addAudioResource: (resource) => {
      withHistory((state) => {
        const newResources = new Map(state.audioResources)
        newResources.set(resource.key, resource)
        return { audioResources: newResources, isDirty: true }
      }, `添加音频：${resource.key}`)
    },

    removeAudioResource: (key) => {
      withHistory((state) => {
        const newResources = new Map(state.audioResources)
        newResources.delete(key)
        return { audioResources: newResources, isDirty: true }
      }, `删除音频：${key}`)
    },

    getAudioResource: (key) => {
      return get().audioResources.get(key)
    },

    setAudioResources: (resources) => {
      withHistory({ audioResources: resources, isDirty: true }, '更新音频资源')
    },

    // 插槽操作
    applySlotTextValues: (values, expectedInputs) => {
      const state = get()
      if (!state.videoItem || !sameExportInputs(expectedInputs, captureExportInputs(state))) {
        return { changed: false, error: '工程内容已变化，请重新预检后应用。' }
      }
      // 不在批量应用时隐式提交其他工具的草稿，避免失败操作也改变历史。
      if (state.isSlotConfigEditing || state.isCanvasTransforming) {
        return { changed: false, error: '请先结束文字输入或画布变换，再重新预检。' }
      }
      const entries = Object.entries(values)
      if (!entries.length || entries.length > 128) return { changed: false, error: '请选择 1–128 个文字 Key。' }
      const eligible = new Set(buildSlotCatalog(state.videoItem, state.layers, state.imageResources, state.slotConfigs)
        .filter(entry => entry.canSimulateText).map(entry => entry.key))
      const next = { ...state.slotConfigs }
      let changed = false
      try {
        for (const [key, value] of entries) {
          if (!eligible.has(key)) throw new Error(`Key ${JSON.stringify(key)} 已不可用于文字模拟。`)
          if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 500) {
            throw new Error(`Key ${JSON.stringify(key)} 需要非空且不超过 500 码点的文案。`)
          }
          const previous = ownSlotConfig(state.slotConfigs, key)
          const textConfig = normalizeTextConfig({ ...previous?.textConfig, text: value, enabled: true })
          const config = mergeSlotTextConfig(previous, key, textConfig)
          if (slotConfigSignature(previous) !== slotConfigSignature(config)) {
            // defineProperty 保留 __proto__ 等合法精确 Key，不触发对象原型赋值。
            Object.defineProperty(next, key, { value: config, enumerable: true, writable: true, configurable: true })
            changed = true
          }
        }
      } catch (error) {
        return { changed: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (changed) withHistory({ slotConfigs: next, isDirty: true }, `应用清单文案：${entries.length} 个 Key`)
      return { changed }
    },

    setSlotConfig: (key, config) => {
      withHistory((state) => ({
        slotConfigs: { ...state.slotConfigs, [key]: config },
        isDirty: true
      }), `${config.type === 'image' ? '替换图片' : '设置文字插槽'}：${key}`)
    },

    removeSlotConfig: (key) => {
      withHistory((state) => {
        const { [key]: _, ...rest } = state.slotConfigs
        return { slotConfigs: rest, isDirty: true }
      }, `清除素材替换：${key}`)
    },

    beginSlotConfigEdit: (key) => {
      const current = get()
      if (!isKnownSlotKey(current, key)) return false
      const active = slotEdit
      if (active && active.key === key && current.videoItem === active.video
        && current.originalBuffer === active.buffer && current.slotConfigs === active.latestSlotConfigs) return true
      // 文本预览与画布拖动共用“单一活动事务”，切换工具时先提交上一个草稿。
      finishSlotConfigEdit(true)
      finishCanvasEdit(true)
      const state = get()
      if (!isKnownSlotKey(state, key)) return false
      slotEdit = {
        before: createSnapshot(state),
        key,
        video: state.videoItem!,
        buffer: state.originalBuffer,
        originalSlotConfigs: state.slotConfigs,
        latestSlotConfigs: state.slotConfigs,
        dirty: state.isDirty
      }
      set({ isSlotConfigEditing: true })
      return true
    },

    previewSlotConfig: (key, config) => {
      const edit = slotEdit
      if (!edit || edit.key !== key) return
      const state = get()
      // 文件、原始缓冲区或配置引用发生变化时，当前回调已过期，直接丢弃。
      if (state.videoItem !== edit.video || state.originalBuffer !== edit.buffer
        || state.slotConfigs !== edit.latestSlotConfigs || !isKnownSlotKey(state, key)) {
        slotEdit = null
        set({ isSlotConfigEditing: false })
        return
      }
      if (config.name !== key || (config.type !== 'image' && config.type !== 'text')) return
      const nextConfig: SlotConfig = {
        ...config,
        imageConfig: config.imageConfig ? { ...config.imageConfig } : undefined,
        textConfig: config.textConfig ? { ...config.textConfig } : undefined
      }
      const previous = ownSlotConfig(state.slotConfigs, key)
      if (slotConfigSignature(previous) === slotConfigSignature(nextConfig)) return
      const slotConfigs = { ...state.slotConfigs, [key]: nextConfig }
      edit.latestSlotConfigs = slotConfigs
      const changed = slotConfigSignature(nextConfig) !== slotConfigSignature(ownSlotConfig(edit.before.slotConfigs, key))
      set({ slotConfigs, isDirty: changed ? true : edit.dirty, isSlotConfigEditing: true })
    },

    endSlotConfigEdit: (commit) => {
      finishSlotConfigEdit(commit)
    },

    setDetectedSlots: (slots) => {
      withHistory({ detectedSlots: slots, isDirty: true }, '更新插槽列表')
    },

    // 播放控制
    setPlaying: (playing) => {
      if (playing) finishCanvasEdit(true)
      set((state) => ({
        playback: { ...state.playback, isPlaying: playing }
      }))
    },

    setCurrentFrame: (frame) => {
      if (frame !== get().playback.currentFrame) finishCanvasEdit(true)
      set((state) => ({
        playback: { ...state.playback, currentFrame: frame }
      }))
    },

    toggleLoop: () => {
      set((state) => ({
        playback: { ...state.playback, loop: !state.playback.loop }
      }))
    },

    setSpeed: (speed) => {
      set((state) => ({
        playback: { ...state.playback, speed }
      }))
    },

    // 关键帧操作
    addKeyframe: (keyframe) => {
      withHistory((state) => ({
        keyframes: [...state.keyframes, { ...keyframe, id: uuid() }],
        isDirty: true
      }), '新增关键帧')
    },

    updateKeyframe: (id, updates) => {
      withHistory((state) => ({
        keyframes: state.keyframes.map((kf) =>
          kf.id === id ? { ...kf, ...updates } : kf
        ),
        isDirty: true
      }), '修改关键帧')
    },

    deleteKeyframe: (id) => {
      withHistory((state) => ({
        keyframes: state.keyframes.filter((kf) => kf.id !== id),
        isDirty: true
      }), '删除关键帧')
    },

    selectKeyframe: (id, multi = false) => {
      set((state) => {
        if (multi) {
          const selected = state.selectedKeyframeIds.includes(id)
          return {
            selectedKeyframeIds: selected
              ? state.selectedKeyframeIds.filter((i) => i !== id)
              : [...state.selectedKeyframeIds, id]
          }
        }
        return { selectedKeyframeIds: [id] }
      })
    },

    insertAnimationKeyframes: (layerIds, trackKeys, outputFrame) => {
      const state = prepareAnimationEdit()
      const frame = outputFrame ?? state.playback.currentFrame
      const ids = [...new Set(layerIds)]
      const keys = [...new Set(trackKeys)]
      if (!ids.length || !keys.length) return { changed: false, error: '请先选择图层和动画属性' }
      if (keys.some(key => !isEditableTrack(key))) return { changed: false, error: '不支持的动画属性' }
      for (const id of ids) {
        const layer = state.layers.find(item => item.id === id)
        const error = layer ? getKeyframeEditError(layer, frame, state.playback.totalFrames) : '图层不存在'
        if (error) return { changed: false, error }
      }
      const selected = new Set(ids)
      const layers = state.layers.map(layer => {
        if (!selected.has(layer.id)) return layer
        const sourceFrame = getLayerSourceFrame(layer, frame)
        const sampled = sampleAnimationValues(layer, frame)
        return keys.reduce((updated, key) => {
          if (updated.animationTracks?.[key].keyframes.some(item => item.frameIndex === sourceFrame)) return updated
          return upsertAnimationValue(updated, key, sampled[key], frame, uuid, false)
        }, layer)
      })
      return saveAnimationLayers(layers, `插入关键帧：${ids.length} 个图层 · ${keys.map(key => TRACK_LABELS[key]).join('、')}`)
    },

    setAnimationValue: (layerId, track, value, outputFrame) => {
      const state = prepareAnimationEdit()
      const layer = state.layers.find(item => item.id === layerId)
      const frame = outputFrame ?? state.playback.currentFrame
      const error = layer ? getKeyframeEditError(layer, frame, state.playback.totalFrames) : '图层不存在'
      if (error || !layer) return { changed: false, error: error! }
      if (!isEditableTrack(track) || !isValidAnimationValue(track, value)) return { changed: false, error: '属性值无效；缩放不可为负数，不透明度需在 0–100% 之间' }
      const updated = upsertAnimationValue(layer, track, value, frame, uuid, true)
      return saveAnimationLayers(state.layers.map(item => item.id === layerId ? updated : item), `修改${TRACK_LABELS[track]}关键帧：${layer.name}`)
    },

    moveAnimationKeyframe: (layerId, track, id, outputFrame) => {
      const state = prepareAnimationEdit()
      const layer = state.layers.find(item => item.id === layerId)
      const error = layer ? getKeyframeEditError(layer, outputFrame, state.playback.totalFrames) : '图层不存在'
      if (error || !layer) return { changed: false, error: error! }
      if (!isEditableTrack(track)) return { changed: false, error: '不支持的动画属性' }
      const sourceTrack = layer.animationTracks?.[track]
      const keyframe = sourceTrack?.keyframes.find(key => key.id === id)
      if (!sourceTrack || !keyframe) return { changed: false, error: '关键帧不存在' }
      const sourceFrame = getLayerSourceFrame(layer, outputFrame)
      if (keyframe.frameIndex === sourceFrame) return { changed: false }
      if (sourceTrack.keyframes.some(key => key.frameIndex === sourceFrame)) return { changed: false, error: '目标帧已有关键帧，请先移动或删除它' }
      const keyframes = sourceTrack.keyframes.map(key => key.id === id ? { ...key, frameIndex: sourceFrame } : key)
        .sort((a, b) => a.frameIndex - b.frameIndex)
      const updated = { ...layer, animationTracks: { ...layer.animationTracks!, [track]: { ...sourceTrack, keyframes } } }
      return saveAnimationLayers(state.layers.map(item => item.id === layerId ? updated : item), `移动${TRACK_LABELS[track]}关键帧：${layer.name}`)
    },

    deleteAnimationKeyframes: (layerId, track, ids) => {
      if (!ids.length) return { changed: false }
      const state = prepareAnimationEdit()
      const layer = state.layers.find(item => item.id === layerId)
      const error = layer ? getAnimationLayerError(layer) : '图层不存在'
      if (error || !layer) return { changed: false, error: error! }
      if (!isEditableTrack(track)) return { changed: false, error: '不支持的动画属性' }
      const sourceTrack = layer.animationTracks?.[track]
      if (!sourceTrack || ids.some(id => !sourceTrack.keyframes.some(key => key.id === id))) return { changed: false, error: '关键帧不存在' }
      const selected = new Set(ids)
      const keyframes = sourceTrack.keyframes.filter(key => !selected.has(key.id))
      const updated = { ...layer, animationTracks: { ...layer.animationTracks!, [track]: { ...sourceTrack, keyframes } } }
      const result = saveAnimationLayers(state.layers.map(item => item.id === layerId ? updated : item), `删除${TRACK_LABELS[track]}关键帧：${layer.name}`)
      if (result.changed) set({ selectedKeyframeIds: get().selectedKeyframeIds.filter(id => !selected.has(id)) })
      return result
    },

    setAnimationEasing: (layerId, track, ids, easing) => {
      if (!ids.length) return { changed: false }
      const state = prepareAnimationEdit()
      const layer = state.layers.find(item => item.id === layerId)
      const error = layer ? getAnimationLayerError(layer) : '图层不存在'
      if (error || !layer) return { changed: false, error: error! }
      if (!isEditableTrack(track) || !isSupportedEasing(easing)) return { changed: false, error: '不支持的动画属性或缓动类型' }
      const sourceTrack = layer.animationTracks?.[track]
      if (!sourceTrack || ids.some(id => !sourceTrack.keyframes.some(key => key.id === id))) return { changed: false, error: '关键帧不存在' }
      const selected = new Set(ids)
      if (sourceTrack.keyframes.filter(key => selected.has(key.id)).every(key => key.easing === easing)) return { changed: false }
      const keyframes = sourceTrack.keyframes.map(key => selected.has(key.id) ? { ...key, easing } : key)
      const updated = { ...layer, animationTracks: { ...layer.animationTracks!, [track]: { ...sourceTrack, keyframes } } }
      return saveAnimationLayers(state.layers.map(item => item.id === layerId ? updated : item), `调整${TRACK_LABELS[track]}关键帧缓动：${layer.name}`)
    },

    // 图层关键帧操作
    addLayerKeyframe: (layerId, trackKey, keyframe) => {
      withHistory((state) => ({
        layers: state.layers.map((layer) => {
          if (layer.id !== layerId) return layer
          const track = layer.tracks[trackKey]
          const newKeyframe = { ...keyframe, id: uuid() }
          const keyframes = [...track.keyframes, newKeyframe]
            .sort((a, b) => a.frameIndex - b.frameIndex)
          return {
            ...layer,
            tracks: {
              ...layer.tracks,
              [trackKey]: { ...track, keyframes }
            }
          }
        }),
        isDirty: true
      }), '新增图层关键帧')
    },

    updateLayerKeyframe: (layerId, trackKey, keyframeId, updates) => {
      withHistory((state) => ({
        layers: state.layers.map((layer) => {
          if (layer.id !== layerId) return layer
          const track = layer.tracks[trackKey]
          const keyframes = track.keyframes.map((kf) =>
            kf.id === keyframeId ? { ...kf, ...updates } : kf
          )
          return {
            ...layer,
            tracks: {
              ...layer.tracks,
              [trackKey]: { ...track, keyframes }
            }
          }
        }),
        isDirty: true
      }), '修改图层关键帧')
    },

    deleteLayerKeyframe: (layerId, trackKey, keyframeId) => {
      withHistory((state) => ({
        layers: state.layers.map((layer) => {
          if (layer.id !== layerId) return layer
          const track = layer.tracks[trackKey]
          const keyframes = track.keyframes.filter((kf) => kf.id !== keyframeId)
          return {
            ...layer,
            tracks: {
              ...layer.tracks,
              [trackKey]: { ...track, keyframes }
            }
          }
        }),
        isDirty: true
      }), '删除图层关键帧')
    },

    applyAnimationPreset: (layerId, preset, startFrame) => {
      withHistory((state) => {
        const params = state.params
        if (!params) return state

        return {
          layers: state.layers.map((layer) => {
            if (layer.id !== layerId) return layer

            const newTracks = { ...layer.tracks }

            // 应用位置关键帧
            if (preset.keyframes.position) {
              const keyframes = preset.keyframes.position.map((kf, _index) => ({
                id: uuid(),
                frameIndex: startFrame + kf.frame,
                value: {
                  x: kf.x === 'centerX' ? params.viewBoxWidth / 2 : kf.x as number,
                  y: kf.y === 'centerY' ? params.viewBoxHeight / 2 : kf.y as number
                },
                easing: kf.easing
              }))
              newTracks.position = {
                ...newTracks.position,
                keyframes: [...newTracks.position.keyframes, ...keyframes]
                  .sort((a, b) => a.frameIndex - b.frameIndex)
              }
            }

            // 应用缩放关键帧
            if (preset.keyframes.scale) {
              const keyframes = preset.keyframes.scale.map((kf) => ({
                id: uuid(),
                frameIndex: startFrame + kf.frame,
                value: { scaleX: kf.scaleX, scaleY: kf.scaleY },
                easing: kf.easing
              }))
              newTracks.scale = {
                ...newTracks.scale,
                keyframes: [...newTracks.scale.keyframes, ...keyframes]
                  .sort((a, b) => a.frameIndex - b.frameIndex)
              }
            }

            // 应用旋转关键帧
            if (preset.keyframes.rotation) {
              const keyframes = preset.keyframes.rotation.map((kf) => ({
                id: uuid(),
                frameIndex: startFrame + kf.frame,
                value: kf.value,
                easing: kf.easing
              }))
              newTracks.rotation = {
                ...newTracks.rotation,
                keyframes: [...newTracks.rotation.keyframes, ...keyframes]
                  .sort((a, b) => a.frameIndex - b.frameIndex)
              }
            }

            // 应用透明度关键帧
            if (preset.keyframes.alpha) {
              const keyframes = preset.keyframes.alpha.map((kf) => ({
                id: uuid(),
                frameIndex: startFrame + kf.frame,
                value: kf.value,
                easing: kf.easing
              }))
              newTracks.alpha = {
                ...newTracks.alpha,
                keyframes: [...newTracks.alpha.keyframes, ...keyframes]
                  .sort((a, b) => a.frameIndex - b.frameIndex)
              }
            }

            return { ...layer, tracks: newTracks }
          }),
          isDirty: true
        }
      }, `应用动画预设：${preset.name}`)
    },

    // UI 操作
    setZoom: (zoom) => {
      finishCanvasEdit(true)
      set({ zoom: Math.max(0.1, Math.min(5, zoom)) })
    },

    setCanvasOffset: (offset) => {
      finishCanvasEdit(true)
      set({ canvasOffset: offset })
    },

    setPreviewBackgroundColor: (color) => {
      set({ previewBackgroundColor: color })
    },

    toggleGrid: () => {
      set((state) => ({ showGrid: !state.showGrid }))
    },

    toggleOnionSkin: () => {
      set((state) => ({ showOnionSkin: !state.showOnionSkin }))
    },

    setRendererMode: (mode) => {
      set({ rendererMode: mode })
    },
    setCanvasKeepRatio: (value) => set({ canvasKeepRatio: value }),

    setTransformEditMode: (mode) => {
      if (mode !== 'whole' && mode !== 'keyframe') return
      if (mode !== get().transformEditMode) finishCanvasEdit(true)
      set({ transformEditMode: mode })
    },

    // 导出配置
    setCompressionConfig: (config) => {
      withHistory((state) => ({
        compressionConfig: { ...state.compressionConfig, ...config },
        isDirty: true
      }), '修改压缩设置')
    },
    
    // 优化配置
    setOptimizationConfig: (config) => {
      withHistory((state) => ({
        optimizationConfig: { ...state.optimizationConfig, ...config, enabled: config.enabled ?? true },
        selectedPresetId: 'custom',
        isDirty: true
      }), '修改优化设置')
    },
    
    setSelectedPresetId: (id) => {
      const preset = getPreset(id)
      if (!preset) return
      withHistory((state) => ({
        selectedPresetId: id,
        optimizationConfig: id === 'custom' ? { ...state.optimizationConfig, enabled: true } : structuredClone(preset.config),
        isDirty: true
      }), `选择压缩方案：${preset.name}`)
    },
    
    setOptimizationStats: (stats) => {
      set({ optimizationStats: stats })
    },

    undo: () => {
      if (slotEdit) { finishSlotConfigEdit(false); return }
      if (canvasEdit) { finishCanvasEdit(false); return }
      const { history } = get()
      moveToHistory(history.past.length - (history.timelineSnapshot ? 0 : 1))
    },

    redo: () => {
      if (slotEdit) { finishSlotConfigEdit(false); return }
      if (canvasEdit) { finishCanvasEdit(false); return }
      const { history } = get()
      if (!history.timelineSnapshot) moveToHistory(history.past.length + 1)
    },

    jumpToHistory: (index) => moveToHistory(index),

    deleteHistoryState: (index) => {
      const { history } = get()
      if (!Number.isInteger(index) || index <= 0 || index > history.past.length + history.future.length) return
      moveToHistory(index - 1, true)
    },

    initializeHistory: () => {
      finishSlotConfigEdit(false)
      finishCanvasEdit(false)
      const state = get()
      set({
        history: {
          past: [], future: [], maxDepth: state.history.maxDepth, isApplyingHistory: false,
          baseLabel: '打开', snapshots: [{ id: uuid(), name: '打开', snapshot: createSnapshot(state) }],
          activeSnapshotId: null, timelineSnapshot: null
        },
        canUndo: false, canRedo: false, isDirty: false
      })
    },

    createHistorySnapshot: (name) => {
      finishSlotConfigEdit(true)
      finishCanvasEdit(true)
      const state = get()
      const snapshots = state.history.snapshots ?? []
      let number = 1
      while (snapshots.some(snapshot => snapshot.name === `快照 ${number}`)) number++
      const id = uuid()
      set({ history: {
        ...state.history,
        snapshots: [...snapshots, { id, name: name?.trim() || `快照 ${number}`, snapshot: createSnapshot(state) }]
      } })
      return id
    },

    restoreHistorySnapshot: (id) => {
      if (!get().history.snapshots?.some(snapshot => snapshot.id === id)) return
      finishSlotConfigEdit(false)
      finishCanvasEdit(false)
      const state = get()
      const entry = state.history.snapshots?.find(snapshot => snapshot.id === id)
      if (!entry) return
      const current = createSnapshot(state)
      if (state.history.timelineSnapshot && state.history.activeSnapshotId === id
        && !state.playback.isPlaying && isSameSnapshot(current, entry.snapshot)) return
      applySnapshot(entry.snapshot, {
        ...state.history,
        timelineSnapshot: state.history.timelineSnapshot ?? current,
        activeSnapshotId: entry.id, activeSnapshotLabel: entry.name, isApplyingHistory: false
      }, current)
    },

    renameHistorySnapshot: (id, name) => {
      const nextName = name.trim()
      const { history } = get()
      if (!nextName || !history.snapshots?.some(snapshot => snapshot.id === id)) return
      set({ history: {
        ...history,
        snapshots: history.snapshots.map(snapshot => snapshot.id === id ? { ...snapshot, name: nextName } : snapshot),
        activeSnapshotLabel: history.activeSnapshotId === id ? nextName : history.activeSnapshotLabel
      } })
    },

    deleteHistorySnapshot: (id) => {
      const { history } = get()
      if (!history.snapshots?.some(snapshot => snapshot.id === id)) return
      // 删除当前快照只移除书签；当前画面及原时间线仍可继续浏览或编辑。
      set({ history: { ...history, snapshots: history.snapshots.filter(snapshot => snapshot.id !== id) } })
    },

    commitHistory: (label) => {
      const hadActiveEdit = Boolean(slotEdit || canvasEdit)
      finishSlotConfigEdit(true)
      finishCanvasEdit(true)
      if (hadActiveEdit) return
      const state = get()
      const snapshot = createSnapshot(state)
      const previous = state.history.past[state.history.past.length - 1]?.snapshot
      if (!state.history.timelineSnapshot && previous && isSameSnapshot(previous, snapshot)) return
      pushHistory(snapshot, label)
    },

    clearHistory: clearHistoryState,

    // 重置
    reset: () => {
      canvasEdit = null
      slotEdit = null
      set({
        isCanvasTransforming: false,
        isSlotConfigEditing: false,
        canvasKeepRatio: true,
        currentSource: null,
        sourceType: null,
        videoItem: null,
        originalBuffer: null,
        projectName: null,
        projectFilePath: null,
        isDirty: false,
        params: null,
        customFps: null,
        customFrames: null,
        layers: [],
        selectedLayerId: null,
        selectedLayerIds: [],
        imageResources: new Map<string, ImageResource>(),
        audioResources: new Map<string, AudioResource>(),
        slotConfigs: {},
        detectedSlots: [],
        playback: initialPlayback,
        keyframes: [],
        selectedKeyframeIds: [],
        transformEditMode: 'whole',
        zoom: 1,
        canvasOffset: { x: 0, y: 0 },
        previewBackgroundColor: 'transparent',
        showGrid: true,
        showOnionSkin: false,
        rendererMode: 'official',
        compressionConfig: initialCompression,
        optimizationConfig: initialOptimization,
        selectedPresetId: 'balanced',
        optimizationStats: null,
        history: {
          past: [],
          future: [],
          maxDepth: get().history.maxDepth,
          isApplyingHistory: false,
          baseLabel: '打开',
          snapshots: [],
          activeSnapshotId: null,
          timelineSnapshot: null
        },
        canUndo: false,
        canRedo: false
      })
    }
  })})
)

// 计算属性 Hooks
export const useCurrentParams = () => {
  const params = useEditorStore((s) => s.params)
  const customFps = useEditorStore((s) => s.customFps)
  const customFrames = useEditorStore((s) => s.customFrames)

  if (!params) return null

  return {
    ...params,
    fps: customFps ?? params.fps,
    frames: customFrames ?? params.frames
  }
}

export const useCanExport = () => {
  const videoItem = useEditorStore((s) => s.videoItem)
  return videoItem !== null
}
