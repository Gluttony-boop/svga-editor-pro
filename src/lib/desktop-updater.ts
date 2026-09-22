import { check } from '@tauri-apps/plugin-updater'
import { isTauriDesktopEnvironment, type UpdateAdapter, type UpdateHandle, type UpdateMetadata } from '@/core/update-policy'
import { tauriAPI } from './tauri-api'

function metadata(update: { currentVersion?: string; version: string; date?: string; body?: string }): UpdateMetadata {
  return { currentVersion: update.currentVersion, version: update.version, date: update.date || null, notes: update.body || null }
}

/** 官方插件负责 HTTPS、版本比较和签名验签；这里不实现或绕过密码学。 */
export function createDesktopUpdaterAdapter(): UpdateAdapter {
  return {
    isDesktop: isTauriDesktopEnvironment(),
    async check(): Promise<UpdateHandle | null> {
      if (!isTauriDesktopEnvironment()) throw new Error('网页模式没有桌面自动更新。')
      const configuration = await tauriAPI.app.getUpdateConfiguration()
      if (!configuration.configured) throw new Error(configuration.reason)
      const found = await check({ timeout: 15_000 })
      if (!found) return null
      const info = metadata(found)
      return {
        metadata: info,
        async download(onProgress) {
          let downloaded = 0
          let total: number | null = null
          await found.download(event => {
            if (event.event === 'Started') { total = event.data.contentLength ?? null; onProgress({ downloaded: 0, total }) }
            if (event.event === 'Progress') { downloaded += event.data.chunkLength; onProgress({ downloaded, total }) }
            if (event.event === 'Finished') onProgress({ downloaded, total: total ?? downloaded })
          })
        },
        async install() { await found.install({ restartAfterInstall: false }) },
        async close() { await found.close() },
      }
    },
  }
}
