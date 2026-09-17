import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeCanvasTransform } from '@/core/layer-transform'
import type { CanvasTransform, VideoItem } from '@/types'
import { useEditorStore } from './editorStore'

const createVideo = (name = 'avatar'): VideoItem => ({
  movie: {
    version: '2.0',
    params: { viewBoxWidth: 400, viewBoxHeight: 300, fps: 24, frames: 24 },
    images: {},
    sprites: [{
      imageKey: name,
      matteKey: null,
      frames: Array.from({ length: 24 }, (_, index) => ({
        alpha: 1,
        layout: { x: 0, y: 0, width: 80, height: 60 },
        transform: { a: 1, b: 0, c: 0, d: 1, tx: index * 3, ty: index * 2 },
        clipPath: null
      }))
    }]
  },
  images: {},
  buffers: {}
})

const edit = (updates: Partial<CanvasTransform>): CanvasTransform => normalizeCanvasTransform(updates)
const state = () => useEditorStore.getState()

describe('画布变换事务', () => {
  beforeEach(() => {
    state().reset()
    state().setVideoItem(createVideo())
    state().setOriginalBuffer(new ArrayBuffer(16))
    state().selectLayer('0')
  })

  it('连续实时预览不写历史，结束后只产生一次可撤销、可重做的变换', () => {
    const sourceFrames = structuredClone(state().layers[0].sprites?.frames)
    expect(state().beginCanvasTransform('0')).toBe(true)
    for (let x = 1; x <= 25; x++) {
      state().previewCanvasTransform('0', edit({ x, scaleX: 1.5, rotation: 0.3 }))
      expect(state().history.past).toHaveLength(0)
    }
    expect(state().isCanvasTransforming).toBe(true)
    expect(state().layers[0].canvasTransform?.x).toBe(25)
    state().endCanvasTransform(true)
    expect(state().history.past).toHaveLength(1)
    expect(state().history.past[0].label).toBe('画布变换：avatar')
    expect(state().isCanvasTransforming).toBe(false)
    expect(state().isDirty).toBe(true)
    expect(state().layers[0].sprites?.frames).toEqual(sourceFrames)
    state().undo()
    expect(normalizeCanvasTransform(state().layers[0].canvasTransform)).toEqual(edit({}))
    state().redo()
    expect(state().layers[0].canvasTransform).toEqual(edit({ x: 25, scaleX: 1.5, rotation: 0.3 }))
  })

  it('取消拖动精确恢复原始图层引用、dirty 和历史', () => {
    const layers = state().layers
    const history = state().history
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', edit({ x: 25, y: -50 }))
    state().endCanvasTransform(false)
    expect(state().layers).toBe(layers)
    expect(state().history).toBe(history)
    expect(state().isDirty).toBe(false)
    expect(state().isCanvasTransforming).toBe(false)
  })

  it('取消拖动不清空已有修改和重做历史', () => {
    state().updateLayer('0', { opacity: 0.4 })
    state().undo()
    const before = state()
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', edit({ rotation: 0.8 }))
    state().endCanvasTransform(false)
    expect(state().layers).toBe(before.layers)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(before.isDirty)
    expect(state().canRedo).toBe(true)
  })

  it('没有移动或拖回起点不产生历史或未保存状态', () => {
    const original = state().layers
    state().beginCanvasTransform('0')
    state().endCanvasTransform(true)
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', edit({ x: 22 }))
    state().previewCanvasTransform('0', edit({}))
    state().endCanvasTransform(true)
    expect(state().layers).toBe(original)
    expect(state().history.past).toHaveLength(0)
    expect(state().isDirty).toBe(false)
  })

  it.each([{ locked: true }, { visible: false }])('锁定或隐藏图层拒绝画布变换：%o', changes => {
    useEditorStore.setState({ layers: state().layers.map(layer => ({ ...layer, ...changes })) })
    const layers = state().layers
    expect(state().beginCanvasTransform('0')).toBe(false)
    state().previewCanvasTransform('0', edit({ x: 123 }))
    state().updateCanvasTransform('0', { x: 55 })
    state().endCanvasTransform(true)
    expect(state().layers).toBe(layers)
    expect(state().history.past).toHaveLength(0)
    expect(state().isDirty).toBe(false)
  })

  it('无文件或不存在的图层不能开始变换', () => {
    expect(state().beginCanvasTransform('missing')).toBe(false)
    state().reset()
    expect(state().beginCanvasTransform('0')).toBe(false)
  })

  it('开始变换暂停播放但保留当前帧', () => {
    state().setCurrentFrame(12)
    state().setPlaying(true)
    state().beginCanvasTransform('0')
    expect(state().playback.isPlaying).toBe(false)
    expect(state().playback.currentFrame).toBe(12)
    state().endCanvasTransform(false)
  })

  it.each([true, false])('拖动时切换文件，旧事件不会回写新文件，commit=%s', commit => {
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', edit({ x: 60 }))
    const nextVideo = createVideo('next-avatar')
    state().setVideoItem(nextVideo)
    state().selectLayer('0')
    const layers = state().layers
    state().previewCanvasTransform('0', edit({ x: 999 }))
    state().endCanvasTransform(commit)
    expect(state().videoItem).toBe(nextVideo)
    expect(state().layers).toBe(layers)
    expect(state().layers[0].imageKey).toBe('next-avatar')
    expect(state().layers[0].canvasTransform).toBeUndefined()
    expect(state().isDirty).toBe(false)
    expect(state().history.past).toHaveLength(0)
    expect(state().isCanvasTransforming).toBe(false)
  })

  it('拖动期间替换底层缓冲区后，结束事务不会恢复旧图层快照', () => {
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', edit({ x: 15 }))
    state().setOriginalBuffer(new ArrayBuffer(32))
    const latestLayers = state().layers
    state().endCanvasTransform(false)
    expect(state().layers).toBe(latestLayers)
    expect(state().history.past).toHaveLength(0)
    expect(state().isCanvasTransforming).toBe(false)
  })

  it('拖动时撤销先取消当前拖动，不顺带撤销上一条已提交操作', () => {
    state().updateLayer('0', { opacity: 0.7 })
    const before = state()
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', edit({ x: 60 }))
    state().undo()
    expect(state().layers).toBe(before.layers)
    expect(state().layers[0].opacity).toBe(0.7)
    expect(state().history).toBe(before.history)
    expect(state().isCanvasTransforming).toBe(false)
    state().endCanvasTransform(true)
    expect(state().history.past).toHaveLength(1)
    state().undo()
    expect(state().layers[0].opacity).toBe(1)
  })

  it('面板更新部分变换保留其他属性且相同值不写历史', () => {
    state().updateCanvasTransform('0', { x: 10, scaleX: 1.2 })
    state().updateCanvasTransform('0', { y: 20, rotation: -Math.PI / 4 })
    const history = state().history
    expect(state().layers[0].canvasTransform).toEqual(edit({ x: 10, y: 20, scaleX: 1.2, rotation: -Math.PI / 4 }))
    state().updateCanvasTransform('0', { y: 20 })
    expect(state().history).toBe(history)
    expect(state().history.past).toHaveLength(2)
  })

  it('视口缩放先提交拖动，后续过期事件不再改动图层', () => {
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', edit({ x: 110 }))
    state().setZoom(2)
    state().previewCanvasTransform('0', edit({ x: 55 }))
    expect(state().layers[0].canvasTransform?.x).toBe(110)
    expect(state().isCanvasTransforming).toBe(false)
    expect(state().history.past).toHaveLength(1)
  })

  it('保存前提交后，失焦取消不回退已提交的画面', () => {
    state().beginCanvasTransform('0')
    state().previewCanvasTransform('0', edit({ rotation: 0.5 }))
    state().endCanvasTransform(true)
    const savedLayers = state().layers
    state().endCanvasTransform(false)
    expect(state().layers).toBe(savedLayers)
    expect(state().history.past).toHaveLength(1)
  })

  it('等比设置不修改文件与历史', () => {
    const before = state()
    state().setCanvasKeepRatio(false)
    expect(state().canvasKeepRatio).toBe(false)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(before.isDirty)
  })
})
