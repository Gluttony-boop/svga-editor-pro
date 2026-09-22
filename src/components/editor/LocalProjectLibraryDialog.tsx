import { useEffect, useRef, useState } from 'react'
import { Button, Icon, Modal } from '@/components/ui'
import type { LocalProjectPreferences, LocalProjectSnapshot, LocalProjectSummary } from '@/types/project-library'
import { formatResourceBytes } from '@/utils/resource-catalog'

type EntryAction = (entry: LocalProjectSummary) => void | Promise<void>

export interface LocalProjectLibraryDialogProps {
  isOpen: boolean
  onClose: () => void
  snapshot: LocalProjectSnapshot | null
  loading: boolean
  error: string | null
  onOpen: EntryAction
  onDownload: EntryAction
  onRemove: EntryAction
  onClear: () => void | Promise<void>
  onConfigure: (patch: Partial<Pick<LocalProjectPreferences, 'recoveryEnabled' | 'recentEnabled'>>) => void | Promise<void>
  onRefresh: () => void | Promise<void>
}

type DeleteConfirmation = { kind: 'clear' } | { kind: 'remove'; entry: LocalProjectSummary }

function formatSavedTime(timestamp: number): { label: string; dateTime?: string } {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return { label: '时间未知' }
  return {
    label: date.toLocaleString(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }),
    dateTime: date.toISOString(),
  }
}

function formatSize(bytes: number): string {
  return Number.isFinite(bytes) && bytes >= 0 ? formatResourceBytes(bytes) : '大小未知'
}

export function LocalProjectLibraryDialog({
  isOpen, onClose, snapshot, loading, error, onOpen, onDownload, onRemove, onClear, onConfigure, onRefresh,
}: LocalProjectLibraryDialogProps) {
  const [pending, setPending] = useState(false)
  const [confirmation, setConfirmation] = useState<DeleteConfirmation | null>(null)
  const [failureFocusVersion, setFailureFocusVersion] = useState(0)
  const pendingRef = useRef(false)
  const mountedRef = useRef(true)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const busy = loading || pending

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  useEffect(() => {
    if (!isOpen) setConfirmation(null)
  }, [isOpen])
  useEffect(() => {
    // 异步处理会暂时禁用按钮，失败后要等按钮恢复可用再回到安全的取消操作。
    // 打开工程的未保存确认会暂时隐藏本弹窗，此时不抢占另一弹窗的焦点。
    if (!isOpen || busy) return
    if (confirmation) cancelRef.current?.focus()
    else if (triggerRef.current) {
      // 等按钮退出 disabled 状态后再还原焦点；被删行已卸载时回到关闭按钮。
      const trigger = triggerRef.current
      if (trigger.isConnected && !trigger.disabled) trigger.focus()
      else closeRef.current?.focus()
      triggerRef.current = null
    }
  }, [confirmation, isOpen, busy, failureFocusVersion])

  const actionsDisabled = busy || !snapshot || !!confirmation
  const entries = snapshot?.entries ?? []
  const recoveries = entries.filter(entry => entry.kind === 'recovery').sort((a, b) => b.updatedAt - a.updatedAt)
  const recent = entries.filter(entry => entry.kind === 'recent').sort((a, b) => b.updatedAt - a.updatedAt)

  const cancelConfirmation = () => {
    setConfirmation(null)
  }

  const requestClose = () => {
    if (loading || pendingRef.current) return
    if (confirmation) cancelConfirmation()
    else onClose()
  }

  const run = async (action: () => void | Promise<void>, onSuccess?: () => void) => {
    // React 更新按钮前也要阻止连续点击，避免同时恢复两个工程或重复删除。
    if (!isOpen || loading || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    try {
      await action()
      if (mountedRef.current) onSuccess?.()
    } catch {
      // 父级负责展示具体错误；保留删除确认，失败不能被误认成已删除。
      // 同步抛错可能让两次 pending 更新被合并，单独触发焦点恢复以覆盖这种情况。
      if (mountedRef.current) setFailureFocusVersion(version => version + 1)
    } finally {
      pendingRef.current = false
      if (mountedRef.current) setPending(false)
    }
  }

  const renderEntry = (entry: LocalProjectSummary) => {
    const savedTime = formatSavedTime(entry.updatedAt)
    const entryLabel = `${entry.name}（${entry.id}）`
    return <li key={entry.id} data-local-project-id={entry.id} className="rounded-lg border border-border bg-bg-tertiary p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-text-muted" aria-hidden="true"><Icon name={entry.kind === 'recovery' ? 'history' : 'file'} size={18} /></span>
        <div className="min-w-0 flex-1">
          <p className="break-all text-sm font-medium text-text-primary">{entry.name}</p>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
            <span>副本更新：<time dateTime={savedTime.dateTime} title="本机本地时间">{savedTime.label}</time></span>
            <span>{formatSize(entry.size)}</span>
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={actionsDisabled} aria-label={`打开本机副本：${entryLabel}`} icon={<Icon name="folder-open" size={15} />} onClick={() => { void run(() => onOpen(entry)) }}>打开本机副本</Button>
        <Button size="sm" disabled={actionsDisabled} aria-label={`下载工程：${entryLabel}`} icon={<Icon name="download" size={15} />} onClick={() => { void run(() => onDownload(entry)) }}>下载工程</Button>
        <Button size="sm" variant="ghost" disabled={actionsDisabled} aria-label={`删除本机副本：${entryLabel}`} icon={<Icon name="trash" size={15} />} onClick={event => {
          triggerRef.current = event.currentTarget
          setConfirmation({ kind: 'remove', entry })
        }}>删除</Button>
      </div>
    </li>
  }

  return <Modal isolateKeyboard isOpen={isOpen} title="恢复与最近工程" className="!max-w-3xl" onClose={requestClose} footer={<>
    <Button disabled={busy || (entries.length === 0 && !error) || !!confirmation} variant="ghost" aria-label="清空全部本机工程副本" icon={<Icon name="trash" size={16} />} onClick={event => {
      triggerRef.current = event.currentTarget
      setConfirmation({ kind: 'clear' })
    }}>清空本机副本</Button>
    <Button ref={closeRef} disabled={busy} aria-label="关闭工程库" onClick={requestClose}>{confirmation ? '取消删除' : '关闭'}</Button>
  </>}>
    <div className="space-y-4" aria-busy={busy}>
      <p className="text-xs leading-relaxed text-text-secondary">工程副本仅保存在当前浏览器或桌面应用的本机用户配置中，不会上传云端。它不是云备份；清理应用数据、浏览器存储或存储空间不足都可能导致副本丢失。重要成果请用 Ctrl+S 保存为 .svgaproj 工程。</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted">{snapshot ? `本机副本已用 ${formatSize(snapshot.bytesUsed)} / 256 MiB` : '本机副本总容量上限 256 MiB'}</p>
        <Button size="sm" disabled={busy || !!confirmation} aria-label="刷新本机工程列表" icon={<Icon name="refresh" size={15} />} onClick={() => { void run(onRefresh) }}>刷新列表</Button>
      </div>
      {error && <div role="alert" className="rounded-lg border border-error/40 bg-error/5 p-3 text-xs leading-relaxed text-error">
        <p className="font-medium">{snapshot ? '本机工程操作未完成' : '本机工程库暂不可用'}</p>
        <p className="mt-1 break-words">{error}</p>
        <p className="mt-1">请保留当前画面，必要时先手动保存工程，再刷新列表重试。</p>
        {!snapshot && <p className="mt-1">无法读取本机副本的数量和内容；不会自动清理。若需要重置损坏的工程库，可手动选择“清空本机副本”并再次确认，所有本机副本将不可恢复。</p>}
      </div>}
      {busy && <p role="status" className="text-xs text-text-secondary">{pending ? '正在处理本机工程，请稍候…' : '正在读取本机工程副本…'}</p>}
      {confirmation && <section aria-label="确认删除本机副本" className="rounded-lg border border-warning/50 bg-warning/5 p-4">
        <h4 className="text-sm font-medium text-warning">{confirmation.kind === 'clear' ? '清空全部本机副本？' : '删除这个本机副本？'}</h4>
        {confirmation.kind === 'remove' && <p className="mt-2 break-all text-sm text-text-primary">{confirmation.entry.name}</p>}
        <p className="mt-2 text-xs leading-relaxed text-text-secondary">只删除本机副本，不删除磁盘工程；不能撤销。{confirmation.kind === 'clear' ? '包括未保存恢复副本与最近工程副本。' : confirmation.entry.kind === 'recovery' ? '这份恢复副本可能是未保存修改的唯一备份。' : ''} 如需保留，请先取消并下载工程。</p>
        {confirmation.kind === 'clear' && !snapshot && <p className="mt-2 text-xs leading-relaxed text-warning">副本数量和内容未知，清空可能删除未保存修改的唯一备份；请先取消并手动保存当前工程，或尝试刷新列表。若存储设置也已损坏，清空后会关闭自动恢复与最近工程记录，需手动重新开启。</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button ref={cancelRef} size="sm" disabled={busy} aria-label="取消删除本机副本" onClick={cancelConfirmation}>取消</Button>
          <Button size="sm" variant="danger" disabled={busy} aria-label={confirmation.kind === 'clear' ? '确认清空全部本机工程副本' : `确认删除本机副本：${confirmation.entry.name}（${confirmation.entry.id}）`} onClick={() => {
            void run(confirmation.kind === 'clear' ? onClear : () => onRemove(confirmation.entry), () => setConfirmation(null))
          }}>{confirmation.kind === 'clear' ? '确认清空' : '确认删除'}</Button>
        </div>
      </section>}
      <fieldset disabled={actionsDisabled} className="space-y-3 rounded-lg border border-border p-3">
        <legend className="px-1 text-xs text-text-muted">本机保存设置</legend>
        <label className="flex items-start gap-2 text-sm text-text-primary">
          <input type="checkbox" className="mt-0.5 accent-accent" checked={snapshot?.preferences.recoveryEnabled ?? true} aria-label="自动保留未保存修改的恢复副本" onChange={event => { void run(() => onConfigure({ recoveryEnabled: event.target.checked })) }} />
          <span>自动保留未保存修改的恢复副本<span className="mt-1 block text-xs leading-relaxed text-text-muted">恢复副本不代表工程已保存；仍需手动保存为 .svgaproj。</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm text-text-primary">
          <input type="checkbox" className="mt-0.5 accent-accent" checked={snapshot?.preferences.recentEnabled ?? true} aria-label="保留最近工程的本机副本" onChange={event => { void run(() => onConfigure({ recentEnabled: event.target.checked })) }} />
          <span>保留最近工程的本机副本<span className="mt-1 block text-xs leading-relaxed text-text-muted">用于下次继续编辑，不记录可自动覆盖原文件的路径。</span></span>
        </label>
        <p className="text-[11px] leading-relaxed text-text-muted">关闭设置只停止后续写入，已有副本仍可打开或手动删除。</p>
      </fieldset>
      {!snapshot && !loading && <p className="rounded-lg bg-bg-tertiary p-4 text-sm text-text-muted">尚未读取到本机副本列表。请点击“刷新列表”重试；这不影响手动打开和保存磁盘工程。</p>}
      {snapshot && <>
        <section aria-label="未保存恢复副本">
          <h4 className="text-sm font-medium text-text-primary">未保存恢复副本 <span className="font-mono text-xs text-text-muted">{recoveries.length} / 5</span></h4>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">最多 5 份，不自动淘汰；满额时请先下载或删除不需要的副本。打开恢复副本会替换当前文档，当前未保存修改将先由编辑器询问处理。</p>
          {recoveries.length > 0 ? <ul className="mt-3 space-y-2">{recoveries.map(renderEntry)}</ul> : <p className="mt-3 rounded-lg bg-bg-tertiary p-4 text-sm text-text-muted">暂无未保存恢复副本。</p>}
        </section>
        <section aria-label="最近工程（本机副本）">
          <h4 className="text-sm font-medium text-text-primary">最近工程（本机副本） <span className="font-mono text-xs text-text-muted">{recent.length} / 8</span></h4>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">最多 8 份，超出数量或容量时淘汰较旧缓存。副本不会跟随磁盘文件更新；打开后保存需要重新选择路径，不会自动覆盖原文件。</p>
          {recent.length > 0 ? <ul className="mt-3 space-y-2">{recent.map(renderEntry)}</ul> : <p className="mt-3 rounded-lg bg-bg-tertiary p-4 text-sm text-text-muted">暂无最近工程副本。</p>}
        </section>
      </>}
    </div>
  </Modal>
}
