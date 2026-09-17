import React, { useEffect, useRef, useState } from 'react'
import { Button, Icon, Modal } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { cn } from '@/utils/cn'
import { historyActionLabel } from '@/utils/history-label'
import { historyStepIcon, historyStepRows } from '@/utils/history-list'

interface HistoryPanelProps {
  collapsed?: boolean
  onToggleCollapsed?: () => void
  onHide?: () => void
  disabled?: boolean
  style?: React.CSSProperties
}

type History = ReturnType<typeof useEditorStore.getState>['history']
type Confirmation = { kind: 'clear' | 'state' | 'snapshot'; history: History; name: string; index?: number; id?: string }

const iconButtonClass = 'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40'

export const HistoryPanel: React.FC<HistoryPanelProps> = ({ collapsed = false, onToggleCollapsed, onHide, disabled = false, style }) => {
  const history = useEditorStore(s => s.history)
  const videoItem = useEditorStore(s => s.videoItem)
  const canUndo = useEditorStore(s => s.canUndo)
  const canRedo = useEditorStore(s => s.canRedo)
  const undo = useEditorStore(s => s.undo)
  const redo = useEditorStore(s => s.redo)
  const jumpToHistory = useEditorStore(s => s.jumpToHistory)
  const restoreSnapshot = useEditorStore(s => s.restoreHistorySnapshot)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [snapshotDialog, setSnapshotDialog] = useState<{ id?: string; name: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const snapshotNameRef = useRef<HTMLInputElement>(null)
  const snapshotDialogOpen = snapshotDialog !== null
  const disabledActions = disabled || !videoItem
  const snapshots = history.snapshots || []
  const isSnapshot = history.timelineSnapshot != null
  const activeSnapshot = isSnapshot ? snapshots.find(snapshot => snapshot.id === history.activeSnapshotId) : undefined
  const rows = historyStepRows(history)
  const currentIndex = history.past.length
  const totalSteps = rows.length - 1
  const undoLabel = isSnapshot ? '撤销：选择快照' : historyActionLabel('撤销', history.past[currentIndex - 1])
  const redoLabel = isSnapshot ? '重做' : historyActionLabel('重做', history.future[0])
  const canDelete = !disabledActions && (isSnapshot ? !!activeSnapshot : currentIndex > 0)

  useEffect(() => {
    setMenuOpen(false)
    setConfirmation(null)
    setSnapshotDialog(null)
  }, [videoItem])

  useEffect(() => {
    if (!snapshotDialogOpen) return
    // 等弹窗记住发起按钮后再聚焦输入框，关闭时才能正确归还焦点。
    snapshotNameRef.current?.focus()
    snapshotNameRef.current?.select()
  }, [snapshotDialogOpen])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  useEffect(() => {
    const list = listRef.current
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !selected || collapsed) return
    // 只滚动面板内部，避免历史跳转带动画布或整个检查器滚动。
    const top = selected.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + selected.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + selected.offsetHeight - list.clientHeight
  }, [history, collapsed])

  const requestDelete = () => {
    setMenuOpen(false)
    if (!canDelete) return
    setConfirmation(isSnapshot && activeSnapshot
      ? { kind: 'snapshot', history, name: activeSnapshot.name, id: activeSnapshot.id }
      : { kind: 'state', history, name: rows[currentIndex].label, index: currentIndex })
  }

  const newSnapshot = () => {
    setMenuOpen(false)
    let number = 1
    while (snapshots.some(snapshot => snapshot.name === `快照 ${number}`)) number++
    setSnapshotDialog({ name: `快照 ${number}` })
  }

  const confirm = () => {
    const current = useEditorStore.getState()
    // 确认框打开后若文档或历史已被其他流程更新，不再按过期索引删除。
    if (confirmation && current.history === confirmation.history && current.videoItem === videoItem) {
      if (confirmation.kind === 'clear') current.clearHistory()
      else if (confirmation.kind === 'snapshot' && confirmation.id) current.deleteHistorySnapshot(confirmation.id)
      else if (confirmation.index !== undefined) current.deleteHistoryState(confirmation.index)
    }
    setConfirmation(null)
  }

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabledActions || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      requestDelete()
      return
    }
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'))
    const focused = options.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? Math.min(options.length - 1, focused + 1)
      : event.key === 'ArrowUp' ? Math.max(0, focused - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1
    if (next < 0 || !options[next]) return
    event.preventDefault()
    event.stopPropagation()
    options[next].focus({ preventScroll: true })
    options[next].click()
  }

  const rowClass = (selected: boolean, future = false) => cn(
    'group flex min-h-8 w-full items-center gap-2 border-l-2 pr-3 text-left text-xs focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-1 focus-visible:outline-accent disabled:cursor-not-allowed',
    selected ? 'border-accent bg-accent/20 text-text-primary' : 'border-transparent hover:bg-bg-tertiary',
    !selected && (future ? 'text-text-muted opacity-50' : 'text-text-secondary')
  )

  const marker = (selected: boolean) => <span aria-hidden="true" className="flex w-4 flex-shrink-0 justify-center text-[9px] text-accent">{selected ? '▶' : ''}</span>

  return (
    <section id="history-panel" data-history-panel aria-label="历史记录" className="relative flex min-h-9 flex-shrink-0 flex-col border-t border-border bg-bg-secondary" style={style}>
      <div className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-border px-2">
        <button type="button" onClick={onToggleCollapsed} aria-expanded={!collapsed} aria-controls="history-panel-content" className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left text-xs font-medium text-text-primary">
          <Icon name="history" size={15} />
          <span>历史记录</span>
          <Icon name={collapsed ? 'chevron-up' : 'chevron-down'} size={13} className="text-text-muted" />
        </button>
        {videoItem && <span className="mr-1 text-[10px] tabular-nums text-text-muted">{isSnapshot ? '快照' : `${currentIndex} / ${totalSteps}`}</span>}
        <div ref={menuRef} className="relative">
          <button type="button" className={iconButtonClass} aria-label="历史记录选项" aria-expanded={menuOpen} aria-controls="history-options" onClick={() => setMenuOpen(value => !value)} onKeyDown={event => { if (event.key === 'Escape') setMenuOpen(false) }}><Icon name="menu" size={15} /></button>
          {menuOpen && (
            <div id="history-options" aria-label="历史记录选项" className="absolute bottom-full right-0 z-30 mb-1 w-48 rounded border border-border bg-bg-secondary p-1 shadow-xl" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setMenuOpen(false); menuRef.current?.querySelector('button')?.focus() } }}>
              <button type="button" disabled={disabledActions} className="history-menu-item" onClick={newSnapshot}>新建快照…</button>
              <button type="button" disabled={disabledActions || !activeSnapshot} className="history-menu-item" onClick={() => { setMenuOpen(false); if (activeSnapshot) setSnapshotDialog({ id: activeSnapshot.id, name: activeSnapshot.name }) }}>重命名快照…</button>
              <button type="button" disabled={!canDelete} className="history-menu-item" onClick={requestDelete}>{isSnapshot ? '删除快照…' : '删除当前状态…'}</button>
              <div className="my-1 border-t border-border" />
              <button type="button" disabled={disabledActions || (!totalSteps && !isSnapshot)} className="history-menu-item" onClick={() => { setMenuOpen(false); setConfirmation({ kind: 'clear', history, name: '' }) }}>清空历史记录…</button>
            </div>
          )}
        </div>
        {onHide && <button type="button" className={iconButtonClass} onClick={onHide} aria-label="隐藏历史记录" title="隐藏历史记录（可从视图菜单重新打开）"><Icon name="close" size={14} /></button>}
      </div>

      {!collapsed && (
        <div id="history-panel-content" className="flex min-h-0 flex-1 flex-col">
          {!videoItem ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-xs text-text-muted"><Icon name="history" size={26} /><p>打开 SVGA 文件后记录编辑步骤</p></div>
          ) : (
            <>
              <div ref={listRef} role="listbox" aria-label="历史状态与快照" aria-busy={disabled} className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1" onKeyDown={handleListKeyDown}>
                {snapshots.length > 0 && <div className="px-3 pb-1 text-[10px] text-text-muted">快照</div>}
                {snapshots.map(snapshot => {
                  const selected = isSnapshot && snapshot.id === history.activeSnapshotId
                  return (
                    <button key={snapshot.id} type="button" role="option" aria-selected={selected} aria-label={`快照：${snapshot.name}`} tabIndex={selected ? 0 : -1} disabled={disabledActions} data-snapshot-id={snapshot.id} className={rowClass(selected)} title={`恢复快照：${snapshot.name}（双击重命名）`} onClick={() => restoreSnapshot(snapshot.id)} onDoubleClick={() => setSnapshotDialog({ id: snapshot.id, name: snapshot.name })}>
                      {marker(selected)}<Icon name="camera" size={14} /><span className="min-w-0 flex-1 truncate">{snapshot.name}</span>{selected && <span className="text-[10px] text-accent">当前</span>}
                    </button>
                  )
                })}
                {isSnapshot && !activeSnapshot && (
                  <button type="button" role="option" aria-selected="true" tabIndex={0} className={rowClass(true)} title="快照已删除，当前画面保留；仍可点击历史步骤恢复">
                    {marker(true)}<Icon name="camera" size={14} /><span className="min-w-0 flex-1 truncate">{history.activeSnapshotLabel || '快照'}（已删除）</span><span className="text-[10px] text-accent">当前</span>
                  </button>
                )}
                {snapshots.length > 0 && <div className="mx-3 my-1 border-t border-border" />}
                <div className="px-3 py-1 text-[10px] text-text-muted">操作步骤</div>
                {rows.map(row => (
                  <button key={row.index} type="button" role="option" aria-selected={row.isCurrent} aria-label={`${row.index === 0 ? '起点' : `步骤 ${row.index}`}：${row.label}${row.isCurrent ? '，当前状态' : ''}`} tabIndex={row.isCurrent ? 0 : -1} disabled={disabledActions} data-history-index={row.index} data-history-future={row.isFuture} className={rowClass(row.isCurrent, row.isFuture)} title={`${row.isCurrent ? '当前状态' : '恢复到'}：${row.label}`} onClick={() => jumpToHistory(row.index)}>
                    {marker(row.isCurrent)}<Icon name={historyStepIcon(row.label)} size={14} /><span className={cn('min-w-0 flex-1 truncate', row.isFuture && 'italic')}>{row.label}</span>
                    {row.isCurrent ? <span className="text-[10px] text-accent">当前</span> : row.isFuture && <span className="text-[10px]">可恢复</span>}
                  </button>
                ))}
              </div>
              <p className="flex-shrink-0 border-t border-border/60 px-3 py-1.5 text-[10px] leading-4 text-text-muted" title={`最多保留 ${history.maxDepth} 步；快照仅在当前文件会话中保留，不写入 SVGA 文件。`}>
                {isSnapshot ? '从快照继续编辑会替换原有操作步骤' : history.future.length ? '灰色步骤可恢复；继续编辑会替换后续步骤' : `点击步骤可回退 · 最多 ${history.maxDepth} 步 · 快照仅本次有效`}
              </p>
            </>
          )}
          <div className="flex h-9 flex-shrink-0 items-center gap-1 border-t border-border px-2">
            <button type="button" className={iconButtonClass} disabled={disabledActions || !canUndo} aria-label={undoLabel} title={undoLabel} onClick={undo}><Icon name="undo" size={15} /></button>
            <button type="button" className={iconButtonClass} disabled={disabledActions || !canRedo} aria-label={redoLabel} title={redoLabel} onClick={redo}><Icon name="redo" size={15} /></button>
            <span className="flex-1" />
            <button type="button" className={iconButtonClass} disabled={disabledActions} aria-label="新建快照" title="新建快照" onClick={newSnapshot}><Icon name="camera" size={16} /></button>
            <button type="button" className={iconButtonClass} disabled={!canDelete} aria-label={isSnapshot ? '删除当前快照' : '删除当前状态'} title={isSnapshot ? '删除快照（保留当前画面）' : '删除当前状态及后续步骤'} onClick={requestDelete}><Icon name="trash" size={16} /></button>
          </div>
        </div>
      )}

      <Modal isOpen={!!snapshotDialog} onClose={() => setSnapshotDialog(null)} title={snapshotDialog?.id ? '重命名快照' : '新建快照'} isolateKeyboard footer={<><Button variant="ghost" onClick={() => setSnapshotDialog(null)}>取消</Button><Button variant="primary" type="submit" form="history-snapshot-form" disabled={!snapshotDialog?.name.trim() || disabledActions}>确定</Button></>}>
        <form id="history-snapshot-form" onSubmit={event => {
          event.preventDefault()
          const name = snapshotDialog?.name.trim()
          if (!name || disabledActions) return
          const store = useEditorStore.getState()
          if (snapshotDialog?.id) store.renameHistorySnapshot(snapshotDialog.id, name)
          else store.createHistorySnapshot(name)
          setSnapshotDialog(null)
        }}>
          <label htmlFor="history-snapshot-name" className="mb-2 block text-sm text-text-secondary">快照名称</label>
          <input ref={snapshotNameRef} id="history-snapshot-name" maxLength={80} value={snapshotDialog?.name || ''} onChange={event => setSnapshotDialog(current => current && { ...current, name: event.target.value })} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) event.stopPropagation() }} className="w-full rounded border border-border bg-bg-primary px-3 py-2 text-sm focus:border-accent focus:outline-none" />
          <p className="mt-3 text-xs text-text-muted">保存当前完整编辑状态，方便随时对比和恢复。快照只在本次文件会话中保留。</p>
        </form>
      </Modal>
      <Modal isOpen={!!confirmation} onClose={() => setConfirmation(null)} title={confirmation?.kind === 'clear' ? '清空历史记录？' : confirmation?.kind === 'snapshot' ? '删除快照？' : '删除历史状态？'} isolateKeyboard footer={<><Button variant="ghost" onClick={() => setConfirmation(null)}>取消</Button><Button variant="danger" onClick={confirm}>确定{confirmation?.kind === 'clear' ? '清空' : '删除'}</Button></>}>
        <p className="break-words text-sm leading-6 text-text-secondary">
          {confirmation?.kind === 'clear' ? '将清空全部撤销和重做步骤，保留当前画面及快照。此操作不可撤销。'
            : confirmation?.kind === 'snapshot' ? `将删除快照“${confirmation.name}”，当前画面和操作步骤保持不变。此操作不可撤销。`
              : `将删除“${confirmation?.name || ''}”及其后的全部步骤，并回到上一步。此操作不可撤销。`}
        </p>
      </Modal>
    </section>
  )
}
