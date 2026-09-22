import { v4 as uuid } from 'uuid'
import { useEditorStore } from '@/stores/editorStore'
import type { ProjectDocument } from '@/types/project'
import type { LocalProjectPreferences, LocalProjectRepository } from '@/types/project-library'
import { createProjectArchive } from './project-archive'
import { captureExportInputs, sameExportInputs } from './export-preview'

export interface RecoveryStatus {
  phase: 'loading' | 'disabled' | 'idle' | 'pending' | 'saving' | 'saved' | 'error'
  message: string
  updatedAt?: number
}

interface RecoveryOptions {
  repository: LocalProjectRepository
  store?: typeof useEditorStore
  encode?: (document: ProjectDocument) => Promise<Blob>
  debounceMs?: number
  minIntervalMs?: number
  onStatus?: (status: RecoveryStatus) => void
}

interface DocumentContext {
  buffer: ArrayBuffer
  recoveryId: string
  recentId: string
  recoveryRevision: number
  recentRevision: number
}

type EditorState = ReturnType<typeof useEditorStore.getState>
type Inputs = readonly unknown[]

/** 名称只用于展示，原路径、控制字符和 Windows 非法字符不进入本地副本索引。 */
function safeName(value: string): string {
  let name = value.split(/[/\\]/).pop()!.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim()
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`
  // 截断可能再次留下尾点；与本机库的文件名校验保持一致。
  name = name.slice(0, 255).replace(/[. ]+$/, '')
  return name || '未命名工程.svgaproj'
}

function editing(state: EditorState): boolean {
  return state.isCanvasTransforming || state.isSlotConfigEditing
}

/**
 * 只订阅工程内容与输入事务，不把播放游标当成编辑。
 * 压缩任务串行执行；上下文代次与仓库代次分别防止切文件、清除缓存时的旧任务回写。
 */
export class ProjectRecoveryCoordinator {
  private readonly repository: LocalProjectRepository
  private readonly store: typeof useEditorStore
  private readonly encode: (document: ProjectDocument) => Promise<Blob>
  private readonly debounceMs: number
  private readonly minIntervalMs: number
  private readonly onStatus?: (status: RecoveryStatus) => void
  private preferences: LocalProjectPreferences | null = null
  private context: DocumentContext | null = null
  private baseline: { inputs: Inputs; reason: 'saved' | 'discarded' | 'error' } | null = null
  private observedInputs: Inputs | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingAt: number | null = null
  private lastAttemptAt: number | null = null
  private inFlight: Promise<void> | null = null
  private recentTail: Promise<void> = Promise.resolve()
  private unsubscribeStore?: () => void
  private unsubscribeRepository?: () => void
  private started = false
  private generation = 0
  private invalidation = 0
  private unappliedInvalidation = false
  private resolveInterrupted: () => void = () => {}
  private interrupted = new Promise<void>(resolve => { this.resolveInterrupted = resolve })
  private lifecycle = 0
  private settingsRequest = 0
  private flushing = 0
  private starting: Promise<void> | null = null

  constructor(options: RecoveryOptions) {
    this.repository = options.repository
    this.store = options.store ?? useEditorStore
    this.encode = options.encode ?? createProjectArchive
    this.debounceMs = Math.max(0, options.debounceMs ?? 3_000)
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 15_000)
    this.onStatus = options.onStatus
  }

  start(): Promise<void> {
    if (this.started) return this.starting ?? Promise.resolve()
    this.started = true
    this.lifecycle++
    this.preferences = null
    this.syncContext(this.store.getState())
    this.observedInputs = captureExportInputs(this.store.getState())
    this.publish({ phase: 'loading', message: '正在读取本地恢复设置…' })
    this.unsubscribeStore = this.store.subscribe((state, previous) => this.changed(state, previous))
    this.unsubscribeRepository = this.repository.subscribe(change => {
      if (change === 'invalidated') this.invalidate()
    })
    const starting = this.refreshSettings().finally(() => {
      if (this.starting === starting) this.starting = null
    })
    this.starting = starting
    return starting
  }

  stop(): void {
    this.started = false
    this.lifecycle++
    this.interrupt()
    this.cancelPending()
    this.unsubscribeStore?.()
    this.unsubscribeRepository?.()
    this.unsubscribeStore = undefined
    this.unsubscribeRepository = undefined
    // 卸载时不提交草稿，也不启动压缩；浏览器关闭不保证任何异步写入完成。
  }

  async flush(): Promise<void> {
    if (!this.started) return
    const lifecycle = this.lifecycle
    const generation = this.generation
    const interrupted = this.interrupted
    const active = () => this.started && this.lifecycle === lifecycle && this.generation === generation
    if (this.starting) await Promise.race([this.starting, interrupted])
    if (!active()) return
    // 手动备份可以重试失败或清除后的内容；已经保存的相同快照无需重复压缩。
    if (this.baseline?.reason !== 'saved') this.baseline = null
    this.flushing++
    try {
      await Promise.race([this.refreshSettings(), interrupted])
      if (!active()) return
      this.schedule(true)
      while (active() && (this.inFlight || this.pendingAt !== null)) {
        this.beginRun()
        // 停止、切文件或清除不会等待一个不可取消的压缩器；旧任务结束后仍受代次检查。
        if (this.inFlight) await Promise.race([this.inFlight, interrupted])
        else break
      }
    } finally {
      this.flushing--
    }
  }

  async recordRecent(archive: Blob, name: string): Promise<void> {
    if (!this.started) return
    this.syncContext(this.store.getState())
    const context = this.context
    if (!context) return
    const lifecycle = this.lifecycle
    const invalidation = this.invalidation
    const expectedEpoch = this.preferences?.epoch
    const current = () => this.started && this.lifecycle === lifecycle && this.context === context
      && this.invalidation === invalidation && this.store.getState().originalBuffer === context.buffer
    // 调用时就开始读取代次，不能等前一个最近工程写完再读取，避免清除后旧保存复活。
    // 立即接住拒绝，排队期间的读取失败也不会产生无人处理的 Promise rejection。
    const snapshot = this.repository.snapshot().then(
      value => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    )
    const task = this.recentTail.catch(() => undefined).then(async () => {
      const read = await snapshot
      if (!current()) return
      if (!read.value) throw read.error
      const { preferences } = read.value
      if ((expectedEpoch !== undefined && expectedEpoch !== preferences.epoch) || !preferences.recentEnabled) return
      const result = await this.repository.put({
        id: context.recentId, kind: 'recent', name: safeName(name), archive,
        size: archive.size, updatedAt: Date.now(), revision: ++context.recentRevision
      }, preferences.epoch)
      if (result !== 'stored' && current()) this.invalidate()
    })
    this.recentTail = task
    await task
  }

  async saved(): Promise<void> {
    const state = this.store.getState()
    // 只有 App 确认同一份编辑内容已写盘并标记干净后，才允许删除它的恢复副本。
    if (!this.started || state.isDirty || editing(state)) return
    this.syncContext(state)
    const context = this.context
    if (!context) return
    this.interrupt()
    this.cancelPending()
    const inputs = captureExportInputs(state)
    this.baseline = { inputs, reason: 'saved' }
    await this.repository.remove(context.recoveryId)
    // remove 会广播失效；只有删除期间没有新增编辑，才重新确认这一份已保存基线。
    if (this.started && this.context === context && !this.store.getState().isDirty
      && !editing(this.store.getState()) && sameExportInputs(inputs, captureExportInputs(this.store.getState()))) {
      this.baseline = { inputs, reason: 'saved' }
    }
    await this.refreshSettings()
  }

  invalidate(): void {
    this.interrupt()
    this.invalidation++
    this.unappliedInvalidation = true
    this.cancelPending()
    this.baseline = { inputs: captureExportInputs(this.store.getState()), reason: 'discarded' }
    if (!this.started) return
    this.publish({ phase: 'idle', message: '本地副本已更新；下一次编辑后再自动备份。' })
    void this.refreshSettings()
  }

  async refreshSettings(): Promise<void> {
    if (!this.started) return
    const request = ++this.settingsRequest
    const lifecycle = this.lifecycle
    try {
      const { preferences } = await this.repository.snapshot()
      if (!this.started || lifecycle !== this.lifecycle || request !== this.settingsRequest) return
      this.applyPreferences(preferences)
    } catch (error) {
      if (this.started && lifecycle === this.lifecycle && request === this.settingsRequest) {
        this.fail(error, captureExportInputs(this.store.getState()))
      }
    }
  }

  private applyPreferences(preferences: LocalProjectPreferences): void {
    const previous = this.preferences
    if (previous && previous.epoch !== preferences.epoch && !this.unappliedInvalidation) {
      this.interrupt()
      this.invalidation++
      this.cancelPending()
      this.baseline = { inputs: captureExportInputs(this.store.getState()), reason: 'discarded' }
    }
    // 失效事件已在发生时捕获基线，异步读取设置不能吞掉事件之后的第一次新编辑。
    this.unappliedInvalidation = false
    this.preferences = { ...preferences }
    if (!preferences.recoveryEnabled) {
      this.cancelPending()
      this.publish({ phase: 'disabled', message: '自动恢复已关闭，已有本地副本仍保留。' })
      return
    }
    if (previous && !previous.recoveryEnabled) this.baseline = null
    if (this.eligible()) {
      if (this.pendingAt === null) this.schedule()
    } else if (!this.inFlight && this.baseline?.reason !== 'error') {
      this.publish({ phase: 'idle', message: '自动恢复已就绪；未完成的输入草稿不会备份。' })
    }
  }

  private syncContext(state: EditorState): void {
    if (state.originalBuffer === (this.context?.buffer ?? null)) return
    this.interrupt()
    this.cancelPending()
    this.baseline = null
    this.lastAttemptAt = null
    this.context = state.originalBuffer ? {
      buffer: state.originalBuffer, recoveryId: `recovery:${uuid()}`, recentId: `recent:${uuid()}`,
      recoveryRevision: 0, recentRevision: 0
    } : null
  }

  private changed(state: EditorState, previous: EditorState): void {
    const inputs = captureExportInputs(state)
    const contentChanged = !this.observedInputs || !sameExportInputs(inputs, this.observedInputs)
    const transactionChanged = editing(state) !== editing(previous)
    this.observedInputs = inputs
    this.syncContext(state)
    if (!contentChanged && state.isDirty === previous.isDirty && !transactionChanged) return
    if (!state.isDirty) {
      this.interrupt()
      this.cancelPending()
      if (this.preferences) this.publish({ phase: this.preferences.recoveryEnabled ? 'idle' : 'disabled', message: '当前工程没有未保存的修改。' })
      return
    }
    if (editing(state)) {
      if (transactionChanged) this.interrupt()
      this.cancelPending()
      if (this.preferences?.recoveryEnabled) this.publish({ phase: 'pending', message: '完成当前输入后自动备份，不会打断编辑。' })
      return
    }
    this.schedule()
  }

  private eligible(): boolean {
    const state = this.store.getState()
    return this.started && Boolean(this.preferences?.recoveryEnabled && this.context
      && state.videoItem && state.params && state.originalBuffer && state.isDirty && !editing(state))
      && !(this.baseline && sameExportInputs(this.baseline.inputs, captureExportInputs(state)))
  }

  private schedule(immediate = false): void {
    if (!this.eligible()) return
    const now = Date.now()
    this.pendingAt = immediate || this.flushing > 0 ? now
      : Math.max(now + this.debounceMs, (this.lastAttemptAt ?? -Infinity) + this.minIntervalMs)
    this.publish({ phase: 'pending', message: '修改已排队，稍后保存本地恢复副本。' })
    this.armTimer()
  }

  private armTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (!this.started || this.inFlight || this.pendingAt === null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.beginRun()
    }, Math.max(0, this.pendingAt - Date.now()))
  }

  private beginRun(): void {
    if (this.inFlight || this.pendingAt === null || this.pendingAt > Date.now()) return
    this.cancelPending()
    if (!this.eligible()) return
    const task = this.run().finally(() => {
      if (this.inFlight === task) this.inFlight = null
      this.armTimer()
    })
    this.inFlight = task
  }

  private async run(): Promise<void> {
    const context = this.context!
    const generation = this.generation
    let inputs = captureExportInputs(this.store.getState())
    try {
      // 代次必须在压缩前读取，clear/disable 会让仓库原子拒绝旧任务的写入。
      const { preferences } = await this.repository.snapshot()
      if (!this.current(context, generation)) return
      if (preferences.epoch !== this.preferences?.epoch || !preferences.recoveryEnabled) {
        this.applyPreferences(preferences)
        return
      }
      if (!this.eligible()) return
      const state = this.store.getState()
      inputs = captureExportInputs(state)
      const document = state.captureProjectRecovery()
      if (!document) return
      this.lastAttemptAt = Date.now()
      this.publish({ phase: 'saving', message: '正在保存本地恢复副本…' })
      const archive = await this.encode(document)
      if (!this.current(context, generation) || !this.eligible()
        || !sameExportInputs(inputs, captureExportInputs(this.store.getState()))) return
      const result = await this.repository.put({
        id: context.recoveryId, kind: 'recovery', name: safeName(this.store.getState().projectName || document.name),
        archive, size: archive.size, updatedAt: Date.now(), revision: ++context.recoveryRevision
      }, preferences.epoch)
      if (!this.current(context, generation)) return
      if (result !== 'stored') {
        this.invalidate()
        return
      }
      // 写入过程中新增的编辑仍保留在队列中，不能错误显示为已备份最新内容。
      if (sameExportInputs(inputs, captureExportInputs(this.store.getState())) && !editing(this.store.getState())) {
        this.baseline = { inputs, reason: 'saved' }
        this.cancelPending()
        this.publish({ phase: 'saved', message: '已保存本地恢复副本，工程文件仍需手动保存。', updatedAt: Date.now() })
      }
    } catch (error) {
      if (this.current(context, generation) && sameExportInputs(inputs, captureExportInputs(this.store.getState()))) this.fail(error, inputs)
    }
  }

  private current(context: DocumentContext, generation: number): boolean {
    return this.started && this.context === context && this.generation === generation
      && this.store.getState().originalBuffer === context.buffer
  }

  private interrupt(): void {
    this.generation++
    this.resolveInterrupted()
    this.interrupted = new Promise(resolve => { this.resolveInterrupted = resolve })
  }

  private fail(error: unknown, inputs: Inputs): void {
    this.baseline = { inputs, reason: 'error' }
    this.cancelPending()
    this.publish({ phase: 'error', message: `本地备份失败，已有副本未删除：${error instanceof Error ? error.message : '未知错误'}。可手动重试。` })
  }

  private cancelPending(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pendingAt = null
  }

  private publish(status: RecoveryStatus): void {
    if (this.started) this.onStatus?.(status)
  }
}
