import React from 'react'
import type { BatchTextSession } from '@/core/batch-text-session'
import type { BatchTextOutputMode } from '@/core/batch-text-export'
import { beginBatchExportActivity } from '@/core/batch-export-activity'
import { previewBatchProduction, type BatchProductionPreview } from '@/core/batch-production'

export function useBatchProductionPreview(session: BatchTextSession | null, record: number | null, mode: BatchTextOutputMode | '') {
  const [value, setValue] = React.useState<BatchProductionPreview | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [usable, setUsable] = React.useState(false)
  const [reviewed, setReviewed] = React.useState<BatchProductionPreview | null>(null)
  const operation = React.useRef<AbortController | null>(null)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; operation.current?.abort() }
  }, [])
  React.useEffect(() => {
    operation.current?.abort()
    setReviewed(null)
    setUsable(false)
  }, [session, record, mode])
  const current = usable && !!value && value.session === session && value.row === record && value.mode === mode
  const generate = async () => {
    if (!session || record === null || !mode || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    const finish = beginBatchExportActivity()
    setBusy(true); setNotice('正在生成单条交付样本并回读实际 SVGA…'); setReviewed(null); setUsable(false)
    try {
      const result = await previewBatchProduction(session, record, mode, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      setValue(result); setUsable(true); setNotice('样本已生成。请比较实际产物与设计模拟，再确认整批生产。')
    } catch (error) {
      if (mounted.current) setNotice(controller.signal.aborted ? '已取消抽样；旧预览保留，但需重新生成后确认。' : '抽样失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      finish()
      if (operation.current === controller) operation.current = null
      if (mounted.current) setBusy(false)
    }
  }
  return { value, current, busy, notice, generate, cancel: () => operation.current?.abort(), isBusy: () => !!operation.current,
    confirmed: current && reviewed === value, confirm: (checked: boolean) => setReviewed(checked && current ? value : null) }
}
