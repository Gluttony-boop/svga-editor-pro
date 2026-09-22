import { CommitNumberField } from '@/components/ui/CommitNumberField'
import type { OptimizationConfig } from '@/core/optimizer'

const MAX_IMAGE_DIMENSION = 8192
const DEFAULT_SIZE_LIMIT = 512

type ImageConfig = OptimizationConfig['image']

export interface ImageResizeControlsProps {
  image: ImageConfig
  canvasSize: { width: number; height: number } | null
  disabled?: boolean
  onChange: (image: ImageConfig) => void
}

const clampDimension = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(MAX_IMAGE_DIMENSION, Math.round(value)))
}

const hasPositiveLimit = (value: number): boolean => Number.isFinite(value) && value > 0

/**
 * 导出图片的尺寸限制设置。这里不订阅编辑器状态，配置变化由调用方统一提交。
 */
export function ImageResizeControls({ image, canvasSize, disabled = false, onChange }: ImageResizeControlsProps) {
  // 旧工程只保存 resizeEnabled；仅当旧配置确实有宽高上限时才迁移为指定尺寸模式。
  const sizeLimitEnabled = image.sizeLimitEnabled
    ?? (image.resizeEnabled && (image.maxWidth > 0 || image.maxHeight > 0))
  const widthLimit = clampDimension(image.maxWidth)
  const heightLimit = clampDimension(image.maxHeight)
  const limitText = widthLimit === 0 && heightLimit === 0 ? '当前不限制指定尺寸。' : `当前上限：${widthLimit || '不限'} × ${heightLimit || '不限'} px。`
  const canvasText = canvasSize && Number.isFinite(canvasSize.width) && Number.isFinite(canvasSize.height) && canvasSize.width > 0 && canvasSize.height > 0
    ? `最大按 ${Math.round(canvasSize.width)} × ${Math.round(canvasSize.height)} px 等比缩小。`
    : '按当前导出画布等比缩小。'

  const updateImage = (update: Partial<ImageConfig>) => onChange({ ...image, ...update })

  const toggleSizeLimit = (enabled: boolean) => {
    if (!enabled) {
      updateImage({ sizeLimitEnabled: false })
      return
    }

    // 旧工程可能只有 resizeEnabled；首次打开指定尺寸时保留已有上限，否则给出可编辑的默认值。
    const hasExistingLimit = hasPositiveLimit(image.maxWidth) || hasPositiveLimit(image.maxHeight)
    updateImage({
      sizeLimitEnabled: true,
      ...(!hasExistingLimit ? { maxWidth: DEFAULT_SIZE_LIMIT, maxHeight: DEFAULT_SIZE_LIMIT } : {})
    })
  }

  const commitDimension = (key: 'maxWidth' | 'maxHeight', value: number) => {
    updateImage({ [key]: clampDimension(value) })
  }

  const applySquareLimit = (size: number) => {
    updateImage({ sizeLimitEnabled: true, maxWidth: size, maxHeight: size })
  }

  const numberDefaults = {
    disabled: disabled || !sizeLimitEnabled,
    context: image,
    min: 0,
    max: MAX_IMAGE_DIMENSION,
    step: 1,
    onStart: () => {},
  }

  return (
    <section aria-label="图片尺寸缩减" className="space-y-2 rounded border border-border bg-bg-secondary/60 p-2.5">
      <div className="space-y-2">
        <label className="flex cursor-pointer items-start gap-2 rounded border border-accent/25 bg-accent/5 p-2">
          <input
            type="checkbox"
            aria-label="按指定尺寸缩减图片"
            checked={sizeLimitEnabled}
            disabled={disabled}
            onChange={event => toggleSizeLimit(event.target.checked)}
            className="mt-0.5 rounded accent-accent"
          />
          <span className="min-w-0 text-xs text-text-secondary">
            <span className="block font-medium text-text-primary">按指定尺寸缩减图片</span>
            <span className="mt-0.5 block text-[10px] leading-relaxed text-text-muted">小图不会放大或裁切，百分比与画布限制会叠加取更小值。</span>
          </span>
        </label>

        {sizeLimitEnabled && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <CommitNumberField
                {...numberDefaults}
                label="最大宽度"
                accessibleLabel="图片最大宽度"
                value={widthLimit}
                unit="px"
                onCommit={value => commitDimension('maxWidth', value)}
              />
              <CommitNumberField
                {...numberDefaults}
                label="最大高度"
                accessibleLabel="图片最大高度"
                value={heightLimit}
                unit="px"
                onCommit={value => commitDimension('maxHeight', value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-text-muted">
              <span>快捷尺寸</span>
              {[256, 512, 1024].map(size => (
                <button
                  key={size}
                  type="button"
                  aria-label={`设置图片最大尺寸为 ${size}×${size} px`}
                  disabled={disabled}
                  onClick={() => applySquareLimit(size)}
                  className="rounded border border-border bg-bg-tertiary px-1.5 py-0.5 hover:border-accent hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                >{size}×{size}</button>
              ))}
            </div>
            <p className="text-[10px] leading-relaxed text-text-muted">{limitText}</p>
          </>
        )}

        <label className="flex cursor-pointer items-start gap-2 rounded border border-border bg-bg-tertiary/60 p-2">
          <input
            type="checkbox"
            aria-label="按当前画布自动缩减图片尺寸"
            checked={image.autoResizeToCanvas ?? false}
            disabled={disabled}
            onChange={event => updateImage({ autoResizeToCanvas: event.target.checked })}
            className="mt-0.5 rounded accent-accent"
          />
          <span className="min-w-0 text-xs text-text-secondary">
            <span className="block font-medium text-text-primary">按当前画布自动缩减图片尺寸</span>
            <span className="mt-0.5 block text-[10px] leading-relaxed text-text-muted">{canvasText}只影响导出图片纹理，不改变画布、图层坐标和动画时序。</span>
          </span>
        </label>
      </div>

      <p className="text-[10px] leading-relaxed text-text-muted">仅影响导出纹理，动画布局不变；更小才替换，建议先预览。输入按 Enter / 失焦应用，Esc 取消。</p>
    </section>
  )
}
