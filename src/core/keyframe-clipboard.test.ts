import { describe, expect, it, vi } from 'vitest'
import type { Layer } from '@/types'
import { createDefaultTracks } from './layer-factory'
import { createAnimationTracks } from './keyframe-editing'
import { copyAnimationKeyframes, prepareKeyframePaste, prepareSelectedKeyframeEdit, MAX_CLIPBOARD_KEYS } from './keyframe-clipboard'
import type { AnimationKeyReference, KeyframeClipboard } from './keyframe-clipboard'

function layer(id = 'a', overrides: Partial<Layer> = {}): Layer {
  const animationTracks = createAnimationTracks()
  animationTracks.position.keyframes = [
    { id: `${id}-p0`, frameIndex: 2, value: { x: 10, y: -20 }, easing: 'bezier', bezierControlPoints: { x1: .2, y1: -.3, x2: .7, y2: 1.2 } },
    { id: `${id}-p1`, frameIndex: 6, value: { x: 30, y: 40 }, easing: 'hold' }
  ]
  animationTracks.scale.keyframes = [{ id: `${id}-s0`, frameIndex: 4, value: { scaleX: 1.5, scaleY: 2 }, easing: 'easeOut' }]
  return { id, name: `图层${id}`, type: 'image', visible: true, locked: false, expanded: false, opacity: 1,
    blendMode: 'normal', clip: { startFrame: 0, duration: 100 }, tracks: createDefaultTracks(), animationTracks, ...overrides }
}
const refs = (id = 'a'): AnimationKeyReference[] => [
  { layerId: id, track: 'position', keyId: `${id}-p0` },
  { layerId: id, track: 'scale', keyId: `${id}-s0` },
  { layerId: id, track: 'position', keyId: `${id}-p1` }
]
const makeIds = () => { let index = 0; return () => `pasted-${index++}` }
const copy = (layers = [layer()], selection = refs()) => copyAnimationKeyframes(layers, selection, 200).clipboard!

describe('关键帧会话剪贴板', () => {
  it('以最早合成帧为起点复制多属性、值、缓动与贝塞尔控制点', () => {
    const source = layer('a', { timeOffsetFrames: 10 })
    const clip = copy([source], [...refs()].reverse())
    expect(clip.keys.map(key => [key.track, key.relativeFrame, key.easing])).toEqual([
      ['position', 4, 'hold'], ['scale', 2, 'easeOut'], ['position', 0, 'bezier']
    ])
    expect(clip.keys[2].bezierControlPoints).toEqual(source.animationTracks!.position.keyframes[0].bezierControlPoints)
    expect(clip.keys[2].value).not.toBe(source.animationTracks!.position.keyframes[0].value)
    expect(clip.keys[2].bezierControlPoints).not.toBe(source.animationTracks!.position.keyframes[0].bezierControlPoints)
    source.animationTracks!.position.keyframes[0].value.x = 999
    source.animationTracks!.position.keyframes[0].bezierControlPoints!.y1 = 999
    expect(clip.keys[2].value).toEqual({ x: 10, y: -20 })
    expect(clip.keys[2].bezierControlPoints!.y1).toBe(-.3)
  })

  it('同名 keyId 在不同图层或轨道中仍以精确三元组寻址，重复选择只复制一次', () => {
    const first = layer(), second = layer('b')
    second.animationTracks!.position.keyframes[0].id = 'a-p0'
    const selection = [refs()[0], refs()[0], { layerId: 'b', track: 'position' as const, keyId: 'a-p0' }]
    expect(copy([first, second], selection).keys.map(key => key.layerId)).toEqual(['a', 'b'])
  })

  it('原动画轨道不混入调整轨道复制，失效选择不静默跳过', () => {
    const source = layer()
    source.tracks.rotation.keyframes = [{ id: 'original', frameIndex: 3, value: 10, easing: 'linear' }]
    expect(copyAnimationKeyframes([source], [...refs(), { layerId: 'a', track: 'rotation', keyId: 'original' }], 200).error).toContain('不存在')
    expect(copyAnimationKeyframes([source], [], 200).error).toContain('选择')
    expect(copyAnimationKeyframes([source], Array(MAX_CLIPBOARD_KEYS + 1).fill(refs()[0]), 200).error).toContain('最多')
  })

  it.each([{ locked: true }, { visible: false }, { timeOffsetFrames: -3 }, { timeOffsetFrames: .5 }, { type: 'audio' as const }])('拒绝不可编辑或不在当前合成范围的来源 %o', overrides => {
    expect(copyAnimationKeyframes([layer('a', overrides)], refs(), 200).clipboard).toBeUndefined()
  })

  it('拒绝无效属性和非有限曲线，不修改原数据', () => {
    const source = layer()
    source.animationTracks!.position.keyframes[0].bezierControlPoints!.y1 = Infinity
    expect(copyAnimationKeyframes([source], refs(), 200).error).toContain('无效')
    source.animationTracks!.position.keyframes[0].bezierControlPoints!.y1 = 0
    source.animationTracks!.scale.keyframes[0].value.scaleX = -1
    expect(copyAnimationKeyframes([source], refs(), 200).error).toContain('无效')
  })
})

describe('关键帧整组粘贴计划', () => {
  it('保留相对帧/轨道/值/缓动，按目标最新时间偏移转换并生成独立 id', () => {
    const source = layer('a', { timeOffsetFrames: 7 }), clip = copy([source])
    const target = { ...source, timeOffsetFrames: 10 }
    const original = JSON.stringify(target)
    const result = prepareKeyframePaste([target], clip, 30, 200, makeIds())
    expect(result.error).toBeUndefined()
    expect(result.selection.map(item => item.keyId)).toEqual(['pasted-0', 'pasted-1', 'pasted-2'])
    const tracks = result.layers[0].animationTracks!
    expect(tracks.position.keyframes.map(key => key.frameIndex)).toEqual([2, 6, 20, 24])
    expect(tracks.scale.keyframes.map(key => key.frameIndex)).toEqual([4, 22])
    expect(tracks.position.keyframes[2]).toMatchObject({ value: { x: 10, y: -20 }, easing: 'bezier', bezierControlPoints: { x1: .2, y1: -.3, x2: .7, y2: 1.2 } })
    expect(tracks.position.keyframes[3].easing).toBe('hold')
    expect(tracks.position.keyframes[2].value).not.toBe(clip.keys[0].value)
    expect(tracks.position.keyframes[2].bezierControlPoints).not.toBe(clip.keys[0].bezierControlPoints)
    expect(tracks.position.keyframes[0]).toBe(target.animationTracks!.position.keyframes[0])
    expect(result.layers[0].tracks).toBe(target.tracks)
    expect(JSON.stringify(target)).toBe(original)
  })

  it('跨图层按原 layerId 映射并保留各层合成时间间隔，图层顺序不影响映射', () => {
    const first = layer('a', { timeOffsetFrames: 5 }), second = layer('b', { timeOffsetFrames: 10 })
    const clip = copy([first, second], [refs()[0], refs('b')[0]])
    expect(clip.keys.map(key => key.relativeFrame)).toEqual([0, 5])
    const result = prepareKeyframePaste([second, first], clip, 50, 200, makeIds())
    expect(result.layers[0].animationTracks!.position.keyframes[2].frameIndex).toBe(45)
    expect(result.layers[1].animationTracks!.position.keyframes[2].frameIndex).toBe(45)
    expect(result.selection.map(key => key.layerId)).toEqual(['a', 'b'])
  })

  it('单来源可以粘贴到新目标图层，无需原层仍存在；不会修改原动画或其他层', () => {
    const source = layer(), target = layer('target', { animationTracks: undefined, timeOffsetFrames: 5 }), other = layer('other')
    const result = prepareKeyframePaste([other, target], copy([source]), 30, 200, makeIds(), 'target')
    expect(result.error).toBeUndefined()
    expect(result.selection.every(item => item.layerId === 'target')).toBe(true)
    expect(result.layers[1].animationTracks!.position.keyframes.map(key => key.frameIndex)).toEqual([25, 29])
    expect(result.layers[0]).toBe(other)
    expect(target.animationTracks).toBeUndefined()
  })

  it('多来源不允许汇到一个目标图层', () => {
    const layers = [layer(), layer('b')]
    const result = prepareKeyframePaste(layers, copy(layers, [refs()[0], refs('b')[0]]), 30, 200, makeIds(), 'a')
    expect(result.error).toContain('仅单一来源')
    expect(result.layers).toBe(layers)
  })

  it('最后一个目标冲突时整组拒绝且不分配 id，不覆盖已有关键帧', () => {
    const target = layer(), layers = [target]
    target.animationTracks!.position.keyframes.push({ id: 'occupied', frameIndex: 24, value: { x: 200, y: 300 }, easing: 'linear' })
    const makeId = vi.fn(makeIds())
    const result = prepareKeyframePaste(layers, copy(), 20, 200, makeId)
    expect(result.error).toContain('整组粘贴已取消')
    expect(result.layers).toBe(layers)
    expect(result.selection).toEqual([])
    expect(makeId).not.toHaveBeenCalled()
    expect(target.animationTracks!.position.keyframes).toHaveLength(3)
  })

  it.each([
    [{ locked: true }, 30], [{ visible: false }, 30], [{ type: 'audio' }, 30],
    [{ timeOffsetFrames: .5 }, 30], [{ timeOffsetFrames: 40 }, 30],
    [{ clip: { startFrame: 10, duration: 20 } }, 5], [{ clip: { startFrame: 0, duration: 32 } }, 30],
    [{}, -1], [{}, 199], [{}, 20.5], [{}, NaN]
  ])('拒绝锁定/隐藏/时间偏移/clip/合成越界且保留原数组：%o @ %s', (overrides, frame) => {
    const layers = [layer('a', overrides as Partial<Layer>)]
    const result = prepareKeyframePaste(layers, copy(), frame as number, 200, makeIds())
    expect(result.error).toBeTruthy()
    expect(result.layers).toBe(layers)
  })

  it('缺失目标或缺失目标源画面均拒绝，不回落到同名图层', () => {
    expect(prepareKeyframePaste([layer('b', { name: '图层a' })], copy(), 30, 200, makeIds()).error).toContain('不存在')
    const noFrame = layer('a', { sprites: { imageKey: 'a', matteKey: null, frames: [] } })
    expect(prepareKeyframePaste([noFrame], copy(), 30, 200, makeIds()).error).toContain('没有可编辑')
  })

  it('重复生成的 id 或与已有 id 冲突不留下部分粘贴', () => {
    const layers = [layer()]
    for (const makeId of [() => 'duplicated', () => 'a-p0']) {
      const result = prepareKeyframePaste(layers, copy(), 30, 200, makeId)
      expect(result.layers).toBe(layers)
      expect(result.error).toContain('标识')
      expect(result.selection).toEqual([])
    }
  })

  it('拒绝剪贴板损坏、重复目标、非有限值和超量，不发生静默覆盖', () => {
    const clip = copy(), layers = [layer()]
    const bad = [
      { ...clip, version: 2 }, { ...clip, keys: [] },
      { ...clip, keys: [clip.keys[0], clip.keys[0]] },
      { ...clip, keys: [{ ...clip.keys[0], relativeFrame: 1 }] },
      { ...clip, keys: [{ ...clip.keys[0], value: { x: NaN, y: 1 } }] },
      { ...clip, keys: [{ ...clip.keys[0], relativeFrame: -1 }] },
      { ...clip, keys: [{ ...clip.keys[0], easing: 'fake' }] },
      { ...clip, keys: Array(MAX_CLIPBOARD_KEYS + 1).fill(clip.keys[0]) }
    ]
    for (const candidate of bad) {
      const result = prepareKeyframePaste(layers, candidate as KeyframeClipboard, 30, 200, makeIds())
      expect(result.error).toBeTruthy()
      expect(result.layers).toBe(layers)
    }
  })
})

describe('关键帧多选删除和缓动', () => {
  it('跨图层、跨轨道整组删除且保持原动画和未选中关键帧', () => {
    const layers = [layer(), layer('b')]
    const result = prepareSelectedKeyframeEdit(layers, [refs()[0], refs()[1], refs('b')[0]], 200, { type: 'delete' })
    expect(result.error).toBeUndefined()
    expect(result.layers[0].animationTracks!.position.keyframes.map(key => key.id)).toEqual(['a-p1'])
    expect(result.layers[0].animationTracks!.scale.keyframes).toEqual([])
    expect(result.layers[1].animationTracks!.position.keyframes.map(key => key.id)).toEqual(['b-p1'])
    expect(result.layers[1].animationTracks!.scale).toBe(layers[1].animationTracks!.scale)
    expect(result.layers[0].tracks).toBe(layers[0].tracks)
    expect(result.selection).toEqual([])
    expect(layers[0].animationTracks!.position.keyframes).toHaveLength(2)
  })

  it('跨图层应用缓动，保留贝塞尔控制点、值、帧；全相同是无变化', () => {
    const layers = [layer(), layer('b')], selection = [...refs(), refs('b')[0]]
    const result = prepareSelectedKeyframeEdit(layers, selection, 200, { type: 'easing', easing: 'easeInOut' })
    expect(result.error).toBeUndefined()
    expect(result.selection).toEqual(selection)
    expect(result.layers[0].animationTracks!.position.keyframes.map(key => key.easing)).toEqual(['easeInOut', 'easeInOut'])
    expect(result.layers[0].animationTracks!.scale.keyframes[0].easing).toBe('easeInOut')
    expect(result.layers[1].animationTracks!.position.keyframes[0]).toEqual({ ...layers[1].animationTracks!.position.keyframes[0], easing: 'easeInOut' })
    expect(prepareSelectedKeyframeEdit(result.layers, selection, 200, { type: 'easing', easing: 'easeInOut' }).layers).toBe(result.layers)
  })

  it('跨层最后一个不可编辑或引用失效时，整组删除和 F9 均不部分生效', () => {
    for (const last of [layer('b', { locked: true }), layer('b', { visible: false }), layer('missing')]) {
      const layers = [layer(), last], original = JSON.stringify(layers)
      for (const action of [{ type: 'delete' as const }, { type: 'easing' as const, easing: 'easeInOut' as const }]) {
        const result = prepareSelectedKeyframeEdit(layers, [refs()[0], refs('b')[0]], 200, action)
        expect(result.error).toBeTruthy()
        expect(result.layers).toBe(layers)
        expect(JSON.stringify(layers)).toBe(original)
      }
    }
  })
})
