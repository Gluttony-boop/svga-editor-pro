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
  LayerTracks
} from '@/types'
import type { OptimizationConfig, OptimizationStats } from '@/core/optimizer'
import { getPreset } from '@/core/optimizer'
import { v4 as uuid } from 'uuid'

interface EditorSnapshot {
  params: MovieParams | null
  customFps: number | null
  customFrames: number | null
  layers: Layer[]
  selectedLayerId: string | null
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
}

interface EditorStore {
  // 文件状态
  currentSource: string | null
  sourceType: 'url' | 'file' | null
  videoItem: VideoItem | null
  originalBuffer: ArrayBuffer | null
  isDirty: boolean

  // 动画参数
  params: MovieParams | null
  customFps: number | null
  customFrames: number | null

  // 图层
  layers: Layer[]
  selectedLayerId: string | null

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

  // Actions
  setVideoItem: (videoItem: VideoItem | null) => void
  setSource: (source: string | null, type: 'url' | 'file' | null) => void
  setOriginalBuffer: (buffer: ArrayBuffer | null) => void
  setParams: (params: MovieParams | null) => void
  setCustomFps: (fps: number | null) => void
  setCustomFrames: (frames: number | null) => void
  
  // 图层操作
  setLayers: (layers: Layer[]) => void
  selectLayer: (layerId: string | null) => void
  updateLayer: (layerId: string, updates: Partial<Layer>) => void
  reorderLayers: (fromIndex: number, toIndex: number) => void
  addLayer: (layer: Omit<Layer, 'id'>) => string
  deleteLayer: (layerId: string) => void
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
  removeSlotConfig: (key: string) => void
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

  // UI 操作
  setZoom: (zoom: number) => void
  setCanvasOffset: (offset: { x: number; y: number }) => void
  setPreviewBackgroundColor: (color: string) => void
  toggleGrid: () => void
  toggleOnionSkin: () => void
  setRendererMode: (mode: 'high-performance' | 'official' | 'pixi') => void

  // 导出配置
  setCompressionConfig: (config: Partial<CompressionConfig>) => void
  
  // 优化配置
  setOptimizationConfig: (config: Partial<OptimizationConfig>) => void
  setSelectedPresetId: (id: string) => void
  setOptimizationStats: (stats: OptimizationStats | null) => void

  // 历史操作
  undo: () => void
  redo: () => void
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
          layout: frame.layout ? { ...frame.layout } : null,
          transform: { ...frame.transform },
          shapes: frame.shapes ? frame.shapes.map((shape) => ({ ...shape })) : undefined
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

const createSnapshot = (state: EditorStore): EditorSnapshot => ({
  params: cloneParams(state.params),
  customFps: state.customFps,
  customFrames: state.customFrames,
  layers: state.layers.map(cloneLayer),
  selectedLayerId: state.selectedLayerId,
  imageResources: cloneImageResources(state.imageResources),
  audioResources: cloneAudioResources(state.audioResources),
  slotConfigs: cloneSlotConfigs(state.slotConfigs),
  detectedSlots: [...state.detectedSlots],
  compressionConfig: cloneCompressionConfig(state.compressionConfig),
  optimizationConfig: cloneOptimizationConfig(state.optimizationConfig),
  selectedPresetId: state.selectedPresetId
})

const serializeSnapshot = (snapshot: EditorSnapshot) => JSON.stringify({
  ...snapshot,
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
  serializeSnapshot(a) === serializeSnapshot(b)

export const useEditorStore = create<EditorStore>()(
  subscribeWithSelector((set, get) => {
    const applySnapshot = (snapshot: EditorSnapshot) => {
      set((state) => ({
        params: cloneParams(snapshot.params),
        customFps: snapshot.customFps,
        customFrames: snapshot.customFrames,
        layers: snapshot.layers.map(cloneLayer),
        selectedLayerId: snapshot.selectedLayerId,
        imageResources: cloneImageResources(snapshot.imageResources),
        audioResources: cloneAudioResources(snapshot.audioResources),
        slotConfigs: cloneSlotConfigs(snapshot.slotConfigs),
        detectedSlots: [...snapshot.detectedSlots],
        compressionConfig: cloneCompressionConfig(snapshot.compressionConfig),
        optimizationConfig: cloneOptimizationConfig(snapshot.optimizationConfig),
        selectedPresetId: snapshot.selectedPresetId,
        playback: snapshot.params
          ? {
              ...state.playback,
              totalFrames: snapshot.customFrames ?? snapshot.params.frames,
              fps: snapshot.customFps ?? snapshot.params.fps,
              currentFrame: Math.min(
                state.playback.currentFrame,
                Math.max(0, (snapshot.customFrames ?? snapshot.params.frames) - 1)
              )
            }
          : state.playback,
        isDirty: true
      }))
    }

    const pushHistory = (snapshot: EditorSnapshot, label?: string) => {
      const state = get()
      if (state.history.isApplyingHistory) return

      const previous = state.history.past[state.history.past.length - 1]?.snapshot
      if (previous && isSameSnapshot(previous, snapshot)) return

      const past = [...state.history.past, { snapshot, label }].slice(-state.history.maxDepth)
      set({
        history: { ...state.history, past, future: [] },
        canUndo: past.length > 0,
        canRedo: false
      })
    }

    const withHistory = (updater: Parameters<typeof set>[0], label?: string) => {
      const before = createSnapshot(get())
      set(updater)
      const after = createSnapshot(get())
      if (!isSameSnapshot(before, after)) {
        pushHistory(before, label)
      }
    }

    const clearHistoryState = () => {
      set((state) => ({
        history: { ...state.history, past: [], future: [], isApplyingHistory: false },
        canUndo: false,
        canRedo: false
      }))
    }

    return ({
    // 初始状态
    currentSource: null,
    sourceType: null,
    videoItem: null,
    originalBuffer: null,
    isDirty: false,

    params: null,
    customFps: null,
    customFrames: null,

    layers: [],
    selectedLayerId: null,

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
      isApplyingHistory: false
    },
    canUndo: false,
    canRedo: false,

    // Actions
    setVideoItem: (videoItem) => {
      set({ videoItem, isDirty: false })
      clearHistoryState()
      if (videoItem?.movie.params) {
        const params = videoItem.movie.params
        set({
          params,
          playback: {
            ...get().playback,
            totalFrames: params.frames,
            fps: params.fps,
            currentFrame: 0
          }
        })
      }
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
        
        set({ layers, selectedLayerId: null, imageResources })
      }
    },

    setSource: (source, type) => {
      set({ currentSource: source, sourceType: type })
    },

    setOriginalBuffer: (buffer) => {
      set({ originalBuffer: buffer })
    },

    setParams: (params) => {
      withHistory({ params }, 'Update params')
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

    setCustomFps: (fps) => {
      withHistory({ customFps: fps, isDirty: true }, 'Update FPS')
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
      withHistory({ customFrames: frames, isDirty: true }, 'Update frames')
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
      withHistory({ layers, isDirty: true }, 'Set layers')
    },

    selectLayer: (layerId) => {
      set({ selectedLayerId: layerId })
    },

    updateLayer: (layerId, updates) => {
      withHistory((state) => ({
        layers: state.layers.map((layer) =>
          layer.id === layerId ? { ...layer, ...updates } : layer
        ),
        isDirty: true
      }))
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
      }))
    },

    reorderLayers: (fromIndex, toIndex) => {
      withHistory((state) => {
        const layers = [...state.layers]
        const [removed] = layers.splice(fromIndex, 1)
        layers.splice(toIndex, 0, removed)
        return { layers, isDirty: true }
      })
    },

    addLayer: (layer) => {
      const id = uuid()
      withHistory((state) => ({
        layers: [...state.layers, { ...layer, id }],
        selectedLayerId: id,
        isDirty: true
      }))
      return id
    },

    deleteLayer: (layerId) => {
      withHistory((state) => ({
        layers: state.layers.filter((l) => l.id !== layerId),
        selectedLayerId: state.selectedLayerId === layerId ? null : state.selectedLayerId,
        isDirty: true
      }))
    },

    duplicateLayer: (layerId) => {
      const state = get()
      const layer = state.layers.find((l) => l.id === layerId)
      if (!layer) return null

      const newId = uuid()
      const duplicated: Layer = {
        ...layer,
        id: newId,
        name: `${layer.name} (副本)`,
        isNew: true,
        tracks: {
          position: { ...layer.tracks.position, keyframes: [...layer.tracks.position.keyframes] },
          scale: { ...layer.tracks.scale, keyframes: [...layer.tracks.scale.keyframes] },
          rotation: { ...layer.tracks.rotation, keyframes: [...layer.tracks.rotation.keyframes] },
          alpha: { ...layer.tracks.alpha, keyframes: [...layer.tracks.alpha.keyframes] }
        }
      }

      withHistory((state) => ({
        layers: [...state.layers, duplicated],
        selectedLayerId: newId,
        isDirty: true
      }))

      return newId
    },

    // 资源操作
    addImageResource: (resource) => {
      withHistory((state) => {
        const newResources = new Map(state.imageResources)
        newResources.set(resource.key, resource)
        return { imageResources: newResources, isDirty: true }
      })
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
          selectedLayerId: shouldRemoveLayers && state.selectedLayerId && !layers.some((layer) => layer.id === state.selectedLayerId)
            ? null
            : state.selectedLayerId,
          isDirty: true
        }
      })
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
      })

      return true
    },

    // 音频资源操作
    addAudioResource: (resource) => {
      withHistory((state) => {
        const newResources = new Map(state.audioResources)
        newResources.set(resource.key, resource)
        return { audioResources: newResources, isDirty: true }
      })
    },

    removeAudioResource: (key) => {
      withHistory((state) => {
        const newResources = new Map(state.audioResources)
        newResources.delete(key)
        return { audioResources: newResources, isDirty: true }
      })
    },

    getAudioResource: (key) => {
      return get().audioResources.get(key)
    },

    setAudioResources: (resources) => {
      withHistory({ audioResources: resources, isDirty: true }, 'Set audio resources')
    },

    // 插槽操作
    setSlotConfig: (key, config) => {
      withHistory((state) => ({
        slotConfigs: { ...state.slotConfigs, [key]: config },
        isDirty: true
      }))
    },

    removeSlotConfig: (key) => {
      withHistory((state) => {
        const { [key]: _, ...rest } = state.slotConfigs
        return { slotConfigs: rest, isDirty: true }
      })
    },

    setDetectedSlots: (slots) => {
      withHistory({ detectedSlots: slots, isDirty: true }, 'Set detected slots')
    },

    // 播放控制
    setPlaying: (playing) => {
      set((state) => ({
        playback: { ...state.playback, isPlaying: playing }
      }))
    },

    setCurrentFrame: (frame) => {
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
      }))
    },

    updateKeyframe: (id, updates) => {
      withHistory((state) => ({
        keyframes: state.keyframes.map((kf) =>
          kf.id === id ? { ...kf, ...updates } : kf
        ),
        isDirty: true
      }))
    },

    deleteKeyframe: (id) => {
      withHistory((state) => ({
        keyframes: state.keyframes.filter((kf) => kf.id !== id),
        isDirty: true
      }))
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
      }))
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
      }))
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
      }))
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
      })
    },

    // UI 操作
    setZoom: (zoom) => {
      set({ zoom: Math.max(0.1, Math.min(5, zoom)) })
    },

    setCanvasOffset: (offset) => {
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

    // 导出配置
    setCompressionConfig: (config) => {
      withHistory((state) => ({
        compressionConfig: { ...state.compressionConfig, ...config },
        isDirty: true
      }), 'Update compression')
    },
    
    // 优化配置
    setOptimizationConfig: (config) => {
      withHistory((state) => ({
        optimizationConfig: { ...state.optimizationConfig, ...config, enabled: config.enabled ?? true },
        selectedPresetId: 'custom',
        isDirty: true
      }), 'Update optimization')
    },
    
    setSelectedPresetId: (id) => {
      const preset = getPreset(id)
      if (!preset) return
      withHistory((state) => ({
        selectedPresetId: id,
        optimizationConfig: id === 'custom' ? { ...state.optimizationConfig, enabled: true } : structuredClone(preset.config),
        isDirty: true
      }), 'Select preset')
    },
    
    setOptimizationStats: (stats) => {
      set({ optimizationStats: stats })
    },

    undo: () => {
      const state = get()
      const entry = state.history.past[state.history.past.length - 1]
      if (!entry) return

      const current = createSnapshot(state)
      const nextPast = state.history.past.slice(0, -1)
      const nextFuture = [{ snapshot: current, label: entry.label }, ...state.history.future]
      set({
        history: {
          ...state.history,
          past: nextPast,
          future: nextFuture,
          isApplyingHistory: true
        },
        canUndo: nextPast.length > 0,
        canRedo: true
      })
      applySnapshot(entry.snapshot)
      set((latest) => ({
        history: { ...latest.history, isApplyingHistory: false }
      }))
    },

    redo: () => {
      const state = get()
      const entry = state.history.future[0]
      if (!entry) return

      const current = createSnapshot(state)
      const nextPast = [...state.history.past, { snapshot: current, label: entry.label }].slice(-state.history.maxDepth)
      const nextFuture = state.history.future.slice(1)
      set({
        history: {
          ...state.history,
          past: nextPast,
          future: nextFuture,
          isApplyingHistory: true
        },
        canUndo: true,
        canRedo: nextFuture.length > 0
      })
      applySnapshot(entry.snapshot)
      set((latest) => ({
        history: { ...latest.history, isApplyingHistory: false }
      }))
    },

    commitHistory: (label) => {
      pushHistory(createSnapshot(get()), label)
    },

    clearHistory: clearHistoryState,

    // 重置
    reset: () => {
      set({
        currentSource: null,
        sourceType: null,
        videoItem: null,
        originalBuffer: null,
        isDirty: false,
        params: null,
        customFps: null,
        customFrames: null,
        layers: [],
        selectedLayerId: null,
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
        rendererMode: 'official',
        compressionConfig: initialCompression,
        optimizationConfig: initialOptimization,
        selectedPresetId: 'balanced',
        optimizationStats: null,
        history: {
          past: [],
          future: [],
          maxDepth: get().history.maxDepth,
          isApplyingHistory: false
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
