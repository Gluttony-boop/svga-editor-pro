import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@/components/ui'
import { formatResourceBytes, type ResourceMetadata } from '@/utils/resource-catalog'
import { resourceAdvice, type ResourceFilter } from '@/utils/resource-audit'
import type { ResourceUsage } from '@/utils/resource-usage'
import { cn } from '@/utils/cn'
import { OperationStatus, type OperationStatusValue } from '@/components/ui/OperationStatus'

interface InspectorResource extends ResourceMetadata {
  mimeType: string
  decodedBytes: number | null
  tags: ResourceFilter[]
  usages: ResourceUsage[]
}

export function ResourceInspector({ resource, sourceUrl, replacementUrl, textSlot, downloading, onClose, onLocate, onReplace, onDownload }: {
  resource: InspectorResource
  sourceUrl?: string
  replacementUrl?: string
  textSlot: boolean
  downloading: boolean
  onClose: () => void
  onLocate: (id: string) => void
  onReplace: () => void
  onDownload: () => Promise<OperationStatusValue>
}) {
  const [background, setBackground] = useState('checker')
  const [copied, setCopied] = useState('')
  const [downloadStatus, setDownloadStatus] = useState<OperationStatusValue | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const copyKey = async () => {
    try {
      if (!navigator.clipboard) throw new Error('剪贴板不可用')
      await navigator.clipboard.writeText(resource.key)
      if (mountedRef.current) setCopied('Key 已复制')
    } catch {
      if (mountedRef.current) setCopied('复制不可用，请选择左侧 Key 手动复制')
    }
  }
  const download = async () => {
    if (downloading) return
    setDownloadStatus({ kind: 'processing', message: '正在提取图片…' })
    try {
      const result = await onDownload()
      if (mountedRef.current) setDownloadStatus(result)
    } catch (error) {
      if (mountedRef.current) setDownloadStatus({ kind: 'error', message: `提取失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }
  const advice = resourceAdvice(resource.tags, resource.decodedBytes)
  const previewStyle = background === 'checker'
    ? { backgroundColor: '#d1d5db', backgroundImage: 'conic-gradient(#f3f4f6 25%, transparent 0 50%, #f3f4f6 0 75%, transparent 0)', backgroundSize: '20px 20px' }
    : { backgroundColor: background }

  return <Modal isolateKeyboard isOpen title="素材检查" className="!max-w-3xl" onClose={onClose} footer={<>
    <Button variant="ghost" disabled={downloading} onClick={() => { void download() }}>{textSlot ? '提取源图片' : '提取当前图片'}</Button>
    <Button disabled={!resource.width || !resource.height} onClick={onReplace}>替换图片…</Button>
    <Button onClick={onClose}>关闭</Button>
  </>}>
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1"><p className="break-all select-text font-mono text-sm text-text-primary">{resource.key}</p><p className="mt-1 text-xs text-text-muted">{resource.usages.length} 个引用图层 · 源格式 {resource.mimeType.split('/')[1].toUpperCase()}</p></div>
        <Button size="sm" onClick={() => { void copyKey() }}>复制 Key</Button>
      </div>
      {copied && <p role="status" className="text-xs text-text-secondary">{copied}</p>}
      <OperationStatus status={downloadStatus} />
      <dl className="grid grid-cols-3 gap-2 text-xs">
        {[
          ['源图尺寸', resource.width && resource.height ? `${resource.width} × ${resource.height}` : '未知'],
          ['源图编码体积', formatResourceBytes(resource.byteSize)],
          ['源图解码估算', resource.decodedBytes === null ? '未知' : formatResourceBytes(resource.decodedBytes)]
        ].map(([label, value]) => <div key={label} className="rounded border border-border bg-bg-tertiary p-2"><dt className="text-text-muted">{label}</dt><dd className="mt-1 font-mono text-text-primary">{value}</dd></div>)}
      </dl>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="素材预览背景">
        <span className="mr-auto text-xs text-text-secondary">透明边缘检查</span>
        {[['checker', '透明格'], ['#000000', '黑色'], ['#ffffff', '白色']].map(([value, label]) => <button type="button" key={value} aria-pressed={background === value} onClick={() => setBackground(value)} className={cn('rounded border px-2 py-1 text-xs', background === value ? 'border-accent text-accent' : 'border-border text-text-secondary')}>{label}</button>)}
      </div>
      <div className={cn('grid gap-3', replacementUrl && 'sm:grid-cols-2')}>
        {[[sourceUrl, '源图片'], ...(replacementUrl ? [[replacementUrl, '当前替换图片']] : [])].map(([url, label]) => <figure key={label}>
          <div className="flex h-52 items-center justify-center overflow-hidden rounded border border-border" style={previewStyle}>
            {url ? <img src={url} alt={label} className="max-h-full max-w-full object-contain" /> : <span className="rounded bg-bg-secondary p-2 text-xs text-text-secondary">暂无图片预览</span>}
          </div><figcaption className="mt-1 text-xs text-text-muted">{label}</figcaption>
        </figure>)}
      </div>
      <p className="text-[11px] text-text-muted">背景仅辅助查看，不写入文件。解码按宽×高×4 估算，不含替换图、帧缓存与 GPU 开销，不等于进程内存。</p>
      {textSlot && <p className="text-xs text-warning">已配置文字插槽：这里仅展示源图，请在动画预览中检查文字合成结果。</p>}
      {advice.length > 0 && <section aria-label="素材检查建议" className="space-y-1 rounded border border-border bg-bg-tertiary p-3">{advice.map(message => <p key={message} className="text-xs leading-relaxed text-text-secondary">{message}</p>)}</section>}
      <section aria-label="引用图层"><h4 className="mb-2 text-xs font-medium text-text-primary">引用图层 · 点击定位</h4>
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {resource.usages.map(usage => <button type="button" key={usage.id} onClick={() => onLocate(usage.id)} title={`定位图层：${usage.name}`} className="flex w-full items-center gap-2 rounded bg-bg-tertiary px-3 py-2 text-left text-xs text-text-secondary hover:text-accent">
            <span className="min-w-0 flex-1 truncate">{usage.name}</span><span className="shrink-0 text-text-muted">{usage.matte ? (usage.image ? '图片 + 遮罩' : '遮罩') : '图片'}{!usage.visible ? ' · 隐藏' : ''}{usage.locked ? ' · 锁定' : ''}</span>
          </button>)}
          {!resource.usages.length && <p className="text-xs text-text-muted">当前无图层引用。查看素材不会自动新增图层。</p>}
        </div>
        <p className="mt-2 text-[11px] text-text-muted">定位会清除图层列表筛选并滚动到目标，不改变播放帧、显示状态或撤销历史。</p>
      </section>
    </div>
  </Modal>
}
