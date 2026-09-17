import { describe, expect, it } from 'vitest'
import { getSelectedLayerIds, selectionForLayers } from './layer-selection'

const layers = [{ id: '0' }, { id: '1' }, { id: '2' }]

describe('图层选区归一化', () => {
  it('多选去重、剔除已删除图层，并保留用户选择顺序', () => {
    expect(getSelectedLayerIds({ layers, selectedLayerId: '0', selectedLayerIds: ['2', 'missing', '0', '2'] }))
      .toEqual(['2', '0'])
  })

  it('旧调用仅写入主选中时恢复单选，不继承上次多选', () => {
    expect(getSelectedLayerIds({ layers, selectedLayerId: '1', selectedLayerIds: [] })).toEqual(['1'])
    expect(getSelectedLayerIds({ layers, selectedLayerId: '1', selectedLayerIds: ['0', '2'] })).toEqual(['1'])
  })

  it('主选中清空或已删除时不产生幽灵选择', () => {
    expect(getSelectedLayerIds({ layers, selectedLayerId: null, selectedLayerIds: ['0', '1'] })).toEqual([])
    expect(getSelectedLayerIds({ layers, selectedLayerId: 'missing', selectedLayerIds: [] })).toEqual([])
    expect(getSelectedLayerIds({ layers: [], selectedLayerId: '0', selectedLayerIds: ['0'] })).toEqual([])
  })

  it('最后一个有效选中项成为主图层，空集合清除主选中', () => {
    expect(selectionForLayers(['2', 'missing', '0', '2', '1'], layers))
      .toEqual({ selectedLayerIds: ['2', '0', '1'], selectedLayerId: '1' })
    expect(selectionForLayers(['missing'], layers)).toEqual({ selectedLayerIds: [], selectedLayerId: null })
    expect(selectionForLayers([], layers)).toEqual({ selectedLayerIds: [], selectedLayerId: null })
  })

  it('选择读取与归一化均不修改输入数组', () => {
    const ids = Object.freeze(['2', '0', '2'])
    const sourceLayers = Object.freeze(layers.map(layer => Object.freeze({ ...layer })))
    expect(getSelectedLayerIds({ layers: sourceLayers, selectedLayerId: '0', selectedLayerIds: ids })).toEqual(['2', '0'])
    expect(selectionForLayers(ids, sourceLayers)).toEqual({ selectedLayerIds: ['2', '0'], selectedLayerId: '0' })
    expect(ids).toEqual(['2', '0', '2'])
    expect(sourceLayers).toEqual(layers)
  })
})
