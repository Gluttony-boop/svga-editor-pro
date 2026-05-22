/**
 * 动画引擎
 * 负责关键帧插值、缓动计算和动画预览
 */

import type { 
  Keyframe, 
  EasingType, 
  Layer, 
  MovieParams 
} from '@/types'

/**
 * 缓动函数映射
 */
export const EasingFunctions = {
  linear: (t: number) => t,
  
  easeIn: (t: number) => t * t,
  
  easeOut: (t: number) => t * (2 - t),
  
  easeInOut: (t: number) => 
    t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  
  easeInQuad: (t: number) => t * t,
  
  easeOutQuad: (t: number) => t * (2 - t),
  
  easeInOutQuad: (t: number) => 
    t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  
  easeInCubic: (t: number) => t * t * t,
  
  easeOutCubic: (t: number) => (--t) * t * t + 1,
  
  easeInOutCubic: (t: number) => 
    t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
  
  easeInQuart: (t: number) => t * t * t * t,
  
  easeOutQuart: (t: number) => 1 - (--t) * t * t * t,
  
  easeInOutQuart: (t: number) => 
    t < 0.5 ? 8 * t * t * t * t : 1 - 8 * (--t) * t * t * t,
  
  easeInExpo: (t: number) => t === 0 ? 0 : Math.pow(2, 10 * (t - 1)),
  
  easeOutExpo: (t: number) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
  
  easeInOutExpo: (t: number) => {
    if (t === 0) return 0
    if (t === 1) return 1
    if (t < 0.5) return Math.pow(2, 10 * (2 * t - 1)) / 2
    return (2 - Math.pow(2, -10 * (2 * t - 1))) / 2
  },
  
  easeInCirc: (t: number) => 1 - Math.sqrt(1 - t * t),
  
  easeOutCirc: (t: number) => Math.sqrt(1 - (--t) * t),
  
  easeInOutCirc: (t: number) => 
    t < 0.5 
      ? (1 - Math.sqrt(1 - 4 * t * t)) / 2 
      : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2,
  
  easeInBack: (t: number) => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return c3 * t * t * t - c1 * t * t
  },
  
  easeOutBack: (t: number) => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  },
  
  easeInOutBack: (t: number) => {
    const c1 = 1.70158
    const c2 = c1 * 1.525
    return t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2
  },
  
  easeInElastic: (t: number) => {
    const c4 = (2 * Math.PI) / 3
    return t === 0 ? 0 : t === 1 ? 1 
      : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4)
  },
  
  easeOutElastic: (t: number) => {
    const c4 = (2 * Math.PI) / 3
    return t === 0 ? 0 : t === 1 ? 1 
      : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
  },
  
  easeInOutElastic: (t: number) => {
    const c5 = (2 * Math.PI) / 4.5
    return t === 0 ? 0 : t === 1 ? 1 : t < 0.5
      ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
      : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1
  },
  
  easeInBounce: (t: number) => 1 - EasingFunctions.easeOutBounce(1 - t),
  
  easeOutBounce: (t: number) => {
    const n1 = 7.5625
    const d1 = 2.75
    if (t < 1 / d1) {
      return n1 * t * t
    } else if (t < 2 / d1) {
      return n1 * (t -= 1.5 / d1) * t + 0.75
    } else if (t < 2.5 / d1) {
      return n1 * (t -= 2.25 / d1) * t + 0.9375
    } else {
      return n1 * (t -= 2.625 / d1) * t + 0.984375
    }
  },
  
  easeInOutBounce: (t: number) => 
    t < 0.5 
      ? (1 - EasingFunctions.easeOutBounce(1 - 2 * t)) / 2 
      : (1 + EasingFunctions.easeOutBounce(2 * t - 1)) / 2
}

/**
 * 贝塞尔曲线插值
 */
export function cubicBezier(
  t: number, 
  x1: number, y1: number, 
  x2: number, y2: number
): number {
  // 使用二分法求解贝塞尔曲线
  const epsilon = 0.0001
  let x = t
  
  // 牛顿迭代法
  for (let i = 0; i < 8; i++) {
    const currentX = bezierValue(x, x1, x2) - t
    if (Math.abs(currentX) < epsilon) break
    
    const derivative = bezierDerivative(x, x1, x2)
    if (Math.abs(derivative) < epsilon) break
    
    x -= currentX / derivative
  }
  
  return bezierValue(x, y1, y2)
}

function bezierValue(t: number, p1: number, p2: number): number {
  const t2 = t * t
  const t3 = t2 * t
  const mt = 1 - t
  const mt2 = mt * mt

  return 3 * mt2 * t * p1 + 3 * mt * t2 * p2 + t3
}

function bezierDerivative(t: number, p1: number, p2: number): number {
  const t2 = t * t
  const mt = 1 - t
  
  return 3 * mt * mt * p1 + 6 * mt * t * (p2 - p1) + 3 * t2 * (1 - p2)
}

/**
 * 应用缓动函数
 */
export function applyEasing(t: number, easing: EasingType, controlPoints?: {
  x1: number
  y1: number
  x2: number
  y2: number
}): number {
  // 限制 t 在 [0, 1] 范围内
  t = Math.max(0, Math.min(1, t))
  
  switch (easing) {
    case 'linear':
      return EasingFunctions.linear(t)
    case 'easeIn':
      return EasingFunctions.easeIn(t)
    case 'easeOut':
      return EasingFunctions.easeOut(t)
    case 'easeInOut':
      return EasingFunctions.easeInOut(t)
    case 'bezier':
      if (controlPoints) {
        return cubicBezier(t, 
          controlPoints.x1, controlPoints.y1, 
          controlPoints.x2, controlPoints.y2
        )
      }
      return EasingFunctions.easeInOutCubic(t)
    default:
      return t
  }
}

/**
 * 插值器接口
 */
export interface Interpolator<T> {
  (a: T, b: T, t: number): T
}

/**
 * 数值插值器
 */
export const numberInterpolator: Interpolator<number> = (a, b, t) => 
  a + (b - a) * t

/**
 * 2D 点插值器
 */
export const point2DInterpolator: Interpolator<{ x: number; y: number }> = (a, b, t) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t
})

/**
 * 缩放插值器
 */
export const scaleInterpolator: Interpolator<{ scaleX: number; scaleY: number }> = (a, b, t) => ({
  scaleX: a.scaleX + (b.scaleX - a.scaleX) * t,
  scaleY: a.scaleY + (b.scaleY - a.scaleY) * t
})

/**
 * 颜色插值器
 */
export const colorInterpolator: Interpolator<{ r: number; g: number; b: number; a: number }> = 
  (a, b, t) => ({
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
    a: a.a + (b.a - a.a) * t
  })

/**
 * 关键帧查找器
 */
export function findKeyframePair<T>(
  keyframes: Keyframe<T>[],
  frameIndex: number
): { prev: Keyframe<T> | null; next: Keyframe<T> | null; t: number } {
  if (keyframes.length === 0) {
    return { prev: null, next: null, t: 0 }
  }

  // 排序关键帧（确保按帧索引排序）
  const sorted = [...keyframes].sort((a, b) => a.frameIndex - b.frameIndex)

  let prev: Keyframe<T> | null = null
  let next: Keyframe<T> | null = null

  for (const kf of sorted) {
    if (kf.frameIndex <= frameIndex) {
      prev = kf
    }
    if (kf.frameIndex > frameIndex && !next) {
      next = kf
      break
    }
  }

  // 计算 t 值
  let t = 0
  if (prev && next) {
    const duration = next.frameIndex - prev.frameIndex
    const elapsed = frameIndex - prev.frameIndex
    t = elapsed / duration
  }

  return { prev, next, t }
}

/**
 * 动画引擎类
 */
export class AnimationEngine {
  /**
   * 计算属性在指定帧的值
   */
  static interpolateProperty<T>(
    keyframes: Keyframe<T>[],
    frameIndex: number,
    defaultValue: T,
    interpolator: Interpolator<T>
  ): T {
    const { prev, next, t } = findKeyframePair(keyframes, frameIndex)

    // 没有关键帧
    if (!prev && !next) {
      return defaultValue
    }

    // 只有前面的关键帧
    if (prev && !next) {
      return prev.value
    }

    // 只有后面的关键帧
    if (!prev && next) {
      return next.value
    }

    // 在两个关键帧之间
    // 应用缓动
    const easedT = applyEasing(t, prev!.easing, prev!.bezierControlPoints)

    return interpolator(prev!.value, next!.value, easedT)
  }

  /**
   * 获取图层在指定帧的所有属性
   * 用于渲染新增图层和构建 SVGA 帧数据
   */
  static getLayerPropertiesAtFrame(layer: Layer, frameIndex: number) {
    const position = this.interpolateProperty(
      layer.tracks.position.keyframes,
      frameIndex,
      layer.tracks.position.defaultValue,
      point2DInterpolator
    )

    const scale = this.interpolateProperty(
      layer.tracks.scale.keyframes,
      frameIndex,
      layer.tracks.scale.defaultValue,
      scaleInterpolator
    )

    const rotation = this.interpolateProperty(
      layer.tracks.rotation.keyframes,
      frameIndex,
      layer.tracks.rotation.defaultValue,
      numberInterpolator
    )

    const alpha = this.interpolateProperty(
      layer.tracks.alpha.keyframes,
      frameIndex,
      layer.tracks.alpha.defaultValue,
      numberInterpolator
    )

    return { position, scale, rotation, alpha }
  }

  /**
   * 生成帧缓存（预计算所有帧）
   */
  static generateFrameCache(
    layers: Layer[],
    params: MovieParams
  ): Map<string, Map<number, {
    position: { x: number; y: number }
    scale: { scaleX: number; scaleY: number }
    rotation: number
    alpha: number
  }>> {
    const cache = new Map<string, Map<number, any>>()

    for (const layer of layers) {
      const layerCache = new Map<number, any>()

      for (let frame = 0; frame < params.frames; frame++) {
        layerCache.set(frame, this.getLayerPropertiesAtFrame(layer, frame))
      }

      cache.set(layer.id, layerCache)
    }

    return cache
  }

  /**
   * 计算动画曲线预览点
   */
  static generateCurvePreview(
    keyframes: Keyframe<any>[],
    interpolator: Interpolator<any>,
    samples: number = 100
  ): Array<{ t: number; value: number }> {
    if (keyframes.length < 2) return []

    const points: Array<{ t: number; value: number }> = []
    const { prev, next } = findKeyframePair(keyframes, samples / 2)

    if (!prev || !next) return []

    for (let i = 0; i <= samples; i++) {
      const t = i / samples
      const easedT = applyEasing(t, prev.easing, prev.bezierControlPoints)
      const value = interpolator(prev.value, next.value, easedT)
      
      points.push({ t: easedT, value: typeof value === 'number' ? value : (value as any).x || 0 })
    }

    return points
  }
}

/**
 * 动画预览生成器
 */
export class AnimationPreview {
  private ctx: CanvasRenderingContext2D
  private params: MovieParams

  constructor(canvas: HTMLCanvasElement, params: MovieParams) {
    this.ctx = canvas.getContext('2d')!
    this.params = params
  }

  /**
   * 绘制关键帧时间线
   */
  drawKeyframeTimeline(
    keyframes: Keyframe<any>[],
    options: {
      width: number
      height: number
      color?: string
      label?: string
    }
  ): void {
    const { width, height, color = '#e94560', label } = options
    const { frames } = this.params

    this.ctx.clearRect(0, 0, width, height)

    // 绘制时间线背景
    this.ctx.fillStyle = '#1a1a2e'
    this.ctx.fillRect(0, 0, width, height)

    // 绘制帧刻度
    this.ctx.strokeStyle = '#333'
    this.ctx.lineWidth = 1
    const frameWidth = width / frames

    for (let i = 0; i <= frames; i += Math.ceil(frames / 20)) {
      const x = i * frameWidth
      this.ctx.beginPath()
      this.ctx.moveTo(x, height - 10)
      this.ctx.lineTo(x, height)
      this.ctx.stroke()
    }

    // 绘制关键帧点
    this.ctx.fillStyle = color
    for (const kf of keyframes) {
      const x = kf.frameIndex * frameWidth
      this.ctx.beginPath()
      this.ctx.arc(x, height / 2, 4, 0, Math.PI * 2)
      this.ctx.fill()
    }

    // 绘制曲线
    if (keyframes.length >= 2) {
      this.ctx.strokeStyle = color
      this.ctx.lineWidth = 2
      this.ctx.beginPath()

      const sorted = [...keyframes].sort((a, b) => a.frameIndex - b.frameIndex)
      
      for (let frame = 0; frame < frames; frame++) {
        const x = frame * frameWidth
        const value = AnimationEngine.interpolateProperty(
          keyframes,
          frame,
          sorted[0].value,
          (a, b, t) => {
            if (typeof a === 'number' && typeof b === 'number') {
              return a + (b - a) * t
            }
            return a
          }
        )
        
        // 归一化值到 [0, height]
        const normalizedValue = typeof value === 'number' 
          ? height - (value * height / 2)
          : height / 2

        if (frame === 0) {
          this.ctx.moveTo(x, normalizedValue)
        } else {
          this.ctx.lineTo(x, normalizedValue)
        }
      }

      this.ctx.stroke()
    }

    // 绘制标签
    if (label) {
      this.ctx.fillStyle = '#fff'
      this.ctx.font = '10px sans-serif'
      this.ctx.fillText(label, 4, 12)
    }
  }
}
