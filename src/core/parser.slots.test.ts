import { describe, expect, it } from 'vitest'
import { SVGAParser } from './parser'
import type { MovieEntity, Sprite } from '@/types'

const movie = (sprites: Sprite[]): MovieEntity => ({
  version: '2.0', params: { viewBoxWidth: 100, viewBoxHeight: 100, fps: 24, frames: 1 },
  images: { resourceOnly: new Uint8Array() }, sprites,
})
const sprite = (imageKey: string): Sprite => ({ imageKey, matteKey: null, frames: [] })

describe('精确 imageKey 检测', () => {
  const parser = new SVGAParser()

  it('收集全部非空字符串 Key，稳定去重且不剥离 $、@ 或空白', () => {
    const keys = ['avatar', '$name@2', '0', '__proto__', ' text ', '', 'avatar', '   ', '$name@2']
    expect(parser.detectSlots(movie(keys.map(sprite)))).toEqual(['avatar', '$name@2', '0', '__proto__', ' text ', '   '])
  })

  it('资源表不等于可调用插槽，空精灵和无效 Key 不创建假插槽', () => {
    expect(parser.detectSlots(movie([]))).toEqual([])
    const invalid = [null, {}, { imageKey: 0 }, { imageKey: false }, sprite('valid')] as Sprite[]
    expect(parser.detectSlots(movie(invalid))).toEqual(['valid'])
  })

  it('可编辑索引保留精灵索引和原始 Key，命名只标记为疑似文字', () => {
    const sprites = ['ordinary', 'userName', 'button_name', '$slot@full'].map(sprite)
    const result = parser.getLayersByEditableIndex(movie(sprites))
    expect(result.get(0)).toEqual({ sprite: sprites[0], imageKey: 'ordinary', layerType: 'image' })
    expect(result.get(1)).toEqual({ sprite: sprites[1], imageKey: 'userName', layerType: 'text-candidate' })
    expect(result.get(2)?.layerType).toBe('image')
    expect(result.get(3)).toEqual({ sprite: sprites[3], imageKey: '$slot@full', layerType: 'slot' })
    expect([...result.values()].some(entry => entry.layerType === 'text')).toBe(false)
  })

  it('容忍缺失精灵字段，不把无效非字符串 Key 交给命名检测', () => {
    const result = parser.getLayersByEditableIndex(movie([null, { imageKey: 12 }] as unknown as Sprite[]))
    expect([...result.keys()]).toEqual([1])
    expect(result.get(1)?.imageKey).toBe('')
  })
})
