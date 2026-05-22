/**
 * Tauri API 适配层
 * 
 * 使用方式：
 *   import { tauriAPI } from '@/lib/tauri-api'
 */

import { invoke } from '@tauri-apps/api/core'
import { open as dialogOpen, save as dialogSave } from '@tauri-apps/plugin-dialog'
import { open as shellOpen } from '@tauri-apps/plugin-shell'

// ==================== 类型定义 ====================

export interface SvgaData {
  version: string
  params: {
    viewBoxWidth: number
    viewBoxHeight: number
    fps: number
    frames: number
  }
  sprites: SvgaSprite[]
  images: Array<{ key: string; data: string }>
  imageMimeTypes: Array<{ key: string; mimeType: string }>
}

export interface SvgaSprite {
  imageKey: string
  matteKey: string
  frames: SvgaFrame[]
}

export interface SvgaFrame {
  alpha: number
  layout: {
    x?: number
    y?: number
    width?: number
    height?: number
  } | null
  transform: {
    a?: number
    b?: number
    c?: number
    d?: number
    tx?: number
    ty?: number
  } | null
  clipPath: string
  shapes: any[]
}

// ==================== Tauri API ====================

export const tauriAPI = {
  // ---------- 平台 ----------
  platform: {
    get: async (): Promise<string> => {
      return invoke<string>('get_platform')
    }
  },

  // ---------- 文件对话框 ----------
  dialog: {
    openFile: async (options?: {
      filters?: Array<{ name: string; extensions: string[] }>
    }): Promise<string | null> => {
      const result = await dialogOpen({
        multiple: false,
        filters: options?.filters || [
          { name: 'SVGA Files', extensions: ['svga'] },
          { name: 'Image Files', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      return result ?? null
    },

    saveFile: async (options?: {
      defaultPath?: string
      filters?: Array<{ name: string; extensions: string[] }>
    }): Promise<string | null> => {
      const result = await dialogSave({
        defaultPath: options?.defaultPath,
        filters: options?.filters || [
          { name: 'SVGA Files', extensions: ['svga'] },
          { name: 'PNG Files', extensions: ['png'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      return result ?? null
    }
  },

  // ---------- 文件读写 ----------
  file: {
    read: async (filePath: string): Promise<{ success: boolean; data?: string; error?: string }> => {
      try {
        const base64 = await invoke<string>('read_file', { filePath })
        return { success: true, data: base64 }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },

    write: async (filePath: string, data: string): Promise<{ success: boolean; error?: string }> => {
      try {
        await invoke('write_file', { filePath, dataBase64: data })
        return { success: true }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }
  },

  // ---------- SVGA 解析（Rust 后端） ----------
  svga: {
    /**
     * 从文件路径解析 SVGA
     * 返回解析后的数据（图片为 base64）
     */
    parseFromFile: async (filePath: string): Promise<SvgaData> => {
      return invoke<SvgaData>('parse_svga', { filePath })
    },

    /**
     * 从 base64 编码的 buffer 解析 SVGA
     */
    parseFromBuffer: async (bufferBase64: string): Promise<SvgaData> => {
      return invoke<SvgaData>('parse_svga_buffer', { bufferBase64 })
    }
  },

  // ---------- 便捷保存 ----------
  saveFile: async (buffer: ArrayBuffer, defaultName: string): Promise<void> => {
    const filePath = await dialogSave({
      defaultPath: defaultName,
      filters: [
        { name: 'SVGA Files', extensions: ['svga'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (!filePath) return

    // ArrayBuffer → base64
    const uint8 = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i])
    }
    const base64 = btoa(binary)

    await invoke('write_file', { filePath, dataBase64: base64 })
  },

  // ---------- 应用信息 ----------
  app: {
    getVersion: async (): Promise<string> => {
      return invoke<string>('get_app_version')
    },
    getLaunchSvgaFile: async (): Promise<string | null> => {
      return invoke<string | null>('get_launch_svga_file')
    }
  },

  // ---------- 外部链接 ----------
  shell: {
    openExternal: async (url: string): Promise<void> => {
      await shellOpen(url)
    }
  },

  // ---------- 窗口控制（Tauri v2 使用 getCurrentWebviewWindow） ----------
  window: {
    minimize: async (): Promise<void> => {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      getCurrentWebviewWindow().minimize()
    },
    maximize: async (): Promise<void> => {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      getCurrentWebviewWindow().toggleMaximize()
    },
    close: async (): Promise<void> => {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      getCurrentWebviewWindow().close()
    }
  }
}

// ==================== 兼容层 ====================

/**
 * 将 Tauri API 包装为统一接口
 * 挂载到 window.nativeAPI
 */
export function createNativeAPI() {
  return {
    platform: tauriAPI.platform,
    dialog: tauriAPI.dialog,
    file: tauriAPI.file,
    saveFile: tauriAPI.saveFile,
    app: tauriAPI.app,
    shell: tauriAPI.shell,
    window: tauriAPI.window,
    // 菜单事件暂用自定义事件模拟
    onMenuAction: (callback: (action: string) => void) => {
      const handler = (e: Event) => {
        const action = (e as CustomEvent).detail
        callback(action)
      }
      window.addEventListener('menu-action', handler)
      return () => {
        window.removeEventListener('menu-action', handler)
      }
    }
  }
}

// 类型导出
export type NativeAPI = ReturnType<typeof createNativeAPI>
