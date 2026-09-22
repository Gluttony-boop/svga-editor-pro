import { sameExportInputs } from './export-preview'

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'current' | 'disabled' | 'downloading' | 'ready' | 'installing' | 'error' | 'cancelled'

export interface UpdateMetadata {
  currentVersion?: string
  version: string
  date: string | null
  notes: string | null
}

export interface UpdateProgress {
  downloaded: number
  total: number | null
}

export interface UpdateStatus {
  phase: UpdatePhase
  message: string
  metadata?: UpdateMetadata
  progress?: UpdateProgress
  errorCode?: 'not-configured' | 'network' | 'signature' | 'version' | 'unknown'
}

export interface UpdateHandle {
  metadata: UpdateMetadata
  download(onProgress: (progress: UpdateProgress) => void): Promise<void>
  install(): Promise<void>
  close?(): Promise<void> | void
}

export interface UpdateAdapter {
  isDesktop: boolean
  check(): Promise<UpdateHandle | null>
}

export function classifyUpdateError(error: unknown): UpdateStatus['errorCode'] {
  const message = error instanceof Error ? error.message : String(error)
  if (/pubkey|public key|endpoint|updater.*config|not configured|未配置|公钥|端点|plugin.*not|not initialized|未初始化/i.test(message)) return 'not-configured'
  if (/signature|verify|签名|验签/i.test(message)) return 'signature'
  if (/version|downgrade|版本/i.test(message)) return 'version'
  if (/network|fetch|timeout|offline|连接|网络|超时/i.test(message)) return 'network'
  return 'unknown'
}

export function canInstallUpdate(input: {
  dirty: boolean
  busy: boolean
  exporting: boolean
  currentInputs: readonly unknown[]
  downloadedInputs: readonly unknown[]
}): { ok: true } | { ok: false; reason: string } {
  if (input.busy) return { ok: false, reason: '当前正在打开、保存或恢复工程，请完成后再安装更新。' }
  if (input.exporting) return { ok: false, reason: '当前正在生成导出文件，请完成后再安装更新。' }
  if (input.dirty) return { ok: false, reason: '工程有未保存修改，请先保存工程或明确放弃修改。' }
  if (!sameExportInputs(input.currentInputs, input.downloadedInputs)) return { ok: false, reason: '下载期间工程内容发生变化，请重新检查更新。' }
  return { ok: true }
}

export function updateStatusForError(error: unknown): UpdateStatus {
  const errorCode = classifyUpdateError(error)
  const messages: Record<NonNullable<UpdateStatus['errorCode']>, string> = {
    'not-configured': '桌面自动更新尚未配置公钥和 HTTPS 更新端点；当前未发起安装。',
    network: '暂时无法连接更新服务；工程和当前编辑不受影响，可稍后重试。',
    signature: '更新签名校验失败；已拒绝安装，不能回退到未签名文件。',
    version: '更新版本或平台不符合要求；已拒绝安装。',
    unknown: '检查更新失败；工程和当前编辑不受影响，可稍后重试。',
  }
  const resolvedCode = errorCode ?? 'unknown'
  return { phase: resolvedCode === 'not-configured' ? 'disabled' : 'error', message: messages[resolvedCode], errorCode: resolvedCode }
}

export function isTauriDesktopEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
