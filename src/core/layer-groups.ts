import type { Layer } from '@/types'

export const MAX_GROUP_NAME_LENGTH = 80

export function getGroupNameError(name: string): string | undefined {
  if (typeof name !== 'string' || !name.trim()) return '请输入编组名称。'
  if (name.trim().length > MAX_GROUP_NAME_LENGTH) return `编组名称最多 ${MAX_GROUP_NAME_LENGTH} 个字符。`
  if (Array.from(name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return '编组名称不能包含控制字符。'
}

export function listLayerGroups(layers: readonly Layer[]) {
  const groups = new Map<string, { id: string; name: string; layerIds: string[] }>()
  for (const layer of layers) {
    if (!layer.group) continue
    const group = groups.get(layer.group.id) ?? { ...layer.group, layerIds: [] }
    group.layerIds.push(layer.id)
    groups.set(group.id, group)
  }
  return [...groups.values()]
}

export type LayerGroupingAction =
  | { type: 'create'; ids: readonly string[]; name: string }
  | { type: 'rename'; groupId: string; name: string }
  | { type: 'dissolve'; groupId: string }

/** 不重排成员、不生成新图层；整组校验通过后才一次性替换元数据。 */
export function planLayerGrouping(layers: Layer[], action: LayerGroupingAction, makeId: () => string): {
  layers: Layer[]; groupId?: string; error?: string
} {
  const fail = (error: string) => ({ layers, error })
  const groups = listLayerGroups(layers)
  const targetGroup = action.type === 'create' ? undefined : groups.find(group => group.id === action.groupId)
  if (action.type !== 'create' && !targetGroup) return fail('编组已不存在，请重新选择。')
  const selected = new Set(action.type === 'create' ? action.ids : targetGroup!.layerIds)
  if (action.type === 'create' && selected.size < 2) return fail('请先选择至少两个图层再编组。')
  if ([...selected].some(id => !layers.some(layer => layer.id === id))) return fail('部分所选图层已不存在，请重新选择。')
  if (layers.some(layer => selected.has(layer.id) && layer.locked)) return fail('包含锁定图层，请先解锁；本次未修改编组。')
  if (action.type === 'dissolve') return { layers: layers.map(layer => {
    if (!selected.has(layer.id)) return layer
    const { group: _group, ...rest } = layer
    return rest
  }), groupId: action.groupId }
  const error = getGroupNameError(action.name)
  if (error) return fail(error)
  const name = action.name.trim()
  if (groups.some(group => group.name === name && group.id !== targetGroup?.id)) return fail('已有同名编组，请使用不同名称。')
  if (targetGroup?.name === name) return { layers, groupId: targetGroup.id }
  const id = targetGroup?.id ?? makeId()
  return { layers: layers.map(layer => selected.has(layer.id) ? { ...layer, group: { id, name } } : layer), groupId: id }
}
