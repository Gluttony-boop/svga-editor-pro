import { afterEach, describe, expect, it, vi } from 'vitest'
import { save as dialogSave } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { createNativeAPI } from '@/lib/tauri-api'
import { saveGeneratedFile } from './exporter'

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })

describe('save result reporting', () => {
  it('任务文件使用独立扩展名与保存类型，不混作客户交付 ZIP', async () => {
    const write = vi.fn(), close = vi.fn(), picker = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }))
    vi.stubGlobal('window', { showSaveFilePicker: picker })
    expect(await saveGeneratedFile(new Blob(['task']), 'batch.svgabatch')).toBe(true)
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'batch.svgabatch', types: [
      { description: 'SVGA 批量任务（包含源快照）', accept: { 'application/octet-stream': ['.svgabatch'] } },
    ] })
    expect(write).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
  it('does not report success when the native save dialog is cancelled', async () => {
    vi.mocked(dialogSave).mockResolvedValue(null)
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, nativeAPI: createNativeAPI() })
    expect(await saveGeneratedFile(new Blob(['svga-bytes']), 'test.svga')).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })
  it('reports write errors rather than silently downloading to a different destination', async () => {
    const click = vi.fn(), abort = vi.fn()
    vi.stubGlobal('document', { createElement: () => ({ click }), body: { appendChild: () => {}, removeChild: () => {} } })
    vi.stubGlobal('window', { showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async () => { throw new Error('disk full') }, close: async () => {}, abort }) }) })
    await expect(saveGeneratedFile(new Blob(['svga-bytes']), 'test.svga')).rejects.toThrow('disk full')
    expect(click).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalled()
  })
  it('writes to the selected native destination and propagates permission errors', async () => {
    vi.mocked(dialogSave).mockResolvedValue('D:/exports/test.svga')
    vi.mocked(invoke).mockResolvedValue(undefined)
    vi.stubGlobal('window', {__TAURI_INTERNALS__: {}, nativeAPI:createNativeAPI()})
    expect(await saveGeneratedFile(new Blob(['abc']), 'test.svga')).toBe(true)
    expect(invoke).toHaveBeenCalledWith('write_file', {filePath:'D:/exports/test.svga',dataBase64:'YWJj'})
    vi.mocked(invoke).mockRejectedValue(new Error('permission denied'))
    await expect(saveGeneratedFile(new Blob(['abc']), 'test.svga')).rejects.toThrow('permission denied')
  })
})
