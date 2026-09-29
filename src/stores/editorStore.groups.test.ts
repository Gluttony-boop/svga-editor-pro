import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import pako from 'pako'
import protobuf from 'protobufjs'
import proto from '@/core/svga-proto'
import { useEditorStore } from './editorStore'
import { captureExportInputs } from '@/core/export-preview'
import { getGroupNameError, listLayerGroups, planLayerGrouping } from '@/core/layer-groups'
import { createProjectArchive, readProjectArchive } from '@/core/project-archive'
import { requiresSvgaMerge } from '@/core/project-export'
import { filterLayers } from '@/utils/layer-filter'

const state = () => useEditorStore.getState()
const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=', 'base64'))
beforeEach(() => {
  state().reset()
  const movie = { version: '2.0', params: { viewBoxWidth: 200, viewBoxHeight: 100, frames: 2, fps: 24 }, images: { a: png },
    sprites: Array.from({ length: 3 }, (_, index) => ({ imageKey: 'a', matteKey: null, frames: Array.from({ length: 2 }, () => ({ alpha: 1, clipPath: null,
      layout: { x: 0, y: 0, width: 20, height: 20 }, transform: { a: 1, b: 0, c: 0, d: 1, tx: index * 20, ty: 0 } })) })) }
  state().setVideoItem({ movie, images: {}, buffers: { a: png.slice().buffer } })
  state().setOriginalBuffer(new Uint8Array(pako.deflate(Movie.encode(Movie.fromObject(movie)).finish())).buffer)
  state().initializeHistory()
  state().selectLayers(['0', '2'])
})
afterEach(() => state().reset())

const create = () => state().groupLayers({ type: 'create', ids: ['0', '2'], name: '  头像组件  ' })

describe('永久命名编组', () => {
  it('不创建/重排图层，不改Key/动画/原始sprite，一次撤销重做', () => {
    const before = state()
    expect(create().changed).toBe(true)
    const grouped = state()
    expect(grouped.layers.map(layer => layer.id)).toEqual(['0', '1', '2'])
    expect(grouped.layers[1]).toBe(before.layers[1])
    expect(grouped.layers[0].sprites).toBe(before.layers[0].sprites)
    expect(grouped.layers[0].tracks).toBe(before.layers[0].tracks)
    expect(grouped.layers[0].imageKey).toBe('a')
    expect(grouped.layers[0].isNew).toBeUndefined()
    expect(grouped.layers[0].group).toEqual(grouped.layers[2].group)
    expect(grouped.layers[0].group?.name).toBe('头像组件')
    expect(grouped.history.past).toHaveLength(1)
    expect(requiresSvgaMerge(state().captureProjectDocument())).toBe(false)
    state().undo()
    expect(state().layers.every(layer => !layer.group)).toBe(true)
    state().redo()
    expect(state().layers[0].group).toEqual(grouped.layers[0].group)
  })
  it('组名搜索保留源索引，选整组不记录历史或增加图层', () => {
    create()
    const group = listLayerGroups(state().layers)[0]
    expect(group.layerIds).toEqual(['0', '2'])
    expect(filterLayers(state().layers, '头像组件', 'all').map(item => item.index)).toEqual([0, 2])
    state().selectLayer('1')
    const history = state().history
    state().selectLayers(group.layerIds)
    expect(state().selectedLayerIds).toEqual(['0', '2'])
    expect(state().layers).toHaveLength(3)
    expect(state().history).toBe(history)
  })
  it('改名与解散作用整组，解散不删除成员', () => {
    const groupId = create().groupId!
    expect(state().groupLayers({ type: 'rename', groupId, name: '信息卡' }).changed).toBe(true)
    expect(state().layers.filter(layer => layer.group?.name === '信息卡')).toHaveLength(2)
    const before = state()
    expect(state().groupLayers({ type: 'rename', groupId, name: '信息卡' }).changed).toBe(false)
    expect(state()).toBe(before)
    expect(state().groupLayers({ type: 'dissolve', groupId }).changed).toBe(true)
    expect(state().layers).toHaveLength(3)
    expect(listLayerGroups(state().layers)).toEqual([])
    state().undo()
    expect(listLayerGroups(state().layers)[0].name).toBe('信息卡')
  })
  it('拒绝无效选区/同名组/锁定成员/不存在的组，失败不改历史', () => {
    const groupId = create().groupId!
    const before = state()
    for (const action of [
      { type: 'create', ids: ['0'], name: '一个' },
      { type: 'create', ids: ['0', 'missing'], name: '失效' },
      { type: 'create', ids: ['1', '2'], name: '头像组件' },
      { type: 'dissolve', groupId: 'missing' },
    ] as const) expect(state().groupLayers(action).error).toBeDefined()
    expect(state()).toBe(before)
    state().updateLayer('2', { locked: true })
    const locked = state()
    expect(state().groupLayers({ type: 'rename', groupId, name: '换名' }).error).toContain('锁定')
    expect(state().groupLayers({ type: 'dissolve', groupId }).error).toContain('锁定')
    expect(state()).toBe(locked)
  })
  it('移动所选到新组允许旧组剩一个成员，不改变未选成员', () => {
    create()
    const before = state().layers[0]
    state().groupLayers({ type: 'create', ids: ['1', '2'], name: '其他组' })
    expect(state().layers[0]).toBe(before)
    expect(listLayerGroups(state().layers).map(group => group.layerIds)).toEqual([['0'], ['1', '2']])
  })
  it('拒绝过期确认以及进行中的编辑，不擅自提交草稿', () => {
    const expected = captureExportInputs(state())
    state().updateLayer('1', { opacity: 0.5 })
    const before = state()
    expect(state().groupLayers({ type: 'create', ids: ['0', '2'], name: '过期' }, expected).error).toContain('已变化')
    expect(state()).toBe(before)
    state().beginCanvasTransform('0')
    const editing = state()
    expect(create().error).toContain('先结束')
    expect(state()).toBe(editing)
  })
  it.each(['', ' ', '\n分组', 'a'.repeat(81)])('拒绝非法组名 %j', name => {
    expect(getGroupNameError(name)).toBeDefined()
    const layers = state().layers
    expect(planLayerGrouping(layers, { type: 'create', ids: ['0', '2'], name }, () => 'g').layers).toBe(layers)
  })
  it('工程归档回读后组名/成员保持，恢复到store还能改名和撤销', async () => {
    const groupId = create().groupId!
    const archive = await createProjectArchive(state().captureProjectDocument())
    const restored = await readProjectArchive(await archive.arrayBuffer())
    expect(restored.layers[0].group).toEqual({ id: groupId, name: '头像组件' })
    state().reset()
    state().restoreProjectDocument(restored, null, '命名编组.svgaproj')
    expect(listLayerGroups(state().layers)[0].layerIds).toEqual(['0', '2'])
    state().groupLayers({ type: 'rename', groupId, name: '恢复后改名' })
    state().undo()
    expect(listLayerGroups(state().layers)[0].name).toBe('头像组件')
  })
  it('工程拒绝同ID不同名称和非法group字段', async () => {
    create()
    const document = state().captureProjectDocument()
    document.layers[2].group = { ...document.layers[2].group!, name: '冲突' }
    await expect(createProjectArchive(document)).rejects.toThrow('同一编组')
    document.layers[2].group.name = document.layers[0].group!.name
    Object.assign(document.layers[0].group!, { parent: 'unsupported' })
    await expect(createProjectArchive(document)).rejects.toThrow('不受支持的字段')
  })
})
