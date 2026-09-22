import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import protobuf from 'protobufjs'
import type { VideoItem } from '@/types'
import type { ProjectDocument } from '@/types/project'
import type { LocalProjectRecord, LocalProjectRepository } from '@/types/project-library'
import { useEditorStore } from '@/stores/editorStore'
import { normalizeCanvasTransform } from './layer-transform'
import { captureExportInputs } from './export-preview'
import { createProjectArchive, readProjectArchive } from './project-archive'
import { createProjectLibrary } from './project-library'
import { ProjectRecoveryCoordinator, type RecoveryStatus } from './project-recovery'
import proto from './svga-proto'

const state = () => useEditorStore.getState()
const Movie = protobuf.Root.fromJSON(proto).lookupType('com.opensource.svga.MovieEntity')
const video = (): VideoItem => ({
  movie: {
    version: '2.0', params: { viewBoxWidth: 100, viewBoxHeight: 80, fps: 24, frames: 2 },
    images: {}, sprites: [{
      imageKey: 'image', matteKey: null,
      frames: Array.from({ length: 2 }, () => ({
        alpha: 1, layout: { x: 0, y: 0, width: 10, height: 10 },
        transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null
      }))
    }]
  }, images: {}, buffers: {}
})

function setupDocument() {
  state().reset()
  const input = video()
  state().setVideoItem(input)
  state().setOriginalBuffer(new Uint8Array(Movie.encode(Movie.fromObject(input.movie)).finish()).buffer)
  state().setSource('输入动画.svga', 'file')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function settleIO() { for (let index = 0; index < 25; index++) await tick() }

async function until(check: () => boolean, message: string) {
  for (let index = 0; index < 150; index++) {
    if (check()) return
    await tick()
  }
  throw new Error(message)
}

let names = 0
const repositories: LocalProjectRepository[] = []
const coordinators: ProjectRecoveryCoordinator[] = []

function openRepository(name = `recovery-coordinator-${++names}`) {
  const repository = createProjectLibrary({ name, broadcast: false })
  repositories.push(repository)
  return repository
}

function create(options: {
  repository?: LocalProjectRepository
  encode?: (document: ProjectDocument) => Promise<Blob>
  debounceMs?: number
  minIntervalMs?: number
} = {}) {
  const repository = options.repository ?? openRepository()
  const status: RecoveryStatus[] = []
  const encode = vi.fn(options.encode ?? (async document => new Blob([JSON.stringify({
    name: document.layers[0]?.name, opacity: document.layers[0]?.opacity,
    width: document.params.viewBoxWidth, text: document.slotConfigs.image?.value
  })])))
  const coordinator = new ProjectRecoveryCoordinator({ ...options, repository, encode, onStatus: value => status.push(value) })
  coordinators.push(coordinator)
  return { repository, coordinator, encode, status }
}

async function records(repository: LocalProjectRepository): Promise<LocalProjectRecord[]> {
  const snapshot = await repository.snapshot()
  return Promise.all(snapshot.entries.map(async summary => {
    const record = await repository.get(summary.id)
    expect(record).toBeDefined()
    return record!
  }))
}

function fakeClock() {
  // IndexedDB 继续使用真实 setImmediate；仅将调度时钟交给测试控制。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-09-21T00:00:00Z'))
}

beforeEach(setupDocument)
afterEach(() => {
  coordinators.splice(0).forEach(coordinator => coordinator.stop())
  repositories.splice(0).forEach(repository => repository.close())
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('自动恢复：真实工程库与编辑器状态', () => {
  it('干净工程、选区、播放与视口变化不触发编码', async () => {
    fakeClock()
    const { coordinator, encode, repository } = create()
    await coordinator.start()
    state().selectLayer('0')
    state().setPlaying(true)
    state().setCurrentFrame(1)
    state().setZoom(2)
    state().toggleGrid()
    await vi.advanceTimersByTimeAsync(60_000)
    await coordinator.flush()
    expect(encode).not.toHaveBeenCalled()
    expect(await records(repository)).toEqual([])
    expect(state().playback.isPlaying).toBe(true)
  })

  it('相同已备份输入不重复编码，备份不暂停播放或增加历史', async () => {
    const { coordinator, encode, repository, status } = create()
    await coordinator.start()
    state().updateLayer('0', { name: '已修改' })
    state().setPlaying(true)
    const before = state()
    await coordinator.flush()
    await coordinator.refreshSettings()
    state().selectLayer('0')
    state().setCurrentFrame(1)
    await coordinator.flush()
    expect(encode).toHaveBeenCalledTimes(1)
    expect(await records(repository)).toHaveLength(1)
    expect(state().history).toBe(before.history)
    expect(state().isDirty).toBe(true)
    expect(state().playback.isPlaying).toBe(true)
    expect(status.some(value => value.phase === 'saved')).toBe(true)
  })

  it('默认等待连续静止 3 秒，后续自动尝试之间至少相隔 15 秒', async () => {
    fakeClock()
    const { coordinator, encode, status } = create()
    await coordinator.start()
    state().updateLayer('0', { name: '第一笔' })
    await vi.advanceTimersByTimeAsync(2_000)
    state().updateLayer('0', { name: '第二笔' })
    await vi.advanceTimersByTimeAsync(2_999)
    await settleIO()
    expect(encode).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await until(() => status.at(-1)?.phase === 'saved', '3 秒静止后没有完成首次备份')
    expect(encode).toHaveBeenCalledTimes(1)
    state().updateLayer('0', { name: '第三笔' })
    await vi.advanceTimersByTimeAsync(14_999)
    await settleIO()
    expect(encode).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await until(() => encode.mock.calls.length === 2, '15 秒节流结束后没有再次编码')
    await until(() => status.at(-1)?.phase === 'saved', '第二次备份未完成')
  })

  it('游标移动与刷新设置不会重置已经排队的 3 秒倒计时', async () => {
    fakeClock()
    const { coordinator, encode, status } = create()
    await coordinator.start()
    state().updateLayer('0', { opacity: 0.5 })
    await vi.advanceTimersByTimeAsync(2_500)
    state().selectLayer('0')
    state().setCurrentFrame(1)
    await coordinator.refreshSettings()
    await vi.advanceTimersByTimeAsync(500)
    await until(() => status.at(-1)?.phase === 'saved', '非内容事件错误地推迟了备份')
    expect(encode).toHaveBeenCalledTimes(1)
  })

  it.each(['canvas', 'text'] as const)('%s 草稿不压缩、不提交，用户完成后才备份', async kind => {
    fakeClock()
    const { coordinator, encode, repository } = create()
    await coordinator.start()
    if (kind === 'canvas') {
      expect(state().beginCanvasTransform('0')).toBe(true)
      state().previewCanvasTransform('0', normalizeCanvasTransform({ x: 42 }))
    } else {
      expect(state().beginSlotConfigEdit('image')).toBe(true)
      state().previewSlotConfig('image', { type: 'text', name: 'image', value: '未提交文字' })
    }
    if (kind === 'text') state().setPlaying(true)
    const draft = state()
    await vi.advanceTimersByTimeAsync(60_000)
    await coordinator.flush()
    expect(state()).toBe(draft)
    expect(encode).not.toHaveBeenCalled()
    expect(await records(repository)).toEqual([])
    if (kind === 'canvas') state().endCanvasTransform(true)
    else state().endSlotConfigEdit(true)
    await coordinator.flush()
    expect(encode).toHaveBeenCalledTimes(1)
    expect(state().history.past).toHaveLength(1)
    expect(state().playback.isPlaying).toBe(kind === 'text')
  })

  it.each(['canvas', 'text'] as const)('%s 草稿取消后，不把被撤销的内容加入恢复库', async kind => {
    const { coordinator, encode, repository } = create()
    await coordinator.start()
    if (kind === 'canvas') {
      expect(state().beginCanvasTransform('0')).toBe(true)
      state().previewCanvasTransform('0', normalizeCanvasTransform({ x: 42 }))
      await coordinator.flush()
      state().endCanvasTransform(false)
    } else {
      expect(state().beginSlotConfigEdit('image')).toBe(true)
      state().previewSlotConfig('image', { type: 'text', name: 'image', value: '取消文字' })
      await coordinator.flush()
      state().endSlotConfigEdit(false)
    }
    await coordinator.flush()
    expect(state().isDirty).toBe(false)
    expect(state().history.past).toHaveLength(0)
    expect(encode).not.toHaveBeenCalled()
    expect(await records(repository)).toEqual([])
  })

  it('编码严格串行；编码期间的新编辑不会被旧结果覆盖', async () => {
    const entered = deferred<void>()
    const release = deferred<Blob>()
    let active = 0, maxActive = 0, calls = 0
    const { coordinator, repository, encode } = create({ encode: async document => {
      active++
      maxActive = Math.max(active, maxActive)
      try {
        if (++calls === 1) { entered.resolve(); return await release.promise }
        return new Blob([document.layers[0].name])
      } finally { active-- }
    } })
    await coordinator.start()
    state().updateLayer('0', { name: '旧内容' })
    const pending = coordinator.flush()
    await entered.promise
    state().updateLayer('0', { name: '新内容' })
    await settleIO()
    expect(encode).toHaveBeenCalledTimes(1)
    expect(encode.mock.calls[0][0].layers[0].name).toBe('旧内容')
    release.resolve(new Blob(['旧内容']))
    await pending
    expect(encode).toHaveBeenCalledTimes(2)
    expect(maxActive).toBe(1)
    const stored = await records(repository)
    expect(stored).toHaveLength(1)
    expect(await stored[0].archive.text()).toBe('新内容')
  })

  it('数据库写入过程中新增编辑仍会再次备份，不误报最新内容已保存', async () => {
    const { coordinator, repository, status } = create()
    await coordinator.start()
    const entered = deferred<void>()
    const release = deferred<void>()
    const put = repository.put.bind(repository)
    const spy = vi.spyOn(repository, 'put').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return put(...args)
    })
    state().updateLayer('0', { name: '写入中' })
    const pending = coordinator.flush()
    await entered.promise
    state().updateLayer('0', { name: '写入期间新内容' })
    expect(status.some(value => value.phase === 'saved')).toBe(false)
    release.resolve()
    await pending
    expect(spy).toHaveBeenCalledTimes(2)
    const stored = await records(repository)
    expect(stored).toHaveLength(1)
    expect(stored[0].revision).toBe(2)
    expect(JSON.parse(await stored[0].archive.text()).name).toBe('写入期间新内容')
    expect(status.filter(value => value.phase === 'saved')).toHaveLength(1)
  })

  it('编码失败不会自动忙循环；显式重试可恢复', async () => {
    fakeClock()
    const { coordinator, encode, status, repository } = create()
    encode.mockRejectedValueOnce(new Error('压缩失败'))
    await coordinator.start()
    state().updateLayer('0', { opacity: 0.4 })
    await coordinator.flush()
    expect(status.at(-1)?.phase).toBe('error')
    state().setCurrentFrame(1)
    await coordinator.refreshSettings()
    await vi.advanceTimersByTimeAsync(120_000)
    await settleIO()
    expect(status.at(-1)?.phase).toBe('error')
    expect(encode).toHaveBeenCalledTimes(1)
    await coordinator.flush()
    expect(encode).toHaveBeenCalledTimes(2)
    expect(await records(repository)).toHaveLength(1)
  })

  it('写入失败保留上次副本；新编辑可以再次尝试', async () => {
    const { coordinator, repository, status, encode } = create()
    await coordinator.start()
    state().updateLayer('0', { name: '可恢复内容' })
    await coordinator.flush()
    const original = (await records(repository))[0]
    vi.spyOn(repository, 'put').mockRejectedValueOnce(new Error('空间不足'))
    state().updateLayer('0', { name: '未写入内容' })
    await coordinator.flush()
    expect(status.at(-1)?.phase).toBe('error')
    expect(await (await records(repository))[0].archive.text()).toBe(await original.archive.text())
    state().updateLayer('0', { name: '再次编辑' })
    await coordinator.flush()
    expect(encode).toHaveBeenCalledTimes(3)
    expect(JSON.parse(await (await records(repository))[0].archive.text()).name).toBe('再次编辑')
  })

  it('设置读取失败时 flush 会结束，恢复存储后可手动重试', async () => {
    const { coordinator, repository, encode, status } = create()
    const read = vi.spyOn(repository, 'snapshot').mockRejectedValue(new Error('存储暂不可用'))
    await coordinator.start()
    state().updateLayer('0', { opacity: 0.4 })
    await coordinator.flush()
    expect(status.at(-1)?.phase).toBe('error')
    expect(encode).not.toHaveBeenCalled()
    read.mockRestore()
    await coordinator.flush()
    expect(encode).toHaveBeenCalledTimes(1)
    expect(await records(repository)).toHaveLength(1)
  })

  it.each(['clear', 'delete', 'disable'] as const)('%s 后，已开始但尚未完成的编码不能让副本复活', async action => {
    const entered = deferred<void>()
    const release = deferred<Blob>()
    const { coordinator, repository, encode } = create({ encode: () => { entered.resolve(); return release.promise } })
    await coordinator.start()
    state().updateLayer('0', { opacity: 0.4 })
    const pending = coordinator.flush()
    await entered.promise
    if (action === 'clear') await repository.clear()
    else if (action === 'delete') await repository.remove('尚未写入的其他副本')
    else await repository.configure({ recoveryEnabled: false })
    // 失效必须解除调用者等待，而不是等一个永远不返回的压缩任务。
    await pending
    release.resolve(new Blob(['过期内容']))
    await settleIO()
    expect(encode).toHaveBeenCalledTimes(1)
    expect(await records(repository)).toEqual([])
  })

  it('未收到广播时，真实 IndexedDB 的 epoch 仍拒绝清除前开始的旧编码', async () => {
    const name = `recovery-missed-broadcast-${++names}`
    const repository = openRepository(name)
    const otherWindow = openRepository(name)
    const entered = deferred<void>()
    const release = deferred<Blob>()
    const { coordinator } = create({ repository, encode: () => { entered.resolve(); return release.promise } })
    await coordinator.start()
    state().updateLayer('0', { opacity: 0.4 })
    const pending = coordinator.flush()
    await entered.promise
    await otherWindow.clear()
    release.resolve(new Blob(['过期内容']))
    await pending
    expect(await records(repository)).toEqual([])
  })

  it('清除后、设置异步返回前发生的新编辑不会被第二次失效基线吞掉', async () => {
    fakeClock()
    const { coordinator, repository, encode, status } = create({ minIntervalMs: 0 })
    await coordinator.start()
    state().updateLayer('0', { name: '清除前内容' })
    await coordinator.flush()
    const entered = deferred<void>()
    const release = deferred<void>()
    const snapshot = repository.snapshot.bind(repository)
    vi.spyOn(repository, 'snapshot').mockImplementationOnce(async () => {
      const value = await snapshot()
      entered.resolve()
      await release.promise
      return value
    })
    await repository.clear()
    await entered.promise
    state().updateLayer('0', { name: '清除后的新编辑' })
    release.resolve()
    await settleIO()
    await vi.advanceTimersByTimeAsync(3_000)
    await until(() => encode.mock.calls.length === 2, '清除后的第一次编辑没有触发自动备份')
    await until(() => status.at(-1)?.phase === 'saved', '新编辑备份没有完成')
    expect(JSON.parse(await (await records(repository))[0].archive.text()).name).toBe('清除后的新编辑')
  })

  it('清除已排队的任务不重建副本，下一次编辑才重新排队', async () => {
    fakeClock()
    const { coordinator, repository, encode, status } = create()
    await coordinator.start()
    state().updateLayer('0', { name: '清除前' })
    await repository.clear()
    await coordinator.refreshSettings()
    await vi.advanceTimersByTimeAsync(60_000)
    await settleIO()
    expect(encode).not.toHaveBeenCalled()
    state().updateLayer('0', { name: '清除后' })
    await vi.advanceTimersByTimeAsync(3_000)
    await until(() => status.at(-1)?.phase === 'saved', '清除后新编辑没有备份')
    expect(encode).toHaveBeenCalledTimes(1)
  })

  it('关闭恢复保留已有副本，重新开启后重新捕获当前未保存内容', async () => {
    fakeClock()
    const { coordinator, repository, encode, status } = create({ minIntervalMs: 0 })
    await coordinator.start()
    state().updateLayer('0', { name: '第一次' })
    await coordinator.flush()
    const id = (await records(repository))[0].id
    await repository.configure({ recoveryEnabled: false })
    await coordinator.refreshSettings()
    state().updateLayer('0', { name: '关闭时的新内容' })
    await coordinator.flush()
    expect(encode).toHaveBeenCalledTimes(1)
    expect((await records(repository))[0].id).toBe(id)
    expect(status.at(-1)?.phase).toBe('disabled')
    await repository.configure({ recoveryEnabled: true })
    await coordinator.refreshSettings()
    await vi.advanceTimersByTimeAsync(3_000)
    await until(() => status.at(-1)?.phase === 'saved', '重新开启未生成新备份')
    expect(encode).toHaveBeenCalledTimes(2)
    const stored = (await records(repository))[0]
    expect(stored.id).toBe(id)
    expect(JSON.parse(await stored.archive.text()).name).toBe('关闭时的新内容')
  })

  it('工程保存完成变为干净时，未完成的后台编码失效', async () => {
    const entered = deferred<void>()
    const release = deferred<Blob>()
    const { coordinator, repository } = create({ encode: () => { entered.resolve(); return release.promise } })
    await coordinator.start()
    state().updateLayer('0', { opacity: 0.4 })
    const pending = coordinator.flush()
    await entered.promise
    expect(state().markProjectSaved(captureExportInputs(state()), null, '已保存.svgaproj')).toBe(true)
    await pending
    await coordinator.saved()
    release.resolve(new Blob(['旧编码']))
    await settleIO()
    expect(await records(repository)).toEqual([])
    expect(state().isDirty).toBe(false)
  })

  it('切换文件时废弃旧编码，新文件沿用串行队列但使用独立身份', async () => {
    const entered = deferred<void>()
    const release = deferred<Blob>()
    const { coordinator, repository, encode } = create()
    encode.mockImplementationOnce(() => { entered.resolve(); return release.promise })
    await coordinator.start()
    state().updateLayer('0', { name: '旧文件内容' })
    const oldPending = coordinator.flush()
    await entered.promise
    setupDocument()
    state().updateLayer('0', { name: '新文件内容' })
    await oldPending
    const newPending = coordinator.flush()
    await settleIO()
    expect(encode).toHaveBeenCalledTimes(1)
    release.resolve(new Blob(['旧文件内容']))
    await newPending
    expect(encode).toHaveBeenCalledTimes(2)
    const stored = await records(repository)
    expect(stored).toHaveLength(1)
    expect(JSON.parse(await stored[0].archive.text()).name).toBe('新文件内容')
  })

  it('仅修改画布尺寸虽然替换视频引用，仍覆盖同一恢复记录', async () => {
    const { coordinator, repository } = create()
    await coordinator.start()
    state().updateLayer('0', { opacity: 0.4 })
    await coordinator.flush()
    const before = state()
    const id = (await records(repository))[0].id
    expect(state().setCanvasSize(160, 120).changed).toBe(true)
    expect(state().videoItem).not.toBe(before.videoItem)
    expect(state().originalBuffer).toBe(before.originalBuffer)
    await coordinator.flush()
    const stored = await records(repository)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id, revision: 2 })
    expect(JSON.parse(await stored[0].archive.text()).width).toBe(160)
  })

  it('停止后取消定时任务并解除订阅，新的编辑和调用不会写入', async () => {
    fakeClock()
    const { coordinator, encode, status, repository } = create()
    await coordinator.start()
    state().updateLayer('0', { name: '排队内容' })
    coordinator.stop()
    const count = status.length
    state().updateLayer('0', { name: '停止后编辑' })
    await coordinator.flush()
    await coordinator.recordRecent(new Blob(['saved']), '停止后.svgaproj')
    await vi.advanceTimersByTimeAsync(60_000)
    await settleIO()
    expect(encode).not.toHaveBeenCalled()
    expect(await records(repository)).toEqual([])
    expect(status).toHaveLength(count)
  })

  it('停止会立即释放 flush，不等待挂起的编码；重新启动也不并行编码', async () => {
    const entered = deferred<void>()
    const release = deferred<Blob>()
    const { coordinator, repository, encode } = create()
    encode.mockImplementationOnce(() => { entered.resolve(); return release.promise })
    await coordinator.start()
    state().updateLayer('0', { opacity: 0.4 })
    const pending = coordinator.flush()
    await entered.promise
    coordinator.stop()
    await pending
    expect(await records(repository)).toEqual([])
    await coordinator.start()
    const restarted = coordinator.flush()
    await settleIO()
    expect(encode).toHaveBeenCalledTimes(1)
    release.resolve(new Blob(['已停止任务']))
    await restarted
    expect(encode).toHaveBeenCalledTimes(2)
    expect(await records(repository)).toHaveLength(1)
  })

  it('启动读取挂起时停止，也不会把 flush 永远留在等待中', async () => {
    const { coordinator, repository, encode } = create()
    const entered = deferred<void>()
    const release = deferred<void>()
    const snapshot = repository.snapshot.bind(repository)
    vi.spyOn(repository, 'snapshot').mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return snapshot()
    })
    const starting = coordinator.start()
    await entered.promise
    const pending = coordinator.flush()
    coordinator.stop()
    await pending
    release.resolve()
    await starting
    expect(encode).not.toHaveBeenCalled()
  })

  it('保存只清理自己的恢复副本，之后记录最近工程，不删除其他工程', async () => {
    const { coordinator, repository } = create()
    await coordinator.start()
    const archive = new Blob(['other'])
    await repository.put({ id: 'other-recovery', kind: 'recovery', name: '其他工程.svgaproj', archive, size: archive.size, revision: 1, updatedAt: Date.now() }, 0)
    state().updateLayer('0', { opacity: 0.4 })
    await coordinator.flush()
    expect(await records(repository)).toHaveLength(2)
    expect(state().markProjectSaved(captureExportInputs(state()), null, '当前工程.svgaproj')).toBe(true)
    await coordinator.saved()
    await coordinator.recordRecent(new Blob(['current']), '当前工程.svgaproj')
    const stored = await records(repository)
    expect(stored).toHaveLength(2)
    expect(stored.find(item => item.kind === 'recovery')?.id).toBe('other-recovery')
    expect(stored.find(item => item.kind === 'recent')?.name).toBe('当前工程.svgaproj')
  })

  it('默认编码器生成可再次打开的真实工程归档，编辑设置与文字完整保留', async () => {
    const { coordinator, repository } = create({ encode: createProjectArchive })
    await coordinator.start()
    state().setCanvasSize(160, 120)
    state().setSlotConfig('image', { type: 'text', name: 'image', value: '恢复昵称' })
    state().setAnimationValue('0', 'position', { x: 12, y: 4 }, 1)
    state().setPlaying(true)
    const history = state().history
    await coordinator.flush()
    const stored = await records(repository)
    expect(stored).toHaveLength(1)
    const document = await readProjectArchive(await stored[0].archive.arrayBuffer())
    expect(document.params).toMatchObject({ viewBoxWidth: 160, viewBoxHeight: 120 })
    expect(document.slotConfigs.image.value).toBe('恢复昵称')
    expect(document.layers[0].animationTracks!.position.keyframes.at(-1)?.value).toEqual({ x: 12, y: 4 })
    expect(state().playback.isPlaying).toBe(true)
    expect(state().history).toBe(history)
    state().restoreProjectDocument(document, null, stored[0].name)
    useEditorStore.setState({ isDirty: true })
    await coordinator.flush()
    const restored = await records(repository)
    expect(restored).toHaveLength(2)
    expect(restored.some(item => item.id === stored[0].id)).toBe(true)
    expect(state().projectFilePath).toBeNull()
    expect(state().isDirty).toBe(true)
  })
})

describe('最近工程：调用时身份、代次与失败传播', () => {
  it('前一写入挂起时，后续保存仍捕获调用时的 epoch，清除后不会复活', async () => {
    const { coordinator, repository } = create()
    await coordinator.start()
    const entered = deferred<void>()
    const release = deferred<void>()
    const put = repository.put.bind(repository)
    const spy = vi.spyOn(repository, 'put').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return put(...args)
    })
    const first = coordinator.recordRecent(new Blob(['first']), '第一份.svgaproj')
    await entered.promise
    const snapshot = vi.spyOn(repository, 'snapshot')
    const second = coordinator.recordRecent(new Blob(['second']), '第二份.svgaproj')
    expect(snapshot).toHaveBeenCalledTimes(1)
    await repository.clear()
    release.resolve()
    await Promise.all([first, second])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(await records(repository)).toEqual([])
  })

  it('没有跨窗口广播时，排队的最近工程也不能读取清除后的新代次再写回', async () => {
    const name = `recent-missed-broadcast-${++names}`
    const repository = openRepository(name)
    const otherWindow = openRepository(name)
    const { coordinator } = create({ repository })
    await coordinator.start()
    const entered = deferred<void>()
    const release = deferred<void>()
    const put = repository.put.bind(repository)
    vi.spyOn(repository, 'put').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return put(...args)
    })
    const first = coordinator.recordRecent(new Blob(['first']), '第一份.svgaproj')
    await entered.promise
    const second = coordinator.recordRecent(new Blob(['second']), '第二份.svgaproj')
    await otherWindow.clear()
    release.resolve()
    await Promise.all([first, second])
    expect(await records(repository)).toEqual([])
  })

  it('排队保存绑定调用时文档，切文件后不把旧字节挂到新工程名下', async () => {
    const { coordinator, repository } = create()
    await coordinator.start()
    const entered = deferred<void>()
    const release = deferred<void>()
    const put = repository.put.bind(repository)
    vi.spyOn(repository, 'put').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return put(...args)
    })
    const first = coordinator.recordRecent(new Blob(['old committed']), '旧工程.svgaproj')
    await entered.promise
    const stale = coordinator.recordRecent(new Blob(['old queued']), '旧工程排队.svgaproj')
    setupDocument()
    const fresh = coordinator.recordRecent(new Blob(['new document']), '新工程.svgaproj')
    release.resolve()
    await Promise.all([first, stale, fresh])
    const stored = await records(repository)
    expect(stored).toHaveLength(2)
    expect(stored.map(item => item.name).sort()).toEqual(['新工程.svgaproj', '旧工程.svgaproj'])
    expect(await stored.find(item => item.name === '新工程.svgaproj')!.archive.text()).toBe('new document')
  })

  it('同一文档新增画布手势不会丢弃已经保存的最近工程副本', async () => {
    const { coordinator, repository } = create()
    await coordinator.start()
    const entered = deferred<void>()
    const release = deferred<void>()
    const snapshot = repository.snapshot.bind(repository)
    vi.spyOn(repository, 'snapshot').mockImplementationOnce(async () => {
      const value = await snapshot()
      entered.resolve()
      await release.promise
      return value
    })
    const pending = coordinator.recordRecent(new Blob(['saved']), '已保存.svgaproj')
    await entered.promise
    expect(state().beginCanvasTransform('0')).toBe(true)
    state().previewCanvasTransform('0', normalizeCanvasTransform({ x: 42 }))
    release.resolve()
    await pending
    const stored = await records(repository)
    expect(stored).toHaveLength(1)
    expect(stored[0].kind).toBe('recent')
    expect(state().isCanvasTransforming).toBe(true)
  })

  it('真实写入错误向调用者传播，失败不会毒化后续队列', async () => {
    const { coordinator, repository } = create()
    await coordinator.start()
    vi.spyOn(repository, 'put').mockRejectedValueOnce(new Error('磁盘空间不足'))
    await expect(coordinator.recordRecent(new Blob(['failure']), '失败.svgaproj')).rejects.toThrow('磁盘空间不足')
    await coordinator.recordRecent(new Blob(['success']), '成功.svgaproj')
    const stored = await records(repository)
    expect(stored).toHaveLength(1)
    expect(stored[0].name).toBe('成功.svgaproj')
  })

  it('最近工程关闭时不写入，重新开启也不能复活关闭期间排队的保存', async () => {
    const { coordinator, repository } = create()
    await coordinator.start()
    const entered = deferred<void>()
    const release = deferred<void>()
    const put = repository.put.bind(repository)
    vi.spyOn(repository, 'put').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return put(...args)
    })
    const first = coordinator.recordRecent(new Blob(['first']), '关闭前.svgaproj')
    await entered.promise
    await repository.configure({ recentEnabled: false })
    await coordinator.refreshSettings()
    const disabled = coordinator.recordRecent(new Blob(['disabled']), '关闭时.svgaproj')
    await repository.configure({ recentEnabled: true })
    await coordinator.refreshSettings()
    release.resolve()
    await Promise.all([first, disabled])
    expect(await records(repository)).toEqual([])
    await coordinator.recordRecent(new Blob(['enabled']), '重新开启.svgaproj')
    expect((await records(repository))[0].name).toBe('重新开启.svgaproj')
  })

  it.each([
    ['D:\\设计\\CON.svgaproj', '_CON.svgaproj'],
    ['LPT1', '_LPT1'],
    ['aux. ', '_aux'],
    ['D:/设计/名称... ', '名称'],
    ['名称<>:"|?*\u0000.svgaproj', '名称________.svgaproj'],
    ['..', '未命名工程.svgaproj'],
    [' ', '未命名工程.svgaproj'],
    [`${'名'.repeat(254)}.继续`, '名'.repeat(254)]
  ])('名称 %s 转为 Windows 可用且通过真实库校验的 %s', async (input, expected) => {
    const { coordinator, repository } = create()
    await coordinator.start()
    await coordinator.recordRecent(new Blob(['name']), input)
    expect((await records(repository))[0].name).toBe(expected)
    useEditorStore.setState({ projectName: input })
    state().updateLayer('0', { opacity: 0.4 })
    await coordinator.flush()
    expect((await records(repository)).find(item => item.kind === 'recovery')?.name).toBe(expected)
  })
})
