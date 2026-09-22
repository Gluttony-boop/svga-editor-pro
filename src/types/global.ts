interface NativeDialogResult {
  canceled: boolean
  filePaths?: string[]
  filePath?: string
}

interface NativeFileResult {
  success: boolean
  data?: string
  path?: string
  error?: string
}

interface NativeAPI {
  platform: {
    get: () => Promise<string>
  }
  dialog: {
    openFile: (options?: Record<string, unknown>) => Promise<NativeDialogResult>
    saveFile: (options?: Record<string, unknown>) => Promise<NativeDialogResult>
  }
  file: {
    read: (filePath: string) => Promise<NativeFileResult>
    write: (filePath: string, data: string) => Promise<NativeFileResult>
    saveFile: (buffer: ArrayBuffer, defaultName: string) => Promise<NativeFileResult>
  }
  saveFile: (buffer: ArrayBuffer, defaultName: string) => Promise<NativeFileResult>
  app: {
    getVersion: () => Promise<string>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  window: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
  }
  onMenuAction: (callback: (action: string) => void) => (() => void) | undefined
}

import type { HighPerformanceRenderer } from '@/core'

declare global {
  interface Window {
    nativeAPI?: NativeAPI
    __SVGA_RENDERER__?: HighPerformanceRenderer
    /** MCP 截图使用的当前预览画布；由 CanvasPreview 管理生命周期。 */
    __SVGA_CANVAS__?: HTMLCanvasElement
  }
  
  interface HTMLCanvasElement {
    __renderer?: HighPerformanceRenderer
  }
}

export {}
