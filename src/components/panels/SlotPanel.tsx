import React from 'react'
import { Panel, Icon, Button } from '@/components/ui'
import { useEditorStore } from '@/stores'
import { cn } from '@/utils/cn'
import { buildSlotCatalog } from '@/utils/slot-catalog'
import { normalizeTextConfig } from '@/core/text-preview'
import { saveGeneratedFile } from '@/core/exporter'
import { SlotEditor } from './SlotEditor'

const BatchPreflightDialog = React.lazy(() => import('../editor/BatchPreflightDialog').then(module => ({ default: module.BatchPreflightDialog })))

interface SlotPanelProps { className?: string; collapsible?: boolean; defaultCollapsed?: boolean }
const FILTERS = [['all', '全部'], ['image', '图片 Key'], ['text', '文字候选'], ['configured', '已配文字']] as const
type KeyFilter = typeof FILTERS[number][0]

export const SlotPanel: React.FC<SlotPanelProps> = ({ className, collapsible = true, defaultCollapsed = false }) => {
  const slotConfigs = useEditorStore(state => state.slotConfigs)
  const video = useEditorStore(state => state.videoItem)
  const layers = useEditorStore(state => state.layers)
  const resources = useEditorStore(state => state.imageResources)
  const [search, setSearch] = React.useState('')
  const [filter, setFilter] = React.useState<KeyFilter>('all')
  const [activeKey, setActiveKey] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [showBatch, setShowBatch] = React.useState(false)
  const catalog = React.useMemo(() => buildSlotCatalog(video, layers, resources, slotConfigs), [video, layers, resources, slotConfigs])
  const matches = (item: typeof catalog[number], id: KeyFilter) => id === 'all' || id === 'image' && item.imageAvailable || id === 'text' && item.textCandidate || id === 'configured' && item.textConfigured
  const filtered = catalog.filter(item => matches(item, filter) && (!search.trim() || item.key.toLowerCase().includes(search.trim().toLowerCase())))
  const selected = catalog.find(item => item.key === activeKey) || filtered.find(item => item.textConfigured) || filtered.find(item => item.textCandidate) || filtered[0]
  React.useEffect(() => { setActiveKey(null); setNotice(''); setSearch(''); setFilter('all') }, [video])

  const exportConfig = async () => {
    useEditorStore.getState().endSlotConfigEdit(true)
    const current = useEditorStore.getState()
    const keys = buildSlotCatalog(current.videoItem, current.layers, current.imageResources, current.slotConfigs)
    const data = {
      format: 'svga-text-preview', version: 1,
      description: '设计文字配置，不包含字体文件，并非 SVGA 协议字段。exportMode 缺省或 preview 表示仅模拟文字，已配置的范围会在 SVGA 导出时写入；bake 表示导出时将启用且非空的当前字形写入图片资源。本 JSON 只是配置，不证明任何 SVGA 已按其生成。请核对实际交付文件；若已包含字形，不得再次叠加相同文字。动态文字需按播放器 API 接入；图层改名导出可能改变 Key。',
      entries: keys.filter(item => item.textConfigured).map(item => {
        const slot = Object.prototype.hasOwnProperty.call(current.slotConfigs, item.key) ? current.slotConfigs[item.key] : undefined
        return { key: item.key, layerIds: item.referenceLayerIds, textConfig: normalizeTextConfig(slot?.textConfig, slot?.type === 'text' ? slot.value : null) }
      })
    }
    setSaving(true)
    try {
      const saved = await saveGeneratedFile(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'text-preview.json')
      setNotice(saved ? '文字配置已保存；请核对实际 SVGA，若已按写入模式导出，不要重复叠字。' : '已取消保存配置')
    } catch (error) { setNotice('配置保存失败：' + (error instanceof Error ? error.message : String(error))) }
    finally { setSaving(false) }
  }

  return <><Panel title="插槽与 Key" icon={<Icon name="key" size={16} />} className={className} collapsible={collapsible} defaultCollapsed={defaultCollapsed} contentClassName="p-3">
    {!video ? <p className="py-6 text-center text-xs text-text-muted">打开 SVGA 后识别图片 Key 与文字候选</p> : <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-text-muted">动态图片和文字共用 imageKey。文字类型仅按命名推测，可选择普通图片 Key 手动模拟；已栅格化的文字无法自动还原。</p>
      <Button size="sm" className="w-full" disabled={!catalog.some(item => item.canSimulateText)} onClick={() => setShowBatch(true)}>批量文案预检…</Button>
      <input type="search" aria-label="搜索图片或文字 Key" placeholder="搜索完整 Key…" value={search} onChange={event => setSearch(event.target.value)} className="w-full rounded border border-border bg-bg-primary px-2 py-1.5 text-xs focus:border-accent outline-none" />
      <div role="group" aria-label="Key 类型筛选" className="flex flex-wrap gap-1">
        {FILTERS.map(([id, label]) => <button type="button" key={id} onClick={() => setFilter(id)} aria-pressed={filter === id}
          className={cn('rounded px-1.5 py-1 text-[10px]', filter === id ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary')}>
          {label} {catalog.filter(item => matches(item, id)).length}
        </button>)}
      </div>
      <div aria-label="Key 列表" className="max-h-48 space-y-1 overflow-auto rounded border border-border p-1">
        {filtered.map(item => <button key={item.key} type="button" aria-label={'检查 Key：' + item.key} aria-pressed={selected?.key === item.key}
          onClick={() => { useEditorStore.getState().endSlotConfigEdit(true); setActiveKey(item.key); setNotice('') }}
          className={cn('block w-full rounded px-2 py-1.5 text-left', selected?.key === item.key ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-tertiary')}>
          <span className="block truncate font-mono text-xs" title={item.key}>{item.key}</span>
          <span className="block text-[10px] text-text-muted">{item.imageAvailable ? '图片' : '无位图'}{item.textCandidate ? ' · 疑似文字' : ''}{item.textConfigured ? ' · 已配文字' : ''}{item.isMatte ? ' · 遮罩' : ''}{item.isVector ? ' · 矢量' : ''} · {item.referenceLayerIds.length} 层</span>
        </button>)}
        {!filtered.length && <p className="p-2 text-xs text-text-muted">此筛选下没有 Key，可切回“全部”并手动选择图片 Key。</p>}
      </div>
      {selected && <SlotEditor key={selected.key} entry={selected} config={Object.prototype.hasOwnProperty.call(slotConfigs, selected.key) ? slotConfigs[selected.key] : undefined} />}
      <Button size="sm" disabled={saving || !catalog.some(item => item.textConfigured)} onClick={() => void exportConfig()}>导出文字配置 JSON</Button>
      {notice && <p role="status" className="text-xs text-text-secondary">{notice}</p>}
    </div>}
  </Panel>
    {showBatch && <React.Suspense fallback={<p role="status">正在加载批量预检…</p>}>
      <BatchPreflightDialog initialKey={selected?.key} onClose={() => setShowBatch(false)} />
    </React.Suspense>}
  </>
}
