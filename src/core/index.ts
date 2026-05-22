export { SVGAParser, svgaParser } from './parser'
export { CanvasRenderer } from './renderer'
export type { RenderOptions } from './renderer'

// 高性能渲染器
export { HighPerformanceRenderer } from './renderer.high-performance'
export type { PerformanceMetrics } from './renderer.high-performance'

// 官方渲染器（修复渲染效果问题）
export { OfficialSvgRenderer } from './renderer.official'

// 资源预加载
export { ImagePreloader, ResourcePool } from './resource-preloader'
export type { PreloadProgress, PreloadResult } from './resource-preloader'

export { ExportEngine, saveFile, saveGeneratedFile, createSaveFileTarget } from './exporter'
export type { SaveFileTarget } from './exporter'
export { ResourceManager, resourceManager } from './resource-manager'
export { LayerFactory, LayerUtils, createDefaultTracks } from './layer-factory'
export { 
  AnimationEngine, 
  AnimationPreview,
  EasingFunctions,
  applyEasing,
  cubicBezier,
  findKeyframePair,
  numberInterpolator,
  point2DInterpolator,
  scaleInterpolator,
  colorInterpolator
} from './animation-engine'
export type { Interpolator } from './animation-engine'
export { SVGABuilder, svgaBuilder } from './svga-builder'
export type { SVGABuildConfig } from './svga-builder'
export { 
  SVGAOptimizer, 
  svgaOptimizer, 
  OPTIMIZATION_PRESETS,
  getPreset
} from './optimizer'
export type { 
  OptimizationConfig, 
  OptimizationStats, 
  OptimizationPreset 
} from './optimizer'

// 音频管理
export { AudioManager, audioManager } from './audio-manager'
