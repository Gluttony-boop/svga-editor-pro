import type { OptimizationConfig } from '@/core/optimizer'
import type { AudioResource, CompressionConfig, ImageResource, Layer, MovieParams, SlotConfig, VideoItem } from './svga'

/** 工程保留编辑数据与原始输入；它不是已经烘焙的播放器产物。 */
export interface ProjectDocument {
  formatVersion: 1
  name: string
  originalBuffer: ArrayBuffer
  videoItem: VideoItem
  params: MovieParams
  customFps: number | null
  customFrames: number | null
  layers: Layer[]
  imageResources: Map<string, ImageResource>
  audioResources: Map<string, AudioResource>
  slotConfigs: Record<string, SlotConfig>
  detectedSlots: string[]
  compressionConfig: CompressionConfig
  optimizationConfig: OptimizationConfig
  selectedPresetId: string
  currentFrame: number
  selectedLayerId: string | null
  selectedLayerIds: string[]
}

export const PROJECT_EXTENSION = 'svgaproj'
export const PROJECT_FORMAT = 'svga-editor-project'
