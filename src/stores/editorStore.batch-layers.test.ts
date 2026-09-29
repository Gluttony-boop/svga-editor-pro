import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { useEditorStore } from './editorStore'
import { captureExportInputs } from '@/core/export-preview'
import { requiresSvgaMerge } from '@/core/project-export'

const state = () => useEditorStore.getState()
beforeEach(() => {
  state().reset()
  state().setVideoItem({ movie: { version: '2.0', params: { viewBoxWidth: 200, viewBoxHeight: 100, frames: 1, fps: 24 },
    images: {}, sprites: ['a', 'b', 'c'].map(imageKey => ({ imageKey, matteKey: null, frames: [{ alpha: 1, clipPath: null,
      layout: { x: 0, y: 0, width: 100, height: 40 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } }] })) }, images: {}, buffers: {} })
  state().setOriginalBuffer(new ArrayBuffer(16))
  state().initializeHistory()
  state().selectLayers(['0', '2'])
})
afterEach(() => state().reset())

describe('图层批量操作', () => {
  it('删除多层只记一次历史，保留资源与原始数据，走合并导出路径', () => {
    const before = state()
    expect(state().operateLayers(['0', '2', '0'], 'delete')).toEqual({ changed: true })
    expect(state().layers.map(layer => layer.id)).toEqual(['1'])
    expect(state().history.past).toHaveLength(1)
    expect(state().selectedLayerIds).toEqual([])
    expect(state().videoItem).toBe(before.videoItem)
    expect(state().imageResources).toBe(before.imageResources)
    expect(state().originalBuffer).toBe(before.originalBuffer)
    expect(requiresSvgaMerge(state().captureProjectDocument())).toBe(true)
    state().undo()
    expect(state().layers.map(layer => layer.id)).toEqual(['0', '1', '2'])
    expect(state().selectedLayerIds).toEqual(['0', '2'])
    state().redo()
    expect(state().layers.map(layer => layer.id)).toEqual(['1'])
  })
  it.each(['hide', 'show', 'lock', 'unlock'] as const)('%s 整组一次提交和撤销，无关图层不变', operation => {
    const field = operation === 'lock' || operation === 'unlock' ? 'locked' : 'visible'
    const value = operation === 'lock' || operation === 'show'
    useEditorStore.setState({ layers: state().layers.map(layer => ({ ...layer, [field]: !value })) })
    const before = state()
    expect(state().operateLayers(['0', '2'], operation).changed).toBe(true)
    expect(state().layers[0][field]).toBe(value)
    expect(state().layers[2][field]).toBe(value)
    expect(state().layers[1]).toBe(before.layers[1])
    expect(state().selectedLayerIds).toEqual(['0', '2'])
    expect(state().history.past).toHaveLength(1)
    state().undo()
    expect(state().layers[0][field]).toBe(!value)
  })
  it('无实际变化不清空重做、不产生历史或 dirty', () => {
    state().operateLayers(['0', '2'], 'hide')
    state().undo()
    const before = state()
    expect(state().operateLayers(['0', '2'], 'show')).toEqual({ changed: false })
    expect(state()).toBe(before)
  })
  it('含锁定层时只拒绝删除，显示状态和锁定状态仍可批量管理', () => {
    state().updateLayer('2', { locked: true })
    const before = state()
    expect(state().operateLayers(['0', '2'], 'delete').error).toContain('锁定')
    expect(state().layers).toBe(before.layers)
    expect(state().operateLayers(['0', '2'], 'hide').changed).toBe(true)
    expect(state().operateLayers(['0', '2'], 'show').changed).toBe(true)
    expect(state().operateLayers(['0', '2'], 'unlock').changed).toBe(true)
  })
  it('删除确认期间工程变化后拒绝旧目标，包括同 ID 新工程', () => {
    const expected = captureExportInputs(state())
    state().updateLayer('1', { opacity: 0.5 })
    const before = state()
    expect(state().operateLayers(['0', '2'], 'delete', expected).error).toContain('已变化')
    expect(state()).toBe(before)
    state().setVideoItem(structuredClone(state().videoItem!))
    expect(state().operateLayers(['0', '2'], 'delete', expected).error).toContain('已变化')
    expect(state().layers).toHaveLength(3)
  })
  it('确认后选区变化仍只处理明确指定的 ID', () => {
    const expected = captureExportInputs(state())
    state().selectLayer('1')
    expect(state().operateLayers(['0', '2'], 'delete', expected).changed).toBe(true)
    expect(state().selectedLayerIds).toEqual(['1'])
  })
  it('拒绝空选区、不存在的成员及活动变换', () => {
    const before = state()
    expect(state().operateLayers([], 'delete').error).toBeDefined()
    expect(state().operateLayers(['0', 'missing'], 'hide').error).toBeDefined()
    expect(state()).toBe(before)
    state().beginCanvasTransform('0')
    const editing = state()
    expect(state().operateLayers(['0'], 'delete').error).toContain('先结束')
    expect(state()).toBe(editing)
  })
  it('可以删除全部图层，撤销恢复完整列表', () => {
    expect(state().operateLayers(['0', '1', '2'], 'delete').changed).toBe(true)
    expect(state().layers).toEqual([])
    expect(state().selectedLayerId).toBeNull()
    state().undo()
    expect(state().layers).toHaveLength(3)
  })
  it('遮罩被剩余图层使用时阻止删除，连同依赖图层选择才允许', () => {
    useEditorStore.setState({ layers: state().layers.map(layer => layer.id === '1'
      ? { ...layer, sprites: { ...layer.sprites!, matteKey: 'a' } } : layer) })
    const before = state()
    expect(state().operateLayers(['0'], 'delete').error).toContain('遮罩')
    expect(state()).toBe(before)
    expect(state().operateLayers(['0', '1'], 'delete').changed).toBe(true)
  })
})
