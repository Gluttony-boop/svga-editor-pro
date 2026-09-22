const DEFAULT_CONFIG = {
  endpoint: 'http://127.0.0.1:5174/mcp',
  token: ''
}

let rpcCounter = 1
let session = null

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG)
  return { ...DEFAULT_CONFIG, ...stored }
}

async function discoverEditor() {
  const candidates = [
    { statusUrl: 'http://127.0.0.1:5174/mcp/status', label: '网页编辑器' },
    { statusUrl: 'http://127.0.0.1:8765/status', label: '桌面编辑器' }
  ]
  let lastError = '未发现正在运行的 SVGA 编辑器'
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.statusUrl, { cache: 'no-store' })
      const status = await response.json().catch(() => ({}))
      if (!response.ok || !status.endpoint || !status.token) {
        lastError = status.error || `${candidate.label}不可用`
        continue
      }
      const current = await getConfig()
      await chrome.storage.local.set({ endpoint: status.endpoint, token: status.token, discoveredAt: Date.now(), editorLabel: candidate.label })
      if (current.endpoint !== status.endpoint || current.token !== status.token) session = null
      return { ok: true, status, label: candidate.label }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return { ok: false, error: lastError }
}

async function rpc(method, params = {}) {
  const config = await getConfig()
  if (!config.endpoint || !config.token) throw new Error('请先在扩展弹窗中填写 MCP 地址和令牌')
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.token}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcCounter++, method, params })
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `MCP 请求失败（${response.status}）`)
  if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error))
  return payload.result
}

async function ensureSession() {
  const discovered = await discoverEditor()
  if (discovered.ok && discovered.status.enabled === false) throw new Error('SVGA 编辑器 AI / MCP 开关已关闭，请先打开开关')
  const config = await getConfig()
  if (!discovered.ok && (!config.endpoint || !config.token)) throw new Error(discovered.error)
  if (session?.endpoint === config.endpoint && session?.token === config.token) return
  const result = await rpc('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: { tools: {} },
    clientInfo: { name: 'svga-editor-gpt-web-extension', version: '1.0.0' }
  })
  session = { endpoint: config.endpoint, token: config.token, serverInfo: result.serverInfo }
  // MCP 初始化握手完成后通知服务端。
  await rpc('notifications/initialized')
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  ;(async () => {
    try {
      if (message.type === 'mcp:configure') {
        await chrome.storage.local.set({ endpoint: message.endpoint, token: message.token })
        session = null
        sendResponse({ ok: true })
        return
      }
      if (message.type === 'mcp:discover') {
        const result = await discoverEditor()
        sendResponse(result)
        return
      }
      if (message.type === 'mcp:health') {
        const result = await discoverEditor()
        if (!result.ok) { sendResponse(result); return }
        sendResponse({ ok: true, status: result.status })
        return
      }
      await ensureSession()
      if (message.type === 'mcp:listTools') {
        sendResponse({ ok: true, result: await rpc('tools/list') })
        return
      }
      if (message.type === 'mcp:call') {
        sendResponse({ ok: true, result: await rpc('tools/call', { name: message.name, arguments: message.arguments || {} }) })
        return
      }
      throw new Error('未知扩展消息')
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
  return true
})
