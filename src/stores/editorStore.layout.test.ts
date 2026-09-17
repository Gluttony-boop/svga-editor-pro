import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeCanvasTransform } from '@/core/layer-transform'
import type { CanvasTransform, VideoItem } from '@/types'
import { useEditorStore } from './editorStore'

const createVideo = (): VideoItem => ({
  movie: {
    version: '2.0',
    params: { viewBoxWidth: 500, viewBoxHeight: 400, fps: 24, frames: 24 },
    images: {},
    sprites: [
      { name: 'avatar', width: 80, height: 60, x: 20, y: 30, dx: 1, dy: 2 },
      { name: 'nickname', width: 120, height: 30, x: 180, y: 120, dx: 2, dy: -1 },
      { name: 'badge', width: 40, height: 90, x: 330, y: 230, dx: -1, dy: 1 }
    ].map(item => ({
      imageKey: item.name,
      matteKey: null,
      frames: Array.from({ length: 24 }, (_, frameIndex) => ({
        alpha: 1,
        layout: { x: 0, y: 0, width: item.width, height: item.height },
        transform: { a: 1, b: 0, c: 0, d: 1, tx: item.x + frameIndex * item.dx, ty: item.y + frameIndex * item.dy },
        clipPath: null
      }))
    }))
  },
  images: {},
  buffers: {}
})

const state = () => useEditorStore.getState()
const edit = (transform: Partial<CanvasTransform> = {}) => normalizeCanvasTransform(transform)
const transforms = () => state().layers.map(layer => edit(layer.canvasTransform))

beforeEach(() => {
  state().reset()
  state().setVideoItem(createVideo())
  state().setOriginalBuffer(new ArrayBuffer(16))
  state().setCurrentFrame(6)
  state().selectLayers(['2', '0', '1'])
})

describe('图层对齐与分布事务', () => {
  it.each([
    { operation: 'align-left', label: '左对齐', expected: [edit(), edit({ x: -166 }), edit({ x: -298 })] },
    { operation: 'align-top', label: '顶对齐', expected: [edit(), edit({ y: -72 }), edit({ y: -194 })] },
    { operation: 'distribute-x', label: '水平等间距', expected: [edit(), edit({ x: -37 }), edit()] },
    { operation: 'distribute-y', label: '垂直等间距', expected: [edit(), edit({ y: 40 }), edit()] }
  ] as const)('$label只产生一条可撤销重做的历史，保留选区、当前帧及源动画', ({ operation, label, expected }) => {
    const video = state().videoItem
    const sourceSprites = structuredClone(video!.movie.sprites)
    const sourceLayers = structuredClone(state().layers)
    const selection = [...state().selectedLayerIds]
    const result = state().arrangeLayers(operation, 'selection')

    expect(result).toMatchObject({ changed: true })
    expect(transforms()).toEqual(expected)
    expect(state().history.past).toHaveLength(1)
    expect(state().history.past[0].label).toBe(`${label}：3 个图层（选区）`)
    expect(state().isDirty).toBe(true)
    expect(state().selectedLayerIds).toEqual(selection)
    expect(state().selectedLayerId).toBe('1')
    expect(state().playback.currentFrame).toBe(6)
    expect(state().videoItem).toBe(video)
    expect(video!.movie.sprites).toEqual(sourceSprites)
    expect(state().layers.map(layer => layer.sprites)).toEqual(sourceSprites)
    expect(state().layers.map(layer => layer.tracks)).toEqual(sourceLayers.map(layer => layer.tracks))

    state().undo()
    expect(transforms()).toEqual([edit(), edit(), edit()])
    expect(state().history.past).toHaveLength(0)
    expect(state().history.future).toHaveLength(1)
    expect(state().selectedLayerIds).toEqual(selection)
    expect(state().selectedLayerId).toBe('1')
    expect(state().playback.currentFrame).toBe(6)
    expect(state().layers.map(layer => layer.sprites)).toEqual(sourceSprites)

    state().redo()
    expect(transforms()).toEqual(expected)
    expect(state().history.past).toHaveLength(1)
    expect(state().history.future).toHaveLength(0)
    expect(state().selectedLayerIds).toEqual(selection)
    expect(state().selectedLayerId).toBe('1')
    expect(state().playback.currentFrame).toBe(6)
    expect(video!.movie.sprites).toEqual(sourceSprites)
    expect(state().layers.map(layer => layer.sprites)).toEqual(sourceSprites)
  })

  it('只对选中项排版，未选中图层连对象引用也保持不变', () => {
    state().selectLayers(['2', '0'])
    const untouched = state().layers[1]
    const result = state().arrangeLayers('align-left', 'selection')

    expect(result).toMatchObject({ changed: true })
    expect(transforms()).toEqual([edit(), edit(), edit({ x: -298 })])
    expect(state().layers[1]).toBe(untouched)
    expect(state().selectedLayerIds).toEqual(['2', '0'])
    expect(state().selectedLayerId).toBe('0')
    expect(state().history.past).toHaveLength(1)
  })

  it.each(['align-left', 'distribute-x'] as const)('重复执行%s不新增历史，也不会让已保存文档重新变脏', operation => {
    expect(state().arrangeLayers(operation, 'selection')).toMatchObject({ changed: true })
    // 模拟用户保存完成；再次点击同一排版按钮不应制造新修改。
    useEditorStore.setState({ isDirty: false })
    const before = state()

    expect(state().arrangeLayers(operation, 'selection')).toMatchObject({ changed: false })
    expect(state().arrangeLayers(operation, 'selection')).toMatchObject({ changed: false })
    expect(state().layers).toBe(before.layers)
    expect(state().history).toBe(before.history)
    expect(state().history.past).toHaveLength(1)
    expect(state().isDirty).toBe(false)
  })

  it('无需变化的排版保留已有重做记录', () => {
    state().arrangeLayers('align-left', 'selection')
    state().updateLayer('0', { opacity: 0.5 })
    state().undo()
    useEditorStore.setState({ isDirty: false })
    const before = state()

    expect(state().arrangeLayers('align-left', 'selection')).toMatchObject({ changed: false })
    expect(state().layers).toBe(before.layers)
    expect(state().history).toBe(before.history)
    expect(state().canRedo).toBe(true)
    expect(state().isDirty).toBe(false)
  })

  it.each([
    { operation: 'align-left', changes: { locked: true } },
    { operation: 'align-left', changes: { visible: false } },
    { operation: 'distribute-x', changes: { locked: true } },
    { operation: 'distribute-x', changes: { visible: false } }
  ] as const)('选区任一成员受保护时原子拒绝：$operation $changes', ({ operation, changes }) => {
    useEditorStore.setState({ layers: state().layers.map(layer => layer.id === '1' ? { ...layer, ...changes } : layer) })
    const before = state()
    const result = state().arrangeLayers(operation, 'selection')

    expect('error' in result).toBe(true)
    expect(state().layers).toBe(before.layers)
    expect(state().history).toBe(before.history)
    expect(state().selectedLayerIds).toEqual(before.selectedLayerIds)
    expect(state().playback.currentFrame).toBe(6)
    expect(state().isDirty).toBe(false)
  })

  it.each([
    { operation: 'align-center-x', expected: edit({ x: -2 }) },
    { operation: 'align-center-y', expected: edit({ y: 71 }) }
  ] as const)('单个图层可相对画布居中：$operation', ({ operation, expected }) => {
    state().selectLayer('1')
    const untouched = [state().layers[0], state().layers[2]]

    expect(state().arrangeLayers(operation, 'canvas')).toMatchObject({ changed: true })
    expect(transforms()).toEqual([edit(), expected, edit()])
    expect(state().layers[0]).toBe(untouched[0])
    expect(state().layers[2]).toBe(untouched[1])
    expect(state().selectedLayerIds).toEqual(['1'])
    expect(state().history.past).toHaveLength(1)
    expect(state().history.past[0].label).toContain('1 个图层（画布）')
    state().undo()
    expect(transforms()).toEqual([edit(), edit(), edit()])
  })

  it.each([
    { ids: [] },
    { ids: ['0'] },
    { ids: ['0', '1'] }
  ])('图层不足三个时拒绝分布：$ids', ({ ids }) => {
    state().selectLayers(ids)
    const before = state()

    for (const operation of ['distribute-x', 'distribute-y'] as const) {
      expect('error' in state().arrangeLayers(operation, 'selection')).toBe(true)
      expect(state().layers).toBe(before.layers)
      expect(state().history).toBe(before.history)
      expect(state().isDirty).toBe(false)
    }
  })

  it('排版前暂停播放，保留用户当前帧', () => {
    state().setPlaying(true)
    state().arrangeLayers('align-left', 'selection')

    expect(state().playback.isPlaying).toBe(false)
    expect(state().playback.currentFrame).toBe(6)
    expect(transforms()).toEqual([edit(), edit({ x: -166 }), edit({ x: -298 })])
    expect(state().history.past).toHaveLength(1)
  })

  it('暂停回调同步实际播放帧后，用最新帧计算排版而非暂停前的旧帧', () => {
    state().setPlaying(true)
    const unsubscribe = useEditorStore.subscribe(
      store => store.playback.isPlaying,
      isPlaying => { if (!isPlaying) state().setCurrentFrame(9) }
    )
    try {
      state().arrangeLayers('align-left', 'selection')
      expect(state().playback.isPlaying).toBe(false)
      expect(state().playback.currentFrame).toBe(9)
      expect(transforms()).toEqual([edit(), edit({ x: -169 }), edit({ x: -292 })])
      expect(state().history.past).toHaveLength(1)
    } finally {
      unsubscribe()
    }
  })

  it('拖动期间排版先提交拖动，再单独记录排版，两次撤销可依次恢复', () => {
    const sourceSprites = structuredClone(state().videoItem!.movie.sprites)
    const dragged = { '0': edit({ x: 10, y: 15 }), '1': edit({ x: 10, y: 15 }), '2': edit({ x: 10, y: 15 }) }
    expect(state().beginCanvasTransforms(['2', '0', '1'])).toBe(true)
    state().previewCanvasTransforms(dragged)
    expect(state().history.past).toHaveLength(0)

    expect(state().arrangeLayers('align-left', 'selection')).toMatchObject({ changed: true })
    const arranged = [edit({ x: 10, y: 15 }), edit({ x: -156, y: 15 }), edit({ x: -288, y: 15 })]
    expect(transforms()).toEqual(arranged)
    expect(state().isCanvasTransforming).toBe(false)
    expect(state().history.past.map(entry => entry.label)).toEqual(['整体变换：3 个图层', '左对齐：3 个图层（选区）'])

    // 松手产生的旧拖动事件不得撤回已完成的排版。
    const committed = state().layers
    state().previewCanvasTransforms({ '0': edit({ x: 999 }), '1': edit({ x: 999 }), '2': edit({ x: 999 }) })
    state().endCanvasTransform(false)
    expect(state().layers).toBe(committed)
    state().undo()
    expect(transforms()).toEqual([dragged['0'], dragged['1'], dragged['2']])
    expect(state().history.past).toHaveLength(1)
    state().undo()
    expect(transforms()).toEqual([edit(), edit(), edit()])
    expect(state().history.past).toHaveLength(0)
    state().redo()
    expect(transforms()).toEqual([dragged['0'], dragged['1'], dragged['2']])
    state().redo()
    expect(transforms()).toEqual(arranged)
    expect(state().selectedLayerIds).toEqual(['2', '0', '1'])
    expect(state().selectedLayerId).toBe('1')
    expect(state().playback.currentFrame).toBe(6)
    expect(state().videoItem!.movie.sprites).toEqual(sourceSprites)
    expect(state().layers.map(layer => layer.sprites)).toEqual(sourceSprites)
  })
})
