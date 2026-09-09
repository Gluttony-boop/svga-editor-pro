import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '@/stores'
import type { VideoItem } from '@/types'
import { SVGAOptimizer, getPreset } from './optimizer'
import { SVGAParser } from './parser'
import { captureExportInputs, sameExportInputs, generateExportPreview, loadExportPreviewVideo } from './export-preview'

const params = { viewBoxWidth: 100, viewBoxHeight: 100, frames: 24, fps: 24 }
afterEach(() => { vi.restoreAllMocks() })

describe('export preview snapshots', () => {
  it('ignores playback, selection and viewport state', () => {
    const state = useEditorStore.getState()
    const inputs = captureExportInputs(state)
    expect(sameExportInputs(inputs, captureExportInputs({ ...state, playback: { ...state.playback, currentFrame: 10 }, selectedLayerId: 'other', zoom: 2 } as typeof state))).toBe(true)
  })
  it('invalidates on document, edits, slots and configuration changes', () => {
    const state = useEditorStore.getState()
    const inputs = captureExportInputs(state)
    const changedStates = [
      { ...state, originalBuffer: new ArrayBuffer(2) },
      { ...state, params },
      { ...state, customFps: 60 },
      { ...state, customFrames: 100 },
      { ...state, layers: [...state.layers] },
      { ...state, imageResources: new Map(state.imageResources) },
      { ...state, audioResources: new Map(state.audioResources) },
      { ...state, slotConfigs: { ...state.slotConfigs } },
      { ...state, compressionConfig: { ...state.compressionConfig } },
      { ...state, optimizationConfig: structuredClone(state.optimizationConfig) }
    ]
    for (const changed of changedStates) expect(sameExportInputs(inputs, captureExportInputs(changed))).toBe(false)
  })
})

describe('actual export size comparison', () => {
  it('rejects invalid timing before starting an expensive build', async () => {
    const build = vi.fn(async () => new Blob(['x']))
    await expect(generateExportPreview(build, getPreset('none')!.config, 1, { ...params, fps: Infinity })).rejects.toThrow('帧率或总帧数无效')
    await expect(generateExportPreview(build, getPreset('none')!.config, 1, { ...params, frames: 0 })).rejects.toThrow('帧率或总帧数无效')
    expect(build).not.toHaveBeenCalled()
  })
  it('measures against the edited baseline, retaining exactly the generated blobs', async () => {
    const baseline = new Blob([new Uint8Array(100)])
    const optimized = new Blob([new Uint8Array(80)])
    vi.spyOn(SVGAOptimizer.prototype, 'optimize').mockResolvedValue(optimized)
    const phases: string[] = []
    const result = await generateExportPreview(async () => baseline, getPreset('none')!.config, 500, params, (phase) => phases.push(phase))
    expect(result.sourceBytes).toBe(500)
    expect(result.baseline).toBe(baseline)
    expect(result.optimized).toBe(optimized)
    expect(result.stats.originalSize).toBe(100)
    expect(result.stats.optimizedSize).toBe(80)
    expect(result.stats.reductionPercent).toBe(20)
    expect(result.params).toEqual(params)
    expect(result.params).not.toBe(params)
    expect(phases).toHaveLength(2)
  })
  it('reports growth honestly instead of showing a successful reduction', async () => {
    vi.spyOn(SVGAOptimizer.prototype, 'optimize').mockResolvedValue(new Blob([new Uint8Array(120)]))
    const result = await generateExportPreview(async () => new Blob([new Uint8Array(100)]), getPreset('balanced')!.config, 999, params)
    expect(result.stats.reductionPercent).toBe(-20)
    expect(result.warnings.join()).toContain('变大')
  })
  it('does not optimize an empty baseline or accept an empty result', async () => {
    const optimize = vi.spyOn(SVGAOptimizer.prototype, 'optimize').mockResolvedValue(new Blob())
    await expect(generateExportPreview(async () => new Blob(), getPreset('none')!.config, 0, params)).rejects.toThrow('未优化副本为空')
    expect(optimize).not.toHaveBeenCalled()
    await expect(generateExportPreview(async () => new Blob(['x']), getPreset('none')!.config, 1, params)).rejects.toThrow('优化结果为空')
  })
  it('supports a real no-optimization job without mutating its inputs', async () => {
    const baseline = new Blob([new Uint8Array([1, 2, 3])])
    const config = structuredClone(getPreset('none')!.config)
    const snapshot = structuredClone(config)
    const result = await generateExportPreview(async () => baseline, config, 3, params)
    expect(new Uint8Array(await result.optimized.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(config).toEqual(snapshot)
    expect(result.stats.reductionPercent).toBe(0)
  })
})

describe('isolated preview resources', () => {
  const video = (): VideoItem => ({ movie: { version: '2.0', params, images: {}, sprites: [] }, images: {}, buffers: {} })
  it('owns and releases parser URLs exactly once', async () => {
    vi.spyOn(SVGAParser.prototype, 'parse').mockImplementation(async (_buffer, options) => {
      options?.onImageUrlCreated?.('blob:preview')
      return video()
    })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const loaded = await loadExportPreviewVideo(new Blob(['test']))
    expect(revoke).not.toHaveBeenCalled()
    loaded.dispose()
    loaded.dispose()
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('blob:preview')
  })
  it('releases URLs on decode failure and oversized canvas rejection', async () => {
    const parse = vi.spyOn(SVGAParser.prototype, 'parse').mockImplementation(async (_buffer, options) => {
      options?.onImageUrlCreated?.('blob:failed')
      throw new Error('decode failed')
    })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    await expect(loadExportPreviewVideo(new Blob(['x']))).rejects.toThrow('decode failed')
    expect(revoke).toHaveBeenCalledWith('blob:failed')
    parse.mockImplementation(async (_buffer, options) => {
      options?.onImageUrlCreated?.('blob:large')
      return { ...video(), movie: { ...video().movie, params: { ...params, viewBoxWidth: 10000 } } }
    })
    await expect(loadExportPreviewVideo(new Blob(['x']))).rejects.toThrow('画布过大')
    expect(revoke).toHaveBeenCalledWith('blob:large')
  })
})
