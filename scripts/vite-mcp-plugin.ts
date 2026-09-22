import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'

const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_BASE64_BYTES = 14 * 1024 * 1024
const TOOL_TIMEOUT_MS = 30_000
const IMAGE_TIMEOUT_MS = 180_000

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null
type Client = { send: (event: string, payload?: unknown) => void }
type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

const toolDefinitions = [
  { name: 'get_editor_state', description: '读取当前 SVGA 工程的安全摘要（不包含图片二进制）', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_canvas_snapshot', description: '读取指定帧的画布截图，让模型看到当前 SVGA 合成效果', inputSchema: { type: 'object', properties: { frame: { type: 'integer', minimum: 0 }, maxDimension: { type: 'integer', minimum: 256, maximum: 2048, default: 1024 } }, additionalProperties: false } },
  { name: 'get_layer_image', description: '读取指定图片图层的实际素材', inputSchema: { type: 'object', properties: { layerId: { type: 'string' } }, required: ['layerId'], additionalProperties: false } },
  { name: 'replace_layer_image', description: '用 PNG、JPEG 或 WebP Base64 图片替换图层素材', inputSchema: { type: 'object', properties: { layerId: { type: 'string' }, imageBase64: { type: 'string' }, mimeType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] } }, required: ['layerId', 'imageBase64', 'mimeType'], additionalProperties: false } },
  { name: 'generate_and_import_image', description: '调用 OpenAI 图片生成 API 并导入指定图层，必须显式确认', inputSchema: { type: 'object', properties: { layerId: { type: 'string' }, prompt: { type: 'string', minLength: 1, maxLength: 8000 }, model: { type: 'string', enum: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2'] }, size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'] }, quality: { type: 'string', enum: ['low', 'medium', 'high'] }, background: { type: 'string', enum: ['transparent', 'opaque', 'auto'] }, outputFormat: { type: 'string', enum: ['png', 'webp'] }, confirm: { type: 'boolean' } }, required: ['layerId', 'prompt', 'confirm'], additionalProperties: false } },
  { name: 'select_layer', description: '选中一个图层', inputSchema: { type: 'object', properties: { layerId: { type: 'string' }, additive: { type: 'boolean' } }, required: ['layerId'], additionalProperties: false } },
  { name: 'update_layer', description: '更新图层的可编辑属性', inputSchema: { type: 'object', properties: { layerId: { type: 'string' }, updates: { type: 'object' } }, required: ['layerId', 'updates'], additionalProperties: false } },
  { name: 'set_current_frame', description: '跳转到指定帧', inputSchema: { type: 'object', properties: { frame: { type: 'integer', minimum: 0 } }, required: ['frame'], additionalProperties: false } },
  { name: 'set_playing', description: '开始或暂停预览播放', inputSchema: { type: 'object', properties: { playing: { type: 'boolean' } }, required: ['playing'], additionalProperties: false } },
  { name: 'set_preview_background', description: '设置预览背景颜色', inputSchema: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'], additionalProperties: false } },
  { name: 'undo', description: '撤销最近一次编辑', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'redo', description: '重做最近一次撤销', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'save_project', description: '请求编辑器保存当前工程', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'focus_export', description: '打开导出面板', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
]

function tokenValue(): string {
  const configured = process.env.SVGA_MCP_TOKEN?.trim()
  return configured || `svga-web-${randomBytes(18).toString('hex')}`
}

function jsonResponse(response: ServerResponse, status: number, body: Json): void {
  const data = Buffer.from(JSON.stringify(body))
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', data.length)
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-MCP-Token, MCP-Protocol-Version')
  response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  response.setHeader('Cache-Control', 'no-store')
  response.end(data)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const length = Number(request.headers['content-length'] || 0)
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY_BYTES) throw new Error('请求体超过 16 MiB 限制')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体超过 16 MiB 限制')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const auth = request.headers.authorization
  const supplied = auth?.startsWith('Bearer ') ? auth.slice(7) : request.headers['x-mcp-token']
  return supplied === token
}

function isLocalWebOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  return !origin || origin === 'http://127.0.0.1:5174' || origin === 'http://localhost:5174' || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')
}

function rpcError(id: unknown, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } }
}

function okTool(message: string): Json {
  return { content: [{ type: 'text', text: message }] }
}

function requestEditorTool(client: Client | null, tool: string, argumentsValue: Record<string, unknown>, pending: Map<string, Pending>): Promise<Json> {
  if (!client) return Promise.reject(new Error('网页编辑器尚未连接 MCP 桥接，请先打开或刷新编辑器页面'))
  const requestId = `web-mcp-${randomUUID()}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('网页编辑器未在 30 秒内响应 MCP 工具调用'))
    }, TOOL_TIMEOUT_MS)
    pending.set(requestId, { resolve, reject, timer })
    client.send('svga:mcp-request', { requestId, tool, arguments: argumentsValue })
  })
}

async function generateImage(argumentsValue: Record<string, unknown>, client: Client | null, pending: Map<string, Pending>, apiKey: string | undefined): Promise<Json> {
  if (argumentsValue.confirm !== true) return { content: [{ type: 'text', text: '生成图片会产生 API 费用并修改工程；请将 confirm 设为 true' }], isError: true }
  if (!apiKey) return { content: [{ type: 'text', text: '未配置 OPENAI_API_KEY，无法生成图片' }], isError: true }
  const layerId = typeof argumentsValue.layerId === 'string' ? argumentsValue.layerId.trim() : ''
  const prompt = typeof argumentsValue.prompt === 'string' ? argumentsValue.prompt.trim() : ''
  if (!layerId || !prompt) return { content: [{ type: 'text', text: 'layerId 和 prompt 不能为空' }], isError: true }
  const model = argumentsValue.model === 'gpt-image-2.5-sunburst' || argumentsValue.model === 'gpt-image-2' ? argumentsValue.model : 'gpt-image-2.5-flare'
  const size = ['1536x1024', '1024x1536'].includes(String(argumentsValue.size)) ? String(argumentsValue.size) : '1024x1024'
  const quality = ['low', 'high'].includes(String(argumentsValue.quality)) ? String(argumentsValue.quality) : 'medium'
  const background = ['opaque', 'auto'].includes(String(argumentsValue.background)) ? String(argumentsValue.background) : 'transparent'
  const outputFormat = argumentsValue.outputFormat === 'png' ? 'png' : 'webp'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS)
  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, size, quality, background, output_format: outputFormat, output_compression: 90, n: 1 }),
      signal: controller.signal
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) {
      const errorValue = payload.error as Record<string, unknown> | undefined
      return { content: [{ type: 'text', text: `OpenAI 图片生成失败：${String(errorValue?.message || response.status)}` }], isError: true }
    }
    const first = Array.isArray(payload.data) ? payload.data[0] as Record<string, unknown> : undefined
    const imageBase64 = typeof first?.b64_json === 'string' ? first.b64_json : ''
    if (!imageBase64 || imageBase64.length > MAX_IMAGE_BASE64_BYTES) return { content: [{ type: 'text', text: '生成图片为空或超过 10 MiB 导入限制' }], isError: true }
    const result = await requestEditorTool(client, 'replace_layer_image', { layerId, imageBase64, mimeType: outputFormat === 'png' ? 'image/png' : 'image/webp' }, pending)
    return { ...result as Record<string, unknown>, generation: { model, size, quality, background, outputFormat, revisedPrompt: first?.revised_prompt || null } }
  } catch (error) {
    return { content: [{ type: 'text', text: `图片生成请求失败：${error instanceof Error ? error.message : String(error)}` }], isError: true }
  } finally {
    clearTimeout(timer)
  }
}

function mcpPlugin(): Plugin {
  const token = tokenValue()
  const pending = new Map<string, Pending>()
  let editorClient: Client | null = null
  let editorEnabled = true
  let server: ViteDevServer | null = null
  const apiKey = process.env.OPENAI_API_KEY

  return {
    name: 'svga-editor-mcp-web',
    configureServer(viteServer) {
      server = viteServer
      viteServer.ws.on('svga:mcp-ready', (_payload, client) => {
        editorClient = client
        client.socket.on('close', () => {
          if (editorClient === client) editorClient = null
        })
        client.send('svga:mcp-status', { endpoint: '/mcp', imageGenerationConfigured: Boolean(apiKey) })
      })
      viteServer.ws.on('svga:mcp-settings', (payload: { enabled?: boolean }, client) => {
        if (editorClient !== client) return
        editorEnabled = payload?.enabled !== false
      })
      viteServer.ws.on('svga:mcp-response', (payload: { requestId?: string; response?: Json }) => {
        if (!payload?.requestId) return
        const entry = pending.get(payload.requestId)
        if (!entry) return
        clearTimeout(entry.timer)
        pending.delete(payload.requestId)
        entry.resolve(payload.response ?? null)
      })
      viteServer.middlewares.use('/mcp', async (request, response, next) => {
        if (request.method === 'OPTIONS') { jsonResponse(response, 204, null); return }
        if (request.method === 'GET' && request.url === '/health') { jsonResponse(response, 200, { ok: true, service: 'svga-editor-mcp-web', editorConnected: Boolean(editorClient) }); return }
        if (request.method === 'GET' && request.url === '/status') {
          if (!isLocalWebOrigin(request)) { jsonResponse(response, 403, { error: 'MCP 状态只允许编辑器本机页面读取' }); return }
          jsonResponse(response, 200, { enabled: editorEnabled, endpoint: 'http://127.0.0.1:5174/mcp', token, protocol_version: '2026-07-28', image_generation_configured: Boolean(apiKey), editorConnected: Boolean(editorClient) }); return
        }
        if (request.method !== 'POST' || request.url !== '/') { next(); return }
        if (!isAuthorized(request, token)) { jsonResponse(response, 401, { error: 'MCP 令牌无效' }); return }
        if (!editorEnabled) { jsonResponse(response, 403, rpcError(null, 'SVGA 编辑器 AI / MCP 开关已关闭')); return }
        try {
          const rpc = JSON.parse(await readBody(request)) as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }
          if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') { jsonResponse(response, 400, rpcError(rpc.id, 'JSON-RPC 2.0 请求无效')); return }
          let result: Json
          if (rpc.method === 'initialize') result = { protocolVersion: rpc.params?.protocolVersion === '2026-07-28' ? '2026-07-28' : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'svga-editor-pro-web', version: '2.0.0' } }
          else if (rpc.method === 'ping' || rpc.method === 'notifications/initialized') result = {}
          else if (rpc.method === 'tools/list') result = { tools: toolDefinitions }
          else if (rpc.method === 'tools/call') {
            const params = rpc.params || {}
            const name = typeof params.name === 'string' ? params.name : ''
            const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)) ? params.arguments as Record<string, unknown> : {}
            result = name === 'generate_and_import_image' ? await generateImage(args, editorClient, pending, apiKey) : await requestEditorTool(editorClient, name, args, pending)
          } else { jsonResponse(response, 200, rpcError(rpc.id, `未知 MCP 方法：${rpc.method}`)); return }
          if (rpc.id === undefined) { jsonResponse(response, 202, null); return }
          jsonResponse(response, 200, { jsonrpc: '2.0', id: rpc.id, result })
        } catch (error) {
          jsonResponse(response, 500, rpcError(null, error instanceof Error ? error.message : String(error)))
        }
      })
      server.config.logger.info(`[MCP] 网页服务已启用：http://127.0.0.1:5174/mcp，令牌：${token}`)
    },
    closeBundle() {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('MCP 服务已关闭')) }
      pending.clear()
      server = null
    }
  }
}

export default mcpPlugin
