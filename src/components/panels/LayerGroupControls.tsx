import React from 'react'
import { Button, Modal } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { listLayerGroups, MAX_GROUP_NAME_LENGTH, type LayerGroupingAction } from '@/core/layer-groups'
import { captureExportInputs } from '@/core/export-preview'
import { getSelectedLayerIds } from '@/utils/layer-selection'

export function LayerGroupControls() {
  const layers = useEditorStore(state => state.layers)
  const selectedLayerId = useEditorStore(state => state.selectedLayerId)
  const selectedLayerIds = useEditorStore(state => state.selectedLayerIds)
  const groups = React.useMemo(() => listLayerGroups(layers), [layers])
  const selection = getSelectedLayerIds({ layers, selectedLayerId, selectedLayerIds })
  const selectedGroup = groups.find(group => selection.length > 0 && selection.every(id => group.layerIds.includes(id)))
  const [pending, setPending] = React.useState<{ action: LayerGroupingAction; inputs: readonly unknown[] } | null>(null)
  const [name, setName] = React.useState('')
  const [error, setError] = React.useState('')
  const open = (action: LayerGroupingAction) => {
    setPending({ action, inputs: captureExportInputs(useEditorStore.getState()) })
    setName(action.type === 'dissolve' ? '' : action.name)
    setError('')
  }
  const submit = () => {
    if (!pending) return
    const action = pending.action.type === 'dissolve' ? pending.action : { ...pending.action, name }
    const result = useEditorStore.getState().groupLayers(action, pending.inputs)
    if (result.error) setError(result.error)
    else setPending(null)
  }
  if (!layers.length) return null
  const title = pending?.action.type === 'create' ? '创建命名编组' : pending?.action.type === 'rename' ? '重命名编组' : '解散编组'
  return <>
    <div aria-label="命名编组" className="flex flex-shrink-0 flex-wrap gap-1 border-b border-border/70 px-2 py-1.5">
      <select aria-label="选择命名编组" value={selectedGroup?.id ?? ''}
        className="h-7 min-w-0 flex-1 rounded border border-border bg-bg-primary px-1 text-xs text-text-secondary"
        onChange={event => {
          const group = groups.find(item => item.id === event.target.value)
          if (group) useEditorStore.getState().selectLayers(group.layerIds)
        }}>
        <option value="">{groups.length ? `命名编组 · ${groups.length}` : '尚无命名编组'}</option>
        {groups.map(group => <option key={group.id} value={group.id}>{group.name}（{group.layerIds.length} 层）</option>)}
      </select>
      <select aria-label="命名编组操作" value="" className="h-7 w-24 rounded border border-border bg-bg-primary px-1 text-xs text-text-secondary"
        onChange={event => {
          if (event.target.value === 'create') open({ type: 'create', ids: selection, name: '' })
          if (!selectedGroup) return
          if (event.target.value === 'select') useEditorStore.getState().selectLayers(selectedGroup.layerIds)
          if (event.target.value === 'rename') open({ type: 'rename', groupId: selectedGroup.id, name: selectedGroup.name })
          if (event.target.value === 'dissolve') open({ type: 'dissolve', groupId: selectedGroup.id })
        }}>
        <option value="">编组操作…</option>
        <option value="create" disabled={selection.length < 2}>编组所选（{selection.length}）</option>
        <option value="select" disabled={!selectedGroup}>选择整组</option>
        <option value="rename" disabled={!selectedGroup}>重命名编组</option>
        <option value="dissolve" disabled={!selectedGroup}>解散编组</option>
      </select>
    </div>
    <Modal isOpen={!!pending} isolateKeyboard title={title} onClose={() => setPending(null)}
      footer={<><Button variant="ghost" onClick={() => setPending(null)}>取消</Button><Button variant="primary" onClick={submit}>确认{title}</Button></>}>
      <p className="text-xs leading-relaxed text-text-secondary">
        {pending?.action.type === 'create' ? `将所选 ${pending.action.ids.length} 个图层保存为命名编组；已有编组成员会移入新组。` : pending?.action.type === 'dissolve' ? '移除整组的编组关系，不删除图层。' : '修改此编组全部成员的组名。'}
        {' '}编组不改变图层顺序，不是预合成或父子绑定；可一步撤销，保存工程后可恢复。
      </p>
      {pending?.action.type !== 'dissolve' && <label className="mt-3 block text-sm text-text-secondary">编组名称
        <input aria-label="编组名称" autoFocus maxLength={MAX_GROUP_NAME_LENGTH} value={name}
          onChange={event => { setName(event.target.value); setError('') }}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
          className="mt-1 w-full rounded border border-border bg-bg-primary px-3 py-2 text-text-primary outline-none focus:border-accent" />
      </label>}
      {error && <p role="alert" className="mt-2 text-xs text-warning">{error}</p>}
    </Modal>
  </>
}
