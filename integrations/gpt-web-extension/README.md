# SVGA Editor MCP for GPT Web

这是一个 Chrome / Edge Manifest V3 扩展。它通过本机 `127.0.0.1` MCP 服务读取和操作 SVGA Editor Pro，并在 ChatGPT 网页右下角显示工具面板。工具调用结果可以一键插入当前 GPT 对话，便于 GPT 继续分析或生成下一步操作。

## 安装

1. 启动 SVGA Editor Pro，在“帮助 → 关于 SVGA Editor Pro”中打开“允许 ChatGPT 操作编辑器”。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启“开发者模式”，选择“加载已解压的扩展”，选择本目录。
3. 点击扩展图标并选择“自动连接本机编辑器”。扩展会自动发现网页版 `5174` 或桌面版 `8765` 服务并完成配对，不需要复制地址和令牌；高级设置仅作为排障备用。
4. 打开 `chatgpt.com`，右下角的“SVGA MCP”按钮可直接调用工具。画布截图和图层素材会显示预览，点击“发送图片给 GPT”会尝试把图片作为 ChatGPT 图片附件提交；确认缩略图出现后再发送消息，GPT 才能真正看到画面。

## 安全边界

- 编辑器 MCP 服务只监听回环地址，不暴露到局域网；扩展权限也只允许访问本机 5174/8765 端口和 ChatGPT 页面。
- 自动发现取得的令牌仅保存在浏览器扩展的本地存储中。不要把令牌提交到仓库或发送给他人。
- 工具默认只提供状态、图层属性、播放、撤销/重做、保存请求和导出面板；不会通过 MCP 直接读取图片二进制或任意路径文件。
- 若端口被占用，可在启动编辑器前设置 `SVGA_MCP_PORT`；若令牌需要固定，可设置 `SVGA_MCP_TOKEN`。

## MCP 兼容性

服务实现 JSON-RPC 2.0 的 `initialize`、`notifications/initialized`、`tools/list`、`tools/call` 和 `ping`，兼容 `2026-07-28` 与 `2025-06-18` 协议版本。扩展使用标准 HTTP POST，因此也可以用其他 MCP 客户端连接同一地址。

新增的视觉与素材工具：

- `get_canvas_snapshot`：读取当前帧或指定帧的 PNG 画布截图。
- `get_layer_image`：读取图片图层的当前素材，返回 MCP image content。
- `replace_layer_image`：用 PNG/JPEG/WebP Base64 替换指定图片 Key，支持撤销。
- `generate_and_import_image`：调用桌面进程中的 OpenAI Images API，并将生成结果导入指定图层。必须传 `confirm: true`，并在启动编辑器前配置 `OPENAI_API_KEY`。

例如，先调用 `get_editor_state` 找到图片图层 ID，再调用：

```json
{
  "name": "generate_and_import_image",
  "arguments": {
    "layerId": "图层 ID",
    "prompt": "透明背景、扁平矢量风格的蓝色星星图标",
    "background": "transparent",
    "outputFormat": "png",
    "confirm": true
  }
}
```

实现形态参考 MCP 官方 [TypeScript SDK 的 HTTP 服务示例](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/server) 与 [2025-06-18 schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/schema.mdx)；桌面端为减少发行包依赖，在 Rust 中实现了同一 JSON-RPC 子集。
