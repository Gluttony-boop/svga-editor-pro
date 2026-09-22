import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureExportInputs } from '@/core/export-preview'
import { normalizeCanvasTransform } from '@/core/layer-transform'
import type { SlotConfig, VideoItem } from '@/types'
import { useEditorStore } from './editorStore'

const state = () => useEditorStore.getState()
const sourceBytes = () => new Uint8Array([0x53, 0x56, 0x47, 0x41, 1, 2, 3, 4]).buffer
const createVideo = (): VideoItem => ({
  movie: {
    version: '2.0', params: { viewBoxWidth: 400, viewBoxHeight: 300, fps: 24, frames: 24 },
    images: { 'avatar$': new Uint8Array([1, 2, 3, 4]) },
    sprites: ['avatar$', 'title$'].map((imageKey, index) => ({
      imageKey, matteKey: null,
      frames: Array.from({ length: 24 }, (_, frame) => ({
        alpha: 1, layout: { x: 0, y: 0, width: 80, height: 60 },
        transform: { a: 1, b: 0, c: 0, d: 1, tx: frame + index, ty: 20 }, clipPath: null,
        shapes: [{ type: 'RECT' as const, rect: { x: 0, y: 0, width: 2, height: 3 }, styles: { fill: { r: 1, g: 0, b: 0, a: 1 } } }]
      }))
    })),
    audios: [{ key: 'voice', data: new Uint8Array([10, 11]), startTime: 0, duration: 1000 }]
  },
  images: { 'avatar$': { width: 80, height: 60, src: 'blob:source-avatar' } as HTMLImageElement },
  buffers: { 'avatar$': new Uint8Array([1, 2, 3, 4]).buffer }
})

const textConfig = (text = '设计师昵称'): SlotConfig => ({
  name: 'title$', type: 'text', value: text,
  textConfig: { text, fontFamily: 'Arial', fontSize: 28, color: '#123456', fontWeight: 'bold',
    textAlign: 'center', offsetX: 2, offsetY: 3, lineHeight: 1.4, enabled: true, replaceImage: true }
})

const editDocument = () => {
  state().setCanvasSize(640, 480)
  state().setCustomFps(30)
  state().setCustomFrames(40)
  state().setAnimationValue('0', 'position', { x: 24, y: -9 }, 6)
  state().addLayerKeyframe('0', 'scale', {
    frameIndex: 3, value: { scaleX: 1.5, scaleY: 0.8 }, easing: 'bezier',
    bezierControlPoints: { x1: 0.2, y1: 0.3, x2: 0.7, y2: 0.9 }
  })
  state().updateLayer('0', {
    name: '主头像', opacity: 0.8, expanded: false, clip: { startFrame: 2, duration: 18 }, timeOffsetFrames: 6,
    canvasTransform: { x: 11, y: 12, scaleX: 1.2, scaleY: 0.9, rotation: 0.5 },
    imageSource: { type: 'file', value: 'blob:replacement', file: { name: 'avatar.png' } as File }
  })
  state().setSlotConfig('title$', textConfig())
  state().setSlotConfig('avatar$', {
    name: 'avatar$', type: 'image', value: 'blob:replacement',
    imageConfig: { url: 'blob:replacement', scaleMode: 'fill' },
    textConfig: { ...textConfig().textConfig!, text: '头像注释', replaceImage: false }
  })
  state().addImageResource({
    key: 'avatar$', data: new Uint8Array([7, 8, 9]), width: 200, height: 100, mimeType: 'image/png',
    blobUrl: 'blob:replacement', bitmap: {} as ImageBitmap,
    source: { type: 'file', value: 'blob:replacement', file: { name: 'avatar.png' } as File }
  })
  state().addAudioResource({
    key: 'voice', data: new Uint8Array([12, 13, 14]), startTime: 20, duration: 500,
    blobUrl: 'blob:voice', audioBuffer: {} as AudioBuffer,
    source: { type: 'file', value: 'blob:voice', file: { name: 'voice.mp3' } as File }
  })
  state().setDetectedSlots(['avatar$', 'title$'])
  state().setCompressionConfig({ enabled: true, quality: 68 })
  state().setOptimizationConfig({ frames: { ...state().optimizationConfig.frames, precision: 4 } })
  state().selectLayers(['1', '0'])
  state().setCurrentFrame(17)
}

beforeEach(() => {
  state().reset()
  state().setVideoItem(createVideo())
  state().setOriginalBuffer(sourceBytes())
  state().setSource('D:\\设计项目\\入场动画.svga', 'file')
  state().initializeHistory()
})

afterEach(() => {
  state().reset()
  vi.restoreAllMocks()
})

describe('工程捕获', () => {
  it('保留原始帧省略的layout和transform，不将缺省字段改成空对象或null', () => {
    const video = createVideo()
    const frame = video.movie.sprites[0].frames[0]
    delete (frame as Partial<typeof frame>).layout
    delete (frame as Partial<typeof frame>).transform
    state().setVideoItem(video)
    state().setOriginalBuffer(sourceBytes())
    const document = state().captureProjectDocument()
    expect(document.layers[0].sprites!.frames[0].layout).toBeUndefined()
    expect(document.layers[0].sprites!.frames[0].transform).toBeUndefined()
    state().restoreProjectDocument(document, null, 'edit.svgaproj')
    expect(state().layers[0].sprites!.frames[0].transform).toBeUndefined()
  })
  it('捕获编辑态、文字和图片替换，不烘焙或改写原始输入', () => {
    const sourceBuffer = state().originalBuffer
    const originalMovie = state().videoItem!.movie
    editDocument()
    const current = state()
    const document = state().captureProjectDocument()
    expect(document.formatVersion).toBe(1)
    expect(document.name).toBe('入场动画.svga')
    expect(document.params).toEqual({ viewBoxWidth: 640, viewBoxHeight: 480, fps: 24, frames: 24 })
    expect(document.customFps).toBe(30)
    expect(document.customFrames).toBe(40)
    expect(document.layers).toEqual(current.layers.map(layer => ({
      ...layer, imageSource: layer.imageSource ? { ...layer.imageSource, file: undefined } : undefined
    })))
    expect(document.layers[0].animationTracks!.position.keyframes.at(-1)!.value).toEqual({ x: 24, y: -9 })
    expect(document.layers[0].timeOffsetFrames).toBe(6)
    expect(document.layers[0].tracks.scale.keyframes[0].bezierControlPoints).toEqual({ x1: 0.2, y1: 0.3, x2: 0.7, y2: 0.9 })
    expect(document.imageResources.get('avatar$')!.data).toEqual(new Uint8Array([7, 8, 9]))
    expect(document.audioResources.get('voice')!.data).toEqual(new Uint8Array([12, 13, 14]))
    expect(document.slotConfigs).toEqual(current.slotConfigs)
    expect(document.detectedSlots).toEqual(['avatar$', 'title$'])
    expect(document.currentFrame).toBe(17)
    expect(document.selectedLayerId).toBe('0')
    expect(document.selectedLayerIds).toEqual(['1', '0'])
    expect(document.compressionConfig.quality).toBe(68)
    expect(document.optimizationConfig.frames.precision).toBe(4)
    expect(document.selectedPresetId).toBe('custom')
    expect(document.originalBuffer).toEqual(sourceBuffer)
    expect(state().originalBuffer).toBe(sourceBuffer)
    expect(originalMovie.params).toEqual({ viewBoxWidth: 400, viewBoxHeight: 300, fps: 24, frames: 24 })
    expect(document.videoItem.movie.images['avatar$']).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(state().isDirty).toBe(true)
    expect(state().history).toBe(current.history)
  })

  it('深拷贝元数据、资源字节和原始帧，仅共享已解码图片实例', () => {
    editDocument()
    const current = state()
    const document = state().captureProjectDocument()
    expect(document.videoItem).not.toBe(current.videoItem)
    expect(document.videoItem.movie).not.toBe(current.videoItem!.movie)
    expect(document.videoItem.images).not.toBe(current.videoItem!.images)
    expect(document.videoItem.images['avatar$']).toBe(current.videoItem!.images['avatar$'])
    document.params.viewBoxWidth = 1
    document.videoItem.movie.params.viewBoxWidth = 2
    ;(document.videoItem.movie.images['avatar$'] as Uint8Array)[0] = 99
    document.videoItem.movie.audios![0].data[0] = 99
    document.videoItem.movie.sprites[0].frames[0].transform.tx = 99
    document.videoItem.movie.sprites[0].frames[0].shapes![0].styles!.fill!.r = 0
    new Uint8Array(document.videoItem.buffers['avatar$'])[0] = 99
    new Uint8Array(document.originalBuffer)[0] = 99
    document.layers[0].clip.startFrame = 99
    document.layers[0].canvasTransform!.x = 99
    document.layers[0].animationTracks!.position.keyframes.at(-1)!.value.x = 99
    document.layers[0].tracks.scale.keyframes[0].value.scaleX = 99
    document.layers[0].tracks.scale.keyframes[0].bezierControlPoints!.x1 = 99
    document.layers[0].sprites!.frames[0].layout!.width = 99
    document.layers[0].sprites!.frames[0].shapes![0].styles!.fill!.g = 99
    document.imageResources.get('avatar$')!.data[0] = 99
    document.audioResources.get('voice')!.data[0] = 99
    document.slotConfigs['title$'].textConfig!.text = '已改变'
    document.slotConfigs['avatar$'].imageConfig!.scaleMode = 'stretch'
    document.detectedSlots.push('other$')
    document.compressionConfig.quality = 99
    document.optimizationConfig.image.quality = 99
    document.selectedLayerIds.splice(0)
    expect(current.params!.viewBoxWidth).toBe(640)
    expect(current.videoItem!.movie.params.viewBoxWidth).toBe(640)
    expect(current.videoItem!.movie.images['avatar$'][0]).toBe(1)
    expect(current.videoItem!.movie.audios![0].data[0]).toBe(10)
    expect(current.videoItem!.movie.sprites[0].frames[0].transform.tx).toBe(0)
    expect(current.videoItem!.movie.sprites[0].frames[0].shapes![0].styles!.fill!.r).toBe(1)
    expect(new Uint8Array(current.videoItem!.buffers['avatar$'])[0]).toBe(1)
    expect(new Uint8Array(current.originalBuffer!)[0]).toBe(0x53)
    expect(current.layers[0].clip.startFrame).toBe(2)
    expect(current.layers[0].canvasTransform!.x).toBe(11)
    expect(current.layers[0].animationTracks!.position.keyframes.at(-1)!.value.x).toBe(24)
    expect(current.layers[0].tracks.scale.keyframes[0].value.scaleX).toBe(1.5)
    expect(current.layers[0].tracks.scale.keyframes[0].bezierControlPoints!.x1).toBe(0.2)
    expect(current.layers[0].sprites!.frames[0].layout!.width).toBe(80)
    expect(current.layers[0].sprites!.frames[0].shapes![0].styles!.fill!.g).toBe(0)
    expect(current.imageResources.get('avatar$')!.data[0]).toBe(7)
    expect(current.audioResources.get('voice')!.data[0]).toBe(12)
    expect(current.slotConfigs['title$'].textConfig!.text).toBe('设计师昵称')
    expect(current.slotConfigs['avatar$'].imageConfig!.scaleMode).toBe('fill')
    expect(current.detectedSlots).toEqual(['avatar$', 'title$'])
    expect(current.compressionConfig.quality).toBe(68)
    expect(current.optimizationConfig.image.quality).not.toBe(99)
    expect(current.selectedLayerIds).toEqual(['1', '0'])
  })

  it('工程快照不包含历史、运行时句柄、文件对象或工作区偏好', () => {
    editDocument()
    const document = state().captureProjectDocument()
    for (const key of ['history', 'isDirty', 'projectFilePath', 'sourceType', 'zoom', 'showGrid', 'rendererMode']) {
      expect(document).not.toHaveProperty(key)
    }
    expect(document.layers[0].imageSource!.file).toBeUndefined()
    expect(document.imageResources.get('avatar$')!.source!.file).toBeUndefined()
    expect(document.imageResources.get('avatar$')!.bitmap).toBeUndefined()
    expect(document.audioResources.get('voice')!.source!.file).toBeUndefined()
    expect(document.audioResources.get('voice')!.audioBuffer).toBeUndefined()
  })

  it.each(['videoItem', 'params', 'originalBuffer'] as const)('缺少 %s 时明确失败，不清除未保存状态', field => {
    state().updateLayer('0', { opacity: 0.6 })
    useEditorStore.setState({ [field]: null })
    expect(() => state().captureProjectDocument()).toThrow('工程数据不完整')
    expect(state().isDirty).toBe(true)
    expect(state().projectName).toBeNull()
    expect(state().projectFilePath).toBeNull()
  })

  it.each([
    ['https://example.test/path/%E5%90%8D%E7%A7%B0.svga?token=private#secret', '名称.svga'],
    ['https://example.test/path/%2E%2E%2Fsecret.svga', '.._secret.svga'],
    ['blob:https://example.test/temporary-id', '未命名动画'],
    ['data:application/octet-stream;base64,private', '未命名动画'],
    ['D:\\客户资料\\作品.svga', '作品.svga'],
    [null, '未命名动画']
  ])('来源 %s 仅保留安全的名称 %s', (source, expected) => {
    state().setSource(source, source ? 'url' : null)
    expect(state().captureProjectDocument().name).toBe(expected)
  })

  it.each(['canvas', 'text'] as const)('先收束 %s 事务，连续预览只保留一次历史', kind => {
    if (kind === 'canvas') {
      state().beginCanvasTransform('0')
      for (let x = 1; x <= 10; x++) state().previewCanvasTransform('0', normalizeCanvasTransform({ x }))
    } else {
      state().beginSlotConfigEdit('title$')
      for (let value = 1; value <= 10; value++) state().previewSlotConfig('title$', textConfig(`名称${value}`))
    }
    expect(state().history.past).toHaveLength(0)
    const document = state().captureProjectDocument()
    expect(state().isCanvasTransforming).toBe(false)
    expect(state().isSlotConfigEditing).toBe(false)
    expect(state().history.past).toHaveLength(1)
    if (kind === 'canvas') expect(document.layers[0].canvasTransform!.x).toBe(10)
    else expect(document.slotConfigs['title$'].value).toBe('名称10')
    state().captureProjectDocument()
    state().endCanvasTransform(false)
    state().endSlotConfigEdit(false)
    expect(state().history.past).toHaveLength(1)
    expect(state().isDirty).toBe(true)
  })

  it('暂停后捕获播放器同步的真实帧，捕获动作本身不置脏或增加历史', () => {
    state().setPlaying(true)
    state().setCurrentFrame(2)
    const unsubscribe = useEditorStore.subscribe(s => s.playback.isPlaying, playing => {
      if (!playing) state().setCurrentFrame(9)
    })
    try {
      expect(state().captureProjectDocument().currentFrame).toBe(9)
      expect(state().playback.isPlaying).toBe(false)
      expect(state().isDirty).toBe(false)
      expect(state().history.past).toHaveLength(0)
    } finally {
      unsubscribe()
    }
  })
})

describe('工程恢复', () => {
  it('修改后捕获、清空并重新打开，完整恢复可编辑数据和游标', () => {
    editDocument()
    const document = state().captureProjectDocument()
    state().reset()
    state().restoreProjectDocument(document, 'D:\\作品\\完成.svgaproj', '完成.svgaproj')
    const restored = state()
    expect(restored.captureProjectDocument()).toEqual(document)
    expect(restored.projectName).toBe('完成.svgaproj')
    expect(restored.projectFilePath).toBe('D:\\作品\\完成.svgaproj')
    expect(restored.currentSource).toBe('入场动画.svga')
    expect(restored.sourceType).toBeNull()
    expect(restored.playback).toMatchObject({ isPlaying: false, currentFrame: 17, totalFrames: 40, fps: 30 })
    expect(restored.isDirty).toBe(false)
    expect(restored.canUndo).toBe(false)
    expect(restored.canRedo).toBe(false)
    expect(restored.history.past).toEqual([])
    expect(restored.history.future).toEqual([])
    expect(restored.history.snapshots).toHaveLength(1)
    expect(restored.history.snapshots![0].name).toBe('打开工程')
    state().updateLayer('0', { opacity: 0.3 })
    state().undo()
    expect(state().layers[0].opacity).toBe(0.8)
    expect(state().layers[0].animationTracks).toEqual(document.layers[0].animationTracks)
    state().redo()
    expect(state().layers[0].opacity).toBe(0.3)
  })

  it('仅发布一次完整状态，旧历史、草稿和关键帧选择不混入新文档', () => {
    const document = state().captureProjectDocument()
    state().updateLayer('0', { opacity: 0.2 })
    state().undo()
    state().selectKeyframe('old-keyframe')
    state().beginSlotConfigEdit('title$')
    state().previewSlotConfig('title$', textConfig('旧文档草稿'))
    const observed = vi.fn()
    const unsubscribe = useEditorStore.subscribe(observed)
    try {
      state().restoreProjectDocument(document, null, '网页工程.svgaproj')
      expect(observed).toHaveBeenCalledTimes(1)
      const restored = observed.mock.calls[0][0] as ReturnType<typeof state>
      expect(restored.layers).toEqual(document.layers)
      expect(restored.videoItem!.movie.params).toEqual(document.videoItem.movie.params)
      expect(restored.isSlotConfigEditing).toBe(false)
      expect(restored.isCanvasTransforming).toBe(false)
      expect(restored.selectedKeyframeIds).toEqual([])
      expect(restored.keyframes).toEqual([])
      expect(restored.history.future).toEqual([])
      state().previewSlotConfig('title$', textConfig('过期事件'))
      state().endSlotConfigEdit(false)
      state().endCanvasTransform(false)
      expect(state().slotConfigs).toEqual(document.slotConfigs)
      expect(state().isDirty).toBe(false)
    } finally {
      unsubscribe()
    }
  })

  it('从同一个工程对象多次打开仍建立全新引用，编辑不污染读取结果', () => {
    editDocument()
    const document = state().captureProjectDocument()
    state().restoreProjectDocument(document, null, '工程.svgaproj')
    const first = state()
    const staleInputs = captureExportInputs(first)
    state().restoreProjectDocument(document, null, '工程.svgaproj')
    const second = state()
    expect(second.videoItem).not.toBe(first.videoItem)
    expect(second.videoItem).not.toBe(document.videoItem)
    expect(second.originalBuffer).not.toBe(first.originalBuffer)
    expect(second.originalBuffer).not.toBe(document.originalBuffer)
    expect(second.layers).not.toBe(document.layers)
    expect(second.imageResources).not.toBe(document.imageResources)
    expect(second.slotConfigs).not.toBe(document.slotConfigs)
    second.layers[0].animationTracks!.position.keyframes[0].value.x = 55
    second.imageResources.get('avatar$')!.data[0] = 66
    second.videoItem!.movie.sprites[0].frames[0].transform.tx = 77
    second.slotConfigs['title$'].textConfig!.text = '只改当前文档'
    expect(document.layers[0].animationTracks!.position.keyframes[0].value.x).toBe(0)
    expect(document.imageResources.get('avatar$')!.data[0]).toBe(7)
    expect(document.videoItem.movie.sprites[0].frames[0].transform.tx).toBe(0)
    expect(document.slotConfigs['title$'].textConfig!.text).toBe('设计师昵称')
    expect(state().markProjectSaved(staleInputs, 'D:\\旧.svgaproj', '旧.svgaproj')).toBe(false)
    expect(state().projectName).toBe('工程.svgaproj')
  })

  it('工程只恢复文档设置，保留工作区缩放、背景、渲染器和其他界面偏好', () => {
    const document = state().captureProjectDocument()
    state().setZoom(1.6)
    state().setCanvasOffset({ x: 12, y: 20 })
    state().setPreviewBackgroundColor('#404040')
    state().toggleGrid()
    state().toggleOnionSkin()
    state().setRendererMode('high-performance')
    state().setCanvasKeepRatio(false)
    state().setTransformEditMode('keyframe')
    state().setSpeed(1.5)
    state().restoreProjectDocument(document, null, '工程.svgaproj')
    expect(state()).toMatchObject({
      zoom: 1.6, canvasOffset: { x: 12, y: 20 }, previewBackgroundColor: '#404040', showGrid: false,
      showOnionSkin: true, rendererMode: 'high-performance', canvasKeepRatio: false, transformEditMode: 'keyframe'
    })
    expect(state().playback.speed).toBe(1.5)
    expect(state().isDirty).toBe(false)
  })

  it.each([[100, 6], [-2, 0], [3.8, 3], [Number.NaN, 0]])('当前帧 %s 在有效时间范围内恢复为 %s', (frame, expected) => {
    const document = state().captureProjectDocument()
    document.currentFrame = frame
    document.customFrames = 7
    document.customFps = 12
    state().restoreProjectDocument(document, null, '工程.svgaproj')
    expect(state().playback).toMatchObject({ currentFrame: expected, totalFrames: 7, fps: 12, isPlaying: false })
  })

  it('无覆盖参数时使用源帧率和帧数，选区去重并剔除不存在的图层', () => {
    const document = state().captureProjectDocument()
    document.selectedLayerIds = ['missing', '1', '1']
    document.selectedLayerId = '0'
    state().restoreProjectDocument(document, null, '工程.svgaproj')
    expect(state().playback).toMatchObject({ totalFrames: 24, fps: 24 })
    expect(state().selectedLayerIds).toEqual(['1', '0'])
    expect(state().selectedLayerId).toBe('0')
    document.selectedLayerId = 'missing'
    state().restoreProjectDocument(document, null, '工程.svgaproj')
    expect(state().selectedLayerIds).toEqual(['1'])
    expect(state().selectedLayerId).toBe('1')
    document.selectedLayerIds = ['missing']
    state().restoreProjectDocument(document, null, '工程.svgaproj')
    expect(state().selectedLayerIds).toEqual([])
    expect(state().selectedLayerId).toBeNull()
  })
})

describe('工程保存状态', () => {
  it('当前输入确认保存后清除 dirty，保存路径独立于原始来源且不增加历史', () => {
    editDocument()
    state().captureProjectDocument()
    const current = state()
    expect(state().markProjectSaved(captureExportInputs(current), 'D:\\工程\\成品.svgaproj', '成品.svgaproj')).toBe(true)
    expect(state().isDirty).toBe(false)
    expect(state().projectName).toBe('成品.svgaproj')
    expect(state().projectFilePath).toBe('D:\\工程\\成品.svgaproj')
    expect(state().currentSource).toBe(current.currentSource)
    expect(state().sourceType).toBe('file')
    expect(state().originalBuffer).toBe(current.originalBuffer)
    expect(state().history).toBe(current.history)
    state().updateLayer('0', { opacity: 0.4 })
    expect(state().isDirty).toBe(true)
    expect(state().projectName).toBe('成品.svgaproj')
  })

  it.each([
    ['图层', () => state().updateLayer('0', { opacity: 0.4 })],
    ['画布', () => state().setCanvasSize(500, 300)],
    ['关键帧', () => state().setAnimationValue('0', 'rotation', 30, 5)],
    ['文字', () => state().setSlotConfig('title$', textConfig('保存期间新文字'))],
    ['插槽目录', () => state().setDetectedSlots(['avatar$', 'title$'])],
    ['方案标识', () => useEditorStore.setState({ selectedPresetId: 'custom', isDirty: true })],
    ['图片', () => state().addImageResource({ key: 'extra', data: new Uint8Array([99]), width: 10, height: 10, mimeType: 'image/png' })],
    ['音频', () => state().addAudioResource({ key: 'extra', data: new Uint8Array([99]), startTime: 0, duration: 10 })],
    ['帧率', () => state().setCustomFps(60)],
    ['帧数', () => state().setCustomFrames(60)],
    ['压缩配置', () => state().setCompressionConfig({ quality: 20 })],
    ['优化配置', () => state().setOptimizationConfig({ enabled: false })]
  ] as const)('保存期间修改%s，旧保存结果不得清除新修改或替换工程路径', (_, edit) => {
    state().updateLayer('0', { name: '保存内容' })
    state().captureProjectDocument()
    const expectedInputs = captureExportInputs(state())
    edit()
    const current = state()
    expect(state().markProjectSaved(expectedInputs, 'D:\\旧.svgaproj', '旧.svgaproj')).toBe(false)
    expect(state()).toBe(current)
    expect(state().isDirty).toBe(true)
    expect(state().projectName).toBeNull()
    expect(state().projectFilePath).toBeNull()
  })

  it('保存期间改变选区、时间游标和工作区不使内容保存失效', () => {
    state().updateLayer('0', { opacity: 0.4 })
    state().captureProjectDocument()
    const expectedInputs = captureExportInputs(state())
    state().selectLayer('1')
    state().setCurrentFrame(12)
    state().setZoom(2)
    state().toggleGrid()
    expect(state().markProjectSaved(expectedInputs, null, '网页.svgaproj')).toBe(true)
    expect(state().isDirty).toBe(false)
    expect(state().selectedLayerId).toBe('1')
    expect(state().playback.currentFrame).toBe(12)
    expect(state().projectFilePath).toBeNull()
  })

  it.each(['canvas', 'text'] as const)('保存期间开启%s草稿，保守保留未保存状态且不干扰输入', kind => {
    state().updateLayer('0', { opacity: 0.4 })
    const expectedInputs = captureExportInputs(state())
    if (kind === 'canvas') state().beginCanvasTransform('0')
    else state().beginSlotConfigEdit('title$')
    expect(state().markProjectSaved(expectedInputs, null, '工程.svgaproj')).toBe(false)
    expect(state().isDirty).toBe(true)
    expect(kind === 'canvas' ? state().isCanvasTransforming : state().isSlotConfigEditing).toBe(true)
    state().endCanvasTransform(false)
    state().endSlotConfigEdit(false)
    expect(state().isDirty).toBe(true)
  })

  it('保存取消或写入失败，没有确认保存就不能清除 dirty 或记住目标路径', () => {
    state().updateLayer('0', { opacity: 0.4 })
    state().captureProjectDocument()
    expect(state().isDirty).toBe(true)
    expect(state().projectName).toBeNull()
    expect(state().projectFilePath).toBeNull()
  })

  it.each(['reset', 'new-video'] as const)('%s 清空工程身份，旧文件保存不得命中新文件', action => {
    state().markProjectSaved(captureExportInputs(state()), 'D:\\旧.svgaproj', '旧.svgaproj')
    const expectedInputs = captureExportInputs(state())
    if (action === 'reset') state().reset()
    else state().setVideoItem(createVideo())
    expect(state().projectName).toBeNull()
    expect(state().projectFilePath).toBeNull()
    expect(state().isDirty).toBe(false)
    expect(state().markProjectSaved(expectedInputs, 'D:\\旧.svgaproj', '旧.svgaproj')).toBe(false)
  })

  it('重复设置同一视频不会丢失当前工程身份或清除未保存修改', () => {
    state().markProjectSaved(captureExportInputs(state()), 'D:\\已保存.svgaproj', '已保存.svgaproj')
    state().updateLayer('0', { opacity: 0.4 })
    const current = state()
    state().setVideoItem(current.videoItem)
    expect(state()).toBe(current)
    expect(state().isDirty).toBe(true)
  })

  it('通用参数修改也属于未保存工程，同值参数不会置脏或产生历史', () => {
    const params = state().params!
    state().setParams({ ...params })
    expect(state().isDirty).toBe(false)
    expect(state().history.past).toHaveLength(0)
    state().setParams({ ...params, fps: 30 })
    expect(state().isDirty).toBe(true)
    expect(state().history.past).toHaveLength(1)
    state().undo()
    expect(state().params!.fps).toBe(24)
  })
})
