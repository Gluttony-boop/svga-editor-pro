import { describe, expect, it } from 'vitest'
import type { Layer, SlotConfig } from '@/types'
import { LayerFactory, createDefaultTracks } from './layer-factory'
import { OfficialSvgRenderer } from './renderer.official'
import { HighPerformanceRenderer } from './renderer.high-performance'

type CacheSignature = { createRenderSignature: (slots: Record<string, SlotConfig>, layers: Layer[], applySlots: boolean) => string }

describe('关键帧编辑的预览缓存失效', () => {
  it.each([OfficialSvgRenderer, HighPerformanceRenderer])('%s在同一帧修改动画数值时不会命中旧画面', Renderer => {
    const layer = LayerFactory.createLayerFromSprite({ imageKey: 'image', frames: [] }, 0, { viewBoxWidth: 100, viewBoxHeight: 100, fps: 24, frames: 20 })
    const signature = (Renderer.prototype as unknown as CacheSignature).createRenderSignature
    const first = signature({}, [layer], true)
    layer.animationTracks = createDefaultTracks()
    layer.animationTracks.position.keyframes = [{ id: 'p0', frameIndex: 0, value: { x: 20, y: 0 }, easing: 'linear' }]
    const next = signature({}, [layer], true)
    expect(next).not.toBe(first)
    layer.animationTracks.position.keyframes[0].value.x = 25
    expect(signature({}, [layer], true)).not.toBe(next)
  })
})
