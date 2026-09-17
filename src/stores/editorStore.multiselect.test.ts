import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeCanvasTransform } from '@/core/layer-transform'
import { getSelectedLayerIds } from '@/utils/layer-selection'
import type { CanvasTransform, VideoItem } from '@/types'
import { useEditorStore } from './editorStore'

const createVideo = (prefix = 'source'): VideoItem => ({
  movie: {
    version: '2.0',
    params: { viewBoxWidth: 400, viewBoxHeight: 300, fps: 24, frames: 24 },
    images: {},
    sprites: ['avatar', 'name', 'background'].map((name, layerIndex) => ({
      imageKey: `${prefix}-${name}`,
      matteKey: null,
      frames: Array.from({ length: 24 }, (_, frameIndex) => ({
        alpha: 1,
        layout: { x: 0, y: 0, width: 80, height: 60 },
        transform: { a: 1, b: 0, c: 0, d: 1, tx: layerIndex * 100 + frameIndex * 3, ty: frameIndex * 2 },
        clipPath: null
      }))
    }))
  },
  images: {},
  buffers: {}
})

const state = () => useEditorStore.getState()
const edit = (transform: Partial<CanvasTransform> = {}): CanvasTransform => normalizeCanvasTransform(transform)
const preview = (x: number) => ({ '0': edit({ x, scaleX: 1.5, scaleY: 1.5 }), '1': edit({ x: x + 10, rotation: 0.3 }) })

beforeEach(() => {
  state().reset()
  state().setVideoItem(createVideo())
  state().setOriginalBuffer(new ArrayBuffer(16))
})

describe('多图层选择状态', () => {
  it('选择去重并过滤无效 ID，以最后一个有效选择作为主图层', () => {
    state().selectLayers(['1', 'missing', '0', '1'])
    expect(state().selectedLayerIds).toEqual(['1', '0'])
    expect(state().selectedLayerId).toBe('0')
    state().selectLayers(['missing'])
    expect(state().selectedLayerIds).toEqual([])
    expect(state().selectedLayerId).toBeNull()
  })

  it('追加选择切换成员，移除主图层后回退到最近选中的剩余成员', () => {
    state().selectLayer('0')
    state().selectLayer('1', true)
    state().selectLayer('2', true)
    expect(state().selectedLayerIds).toEqual(['0', '1', '2'])
    expect(state().selectedLayerId).toBe('2')
    state().selectLayer('1', true)
    expect(state().selectedLayerIds).toEqual(['0', '2'])
    expect(state().selectedLayerId).toBe('2')
    state().selectLayer('2', true)
    expect(state().selectedLayerIds).toEqual(['0'])
    expect(state().selectedLayerId).toBe('0')
    state().selectLayer('0', true)
    expect(state().selectedLayerIds).toEqual([])
    expect(state().selectedLayerId).toBeNull()
  })

  it('默认单选与清空选择兼容旧调用，并清除全部多选高亮', () => {
    state().selectLayers(['0', '1'])
    state().selectLayer('2')
    expect(state().selectedLayerId).toBe('2')
    expect(state().selectedLayerIds).toEqual(['2'])
    state().selectLayers(['0', '1'])
    state().selectLayer(null)
    expect(state().selectedLayerId).toBeNull()
    expect(state().selectedLayerIds).toEqual([])
  })

  it('纯选择切换不修改文档、dirty、撤销或重做栈', () => {
    state().updateLayer('2', { opacity: 0.5 })
    state().undo()
    const before = state()
    state().selectLayers(['0', '1'])
    state().selectLayer('2', true)
    state().selectLayer('1', true)
    state().selectLayer(null)
    expect(state().layers).toBe(before.layers)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(before.isDirty)
    expect(state().canUndo).toBe(before.canUndo)
    expect(state().canRedo).toBe(true)
  })

  it('兼容旧代码只覆盖 selectedLayerId 后的追加操作', () => {
    state().selectLayers(['0', '1'])
    useEditorStore.setState({ selectedLayerId: '2' })
    expect(getSelectedLayerIds(state())).toEqual(['2'])
    state().selectLayer('0', true)
    expect(state().selectedLayerIds).toEqual(['2', '0'])
    expect(state().selectedLayerId).toBe('0')
  })

  it('删除主图层保留其他选择，撤销恢复完整选区与主图层', () => {
    state().selectLayers(['0', '1'])
    state().deleteLayer('1')
    expect(state().layers.map(layer => layer.id)).toEqual(['0', '2'])
    expect(state().selectedLayerIds).toEqual(['0'])
    expect(state().selectedLayerId).toBe('0')
    state().undo()
    expect(state().layers.map(layer => layer.id)).toEqual(['0', '1', '2'])
    expect(state().selectedLayerIds).toEqual(['0', '1'])
    expect(state().selectedLayerId).toBe('1')
    state().redo()
    expect(state().selectedLayerIds).toEqual(['0'])
    expect(state().selectedLayerId).toBe('0')
  })

  it('删除未选中图层不会清除当前多选', () => {
    state().selectLayers(['0', '1'])
    state().deleteLayer('2')
    expect(state().selectedLayerIds).toEqual(['0', '1'])
    expect(state().selectedLayerId).toBe('1')
  })

  it('新增图层切到新图层单选，撤销与重做分别恢复对应选区', () => {
    state().selectLayers(['0', '1'])
    const { id: _sourceId, ...newLayer } = state().layers[0]
    const id = state().addLayer({ ...newLayer, name: '新增头像' })
    expect(state().selectedLayerIds).toEqual([id])
    expect(state().selectedLayerId).toBe(id)
    state().undo()
    expect(state().selectedLayerIds).toEqual(['0', '1'])
    expect(state().selectedLayerId).toBe('1')
    expect(state().layers).toHaveLength(3)
    state().redo()
    expect(state().selectedLayerIds).toEqual([id])
    expect(state().selectedLayerId).toBe(id)
    expect(state().layers).toHaveLength(4)
  })

  it('复制只创建该行副本，撤销后恢复此前多选', () => {
    state().selectLayers(['0', '1'])
    const id = state().duplicateLayer('0')
    expect(id).not.toBeNull()
    expect(state().layers).toHaveLength(4)
    expect(state().selectedLayerIds).toEqual([id])
    state().undo()
    expect(state().layers).toHaveLength(3)
    expect(state().selectedLayerIds).toEqual(['0', '1'])
    expect(state().selectedLayerId).toBe('1')
  })

  it('整体更新图层集合时剔除失效选择而不遗留不存在的主图层', () => {
    state().selectLayers(['0', '1'])
    state().setLayers(state().layers.filter(layer => layer.id !== '1'))
    expect(state().selectedLayerIds).toEqual(['0'])
    expect(state().selectedLayerId).toBe('0')
    state().undo()
    expect(state().selectedLayerIds).toEqual(['0', '1'])
    expect(state().selectedLayerId).toBe('1')
  })
})

describe('多图层画布变换事务', () => {
  beforeEach(() => {
    state().selectLayers(['0', '1'])
  })

  it('多次预览只在结束时写一条历史，并且不修改原动画或未参与图层', () => {
    const original = state().layers
    const sourceSprites = structuredClone(original.map(layer => layer.sprites))
    expect(state().beginCanvasTransforms(['0', '1', '0'])).toBe(true)
    for (let x = 1; x <= 20; x++) {
      state().previewCanvasTransforms(preview(x))
      expect(state().history.past).toHaveLength(0)
      expect(state().layers[2]).toBe(original[2])
    }
    expect(state().layers[0].canvasTransform).toEqual(preview(20)['0'])
    expect(state().layers[1].canvasTransform).toEqual(preview(20)['1'])
    expect(state().isCanvasTransforming).toBe(true)
    state().endCanvasTransform(true)
    expect(state().history.past).toHaveLength(1)
    expect(state().history.past[0].label).toBe('整体变换：2 个图层')
    expect(state().isCanvasTransforming).toBe(false)
    expect(state().isDirty).toBe(true)
    expect(state().layers.map(layer => layer.sprites)).toEqual(sourceSprites)
    expect(state().layers[2]).toBe(original[2])
    state().undo()
    expect(state().layers.map(layer => edit(layer.canvasTransform))).toEqual([edit(), edit(), edit()])
    expect(state().selectedLayerIds).toEqual(['0', '1'])
    state().redo()
    expect(state().layers.map(layer => edit(layer.canvasTransform))).toEqual([preview(20)['0'], preview(20)['1'], edit()])
    expect(state().layers.map(layer => layer.sprites)).toEqual(sourceSprites)
  })

  it('取消恢复同一个图层数组、dirty 和历史，保留已有重做记录', () => {
    state().updateLayer('2', { opacity: 0.4 })
    state().undo()
    const before = state()
    state().beginCanvasTransforms(['0', '1'])
    state().previewCanvasTransforms(preview(30))
    state().endCanvasTransform(false)
    expect(state().layers).toBe(before.layers)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(before.isDirty)
    expect(state().canRedo).toBe(true)
    expect(state().selectedLayerIds).toEqual(['0', '1'])
    expect(state().isCanvasTransforming).toBe(false)
  })

  it('没有实际位移或所有图层拖回原值时不产生历史', () => {
    const original = state().layers
    state().beginCanvasTransforms(['0', '1'])
    state().endCanvasTransform(true)
    state().beginCanvasTransforms(['0', '1'])
    state().previewCanvasTransforms(preview(10))
    state().previewCanvasTransforms({ '0': edit(), '1': edit() })
    state().endCanvasTransform(true)
    expect(state().layers).toBe(original)
    expect(state().history.past).toHaveLength(0)
    expect(state().isDirty).toBe(false)
  })

  it.each([{ ids: [] }, { ids: ['0', 'missing'] }])('空选区或不存在的成员拒绝整个事务：$ids', ({ ids }) => {
    const before = state()
    expect(state().beginCanvasTransforms(ids)).toBe(false)
    state().previewCanvasTransforms(preview(99))
    state().endCanvasTransform(true)
    expect(state().layers).toBe(before.layers)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(false)
    expect(state().isCanvasTransforming).toBe(false)
  })

  it.each([{ locked: true }, { visible: false }])('任意成员受保护时整个选区拒绝开始，不只移动可编辑部分：%o', updates => {
    useEditorStore.setState({ layers: state().layers.map(layer => layer.id === '1' ? { ...layer, ...updates } : layer) })
    const original = state().layers
    expect(state().beginCanvasTransforms(['0', '1'])).toBe(false)
    state().previewCanvasTransforms(preview(99))
    state().endCanvasTransform(true)
    expect(state().layers).toBe(original)
    expect(state().history.past).toHaveLength(0)
    expect(state().isDirty).toBe(false)
  })

  it.each([
    { title: '缺少一个成员', values: { '0': edit({ x: 200 }) } },
    { title: '附带未参与图层', values: { ...preview(200), '2': edit({ x: 200 }) } },
    { title: '数量相同但成员错误', values: { '0': edit({ x: 200 }), missing: edit({ x: 200 }) } }
  ])('预览$标题时拒绝整个更新，并准确撤回本次拖动', ({ values }) => {
    const before = state()
    state().beginCanvasTransforms(['0', '1'])
    state().previewCanvasTransforms(preview(10))
    state().previewCanvasTransforms(values as Record<string, CanvasTransform>)
    state().endCanvasTransform(true)
    expect(state().layers).toBe(before.layers)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(before.isDirty)
    expect(state().isCanvasTransforming).toBe(false)
  })

  it.each([true, false])('切换文件后旧预览与结束事件不污染拥有相同图层 ID 的新文件：commit=%s', commit => {
    state().beginCanvasTransforms(['0', '1'])
    state().previewCanvasTransforms(preview(10))
    const nextVideo = createVideo('next')
    state().setVideoItem(nextVideo)
    state().selectLayers(['0', '1'])
    const nextLayers = state().layers
    state().previewCanvasTransforms(preview(999))
    state().endCanvasTransform(commit)
    expect(state().videoItem).toBe(nextVideo)
    expect(state().layers).toBe(nextLayers)
    expect(state().layers.map(layer => layer.imageKey)).toEqual(['next-avatar', 'next-name', 'next-background'])
    expect(state().layers.every(layer => layer.canvasTransform === undefined)).toBe(true)
    expect(state().history.past).toHaveLength(0)
    expect(state().isDirty).toBe(false)
    expect(state().isCanvasTransforming).toBe(false)
  })

  it('更换源文件清空整个选区，reset 后过期预览不能恢复旧图层', () => {
    state().setVideoItem(createVideo('next'))
    expect(state().selectedLayerId).toBeNull()
    expect(state().selectedLayerIds).toEqual([])
    state().selectLayers(['0', '1'])
    state().beginCanvasTransforms(['0', '1'])
    state().previewCanvasTransforms(preview(10))
    state().reset()
    state().previewCanvasTransforms(preview(999))
    state().endCanvasTransform(true)
    expect(state().layers).toEqual([])
    expect(state().selectedLayerIds).toEqual([])
    expect(state().selectedLayerId).toBeNull()
    expect(state().history.past).toHaveLength(0)
    expect(state().isDirty).toBe(false)
  })

  it('拖动时撤销只取消本次多图层拖动，不撤销上一条操作', () => {
    state().updateLayer('2', { opacity: 0.7 })
    const before = state()
    state().beginCanvasTransforms(['0', '1'])
    state().previewCanvasTransforms(preview(80))
    state().undo()
    state().endCanvasTransform(true)
    expect(state().layers).toBe(before.layers)
    expect(state().layers[2].opacity).toBe(0.7)
    expect(state().history).toBe(before.history)
    expect(state().isCanvasTransforming).toBe(false)
  })

  it('切换选区先提交本次整体变换，过期预览不会改动新选区', () => {
    state().beginCanvasTransforms(['0', '1'])
    state().previewCanvasTransforms(preview(10))
    state().selectLayer('2')
    const committed = state().layers
    state().previewCanvasTransforms(preview(99))
    state().endCanvasTransform(false)
    expect(state().layers).toBe(committed)
    expect(state().selectedLayerIds).toEqual(['2'])
    expect(state().history.past).toHaveLength(1)
    state().undo()
    expect(state().selectedLayerIds).toEqual(['0', '1'])
    expect(state().layers.map(layer => edit(layer.canvasTransform))).toEqual([edit(), edit(), edit()])
  })

  it('旧的单图层事务 API 仍只影响指定图层，并保存多选快照', () => {
    const original = state().layers
    expect(state().beginCanvasTransform('0')).toBe(true)
    state().previewCanvasTransform('0', edit({ x: 20 }))
    state().endCanvasTransform(true)
    expect(state().layers[0].canvasTransform).toEqual(edit({ x: 20 }))
    expect(state().layers[1]).toBe(original[1])
    expect(state().layers[2]).toBe(original[2])
    expect(state().history.past).toHaveLength(1)
    expect(state().history.past[0].label).toBe('画布变换：source-avatar')
    state().undo()
    expect(state().selectedLayerIds).toEqual(['0', '1'])
    expect(state().selectedLayerId).toBe('1')
  })
})
