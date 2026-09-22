import { beforeEach, describe, expect, it } from 'vitest'
import type { VideoItem } from '@/types'
import { useEditorStore } from './editorStore'

const createVideo = (): VideoItem => ({
  movie: {
    version: '2.0',
    params: { viewBoxWidth: 400, viewBoxHeight: 300, fps: 24, frames: 24 },
    images: {},
    sprites: [{ imageKey: 'frame', matteKey: null, frames: Array.from({ length: 24 }, () => ({
      alpha: 1,
      layout: { x: 0, y: 0, width: 80, height: 60 },
      transform: { a: 1, b: 0, c: 0, d: 1, tx: 10, ty: 20 },
      clipPath: null
    })) }]
  },
  images: {},
  buffers: {}
})

const state = () => useEditorStore.getState()

describe('编辑器画布尺寸', () => {
  beforeEach(() => {
    state().reset()
    state().setVideoItem(createVideo())
    state().setOriginalBuffer(new ArrayBuffer(8))
  })

  it('同步 params 和 videoItem、保持动画参数并只产生一条历史', () => {
    const originalVideo = state().videoItem
    const result = state().setCanvasSize(640, 480)
    expect(result).toEqual({ changed: true })
    expect(state().params?.viewBoxWidth).toBe(640)
    expect(state().params?.viewBoxHeight).toBe(480)
    expect(state().videoItem?.movie.params.viewBoxWidth).toBe(640)
    expect(state().videoItem?.movie.params.viewBoxHeight).toBe(480)
    expect(state().videoItem?.movie.params.fps).toBe(24)
    expect(state().videoItem?.movie.params.frames).toBe(24)
    expect(state().videoItem).not.toBe(originalVideo)
    expect(originalVideo?.movie.params.viewBoxWidth).toBe(400)
    expect(state().history.past).toHaveLength(1)
    expect(state().history.past[0].label).toBe('修改画布尺寸：640 × 480')
    expect(state().isDirty).toBe(true)
    expect(state().playback.totalFrames).toBe(24)
    expect(state().playback.fps).toBe(24)
  })

  it('尺寸修改支持撤销和重做，并恢复 videoItem 身份', () => {
    const originalVideo = state().videoItem
    state().setCanvasSize(640, 480)
    const editedVideo = state().videoItem
    state().undo()
    expect(state().params?.viewBoxWidth).toBe(400)
    expect(state().params?.viewBoxHeight).toBe(300)
    expect(state().videoItem).toBe(originalVideo)
    expect(state().canRedo).toBe(true)
    state().redo()
    expect(state().videoItem).toBe(editedVideo)
    expect(state().videoItem?.movie.params.viewBoxWidth).toBe(640)
    expect(state().videoItem?.movie.params.viewBoxHeight).toBe(480)
  })

  it('同值和非法值不产生历史，也不改变文档', () => {
    const before = state()
    expect(state().setCanvasSize(400, 300)).toEqual({ changed: false })
    for (const size of [[0, 300], [100.5, 100], [8193, 1], [2049, 2048], [Number.NaN, 100]] as const) {
      expect(state().setCanvasSize(size[0], size[1]).changed).toBe(false)
    }
    expect(state().params?.viewBoxWidth).toBe(400)
    expect(state().params?.viewBoxHeight).toBe(300)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(false)
  })

  it('没有文件时返回明确错误', () => {
    state().reset()
    expect(state().setCanvasSize(640, 480)).toEqual({ changed: false, error: '请先打开 SVGA 文件。' })
  })
})
