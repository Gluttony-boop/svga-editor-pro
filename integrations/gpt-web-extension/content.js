(() => {
  if (document.getElementById('svga-mcp-root')) return
  const root = document.createElement('div')
  root.id = 'svga-mcp-root'
  root.innerHTML = `<div id="svga-mcp-panel"><strong>SVGA Editor MCP</strong><select id="svga-mcp-tool"></select><textarea id="svga-mcp-args">{}</textarea><button id="svga-mcp-run">调用工具</button><button id="svga-mcp-insert" style="margin-left:6px;background:#303746">插入 GPT</button><button id="svga-mcp-attach" style="display:none;margin-left:6px;background:#287a58">发送图片给 GPT</button><img id="svga-mcp-image" alt="MCP 返回的 SVGA 图片"><pre id="svga-mcp-result"></pre></div><button id="svga-mcp-toggle">SVGA MCP</button>`
  document.body.appendChild(root)
  const panel = root.querySelector('#svga-mcp-panel')
  const result = root.querySelector('#svga-mcp-result')
  const tool = root.querySelector('#svga-mcp-tool')
  const image = root.querySelector('#svga-mcp-image')
  const attach = root.querySelector('#svga-mcp-attach')
  let latestResponse = null

  const imageContent = response => response?.result?.content?.find(item => item?.type === 'image' && item.data && item.mimeType)
  const withoutImageData = value => JSON.stringify(value, (_key, item) => {
    if (typeof item === 'string' && item.length > 2048) return `[已省略 ${item.length} 字符]`
    return item
  }, 2)

  const imageFile = item => {
    const binary = atob(item.data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const extension = item.mimeType === 'image/webp' ? 'webp' : item.mimeType === 'image/jpeg' ? 'jpg' : 'png'
    return new File([bytes], `svga-mcp-${Date.now()}.${extension}`, { type: item.mimeType })
  }

  const attachImageToChatGpt = item => {
    const fileInput = [...document.querySelectorAll('input[type="file"]')].find(input => {
      const accept = input.getAttribute('accept') || ''
      return !accept || accept.includes('image') || accept.includes('*')
    })
    if (!fileInput) throw new Error('未找到 ChatGPT 图片上传入口，请先点击输入框旁的附件按钮再重试')
    const transfer = new DataTransfer()
    transfer.items.add(imageFile(item))
    fileInput.files = transfer.files
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const send = message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve))
  const loadTools = async () => {
    result.textContent = '正在自动连接本机 SVGA 编辑器...'
    const discovered = await send({ type: 'mcp:discover' })
    if (!discovered?.ok) { result.textContent = '未发现编辑器。请打开 SVGA 编辑器，并在“关于”中开启 AI / MCP。'; return }
    if (discovered.status?.enabled === false) { result.textContent = '已发现编辑器，但 AI / MCP 开关尚未打开。'; return }
    if (discovered.status?.editorConnected === false) { result.textContent = '已发现网页服务，但编辑器页面尚未连接，请刷新 SVGA 编辑器页面。'; return }
    const response = await send({ type: 'mcp:listTools' })
    if (!response?.ok) { result.textContent = response?.error || '自动连接失败'; return }
    tool.replaceChildren(...(response.result.tools || []).map(item => {
      const option = document.createElement('option')
      option.value = item.name; option.textContent = item.name
      return option
    }))
    result.textContent = '已连接。选择工具并执行，结果可插入当前 GPT 对话。'
  }
  root.querySelector('#svga-mcp-toggle').addEventListener('click', async () => {
    panel.classList.toggle('open')
    if (panel.classList.contains('open') && !tool.options.length) await loadTools()
  })
  root.querySelector('#svga-mcp-run').addEventListener('click', async () => {
    let args
    try { args = JSON.parse(root.querySelector('#svga-mcp-args').value || '{}') } catch { result.textContent = '参数 JSON 无效'; return }
    const response = await send({ type: 'mcp:call', name: tool.value, arguments: args })
    latestResponse = response
    const returnedImage = imageContent(response)
    image.src = returnedImage ? `data:${returnedImage.mimeType};base64,${returnedImage.data}` : ''
    image.style.display = returnedImage ? 'block' : 'none'
    attach.style.display = returnedImage ? 'inline-block' : 'none'
    result.textContent = response?.ok ? withoutImageData(response.result) : response?.error || '调用失败'
  })
  root.querySelector('#svga-mcp-insert').addEventListener('click', () => {
    const text = result.textContent || ''
    const input = document.querySelector('textarea[data-id="root"], textarea[placeholder*="Message"], [contenteditable="true"]')
    if (!input || !text) return
    if (input instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(input, `${input.value}\n\n[SVGA MCP 结果]\n${text}`)
    } else {
      input.textContent = `${input.textContent || ''}\n\n[SVGA MCP 结果]\n${text}`
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    input.focus()
  })
  attach.addEventListener('click', () => {
    const returnedImage = imageContent(latestResponse)
    if (!returnedImage) return
    try {
      attachImageToChatGpt(returnedImage)
      result.textContent = `${result.textContent}\n\n图片已提交到 ChatGPT 附件区，请确认缩略图出现后发送消息。`
    } catch (error) {
      result.textContent = `${result.textContent}\n\n${error instanceof Error ? error.message : String(error)}`
    }
  })
  // 页面加载后先静默探测一次；用户打开面板时通常已经完成连接。
  window.setTimeout(() => { void loadTools() }, 250)
})()
