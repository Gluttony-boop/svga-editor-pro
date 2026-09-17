import { describe, expect, it } from 'vitest'
import type { FrameData, Layer, Sprite, VideoItem } from '@/types'
import { createDefaultTracks } from './layer-factory'
import { getLayerOutputRange } from './layer-time'
import { planLayerTiming } from './timing-plan'
import type { LayerTimingPlan, TimingRequest } from './timing-plan'

function sprite(imageKey: string, matteKey: string | null = null): Sprite {
  const frame: FrameData = {
    alpha: 1, layout: { x: 0, y: 0, width: 20, height: 20 },
    transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, clipPath: null
  }
  return { imageKey, matteKey, frames: [frame] }
}

function layer(id: string, overrides: Partial<Layer> = {}): Layer {
  return {
    id, name: `图层 ${id}`, type: 'image', imageKey: id,
    visible: true, locked: false, expanded: true, opacity: 1, blendMode: 'normal',
    clip: { startFrame: 0, duration: 20 }, tracks: createDefaultTracks(),
    sprites: sprite(id), ...overrides
  }
}

function video(sprites: Sprite[] = []): VideoItem {
  return {
    movie: { version: '2.0', params: { viewBoxWidth: 100, viewBoxHeight: 100, fps: 30, frames: 100 }, images: {}, sprites },
    images: {}, buffers: {}
  }
}

function request(overrides: Partial<TimingRequest> = {}): TimingRequest {
  return { mode: 'shift', frames: 5, extendDuration: false, ...overrides }
}

function plan(layers: readonly Layer[], selected: readonly string[], options: Partial<TimingRequest> = {}, total = 100) {
  const result = planLayerTiming(layers, selected, video(), total, request(options))
  if ('error' in result) throw new Error(result.error)
  return result
}

function error(result: LayerTimingPlan) {
  expect(result).toHaveProperty('error')
  expect(result).not.toHaveProperty('offsets')
  return 'error' in result ? result.error : ''
}

function outputStart(item: Layer, offset: number) {
  return getLayerOutputRange({ ...item, timeOffsetFrames: offset }).startFrame
}

describe('图层时间偏移规划', () => {
  it('延后叠加现有偏移，源 clip 和关键帧保持不变', () => {
    const a = layer('a', { clip: { startFrame: 3, duration: 20 }, timeOffsetFrames: 7 })
    a.tracks.position.keyframes = [{ id: 'position', frameIndex: 5, value: { x: 10, y: 20 }, easing: 'linear' }]
    const snapshot = JSON.stringify(a)
    const clip = a.clip
    const frames = a.sprites!.frames
    const tracks = a.tracks
    const result = plan([a], ['a'], { frames: 10 })
    expect(result).toEqual({ offsets: { a: 17 }, totalFrames: 100, changed: true })
    expect(outputStart(a, result.offsets.a)).toBe(20)
    expect(JSON.stringify(a)).toBe(snapshot)
    expect(a.clip).toBe(clip)
    expect(a.sprites!.frames).toBe(frames)
    expect(a.tracks).toBe(tracks)
  })

  it('正源起点允许负偏移，将图层提前至第 1 帧', () => {
    const a = layer('a', { clip: { startFrame: 10, duration: 20 } })
    expect(plan([a], ['a'], { frames: -10 })).toEqual({ offsets: { a: -10 }, totalFrames: 100, changed: true })
  })

  it('任一图层早于第 1 帧时整次拒绝，不截掉开头', () => {
    const layers = [layer('a', { timeOffsetFrames: 10 }), layer('b')]
    expect(error(planLayerTiming(layers, ['a', 'b'], video(), 100, request({ frames: -1 })))).toContain('第 1 帧')
    expect(layers[0].timeOffsetFrames).toBe(10)
    expect(layers[1].timeOffsetFrames).toBeUndefined()
  })

  it('复位清零所有选中层偏移，不自动缩短动画', () => {
    const a = layer('a', { timeOffsetFrames: 80 })
    const b = layer('b', { clip: { startFrame: 10, duration: 20 }, timeOffsetFrames: -4 })
    expect(plan([a, b], ['a', 'b'], { mode: 'reset', frames: 0 })).toEqual({ offsets: { a: 0, b: 0 }, totalFrames: 100, changed: true })
  })

  it('反向平移可回到原偏移，不依赖逐帧重写', () => {
    const original = layer('a', { timeOffsetFrames: 8 })
    const forward = plan([original], ['a'], { frames: 20 })
    const backward = plan([{ ...original, timeOffsetFrames: forward.offsets.a }], ['a'], { frames: -20 })
    expect(backward.offsets.a).toBe(8)
    expect(original.timeOffsetFrames).toBe(8)
  })

  it('新增图片层不需要原始 sprite，可以独立调整', () => {
    const a = layer('new', { isNew: true, sprites: undefined, clip: { startFrame: 8, duration: 20 } })
    expect(plan([a], ['new'], { frames: -3 }).offsets.new).toBe(-3)
  })

  it('相同图片 Key 的普通图层互不连带调整', () => {
    const a = layer('a', { imageKey: 'shared', sprites: sprite('shared') })
    const b = layer('b', { imageKey: 'shared', sprites: sprite('shared'), timeOffsetFrames: 7 })
    expect(plan([a, b], ['a']).offsets).toEqual({ a: 5 })
    expect(b.timeOffsetFrames).toBe(7)
  })

  it('选中 ID 去重，但未知 ID 不会被静默过滤', () => {
    expect(plan([layer('a')], ['a', 'a']).offsets).toEqual({ a: 5 })
    error(planLayerTiming([layer('a')], ['a', 'missing', 'missing'], video(), 100, request()))
  })
})

describe('图层错峰规划', () => {
  it('按图层列表顺序而非点击顺序，以首层当前输出起点为基准', () => {
    const layers = [
      layer('a', { clip: { startFrame: 10, duration: 20 }, timeOffsetFrames: 5 }),
      layer('unselected'), layer('b', { clip: { startFrame: 3, duration: 10 }, timeOffsetFrames: 20 }),
      layer('c', { clip: { startFrame: 8, duration: 30 }, timeOffsetFrames: 2 })
    ]
    const result = plan(layers, ['c', 'a', 'b', 'a'], { mode: 'stagger', frames: 7 })
    expect(result.offsets).toEqual({ a: 5, b: 19, c: 21 })
    expect(['a', 'b', 'c'].map(id => outputStart(layers.find(item => item.id === id)!, result.offsets[id]))).toEqual([15, 22, 29])
    expect(layers.map(item => item.clip.duration)).toEqual([20, 20, 10, 30])
  })

  it('零间隔让不同源起点、不同偏移的图层同时开始', () => {
    const layers = [layer('a', { timeOffsetFrames: 5 }), layer('b', { clip: { startFrame: 10, duration: 20 } })]
    const result = plan(layers, ['a', 'b'], { mode: 'stagger', frames: 0 })
    expect(result.offsets).toEqual({ a: 5, b: -5 })
  })

  it('新增层与导入层可以混合错峰，持续时间不受间隔影响', () => {
    const layers = [layer('a', { clip: { startFrame: 3, duration: 10 } }), layer('new', { isNew: true, sprites: undefined, clip: { startFrame: 20, duration: 6 } })]
    const result = plan(layers, ['new', 'a'], { mode: 'stagger', frames: 4 })
    expect(result.offsets).toEqual({ a: 0, new: -13 })
    expect(outputStart(layers[1], result.offsets.new)).toBe(7)
  })

  it('少于 2 个不同图层或负间隔时拒绝错峰', () => {
    const a = layer('a')
    expect(error(planLayerTiming([a], ['a', 'a'], video(), 100, request({ mode: 'stagger' })))).toContain('2')
    expect(error(planLayerTiming([a, layer('b')], ['a', 'b'], video(), 100, request({ mode: 'stagger', frames: -1 })))).toContain('非负')
  })
})

describe('时间范围与自动延长保护', () => {
  it('关闭自动延长时越界拒绝，不裁切图层尾部', () => {
    const a = layer('a', { clip: { startFrame: 0, duration: 100 } })
    expect(error(planLayerTiming([a], ['a'], video(), 100, request()))).toContain('延长总帧数以保留尾部')
    expect(a.clip.duration).toBe(100)
  })

  it('开启自动延长时取当前长度与所选新尾帧的最大值', () => {
    const layers = [layer('a', { clip: { startFrame: 0, duration: 100 } }), layer('b', { clip: { startFrame: 8, duration: 50 } })]
    expect(plan(layers, ['a', 'b'], { frames: 20, extendDuration: true })).toEqual({ offsets: { a: 20, b: 20 }, totalFrames: 120, changed: true })
  })

  it('错峰后按最长的新结束时间延长，不假设最后层持续最久', () => {
    const layers = [layer('a', { clip: { startFrame: 0, duration: 98 } }), layer('b', { clip: { startFrame: 0, duration: 110 } }), layer('c')]
    const result = plan(layers, ['a', 'b', 'c'], { mode: 'stagger', frames: 10, extendDuration: true })
    expect(result.totalFrames).toBe(120)
  })

  it('恰好结束在动画末尾不需要开启自动延长', () => {
    const a = layer('a', { clip: { startFrame: 10, duration: 80 } })
    expect(plan([a], ['a'], { frames: 10 }).totalFrames).toBe(100)
  })

  it('自动延长上限允许 10000 帧但拒绝更多', () => {
    const a = layer('a')
    expect(plan([a], ['a'], { frames: 9980, extendDuration: true }).totalFrames).toBe(10000)
    expect(error(planLayerTiming([a], ['a'], video(), 100, request({ frames: 9981, extendDuration: true })))).toContain('10000')
  })

  it('已有超过上限的动画可在既有范围内调整，但不能继续扩长', () => {
    const a = layer('a')
    expect(plan([a], ['a'], { frames: 11980, extendDuration: true }, 12000).totalFrames).toBe(12000)
    error(planLayerTiming([a], ['a'], video(), 12000, request({ frames: 11981, extendDuration: true })))
  })

  it('复位也不能悄悄裁切源范围，必要时需明确开启延长', () => {
    const a = layer('a', { clip: { startFrame: 10, duration: 100 }, timeOffsetFrames: -10 })
    error(planLayerTiming([a], ['a'], video(), 100, request({ mode: 'reset' })))
    expect(plan([a], ['a'], { mode: 'reset', extendDuration: true }).totalFrames).toBe(110)
  })
})

describe('遮罩组件时间保护', () => {
  function maskedLayers() {
    return [layer('content', { sprites: sprite('content', 'mask') }), layer('mask'), layer('other')]
  }

  it.each(['content', 'mask'])('只选择 %s 时拒绝拆开遮罩与内容时间', id => {
    expect(error(planLayerTiming(maskedLayers(), [id], video(), 100, request()))).toContain('整个遮罩关联组')
  })

  it('完整选择内容与遮罩允许统一平移', () => {
    expect(plan(maskedLayers(), ['content', 'mask']).offsets).toEqual({ content: 5, mask: 5 })
  })

  it('完整遮罩组件可复位，恢复到各自源时间', () => {
    const layers = maskedLayers()
    layers[0].timeOffsetFrames = 12
    layers[1].timeOffsetFrames = 15
    expect(plan(layers, ['content', 'mask'], { mode: 'reset' }).offsets).toEqual({ content: 0, mask: 0 })
  })

  it('即使整组选择，错峰仍会拒绝遮罩关联', () => {
    expect(error(planLayerTiming(maskedLayers(), ['content', 'mask'], video(), 100, request({ mode: 'stagger' })))).toContain('不能错峰')
  })

  it('遮罩组件未涉及当前选区时不阻碍普通图层时间编辑', () => {
    expect(plan(maskedLayers(), ['other']).offsets).toEqual({ other: 5 })
  })

  it('共享遮罩的多个内容层必须全部选中', () => {
    const layers = [layer('a', { sprites: sprite('a', 'mask') }), layer('b', { sprites: sprite('b', 'mask') }), layer('mask')]
    error(planLayerTiming(layers, ['a', 'mask'], video(), 100, request()))
    expect(plan(layers, ['mask', 'a', 'b']).offsets).toEqual({ a: 5, b: 5, mask: 5 })
  })

  it('同一遮罩 Key 的多个候选图层都受保护，不能仅改第一个匹配层', () => {
    const layers = [layer('a', { sprites: sprite('a', 'mask') }), layer('mask1', { imageKey: 'mask', sprites: sprite('mask') }), layer('mask2', { imageKey: 'mask', sprites: sprite('mask') })]
    error(planLayerTiming(layers, ['a', 'mask1'], video(), 100, request()))
    expect(plan(layers, ['a', 'mask1', 'mask2']).offsets).toEqual({ a: 5, mask1: 5, mask2: 5 })
  })

  it('多级遮罩链必须整条关联组件选中', () => {
    const layers = [layer('a', { sprites: sprite('a', 'mask') }), layer('mask', { sprites: sprite('mask', 'outer') }), layer('outer')]
    error(planLayerTiming(layers, ['a', 'mask'], video(), 100, request()))
    expect(plan(layers, ['a', 'mask', 'outer']).offsets).toEqual({ a: 5, mask: 5, outer: 5 })
  })

  it('遮罩成员锁定或隐藏时不能通过选择完整组件绕开保护', () => {
    const layers = maskedLayers()
    layers[1].locked = true
    error(planLayerTiming(layers, ['content', 'mask'], video(), 100, request()))
  })

  it('缺少关联遮罩时拒绝内容层平移与复位', () => {
    const a = layer('a', { sprites: sprite('a', 'missing-mask') })
    for (const mode of ['shift', 'reset'] as const) {
      expect(error(planLayerTiming([a], ['a'], video(), 100, request({ mode })))).toContain('遮罩图层缺失')
    }
  })

  it('原始图层按 editableIndex 而非当前列表位置查找遮罩关系', () => {
    const source = video([sprite('content', 'mask'), sprite('mask')])
    const layers = [layer('renamed-mask', { imageKey: 'mask', sprites: undefined, editableIndex: 1 }), layer('renamed-content', { imageKey: 'content', sprites: undefined, editableIndex: 0 })]
    error(planLayerTiming(layers, ['renamed-mask'], source, 100, request()))
    expect(planLayerTiming(layers, ['renamed-mask', 'renamed-content'], source, 100, request()))
      .toMatchObject({ offsets: { 'renamed-mask': 5, 'renamed-content': 5 }, changed: true })
  })

  it('旧数字 ID 也能映射原始 sprite，未知索引不会崩溃或误命中', () => {
    const source = video([sprite('content', 'mask'), sprite('mask')])
    const layers = [layer('0', { imageKey: 'content', sprites: undefined }), layer('1', { imageKey: 'mask', sprites: undefined })]
    error(planLayerTiming(layers, ['0'], source, 100, request()))
    expect(planLayerTiming(layers, ['0', '1'], source, 100, request())).toMatchObject({ offsets: { '0': 5, '1': 5 } })
    error(planLayerTiming([layer('unknown', { sprites: undefined, editableIndex: 99999 })], ['unknown'], source, 100, request()))
  })

  it('isNew 复制层保留的遮罩信息也受保护，不能绕过关联检查错峰', () => {
    const layers = [layer('new', { isNew: true, sprites: sprite('new', 'mask') }), layer('mask')]
    error(planLayerTiming(layers, ['new'], video(), 100, request()))
    expect(error(planLayerTiming(layers, ['new', 'mask'], video(), 100, request({ mode: 'stagger' })))).toContain('不能错峰')
    expect(plan(layers, ['new', 'mask']).offsets).toEqual({ new: 5, mask: 5 })
  })

  it('isNew 复制层的遮罩缺失时保守拒绝时间调整', () => {
    const a = layer('new', { isNew: true, sprites: sprite('new', 'missing-mask') })
    expect(error(planLayerTiming([a], ['new'], video(), 100, request()))).toContain('遮罩图层缺失')
  })
})

describe('时间规划数值、空操作与不变性', () => {
  it.each([{ locked: true }, { visible: false }, { type: 'audio' }, { type: 'text' }, { type: 'shape' }] as Array<Partial<Layer>>)(
    '保护成员整次拒绝：%j', overrides => {
      const layers = [layer('a'), layer('b', overrides)]
      error(planLayerTiming(layers, ['a', 'b'], video(), 100, request()))
      expect(layers[0].timeOffsetFrames).toBeUndefined()
    }
  )

  it.each([NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('非法偏移数值 %s 不会被归一化为零', number => {
    error(planLayerTiming([layer('a', { timeOffsetFrames: number })], ['a'], video(), 100, request()))
    error(planLayerTiming([layer('a')], ['a'], video(), 100, request({ frames: number })))
  })

  it.each([
    { startFrame: 0, duration: 0 }, { startFrame: 0, duration: -1 }, { startFrame: -1, duration: 5 },
    { startFrame: 0.5, duration: 10 }, { startFrame: 0, duration: 5.5 },
    { startFrame: NaN, duration: 10 }, { startFrame: 0, duration: Infinity },
    { startFrame: Number.MAX_SAFE_INTEGER, duration: 1 }
  ])('拒绝空片段或非法源范围：%j', clip => {
    error(planLayerTiming([layer('a', { clip })], ['a'], video(), 100, request()))
  })

  it('当前源范围加偏移发生安全整数溢出时拒绝', () => {
    const a = layer('a', { timeOffsetFrames: Number.MAX_SAFE_INTEGER - 10 })
    error(planLayerTiming([a], ['a'], video(), 100, request({ mode: 'reset' })))
  })

  it('新偏移及错峰间距计算溢出时不输出部分结果', () => {
    const layers = [layer('a'), layer('b'), layer('c')]
    error(planLayerTiming(layers, ['a', 'b'], video(), 100, request({ frames: Number.MAX_SAFE_INTEGER, extendDuration: true })))
    error(planLayerTiming(layers, ['a', 'b', 'c'], video(), 100, request({ mode: 'stagger', frames: Number.MAX_SAFE_INTEGER, extendDuration: true })))
  })

  it.each([0, -1, NaN, Infinity, 5.5, Number.MAX_SAFE_INTEGER + 1])('拒绝非法总帧数 %s', frames => {
    error(planLayerTiming([layer('a')], ['a'], video(), frames, request()))
  })

  it('没有视频、空选区、重复图层身份或未知模式有明确错误', () => {
    const a = layer('a')
    error(planLayerTiming([a], ['a'], null, 100, request()))
    error(planLayerTiming([a], [], video(), 100, request()))
    error(planLayerTiming([a, a], ['a'], video(), 100, request()))
    error(planLayerTiming([a], ['a'], video(), 100, request({ mode: 'unknown' as TimingRequest['mode'] })))
  })

  it('零平移、已复位、已正确错峰均不产生伪变化', () => {
    const layers = [layer('a'), layer('b', { timeOffsetFrames: 5 })]
    expect(plan(layers, ['a'], { frames: 0 }).changed).toBe(false)
    expect(plan(layers, ['a'], { mode: 'reset' }).changed).toBe(false)
    expect(plan(layers, ['a', 'b'], { mode: 'stagger', frames: 5 }).changed).toBe(false)
  })

  it('只延长不足的动画范围也算变化，即使偏移没变', () => {
    const a = layer('a', { clip: { startFrame: 0, duration: 110 } })
    expect(plan([a], ['a'], { frames: 0, extendDuration: true })).toEqual({ offsets: { a: 0 }, totalFrames: 110, changed: true })
  })

  it('特殊 ID 安全保存为普通键', () => {
    const result = plan([layer('__proto__')], ['__proto__'])
    expect(Object.prototype.hasOwnProperty.call(result.offsets, '__proto__')).toBe(true)
    expect(result.offsets['__proto__']).toBe(5)
    expect(Object.getPrototypeOf(result.offsets)).toBe(Object.prototype)
  })

  it('不修改视频、全体图层、选择顺序及任何音频时间', () => {
    const source = video([sprite('a')])
    source.movie.audios = [{ key: 'music', data: new Uint8Array([1, 2, 3]), startTime: 60, duration: 1000 }]
    const audio = layer('audio', { type: 'audio', audioKey: 'music', audioStartTime: 30 })
    const layers = [layer('a'), audio]
    const selected = ['a', 'a']
    const before = JSON.stringify({ source, layers, selected })
    const result = planLayerTiming(layers, selected, source, 100, request({ frames: 90, extendDuration: true }))
    expect(result).toMatchObject({ offsets: { a: 90 }, totalFrames: 110, changed: true })
    expect(JSON.stringify({ source, layers, selected })).toBe(before)
    expect(source.movie.audios![0].startTime).toBe(60)
    expect(audio.audioStartTime).toBe(30)
  })
})
