import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProjectSaveTarget, getProjectFileName, isProjectFileName } from './project-files'
import { tauriAPI } from './tauri-api'

vi.mock('./tauri-api', () => ({ tauriAPI: { dialog: { saveFile: vi.fn() }, file: { writeProject: vi.fn() } } }))
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('window', {}) })
afterEach(() => { vi.unstubAllGlobals() })

describe('工程保存目标', () => {
  it('工程名称只用文件名，不会覆盖源SVGA', () => {
    expect(getProjectFileName('D:\\assets\\礼物.svga')).toBe('礼物.svgaproj')
    expect(getProjectFileName('https://example.test/f.svga?q=secret')).toBe('f.svgaproj')
    expect(getProjectFileName('f.SVGAPROJ')).toBe('f.svgaproj')
    expect(isProjectFileName('f.svga')).toBe(false)
  })
  it('原生选择取消不产生任何写入', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    vi.mocked(tauriAPI.dialog.saveFile).mockResolvedValue(null)
    expect(await createProjectSaveTarget('f.svga')).toBeNull()
    expect(tauriAPI.file.writeProject).not.toHaveBeenCalled()
  })
  it('原生工程覆盖调用专用安全写入，明确路径和文件名', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    vi.mocked(tauriAPI.file.writeProject).mockResolvedValue({ success: true })
    const target = await createProjectSaveTarget('f', 'D:/edit/f.svgaproj')
    expect(target?.filePath).toBe('D:/edit/f.svgaproj')
    expect(target?.confirmation).toBe('written')
    await target!.write(new Blob(['ZIPDATA']))
    expect(tauriAPI.dialog.saveFile).not.toHaveBeenCalled()
    expect(tauriAPI.file.writeProject).toHaveBeenCalledWith('D:/edit/f.svgaproj', btoa('ZIPDATA'))
  })
  it('原生目标扩展名错误、后端失败都不伪报成功', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    await expect(createProjectSaveTarget('f', 'D:/source.svga')).rejects.toThrow('不能覆盖')
    vi.mocked(tauriAPI.file.writeProject).mockResolvedValue({ success: false, error: 'disk full' })
    const target = await createProjectSaveTarget('f', 'D:/f.svgaproj')
    await expect(target!.write(new Blob(['data']))).rejects.toThrow('disk full')
  })
  it('浏览器正常写入后才完成，使用工程扩展名和原子writable', async () => {
    const write = vi.fn(), close = vi.fn(), abort = vi.fn()
    const picker = vi.fn().mockResolvedValue({ name: 'edit.svgaproj', createWritable: async () => ({ write, close, abort }) })
    vi.stubGlobal('window', { showSaveFilePicker: picker })
    const target = await createProjectSaveTarget('f')
    await target!.write(new Blob(['data']))
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'f.svgaproj' }))
    expect(write).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(abort).not.toHaveBeenCalled()
    expect(target?.displayName).toBe('edit.svgaproj')
  })
  it('浏览器取消返回null，其他picker错误不悄悄降级为下载', async () => {
    const picker = vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError'))
    vi.stubGlobal('window', { showSaveFilePicker: picker })
    expect(await createProjectSaveTarget('f')).toBeNull()
    picker.mockRejectedValue(new Error('permission'))
    await expect(createProjectSaveTarget('f')).rejects.toThrow('permission')
  })
  it('浏览器写入或close失败会abort临时写入', async () => {
    const abort = vi.fn()
    vi.stubGlobal('window', { showSaveFilePicker: async () => ({ name: 'f.svgaproj', createWritable: async () => ({
      write: vi.fn(), close: () => { throw new Error('close failed') }, abort,
    }) }) })
    const target = await createProjectSaveTarget('f')
    await expect(target!.write(new Blob(['data']))).rejects.toThrow('close failed')
    expect(abort).toHaveBeenCalledOnce()
  })
  it('浏览器显式拒绝把工程写入svga文件', async () => {
    vi.stubGlobal('window', { showSaveFilePicker: async () => ({ name: 'source.svga' }) })
    await expect(createProjectSaveTarget('f')).rejects.toThrow('不能覆盖')
  })
  it('无法确认下载完成时明确返回download类型，且不写空文件', async () => {
    const target = await createProjectSaveTarget('f')
    expect(target?.confirmation).toBe('download')
    await expect(target!.write(new Blob())).rejects.toThrow('为空')
  })
})
