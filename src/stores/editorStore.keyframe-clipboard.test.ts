import { beforeEach, describe, expect, it } from 'vitest'
import type { VideoItem } from '@/types'
import { createAnimationTracks } from '@/core/keyframe-editing'
import { copyAnimationKeyframes } from '@/core/keyframe-clipboard'
import type { AnimationKeyReference } from '@/core/keyframe-clipboard'
import { useEditorStore } from './editorStore'

const state = () => useEditorStore.getState()
const refs = (id = '0'): AnimationKeyReference[] => [
  { layerId: id, track: 'position', keyId: `${id}-p0` },
  { layerId: id, track: 'scale', keyId: `${id}-s0` },
  { layerId: id, track: 'position', keyId: `${id}-p1` }
]
const copy = (selection = refs()) => copyAnimationKeyframes(state().layers, selection, state().playback.totalFrames).clipboard!

beforeEach(() => {
  state().reset()
  const video: VideoItem = { movie: {
    version: '2.0.0', params: { viewBoxWidth: 320, viewBoxHeight: 240, fps: 24, frames: 40 }, images: {},
    sprites: ['body', 'badge'].map(imageKey => ({ imageKey, matteKey: null,
      frames: Array.from({ length: 40 }, () => ({ alpha: 1, layout: { x: 0, y: 0, width: 40, height: 20 },
        transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null })) }))
  }, images: {}, buffers: {} }
  state().setVideoItem(video)
  useEditorStore.setState({ layers: state().layers.map(layer => {
    const tracks = createAnimationTracks()
    tracks.position.keyframes = [
      { id: `${layer.id}-p0`, frameIndex: 2, value: { x: 12, y: 6 }, easing: 'bezier', bezierControlPoints: { x1: .2, y1: -.3, x2: .6, y2: 1.2 } },
      { id: `${layer.id}-p1`, frameIndex: 6, value: { x: 50, y: 10 }, easing: 'hold' }
    ]
    tracks.scale.keyframes = [{ id: `${layer.id}-s0`, frameIndex: 4, value: { scaleX: 1.3, scaleY: 1.5 }, easing: 'linear' }]
    return { ...layer, animationTracks: tracks }
  }) })
  state().selectLayer('0')
  state().initializeHistory()
})

describe('关键帧多选的 store 原子历史', () => {
  it('单层多属性粘贴只有一次历史，撤销/重做整组恢复并保留新 id 与曲线', () => {
    const clipboard = copy(), original = state().layers
    state().setCurrentFrame(20)
    const result = state().pasteAnimationKeyframes(clipboard)
    expect(result.changed).toBe(true)
    expect(result.selection).toHaveLength(3)
    expect(result.selection!.every(ref => !refs().some(source => source.keyId === ref.keyId))).toBe(true)
    expect(state().history.past).toHaveLength(1)
    expect(state().isDirty).toBe(true)
    const pasted = state().layers[0].animationTracks
    expect(state().layers[0].tracks).toBe(original[0].tracks)
    expect(state().layers[0].sprites).toBe(original[0].sprites)
    expect(state().layers[1]).toBe(original[1])
    expect(pasted!.position.keyframes.map(key => key.frameIndex)).toEqual([2, 6, 20, 24])
    state().undo()
    expect(state().layers[0].animationTracks).toEqual(original[0].animationTracks)
    state().redo()
    expect(state().layers[0].animationTracks).toEqual(pasted)
  })

  it('跨图层粘贴的相对帧来自合成时间而不是数组顺序', () => {
    useEditorStore.setState({ layers: state().layers.map(layer => layer.id === '1' ? { ...layer, timeOffsetFrames: 3 } : layer) })
    const clipboard = copy([refs('1')[0], refs()[0]])
    const result = state().pasteAnimationKeyframes(clipboard, 20)
    expect(result.changed).toBe(true)
    expect(result.selection!.map(ref => ref.layerId)).toEqual(['1', '0'])
    expect(state().layers.map(layer => layer.animationTracks!.position.keyframes[2].frameIndex)).toEqual([20, 20])
    expect(state().history.past).toHaveLength(1)
    state().undo()
    expect(state().layers.every(layer => layer.animationTracks!.position.keyframes.length === 2)).toBe(true)
  })

  it('显式当前层粘贴只修改目标，不会修改来源层', () => {
    const clipboard = copy(), source = state().layers[0]
    const result = state().pasteAnimationKeyframes(clipboard, 20, '1')
    expect(result.selection!.every(ref => ref.layerId === '1')).toBe(true)
    expect(state().layers[0]).toBe(source)
    expect(state().layers[1].animationTracks!.scale.keyframes.map(key => key.frameIndex)).toEqual([4, 22])
    expect(state().history.past).toHaveLength(1)
  })

  it('跨层批量删除与缓动各一次历史，撤销/重做不遗漏其他属性', () => {
    const selection = [...refs(), refs('1')[0]], original = state().layers.map(layer => layer.animationTracks)
    expect(state().setSelectedAnimationEasing(selection, 'easeInOut')).toEqual({ changed: true })
    expect(state().history.past).toHaveLength(1)
    expect(state().layers[0].animationTracks!.scale.keyframes[0].easing).toBe('easeInOut')
    expect(state().layers[1].animationTracks!.position.keyframes[0].easing).toBe('easeInOut')
    const eased = state().layers.map(layer => layer.animationTracks)
    state().undo()
    expect(state().layers.map(layer => layer.animationTracks)).toEqual(original)
    state().redo()
    expect(state().layers.map(layer => layer.animationTracks)).toEqual(eased)
    expect(state().deleteSelectedAnimationKeyframes(selection)).toEqual({ changed: true })
    expect(state().history.past).toHaveLength(2)
    expect(state().layers[0].animationTracks!.position.keyframes).toEqual([])
    expect(state().layers[0].animationTracks!.scale.keyframes).toEqual([])
    expect(state().layers[1].animationTracks!.position.keyframes.map(key => key.id)).toEqual(['1-p1'])
    state().undo()
    expect(state().layers.map(layer => layer.animationTracks)).toEqual(eased)
  })

  it('相同缓动不产生历史或 dirty；无效缓动也不提交', () => {
    const selection = [refs()[1]], before = state()
    expect(state().setSelectedAnimationEasing(selection, 'linear')).toEqual({ changed: false })
    expect(state().setSelectedAnimationEasing(selection, 'fake' as 'linear').error).toBeTruthy()
    expect(state()).toBe(before)
  })

  it.each(['locked', 'hidden', 'missing', 'out-of-range', 'conflict'])('任一目标失败则粘贴不产生任何历史/dirty/播放副作用：%s', reason => {
    const clipboard = copy([...refs(), refs('1')[0]])
    useEditorStore.setState({ layers: state().layers.map(layer => layer.id !== '1' ? layer : reason === 'locked' ? { ...layer, locked: true }
      : reason === 'hidden' ? { ...layer, visible: false } : reason === 'missing' ? { ...layer, id: 'other' }
        : reason === 'out-of-range' ? { ...layer, timeOffsetFrames: 25 } : { ...layer, animationTracks: { ...layer.animationTracks!, position: {
          ...layer.animationTracks!.position, keyframes: [...layer.animationTracks!.position.keyframes, { id: 'conflict', frameIndex: 20, value: { x: 1, y: 2 }, easing: 'linear' as const }]
        } } }) })
    state().setPlaying(true)
    const before = state()
    expect(state().pasteAnimationKeyframes(clipboard, 20).error).toBeTruthy()
    expect(state()).toBe(before)
    expect(state().history.past).toHaveLength(0)
    expect(state().isDirty).toBe(false)
  })

  it('批量删除和缓动包含隐藏层或失效 Key 时，不先修改可编辑层', () => {
    const selection = [...refs(), refs('1')[0]]
    useEditorStore.setState({ layers: state().layers.map(layer => layer.id === '1' ? { ...layer, visible: false } : layer) })
    const before = state()
    expect(state().deleteSelectedAnimationKeyframes(selection).error).toBeTruthy()
    expect(state().setSelectedAnimationEasing(selection, 'easeInOut').error).toBeTruthy()
    expect(state().deleteSelectedAnimationKeyframes([...refs(), { layerId: '0', track: 'rotation', keyId: 'missing' }]).error).toBeTruthy()
    expect(state()).toBe(before)
  })

  it.each(['canvas', 'slot'])('不把未提交 %s 草稿夹带进关键帧历史', kind => {
    const clipboard = copy()
    if (kind === 'canvas') {
      expect(state().beginCanvasTransform('0')).toBe(true)
      state().previewCanvasTransform('0', { x: 10, y: 10, scaleX: 1, scaleY: 1, rotation: 0 })
    } else {
      expect(state().beginSlotConfigEdit('body')).toBe(true)
      state().previewSlotConfig('body', { type: 'text', name: 'body', value: '草稿' })
    }
    const before = state()
    expect(state().pasteAnimationKeyframes(clipboard, 20).error).toContain('结束当前编辑')
    expect(state().deleteSelectedAnimationKeyframes(refs()).error).toContain('结束当前编辑')
    expect(state().setSelectedAnimationEasing(refs(), 'easeInOut').error).toContain('结束当前编辑')
    expect(state()).toBe(before)
    expect(state().history.past).toHaveLength(0)
    if (kind === 'canvas') state().endCanvasTransform(false)
    else state().endSlotConfigEdit(false)
  })
})
