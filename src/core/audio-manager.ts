/**
 * 音频管理器
 * 负责SVGA音频轨道的解析、播放和控制
 * 
 * 参考在线编辑器的音频功能设计：
 * - parseAudioTrack: 从SVGA数据中解析音频轨道
 * - 音频与动画帧同步播放
 * - 多音频轨道管理
 */

import type { Audio, AudioResource, AudioPlaybackState } from '@/types'

export class AudioManager {
  private audioContext: AudioContext | null = null
  private activeSources: Map<string, { source: AudioBufferSourceNode; gainNode: GainNode }> = new Map()
  private audioBuffers: Map<string, AudioBuffer> = new Map()
  private blobUrls: Map<string, string> = new Map()
  private _playbackState: AudioPlaybackState = {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false
  }

  /**
   * 获取或创建 AudioContext
   */
  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext()
    }
    // 恢复被暂停的上下文（浏览器自动暂停策略）
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume()
    }
    return this.audioContext
  }

  /**
   * 从SVGA原始音频数据创建AudioResource
   */
  async parseAudioTrack(audio: Audio): Promise<AudioResource> {
    const uint8Data = audio.data instanceof Uint8Array
      ? audio.data
      : new Uint8Array(audio.data as unknown as ArrayLike<number>)

    // 创建 Blob URL
    const blob = new Blob([uint8Data.buffer as ArrayBuffer], { type: 'audio/mp3' })
    const blobUrl = URL.createObjectURL(blob)
    this.blobUrls.set(audio.key, blobUrl)

    // 解码音频
    let audioBuffer: AudioBuffer | undefined
    try {
      const ctx = this.getAudioContext()
      const arrayBuffer = await blob.arrayBuffer()
      audioBuffer = await ctx.decodeAudioData(arrayBuffer)
      this.audioBuffers.set(audio.key, audioBuffer)
    } catch (err) {
      console.warn(`[AudioManager] 音频解码失败: ${audio.key}`, err)
    }

    return {
      key: audio.key,
      data: uint8Data,
      startTime: audio.startTime || 0,
      duration: audio.duration || (audioBuffer ? audioBuffer.duration * 1000 : 0),
      blobUrl,
      audioBuffer,
      source: {
        type: 'dataUrl',
        value: blobUrl
      }
    }
  }

  /**
   * 批量解析SVGA中的音频轨道
   */
  async parseAudioTracks(audios: Audio[] | undefined): Promise<AudioResource[]> {
    if (!audios || audios.length === 0) return []

    const resources: AudioResource[] = []
    for (const audio of audios) {
      try {
        const resource = await this.parseAudioTrack(audio)
        resources.push(resource)
      } catch (err) {
        console.warn(`[AudioManager] 解析音频轨道失败: ${audio.key}`, err)
      }
    }
    return resources
  }

  /**
   * 从文件创建音频资源
   */
  async loadFromFile(file: File): Promise<{ success: boolean; resource?: AudioResource; error?: string }> {
    try {
      if (!file.type.startsWith('audio/') && !file.name.match(/\.(mp3|wav|ogg|aac|m4a)$/i)) {
        return { success: false, error: '不支持的音频文件格式' }
      }

      const arrayBuffer = await file.arrayBuffer()
      const uint8Data = new Uint8Array(arrayBuffer)

      // 解码音频获取时长
      let audioBuffer: AudioBuffer | undefined
      let duration = 0
      try {
        const ctx = this.getAudioContext()
        audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
        duration = audioBuffer.duration * 1000
      } catch {
        // 解码失败，无法获取精确时长
      }

      const key = `audio_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
      const blob = new Blob([uint8Data], { type: file.type })
      const blobUrl = URL.createObjectURL(blob)
      this.blobUrls.set(key, blobUrl)
      if (audioBuffer) {
        this.audioBuffers.set(key, audioBuffer)
      }

      return {
        success: true,
        resource: {
          key,
          data: uint8Data,
          startTime: 0,
          duration,
          blobUrl,
          audioBuffer,
          source: { type: 'file', value: file.name, file },
          isNew: true
        }
      }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /**
   * 从URL加载音频资源
   */
  async loadFromUrl(url: string): Promise<{ success: boolean; resource?: AudioResource; error?: string }> {
    try {
      const response = await fetch(url)
      if (!response.ok) {
        return { success: false, error: `加载音频失败: HTTP ${response.status}` }
      }

      const arrayBuffer = await response.arrayBuffer()
      const uint8Data = new Uint8Array(arrayBuffer)

      let audioBuffer: AudioBuffer | undefined
      let duration = 0
      try {
        const ctx = this.getAudioContext()
        audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
        duration = audioBuffer.duration * 1000
      } catch {
        // 解码失败
      }

      const key = `audio_url_${Date.now()}`
      const blob = new Blob([uint8Data])
      const blobUrl = URL.createObjectURL(blob)
      this.blobUrls.set(key, blobUrl)
      if (audioBuffer) {
        this.audioBuffers.set(key, audioBuffer)
      }

      return {
        success: true,
        resource: {
          key,
          data: uint8Data,
          startTime: 0,
          duration,
          blobUrl,
          audioBuffer,
          source: { type: 'url', value: url },
          isNew: true
        }
      }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /**
   * 播放指定音频（与动画帧同步）
   * @param key 音频资源key
   * @param startOffsetMs 从动画开始的偏移量（毫秒）
   */
  playAudio(key: string, startOffsetMs: number = 0): void {
    this.stopAudio(key)

    const audioBuffer = this.audioBuffers.get(key)
    if (!audioBuffer) {
      console.warn(`[AudioManager] 音频未解码: ${key}`)
      return
    }

    const ctx = this.getAudioContext()
    const source = ctx.createBufferSource()
    const gainNode = ctx.createGain()

    source.buffer = audioBuffer
    source.connect(gainNode)
    gainNode.connect(ctx.destination)

    // 应用音量和静音
    gainNode.gain.value = this._playbackState.muted ? 0 : this._playbackState.volume

    // 计算偏移
    const offsetSeconds = Math.max(0, startOffsetMs / 1000)
    source.start(0, offsetSeconds)

    this.activeSources.set(key, { source, gainNode })

    source.onended = () => {
      this.activeSources.delete(key)
    }
  }

  /**
   * 停止指定音频
   */
  stopAudio(key: string): void {
    const active = this.activeSources.get(key)
    if (active) {
      try {
        active.source.stop()
      } catch {
        // 已停止的source会抛出异常，忽略
      }
      active.source.disconnect()
      active.gainNode.disconnect()
      this.activeSources.delete(key)
    }
  }

  /**
   * 停止所有音频
   */
  stopAll(): void {
    for (const key of this.activeSources.keys()) {
      this.stopAudio(key)
    }
  }

  /**
   * 与动画帧同步播放音频
   * 根据当前帧索引计算每个音频是否应该播放
   */
  syncWithFrame(
    audioResources: AudioResource[],
    frameIndex: number,
    fps: number,
    isPlaying: boolean
  ): void {
    if (!isPlaying) {
      this.stopAll()
      return
    }

    const currentTimeMs = (frameIndex / fps) * 1000

    for (const audio of audioResources) {
      const audioEnd = audio.startTime + audio.duration
      const shouldBePlaying = currentTimeMs >= audio.startTime && currentTimeMs < audioEnd

      const isActive = this.activeSources.has(audio.key)

      if (shouldBePlaying && !isActive) {
        // 音频应该播放但还没有开始
        const offset = currentTimeMs - audio.startTime
        this.playAudio(audio.key, offset)
      } else if (!shouldBePlaying && isActive) {
        // 音频不应播放但还在播放
        this.stopAudio(audio.key)
      }
    }
  }

  /**
   * 设置音量
   */
  setVolume(volume: number): void {
    this._playbackState.volume = Math.max(0, Math.min(1, volume))
    for (const [, active] of this.activeSources) {
      active.gainNode.gain.value = this._playbackState.muted ? 0 : this._playbackState.volume
    }
  }

  /**
   * 设置静音
   */
  setMuted(muted: boolean): void {
    this._playbackState.muted = muted
    for (const [, active] of this.activeSources) {
      active.gainNode.gain.value = muted ? 0 : this._playbackState.volume
    }
  }

  /**
   * 获取播放状态
   */
  get playbackState(): AudioPlaybackState {
    return { ...this._playbackState }
  }

  /**
   * 获取音频时长（秒）
   */
  getAudioDuration(key: string): number {
    const buffer = this.audioBuffers.get(key)
    return buffer ? buffer.duration : 0
  }

  /**
   * 清理所有资源
   */
  cleanup(): void {
    this.stopAll()

    for (const url of this.blobUrls.values()) {
      URL.revokeObjectURL(url)
    }
    this.blobUrls.clear()
    this.audioBuffers.clear()

    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }
  }
}

// 单例导出
export const audioManager = new AudioManager()
