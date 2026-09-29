import type { ImageReplacementScope } from '@/core/image-replacement'
import type { ResourceUsage } from '@/utils/resource-usage'

export function ReplacementScopeControls({ scope, onChange, currentLayerId, currentLayerError, usages }: {
  scope: ImageReplacementScope
  onChange: (scope: ImageReplacementScope) => void
  currentLayerId?: string
  currentLayerError?: string
  usages: ResourceUsage[]
}) {
  const affected = scope === 'current-layer' ? usages.filter(usage => usage.id === currentLayerId) : usages
  return <section aria-label="图片替换范围" className="space-y-2 rounded border border-border p-3">
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">替换范围</legend>
      <label className="flex items-start gap-2 text-xs">
        <input type="radio" name="image-replacement-scope" value="current-layer" checked={scope === 'current-layer'} disabled={!!currentLayerError || !currentLayerId} onChange={() => onChange('current-layer')} />
        <span>仅当前图层<span className="mt-0.5 block text-text-muted">创建独立资源，保留动画、顺序和文字配置；其他引用不变。</span></span>
      </label>
      {currentLayerError && <p className="pl-5 text-xs text-warning">{currentLayerError}</p>}
      <label className="flex items-start gap-2 text-xs">
        <input type="radio" name="image-replacement-scope" value="all-references" checked={scope === 'all-references'} onChange={() => onChange('all-references')} />
        <span>所有引用图层（{usages.length}）<span className="mt-0.5 block text-text-muted">包括隐藏、锁定图层和遮罩引用；不会新增图层。</span></span>
      </label>
    </fieldset>
    <div className="border-t border-border pt-2">
      <p className="mb-1 text-xs text-text-secondary">将影响 {affected.length} 个图层</p>
      <ul aria-label="本次替换影响的图层" className="max-h-28 space-y-1 overflow-y-auto text-xs">
        {affected.map(usage => <li key={usage.id} className="flex gap-2">
          <span className="min-w-0 flex-1 truncate" title={usage.name}>{usage.name}</span>
          {usage.id === currentLayerId && <span className="shrink-0 text-accent">当前图层</span>}
          <span className="shrink-0 text-text-muted">{usage.matte ? '遮罩引用' : '图片'}{!usage.visible ? ' · 隐藏' : ''}{usage.locked ? ' · 锁定' : ''}</span>
        </li>)}
      </ul>
      {!affected.length && <p className="text-xs text-text-muted">{scope === 'current-layer' ? '尚未确认有效的当前图层，不会应用替换。' : '此资源当前没有图层引用；仅保存资源替换设置。'}</p>}
    </div>
  </section>
}
