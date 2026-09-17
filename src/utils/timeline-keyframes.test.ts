import { describe, expect, it } from 'vitest'
import type { Layer } from '@/types'
import { createDefaultTracks } from '@/core/layer-factory'
import { createAnimationTracks } from '@/core/keyframe-editing'
import { adjacentKeyframe, buildTimelineRows, findTimelineKey, keyframeAtDrag, keyframeMoveError, timelineInsertionError } from './timeline-keyframes'

function layer(id: string, overrides: Partial<Layer> = {}): Layer {
  return {
    id, name: id, type: 'image', visible: true, locked: false, expanded: false, opacity: 1,
    blendMode: 'normal', clip: { startFrame: 0, duration: 30 }, tracks: createDefaultTracks(),
    ...overrides
  }
}

function animated(id = 'a', offset = 0): Layer {
  const tracks = createAnimationTracks()
  tracks.rotation.keyframes = [
    { id: 'one', frameIndex: 0, value: 0, easing: 'linear' },
    { id: 'two', frameIndex: 10, value: 90, easing: 'linear' },
    { id: 'three', frameIndex: 20, value: 180, easing: 'easeInOut' }
  ]
  return layer(id, { animationTracks: tracks, timeOffsetFrames: offset })
}

describe('时间轴属性虚拟行', () => {
  it('只自动展开主选中图层，其他图层保持一行', () => {
    const rows = buildTimelineRows([layer('a'), layer('b'), layer('c')], 'b', {}, 'all', false, ['a', 'b'])
    expect(rows.map(row => row.key)).toEqual(['a', 'b', 'b:position', 'b:scale', 'b:rotation', 'b:alpha', 'c'])
    expect(rows.findIndex(row => row.key === 'c')).toBe(6)
  })

  it('显式展开与收起优先于默认选中状态', () => {
    const rows = buildTimelineRows([layer('a'), layer('b')], 'b', { a: true, b: false }, 'all', false, ['b'])
    expect(rows.map(row => row.key)).toEqual(['a', 'a:position', 'a:scale', 'a:rotation', 'a:alpha', 'b'])
  })

  it('非图片图层不出现无效属性，锁定或隐藏图层仍可查看轨道', () => {
    const rows = buildTimelineRows([layer('audio', { type: 'audio' }), animated('locked')], 'locked', { audio: true }, 'rotation', false, ['locked'])
    expect(rows.map(row => row.key)).toEqual(['audio', 'locked', 'locked:rotation'])
    const readonly = buildTimelineRows([layer('a', { locked: true, visible: false })], 'a', {}, 'all', false, ['a'])
    expect(readonly).toHaveLength(5)
  })

  it('按属性过滤并保留图层名行', () => {
    const rows = buildTimelineRows([animated()], 'a', {}, 'scale', false, ['a'])
    expect(rows.map(row => row.key)).toEqual(['a', 'a:scale'])
  })

  it('U 只显示新调整轨道的已有动画，不将旧预设伪装为可编辑轨道', () => {
    const item = animated()
    item.tracks.position.keyframes.push({ id: 'legacy', frameIndex: 0, value: { x: 1, y: 2 }, easing: 'linear' })
    const rows = buildTimelineRows([item, layer('b')], 'a', { b: true }, 'animated', false, ['a'])
    expect(rows.map(row => row.key)).toEqual(['a', 'a:rotation', 'b'])
  })

  it('仅选中图层过滤以精确 id 为准，无选择时返回空行', () => {
    const layers = [layer('a'), layer('b')]
    expect(buildTimelineRows(layers, 'b', {}, 'all', true, ['a']).map(row => row.key)).toEqual(['a'])
    expect(buildTimelineRows(layers, null, {}, 'all', true, [])).toEqual([])
  })
})

describe('时间轴关键帧寻址与导航', () => {
  it('使用图层、属性、关键帧三元组，显示帧包含时间偏移', () => {
    const first = animated('a')
    const second = animated('b', 7)
    expect(findTimelineKey([first, second], { layerId: 'b', track: 'rotation', keyId: 'two' }))
      .toMatchObject({ layer: { id: 'b' }, keyframe: { frameIndex: 10 }, outputFrame: 17 })
    expect(findTimelineKey([first, second], { layerId: 'b', track: 'position', keyId: 'two' })).toBeNull()
    expect(findTimelineKey([first], { layerId: 'b', track: 'rotation', keyId: 'two' })).toBeNull()
    expect(findTimelineKey([first], null)).toBeNull()
  })

  it('删除后的选中引用失效，不回落到其他图层的同名关键帧', () => {
    const item = animated()
    item.animationTracks!.rotation.keyframes = []
    expect(findTimelineKey([item, animated('b')], { layerId: 'a', track: 'rotation', keyId: 'two' })).toBeNull()
  })

  it('前后关键帧严格跳过当前帧，时间偏移不改变源数据', () => {
    const item = animated('a', 5)
    expect(adjacentKeyframe(item, 'rotation', 15, -1)?.id).toBe('one')
    expect(adjacentKeyframe(item, 'rotation', 15, 1)?.id).toBe('three')
    expect(adjacentKeyframe(item, 'rotation', 5, -1)).toBeNull()
    expect(adjacentKeyframe(item, 'rotation', 25, 1)).toBeNull()
    expect(adjacentKeyframe(item, 'position', 15, 1)).toBeNull()
  })
})

describe('时间轴工具栏批量插帧校验', () => {
  it('全部选中图层可编辑时通过，并保持选择顺序和图层数据', () => {
    const layers = [animated('a'), animated('b', 5)]
    const selectedIds = ['b', 'a']
    const before = JSON.stringify(layers)
    expect(timelineInsertionError(layers, selectedIds, 10, 40)).toBeNull()
    expect(selectedIds).toEqual(['b', 'a'])
    expect(JSON.stringify(layers)).toBe(before)
  })

  it.each([
    { locked: true },
    { visible: false },
    { type: 'audio' as const }
  ])('任意非主选中图层不可编辑时拒绝整组：%o', overrides => {
    const layers = [layer('不能编辑', overrides), layer('主选中')]
    const result = timelineInsertionError(layers, ['不能编辑', '主选中'], 10, 30)
    expect(result).toMatch(/^不能编辑：/)
    expect(timelineInsertionError(layers, ['主选中'], 10, 30)).toBeNull()
  })

  it('使用每个图层自己的时间偏移校验，不以主图层范围代替整组', () => {
    const layers = [animated('延后图层', 10), animated('主图层')]
    expect(timelineInsertionError(layers, ['主图层', '延后图层'], 5, 40)).toContain('延后图层')
    expect(timelineInsertionError(layers, ['主图层', '延后图层'], 10, 40)).toBeNull()
  })

  it('无选择、已删除图层和非整数帧均拒绝，不静默漏掉目标', () => {
    expect(timelineInsertionError([layer('a')], [], 0, 30)).toContain('选择')
    expect(timelineInsertionError([layer('a')], ['a', 'missing'], 0, 30)).toContain('不存在')
    expect(timelineInsertionError([layer('a')], ['a'], 1.5, 30)).toContain('整数帧')
  })

  it('有已有关键帧的选中图层仍可批量插入，校验不删除或覆盖它们', () => {
    const item = animated()
    expect(timelineInsertionError([item], ['a', 'a'], 10, 30)).toBeNull()
    expect(item.animationTracks!.rotation.keyframes).toHaveLength(3)
    expect(item.animationTracks!.rotation.keyframes[1].value).toBe(90)
  })
})

describe('时间轴拖动安全', () => {
  it('位移按最近帧吸附，横向滚动只累计一次', () => {
    expect(keyframeAtDrag(10, 14, 20, 10)).toBe(13)
    expect(keyframeAtDrag(10, 15, 20, 10)).toBe(14)
    expect(keyframeAtDrag(10, -20, 0, 10)).toBe(8)
    expect(keyframeAtDrag(10, 0, 0, 10)).toBe(10)
  })

  it('不静默钳制越界帧，让提交校验明确拒绝', () => {
    expect(keyframeAtDrag(0, -50, 0, 10)).toBe(-5)
    expect(keyframeAtDrag(10, 40, 0, 0)).toBe(10)
    expect(keyframeAtDrag(10, 40, 0, NaN)).toBe(10)
  })

  it('目标帧冲突拒绝覆盖；同一关键帧留在原位允许', () => {
    const item = animated('a', 5)
    expect(keyframeMoveError(item, 'rotation', 'one', 15, 40)).toContain('已有关键帧')
    expect(keyframeMoveError(item, 'rotation', 'one', 5, 40)).toBeNull()
    expect(keyframeMoveError(item, 'rotation', 'one', 6, 40)).toBeNull()
    expect(item.animationTracks!.rotation.keyframes[0].frameIndex).toBe(0)
  })

  it('拒绝越合成范围、小数和源 clip 外的位置', () => {
    const item = animated('a', 5)
    for (const frame of [-1, 40, 2.5, NaN]) expect(keyframeMoveError(item, 'rotation', 'one', frame, 40)).toBeTruthy()
    expect(keyframeMoveError(item, 'rotation', 'one', 4, 40)).toContain('时间范围')
    expect(keyframeMoveError(item, 'rotation', 'one', 35, 40)).toContain('时间范围')
  })

  it('拒绝锁定、隐藏图层以及不存在的关键帧', () => {
    expect(keyframeMoveError({ ...animated(), locked: true }, 'rotation', 'one', 1, 30)).toContain('解锁')
    expect(keyframeMoveError({ ...animated(), visible: false }, 'rotation', 'one', 1, 30)).toContain('显示')
    expect(keyframeMoveError(animated(), 'rotation', 'missing', 1, 30)).toContain('不存在')
  })
})
