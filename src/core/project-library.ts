import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import type {
  LocalProjectPreferences,
  LocalProjectRecord,
  LocalProjectRepository,
  LocalProjectSnapshot,
  LocalProjectSummary
} from '@/types/project-library'
import { MAX_PROJECT_BYTES } from './project-validation'

export const PROJECT_LIBRARY_DB = 'svga-editor-local-projects-v1'
export const PROJECT_LIBRARY_MAX_BYTES = 256 * 1024 * 1024
export const PROJECT_LIBRARY_MAX_RECOVERY = 5
export const PROJECT_LIBRARY_MAX_RECENT = 8

const PREFERENCES_KEY = 'preferences'
type LibraryChange = 'written' | 'invalidated'
type LibraryMode = 'readonly' | 'readwrite'

interface ProjectLibrarySchema extends DBSchema {
  entries: { key: string; value: LocalProjectRecord }
  meta: { key: string; value: LocalProjectPreferences }
}

type LibraryTransaction<Mode extends LibraryMode> = IDBPTransaction<ProjectLibrarySchema, ['entries', 'meta'], Mode>

class LocalProjectStorageError extends Error {}

function storageError(message: string): LocalProjectStorageError {
  return new LocalProjectStorageError(message)
}

function actionableError(error: unknown): Error {
  if (error instanceof LocalProjectStorageError) return error
  const name = error instanceof Error ? error.name : ''
  if (name === 'QuotaExceededError') {
    return storageError('本机工程存储空间不足，原有副本已保留。请先保存工程到文件，再删除不需要的本机副本。')
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return storageError('当前浏览器或系统禁止本机工程存储。请检查隐私设置，并主动保存工程到文件。')
  }
  if (name === 'VersionError') {
    return storageError('本机工程库由更新版本创建。请更新应用，不要清除仍需恢复的工程副本。')
  }
  return storageError('本机工程存储操作失败，未确认写入成功。请重新打开应用，并主动保存工程到文件；原有副本不会被自动清空。')
}

function validInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function validateId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw storageError('本机工程标识无效，请重新打开原工程后重试。')
  }
}

function preferencesFrom(value: unknown): LocalProjectPreferences {
  if (!value || typeof value !== 'object') throw storageError('本机工程库设置损坏，请先保存当前工程到文件；不会自动重置存储设置。')
  const preferences = value as LocalProjectPreferences
  if (typeof preferences.recoveryEnabled !== 'boolean' || typeof preferences.recentEnabled !== 'boolean' || !validInteger(preferences.epoch)) {
    throw storageError('本机工程库设置损坏，请先保存当前工程到文件；不会自动重置存储设置。')
  }
  return {
    recoveryEnabled: preferences.recoveryEnabled,
    recentEnabled: preferences.recentEnabled,
    epoch: preferences.epoch
  }
}

function recordFrom(value: unknown): LocalProjectRecord {
  if (!value || typeof value !== 'object') throw storageError('本机工程副本记录损坏，可手动删除该副本后重试。')
  const record = value as LocalProjectRecord
  validateId(record.id)
  if (record.kind !== 'recovery' && record.kind !== 'recent') throw storageError('本机工程副本类别无效。')
  if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 255
    || /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(record.name) || /[. ]$/.test(record.name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(record.name)) {
    throw storageError('工程显示名称无效，请使用不含路径或特殊文件字符的名称（最多 255 字符）。')
  }
  if (!validInteger(record.updatedAt) || !validInteger(record.revision)) throw storageError('本机工程副本的时间或版本号无效。')
  // 用原生 Blob 的 getter 进行品牌校验，不能信任被覆盖的 size 或仿造的普通对象。
  let archiveSize: number
  try {
    const sizeGetter = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get
    if (!sizeGetter) throw new Error('Blob unavailable')
    archiveSize = sizeGetter.call(record.archive)
  } catch {
    throw storageError('本机工程副本必须包含真实的 Blob 工程内容。')
  }
  if (!validInteger(record.size) || record.size <= 0 || record.size !== archiveSize || record.size > MAX_PROJECT_BYTES) {
    throw storageError('本机工程副本大小无效，单个工程必须大于 0 且不超过 128 MiB。')
  }
  // 白名单复制，禁止调用方的磁盘路径、句柄或其它元数据进入本机副本库。
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    updatedAt: record.updatedAt,
    size: archiveSize,
    revision: record.revision,
    archive: record.archive
  }
}

function summaryOf(record: LocalProjectRecord): LocalProjectSummary {
  return {
    id: record.id, kind: record.kind, name: record.name,
    updatedAt: record.updatedAt, size: record.size, revision: record.revision
  }
}

function nextPreferences(preferences: LocalProjectPreferences): LocalProjectPreferences {
  if (preferences.epoch >= Number.MAX_SAFE_INTEGER) throw storageError('本机工程库代次已超出可用范围，请先导出重要工程副本。')
  return { ...preferences, epoch: preferences.epoch + 1 }
}

/** 本机恢复库只保存归档字节，不解压工程，也不读取或覆盖原磁盘文件。 */
export function createProjectLibrary(options: { name?: string; broadcast?: boolean } = {}): LocalProjectRepository {
  const name = options.name ?? PROJECT_LIBRARY_DB
  let closed = false
  let failure: Error | undefined
  let connection: IDBPDatabase<ProjectLibrarySchema> | undefined
  let channel: BroadcastChannel | undefined
  const listeners = new Set<(change: LibraryChange) => void>()

  const notify = (change: LibraryChange) => {
    if (closed) return
    for (const listener of listeners) {
      // 一名观察者报错不能把已经提交的事务误报为失败，或阻止其他窗口收到失效通知。
      try { listener(change) } catch { /* 观察者负责呈现自己的界面错误。 */ }
    }
  }

  const publish = (change: LibraryChange) => {
    notify(change)
    try { channel?.postMessage({ type: change }) } catch { /* 事务中的 epoch 仍保证旧写入不会复活。 */ }
  }

  if (options.broadcast !== false && typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(`svga-editor:local-projects:${name}`)
      channel.onmessage = event => {
        const data: unknown = event.data
        if (!data || typeof data !== 'object' || Object.keys(data).length !== 1 || !('type' in data)) return
        if (data.type === 'written' || data.type === 'invalidated') notify(data.type)
      }
    } catch { /* 某些隐私模式禁止广播，本机库仍依赖 IndexedDB 事务安全运行。 */ }
  }

  const database = new Promise<IDBPDatabase<ProjectLibrarySchema>>((resolve, reject) => {
    const fail = (error: Error) => {
      failure = error
      connection?.close()
      reject(error)
    }
    try {
      if (typeof indexedDB === 'undefined') throw storageError('当前环境不支持本机工程存储，请主动保存工程到文件。')
      void openDB<ProjectLibrarySchema>(name, 1, {
        upgrade(db, oldVersion, _newVersion, tx) {
          if (oldVersion !== 0) return
          db.createObjectStore('entries', { keyPath: 'id' })
          db.createObjectStore('meta')
          // 只在首次创建库时初始化，重新打开或清除副本不会重新开启已关闭的选项。
          void tx.objectStore('meta').put({ recoveryEnabled: true, recentEnabled: true, epoch: 0 }, PREFERENCES_KEY).catch(() => {})
        },
        blocked() {
          fail(storageError('本机工程库被其他窗口占用。请关闭其他编辑器窗口后重新打开；不会删除原有副本。'))
        },
        blocking() {
          fail(storageError('其他窗口正在升级本机工程库，此连接已关闭。请重新打开当前应用后继续。'))
          notify('invalidated')
        },
        terminated() {
          fail(storageError('本机工程库连接意外关闭。请重新打开应用，并主动保存当前工程到文件。'))
          notify('invalidated')
        }
      }).then(db => {
        connection = db
        if (closed || failure) {
          db.close()
          reject(failure ?? storageError('本机工程库已关闭，请重新打开应用后继续。'))
          return
        }
        if (!db.objectStoreNames.contains('entries') || !db.objectStoreNames.contains('meta')) {
          fail(storageError('本机工程库结构不兼容。请保留现有存储并更新应用，不会自动清空副本。'))
          return
        }
        const tx = db.transaction(['entries', 'meta'])
        void tx.done.catch(() => {})
        if (tx.objectStore('entries').keyPath !== 'id' || tx.objectStore('meta').keyPath !== null) {
          fail(storageError('本机工程库结构不兼容。请保留现有存储并更新应用，不会自动清空副本。'))
          return
        }
        resolve(db)
      }).catch(error => fail(actionableError(error)))
    } catch (error) { fail(actionableError(error)) }
  })
  // 工厂立即打开数据库；调用方尚未发起 snapshot 时的失败也必须有拒绝处理器。
  void database.catch(() => {})

  const transact = async <T, Mode extends LibraryMode>(mode: Mode, action: (tx: LibraryTransaction<Mode>) => Promise<T>): Promise<T> => {
    if (closed) throw storageError('本机工程库已关闭，请重新打开应用后继续。')
    if (failure) throw failure
    try {
      const db = await database
      if (closed) throw storageError('本机工程库已关闭，请重新打开应用后继续。')
      if (failure) throw failure
      // 写入、清除和设置共用两张表的锁，跨窗口也不会丢失 epoch 或配额变更。
      const tx = db.transaction(['entries', 'meta'], mode)
      const done = tx.done
      void done.catch(() => {})
      try {
        const result = await action(tx)
        await done
        return result
      } catch (error) {
        try { tx.abort() } catch { /* 事务可能已经因浏览器错误中止。 */ }
        await done.catch(() => {})
        throw error
      }
    } catch (error) { throw actionableError(error) }
  }

  return {
    async snapshot(): Promise<LocalProjectSnapshot> {
      return transact('readonly', async tx => {
        const preferences = preferencesFrom(await tx.objectStore('meta').get(PREFERENCES_KEY))
        const records = (await tx.objectStore('entries').getAll()).map(recordFrom)
        return {
          preferences,
          entries: records.map(summaryOf).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
          bytesUsed: records.reduce((sum, record) => sum + record.size, 0)
        }
      })
    },

    async get(id) {
      validateId(id)
      return transact('readonly', async tx => {
        const record = await tx.objectStore('entries').get(id)
        return record === undefined ? undefined : recordFrom(record)
      })
    },

    async put(record, expectedEpoch) {
      const incoming = recordFrom(record)
      if (!validInteger(expectedEpoch)) throw storageError('本机工程库写入代次无效，请刷新恢复列表后重试。')
      const result = await transact('readwrite', async tx => {
        const preferences = preferencesFrom(await tx.objectStore('meta').get(PREFERENCES_KEY))
        if (preferences.epoch !== expectedEpoch) return 'stale' as const
        if (!(incoming.kind === 'recovery' ? preferences.recoveryEnabled : preferences.recentEnabled)) return 'disabled' as const
        const entries = tx.objectStore('entries')
        const records = (await entries.getAll()).map(recordFrom)
        const old = records.find(item => item.id === incoming.id)
        if (old && old.kind !== incoming.kind) throw storageError('同一本机副本不能改变类别，请使用新的工程副本标识。')
        if (old && incoming.revision <= old.revision) return 'stale' as const
        const remaining = records.filter(item => item.id !== incoming.id)
        const recoveryCount = remaining.filter(item => item.kind === 'recovery').length + Number(incoming.kind === 'recovery')
        if (recoveryCount > PROJECT_LIBRARY_MAX_RECOVERY) throw storageError('自动恢复副本已达 5 个上限。请先恢复或导出旧副本，再手动删除不需要的副本。')
        let recentCount = remaining.filter(item => item.kind === 'recent').length + Number(incoming.kind === 'recent')
        let bytes = remaining.reduce((sum, item) => sum + item.size, incoming.size)
        const candidates = remaining.filter(item => item.kind === 'recent').sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
        const evicted: string[] = []
        for (const item of candidates) {
          if (recentCount <= PROJECT_LIBRARY_MAX_RECENT && bytes <= PROJECT_LIBRARY_MAX_BYTES) break
          evicted.push(item.id)
          recentCount -= 1
          bytes -= item.size
        }
        if (bytes > PROJECT_LIBRARY_MAX_BYTES) throw storageError('本机工程副本超过 256 MiB 容量上限，原有恢复副本已保留。请先保存到文件，再手动清理旧副本。')
        // 先计算可行方案再操作；删除最近副本与写入共享事务，写入失败会完整回滚。
        for (const id of evicted) await entries.delete(id)
        await entries.put(incoming)
        return 'stored' as const
      })
      if (result === 'stored') publish('written')
      return result
    },

    async remove(id) {
      validateId(id)
      await transact('readwrite', async tx => {
        // 即使尚无该记录也要失效旧任务：它可能仍在压缩，稍后才会首次写入。
        const preferences = nextPreferences(preferencesFrom(await tx.objectStore('meta').get(PREFERENCES_KEY)))
        await tx.objectStore('entries').delete(id)
        await tx.objectStore('meta').put(preferences, PREFERENCES_KEY)
      })
      publish('invalidated')
    },

    async clear() {
      await transact('readwrite', async tx => {
        const stored = await tx.objectStore('meta').get(PREFERENCES_KEY)
        let preferences: LocalProjectPreferences
        try {
          preferences = nextPreferences(preferencesFrom(stored))
        } catch {
          // 只有用户明确清除时才修复损坏的设置，且两项一律关闭，绝不恢复后台收集。
          const oldEpoch = stored && validInteger(stored.epoch) && stored.epoch < Number.MAX_SAFE_INTEGER ? stored.epoch + 1 : 0
          preferences = { recoveryEnabled: false, recentEnabled: false, epoch: Math.max(Date.now(), oldEpoch) }
        }
        await tx.objectStore('entries').clear()
        await tx.objectStore('meta').put(preferences, PREFERENCES_KEY)
      })
      publish('invalidated')
    },

    async configure(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.entries(patch).some(([key, value]) => !['recoveryEnabled', 'recentEnabled'].includes(key) || typeof value !== 'boolean')) {
        throw storageError('本机工程存储设置无效，只能开启或关闭自动恢复和最近工程。')
      }
      const safePatch = { ...patch }
      const preferences = await transact('readwrite', async tx => {
        const next = { ...nextPreferences(preferencesFrom(await tx.objectStore('meta').get(PREFERENCES_KEY))), ...safePatch }
        await tx.objectStore('meta').put(next, PREFERENCES_KEY)
        return next
      })
      publish('invalidated')
      return preferences
    },

    subscribe(listener) {
      if (closed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    close() {
      if (closed) return
      closed = true
      listeners.clear()
      channel?.close()
      channel = undefined
      connection?.close()
    }
  }
}
