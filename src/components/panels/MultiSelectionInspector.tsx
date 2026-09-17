import React from 'react'
import { Icon } from '@/components/ui'
import type { Layer } from '@/types'

interface MultiSelectionInspectorProps {
  layers: Layer[]
  primaryLayer: Layer | undefined
  onKeepPrimary: () => void
}

/** 多选只展示范围与操作语义，避免将主图层数值误认为整组选区参数。 */
export const MultiSelectionInspector: React.FC<MultiSelectionInspectorProps> = ({ layers, primaryLayer, onKeepPrimary }) => {
  const protectedCount = layers.filter(layer => layer.locked || !layer.visible).length

  return (
    <section aria-label="多图层选择" className="space-y-3 rounded border border-accent/30 bg-accent/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
          <Icon name="layer" size={14} />
          已选 {layers.length} 层
        </div>
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">临时选区</span>
      </div>

      <p className="text-[11px] leading-relaxed text-text-secondary">
        在画布上整体移动、等比缩放或旋转，各图层保留原动画。一次拖动只生成一条撤销记录。
      </p>

      {primaryLayer && (
        <div className="space-y-2 rounded border border-border bg-bg-secondary px-2 py-2">
          <div className="flex min-w-0 items-center gap-2 text-[11px]">
            <span className="flex-shrink-0 text-text-muted">主选中</span>
            <span className="min-w-0 truncate text-text-primary" title={primaryLayer.name}>{primaryLayer.name}</span>
          </div>
          <button
            type="button"
            className="text-[11px] text-accent hover:underline"
            onClick={onKeepPrimary}
            title="恢复单选后可精确输入该图层的位置、缩放和旋转"
          >仅保留主图层</button>
        </div>
      )}

      {protectedCount > 0 && (
        <p className="text-[11px] leading-relaxed text-warning">
          选区包含 {protectedCount} 个锁定或隐藏图层。请先解锁、显示或移出选区后再整体调整。
        </p>
      )}

      <div className="space-y-1 border-t border-border pt-2 text-[10px] leading-relaxed text-text-muted">
        <p>Shift / Ctrl / ⌘ 单击图层可追加或移出选择；单击其他图层恢复单选。</p>
        <p>暂未创建永久编组，也不会自动生成关键帧。单层参数需恢复单选后调整。</p>
      </div>
    </section>
  )
}
