/**
 * 图层工厂
 * 负责创建和管理图层
 */

import type { 
  Layer, 
  ImageResource, 
  AudioResource,
  LayerTracks,
  Keyframe,
  MovieParams 
} from '@/types'
import { v4 as uuid } from 'uuid'

/**
 * 创建默认动画轨道
 */
export function createDefaultTracks(_params?: MovieParams): LayerTracks {
  
  return {
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
}

/**
 * 图层工厂类
 */
export class LayerFactory {
  /**
   * 创建图片图层
   */
  static createImageLayer(
    resource: ImageResource,
    options: {
      name?: string
      startFrame?: number
      params?: MovieParams
    } = {}
  ): Layer {
    const { 
      name = resource.key,
      startFrame = 0,
      params 
    } = options

    const totalFrames = params?.frames || 60

    return {
      id: uuid(),
      name,
      type: 'image',
      visible: true,
      locked: false,
      expanded: true,
      opacity: 1,
      blendMode: 'normal',
      imageKey: resource.key,
      imageSource: resource.source,
      clip: {
        startFrame,
        duration: totalFrames
      },
      tracks: createDefaultTracks(params),
      isNew: true
    }
  }

  /**
   * 创建文本图层
   */
  static createTextLayer(
    text: string,
    options: {
      name?: string
      fontSize?: number
      color?: string
      startFrame?: number
      params?: MovieParams
    } = {}
  ): Layer {
    const {
      name = text.substring(0, 10),
      fontSize: _fontSize = 24,
      color: _color = '#ffffff',
      startFrame = 0,
      params
    } = options

    const totalFrames = params?.frames || 60

    return {
      id: uuid(),
      name,
      type: 'text',
      visible: true,
      locked: false,
      expanded: true,
      opacity: 1,
      blendMode: 'normal',
      clip: {
        startFrame,
        duration: totalFrames
      },
      tracks: createDefaultTracks(params),
      isNew: true
    }
  }

  /**
   * 创建音频图层
   */
  static createAudioLayer(
    resource: AudioResource,
    options: {
      name?: string
      startFrame?: number
      params?: MovieParams
    } = {}
  ): Layer {
    const { 
      name = resource.key,
      startFrame = 0,
      params 
    } = options

    // 根据音频时长计算帧数
    const fps = params?.fps || 24
    const durationMs = resource.duration || 1000
    const audioFrames = Math.ceil((durationMs / 1000) * fps)
    const totalFrames = params?.frames || Math.max(60, audioFrames)

    return {
      id: uuid(),
      name,
      type: 'audio',
      visible: true,
      locked: false,
      expanded: true,
      opacity: 1,
      blendMode: 'normal',
      audioKey: resource.key,
      audioSource: resource.source,
      audioStartTime: resource.startTime,
      audioDuration: resource.duration,
      clip: {
        startFrame,
        duration: totalFrames
      },
      tracks: createDefaultTracks(params),
      isNew: true
    }
  }

  /**
   * 复制图层
   */
  static duplicateLayer(layer: Layer): Layer {
    return {
      ...layer,
      id: uuid(),
      name: `${layer.name} (副本)`,
      tracks: {
        position: { 
          ...layer.tracks.position, 
          keyframes: layer.tracks.position.keyframes.map(kf => ({ ...kf, id: uuid() }))
        },
        scale: { 
          ...layer.tracks.scale, 
          keyframes: layer.tracks.scale.keyframes.map(kf => ({ ...kf, id: uuid() }))
        },
        rotation: { 
          ...layer.tracks.rotation, 
          keyframes: layer.tracks.rotation.keyframes.map(kf => ({ ...kf, id: uuid() }))
        },
        alpha: { 
          ...layer.tracks.alpha, 
          keyframes: layer.tracks.alpha.keyframes.map(kf => ({ ...kf, id: uuid() }))
        }
      },
      isNew: true
    }
  }

  /**
   * 从 Sprite 创建图层（用于 SVGA 解析）
   */
  static createLayerFromSprite(
    sprite: any,
    index: number,
    params: MovieParams
  ): Layer {
    return {
      id: String(index),
      name: sprite.imageKey || `Layer ${index + 1}`,
      type: 'image',
      visible: true,
      locked: false,
      expanded: true,
      opacity: 1,
      blendMode: 'normal',
      imageKey: sprite.imageKey,
      sprites: sprite,
      clip: {
        startFrame: 0,
        duration: params.frames
      },
      tracks: createDefaultTracks(params)
    }
  }
}

/**
 * 图层操作工具类
 */
export class LayerUtils {
  /**
   * 计算图层在指定帧的属性值
   */
  static interpolateProperty<T>(
    keyframes: Keyframe<T>[],
    frameIndex: number,
    defaultValue: T,
    interpolate: (a: T, b: T, t: number) => T
  ): T {
    if (keyframes.length === 0) {
      return defaultValue
    }

    // 找到前后关键帧
    let prevKf: Keyframe<T> | null = null
    let nextKf: Keyframe<T> | null = null

    for (const kf of keyframes) {
      if (kf.frameIndex <= frameIndex) {
        prevKf = kf
      }
      if (kf.frameIndex > frameIndex && !nextKf) {
        nextKf = kf
        break
      }
    }

    // 没有关键帧
    if (!prevKf && !nextKf) {
      return defaultValue
    }

    // 只有前面的关键帧
    if (prevKf && !nextKf) {
      return prevKf.value
    }

    // 只有后面的关键帧
    if (!prevKf && nextKf) {
      return nextKf.value
    }

    // 在两个关键帧之间，进行插值
    const duration = nextKf!.frameIndex - prevKf!.frameIndex
    const elapsed = frameIndex - prevKf!.frameIndex
    const t = elapsed / duration

    // 应用缓动
    const easedT = applyEasing(t, prevKf!.easing)

    return interpolate(prevKf!.value, nextKf!.value, easedT)
  }

  /**
   * 获取图层在指定帧的所有属性
   */
  static getLayerPropertiesAtFrame(layer: Layer, frameIndex: number) {
    const position = this.interpolateProperty(
      layer.tracks.position.keyframes,
      frameIndex,
      layer.tracks.position.defaultValue,
      (a, b, t) => ({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t
      })
    )

    const scale = this.interpolateProperty(
      layer.tracks.scale.keyframes,
      frameIndex,
      layer.tracks.scale.defaultValue,
      (a, b, t) => ({
        scaleX: a.scaleX + (b.scaleX - a.scaleX) * t,
        scaleY: a.scaleY + (b.scaleY - a.scaleY) * t
      })
    )

    const rotation = this.interpolateProperty(
      layer.tracks.rotation.keyframes,
      frameIndex,
      layer.tracks.rotation.defaultValue,
      (a, b, t) => a + (b - a) * t
    )

    const alpha = this.interpolateProperty(
      layer.tracks.alpha.keyframes,
      frameIndex,
      layer.tracks.alpha.defaultValue,
      (a, b, t) => a + (b - a) * t
    )

    return { position, scale, rotation, alpha }
  }

  /**
   * 检查图层是否在指定帧可见
   */
  static isLayerVisibleAtFrame(layer: Layer, frameIndex: number): boolean {
    if (!layer.visible) return false
    
    const { startFrame, duration } = layer.clip
    return frameIndex >= startFrame && frameIndex < startFrame + duration
  }
}

/**
 * 应用缓动函数
 */
function applyEasing(t: number, easing: string): number {
  switch (easing) {
    case 'linear':
      return t
    case 'easeIn':
      return t * t
    case 'easeOut':
      return t * (2 - t)
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    case 'bezier':
      // 简单的贝塞尔曲线实现（可扩展支持自定义控制点）
      return t < 0.5 
        ? 4 * t * t * t 
        : 1 - Math.pow(-2 * t + 2, 3) / 2
    default:
      return t
  }
}
