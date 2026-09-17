/**
 * SVGA 动画核心数据结构
 * 设计原则：内存紧凑、快速查询、易于序列化
 */

// ==================== 基础类型 ====================

/**
 * 缓动类型
 */
export type EasingType = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'bezier'

/**
 * 图层类型
 */
export type LayerType = 'image' | 'text' | 'shape' | 'audio'

/**
 * 混合模式
 */
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'

/**
 * 图片来源类型
 */
export type ImageSourceType = 'file' | 'url' | 'dataUrl' | 'blob'

/**
 * 图片 MIME 类型
 */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

// ==================== SVGA 原始数据结构 ====================

/**
 * Movie - SVGA 文件的内存表示
 */
export interface Movie {
  version: string
  params: MovieParams
  images: Record<string, Uint8Array>
  sprites: Sprite[]
  audios?: Audio[]
}

/**
 * 动画参数
 */
export interface MovieParams {
  viewBoxWidth: number
  viewBoxHeight: number
  fps: number
  frames: number
}

/**
 * 精灵 (图层)
 */
export interface Sprite {
  imageKey: string
  matteKey: string | null
  frames: FrameData[]
}

/**
 * 帧数据 (对应某一帧的状态)
 */
export interface FrameData {
  alpha: number
  layout: Layout | null
  transform: Transform
  clipPath: string | null
  shapes?: ShapeEntity[]  // 矢量图形数组
  blendMode?: string  // 图层混合模式
}

/**
 * 矢量图形实体
 */
export interface ShapeEntity {
  type: ShapeType
  shape?: ShapeArgs
  rect?: RectArgs
  ellipse?: EllipseArgs
  styles?: ShapeStyle
  transform?: Transform
}

/**
 * 形状类型
 */
export type ShapeType = 'SHAPE' | 'RECT' | 'ELLIPSE' | 'KEEP'

/**
 * 路径参数
 */
export interface ShapeArgs {
  d: string
}

/**
 * 矩形参数
 */
export interface RectArgs {
  x: number
  y: number
  width: number
  height: number
  cornerRadius?: number
}

/**
 * 椭圆参数
 */
export interface EllipseArgs {
  x: number
  y: number
  radiusX: number
  radiusY: number
}

/**
 * 形状样式
 */
export interface ShapeStyle {
  fill?: RGBAColor
  stroke?: RGBAColor
  strokeWidth?: number
  lineCap?: LineCap
  lineJoin?: LineJoin
  miterLimit?: number
  lineDashI?: number
  lineDashII?: number
  lineDashIII?: number
}

/**
 * RGBA 颜色
 */
export interface RGBAColor {
  r: number
  g: number
  b: number
  a: number
}

/**
 * 线端点样式
 */
export type LineCap = 'LineCap_BUTT' | 'LineCap_ROUND' | 'LineCap_SQUARE'

/**
 * 线连接样式
 */
export type LineJoin = 'LineJoin_MITER' | 'LineJoin_ROUND' | 'LineJoin_BEVEL'

/**
 * 布局信息
 */
export interface Layout {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 2D 变换矩阵
 * [ a  c  tx ]
 * [ b  d  ty ]
 * [ 0  0  1  ]
 */
export interface Transform {
  a: number   // scaleX (affected by rotation)
  b: number   // skewY
  c: number   // skewX
  d: number   // scaleY (affected by rotation)
  tx: number  // translateX
  ty: number  // translateY
}

/**
 * 音频数据（SVGA 原始格式）
 */
export interface Audio {
  key: string
  data: Uint8Array
  startTime: number
  duration: number
}

/**
 * 音频资源（编辑态，扩展版）
 */
export interface AudioResource {
  key: string
  data: Uint8Array
  startTime: number   // 起始时间（毫秒）
  duration: number     // 持续时间（毫秒）
  blobUrl?: string     // Blob URL 用于播放
  audioBuffer?: AudioBuffer  // 解码后的音频缓冲区
  source?: AudioSource // 来源信息
  isNew?: boolean
}

/**
 * 音频来源
 */
export interface AudioSource {
  type: 'file' | 'url' | 'dataUrl'
  value: string
  file?: File
}

/**
 * 音频播放状态
 */
export interface AudioPlaybackState {
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  muted: boolean
}

// ==================== 编辑态数据结构 ====================

/** 整段动画的画布调整；位置为世界坐标偏移，旋转使用弧度。 */
export interface CanvasTransform {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
}

/**
 * Layer - 编辑态图层（扩展版，支持新增图层）
 */
export interface Layer {
  id: string
  name: string
  type: LayerType
  visible: boolean
  locked: boolean
  expanded: boolean
  opacity: number
  blendMode: BlendMode
  
  // 图层时间范围
  clip: {
    startFrame: number
    duration: number
  }
  /** 输出时间相对源时间的整数帧偏移；裁切与关键帧仍保留在源时间坐标。 */
  timeOffsetFrames?: number
  
  // 图片图层特有属性
  imageKey?: string
  imageSource?: ImageSource
  
  // 音频图层特有属性
  audioKey?: string
  audioSource?: AudioSource
  audioStartTime?: number   // 音频起始时间（毫秒）
  audioDuration?: number    // 音频持续时间（毫秒）
  
  // 图层可编辑索引（用于插槽系统）
  editableIndex?: number
  
  // 动画轨道
  tracks: LayerTracks

  /** 独立于原始逐帧动画，预览与导出使用同一矩阵合成。 */
  canvasTransform?: CanvasTransform
  
  // 原始 SVGA 精灵数据（仅存在于从 SVGA 解析的图层）
  sprites?: Sprite
  
  // 是否为新增图层
  isNew?: boolean
}

/**
 * 图片资源来源
 */
export interface ImageSource {
  type: ImageSourceType
  value: string  // 文件路径、URL 或 Data URL
  file?: File    // 原始文件对象（如果来自本地文件）
}

/**
 * 图层轨道
 */
export interface LayerTracks {
  position: PropertyTrack<{ x: number; y: number }>
  scale: PropertyTrack<{ scaleX: number; scaleY: number }>
  rotation: PropertyTrack<number>
  alpha: PropertyTrack<number>
}

/**
 * 属性轨道
 */
export interface PropertyTrack<T> {
  keyframes: Keyframe<T>[]
  currentValue: T
  defaultValue: T
}

/**
 * 关键帧（扩展版）
 */
export interface Keyframe<T = any> {
  id: string
  frameIndex: number
  value: T
  easing: EasingType
  // 贝塞尔曲线控制点（当 easing 为 'bezier' 时使用）
  bezierControlPoints?: {
    x1: number
    y1: number
    x2: number
    y2: number
  }
}

/**
 * 动画模板 - 预设动画效果
 */
export interface AnimationPreset {
  id: string
  name: string
  category: 'entrance' | 'exit' | 'emphasis' | 'custom'
  duration: number  // 持续帧数
  keyframes: {
    position?: Array<{
      frame: number
      x: number | 'centerX' | 'centerY'
      y: number | 'centerX' | 'centerY'
      easing: EasingType
    }>
    scale?: Array<{
      frame: number
      scaleX: number
      scaleY: number
      easing: EasingType
    }>
    rotation?: Array<{
      frame: number
      value: number
      easing: EasingType
    }>
    alpha?: Array<{
      frame: number
      value: number
      easing: EasingType
    }>
  }
}

// ==================== 图片资源 ====================

/**
 * 图片资源（扩展版）
 */
export interface ImageResource {
  key: string
  data: Uint8Array
  width: number
  height: number
  mimeType: ImageMimeType
  blobUrl?: string
  bitmap?: ImageBitmap
  // 新增：资源来源信息
  source?: ImageSource
  // 新增：是否为新增资源
  isNew?: boolean
}

/**
 * 资源库状态
 */
export interface ResourceLibrary {
  images: Map<string, ImageResource>
  audios: Map<string, AudioResource>
  // 预加载的图片缓存
  imageCache: Map<string, HTMLImageElement>
}

/**
 * 资源操作结果
 */
export interface ResourceOperationResult {
  success: boolean
  resource?: ImageResource
  error?: string
}

// ==================== 帧缓存数据结构 ====================

/**
 * 帧缓存数据
 * 
 * 内存布局 (每帧每图层 12 个 float):
 * [0-1]:   position (x, y)
 * [2-3]:   scale (scaleX, scaleY)
 * [4]:     rotation
 * [5]:     alpha
 * [6-7]:   layout (width, height)
 * [8-11]:  transform matrix (a, b, c, d)
 * 
 * 总大小: 12 * 4 bytes = 48 bytes/帧
 * 100 图层 × 300 帧 = 14,400 帧 × 48 bytes = 691 KB
 */
export type FrameCacheData = Float32Array

/**
 * 帧缓存索引
 */
export interface FrameCacheIndex {
  frameOffset: Uint32Array
  layerStride: number
  totalFrames: number
  totalLayers: number
}

// ==================== 动画模板 ====================

/**
 * 动画模板
 */
export interface AnimationTemplate {
  name: string
  duration: number
  keyframes: {
    position: Array<{
      frame: number
      x: number | 'centerX' | 'centerY'
      y: number | 'centerX' | 'centerY'
      easing: EasingType
    }>
    scale: Array<{
      frame: number
      scaleX: number
      scaleY: number
      easing: EasingType
    }>
    rotation: Array<{
      frame: number
      value: number
      easing: EasingType
    }>
    alpha: Array<{
      frame: number
      value: number
      easing: EasingType
    }>
  }
}

// ==================== 操作历史 ====================

/**
 * 历史记录状态
 */
export interface HistoryState {
  layers: Layer[]
  movieSnapshot: MovieSnapshot
  selectedLayerId: string | null
  currentFrame: number
  description: string
  timestamp: number
}

/**
 * Movie 快照 (用于历史记录)
 */
export interface MovieSnapshot {
  version: string
  params: MovieParams
  images: Record<string, Uint8Array>
  sprites: Sprite[]
}

// ==================== 渲染状态 ====================

/**
 * 渲染质量级别
 */
export enum QualityLevel {
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
  ULTRA_LOW = 'ultra_low'
}

/**
 * 渲染配置
 */
export interface RenderingConfig {
  resolution: number
  antialiasing: boolean
  textureQuality: 'full' | 'medium' | 'low' | 'thumbnail'
  maxLayers: number
}

// ==================== UI 状态 ====================

/**
 * Timeline 视图状态
 */
export interface TimelineViewState {
  zoom: number
  scrollOffset: number
  selectedKeyframes: Set<string>
}

/**
 * 画布视图状态
 */
export interface CanvasViewState {
  scale: number
  offsetX: number
  offsetY: number
  showGrid: boolean
  showGuides: boolean
}

// ==================== Worker 消息 ====================

/**
 * Worker 消息类型
 */
export type WorkerMessageType =
  | 'init'
  | 'loadMovie'
  | 'computeAllFrames'
  | 'computeFrame'
  | 'updateKeyframe'
  | 'addLayer'
  | 'removeLayer'
  | 'getFrame'
  | 'syncFromStore'

/**
 * Worker 消息
 */
export interface WorkerMessage {
  type: WorkerMessageType
  [key: string]: any
}

/**
 * Worker 响应
 */
export interface WorkerResponse {
  type: string
  success: boolean
  data?: any
  error?: string
}

// ==================== 辅助类型 ====================

/**
 * 位置
 */
export interface Position {
  x: number
  y: number
}

/**
 * 缩放
 */
export interface Scale {
  scaleX: number
  scaleY: number
}

/**
 * 边界框
 */
export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 矩形区域
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 插值上下文
 */
export interface InterpolationContext {
  frameIndex: number
  totalFrames: number
  keyframes: Keyframe[]
  defaultValue: any
}

// ==================== 编辑器核心类型 ====================

/**
 * VideoItem - 解析后的 SVGA 数据结构
 */
export interface VideoItem {
  movie: MovieEntity
  images: Record<string, HTMLImageElement>
  buffers: Record<string, ArrayBuffer>
}

/**
 * MovieEntity - Protobuf 解码后的原始数据结构
 */
export interface MovieEntity {
  version: string
  params: MovieParams
  images: Record<string, Uint8Array | number[]>
  sprites: Sprite[]
  audios?: Audio[]
}

/**
 * 插槽配置
 */
export interface SlotConfig {
  type: 'image' | 'text'
  name: string
  value: string | null
  imageConfig?: {
    url: string
    scaleMode: 'fit' | 'fill' | 'stretch'
  }
  textConfig?: {
    text: string
    fontSize: number
    color: string
    fontFamily: string
  }
}

/**
 * 文本插槽配置
 */
export interface TextSlotConfig extends SlotConfig {
  type: 'text'
  textConfig: {
    text: string
    fontSize: number
    color: string
    fontFamily: string
  }
}

/**
 * 图片插槽配置
 */
export interface ImageSlotConfig extends SlotConfig {
  type: 'image'
  imageConfig: {
    url: string
    scaleMode: 'fit' | 'fill' | 'stretch'
  }
}

/**
 * 播放状态
 */
export interface PlaybackState {
  isPlaying: boolean
  currentFrame: number
  totalFrames: number
  fps: number
  loop: boolean
  speed: number
}

/**
 * 压缩配置
 */
export interface CompressionConfig {
  enabled: boolean
  mode: 'smart' | 'webp' | 'png'
  quality: number
  resizeEnabled: boolean
  resizePercent: number
}
