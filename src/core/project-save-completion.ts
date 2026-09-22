import { useEditorStore } from '@/stores/editorStore'
import { captureExportInputs, sameExportInputs } from './export-preview'

interface RecoveryBookkeeping {
  saved(): Promise<void>
  recordRecent(archive: Blob, name: string): Promise<void>
}

/** 文件写入已成功后再调用；本机缓存失败不能把已经保存的工程误报为写盘失败。 */
export async function finishProjectSave(options: {
  archive: Blob
  inputs: readonly unknown[]
  displayName: string
  filePath: string | null
  recovery?: RecoveryBookkeeping | null
}): Promise<{ current: boolean; localWarning?: string }> {
  const state = useEditorStore.getState()
  const buffer = state.originalBuffer
  if (!state.markProjectSaved(options.inputs, options.filePath, options.displayName)) return { current: false }
  const warnings: string[] = []
  if (options.recovery) {
    try { await options.recovery.saved() }
    catch { warnings.push('工程文件已写入，但旧恢复副本未能清理。') }
    // 清理库的 await 期间可能切换文件；不得将旧工程记入新文档的最近副本。
    if (useEditorStore.getState().originalBuffer === buffer) {
      try { await options.recovery.recordRecent(options.archive, options.displayName) }
      catch { warnings.push('未能更新最近工程的本机副本，请保留已保存的工程文件。') }
    }
  }
  const latest = useEditorStore.getState()
  const current = !latest.isDirty && !latest.isCanvasTransforming && !latest.isSlotConfigEditing
    && sameExportInputs(options.inputs, captureExportInputs(latest))
  return { current, ...(warnings.length ? { localWarning: warnings.join(' ') } : {}) }
}
