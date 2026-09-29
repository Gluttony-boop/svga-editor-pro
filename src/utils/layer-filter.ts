import type { Layer } from '@/types'

export type LayerFilter = 'all' | 'visible' | 'hidden' | 'locked' | 'unlocked'

type SearchableLayer = Pick<Layer, 'name' | 'imageKey' | 'visible' | 'locked' | 'group'>

/** 保留源索引，搜索编组不会重排图层编号或改变编辑目标。 */
export function filterLayers<T extends SearchableLayer>(
  layers: readonly T[],
  query: string,
  filter: LayerFilter
): { layer: T; index: number }[] {
  const keyword = query.trim().toLocaleLowerCase()
  return layers.flatMap((layer, index) => {
    const matchesName = !keyword || [layer.name, layer.imageKey ?? '', layer.group?.name ?? '']
      .some((value) => value.toLocaleLowerCase().includes(keyword))
    const matchesStatus = filter === 'all'
      || (filter === 'visible' && layer.visible)
      || (filter === 'hidden' && !layer.visible)
      || (filter === 'locked' && layer.locked)
      || (filter === 'unlocked' && !layer.locked)
    return matchesName && matchesStatus ? [{ layer, index }] : []
  })
}
