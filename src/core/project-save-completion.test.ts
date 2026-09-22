import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '@/stores/editorStore'
import { captureExportInputs } from './export-preview'
import { finishProjectSave } from './project-save-completion'

const state = () => useEditorStore.getState()
const open = () => {
  state().setVideoItem({ movie: { version: '2.0', params: { viewBoxWidth: 20, viewBoxHeight: 20, fps: 20, frames: 10 }, sprites: [], images: {} }, images: {}, buffers: {} })
  state().setOriginalBuffer(new ArrayBuffer(8))
  state().setCustomFps(30)
}
beforeEach(() => { state().reset(); open() })
afterEach(() => { state().reset(); vi.restoreAllMocks() })
const options = () => ({ archive: new Blob(['project']), inputs: captureExportInputs(state()), displayName: 'saved.svgaproj', filePath: null })

describe('写盘成功后的本机副本维护', () => {
  it('只有文件写入状态仍最新才清理恢复副本并记录最近工程', async () => {
    const recovery = { saved: vi.fn(async () => {}), recordRecent: vi.fn(async () => {}) }
    const request = options()
    expect(await finishProjectSave({ ...request, recovery })).toEqual({ current: true })
    expect(state().isDirty).toBe(false)
    expect(recovery.saved).toHaveBeenCalledOnce()
    expect(recovery.recordRecent).toHaveBeenCalledWith(request.archive, request.displayName)
  })
  it('缓存写入失败不撤销磁盘保存，返回独立警告而不是抛出保存错误', async () => {
    const recovery = { saved: vi.fn(async () => { throw new Error('quota') }), recordRecent: vi.fn(async () => { throw new Error('unavailable') }) }
    const result = await finishProjectSave({ ...options(), recovery })
    expect(result.current).toBe(true)
    expect(result.localWarning).toContain('工程文件已写入')
    expect(result.localWarning).toContain('最近工程')
    expect(state().projectName).toBe('saved.svgaproj')
    expect(state().isDirty).toBe(false)
  })
  it('写入期间已经变化的输入不能清除dirty或清理恢复副本', async () => {
    const request = options()
    state().setCustomFrames(30)
    const recovery = { saved: vi.fn(), recordRecent: vi.fn() }
    expect(await finishProjectSave({ ...request, recovery })).toEqual({ current: false })
    expect(state().isDirty).toBe(true)
    expect(recovery.saved).not.toHaveBeenCalled()
  })
  it('缓存维护期间再次编辑时返回false，阻止关闭/切换时遗漏新的未保存修改', async () => {
    const recovery = { saved: async () => { state().setCustomFrames(40) }, recordRecent: vi.fn(async () => {}) }
    expect((await finishProjectSave({ ...options(), recovery })).current).toBe(false)
    expect(state().isDirty).toBe(true)
    expect(recovery.recordRecent).toHaveBeenCalledOnce()
  })
  it('缓存维护时已打开新文件，旧快照不能被记录到新文档最近工程', async () => {
    const recovery = { saved: async () => { open() }, recordRecent: vi.fn(async () => {}) }
    expect((await finishProjectSave({ ...options(), recovery })).current).toBe(false)
    expect(recovery.recordRecent).not.toHaveBeenCalled()
  })
})
