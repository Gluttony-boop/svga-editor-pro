import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from './editorStore'
import type { VideoItem } from '@/types'
import { getLayerOutputRange } from '@/core/layer-time'

const video = (): VideoItem => ({
  movie: {
    version: '2.0', params: { viewBoxWidth: 200, viewBoxHeight: 200, fps: 10, frames: 10 }, images: {},
    sprites: ['a', 'b', 'c'].map((imageKey, i) => ({ imageKey, matteKey: null, frames: Array.from({ length: 10 }, (_, f) => ({
      alpha: 1, layout: { x: 0, y: 0, width: 20, height: 20 }, clipPath: null,
      transform: { a: 1, b: 0, c: 0, d: 1, tx: i * 50 + f, ty: f }
    })) })),
    audios: [{ key: 'sound', data: new Uint8Array([1, 2]), startTime: 0, duration: 1000 }]
  }, images: {}, buffers: {}
})
const state = () => useEditorStore.getState()

beforeEach(() => {
  state().reset()
  state().setVideoItem(video())
  state().setOriginalBuffer(new ArrayBuffer(8))
  state().selectLayers(['0', '1'])
})

describe('图层时间编排状态', () => {
  it('延后与自动延长一次提交，源动画/音频/未选中层不变，可撤销重做', () => {
    const before = state()
    const frames = JSON.stringify(before.videoItem)
    const third = before.layers[2]
    const result = state().arrangeLayerTiming({ mode: 'shift', frames: 5, extendDuration: true })
    expect(result).toMatchObject({ changed: true, totalFrames: 15 })
    expect(state().layers.map(layer => layer.timeOffsetFrames || 0)).toEqual([5, 5, 0])
    expect(state().customFrames).toBe(15)
    expect(state().playback.totalFrames).toBe(15)
    expect(state().history.past).toHaveLength(1)
    expect(state().layers[2]).toBe(third)
    expect(JSON.stringify(state().videoItem)).toBe(frames)
    expect(state().layers[0].tracks).toBe(before.layers[0].tracks)
    expect(state().layers[0].clip).toBe(before.layers[0].clip)
    state().undo()
    expect(state().customFrames).toBeNull()
    expect(state().playback.totalFrames).toBe(10)
    expect(state().layers[0].timeOffsetFrames).toBeUndefined()
    expect(state().selectedLayerIds).toEqual(['0', '1'])
    state().redo()
    expect(state().layers[1].timeOffsetFrames).toBe(5)
    expect(state().playback.totalFrames).toBe(15)
  })

  it('关闭延长时越界原子拒绝，提前越过起点也拒绝', () => {
    const before = state()
    expect(state().arrangeLayerTiming({ mode: 'shift', frames: 5, extendDuration: false })).toHaveProperty('error')
    expect(state().arrangeLayerTiming({ mode: 'shift', frames: -1, extendDuration: true })).toHaveProperty('error')
    expect(state().layers).toBe(before.layers)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(false)
    expect(state().playback.totalFrames).toBe(10)
  })

  it('错峰按图层顺序而非选中顺序，并且重复操作无历史', () => {
    state().selectLayers(['2', '0', '1'])
    state().arrangeLayerTiming({ mode: 'stagger', frames: 3, extendDuration: true })
    expect(state().layers.map(layer => getLayerOutputRange(layer).startFrame)).toEqual([0, 3, 6])
    expect(state().playback.totalFrames).toBe(16)
    const before = state()
    expect(state().arrangeLayerTiming({ mode: 'stagger', frames: 3, extendDuration: true })).toMatchObject({ changed: false })
    expect(state().history).toBe(before.history)
    expect(state().layers).toBe(before.layers)
  })

  it('重置只清偏移，不自动缩短总时长；零偏移是只读操作', () => {
    const initial = state()
    state().arrangeLayerTiming({ mode: 'reset', frames: 0, extendDuration: true })
    expect(state().layers).toBe(initial.layers)
    expect(state().isDirty).toBe(false)
    state().arrangeLayerTiming({ mode: 'shift', frames: 4, extendDuration: true })
    state().arrangeLayerTiming({ mode: 'reset', frames: 0, extendDuration: true })
    expect(state().layers[0].timeOffsetFrames).toBe(0)
    expect(state().playback.totalFrames).toBe(14)
    expect(state().history.past).toHaveLength(2)
  })

  it.each([{ locked: true }, { visible: false }])('选区含保护图层时整组拒绝 %s', update => {
    state().updateLayer('1', update)
    const before = state()
    expect(state().arrangeLayerTiming({ mode: 'shift', frames: 2, extendDuration: true })).toHaveProperty('error')
    expect(state().layers).toBe(before.layers)
    expect(state().history).toBe(before.history)
  })

  it('先暂停但不跳帧或改选区，再安排时间', () => {
    state().setCurrentFrame(4)
    state().setPlaying(true)
    state().arrangeLayerTiming({ mode: 'shift', frames: 3, extendDuration: true })
    expect(state().playback.isPlaying).toBe(false)
    expect(state().playback.currentFrame).toBe(4)
    expect(state().selectedLayerIds).toEqual(['0', '1'])
  })

  it('拖动尚未结束时先提交变换，时间编排使用独立历史', () => {
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', { x: 12, y: 0, scaleX: 1, scaleY: 1, rotation: 0 })
    state().arrangeLayerTiming({ mode: 'shift', frames: 3, extendDuration: true })
    expect(state().isCanvasTransforming).toBe(false)
    expect(state().history.past).toHaveLength(2)
    state().undo()
    expect(state().layers[0].timeOffsetFrames).toBeUndefined()
    expect(state().layers[0].canvasTransform?.x).toBe(12)
    state().undo()
    expect(state().layers[0].canvasTransform).toBeUndefined()
  })
})
