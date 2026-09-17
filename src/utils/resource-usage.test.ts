import { describe, expect, it } from 'vitest'
import { LayerFactory } from '@/core/layer-factory'
import type { Layer, VideoItem } from '@/types'
import { buildResourceUsageIndex, describeResourceScope, getResourceUsages } from './resource-usage'

const layer = (key: string, extra: Partial<Layer> = {}): Layer => ({
  ...LayerFactory.createImageLayer({ key, data: new Uint8Array(), width: 8, height: 8, mimeType: 'image/png' }),
  ...extra
})

describe('素材引用索引', () => {
  it('同一图层的图片和遮罩共用一个 Key 时只记录一次并保留两种用途', () => {
    const layers = [layer('avatar', {
      id: 'shared', name: '共享头像', visible: false, locked: true,
      sprites: { imageKey: 'avatar', matteKey: 'avatar', frames: [] }
    })]
    const index = buildResourceUsageIndex(layers, null)

    expect([...index.keys()]).toEqual(['avatar'])
    expect(index.get('avatar')).toEqual([{
      id: 'shared', name: '共享头像', image: true, matte: true, visible: false, locked: true
    }])
  })

  it('原始图层以当前图片 Key 和原文件遮罩 Key 建立引用，忽略被删除的图层', () => {
    const video = { movie: { sprites: [
      { imageKey: 'old-image', matteKey: 'original-mask' },
      { imageKey: 'deleted-image', matteKey: 'deleted-mask' }
    ] } } as VideoItem
    const layers = [layer('new-image', {
      id: 'retained', isNew: false, editableIndex: 0,
      sprites: { imageKey: 'old-image', matteKey: 'fallback-mask', frames: [] }
    })]
    const index = buildResourceUsageIndex(layers, video)

    expect([...index.keys()]).toEqual(['new-image', 'original-mask'])
    expect(index.get('new-image')).toEqual([expect.objectContaining({ id: 'retained', image: true, matte: false })])
    expect(index.get('original-mask')).toEqual([expect.objectContaining({ id: 'retained', image: false, matte: true })])
  })

  it('新增图层仅使用自身精灵遮罩，不复用原文件相同索引的遮罩', () => {
    const video = { movie: { sprites: [{ imageKey: 'old-image', matteKey: 'old-mask' }] } } as VideoItem
    const layers = [layer('new-image', {
      id: 'added', isNew: true, editableIndex: 0,
      sprites: { imageKey: 'new-image', matteKey: 'new-mask', frames: [] }
    })]

    const index = buildResourceUsageIndex(layers, video)

    expect([...index.keys()]).toEqual(['new-image', 'new-mask'])
    expect(index.has('old-mask')).toBe(false)
  })

  it('未加载原文件时使用图层精灵引用，并跳过没有图片或遮罩 Key 的图层', () => {
    const layers = [
      layer('unused', { imageKey: undefined, sprites: { imageKey: 'fallback-image', matteKey: 'fallback-mask', frames: [] } }),
      layer('', { imageKey: undefined })
    ]
    const before = structuredClone(layers)

    const index = buildResourceUsageIndex(layers, null)

    expect([...index.keys()]).toEqual(['fallback-image', 'fallback-mask'])
    expect(layers).toEqual(before)
    expect(buildResourceUsageIndex([], null).size).toBe(0)
  })
})

describe('资源操作范围', () => {
  it('统计共享图片，包含隐藏、锁定图层，不匹配相似 Key', () => {
    const layers = [layer('avatar'), layer('avatar', { visible: false, locked: true }), layer('avatar2')]
    expect(getResourceUsages('avatar', layers, null)).toHaveLength(2)
    expect(describeResourceScope('avatar', layers, null)).toContain('全部 2 个图层')
    expect(getResourceUsages('avatar', layers, null)[1]).toMatchObject({ visible: false, locked: true })
  })

  it('合并普通和遮罩引用，不重复计算同一图层，并排除已删除图层', () => {
    const video = { movie: { sprites: [
      { imageKey: 'avatar', matteKey: 'avatar' },
      { imageKey: 'other', matteKey: 'avatar' },
      { imageKey: 'avatar' }
    ] } } as VideoItem
    const layers = [layer('avatar', { isNew: false, editableIndex: 0 }), layer('other', { isNew: false, editableIndex: 1 })]
    expect(getResourceUsages('avatar', layers, video)).toHaveLength(2)
    expect(describeResourceScope('avatar', layers, video)).toContain('含 2 个遮罩引用')
  })

  it('新增图层不借用原文件同索引的遮罩', () => {
    const video = { movie: { sprites: [{ imageKey: 'other', matteKey: 'avatar' }] } } as VideoItem
    expect(getResourceUsages('avatar', [layer('other', { isNew: true, editableIndex: 0 })], video)).toEqual([])
  })

  it('查询范围不修改图层，未引用资源不新增图层', () => {
    const layers = [layer('other')]
    const before = JSON.stringify(layers)
    expect(describeResourceScope('avatar', layers, null)).toContain('没有图层引用')
    expect(JSON.stringify(layers)).toBe(before)
  })
})
