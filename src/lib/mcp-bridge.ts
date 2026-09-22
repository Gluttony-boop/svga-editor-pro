import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useEditorStore } from '@/stores'
import { resourceManager } from '@/core'
import { detectImageMime } from '@/utils/image-mime'

interface McpRequestEvent {
  requestId: string
  tool: string
  arguments?: Record<string, unknown>
}

interface McpToolResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >
  structuredContent?: unknown
  isError?: boolean
}

const MAX_MCP_IMAGE_BYTES = 10 * 1024 * 1024
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const EDITABLE_LAYER_FIELDS = new Set([
  'name', 'visible', 'locked', 'opacity', 'blendMode', 'clip', 'timeOffsetFrames',
  'imageKey', 'audioKey', 'audioStartTime', 'audioDuration', 'editableIndex', 'canvasTransform'
])

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function ok(value: unknown): McpToolResponse {
  let text: string
  try { text = JSON.stringify(value, null, 2) } catch { text = String(value) }
  return { content: [{ type: 'text', text }], structuredContent: value }
}

function fail(message: string): McpToolResponse {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 32 * 1024
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function normalizeBase64Image(value: unknown, declaredMimeType: unknown): { base64: string; mimeType: string } | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const trimmed = value.trim()
  const dataUrl = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed)
  const mimeType = dataUrl?.[1].toLowerCase() || (typeof declaredMimeType === 'string' ? declaredMimeType.toLowerCase() : '')
  const base64 = (dataUrl?.[2] || trimmed).replace(/\s/g, '')
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const estimatedBytes = Math.floor(base64.length * 3 / 4) - padding
  if (estimatedBytes <= 0 || estimatedBytes > MAX_MCP_IMAGE_BYTES) return null
  return { base64, mimeType }
}

async function waitForPreviewFrame(frameIndex: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timer = 0
    const handleFrame = (event: Event) => {
      if ((event as CustomEvent<{ frameIndex: number }>).detail?.frameIndex !== frameIndex) return
      window.clearTimeout(timer)
      window.removeEventListener('svga-preview-frame', handleFrame)
      resolve()
    }
    window.addEventListener('svga-preview-frame', handleFrame)
    timer = window.setTimeout(() => {
      window.removeEventListener('svga-preview-frame', handleFrame)
      reject(new Error('预览画面未在 5 秒内完成渲染'))
    }, 5000)
    window.dispatchEvent(new CustomEvent('svga-manual-frame', { detail: { frameIndex } }))
  })
}

async function canvasSnapshot(frame: number | undefined, maxDimension: number): Promise<McpToolResponse> {
  const state = useEditorStore.getState()
  if (!state.videoItem) return fail('当前没有打开 SVGA 工程')
  const frameIndex = frame ?? state.playback.currentFrame
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= Math.max(1, state.playback.totalFrames)) return fail('帧号超出范围')
  if (state.playback.isPlaying) state.setPlaying(false)
  state.setCurrentFrame(frameIndex)
  await waitForPreviewFrame(frameIndex)

  const source = window.__SVGA_CANVAS__
  if (!source || !source.width || !source.height) return fail('当前渲染器没有可读取的预览画布')
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * scale))
  canvas.height = Math.max(1, Math.round(source.height * scale))
  const context = canvas.getContext('2d')
  if (!context) return fail('无法创建截图画布')
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('画布截图编码失败')), 'image/png'))
  if (blob.size > MAX_MCP_IMAGE_BYTES) return fail('截图超过 10 MiB，请减小 maxDimension')
  const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
  return {
    content: [
      { type: 'text', text: `SVGA 当前第 ${frameIndex + 1} 帧，画布 ${canvas.width}×${canvas.height}` },
      { type: 'image', data, mimeType: 'image/png' }
    ],
    structuredContent: { frame: frameIndex, width: canvas.width, height: canvas.height, mimeType: 'image/png' }
  }
}

function layerImage(layerId: string): McpToolResponse {
  const state = useEditorStore.getState()
  const layer = state.layers.find(item => item.id === layerId)
  if (!layer) return fail('图层不存在')
  if (!layer.imageKey) return fail('该图层不是图片图层或没有图片 Key')
  const replacement = state.imageResources.get(layer.imageKey)
  const original = state.videoItem?.buffers?.[layer.imageKey]
  const movieImage = state.videoItem?.movie.images?.[layer.imageKey]
  const bytes = replacement?.data?.byteLength
    ? replacement.data
    : original
      ? new Uint8Array(original)
      : movieImage
        ? new Uint8Array(movieImage)
        : undefined
  if (!bytes?.byteLength) return fail(`找不到图片资源：${layer.imageKey}`)
  if (bytes.byteLength > MAX_MCP_IMAGE_BYTES) return fail('图层图片超过 10 MiB，未通过 MCP 返回')
  const mimeType = detectImageMime(bytes, replacement?.mimeType)
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return fail(`不支持的图片格式：${mimeType}`)
  const image = state.videoItem?.images?.[layer.imageKey]
  const width = replacement?.width || image?.naturalWidth || image?.width || 0
  const height = replacement?.height || image?.naturalHeight || image?.height || 0
  return {
    content: [
      { type: 'text', text: `图层“${layer.name}”的图片资源 ${layer.imageKey}，${width}×${height}` },
      { type: 'image', data: bytesToBase64(bytes), mimeType }
    ],
    structuredContent: { layerId, layerName: layer.name, imageKey: layer.imageKey, width, height, mimeType, byteSize: bytes.byteLength }
  }
}

async function replaceLayerImage(layerId: string, imageBase64: unknown, mimeType: unknown): Promise<McpToolResponse> {
  const state = useEditorStore.getState()
  const layer = state.layers.find(item => item.id === layerId)
  if (!layer) return fail('图层不存在')
  if (!layer.imageKey) return fail('该图层不是图片图层或没有图片 Key')
  const normalized = normalizeBase64Image(imageBase64, mimeType)
  if (!normalized) return fail('图片必须是 10 MiB 以内的 PNG、JPEG 或 WebP Base64 数据')
  const dataUrl = `data:${normalized.mimeType};base64,${normalized.base64}`
  const result = await resourceManager.loadFromDataUrl(dataUrl, layer.imageKey)
  if (!result.success || !result.resource) return fail(result.error || '图片读取失败')
  const detectedMimeType = detectImageMime(result.resource.data, result.resource.mimeType)
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(detectedMimeType)) return fail('图片实际编码不是 PNG、JPEG 或 WebP')
  result.resource.mimeType = detectedMimeType as 'image/png' | 'image/jpeg' | 'image/webp'
  state.addImageResource(result.resource)
  const affectedLayers = useEditorStore.getState().layers.filter(item => item.imageKey === layer.imageKey).map(item => item.id)
  return ok({
    replaced: true,
    layerId,
    imageKey: layer.imageKey,
    affectedLayers,
    width: result.resource.width,
    height: result.resource.height,
    mimeType: result.resource.mimeType,
    byteSize: result.resource.data.byteLength,
    message: affectedLayers.length > 1 ? `共享该图片 Key 的 ${affectedLayers.length} 个图层已一起更新` : '图层图片已更新'
  })
}

function serializableEditorState() {
  const state = useEditorStore.getState()
  return {
    projectName: state.projectName,
    projectFilePath: state.projectFilePath,
    currentSource: state.currentSource,
    sourceType: state.sourceType,
    isDirty: state.isDirty,
    params: state.params,
    playback: state.playback,
    selectedLayerId: state.selectedLayerId,
    selectedLayerIds: state.selectedLayerIds,
    detectedSlots: state.detectedSlots,
    slotConfigs: state.slotConfigs,
    layers: state.layers.map(layer => ({
      id: layer.id,
      name: layer.name,
      type: layer.type,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      clip: layer.clip,
      timeOffsetFrames: layer.timeOffsetFrames ?? 0,
      imageKey: layer.imageKey,
      audioKey: layer.audioKey,
      editableIndex: layer.editableIndex,
      canvasTransform: layer.canvasTransform,
      trackSummary: Object.fromEntries(Object.entries(layer.tracks).map(([key, track]) => [key, {
        defaultValue: track.defaultValue,
        keyframeCount: track.keyframes.length
      }]))
    })),
    resources: {
      images: Array.from(state.imageResources.keys()),
      audios: Array.from(state.audioResources.keys())
    },
    history: {
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      pastCount: state.history.past.length,
      futureCount: state.history.future.length
    }
  }
}

function allowedLayerUpdates(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const updates: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(input)) {
    if (!EDITABLE_LAYER_FIELDS.has(key)) continue
    if (key === 'name' && typeof item !== 'string') return null
    if (['visible', 'locked'].includes(key) && typeof item !== 'boolean') return null
    if (['opacity', 'timeOffsetFrames', 'audioStartTime', 'audioDuration', 'editableIndex'].includes(key) && (typeof item !== 'number' || !Number.isFinite(item))) return null
    if (key === 'clip') {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const clip = item as Record<string, unknown>
      if (!Number.isInteger(clip.startFrame) || !Number.isInteger(clip.duration) || Number(clip.startFrame) < 0 || Number(clip.duration) < 0) return null
    }
    if (key === 'canvasTransform') {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const transform = item as Record<string, unknown>
      if (['x', 'y', 'scaleX', 'scaleY', 'rotation'].some(name => typeof transform[name] !== 'number' || !Number.isFinite(transform[name] as number))) return null
    }
    updates[key] = item
  }
  return Object.keys(updates).length > 0 ? updates : null
}

function dispatchMenuAction(action: 'save' | 'export') {
  window.dispatchEvent(new CustomEvent('menu-action', { detail: action }))
}

async function handleTool(request: McpRequestEvent): Promise<McpToolResponse> {
  const args = request.arguments ?? {}
  const state = useEditorStore.getState()

  try {
    switch (request.tool) {
      case 'get_editor_state':
        return ok(serializableEditorState())
      case 'get_canvas_snapshot': {
        const frame = args.frame === undefined ? undefined : Number(args.frame)
        const requestedMax = args.maxDimension === undefined ? 1024 : Number(args.maxDimension)
        if (!Number.isInteger(requestedMax) || requestedMax < 256 || requestedMax > 2048) return fail('maxDimension 必须是 256 到 2048 的整数')
        return await canvasSnapshot(frame, requestedMax)
      }
      case 'get_layer_image':
        return layerImage(typeof args.layerId === 'string' ? args.layerId : '')
      case 'replace_layer_image':
        return await replaceLayerImage(typeof args.layerId === 'string' ? args.layerId : '', args.imageBase64, args.mimeType)
      case 'select_layer': {
        const layerId = typeof args.layerId === 'string' ? args.layerId : ''
        if (!layerId || !state.layers.some(layer => layer.id === layerId)) return fail('图层不存在')
        state.selectLayer(layerId, args.additive === true)
        return ok({ selectedLayerId: layerId, selectedLayerIds: useEditorStore.getState().selectedLayerIds })
      }
      case 'update_layer': {
        const layerId = typeof args.layerId === 'string' ? args.layerId : ''
        if (!layerId || !state.layers.some(layer => layer.id === layerId)) return fail('图层不存在')
        const updates = allowedLayerUpdates(args.updates)
        if (!updates) return fail('没有可应用的图层属性，或属性类型无效')
        state.updateLayer(layerId, updates)
        return ok({ layerId, updates })
      }
      case 'set_current_frame': {
        const frame = Number(args.frame)
        if (!Number.isInteger(frame) || frame < 0 || frame >= Math.max(1, state.playback.totalFrames)) return fail('帧号超出范围')
        state.setCurrentFrame(frame)
        return ok({ currentFrame: useEditorStore.getState().playback.currentFrame })
      }
      case 'set_playing':
        if (typeof args.playing !== 'boolean') return fail('playing 必须是布尔值')
        state.setPlaying(args.playing)
        return ok({ playing: useEditorStore.getState().playback.isPlaying })
      case 'set_preview_background':
        if (typeof args.color !== 'string' || !/^#[0-9a-f]{6,8}$/i.test(args.color)) return fail('颜色必须是 #RRGGBB 或 #RRGGBBAA')
        state.setPreviewBackgroundColor(args.color)
        return ok({ color: useEditorStore.getState().previewBackgroundColor })
      case 'undo':
        if (!state.canUndo) return fail('没有可撤销的编辑')
        state.undo()
        return ok({ canUndo: useEditorStore.getState().canUndo })
      case 'redo':
        if (!state.canRedo) return fail('没有可重做的编辑')
        state.redo()
        return ok({ canRedo: useEditorStore.getState().canRedo })
      case 'save_project':
        dispatchMenuAction('save')
        return ok({ accepted: true, message: '已请求编辑器保存工程' })
      case 'focus_export':
        dispatchMenuAction('export')
        return ok({ accepted: true, message: '已打开导出面板' })
      default:
        return fail(`未知工具：${request.tool}`)
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** 注册桌面端 MCP 请求桥；网页构建不会打开本地监听器。 */
export async function registerMcpBridge(): Promise<UnlistenFn | undefined> {
  if (!isTauriRuntime()) return registerWebMcpBridge()
  return listen<McpRequestEvent>('mcp-request', async event => {
    const response = await handleTool(event.payload)
    try {
      await invoke('mcp_respond', { requestId: event.payload.requestId, response })
    } catch (error) {
      console.warn('[MCP] 返回工具结果失败：', error)
    }
  })
}

/** Vite 网页开发模式使用 HMR WebSocket 作为本机 MCP 桥接，不需要 Tauri。 */
function registerWebMcpBridge(): (() => void) | undefined {
  const hot = import.meta.hot
  if (!hot) return undefined
  const handleRequest = async (request: McpRequestEvent) => {
    const response = await handleTool(request)
    hot.send('svga:mcp-response', { requestId: request.requestId, response })
  }
  hot.on('svga:mcp-request', handleRequest)
  hot.send('svga:mcp-ready', { version: 1 })
  return () => hot.off('svga:mcp-request', handleRequest)
}

export const __mcpTest = { allowedLayerUpdates, normalizeBase64Image, serializableEditorState }
