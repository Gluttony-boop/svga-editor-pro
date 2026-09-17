import { describe, expect, it } from 'vitest'
import type { FrameData, Layer, VideoItem } from '@/types'
import { createDefaultTracks } from './layer-factory'
import {
  applyCanvasTransform, applyCanvasTransformsToMovie, applyImportedTrackOverlay, getLayerBaseFrame,
  getLayerGeometry, normalizeCanvasTransform, transformCanvasPoint
} from './layer-transform'

const sourceFrame = (): FrameData => ({
  alpha: 0.8,
  layout: { x: 0, y: 0, width: 100, height: 50 },
  transform: { a: 1.2, b: 0.4, c: 0.3, d: -0.8, tx: 40, ty: 60 },
  clipPath: 'M0 0L100 0L100 50Z',
  shapes: [{ type: 'RECT', rect: { x: 0, y: 0, width: 100, height: 50 } }]
})
const layer = (overrides: Partial<Layer> = {}): Layer => ({
  id: '0', name: '共享素材', type: 'image', visible: true, locked: false,
  expanded: true, opacity: 1, blendMode: 'normal', imageKey: 'shared',
  editableIndex: 0, clip: { startFrame: 0, duration: 2 }, tracks: createDefaultTracks(),
  sprites: { imageKey: 'shared', matteKey: 'mask', frames: [sourceFrame(), sourceFrame()] },
  ...overrides
})

describe('画布整段变换', () => {
  it('缺省或非法数值安全归一化，保留镜像', () => {
    expect(normalizeCanvasTransform({ x: NaN, y: Infinity, scaleX: -2 })).toEqual({ x: 0, y: 0, scaleX: -2, scaleY: 1, rotation: 0 })
    const frame = sourceFrame()
    expect(applyCanvasTransform(frame)).toBe(frame)
  })

  it('原始矩阵不分解，围绕每帧中心旋转缩放并叠加世界位移', () => {
    const frame = sourceFrame()
    const snapshot = JSON.stringify(frame)
    const before = transformCanvasPoint(frame.transform, { x: 50, y: 25 })
    const result = applyCanvasTransform(frame, { x: 12, y: -8, scaleX: 2, scaleY: 3, rotation: Math.PI / 2 })
    const after = transformCanvasPoint(result.transform, { x: 50, y: 25 })
    expect(after.x).toBeCloseTo(before.x + 12)
    expect(after.y).toBeCloseTo(before.y - 8)
    expect(result.transform.a).toBeCloseTo(-1.2)
    expect(result.transform.b).toBeCloseTo(2.4)
    expect(result.transform.c).toBeCloseTo(2.4)
    expect(result.transform.d).toBeCloseTo(0.6)
    expect(result.shapes).toBe(frame.shapes)
    expect(result.clipPath).toBe(frame.clipPath)
    expect(result.alpha).toBe(frame.alpha)
    expect(JSON.stringify(frame)).toBe(snapshot)
  })

  it('稀疏矩阵的显式零和layout回退位置正确区分', () => {
    const frame = { alpha: 1, layout: { x: 9, y: 13, width: 10, height: 20 }, transform: { tx: 0 }, clipPath: null } as FrameData
    const result = applyCanvasTransform(frame, { x: 3, y: 4 })
    expect(result.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, tx: 3, ty: 17 })
  })

  it('位移跟随各帧原始运动，不把当前帧矩阵写到全部帧', () => {
    const selected = layer({ canvasTransform: { x: 20, y: 30, scaleX: 1, scaleY: 1, rotation: 0 } })
    selected.sprites!.frames[1].transform.tx += 90
    const a = getLayerGeometry(selected, 0)!
    const b = getLayerGeometry(selected, 1)!
    expect(b.frame.transform.tx - a.frame.transform.tx).toBeCloseTo(90)
    expect(a.center.x + 20).toBeCloseTo((a.quad[0].x + a.quad[2].x) / 2)
    expect(a.baseBounds.width).toBeCloseTo(135)
  })

  it('新增图层以轨道为基础且画布调整只应用一次', () => {
    const selected = layer({ isNew: true, sprites: undefined, editableIndex: undefined,
      canvasTransform: { x: 5, y: 6, scaleX: 1, scaleY: 1, rotation: 0 } })
    selected.tracks.position.defaultValue = { x: 10, y: 20 }
    const images = new Map([['shared', { width: 60, height: 80 }]])
    expect(getLayerBaseFrame(selected, 0, null, images)?.transform.tx).toBe(10)
    expect(getLayerGeometry(selected, 0, null, images)?.frame.transform.tx).toBe(15)
    expect(getLayerBaseFrame(selected, 2, null, images)).toBeNull()
  })

  it('共享图片按稳定图层索引独立导出，支持重排', () => {
    const first = layer({ canvasTransform: { x: 10, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } })
    const second = layer({ id: '1', editableIndex: 1 })
    const movie = { sprites: [{ ...first.sprites! }, { ...second.sprites! }] }
    applyCanvasTransformsToMovie(movie, [second, first])
    expect(movie.sprites[0].frames[0].transform.tx).toBe(50)
    expect(movie.sprites[1].frames[0].transform.tx).toBe(40)
    expect(first.sprites!.frames[0].transform.tx).toBe(40)
    expect(movie.sprites[0].matteKey).toBe('mask')
  })

  it('没有选中图层原sprite时可从视频索引取到原始帧', () => {
    const video = { movie: { sprites: [layer().sprites] }, images: {} } as unknown as VideoItem
    expect(getLayerBaseFrame(layer({ sprites: undefined }), 0, video)?.transform.tx).toBe(40)
    expect(getLayerGeometry(layer({ visible: false }), 0, video)).toBeNull()
  })

  it('短sprite结束后不生成幽灵边框或延长最后一帧', () => {
    const selected = layer({ clip: { startFrame: 0, duration: 10 } })
    expect(getLayerBaseFrame(selected, 2)).toBeNull()
    expect(getLayerGeometry(selected, 2)).toBeNull()
  })

  it('导入层只叠加显式关键帧，几何基准包含轨道而不重复整段调整', () => {
    const selected = layer({ canvasTransform: { x: 5, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } })
    selected.tracks.scale.defaultValue = { scaleX: 999, scaleY: 999 }
    selected.tracks.rotation.defaultValue = 180
    selected.tracks.alpha.defaultValue = 0
    selected.tracks.position.keyframes = [{ id: 'position', frameIndex: 0, value: { x: 12, y: 8 }, easing: 'linear' }]
    const raw = selected.sprites!.frames[0]
    const tracked = applyImportedTrackOverlay(raw, selected, 0)
    expect(tracked.transform).toEqual({ ...raw.transform, tx: 52, ty: 68 })
    expect(tracked.alpha).toBe(0.8)
    expect(getLayerBaseFrame(selected, 0)?.transform.tx).toBe(52)
    expect(getLayerGeometry(selected, 0)?.frame.transform.tx).toBe(57)
  })
})
