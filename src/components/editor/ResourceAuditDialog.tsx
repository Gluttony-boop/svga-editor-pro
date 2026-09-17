import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@/components/ui'
import { saveGeneratedFile } from '@/core/exporter'
import { OperationStatus, type OperationStatusValue } from '@/components/ui/OperationStatus'
import { type auditResources, createResourceAuditReport, RESOURCE_FILTERS, type ResourceFilter } from '@/utils/resource-audit'
import { formatResourceBytes } from '@/utils/resource-catalog'

export function ResourceAuditDialog({ audit, onClose, onFilter, onInspect, onLocate }: {
  audit: ReturnType<typeof auditResources>
  onClose: () => void
  onFilter: (filter: ResourceFilter) => void
  onInspect: (key: string) => void
  onLocate: (id: string) => void
}) {
  const [status, setStatus] = useState<OperationStatusValue | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const top = [...audit.rows].sort((a, b) => (b.decodedBytes ?? -1) - (a.decodedBytes ?? -1)).slice(0, 5)
  const download = async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setStatus({ kind: 'processing', message: '正在保存检查报告…' })
    try {
      const report = createResourceAuditReport(audit)
      const saved = await saveGeneratedFile(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), 'svga-resource-audit.json')
      if (mountedRef.current) setStatus({ kind: saved ? 'success' : 'cancelled', message: saved ? '检查报告已保存（保存开始时的快照）' : '已取消保存报告' })
    } catch (error) {
      if (mountedRef.current) setStatus({ kind: 'error', message: `保存报告失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }
  return <Modal isolateKeyboard isOpen title="SVGA 素材体检" className="!max-w-3xl" onClose={onClose} footer={<>
    <Button disabled={saving} onClick={() => { void download() }}>导出检查报告</Button><Button onClick={onClose}>关闭</Button>
  </>}>
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-text-secondary">从当前编辑的引用关系与源图片成本入手排查。检查不会修改文件，不会自动删除素材；它不是播放器兼容性认证。</p>
      <div className="grid grid-cols-3 gap-2">
        {RESOURCE_FILTERS.filter(filter => filter.id !== 'all').map(filter => <button type="button" key={filter.id} onClick={() => onFilter(filter.id)} className="rounded border border-border bg-bg-tertiary p-3 text-left hover:border-accent">
          <span className="block text-xs text-text-muted">{filter.label}</span><span className="mt-1 block font-mono text-xl text-text-primary">{audit.counts[filter.id]}</span>
        </button>)}
        <div className="rounded border border-border p-3"><span className="block text-xs text-text-muted">待核对引用 Key</span><span className={`mt-1 block font-mono text-xl ${audit.missing.length ? 'text-warning' : 'text-text-primary'}`}>{audit.missing.length}</span></div>
      </div>
      <p className="text-xs text-text-muted">{audit.counts.all} 张源图 · 编码 {formatResourceBytes(audit.stats.encodedBytes)} · 解码估算 {formatResourceBytes(audit.stats.decodedBytes)}{audit.stats.unknownDimensions > 0 ? `（${audit.stats.unknownDimensions} 张尺寸未知，未计入）` : ''}</p>
      {audit.missing.length > 0 && <section className="rounded border border-warning/40 p-3" aria-label="缺失资源引用">
        <h4 className="mb-2 text-sm text-warning">引用的图片 Key 不在当前资源列表中</h4>
        <div className="max-h-44 space-y-2 overflow-y-auto">{audit.missing.map(item => <div key={item.key}>
          <p className="break-all font-mono text-xs text-text-primary">{item.key}</p>
          {item.usages.map(usage => <button key={usage.id} type="button" className="mr-2 text-xs text-accent underline" onClick={() => onLocate(usage.id)}>定位 {usage.name}{usage.matte ? '（遮罩）' : ''}</button>)}
        </div>)}</div><p className="mt-2 text-xs text-text-muted">可能是动态插槽或形状图层约定，需结合目标播放器确认，不能仅凭缺失图片判定文件损坏。</p>
      </section>}
      <section aria-label="源图内存排行"><h4 className="mb-2 text-sm text-text-primary">源图解码成本 · 前 5 项</h4>
        <div className="space-y-1">{top.map(row => <button type="button" key={row.key} onClick={() => onInspect(row.key)} className="flex w-full items-center gap-3 rounded bg-bg-tertiary px-3 py-2 text-left text-xs hover:text-accent">
          <span className="min-w-0 flex-1 truncate font-mono">{row.key}</span><span className="shrink-0 text-text-muted">{row.usages.length} 引用</span><span className="shrink-0 font-mono">{row.decodedBytes === null ? '尺寸未知' : formatResourceBytes(row.decodedBytes)}</span>
        </button>)}</div>
        {!top.length && <p className="text-xs text-text-muted">当前没有可统计的图片资源。</p>}
      </section>
      <p className="text-[11px] leading-relaxed text-text-muted">高内存指单张源图按宽×高×4 估算 ≥ 4 MiB，仅是排查阈值。PNG 量化可能减小文件，却不改变同尺寸图片的这项解码估算；降采样才会改变像素数。统计不含替换图、帧缓存与 GPU 开销。</p>
      <OperationStatus status={status} />
    </div>
  </Modal>
}
