import { beforeEach, describe, expect, it } from 'vitest'
import type { CanvasTransform, Layer, VideoItem } from '@/types'
import { getLayerBaseFrame, normalizeCanvasTransform } from '@/core/layer-transform'
import { getLayerDuplicateError, resolveCanvasTransform, sampleAnimationValues } from '@/core/keyframe-editing'
import { useEditorStore } from './editorStore'

const state = () => useEditorStore.getState()
const createVideo = (): VideoItem => ({
  movie: {
    version: '2.0.0', params: { viewBoxWidth: 320, viewBoxHeight: 240, fps: 24, frames: 30 }, images: {},
    sprites: ['body', 'badge'].map(imageKey => ({
      imageKey, matteKey: null, frames: Array.from({ length: 30 }, (_, index) => ({
        alpha: 1, layout: { x: 0, y: 0, width: 40, height: 20 },
        transform: { a: 1, b: 0, c: 0, d: 1, tx: index * 3, ty: index * 2 }, clipPath: null
      }))
    }))
  }, images: {}, buffers: {}
})
const update = (values: Partial<Layer>) => {
  useEditorStore.setState({ layers: state().layers.map(layer => layer.id === '0' ? { ...layer, ...values } : layer) })
}
const effective = (): CanvasTransform => resolveCanvasTransform(state().layers[0], state().playback.currentFrame)

beforeEach(() => {
  state().reset()
  state().setVideoItem(createVideo())
  state().selectLayer('0')
})

describe('图层附加关键帧操作', () => {
  it('编辑模式仅影响UI，不创建历史；撤销内容不回退模式', () => {
    state().setTransformEditMode('keyframe')
    expect(state().history.past).toHaveLength(0)
    expect(state().isDirty).toBe(false)
    state().insertAnimationKeyframes(['0'], ['position'])
    state().undo()
    expect(state().transformEditMode).toBe('keyframe')
    state().reset()
    expect(state().transformEditMode).toBe('whole')
  })

  it('只在指定图层插入指定属性，不修改原帧/旧预设，重复插入不写历史', () => {
    const before = state().layers
    expect(state().insertAnimationKeyframes(['0'], ['position', 'scale'], 6)).toEqual({ changed: true })
    const layer = state().layers[0]
    expect(layer.tracks).toBe(before[0].tracks)
    expect(layer.sprites).toBe(before[0].sprites)
    expect(state().layers[1]).toBe(before[1])
    expect(layer.animationTracks!.position.keyframes).toEqual([expect.objectContaining({ frameIndex: 6, value: { x: 0, y: 0 } })])
    expect(layer.animationTracks!.scale.keyframes).toHaveLength(1)
    expect(layer.animationTracks!.rotation.keyframes).toHaveLength(0)
    expect(state().insertAnimationKeyframes(['0', '0'], ['position', 'scale'], 6)).toEqual({ changed: false })
    expect(state().history.past).toHaveLength(1)
    state().undo()
    expect(state().layers[0].animationTracks).toBeUndefined()
    state().redo()
    expect(state().layers[0].animationTracks).toEqual(layer.animationTracks)
  })

  it('批量插帧原子提交，一项锁定则不修改其他图层', () => {
    useEditorStore.setState({ layers: state().layers.map(layer => layer.id === '1' ? { ...layer, locked: true } : layer) })
    const before = state().layers
    expect(state().insertAnimationKeyframes(['0', '1'], ['position']).error).toMatch('解锁')
    expect(state().layers).toBe(before)
    expect(state().history.past).toHaveLength(0)
  })

  it('批量重复ID去重并只写一次历史', () => {
    expect(state().insertAnimationKeyframes(['0', '1', '1'], ['position', 'position'])).toEqual({ changed: true })
    expect(state().layers.every(layer => layer.animationTracks!.position.keyframes.length === 1)).toBe(true)
    expect(state().history.past).toHaveLength(1)
  })

  it('首次在后续帧直接修改补中性起点，按源时间存储', () => {
    update({ timeOffsetFrames: 3 })
    expect(state().setAnimationValue('0', 'position', { x: 70, y: -14 }, 10)).toEqual({ changed: true })
    const keys = state().layers[0].animationTracks!.position.keyframes
    expect(keys.map(key => key.frameIndex)).toEqual([0, 7])
    expect(keys[0].value).toEqual({ x: 0, y: 0 })
    expect(sampleAnimationValues(state().layers[0], 6).position).toEqual({ x: 30, y: -6 })
    expect(sampleAnimationValues(state().layers[0], 10).position).toEqual({ x: 70, y: -14 })
  })

  it.each([
    { clip: { startFrame: 5, duration: 20 }, timeOffsetFrames: 3, output: 12, start: 5, end: 9 },
    { clip: { startFrame: 0, duration: 30 }, timeOffsetFrames: -5, output: 8, start: 5, end: 13 }
  ])('补起点遵守裁切与可见输出范围 %o', ({ clip, timeOffsetFrames, output, start, end }) => {
    update({ clip, timeOffsetFrames })
    state().setAnimationValue('0', 'rotation', 90, output)
    expect(state().layers[0].animationTracks!.rotation.keyframes.map(key => key.frameIndex)).toEqual([start, end])
  })

  it('更新已有关键帧保留ID和缓动，相同值no-op', () => {
    state().setAnimationValue('0', 'rotation', 90, 10)
    const key = state().layers[0].animationTracks!.rotation.keyframes[1]
    state().setAnimationEasing('0', 'rotation', [key.id], 'hold')
    state().setAnimationValue('0', 'rotation', 120, 10)
    expect(state().layers[0].animationTracks!.rotation.keyframes[1]).toEqual({ ...key, easing: 'hold', value: 120 })
    const history = state().history
    expect(state().setAnimationValue('0', 'rotation', 120, 10)).toEqual({ changed: false })
    expect(state().history).toBe(history)
  })

  it('移动用输出帧换算源帧，冲突拒绝，移动支持撤销重做', () => {
    update({ timeOffsetFrames: 3 })
    state().setAnimationValue('0', 'rotation', 90, 13)
    const key = state().layers[0].animationTracks!.rotation.keyframes[1]
    expect(state().moveAnimationKeyframe('0', 'rotation', key.id, 3).error).toMatch('已有关键帧')
    expect(state().moveAnimationKeyframe('0', 'rotation', key.id, 13)).toEqual({ changed: false })
    expect(state().moveAnimationKeyframe('0', 'rotation', key.id, 18)).toEqual({ changed: true })
    expect(state().layers[0].animationTracks!.rotation.keyframes[1].frameIndex).toBe(15)
    state().undo()
    expect(state().layers[0].animationTracks!.rotation.keyframes[1].frameIndex).toBe(10)
    state().redo()
    expect(state().layers[0].animationTracks!.rotation.keyframes[1].frameIndex).toBe(15)
  })

  it('删除最后一个属性关键帧恢复中性值，允许播放头位于clip之外时清理旧关键帧', () => {
    state().insertAnimationKeyframes(['0'], ['position'], 4)
    state().setAnimationValue('0', 'position', { x: 10, y: 20 }, 4)
    const key = state().layers[0].animationTracks!.position.keyframes[0]
    state().selectKeyframe(key.id)
    update({ clip: { startFrame: 5, duration: 20 } })
    expect(state().deleteAnimationKeyframes('0', 'position', [key.id])).toEqual({ changed: true })
    expect(sampleAnimationValues(state().layers[0], 8).position).toEqual({ x: 0, y: 0 })
    expect(state().selectedKeyframeIds).toEqual([])
    state().undo()
    expect(state().layers[0].animationTracks!.position.keyframes).toHaveLength(1)
  })

  it('设置hold缓动只影响选中关键帧，可撤销，重复设置不写历史', () => {
    state().setAnimationValue('0', 'alpha', 0, 10)
    const keys = state().layers[0].animationTracks!.alpha.keyframes
    state().setAnimationEasing('0', 'alpha', [keys[0].id], 'hold')
    expect(sampleAnimationValues(state().layers[0], 9).alpha).toBe(1)
    expect(sampleAnimationValues(state().layers[0], 10).alpha).toBe(0)
    const history = state().history
    expect(state().setAnimationEasing('0', 'alpha', [keys[0].id], 'hold')).toEqual({ changed: false })
    expect(state().history).toBe(history)
    state().undo()
    expect(sampleAnimationValues(state().layers[0], 5).alpha).toBe(0.5)
  })

  it.each<Partial<Layer>>([{ locked: true }, { visible: false }, { type: 'text' }, { timeOffsetFrames: 40 }])('插帧、修改和移动拒绝不可编辑图层 %o', changes => {
    update(changes)
    expect(state().insertAnimationKeyframes(['0'], ['position']).changed).toBe(false)
    expect(state().setAnimationValue('0', 'position', { x: 1, y: 2 }).changed).toBe(false)
    expect(state().moveAnimationKeyframe('0', 'position', 'missing', 0).changed).toBe(false)
    expect(state().history.past).toHaveLength(0)
    expect(state().isDirty).toBe(false)
  })

  it('拒绝NaN、越界、缺失ID或无效属性，不创建任何半完成操作', () => {
    expect(state().setAnimationValue('0', 'position', { x: NaN, y: 0 }).error).toBeTruthy()
    expect(state().setAnimationValue('0', 'scale', { scaleX: -1, scaleY: 1 }).error).toBeTruthy()
    expect(state().setAnimationValue('0', 'alpha', 1.1).error).toBeTruthy()
    expect(state().setAnimationValue('0', 'rotation', 90, 30).error).toBeTruthy()
    expect(state().insertAnimationKeyframes(['missing'], ['rotation']).error).toBeTruthy()
    expect(state().deleteAnimationKeyframes('0', 'position', ['missing']).error).toBeTruthy()
    expect(state().setAnimationEasing('0', 'position', ['missing'], 'hold').error).toBeTruthy()
    expect(state().history.past).toHaveLength(0)
  })

  it('暂停播放器同步当前帧后才采样，避免写入旧播放帧', () => {
    state().setCurrentFrame(4)
    state().setPlaying(true)
    const unsubscribe = useEditorStore.subscribe(value => value.playback.isPlaying, playing => {
      if (!playing) state().setCurrentFrame(12)
    })
    state().insertAnimationKeyframes(['0'], ['position'])
    unsubscribe()
    expect(state().playback.isPlaying).toBe(false)
    expect(state().layers[0].animationTracks!.position.keyframes[0].frameIndex).toBe(12)
  })
})

describe('关键帧模式画布事务', () => {
  it('一次连续拖动只写变化属性，一次历史，baseline与原运动不变', () => {
    update({ canvasTransform: normalizeCanvasTransform({ x: 10, y: 20, scaleX: 2, scaleY: 3, rotation: 0.1 }) })
    state().setCurrentFrame(10)
    state().setTransformEditMode('keyframe')
    const original = state().layers[0]
    const initial = effective()
    expect(state().beginCanvasTransform('0')).toBe(true)
    for (let x = 1; x <= 20; x++) {
      state().previewCanvasTransform('0', { ...initial, x: initial.x + x, y: initial.y - x })
      expect(state().history.past).toHaveLength(0)
    }
    state().endCanvasTransform(true)
    expect(state().history.past).toHaveLength(1)
    expect(state().history.past[0].label).toBe('关键帧变换：body')
    const layer = state().layers[0]
    expect(layer.canvasTransform).toEqual(original.canvasTransform)
    expect(layer.tracks).toBe(original.tracks)
    expect(layer.sprites).toBe(original.sprites)
    expect(layer.animationTracks!.position.keyframes.map(key => key.frameIndex)).toEqual([0, 10])
    expect(layer.animationTracks!.position.keyframes[1].value).toEqual({ x: 20, y: -20 })
    expect(layer.animationTracks!.scale.keyframes).toEqual([])
    expect(layer.animationTracks!.rotation.keyframes).toEqual([])
    state().undo()
    expect(state().layers[0].animationTracks).toBeUndefined()
    state().redo()
    expect(effective()).toEqual({ ...initial, x: initial.x + 20, y: initial.y - 20 })
  })

  it('缩放与旋转从effective反算附加轨道，弧度转换为角度', () => {
    update({ canvasTransform: normalizeCanvasTransform({ scaleX: 2, scaleY: 3, rotation: Math.PI / 6 }) })
    state().setCurrentFrame(8)
    state().setTransformEditMode('keyframe')
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', { ...effective(), scaleX: 4, scaleY: 9, rotation: Math.PI / 2 })
    state().endCanvasTransform(true)
    const values = sampleAnimationValues(state().layers[0], 8)
    expect(values.scale).toEqual({ scaleX: 2, scaleY: 3 })
    expect(values.rotation).toBeCloseTo(60)
    expect(state().layers[0].animationTracks!.position.keyframes).toEqual([])
  })

  it.each([false, true])('取消或回到起点恢复原引用和dirty，回起点=%s', returnToStart => {
    state().setCurrentFrame(10)
    state().setTransformEditMode('keyframe')
    const before = state()
    const initial = effective()
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', { ...initial, x: 80 })
    if (returnToStart) state().previewCanvasTransform('0', initial)
    state().endCanvasTransform(returnToStart)
    expect(state().layers).toBe(before.layers)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(false)
  })

  it('切换帧或编辑模式提交本手势，迟到的事件不污染下一帧', () => {
    state().setCurrentFrame(10)
    state().setTransformEditMode('keyframe')
    const initial = effective()
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', { ...initial, x: 80 })
    state().setCurrentFrame(20)
    state().previewCanvasTransform('0', { ...initial, x: 99 })
    expect(state().layers[0].animationTracks!.position.keyframes.map(key => key.frameIndex)).toEqual([0, 10])
    expect(state().history.past).toHaveLength(1)
    expect(state().isCanvasTransforming).toBe(false)
  })

  it('拒绝多选关键帧手势和图层有效范围外的手势', () => {
    state().setTransformEditMode('keyframe')
    expect(state().beginCanvasTransforms(['0', '1'])).toBe(false)
    update({ timeOffsetFrames: 10 })
    expect(state().beginCanvasTransform('0')).toBe(false)
    expect(state().history.past).toHaveLength(0)
  })

  it('whole模式effective反算baseline，不覆盖已有关键帧', () => {
    state().setAnimationValue('0', 'position', { x: 20, y: 30 }, 0)
    state().setAnimationValue('0', 'scale', { scaleX: 2, scaleY: 3 }, 0)
    state().setAnimationValue('0', 'rotation', 90, 0)
    update({ canvasTransform: normalizeCanvasTransform({ x: 10, y: 15, scaleX: 2, scaleY: 4, rotation: 0.2 }) })
    state().clearHistory()
    const tracks = state().layers[0].animationTracks
    const initial = effective()
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', { ...initial, x: initial.x + 15, scaleX: initial.scaleX * 2, rotation: initial.rotation + 0.4 })
    state().endCanvasTransform(true)
    expect(state().layers[0].animationTracks).toBe(tracks)
    expect(state().layers[0].canvasTransform).toEqual({ x: 25, y: 15, scaleX: 4, scaleY: 4, rotation: expect.closeTo(0.6) })
    expect(state().history.past).toHaveLength(1)
  })

  it('浮点effective往返没有微小变化历史，零动画缩放不产生Infinity', () => {
    state().setAnimationValue('0', 'position', { x: 0.2, y: 0.3 }, 0)
    state().setAnimationValue('0', 'scale', { scaleX: 0, scaleY: 2 }, 0)
    update({ canvasTransform: normalizeCanvasTransform({ x: 0.1, y: 0.1 }) })
    state().clearHistory()
    const original = state().layers
    const initial = effective()
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', initial)
    state().endCanvasTransform(true)
    expect(state().layers).toBe(original)
    expect(state().history.past).toHaveLength(0)
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', { ...initial, scaleX: 2 })
    state().endCanvasTransform(true)
    expect(state().layers).toBe(original)
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', { ...initial, x: initial.x + 10 })
    state().endCanvasTransform(true)
    expect(state().layers[0].canvasTransform!.x).toBeCloseTo(10.1)
    expect(state().layers[0].canvasTransform!.scaleX).toBe(1)
  })
})

describe('复制与关键帧历史隔离', () => {
  it('复制导入图层保留逐帧运动和裁切，所有关键帧使用新ID并深拷贝', () => {
    state().setAnimationValue('0', 'position', { x: 60, y: 20 }, 10)
    update({ timeOffsetFrames: 3, clip: { startFrame: 2, duration: 24 } })
    const source = state().layers[0]
    source.tracks.position.keyframes = [{ id: 'old-preset', frameIndex: 0, value: { x: 8, y: 4 }, easing: 'linear' }]
    const newId = state().duplicateLayer('0')!
    const copy = state().layers.find(layer => layer.id === newId)!
    expect(copy.isNew).toBe(true)
    expect(copy.clip).toEqual(source.clip)
    expect(copy.timeOffsetFrames).toBe(3)
    expect(copy.sprites).toEqual(source.sprites)
    expect(copy.sprites).not.toBe(source.sprites)
    expect(copy.animationTracks!.position.keyframes.map(key => key.id)).not.toEqual(source.animationTracks!.position.keyframes.map(key => key.id))
    expect(copy.tracks.position.keyframes[0].id).not.toBe('old-preset')
    expect(getLayerBaseFrame(copy, 13)).toEqual(getLayerBaseFrame(source, 13))
    expect(getLayerBaseFrame(copy, 13)!.transform.tx).toBe(38)
    copy.animationTracks!.position.keyframes[1].value.x = 999
    copy.tracks.position.keyframes[0].value.x = 999
    expect(source.animationTracks!.position.keyframes[1].value.x).toBe(60)
    expect(source.tracks.position.keyframes[0].value.x).toBe(8)
  })

  it('遮罩内容或作为遮罩的图层拒绝单独复制，不产生历史', () => {
    const layers = state().layers
    layers[0].sprites!.matteKey = 'badge'
    expect(getLayerDuplicateError(layers[0], layers, state().videoItem)).toMatch('遮罩')
    expect(getLayerDuplicateError(layers[1], layers, state().videoItem)).toMatch('遮罩')
    expect(state().duplicateLayer('0')).toBeNull()
    expect(state().duplicateLayer('1')).toBeNull()
    expect(state().layers).toHaveLength(2)
    expect(state().history.past).toHaveLength(0)
  })

  it('撤销快照不共享关键帧值或曲线控制点', () => {
    state().setAnimationValue('0', 'position', { x: 10, y: 20 }, 0)
    const key = state().layers[0].animationTracks!.position.keyframes[0]
    key.bezierControlPoints = { x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 }
    state().setAnimationValue('0', 'position', { x: 30, y: 40 }, 0)
    state().layers[0].animationTracks!.position.keyframes[0].value.x = 999
    state().layers[0].animationTracks!.position.keyframes[0].bezierControlPoints!.x1 = 0.9
    state().undo()
    const restored = state().layers[0].animationTracks!.position.keyframes[0]
    expect(restored.value).toEqual({ x: 10, y: 20 })
    expect(restored.bezierControlPoints!.x1).toBe(0.1)
  })
})
