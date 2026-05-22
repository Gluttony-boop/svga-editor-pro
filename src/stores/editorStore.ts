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
import { v4 as uuid } from 'uuid'

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
  showGrid: boolean
  showOnionSkin: boolean
  rendererMode: 'high-performance' | 'official' | 'pixi'

  // 导出配置
  compressionConfig: CompressionConfig
  
  // 优化配置
  optimizationConfig: OptimizationConfig
  selectedPresetId: string
  optimizationStats: OptimizationStats | null

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
  toggleGrid: () => void
  toggleOnionSkin: () => void
  setRendererMode: (mode: 'high-performance' | 'official' | 'pixi') => void

  // 导出配置
  setCompressionConfig: (config: Partial<CompressionConfig>) => void
  
  // 优化配置
  setOptimizationConfig: (config: Partial<OptimizationConfig>) => void
  setSelectedPresetId: (id: string) => void
  setOptimizationStats: (stats: OptimizationStats | null) => void

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

const initialOptimization: OptimizationConfig = {
  enabled: true,
  image: {
    format: 'webp',
    quality: 80,
    resizeEnabled: false,
    resizePercent: 100,
    maxWidth: 0,
    maxHeight: 0,
    deduplicate: false  // 暂时关闭去重
  },
  frames: {
    simplify: false,     // 暂时关闭帧精简
    keyframeThreshold: 0.02,
    removeInvisible: false,
    precision: 6         // 保持高精度
  },
  compression: {
    level: 8,
    useBestCompression: true
  }
}

export const useEditorStore = create<EditorStore>()(
  subscribeWithSelector((set, get) => ({
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
    showGrid: true,
    showOnionSkin: false,
    rendererMode: 'pixi' as const,

    compressionConfig: initialCompression,
    
    optimizationConfig: initialOptimization,
    selectedPresetId: 'balanced',
    optimizationStats: null,

    // Actions
    setVideoItem: (videoItem) => {
      set({ videoItem, isDirty: false })
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
      set({ params })
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
      set({ customFps: fps, isDirty: true })
      if (fps) {
        set({
          playback: {
            ...get().playback,
            fps
          }
        })
      }
    },

    setCustomFrames: (frames) => {
      set({ customFrames: frames, isDirty: true })
    },

    // 图层操作
    setLayers: (layers) => {
      set({ layers })
    },

    selectLayer: (layerId) => {
      set({ selectedLayerId: layerId })
    },

    updateLayer: (layerId, updates) => {
      set((state) => ({
        layers: state.layers.map((layer) =>
          layer.id === layerId ? { ...layer, ...updates } : layer
        ),
        isDirty: true
      }))
    },

    updateLayerTrackDefaultValue: (layerId, trackKey, value) => {
      set((state) => ({
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
      set((state) => {
        const layers = [...state.layers]
        const [removed] = layers.splice(fromIndex, 1)
        layers.splice(toIndex, 0, removed)
        return { layers, isDirty: true }
      })
    },

    addLayer: (layer) => {
      const id = uuid()
      set((state) => ({
        layers: [...state.layers, { ...layer, id }],
        selectedLayerId: id,
        isDirty: true
      }))
      return id
    },

    deleteLayer: (layerId) => {
      set((state) => ({
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

      set((state) => ({
        layers: [...state.layers, duplicated],
        selectedLayerId: newId,
        isDirty: true
      }))

      return newId
    },

    // 资源操作
    addImageResource: (resource) => {
      set((state) => {
        const newResources = new Map(state.imageResources)
        newResources.set(resource.key, resource)
        return { imageResources: newResources, isDirty: true }
      })
    },

    removeImageResource: (key) => {
      set((state) => {
        const newResources = new Map(state.imageResources)
        newResources.delete(key)
        return { imageResources: newResources, isDirty: true }
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

      // 检查新 key 是否已存在（非当前图层的）
      const keyConflict = state.layers.some(
        (l) => l.id !== layerId && l.imageKey === newKey
      )
      if (keyConflict) {
        console.warn(`[renameImageKey] Key "${newKey}" already exists, aborting`)
        return
      }

      set((state) => {
        // 1. 更新图层的 imageKey 和 name
        const layers = state.layers.map((l) => {
          if (l.id !== layerId) return l
          return {
            ...l,
            imageKey: newKey,
            name: newKey,
            // 同步更新 sprites 中的 imageKey
            sprites: l.sprites ? { ...l.sprites, imageKey: newKey } : undefined,
          }
        })

        // 2. 更新 videoItem 中的 sprites、buffers、images
        let videoItem = state.videoItem
        if (videoItem) {
          const movie = { ...videoItem.movie }
          // 更新 sprites
          movie.sprites = movie.sprites.map((sprite) => {
            if (sprite.imageKey === oldKey) {
              return { ...sprite, imageKey: newKey }
            }
            // 更新 matteKey 引用
            if (sprite.matteKey === oldKey) {
              return { ...sprite, matteKey: newKey }
            }
            return sprite
          })

          // 更新 buffers
          const buffers = { ...videoItem.buffers }
          if (buffers[oldKey] !== undefined) {
            buffers[newKey] = buffers[oldKey]
            delete buffers[oldKey]
          }

          // 更新 images
          const images = { ...videoItem.images }
          if (images[oldKey] !== undefined) {
            images[newKey] = images[oldKey]
            delete images[oldKey]
          }

          videoItem = { ...videoItem, movie, buffers, images }
        }

        // 3. 更新 imageResources Map
        const imageResources = new Map(state.imageResources)
        const resource = imageResources.get(oldKey)
        if (resource) {
          imageResources.delete(oldKey)
          imageResources.set(newKey, { ...resource, key: newKey })
        }

        // 4. 更新 slotConfigs
        let slotConfigs = state.slotConfigs
        if (slotConfigs[oldKey]) {
          const { [oldKey]: slotConfig, ...rest } = slotConfigs
          slotConfigs = { ...rest, [newKey]: { ...slotConfig, name: newKey } }
        }

        return { layers, videoItem, imageResources, slotConfigs, isDirty: true }
      })
    },

    // 音频资源操作
    addAudioResource: (resource) => {
      set((state) => {
        const newResources = new Map(state.audioResources)
        newResources.set(resource.key, resource)
        return { audioResources: newResources, isDirty: true }
      })
    },

    removeAudioResource: (key) => {
      set((state) => {
        const newResources = new Map(state.audioResources)
        newResources.delete(key)
        return { audioResources: newResources, isDirty: true }
      })
    },

    getAudioResource: (key) => {
      return get().audioResources.get(key)
    },

    setAudioResources: (resources) => {
      set({ audioResources: resources })
    },

    // 插槽操作
    setSlotConfig: (key, config) => {
      set((state) => ({
        slotConfigs: { ...state.slotConfigs, [key]: config },
        isDirty: true
      }))
    },

    removeSlotConfig: (key) => {
      set((state) => {
        const { [key]: _, ...rest } = state.slotConfigs
        return { slotConfigs: rest, isDirty: true }
      })
    },

    setDetectedSlots: (slots) => {
      set({ detectedSlots: slots })
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
      set((state) => ({
        keyframes: [...state.keyframes, { ...keyframe, id: uuid() }],
        isDirty: true
      }))
    },

    updateKeyframe: (id, updates) => {
      set((state) => ({
        keyframes: state.keyframes.map((kf) =>
          kf.id === id ? { ...kf, ...updates } : kf
        ),
        isDirty: true
      }))
    },

    deleteKeyframe: (id) => {
      set((state) => ({
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
      set((state) => ({
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
      set((state) => ({
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
      set((state) => ({
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
      set((state) => {
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
      set((state) => ({
        compressionConfig: { ...state.compressionConfig, ...config }
      }))
    },
    
    // 优化配置
    setOptimizationConfig: (config) => {
      set((state) => ({
        optimizationConfig: { ...state.optimizationConfig, ...config },
        selectedPresetId: 'custom'
      }))
    },
    
    setSelectedPresetId: (id) => {
      set({ selectedPresetId: id })
    },
    
    setOptimizationStats: (stats) => {
      set({ optimizationStats: stats })
    },

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
        showGrid: true,
        showOnionSkin: false,
        compressionConfig: initialCompression,
        optimizationConfig: initialOptimization,
        selectedPresetId: 'balanced',
        optimizationStats: null
      })
    }
  }))
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
