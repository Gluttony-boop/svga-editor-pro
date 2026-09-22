import 'fake-indexeddb/auto'
import { forceCloseDatabase } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteDB, openDB, type IDBPDatabase, type OpenDBCallbacks } from 'idb'
import type { LocalProjectRecord, LocalProjectRepository } from '@/types/project-library'
import {
  createProjectLibrary, PROJECT_LIBRARY_MAX_BYTES, PROJECT_LIBRARY_MAX_RECENT, PROJECT_LIBRARY_MAX_RECOVERY,
} from './project-library'
import { MAX_PROJECT_BYTES } from './project-validation'

const record = (id: string, kind: 'recovery' | 'recent' = 'recent', revision = 1): LocalProjectRecord => ({
  id, kind, name: `${id}.svgaproj`, updatedAt: revision, revision, size: 4,
  archive: new Blob(['test']),
})

const MiB = 1024 * 1024
let sharedChunk: Blob | undefined

function largeRecord(id: string, size: number, kind: 'recovery' | 'recent' = 'recent', revision = 1): LocalProjectRecord {
  // 复用 32 MiB 的底层数据，不为每个逻辑配额案例重新分配数百 MiB 或读取归档内容。
  sharedChunk ??= new Blob([new Uint8Array(32 * MiB)])
  const parts = Array<Blob>(Math.floor(size / sharedChunk.size)).fill(sharedChunk)
  if (size % sharedChunk.size) parts.push(sharedChunk.slice(0, size % sharedChunk.size))
  return { ...record(id, kind, revision), archive: new Blob(parts), size }
}

let sequence = 0
const names = new Set<string>()
const repositories = new Set<LocalProjectRepository>()
const rawConnections = new Set<IDBPDatabase>()

function databaseName(): string {
  const name = `test-local-project-library-${++sequence}`
  names.add(name)
  return name
}

function open(name = databaseName(), broadcast = false): LocalProjectRepository {
  names.add(name)
  const repository = createProjectLibrary({ name, broadcast })
  repositories.add(repository)
  return repository
}

async function rawOpen(name: string, version?: number, callbacks?: OpenDBCallbacks<unknown>): Promise<IDBPDatabase> {
  names.add(name)
  const database = await openDB(name, version, callbacks)
  rawConnections.add(database)
  return database
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // 先关闭每一个窗口连接，再删各用例独立的数据库，避免失败用例让下一例一直 blocked。
  for (const repository of repositories) repository.close()
  for (const database of rawConnections) database.close()
  repositories.clear()
  rawConnections.clear()
  for (const name of names) await deleteDB(name)
  names.clear()
})

describe('本机工程库：持久化与写入边界', () => {
  it('首次创建、写入、重新打开读取快照，摘要不携带工程字节或磁盘路径', async () => {
    const name = databaseName()
    const first = open(name)
    expect(await first.snapshot()).toEqual({
      entries: [], bytesUsed: 0, preferences: { recoveryEnabled: true, recentEnabled: true, epoch: 0 },
    })
    const incoming = { ...record('recent-1'), path: 'D:\\private\\client.svgaproj', fileHandle: { name: 'private' }, other: 'discard' }
    expect(await first.put(incoming, 0)).toBe('stored')
    const snapshot = await first.snapshot()
    expect(snapshot.entries).toEqual([{ id: 'recent-1', kind: 'recent', name: 'recent-1.svgaproj', updatedAt: 1, size: 4, revision: 1 }])
    expect(snapshot.bytesUsed).toBe(4)
    first.close()

    const second = open(name)
    const recovered = await second.get('recent-1')
    expect(recovered).toEqual(record('recent-1'))
    expect(await recovered?.archive.text()).toBe('test')
    expect(Object.keys(recovered!).sort()).toEqual(['archive', 'id', 'kind', 'name', 'revision', 'size', 'updatedAt'])
    const raw = await rawOpen(name)
    expect(Object.keys(await raw.get('entries', 'recent-1')).sort()).toEqual(Object.keys(recovered!).sort())
  })

  it('更新后的摘要按更新时间降序排列，同一时间按标识稳定排序', async () => {
    const repository = open()
    for (const id of ['c', 'b', 'a']) await repository.put(record(id), 0)
    expect((await repository.snapshot()).entries.map(entry => entry.id)).toEqual(['a', 'b', 'c'])
    await repository.put(record('c', 'recent', 2), 0)
    expect((await repository.snapshot()).entries.map(entry => entry.id)).toEqual(['c', 'a', 'b'])
    expect((await repository.snapshot()).bytesUsed).toBe(12)
  })

  it('只接受更高 revision，低版本和重复任务都不覆盖已有字节或发出 written', async () => {
    const repository = open()
    const changed = vi.fn()
    repository.subscribe(changed)
    await repository.put(record('r', 'recovery', 2), 0)
    changed.mockClear()
    expect(await repository.put({ ...record('r', 'recovery', 2), archive: new Blob(['same']) }, 0)).toBe('stale')
    expect(await repository.put({ ...record('r', 'recovery', 1), archive: new Blob(['back']) }, 0)).toBe('stale')
    expect(await (await repository.get('r'))?.archive.text()).toBe('test')
    expect(changed).not.toHaveBeenCalled()
    expect(await repository.put({ ...record('r', 'recovery', 3), archive: new Blob(['next']) }, 0)).toBe('stored')
    expect(await (await repository.get('r'))?.archive.text()).toBe('next')
  })

  it('同一个 id 不能偷偷从恢复副本变成可淘汰的最近副本', async () => {
    const repository = open()
    await repository.put(record('keep', 'recovery'), 0)
    await expect(repository.put(record('keep', 'recent', 2), 0)).rejects.toThrow('不能改变类别')
    expect((await repository.get('keep'))?.kind).toBe('recovery')
  })

  it('没有找到的合法 id 返回 undefined', async () => {
    const repository = open()
    expect(await repository.get('missing')).toBeUndefined()
  })

  it.each(['', '  ', 'a\u0000b', 'a\nb', 'a\u007fb', 'a'.repeat(129)])('拒绝无效标识 %j', async id => {
    const repository = open()
    await expect(repository.put({ ...record('valid'), id }, 0)).rejects.toThrow('标识无效')
    await expect(repository.get(id)).rejects.toThrow('标识无效')
    await expect(repository.remove(id)).rejects.toThrow('标识无效')
    expect((await repository.snapshot()).entries).toEqual([])
  })

  it.each([
    '', ' ', '../bad.svgaproj', 'D:\\private\\bad.svgaproj', 'bad/name.svgaproj', 'bad:name.svgaproj', 'bad?name.svgaproj',
    'bad*name.svgaproj', 'bad"name.svgaproj', '<bad>.svgaproj', 'bad|name.svgaproj', 'bad\u0000.svgaproj',
    'bad\u007f.svgaproj', 'tail.', 'tail ', '.', '..', 'CON', 'con.svgaproj', 'PRN.txt', 'AUX.svgaproj',
    'NUL.svgaproj', 'COM1.svgaproj', 'lpt9.svgaproj', 'a'.repeat(256),
  ])('拒绝路径或无效文件显示名称 %j', async name => {
    const repository = open()
    await expect(repository.put({ ...record('bad'), name }, 0)).rejects.toThrow('显示名称无效')
    expect((await repository.snapshot()).entries).toEqual([])
  })

  it.each(['甲方礼物.svgaproj', 'COM10.svgaproj', 'container.svgaproj', 'a'.repeat(255)])('保留合法显示名称 %j', async name => {
    const repository = open()
    expect(await repository.put({ ...record('good'), name }, 0)).toBe('stored')
    expect((await repository.get('good'))?.name).toBe(name)
  })

  it.each([
    { revision: -1 }, { revision: 0.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { updatedAt: NaN },
    { updatedAt: Infinity }, { updatedAt: -1 }, { updatedAt: 0.5 }, { updatedAt: Number.MAX_SAFE_INTEGER + 1 },
    { kind: undefined }, { kind: 'other' }, { size: 0 }, { size: 5 }, { size: 4.5 },
  ])('拒绝损坏字段 %j', async patch => {
    const repository = open()
    await expect(repository.put({ ...record('bad'), ...patch } as LocalProjectRecord, 0)).rejects.toThrow()
    expect((await repository.snapshot()).entries).toEqual([])
  })

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('拒绝无效 expectedEpoch %j', async epoch => {
    const repository = open()
    await expect(repository.put(record('bad'), epoch)).rejects.toThrow('写入代次无效')
  })

  it('拒绝缺失或伪造 Blob、空工程，以及单工程超过 128 MiB', async () => {
    const repository = open()
    for (const archive of [undefined, { size: 4 }, Object.create(Blob.prototype)]) {
      await expect(repository.put({ ...record('bad'), archive } as LocalProjectRecord, 0)).rejects.toThrow('真实的 Blob')
    }
    await expect(repository.put({ ...record('empty'), archive: new Blob([]), size: 0 }, 0)).rejects.toThrow('大小无效')
    await expect(repository.put(largeRecord('large', MAX_PROJECT_BYTES + 1), 0)).rejects.toThrow('128 MiB')
    expect((await repository.snapshot()).entries).toEqual([])
  })

  it('不信任 Blob 上被覆盖的 size，按原生 getter 得到的真实字节数校验和存储', async () => {
    const repository = open()
    const archive = new Blob(['real'])
    Object.defineProperty(archive, 'size', { value: 1 })
    await expect(repository.put({ ...record('bad'), archive, size: 1 }, 0)).rejects.toThrow('大小无效')
    expect(await repository.put({ ...record('good'), archive, size: 4 }, 0)).toBe('stored')
    expect((await repository.get('good'))?.archive.size).toBe(4)
    expect((await repository.snapshot()).bytesUsed).toBe(4)
  })
})

describe('本机工程库：配额和事务完整性', () => {
  it('最多保留 5 份恢复副本；满额拒绝第 6 份但仍允许更新原副本，不自动删除旧副本', async () => {
    const repository = open()
    for (let index = 0; index < PROJECT_LIBRARY_MAX_RECOVERY; index++) await repository.put(record(`recovery-${index}`, 'recovery'), 0)
    await repository.put(record('recent'), 0)
    const before = await repository.snapshot()
    await expect(repository.put(record('sixth', 'recovery'), 0)).rejects.toThrow('5 个上限')
    expect(await repository.snapshot()).toEqual(before)
    expect(await repository.put(record('recovery-0', 'recovery', 2), 0)).toBe('stored')
    expect((await repository.snapshot()).entries.filter(item => item.kind === 'recovery')).toHaveLength(5)
  })

  it('最近副本超过 8 份时仅淘汰最旧最近副本，恢复副本不会被淘汰', async () => {
    const repository = open()
    await repository.put(record('recovery', 'recovery'), 0)
    for (let index = 0; index <= PROJECT_LIBRARY_MAX_RECENT; index++) await repository.put(record(`recent-${index}`, 'recent', index + 1), 0)
    expect(await repository.get('recent-0')).toBeUndefined()
    expect(await repository.get('recovery')).toBeDefined()
    expect((await repository.snapshot()).entries.filter(item => item.kind === 'recent')).toHaveLength(8)
    expect((await repository.snapshot()).bytesUsed).toBe(36)
  })

  it('淘汰同一更新时间的最近副本时以 id 为稳定次序', async () => {
    const repository = open()
    for (const id of ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']) await repository.put(record(id), 0)
    await repository.put(record('new', 'recent', 2), 0)
    expect(await repository.get('a')).toBeUndefined()
    expect((await repository.snapshot()).entries.map(entry => entry.id)).toEqual(['new', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  })

  it('256 MiB 总上限允许边界值和原记录替换，配额计算不会重复累计旧版本', async () => {
    const repository = open()
    const readArchive = vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new Error('配额检查不应读取归档'))
    await repository.put(largeRecord('a', 128 * MiB, 'recovery'), 0)
    await repository.put(largeRecord('b', 128 * MiB, 'recovery'), 0)
    expect((await repository.snapshot()).bytesUsed).toBe(PROJECT_LIBRARY_MAX_BYTES)
    expect(await repository.put(largeRecord('a', 128 * MiB, 'recovery', 2), 0)).toBe('stored')
    expect((await repository.snapshot()).bytesUsed).toBe(PROJECT_LIBRARY_MAX_BYTES)
    await repository.put(largeRecord('a', 64 * MiB, 'recovery', 3), 0)
    expect((await repository.snapshot()).bytesUsed).toBe(192 * MiB)
    expect(readArchive).not.toHaveBeenCalled()
  })

  it('容量不足时可以淘汰多份最近缓存，但不淘汰恢复副本', async () => {
    const repository = open()
    await repository.put(largeRecord('recovery', 128 * MiB, 'recovery'), 0)
    for (let index = 1; index <= 4; index++) await repository.put(largeRecord(`recent-${index}`, 32 * MiB, 'recent', index), 0)
    await repository.put(largeRecord('new', 96 * MiB, 'recent', 5), 0)
    const snapshot = await repository.snapshot()
    expect(snapshot.bytesUsed).toBe(PROJECT_LIBRARY_MAX_BYTES)
    expect(snapshot.entries.map(entry => entry.id)).toEqual(['new', 'recent-4', 'recovery'])
  })

  it('给恢复副本腾空间也只删除最近缓存，不需要用户删除有余量的恢复副本', async () => {
    const repository = open()
    await repository.put(largeRecord('a', 96 * MiB, 'recovery'), 0)
    await repository.put(largeRecord('b', 96 * MiB, 'recovery'), 0)
    await repository.put(largeRecord('cache', 64 * MiB), 0)
    await repository.put(largeRecord('c', 64 * MiB, 'recovery'), 0)
    expect((await repository.snapshot()).entries.map(entry => entry.id)).toEqual(['a', 'b', 'c'])
    expect((await repository.snapshot()).bytesUsed).toBe(PROJECT_LIBRARY_MAX_BYTES)
  })

  it('仅剩恢复副本且容量已满时拒绝新副本，连一字节空间也不从恢复副本中挤出', async () => {
    const repository = open()
    await repository.put(largeRecord('a', 128 * MiB, 'recovery'), 0)
    await repository.put(largeRecord('b', 128 * MiB, 'recovery'), 0)
    const before = await repository.snapshot()
    await expect(repository.put({ ...record('c'), archive: new Blob(['1']), size: 1 }, 0)).rejects.toThrow('256 MiB')
    expect(await repository.snapshot()).toEqual(before)
  })

  it('浏览器在淘汰后的 put 抛出 QuotaExceededError，旧最近缓存与恢复副本全部回滚保留', async () => {
    const repository = open()
    await repository.put(record('recovery', 'recovery'), 0)
    for (let index = 0; index < 8; index++) await repository.put(record(`recent-${index}`, 'recent', index + 1), 0)
    const before = await repository.snapshot()
    const changed = vi.fn()
    repository.subscribe(changed)
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'entries' && value.id === 'new') throw new DOMException('quota', 'QuotaExceededError')
      return originalPut.call(this, value, key)
    })
    await expect(repository.put(record('new', 'recent', 9), 0)).rejects.toThrow('存储空间不足')
    expect(await repository.snapshot()).toEqual(before)
    expect(await (await repository.get('recent-0'))?.archive.text()).toBe('test')
    expect(changed).not.toHaveBeenCalled()
  })

  it('请求成功但整个事务 abort 也不能报 stored，覆盖的字节回滚且不发通知', async () => {
    const repository = open()
    await repository.put(record('keep'), 0)
    const changed = vi.fn()
    repository.subscribe(changed)
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key)
      if (this.name === 'entries' && value.revision === 2) request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await expect(repository.put({ ...record('keep', 'recent', 2), archive: new Blob(['lost']) }, 0)).rejects.toThrow('未确认写入成功')
    expect(await (await repository.get('keep'))?.archive.text()).toBe('test')
    expect((await repository.get('keep'))?.revision).toBe(1)
    expect(changed).not.toHaveBeenCalled()
  })

  it.each(['remove', 'clear'] as const)('%s 的设置写入失败时，删除和 epoch 都一起回滚', async action => {
    const repository = open()
    await repository.put(record('keep'), 0)
    const before = await repository.snapshot()
    const changed = vi.fn()
    repository.subscribe(changed)
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'meta') throw new DOMException('quota', 'QuotaExceededError')
      return originalPut.call(this, value, key)
    })
    await expect(action === 'clear' ? repository.clear() : repository.remove('keep')).rejects.toThrow('原有副本已保留')
    expect(await repository.snapshot()).toEqual(before)
    expect(changed).not.toHaveBeenCalled()
  })

  it('两个窗口同时补第 8 和第 9 个最近副本，写事务锁确保最终仍只有 8 个', async () => {
    const name = databaseName()
    const first = open(name)
    const second = open(name)
    for (let index = 0; index < 7; index++) await first.put(record(`old-${index}`, 'recent', index + 1), 0)
    expect(await Promise.all([first.put(record('new-a', 'recent', 8), 0), second.put(record('new-b', 'recent', 9), 0)])).toEqual(['stored', 'stored'])
    const snapshot = await second.snapshot()
    expect(snapshot.entries).toHaveLength(8)
    expect(snapshot.entries.map(item => item.id)).toContain('new-a')
    expect(snapshot.entries.map(item => item.id)).toContain('new-b')
    expect(await first.get('old-0')).toBeUndefined()
  })
})

describe('本机工程库：删除、设置与跨窗口失效', () => {
  it('清除递增 epoch，旧异步任务不能把副本写回来', async () => {
    const repository = open()
    await repository.put(record('r', 'recovery'), 0)
    await repository.clear()
    expect(await repository.snapshot()).toEqual({ entries: [], bytesUsed: 0, preferences: { recoveryEnabled: true, recentEnabled: true, epoch: 1 } })
    expect(await repository.put(record('late', 'recovery'), 0)).toBe('stale')
  })

  it('删除不存在 id 也使 epoch 失效，阻止尚未首次写入的压缩任务复活', async () => {
    const repository = open()
    const changed = vi.fn()
    repository.subscribe(changed)
    await repository.remove('pending')
    expect((await repository.snapshot()).preferences.epoch).toBe(1)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith('invalidated')
    expect(await repository.put(record('pending', 'recovery'), 0)).toBe('stale')
    expect((await repository.snapshot()).entries).toEqual([])
  })

  it('删除仅移除指定副本，其余副本和两项设置都保留', async () => {
    const repository = open()
    await repository.put(record('remove', 'recovery'), 0)
    await repository.put(record('keep'), 0)
    await repository.remove('remove')
    expect(await repository.snapshot()).toMatchObject({ entries: [{ id: 'keep' }], bytesUsed: 4, preferences: { recoveryEnabled: true, recentEnabled: true, epoch: 1 } })
  })

  it('关闭两项后拒绝对应写入、保留既有记录；清除与重开也不会自动启用选项', async () => {
    const name = databaseName()
    const repository = open(name)
    await repository.put(record('keep', 'recovery'), 0)
    const preferences = await repository.configure({ recoveryEnabled: false, recentEnabled: false })
    expect(preferences).toEqual({ recoveryEnabled: false, recentEnabled: false, epoch: 1 })
    expect(await repository.put(record('new', 'recovery'), 1)).toBe('disabled')
    expect(await repository.put(record('new-recent'), 1)).toBe('disabled')
    expect((await repository.snapshot()).entries.map(item => item.id)).toEqual(['keep'])
    await repository.clear()
    repository.close()
    const reopened = open(name)
    expect(await reopened.snapshot()).toEqual({ entries: [], bytesUsed: 0, preferences: { recoveryEnabled: false, recentEnabled: false, epoch: 2 } })
    expect(await reopened.put(record('new'), 2)).toBe('disabled')
  })

  it('两个开关独立；改变设置仍使之前捕获的 epoch 作废', async () => {
    const repository = open()
    await repository.configure({ recoveryEnabled: false })
    expect(await repository.put(record('recent'), 1)).toBe('stored')
    expect(await repository.put(record('blocked', 'recovery'), 1)).toBe('disabled')
    await repository.configure({ recoveryEnabled: true, recentEnabled: false })
    expect(await repository.put(record('late', 'recovery'), 1)).toBe('stale')
    expect(await repository.put(record('allowed', 'recovery'), 2)).toBe('stored')
    expect(await repository.put(record('blocked-recent'), 2)).toBe('disabled')
  })

  it.each([null, [], { recoveryEnabled: 'yes' }, { recentEnabled: 1 }, { epoch: 0 }, { recoveryEnabled: true, path: 'secret' }])('拒绝无效设置 %j', async patch => {
    const repository = open()
    await expect(repository.configure(patch as Parameters<LocalProjectRepository['configure']>[0])).rejects.toThrow('设置无效')
    expect((await repository.snapshot()).preferences).toEqual({ recoveryEnabled: true, recentEnabled: true, epoch: 0 })
  })

  it('没有 BroadcastChannel 时，不同窗口也依赖同库 epoch 拒绝清除/关闭之前的延迟写入', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const name = databaseName()
    const first = open(name, true)
    const second = open(name, true)
    const staleEpoch = (await second.snapshot()).preferences.epoch
    await first.put(record('keep', 'recovery'), staleEpoch)
    await first.clear()
    expect(await second.put(record('late', 'recovery'), staleEpoch)).toBe('stale')
    const afterClear = (await second.snapshot()).preferences.epoch
    await first.configure({ recoveryEnabled: false })
    expect(await second.put(record('late', 'recovery'), afterClear)).toBe('stale')
    expect(await second.put(record('disabled', 'recovery'), (await second.snapshot()).preferences.epoch)).toBe('disabled')
    expect((await second.snapshot()).entries).toEqual([])
  })

  it('两个窗口并发改不同开关不会丢失另一窗口的设置', async () => {
    const name = databaseName()
    const first = open(name)
    const second = open(name)
    await Promise.all([first.configure({ recoveryEnabled: false }), second.configure({ recentEnabled: false })])
    expect((await first.snapshot()).preferences).toEqual({ recoveryEnabled: false, recentEnabled: false, epoch: 2 })
  })
})

describe('本机工程库：损坏与连接故障', () => {
  it.each([undefined, null, {}, { epoch: 5 }, { recoveryEnabled: true, recentEnabled: false, epoch: -1 }, { recoveryEnabled: 'bad', recentEnabled: true, epoch: 4 }])('设置损坏 %j 时不静默重置；明确清除才能修复并关闭两项选项', async preferences => {
    const name = databaseName()
    const repository = open(name)
    await repository.put(record('keep', 'recovery'), 0)
    const raw = await rawOpen(name)
    if (preferences === undefined) await raw.delete('meta', 'preferences')
    else await raw.put('meta', preferences, 'preferences')
    await expect(repository.snapshot()).rejects.toThrow('设置损坏')
    await expect(repository.put(record('blocked'), 0)).rejects.toThrow('设置损坏')
    await expect(repository.configure({ recoveryEnabled: true })).rejects.toThrow('设置损坏')
    expect(await (await repository.get('keep'))?.archive.text()).toBe('test')

    await repository.clear()
    const snapshot = await repository.snapshot()
    expect(snapshot.entries).toEqual([])
    expect(snapshot.preferences).toMatchObject({ recoveryEnabled: false, recentEnabled: false })
    expect(snapshot.preferences.epoch).toBeGreaterThan(5)
    expect(await repository.put(record('late'), 0)).toBe('stale')
  })

  it('记录损坏使快照明确失败，但合法单份仍可读取，用户可定向删除坏记录', async () => {
    const name = databaseName()
    const repository = open(name)
    await repository.put(record('keep', 'recovery'), 0)
    const raw = await rawOpen(name)
    await raw.put('entries', { ...record('bad'), kind: undefined })
    await expect(repository.snapshot()).rejects.toThrow('类别无效')
    await expect(repository.get('bad')).rejects.toThrow('类别无效')
    await expect(repository.put(record('new'), 0)).rejects.toThrow('类别无效')
    expect(await repository.get('keep')).toBeDefined()
    await repository.remove('bad')
    expect((await repository.snapshot()).entries.map(item => item.id)).toEqual(['keep'])
  })

  it('手动清空不依赖坏记录可读，且保留关闭过的选项', async () => {
    const name = databaseName()
    const repository = open(name)
    await repository.snapshot()
    await repository.configure({ recoveryEnabled: false, recentEnabled: false })
    const raw = await rawOpen(name)
    await raw.put('entries', { id: 'broken', archive: { size: 4 } })
    await expect(repository.snapshot()).rejects.toThrow()
    await repository.clear()
    expect(await repository.snapshot()).toEqual({ entries: [], bytesUsed: 0, preferences: { recoveryEnabled: false, recentEnabled: false, epoch: 2 } })
  })

  it('epoch 到达最大安全整数时不允许循环回旧代次，明确清除可关闭收集并恢复', async () => {
    const name = databaseName()
    const repository = open(name)
    await repository.put(record('keep'), 0)
    const raw = await rawOpen(name)
    await raw.put('meta', { recoveryEnabled: true, recentEnabled: true, epoch: Number.MAX_SAFE_INTEGER }, 'preferences')
    await expect(repository.remove('keep')).rejects.toThrow('代次已超出')
    await expect(repository.configure({ recentEnabled: false })).rejects.toThrow('代次已超出')
    expect(await repository.get('keep')).toBeDefined()
    await repository.clear()
    expect((await repository.snapshot()).preferences).toMatchObject({ recoveryEnabled: false, recentEnabled: false })
    expect(await repository.put(record('old'), Number.MAX_SAFE_INTEGER)).toBe('stale')
  })

  it.each(['缺表', '错误keyPath'])('物理库结构%s时不擅自删库；保留原数据供修复或升级', async kind => {
    const name = databaseName()
    const raw = await rawOpen(name, 1, {
      upgrade(db) {
        db.createObjectStore('entries', { keyPath: kind === '错误keyPath' ? 'other' : 'id' })
        if (kind !== '缺表') db.createObjectStore('meta')
      },
    })
    await raw.put('entries', { id: 'keep', other: 'keep', payload: '仍保留' })
    const repository = open(name)
    await expect(repository.snapshot()).rejects.toThrow('结构不兼容')
    await expect(repository.clear()).rejects.toThrow('结构不兼容')
    expect(await raw.get('entries', 'keep')).toMatchObject({ payload: '仍保留' })
  })

  it('不支持 IndexedDB 时提供主动保存建议，工厂本身不产生未处理的拒绝', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const repository = open()
    await expect(repository.snapshot()).rejects.toThrow('不支持本机工程存储')
  })

  it.each(['SecurityError', 'NotAllowedError'])('打开时遇到 %s，给出隐私权限提示而不创建替代空库', async errorName => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new DOMException('denied', errorName) })
    const repository = open()
    await expect(repository.snapshot()).rejects.toThrow('禁止本机工程存储')
  })

  it('主动 close 可重复调用，之后不能读写、订阅或重新开启此实例', async () => {
    const repository = open()
    await repository.put(record('keep'), 0)
    const listener = vi.fn()
    repository.close()
    repository.close()
    repository.subscribe(listener)()
    await expect(repository.snapshot()).rejects.toThrow('已关闭')
    await expect(repository.get('keep')).rejects.toThrow('已关闭')
    await expect(repository.put(record('new'), 0)).rejects.toThrow('已关闭')
    await expect(repository.remove('keep')).rejects.toThrow('已关闭')
    await expect(repository.clear()).rejects.toThrow('已关闭')
    await expect(repository.configure({ recentEnabled: false })).rejects.toThrow('已关闭')
    expect(listener).not.toHaveBeenCalled()
  })

  it('连接尚未打开时 close，不会留下阻塞删除或升级的幽灵连接', async () => {
    const name = databaseName()
    const repository = open(name)
    repository.close()
    await expect(repository.snapshot()).rejects.toThrow('已关闭')
    const raw = await rawOpen(name, 2)
    expect(raw.version).toBe(2)
  })

  it('其他窗口升级时主动关闭旧连接并通知；重开旧版不会清空新版数据库', async () => {
    const name = databaseName()
    const repository = open(name)
    await repository.put(record('keep'), 0)
    const listener = vi.fn()
    repository.subscribe(listener)
    const upgraded = await rawOpen(name, 2)
    expect(listener).toHaveBeenCalledWith('invalidated')
    await expect(repository.snapshot()).rejects.toThrow('正在升级')
    const outdated = open(name)
    await expect(outdated.snapshot()).rejects.toThrow('由更新版本创建')
    expect(await upgraded.get('entries', 'keep')).toMatchObject({ id: 'keep', revision: 1 })
  })

  it('blocked 回调之后即使底层请求迟到成功，也会关闭迟到连接并保留旧数据', async () => {
    const name = databaseName()
    const original = open(name)
    await original.put(record('keep'), 0)
    original.close()
    const nativeOpen = indexedDB.open.bind(indexedDB)
    const spy = vi.spyOn(indexedDB, 'open').mockImplementation((dbName, version) => {
      const request = nativeOpen(dbName, version)
      // v1 库没有可自然构造的 v0 连接；向真实请求注入阻塞事件，仍让其真实完成以验证迟到清理。
      queueMicrotask(() => request.dispatchEvent(new IDBVersionChangeEvent('blocked', { oldVersion: 0, newVersion: 1 })))
      return request
    })
    const blocked = open(name)
    await expect(blocked.snapshot()).rejects.toThrow('被其他窗口占用')
    spy.mockRestore()
    const upgraded = await rawOpen(name, 2)
    expect(await upgraded.get('entries', 'keep')).toBeDefined()
  })

  it('连接异常终止后只报错与通知，不会自动重建空库', async () => {
    const name = databaseName()
    let nativeConnection: IDBDatabase | undefined
    const nativeOpen = indexedDB.open.bind(indexedDB)
    vi.spyOn(indexedDB, 'open').mockImplementation((dbName, version) => {
      const request = nativeOpen(dbName, version)
      request.addEventListener('success', () => { nativeConnection = request.result })
      return request
    })
    const repository = open(name)
    await repository.put(record('keep'), 0)
    const listener = vi.fn()
    repository.subscribe(listener)
    // fake-indexeddb 6.2.5 的声明把实例误写为构造器；运行时 API 接受实际数据库实例。
    ;(forceCloseDatabase as unknown as (db: IDBDatabase) => void)(nativeConnection!)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('invalidated'))
    await expect(repository.snapshot()).rejects.toThrow('连接意外关闭')
    const raw = await rawOpen(name)
    expect(await raw.get('entries', 'keep')).toBeDefined()
  })
})

describe('本机工程库：观察者与广播隔离', () => {
  it('观察者抛错不能把已提交事务误报失败，也不能阻止其他监听器收到通知', async () => {
    const repository = open()
    repository.subscribe(() => { throw new Error('界面异常') })
    const listener = vi.fn()
    const unsubscribe = repository.subscribe(listener)
    expect(await repository.put(record('keep'), 0)).toBe('stored')
    expect(listener).toHaveBeenCalledWith('written')
    await expect(repository.clear()).resolves.toBeUndefined()
    expect(listener).toHaveBeenCalledWith('invalidated')
    expect((await repository.snapshot()).entries).toEqual([])
    listener.mockClear()
    unsubscribe()
    await repository.configure({ recentEnabled: false })
    expect(listener).not.toHaveBeenCalled()
  })

  it('广播创建被隐私模式拒绝时，本机库仍可写入并用 epoch 失效旧任务', async () => {
    vi.stubGlobal('BroadcastChannel', class { constructor() { throw new DOMException('denied', 'SecurityError') } })
    const repository = open(databaseName(), true)
    expect(await repository.put(record('keep'), 0)).toBe('stored')
    await repository.clear()
    expect(await repository.put(record('late'), 0)).toBe('stale')
  })

  it('广播发送失败不能改变已提交结果；接收消息只接受精确的类型白名单，关闭时释放频道', async () => {
    const channels: TestChannel[] = []
    class TestChannel {
      onmessage?: (event: { data: unknown }) => void
      close = vi.fn()
      postMessage = vi.fn(() => { throw new Error('channel unavailable') })
      constructor(readonly name: string) { channels.push(this) }
    }
    vi.stubGlobal('BroadcastChannel', TestChannel)
    const name = databaseName()
    const repository = open(name, true)
    const listener = vi.fn()
    repository.subscribe(listener)
    expect(await repository.put(record('keep'), 0)).toBe('stored')
    expect(channels[0].name).toBe(`svga-editor:local-projects:${name}`)
    expect(channels[0].postMessage).toHaveBeenCalledWith({ type: 'written' })
    listener.mockClear()
    for (const data of [undefined, 'invalidated', {}, { type: 'clear' }, { type: 'invalidated', path: 'secret' }]) channels[0].onmessage?.({ data })
    expect(listener).not.toHaveBeenCalled()
    channels[0].onmessage?.({ data: { type: 'invalidated' } })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('invalidated')
    expect(await repository.get('keep')).toBeDefined()
    repository.close()
    expect(channels[0].close).toHaveBeenCalledTimes(1)
    listener.mockClear()
    channels[0].onmessage?.({ data: { type: 'written' } })
    expect(listener).not.toHaveBeenCalled()
  })
})
