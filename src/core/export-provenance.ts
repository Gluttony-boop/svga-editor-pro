import type { Layer, SlotConfig } from '@/types'
import type { ExportSpriteBinding } from '@/types/export-artifact'
import { findExportSlotSourceKey } from './text-export'

export interface ExportProvenanceOptions {
  signal?: AbortSignal
  /** 在实际输出 sprite 顺序确定、图片 Key 规范化之后调用。 */
  onBindings?: (bindings: ExportSpriteBinding[]) => void
}

export function throwIfExportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已取消导出', 'AbortError')
}

/** 必须在发出 sprite 的代码路径调用；不允许事后按数组位置或名称拼凑身份。 */
export function createExportSpriteBinding(
  spriteIndex: number,
  layer: Layer | undefined,
  originalSpriteIndex: number | null,
  sourceImageKey: string | null | undefined,
  exportImageKey: string | null | undefined,
  slots?: Record<string, SlotConfig>
): ExportSpriteBinding {
  return {
    spriteIndex,
    layerId: layer?.id ?? null,
    originalSpriteIndex,
    sourceImageKey: sourceImageKey || null,
    sourceSlotKey: findExportSlotSourceKey(slots, layer, sourceImageKey, exportImageKey),
    baselineImageKey: null
  }
}

export function emitExportBindings(
  options: ExportProvenanceOptions,
  bindings: ExportSpriteBinding[],
  sprites: ReadonlyArray<{ imageKey?: string | null }> | null | undefined
): void {
  throwIfExportAborted(options.signal)
  if (!options.onBindings) return
  if (bindings.length !== (sprites?.length ?? 0)) {
    throw new Error('导出图层来源与实际 sprite 数量不一致，已取消导出')
  }
  options.onBindings(bindings.map((binding, index) => ({
    ...binding,
    spriteIndex: index,
    baselineImageKey: sprites?.[index].imageKey || null
  })))
}
