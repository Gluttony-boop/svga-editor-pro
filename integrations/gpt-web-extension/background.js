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
  const config = await getConfig()
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
      if (message.type === 'mcp:health') {
        const config = await getConfig()
        const response = await fetch(config.endpoint.replace(/\/mcp\/?$/, '/health'), { headers: { 'Authorization': `Bearer ${config.token}` } })
        sendResponse({ ok: response.ok, status: response.status })
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
