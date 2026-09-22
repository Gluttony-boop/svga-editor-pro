import React from 'react'
import { Button, Modal } from '@/components/ui'
import { OperationStatus, type OperationStatusValue } from '@/components/ui/OperationStatus'
import { tauriAPI, type LicenseStatusSummary } from '@/lib/tauri-api'

interface LicenseSummary {
  configured: boolean
  reason: string
  currentVersion: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function LicenseDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [status, setStatus] = React.useState<OperationStatusValue | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [summary, setSummary] = React.useState<LicenseSummary | null>(null)
  const [license, setLicense] = React.useState<LicenseStatusSummary | null>(null)
  const [code, setCode] = React.useState('')
  const operationRef = React.useRef(0)

  const close = React.useCallback(() => {
    operationRef.current += 1
    setCode('')
    setLoading(false)
    onClose()
  }, [onClose])

  React.useEffect(() => {
    if (!isOpen) {
      operationRef.current += 1
      setCode('')
      return
    }
    const operation = ++operationRef.current
    const current = () => operationRef.current === operation
    setLoading(true)
    setStatus(null)
    setCode('')
    setLicense(null)

    if (!('__TAURI_INTERNALS__' in window)) {
      setSummary({ configured: false, reason: '网页模式未启用桌面授权；不会收集或发送激活码。', currentVersion: '' })
      setStatus({ kind: 'warning', message: '当前是网页版本，桌面激活功能未启用。' })
      setLoading(false)
      return
    }

    void tauriAPI.app.getLicenseConfiguration().then(async value => {
      if (!current()) return
      setSummary(value)
      setStatus({ kind: 'warning', message: value.reason })
      if (value.configured) {
        const next = await tauriAPI.app.getLicenseStatus()
        if (current()) setLicense(next)
      }
    }).catch(error => {
      if (current()) setStatus({ kind: 'error', message: `无法读取桌面授权：${errorText(error)}` })
    }).finally(() => {
      if (current()) setLoading(false)
    })

    return () => {
      if (current()) operationRef.current += 1
    }
  }, [isOpen])

  React.useEffect(() => {
    if (!isOpen || !summary?.configured || !('__TAURI_INTERNALS__' in window)) return
    const timer = window.setInterval(() => {
      const operation = operationRef.current
      void tauriAPI.app.getLicenseStatus().then(next => {
        if (isOpen && operationRef.current === operation) setLicense(next)
      }).catch(() => {
        // 定时刷新失败不覆盖用户正在处理的激活/刷新错误。
      })
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [isOpen, summary?.configured])

  const activate = async () => {
    const submittedCode = code.trim()
    if (!submittedCode) return
    const operation = ++operationRef.current
    setCode('')
    setLoading(true)
    try {
      const next = await tauriAPI.app.activateLicense(submittedCode)
      if (operationRef.current !== operation) return
      setLicense(next)
      setStatus({ kind: 'success', message: '激活请求已完成；激活码不会保存到编辑器工程。' })
    } catch (error) {
      if (operationRef.current === operation) setStatus({ kind: 'error', message: `激活失败：${errorText(error)}` })
    } finally {
      if (operationRef.current === operation) setLoading(false)
    }
  }

  const refresh = async () => {
    const operation = ++operationRef.current
    setLoading(true)
    try {
      const next = await tauriAPI.app.refreshLicense()
      if (operationRef.current !== operation) return
      setLicense(next)
      setStatus({ kind: 'success', message: '授权已刷新。' })
    } catch (error) {
      if (operationRef.current === operation) setStatus({ kind: 'error', message: `刷新失败：${errorText(error)}` })
    } finally {
      if (operationRef.current === operation) setLoading(false)
    }
  }

  const clear = async () => {
    if (!window.confirm('确定退出本机授权吗？设备标识会保留，以便同一设备重新激活。')) return
    const operation = ++operationRef.current
    setCode('')
    setLoading(true)
    try {
      await tauriAPI.app.clearLicense()
      if (operationRef.current !== operation) return
      const next = await tauriAPI.app.getLicenseStatus()
      if (operationRef.current === operation) {
        setLicense(next)
        setStatus({ kind: 'success', message: '本机授权凭据已清除。' })
      }
    } catch (error) {
      if (operationRef.current === operation) setStatus({ kind: 'error', message: `清除失败：${errorText(error)}` })
    } finally {
      if (operationRef.current === operation) setLoading(false)
    }
  }

  return (
    <Modal isolateKeyboard isOpen={isOpen} onClose={close} title="授权状态" footer={<Button onClick={close}>关闭</Button>}>
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-text-secondary">授权用于控制未来明确标注的高级能力，不会锁住已有工程、保存或迁出成果。纯客户端无法保证绝对不可破解；服务端、公钥和安全存储未配置时不会发送激活码。</p>
        {loading && <p role="status" className="text-xs text-text-muted">正在处理桌面授权…</p>}
        {summary && (
          <div className="rounded-lg border border-border bg-bg-tertiary p-3 text-sm">
            <p className="font-medium">{summary.configured ? '桌面授权已配置' : '桌面授权未配置'}</p>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">{summary.reason}</p>
            {summary.currentVersion && <p className="mt-2 text-xs text-text-muted">应用版本：{summary.currentVersion}</p>}
          </div>
        )}
        {summary?.configured && (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <label className="block text-xs text-text-secondary">
              激活码
              <input aria-label="桌面激活码" type="password" autoComplete="new-password" value={code} onChange={event => setCode(event.target.value)} className="mt-1 w-full rounded border border-border bg-bg-primary px-2 py-1.5 font-mono text-xs text-text-primary" placeholder="输入小时卡或天卡激活码" />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button disabled={loading || !code.trim()} onClick={() => { void activate() }}>激活</Button>
              <Button variant="ghost" disabled={loading || !license} onClick={() => { void refresh() }}>联网刷新</Button>
              <Button variant="ghost" disabled={loading || !license} onClick={() => { void clear() }}>退出授权</Button>
            </div>
            {license && (
              <p role="status" className="text-xs text-text-secondary">
                状态：{license.state} · {license.reason}
                {license.expiresAt ? ` · 离线凭据至 ${new Date(license.expiresAt * 1000).toLocaleString()}` : ''}
                {license.licenseExpiresAt ? ` · 授权至 ${new Date(license.licenseExpiresAt * 1000).toLocaleString()}` : ''}
              </p>
            )}
          </div>
        )}
        <OperationStatus status={status} />
        <p className="text-xs leading-relaxed text-text-muted">小时/天有效期、离线到期和回拨策略已在本地策略测试中定义；生产激活、续期、换机、退款和支付流程尚未上线。</p>
      </div>
    </Modal>
  )
}
