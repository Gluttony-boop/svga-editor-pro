import type { ProjectDocument } from '@/types/project'
import { PROJECT_FORMAT } from '@/types/project'
import { getCanvasSizeError } from './canvas-size'

export const MAX_PROJECT_BYTES = 128 * 1024 * 1024
export const MAX_PROJECT_UNPACKED_BYTES = 256 * 1024 * 1024
export const MAX_PROJECT_MANIFEST_BYTES = 32 * 1024 * 1024
export const MAX_PROJECT_ENTRIES = 5000
export const MAX_PROJECT_FRAMES = 1_000_000

export interface ProjectAssetRef { asset: string }
export interface ProjectAsset { path: string; size: number; sha256: string }
export type JsonRecord = Record<string, unknown>
export interface ProjectManifest {
  format: typeof PROJECT_FORMAT
  formatVersion: 1
  assets: ProjectAsset[]
  document: Omit<ProjectDocument, 'originalBuffer' | 'videoItem' | 'layers' | 'imageResources' | 'audioResources' | 'slotConfigs'> & {
    originalBuffer: ProjectAssetRef
    videoItem: { movie: JsonRecord; buffers: Array<{ key: string; data: ProjectAssetRef }> }
    layers: JsonRecord[]
    imageResources: JsonRecord[]
    audioResources: JsonRecord[]
    slotConfigs: Array<{ key: string; config: JsonRecord }>
  }
}

export function projectError(message: string): never { throw new Error(`工程文件无效：${message}`) }

export function record(value: unknown, path: string, required: string[], optional: string[] = []): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return projectError(`${path} 必须为对象`)
  const result = value as JsonRecord
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(result, key)) projectError(`${path} 缺少 ${key}`)
  for (const key of Object.keys(result)) {
    if (!required.includes(key) && !optional.includes(key)) projectError(`${path} 包含不受支持的字段 ${key}，请使用兼容版本打开`)
  }
  return result
}

export function text(value: unknown, path: string, max = 4096, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.length)) projectError(`${path} 文本无效`)
}

function number(value: unknown, path: string, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, integer = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) projectError(`${path} 数值无效`)
}

function bool(value: unknown, path: string): void { if (typeof value !== 'boolean') projectError(`${path} 必须为布尔值`) }
function enumeration(value: unknown, path: string, allowed: readonly unknown[]): void { if (!allowed.includes(value)) projectError(`${path} 值不受支持`) }
function array(value: unknown, path: string, max = MAX_PROJECT_ENTRIES): unknown[] {
  if (!Array.isArray(value) || value.length > max) return projectError(`${path} 数组无效或超过数量上限`)
  return value
}
function optional(value: JsonRecord, key: string, fn: (value: unknown, path: string) => void, path: string): void {
  if (Object.prototype.hasOwnProperty.call(value, key)) fn(value[key], `${path}.${key}`)
}
function unique(value: string, seen: Set<string>, path: string): void {
  if (seen.has(value)) projectError(`${path} 重复：${value}`)
  seen.add(value)
}

export function isProjectAssetPath(path: string): boolean { return /^assets\/[0-9]{5}\.bin$/.test(path) }

function assetRef(value: unknown, path: string, assets: Set<string>, used: Set<string>): void {
  const ref = record(value, path, ['asset'])
  text(ref.asset, `${path}.asset`, 32, true)
  if (!assets.has(ref.asset)) projectError(`${path} 引用了未声明的资源`)
  used.add(ref.asset)
}

function numbers(value: unknown, path: string, keys: string[], required = false): void {
  const item = record(value, path, required ? keys : [], required ? [] : keys)
  // 原生解析器的 Option 数值会序列化为 null；仅原始稀疏字段允许，编辑值仍须完整有限。
  for (const key of keys) if (required || item[key] != null) optional(item, key, number, path)
}

function params(value: unknown, path: string): void {
  const item = record(value, path, ['viewBoxWidth', 'viewBoxHeight', 'fps', 'frames'])
  number(item.viewBoxWidth, `${path}.viewBoxWidth`, 0.000001, 100000)
  number(item.viewBoxHeight, `${path}.viewBoxHeight`, 0.000001, 100000)
  number(item.fps, `${path}.fps`, 0.000001, 1000)
  number(item.frames, `${path}.frames`, 1, MAX_PROJECT_FRAMES, true)
}

function shape(value: unknown, path: string): void {
  const item = record(value, path, [], ['type', 'shape', 'shapeD', 'rect', 'ellipse', 'styles', 'transform'])
  optional(item, 'type', (v, p) => enumeration(v, p, [0, 1, 2, 3, 'SHAPE', 'RECT', 'ELLIPSE', 'KEEP']), path)
  if (item.shapeD != null) text(item.shapeD, `${path}.shapeD`, MAX_PROJECT_MANIFEST_BYTES)
  if (item.shape != null) {
    const args = record(item.shape, `${path}.shape`, [], ['d'])
    optional(args, 'd', (v, p) => text(v, p, MAX_PROJECT_MANIFEST_BYTES), `${path}.shape`)
  }
  if (item.rect != null) numbers(item.rect, `${path}.rect`, ['x', 'y', 'width', 'height', 'cornerRadius'])
  if (item.ellipse != null) numbers(item.ellipse, `${path}.ellipse`, ['x', 'y', 'radiusX', 'radiusY'])
  if (item.transform != null) numbers(item.transform, `${path}.transform`, ['a', 'b', 'c', 'd', 'tx', 'ty'])
  if (item.styles != null) {
    const style = record(item.styles, `${path}.styles`, [], ['fill', 'stroke', 'strokeWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashI', 'lineDashII', 'lineDashIII'])
    for (const key of ['fill', 'stroke']) if (style[key] != null) numbers(style[key], `${path}.styles.${key}`, ['r', 'g', 'b', 'a'])
    for (const key of ['strokeWidth', 'miterLimit', 'lineDashI', 'lineDashII', 'lineDashIII']) optional(style, key, number, path)
    optional(style, 'lineCap', (v, p) => enumeration(v, p, [0, 1, 2, 'LineCap_BUTT', 'LineCap_ROUND', 'LineCap_SQUARE']), path)
    optional(style, 'lineJoin', (v, p) => enumeration(v, p, [0, 1, 2, 'LineJoin_MITER', 'LineJoin_ROUND', 'LineJoin_BEVEL']), path)
  }
}

/** 保留 protobuf 的省略字段和空帧，不把缺省矩阵强制补零。 */
function sprite(value: unknown, path: string): void {
  const item = record(value, path, ['frames'], ['imageKey', 'matteKey'])
  optional(item, 'imageKey', text, path)
  if (item.matteKey != null) text(item.matteKey, `${path}.matteKey`)
  array(item.frames, `${path}.frames`, MAX_PROJECT_FRAMES).forEach((value, index) => {
    if (value === null) return
    const at = `${path}.frames[${index}]`
    const frame = record(value, at, [], ['alpha', 'layout', 'transform', 'clipPath', 'shapes', 'blendMode'])
    optional(frame, 'alpha', number, at)
    if (frame.layout != null) numbers(frame.layout, `${at}.layout`, ['x', 'y', 'width', 'height'])
    if (frame.transform != null) numbers(frame.transform, `${at}.transform`, ['a', 'b', 'c', 'd', 'tx', 'ty'])
    if (frame.clipPath != null) text(frame.clipPath, `${at}.clipPath`, MAX_PROJECT_MANIFEST_BYTES)
    optional(frame, 'blendMode', text, at)
    if (frame.shapes != null) array(frame.shapes, `${at}.shapes`).forEach((value, index) => shape(value, `${at}.shapes[${index}]`))
  })
}

function trackValue(value: unknown, path: string, name: string): void {
  if (name === 'position') numbers(value, path, ['x', 'y'], true)
  else if (name === 'scale') numbers(value, path, ['scaleX', 'scaleY'], true)
  else number(value, path)
}

function tracks(value: unknown, path: string, ids: Set<string>, edited: boolean): void {
  const item = record(value, path, ['position', 'scale', 'rotation', 'alpha'])
  for (const name of ['position', 'scale', 'rotation', 'alpha']) {
    const at = `${path}.${name}`
    const track = record(item[name], at, ['keyframes', 'currentValue', 'defaultValue'])
    trackValue(track.currentValue, `${at}.currentValue`, name)
    trackValue(track.defaultValue, `${at}.defaultValue`, name)
    const occupied = new Set<number>()
    array(track.keyframes, `${at}.keyframes`, MAX_PROJECT_FRAMES).forEach((value, index) => {
      const keyPath = `${at}.keyframes[${index}]`
      const key = record(value, keyPath, ['id', 'frameIndex', 'value', 'easing'], ['bezierControlPoints'])
      text(key.id, `${keyPath}.id`, 256, true)
      unique(key.id, ids, `${keyPath}.id`)
      number(key.frameIndex, `${keyPath}.frameIndex`, 0, MAX_PROJECT_FRAMES, true)
      if (edited && occupied.has(key.frameIndex)) projectError(`${keyPath} 同一属性不能有重复编辑关键帧`)
      occupied.add(key.frameIndex)
      trackValue(key.value, `${keyPath}.value`, name)
      enumeration(key.easing, `${keyPath}.easing`, ['linear', 'easeIn', 'easeOut', 'easeInOut', 'bezier', 'hold'])
      if (key.bezierControlPoints !== undefined) {
        numbers(key.bezierControlPoints, `${keyPath}.bezierControlPoints`, ['x1', 'y1', 'x2', 'y2'], true)
        const points = key.bezierControlPoints as JsonRecord
        number(points.x1, `${keyPath}.x1`, 0, 1)
        number(points.x2, `${keyPath}.x2`, 0, 1)
      }
    })
  }
}

function layer(value: unknown, path: string, layerIds: Set<string>, keyframeIds: Set<string>): void {
  const item = record(value, path, ['id', 'name', 'type', 'visible', 'locked', 'expanded', 'opacity', 'blendMode', 'clip', 'tracks'],
    ['timeOffsetFrames', 'imageKey', 'audioKey', 'audioStartTime', 'audioDuration', 'editableIndex', 'animationTracks', 'canvasTransform', 'sprites', 'isNew'])
  text(item.id, `${path}.id`, 256, true)
  unique(item.id, layerIds, `${path}.id`)
  text(item.name, `${path}.name`)
  enumeration(item.type, `${path}.type`, ['image', 'audio', 'shape', 'text'])
  for (const key of ['visible', 'locked', 'expanded']) bool(item[key], `${path}.${key}`)
  number(item.opacity, `${path}.opacity`, 0, 1)
  enumeration(item.blendMode, `${path}.blendMode`, ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'])
  const clip = record(item.clip, `${path}.clip`, ['startFrame', 'duration'])
  number(clip.startFrame, `${path}.clip.startFrame`, 0, MAX_PROJECT_FRAMES, true)
  number(clip.duration, `${path}.clip.duration`, 0, MAX_PROJECT_FRAMES, true)
  optional(item, 'timeOffsetFrames', (v, p) => number(v, p, -MAX_PROJECT_FRAMES, MAX_PROJECT_FRAMES, true), path)
  for (const key of ['imageKey', 'audioKey']) optional(item, key, text, path)
  for (const key of ['audioStartTime', 'audioDuration']) optional(item, key, (v, p) => number(v, p, 0), path)
  optional(item, 'editableIndex', (v, p) => number(v, p, 0, MAX_PROJECT_ENTRIES, true), path)
  optional(item, 'isNew', bool, path)
  tracks(item.tracks, `${path}.tracks`, keyframeIds, false)
  if (item.animationTracks !== undefined) tracks(item.animationTracks, `${path}.animationTracks`, keyframeIds, true)
  if (item.canvasTransform !== undefined) numbers(item.canvasTransform, `${path}.canvasTransform`, ['x', 'y', 'scaleX', 'scaleY', 'rotation'], true)
  if (item.sprites !== undefined) sprite(item.sprites, `${path}.sprites`)
}

function textConfig(value: unknown, path: string): void {
  const item = record(value, path, ['text', 'fontSize', 'color', 'fontFamily'], ['fontWeight', 'textAlign', 'offsetX', 'offsetY', 'lineHeight', 'enabled', 'replaceImage', 'boxWidth', 'boxHeight', 'referenceWidth', 'referenceHeight', 'exportMode'])
  text(item.text, `${path}.text`, 10000)
  number(item.fontSize, `${path}.fontSize`, 1, 512)
  for (const key of ['color', 'fontFamily']) {
    text(item[key], `${path}.${key}`, 128, true)
    if (/[;{}\r\n]/.test(item[key] as string)) projectError(`${path}.${key} 包含非法样式字符`)
  }
  optional(item, 'fontWeight', (v, p) => enumeration(v, p, ['normal', 'bold']), path)
  optional(item, 'textAlign', (v, p) => enumeration(v, p, ['left', 'center', 'right']), path)
  for (const key of ['offsetX', 'offsetY']) optional(item, key, (v, p) => number(v, p, -8192, 8192), path)
  optional(item, 'lineHeight', (v, p) => number(v, p, 0.5, 4), path)
  optional(item, 'enabled', bool, path)
  optional(item, 'replaceImage', bool, path)
  optional(item, 'exportMode', (v, p) => enumeration(v, p, ['preview', 'bake']), path)
  const dimensions = ['boxWidth', 'boxHeight', 'referenceWidth', 'referenceHeight']
  const dimensionCount = dimensions.filter(key => Object.prototype.hasOwnProperty.call(item, key)).length
  if (dimensionCount !== 0 && dimensionCount !== dimensions.length) projectError(`${path} 文字框与参考尺寸必须同时保存`)
  if (item.exportMode === 'bake' && dimensionCount === 0) projectError(`${path} 写入 SVGA 的文字必须包含完整文字框与参考尺寸`)
  if (dimensionCount === dimensions.length) {
    for (const key of dimensions) number(item[key], `${path}.${key}`, 1, 8192, true)
    const [boxWidth, boxHeight, referenceWidth, referenceHeight] = dimensions.map(key => item[key] as number)
    // 文字框变窄但变高时，底图与文字共同占用的合成区域可能比二者各自都大。
    if (boxWidth * boxHeight > 4_194_304 || referenceWidth * referenceHeight > 4_194_304 ||
      Math.max(boxWidth, referenceWidth) * Math.max(boxHeight, referenceHeight) > 4_194_304) {
      projectError(`${path} 文字框、参考尺寸或合成区域超过 4,194,304 像素上限`)
    }
  }
}

function exportConfigs(document: JsonRecord): void {
  const config = record(document.compressionConfig, 'compressionConfig', ['enabled', 'mode', 'quality', 'resizeEnabled', 'resizePercent'])
  bool(config.enabled, 'compressionConfig.enabled')
  bool(config.resizeEnabled, 'compressionConfig.resizeEnabled')
  enumeration(config.mode, 'compressionConfig.mode', ['smart', 'webp', 'png'])
  number(config.quality, 'compressionConfig.quality', 0, 100)
  number(config.resizePercent, 'compressionConfig.resizePercent', 1, 100)
  const optimization = record(document.optimizationConfig, 'optimizationConfig', ['enabled', 'image', 'frames', 'compression'])
  bool(optimization.enabled, 'optimizationConfig.enabled')
  const image = record(optimization.image, 'optimizationConfig.image', ['format', 'quality', 'resizeEnabled', 'resizePercent', 'maxWidth', 'maxHeight', 'deduplicate'], ['pngColors', 'sizeLimitEnabled', 'autoResizeToCanvas'])
  enumeration(image.format, 'optimizationConfig.image.format', ['webp', 'png', 'auto'])
  number(image.quality, 'optimizationConfig.image.quality', 0, 100)
  optional(image, 'pngColors', (v, p) => enumeration(v, p, [0, 64, 128, 256]), 'optimizationConfig.image')
  bool(image.resizeEnabled, 'optimizationConfig.image.resizeEnabled')
  bool(image.deduplicate, 'optimizationConfig.image.deduplicate')
  optional(image, 'sizeLimitEnabled', bool, 'optimizationConfig.image')
  optional(image, 'autoResizeToCanvas', bool, 'optimizationConfig.image')
  number(image.resizePercent, 'optimizationConfig.image.resizePercent', 1, 100)
  for (const key of ['maxWidth', 'maxHeight']) number(image[key], `optimizationConfig.image.${key}`, 0, 100000)
  const frames = record(optimization.frames, 'optimizationConfig.frames', ['simplify', 'keyframeThreshold', 'removeInvisible', 'precision'])
  bool(frames.simplify, 'optimizationConfig.frames.simplify')
  bool(frames.removeInvisible, 'optimizationConfig.frames.removeInvisible')
  number(frames.keyframeThreshold, 'optimizationConfig.frames.keyframeThreshold', 0, 1)
  number(frames.precision, 'optimizationConfig.frames.precision', 0, 10, true)
  const compression = record(optimization.compression, 'optimizationConfig.compression', ['level', 'useBestCompression'])
  number(compression.level, 'optimizationConfig.compression.level', 0, 9, true)
  bool(compression.useBestCompression, 'optimizationConfig.compression.useBestCompression')
}

/** 所有字典都采用 entries 数组，合法资源 Key 不承担对象路径或文件路径职责。 */
export function validateProjectManifest(value: unknown): asserts value is ProjectManifest {
  const manifest = record(value, 'manifest', ['format', 'formatVersion', 'assets', 'document'])
  if (manifest.format !== PROJECT_FORMAT) projectError('不是 SVGA Editor 工程')
  if (manifest.formatVersion !== 1) projectError('工程版本不受支持，请升级编辑器')
  const assets = new Set<string>()
  const usedAssets = new Set<string>()
  let totalSize = 0
  array(manifest.assets, 'assets', MAX_PROJECT_ENTRIES - 1).forEach((value, index) => {
    const at = `assets[${index}]`
    const item = record(value, at, ['path', 'size', 'sha256'])
    text(item.path, `${at}.path`, 32, true)
    if (!isProjectAssetPath(item.path)) projectError(`${at} 资源路径不安全`)
    unique(item.path, assets, `${at}.path`)
    number(item.size, `${at}.size`, 0, MAX_PROJECT_BYTES, true)
    totalSize += item.size
    text(item.sha256, `${at}.sha256`, 64, true)
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) projectError(`${at} SHA-256 无效`)
  })
  if (totalSize > MAX_PROJECT_UNPACKED_BYTES) projectError('资源总大小超过解压上限')
  const doc = record(manifest.document, 'document', ['formatVersion', 'name', 'originalBuffer', 'videoItem', 'params', 'customFps', 'customFrames', 'layers', 'imageResources', 'audioResources', 'slotConfigs', 'detectedSlots', 'compressionConfig', 'optimizationConfig', 'selectedPresetId', 'currentFrame', 'selectedLayerId', 'selectedLayerIds'])
  if (doc.formatVersion !== 1) projectError('编辑文档版本不受支持')
  text(doc.name, 'name', 255, true)
  if (/[/\\\x00-\x1f]/.test(doc.name)) projectError('工程名称不能包含路径或控制字符')
  assetRef(doc.originalBuffer, 'originalBuffer', assets, usedAssets)
  params(doc.params, 'params')
  const currentParams = doc.params as JsonRecord
  const sizeError = getCanvasSizeError({ width: currentParams.viewBoxWidth as number, height: currentParams.viewBoxHeight as number })
  if (sizeError) projectError(sizeError)
  if (doc.customFps !== null) number(doc.customFps, 'customFps', 1, 1000)
  if (doc.customFrames !== null) number(doc.customFrames, 'customFrames', 1, MAX_PROJECT_FRAMES, true)
  const frames = (doc.customFrames ?? (doc.params as JsonRecord).frames) as number
  number(doc.currentFrame, 'currentFrame', 0, frames - 1, true)
  text(doc.selectedPresetId, 'selectedPresetId', 256)
  const video = record(doc.videoItem, 'videoItem', ['movie', 'buffers'])
  const movie = record(video.movie, 'videoItem.movie', ['params', 'sprites'], ['version', 'audios'])
  optional(movie, 'version', text, 'videoItem.movie')
  params(movie.params, 'videoItem.movie.params')
  const movieParams = movie.params as JsonRecord
  if (movieParams.viewBoxWidth !== currentParams.viewBoxWidth || movieParams.viewBoxHeight !== currentParams.viewBoxHeight) projectError('当前画布与预览动画的尺寸不一致')
  array(movie.sprites, 'videoItem.movie.sprites').forEach((value, index) => sprite(value, `videoItem.movie.sprites[${index}]`))
  if (movie.audios !== undefined) array(movie.audios, 'movie.audios').forEach((value, index) => {
    const at = `movie.audios[${index}]`
    const audio = record(value, at, [], ['key', 'data', 'startTime', 'duration', 'audioKey', 'startFrame', 'endFrame', 'totalTime'])
    for (const key of ['key', 'audioKey']) optional(audio, key, text, at)
    for (const key of ['startTime', 'duration', 'totalTime']) optional(audio, key, (v, p) => number(v, p, 0), at)
    for (const key of ['startFrame', 'endFrame']) optional(audio, key, (v, p) => number(v, p, 0, MAX_PROJECT_FRAMES, true), at)
    if (audio.data !== undefined) assetRef(audio.data, `${at}.data`, assets, usedAssets)
  })
  const imageKeys = new Set<string>()
  array(video.buffers, 'videoItem.buffers').forEach((value, index) => {
    const item = record(value, `videoItem.buffers[${index}]`, ['key', 'data'])
    text(item.key, 'videoItem.buffers.key')
    unique(item.key, imageKeys, 'videoItem.buffers.key')
    assetRef(item.data, `videoItem.buffers[${index}].data`, assets, usedAssets)
  })
  const layerIds = new Set<string>(), keyframeIds = new Set<string>()
  array(doc.layers, 'layers').forEach((value, index) => layer(value, `layers[${index}]`, layerIds, keyframeIds))
  for (const kind of ['imageResources', 'audioResources']) {
    const keys = new Set<string>()
    array(doc[kind], kind).forEach((value, index) => {
      const at = `${kind}[${index}]`
      const item = record(value, at, kind === 'imageResources' ? ['key', 'data', 'width', 'height', 'mimeType'] : ['key', 'data', 'startTime', 'duration'], ['isNew'])
      text(item.key, `${at}.key`)
      unique(item.key, keys, `${kind}.key`)
      assetRef(item.data, `${at}.data`, assets, usedAssets)
      optional(item, 'isNew', bool, at)
      if (kind === 'imageResources') {
        number(item.width, `${at}.width`, 1, 100000, true)
        number(item.height, `${at}.height`, 1, 100000, true)
        enumeration(item.mimeType, `${at}.mimeType`, ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
      } else {
        number(item.startTime, `${at}.startTime`, 0)
        number(item.duration, `${at}.duration`, 0)
      }
    })
  }
  const slotKeys = new Set<string>()
  array(doc.slotConfigs, 'slotConfigs').forEach((value, index) => {
    const at = `slotConfigs[${index}]`
    const item = record(value, at, ['key', 'config'])
    text(item.key, `${at}.key`)
    unique(item.key, slotKeys, `${at}.key`)
    const config = record(item.config, `${at}.config`, ['type', 'name', 'value'], ['imageConfig', 'textConfig'])
    enumeration(config.type, `${at}.type`, ['image', 'text'])
    text(config.name, `${at}.name`)
    if (config.value !== null && typeof config.value !== 'object') text(config.value, `${at}.value`, 10000)
    // 图片 URL 只存在于内存；归档只接受资源引用，打开时不会发起网络请求。
    if (typeof config.value === 'string' && config.type === 'image' && /^(?:data:|blob:|https?:|file:)/i.test(config.value)) projectError(`${at}.value 图片必须使用内嵌资源`)
    if (typeof config.value === 'string' && config.value && config.type === 'image' && !config.imageConfig && !config.textConfig) projectError(`${at}.value 缺少可恢复的内嵌图片`)
    if (config.value && typeof config.value === 'object') {
      if (config.type !== 'image') projectError(`${at}.value 文字必须为文本`)
      const imageValue = record(config.value, `${at}.value`, ['asset', 'mimeType'])
      assetRef(imageValue.asset, `${at}.value.asset`, assets, usedAssets)
      enumeration(imageValue.mimeType, `${at}.value.mimeType`, ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    }
    if (config.textConfig !== undefined) textConfig(config.textConfig, `${at}.textConfig`)
    if (config.imageConfig !== undefined) {
      const image = record(config.imageConfig, `${at}.imageConfig`, ['asset', 'mimeType', 'scaleMode'])
      assetRef(image.asset, `${at}.imageConfig.asset`, assets, usedAssets)
      enumeration(image.mimeType, `${at}.imageConfig.mimeType`, ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
      enumeration(image.scaleMode, `${at}.imageConfig.scaleMode`, ['fit', 'fill', 'stretch'])
    }
  })
  const detected = new Set<string>()
  array(doc.detectedSlots, 'detectedSlots').forEach(value => { text(value, 'detectedSlots.key'); unique(value, detected, 'detectedSlots.key') })
  const selected = new Set<string>()
  array(doc.selectedLayerIds, 'selectedLayerIds').forEach(value => {
    text(value, 'selectedLayerIds.id', 256, true)
    unique(value, selected, 'selectedLayerIds.id')
    if (!layerIds.has(value)) projectError('选择集引用不存在的图层')
  })
  if (doc.selectedLayerId !== null) {
    text(doc.selectedLayerId, 'selectedLayerId', 256, true)
    if (!layerIds.has(doc.selectedLayerId)) projectError('主选区引用不存在的图层')
  }
  exportConfigs(doc)
  if (usedAssets.size !== assets.size) projectError('包含未被文档引用的资源')
}
