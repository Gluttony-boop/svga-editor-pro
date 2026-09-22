import React from 'react'
import { Button, Icon, Modal } from '@/components/ui'
import { OperationStatus, type OperationStatusValue } from '@/components/ui/OperationStatus'
import { canInstallUpdate, updateStatusForError, type UpdateHandle, type UpdateStatus } from '@/core/update-policy'
import { createDesktopUpdaterAdapter } from '@/lib/desktop-updater'

interface UpdateDialogProps {
  isOpen: boolean
  onClose: () => void
  dirty: boolean
  busy: boolean
  exporting: boolean
  currentInputs: readonly unknown[]
  onSave: () => Promise<boolean>
  getGuards?: () => { dirty: boolean; busy: boolean; exporting: boolean; currentInputs: readonly unknown[] }
  adapter?: import('@/core/update-policy').UpdateAdapter
  beforeInstall?: () => void
}

function displayStatus(status: UpdateStatus): OperationStatusValue | null {
  if (status.phase === 'idle') return null
  const kind: OperationStatusValue['kind'] = status.phase === 'error' ? 'error'
    : status.phase === 'disabled' || status.phase === 'cancelled' ? 'warning' : status.phase === 'ready' || status.phase === 'current' ? 'success' : 'processing'
  return { kind, message: status.message }
}

export function UpdateDialog({ isOpen, onClose, dirty, busy, exporting, currentInputs, onSave, getGuards, adapter: injectedAdapter, beforeInstall }: UpdateDialogProps) {
  const [status, setStatus] = React.useState<UpdateStatus>({ phase: 'idle', message: '' })
  const [handle, setHandle] = React.useState<UpdateHandle | null>(null)
  const handleRef = React.useRef<UpdateHandle | null>(null)
  const [checkedInputs, setCheckedInputs] = React.useState<readonly unknown[] | null>(null)
  const [busyAction, setBusyAction] = React.useState<'checking' | 'downloading' | 'installing' | null>(null)
  const tokenRef = React.useRef(0)
  const mountedRef = React.useRef(true)
  const adapter = React.useMemo(() => injectedAdapter ?? createDesktopUpdaterAdapter(), [injectedAdapter])
  const invalidate = React.useCallback(() => { tokenRef.current++ }, [])

  const clearHandle = React.useCallback(() => {
    const current = handleRef.current
    handleRef.current = null
    setHandle(null)
    if (current?.close) void Promise.resolve(current.close()).catch(() => {})
  }, [])

  React.useEffect(() => {
    // React.StrictMode 会在开发环境模拟一次卸载/重挂载；每次建立效果都要重新标记为可用。
    mountedRef.current = true
    return () => { mountedRef.current = false; invalidate(); clearHandle() }
  }, [clearHandle, invalidate])
  React.useEffect(() => {
    if (!isOpen) { tokenRef.current++; setBusyAction(null); clearHandle(); setCheckedInputs(null); setStatus({ phase: 'idle', message: '' }) }
  }, [isOpen, clearHandle])

  const active = (token: number) => mountedRef.current && isOpen && token === tokenRef.current
  const checkUpdate = async () => {
    if (busyAction) return
    const token = ++tokenRef.current
    setBusyAction('checking'); setStatus({ phase: 'checking', message: '正在检查签名更新清单…' })
    try {
      if (!adapter.isDesktop) { if (active(token)) setStatus({ phase: 'disabled', message: '网页模式不会安装桌面更新；网页版本随部署更新。' }); return }
      const found = await adapter.check()
      if (!active(token)) return
      if (!found) { setStatus({ phase: 'current', message: '当前没有可用更新；未将断网或未配置误报为最新版。' }); return }
      handleRef.current = found; setHandle(found); setCheckedInputs(getGuards?.().currentInputs ?? currentInputs); setStatus({ phase: 'available', message: `发现新版本 ${found.metadata.version}，下载前请保存重要修改。`, metadata: found.metadata })
    } catch (error) { if (active(token)) { clearHandle(); setStatus(updateStatusForError(error)) } }
    finally { if (active(token)) setBusyAction(null) }
  }

  const download = async () => {
    if (!handle || busyAction) return
    const token = ++tokenRef.current
    setBusyAction('downloading'); setStatus({ phase: 'downloading', message: '正在下载签名更新包…', metadata: handle.metadata, progress: { downloaded: 0, total: null } })
    try {
      await handle.download(progress => { if (active(token)) setStatus(previous => ({ ...previous, phase: 'downloading', message: '正在下载签名更新包…', progress, metadata: handle.metadata })) })
      if (active(token)) setStatus({ phase: 'ready', message: '更新包已下载并通过插件校验；安装前仍会重新检查未保存状态。', metadata: handle.metadata })
    } catch (error) { if (active(token)) { clearHandle(); setStatus(updateStatusForError(error)) } }
    finally { if (active(token)) setBusyAction(null) }
  }

  const install = async () => {
    if (!handle || busyAction || !checkedInputs) return
    let guards = getGuards?.() ?? { dirty, busy, exporting, currentInputs }
    let guard = canInstallUpdate({ ...guards, downloadedInputs: checkedInputs })
    if (!guard.ok) { setStatus({ phase: 'error', message: guard.reason, errorCode: 'unknown' }); return }
    // 只有初步状态允许安装时才提交画布手势；提交后再实时检查一次，避免把刚结束的草稿漏过去。
    beforeInstall?.()
    guards = getGuards?.() ?? { dirty, busy, exporting, currentInputs }
    guard = canInstallUpdate({ ...guards, downloadedInputs: checkedInputs })
    if (!guard.ok) { setStatus({ phase: 'error', message: guard.reason, errorCode: 'unknown' }); return }
    const token = ++tokenRef.current
    setBusyAction('installing'); setStatus({ phase: 'installing', message: '正在启动签名安装程序；Windows 可能会退出应用。', metadata: handle.metadata })
    try {
      await handle.install()
      await handle.close?.()
      clearHandle()
      if (active(token)) setStatus({ phase: 'ready', message: '安装调用已完成。Windows 可能已退出；macOS/Linux 请手动重启应用。', metadata: handle.metadata })
    } catch (error) { if (active(token)) setStatus(updateStatusForError(error)) }
    finally { if (active(token)) setBusyAction(null) }
  }

  const saveAndDownload = async () => {
    if (busyAction) return
    const saved = await onSave()
    if (!saved) { setStatus({ phase: 'error', message: '工程未确认保存，已阻止更新下载。', errorCode: 'unknown' }); return }
    await checkUpdate()
  }

  const saveAndRecheck = async () => {
    if (busyAction) return
    const saved = await onSave()
    if (!saved) { setStatus({ phase: 'error', message: '工程未确认保存，已阻止更新安装。', errorCode: 'unknown' }); return }
    clearHandle()
    await checkUpdate()
  }

  const progress = status.progress?.total ? `${Math.min(100, Math.round(status.progress.downloaded / status.progress.total * 100))}%` : status.progress ? `${Math.round(status.progress.downloaded / 1024)} KiB` : ''
  return <Modal isolateKeyboard isOpen={isOpen} onClose={() => { if (!busyAction) onClose() }} title="检查桌面更新" footer={<div className="flex w-full items-center justify-end gap-2">
    <Button variant="ghost" disabled={!!busyAction} onClick={onClose}>关闭</Button>
    {dirty && !handle && <Button disabled={!!busyAction} onClick={() => { void saveAndDownload() }}>保存并检查</Button>}
    {dirty && handle && <Button disabled={!!busyAction} onClick={() => { void saveAndRecheck() }}>保存并重新检查</Button>}
    {!handle && <Button disabled={!!busyAction} onClick={() => { void checkUpdate() }} icon={<Icon name="refresh" size={15} />}>检查更新</Button>}
    {handle && status.phase === 'available' && <Button disabled={!!busyAction} onClick={() => { void download() }}>下载更新</Button>}
    {handle && (status.phase === 'ready' || status.phase === 'installing') && <Button disabled={!!busyAction || status.phase === 'installing'} variant="primary" onClick={() => { void install() }}>安装更新</Button>}
  </div>}>
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-text-secondary">更新只接受 Tauri updater 的 HTTPS 清单和签名包。公钥、端点未配置时不会联网或假报最新版；网页模式不会安装桌面程序。</p>
      {status.metadata && <div className="rounded-lg border border-border bg-bg-tertiary p-3 text-sm"><p className="font-medium">{status.metadata.currentVersion ? `当前 ${status.metadata.currentVersion} → ` : ''}版本 {status.metadata.version}</p>{status.metadata.date && <p className="mt-1 text-xs text-text-muted">发布时间：{status.metadata.date}</p>}{status.metadata.notes && <p className="mt-2 whitespace-pre-wrap text-xs text-text-secondary">{status.metadata.notes}</p>}</div>}
      <OperationStatus status={displayStatus(status)} />
      {progress && <p role="status" className="text-xs text-text-muted">下载进度：{progress}。官方插件没有可保证的中途取消 API，关闭窗口只会放弃当前界面跟踪，不会把未完成下载标记为已安装。</p>}
      {status.phase === 'ready' && <p className="rounded border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed text-warning">安装前会再次检查未保存修改、文件读写和导出状态。更新失败不会删除工程或本机恢复副本。</p>}
    </div>
  </Modal>
}
