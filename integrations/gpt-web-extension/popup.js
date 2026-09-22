const $ = id => document.getElementById(id)
const status = message => { $('status').textContent = message }
const send = message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve))
const compactResult = value => JSON.stringify(value, (_key, item) => {
  if (typeof item === 'string' && item.length > 2048) return `[已省略 ${item.length} 字符]`
  return item
}, 2)

async function loadConfig() {
  const config = await chrome.storage.local.get({ endpoint: 'http://127.0.0.1:5174/mcp', token: '' })
  $('endpoint').value = config.endpoint
  $('token').value = config.token
}

async function refreshTools() {
  status('正在读取工具...')
  const response = await send({ type: 'mcp:listTools' })
  if (!response?.ok) { status(response?.error || '连接失败'); return }
  const select = $('tool')
  select.replaceChildren(...(response.result.tools || []).map(tool => {
    const option = document.createElement('option')
    option.value = tool.name
    option.textContent = `${tool.name} - ${tool.description || ''}`
    return option
  }))
  status(`已连接，可用工具 ${select.options.length} 个`)
}

$('connect').addEventListener('click', async () => {
  const response = await send({ type: 'mcp:configure', endpoint: $('endpoint').value.trim(), token: $('token').value.trim() })
  status(response?.ok ? '配置已保存' : response?.error || '保存失败')
})
$('refresh').addEventListener('click', refreshTools)
$('call').addEventListener('click', async () => {
  let args
  try { args = JSON.parse($('arguments').value || '{}') } catch { status('参数 JSON 无效'); return }
  status('正在调用...')
  const response = await send({ type: 'mcp:call', name: $('tool').value, arguments: args })
  $('result').textContent = response?.ok ? compactResult(response.result) : response?.error || '调用失败'
  status(response?.ok ? '调用完成' : '调用失败')
})
void loadConfig()
