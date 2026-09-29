import React from 'react'
import { evaluateSizeBudget } from '@/core/export-size-budget'

export function ExportSizeBudget({ actualBytes, stale, disabled }: { actualBytes?: number; stale: boolean; disabled: boolean }) {
  const [target, setTarget] = React.useState('')
  React.useEffect(() => {
    const open = () => setTarget('50')
    window.addEventListener('svga-start-size-budget', open)
    return () => window.removeEventListener('svga-start-size-budget', open)
  }, [])
  const result = evaluateSizeBudget(target, actualBytes, stale)
  return <section aria-label="导出体积目标" className="space-y-1 rounded-lg border border-border bg-bg-primary/40 p-2">
    <label className="flex items-center gap-2 text-xs text-text-secondary">目标大小（KiB）
      <input type="number" min="0.01" max="1048576" step="any" value={target} disabled={disabled} placeholder="不限" aria-label="导出目标大小 KiB"
        onChange={event => setTarget(event.target.value)} className="h-7 min-w-0 flex-1 rounded border border-border bg-bg-primary px-2 text-text-primary" />
    </label>
    <p role="status" className={'text-[11px] leading-relaxed ' + (result.status === 'passed' ? 'text-success' : ['failed', 'invalid', 'stale'].includes(result.status) ? 'text-warning' : 'text-text-muted')}>{result.message}</p>
    <p className="text-[10px] text-text-muted">只核对体积，不自动保证达标；不限制正常导出。</p>
  </section>
}
