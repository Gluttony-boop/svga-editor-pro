import { describe, expect, it } from 'vitest'
import { selectLayerInList } from './layer-selection'

describe('列表范围与增减选择', () => {
  const order = ['a', 'b', 'c', 'd']
  it('Shift 连续选择，锚点不随终点变化', () => {
    const result = selectLayerInList(order, ['a'], 'c', 'a', true, false)
    expect(result).toEqual({ ids: ['a', 'b', 'c'], anchor: 'a' })
    expect(selectLayerInList(order, result.ids, 'b', result.anchor, true, false).ids).toEqual(['a', 'b'])
  })
  it('反向范围以点击项为主选中，Ctrl+Shift 保留其他选区', () => {
    expect(selectLayerInList(order, ['d'], 'b', 'd', true, false)).toEqual({ ids: ['c', 'd', 'b'], anchor: 'd' })
    expect(selectLayerInList(order, ['a', 'd'], 'c', 'd', true, true).ids).toEqual(['a', 'd', 'c'])
  })
  it('Ctrl/⌘ 增减，不复制或修改列表', () => {
    expect(selectLayerInList(order, ['a'], 'c', 'a', false, true).ids).toEqual(['a', 'c'])
    expect(selectLayerInList(order, ['a', 'c'], 'a', 'a', false, true).ids).toEqual(['c'])
    expect(order).toEqual(['a', 'b', 'c', 'd'])
  })
  it('筛选后不加入不可见图层，锚点失效时退为单选', () => {
    expect(selectLayerInList(['a', 'c'], ['a'], 'c', 'a', true, false).ids).toEqual(['a', 'c'])
    expect(selectLayerInList(['b', 'c'], ['a'], 'c', 'a', true, false).ids).toEqual(['c'])
  })
  it('单选替换选区，无效目标不动原选区', () => {
    expect(selectLayerInList(order, ['a', 'b'], 'c', 'a', false, false).ids).toEqual(['c'])
    expect(selectLayerInList(order, ['a'], 'missing', 'a', true, true)).toEqual({ ids: ['a'], anchor: 'a' })
  })
})
