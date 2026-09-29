import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeQuantizedPng } from '@/core/png-quantize'
import { captureReplacementTarget } from '@/core/replacement-target'
import { useEditorStore } from './editorStore'

const state = () => useEditorStore.getState()
const png = new Uint8Array(encodeQuantizedPng(new Uint8Array(20 * 10 * 4).fill(255), 20, 10, 64))
const replacement = `data:image/png;base64,${Buffer.from(png).toString('base64')}`

beforeEach(() => {
  state().reset()
  state().setVideoItem({ movie: { version: '2.0', params: { viewBoxWidth: 200, viewBoxHeight: 100, frames: 2, fps: 24 },
    images: { avatar: png }, sprites: [0, 1].map(index => ({ imageKey: 'avatar', matteKey: null, frames: [0, 1].map(frame => ({ alpha: 1,
      clipPath: 'M0 0L20 10Z', layout: { x: 0, y: 0, width: 20, height: 10 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: index * 50 + frame, ty: 0 } })) })) },
    images: { avatar: { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as HTMLImageElement }, buffers: { avatar: new Uint8Array(png).buffer } })
  state().setOriginalBuffer(new ArrayBuffer(16))
  state().selectLayer('1')
  state().initializeHistory()
})

afterEach(() => state().reset())

describe('图片替换原子历史事务', () => {
  it('单层资源/插槽/绑定只记一次历史，撤销和重做完整恢复且不改变原sprite顺序', () => {
    const before = state()
    const target = captureReplacementTarget(before, 'avatar')
    const result = state().replaceImageResource('avatar', replacement, 'current-layer', '1', target)
    expect(result).toEqual({ changed: true, key: 'avatar_layer' })
    expect(state().history.past).toHaveLength(1)
    expect(state().layers.map(layer => layer.id)).toEqual(['0', '1'])
    expect(state().layers[1]).toMatchObject({ imageKey: 'avatar_layer', resourceDetached: true, editableIndex: 1 })
    expect(state().layers[1].isNew).not.toBe(true)
    expect(state().originalBuffer).toBe(before.originalBuffer)
    expect(state().videoItem).toBe(before.videoItem)
    expect(state().selectedLayerIds).toEqual(['1'])
    state().undo()
    expect(state().layers).toEqual(before.layers)
    expect([...state().imageResources.keys()]).toEqual(['avatar'])
    expect(state().slotConfigs).toEqual(before.slotConfigs)
    expect(state().canRedo).toBe(true)
    state().redo()
    expect(state().layers[1]).toMatchObject({ imageKey: 'avatar_layer', resourceDetached: true, editableIndex: 1 })
    expect([...state().imageResources.keys()]).toEqual(['avatar', 'avatar_layer'])
    expect(state().slotConfigs.avatar_layer.value).toBe(replacement)
  })

  it('全部引用仍只记录一次历史，不增图层、不增加独立资源', () => {
    const before = state()
    expect(state().replaceImageResource('avatar', replacement, 'all-references').changed).toBe(true)
    expect(state().history.past).toHaveLength(1)
    expect(state().layers).toBe(before.layers)
    expect(state().imageResources).toBe(before.imageResources)
    expect(state().slotConfigs.avatar.value).toBe(replacement)
    state().undo()
    expect(state().slotConfigs).toEqual(before.slotConfigs)
  })

  it.each(['文字草稿', '画布变换'])('%s 活跃时拒绝，不偷偷提交草稿或清除重做', mode => {
    if (mode === '文字草稿') state().beginSlotConfigEdit('avatar')
    else state().beginCanvasTransform('1')
    const before = state()
    expect(state().replaceImageResource('avatar', replacement, 'current-layer', '1')).toMatchObject({ changed: false, error: expect.stringContaining('先结束') })
    expect(state()).toBe(before)
    expect(state().history.past).toHaveLength(0)
  })

  it('失效预览拒绝且保留已有重做栈', () => {
    const target = captureReplacementTarget(state(), 'avatar')
    state().updateLayer('1', { opacity: 0.5 })
    state().undo()
    const before = state()
    expect(state().replaceImageResource('avatar', replacement, 'current-layer', '1', target).changed).toBe(false)
    expect(state()).toBe(before)
    expect(state().canRedo).toBe(true)
  })

  it('图层选中状态在图片加载期间改变时不能把换图应用到另一层', () => {
    const target = captureReplacementTarget(state(), 'avatar')
    state().selectLayer('0')
    const before = state()
    expect(state().replaceImageResource('avatar', replacement, 'current-layer', '1', target).changed).toBe(false)
    expect(state()).toBe(before)
  })

  it('无效拟合图片失败时不写入资源、插槽或历史', () => {
    const before = state()
    expect(state().replaceImageResource('avatar', 'data:image/png;base64,AA==', 'current-layer', '1').changed).toBe(false)
    expect(state()).toBe(before)
    expect(state().history.past).toHaveLength(0)
  })
})
