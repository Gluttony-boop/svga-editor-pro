import { tauriAPI } from './tauri-api'

export interface ProjectSaveTarget {
  filePath: string | null
  displayName: string
  confirmation: 'written' | 'download'
  write: (blob: Blob) => Promise<void>
}
type Writable = { write: (data: ArrayBuffer) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void> }
type SavePicker = (options: unknown) => Promise<{ name: string; createWritable: () => Promise<Writable> }>

export function isProjectFileName(name: string): boolean { return /\.svgaproj$/i.test(name) }
export function getProjectFileName(name?: string | null): string {
  const base = (name || '未命名').split(/[\\/]/).pop()!.split(/[?#]/)[0].replace(/\.(?:svga|svgaproj)$/i, '')
  return `${base || '未命名'}.svgaproj`
}

const assertTarget = (name: string) => {
  if (!isProjectFileName(name)) throw new Error('工程文件必须使用 .svgaproj 扩展名，不能覆盖原 SVGA 文件。')
}
const assertBlob = (blob: Blob) => {
  if (!blob.size || blob.size > 128 * 1024 * 1024) throw new Error('工程为空或超过 128 MiB，未写入文件。')
}

/** 保存目标在异步编码前选择，浏览器不会因失去用户手势而拒绝文件对话框。 */
export async function createProjectSaveTarget(defaultName: string, existingPath?: string | null): Promise<ProjectSaveTarget | null> {
  const name = getProjectFileName(defaultName)
  if ('__TAURI_INTERNALS__' in window) {
    const path = existingPath || await tauriAPI.dialog.saveFile({ defaultPath: name, filters: [{ name: 'SVGA Editor 工程', extensions: ['svgaproj'] }] })
    if (!path) return null
    assertTarget(path)
    return { filePath: path, displayName: path.split(/[\\/]/).pop()!, confirmation: 'written', write: async blob => {
      assertBlob(blob)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const chunks: string[] = []
      for (let index = 0; index < bytes.length; index += 8192) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)))
      const result = await tauriAPI.file.writeProject(path, btoa(chunks.join('')))
      if (!result.success) throw new Error(result.error || '工程写入失败，原文件保留。')
    } }
  }
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker
  if (picker) {
    let handle: Awaited<ReturnType<SavePicker>>
    try { handle = await picker.call(window, { suggestedName: name, types: [{ description: 'SVGA Editor 工程', accept: { 'application/zip': ['.svgaproj'] } }] }) }
    catch (error) { if ((error as Error).name === 'AbortError') return null; throw error }
    // 某些测试或旧浏览器句柄没有 name；指定名称仍由文件对话框负责。
    const displayName = handle.name || name
    assertTarget(displayName)
    return { filePath: null, displayName, confirmation: 'written', write: async blob => {
      assertBlob(blob)
      let writable: Writable | undefined
      try {
        const buffer = await blob.arrayBuffer()
        writable = await handle.createWritable()
        await writable.write(buffer)
        await writable.close()
        writable = undefined
      } catch (error) { try { await writable?.abort?.() } catch { /* 保留原始写入错误。 */ } throw error }
    } }
  }
  return { filePath: null, displayName: name, confirmation: 'download', write: async blob => {
    assertBlob(blob)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = name
    document.body.appendChild(anchor)
    anchor.click(); anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  } }
}
