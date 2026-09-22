//! 本地 MCP（Model Context Protocol）桥接服务。
//!
//! 服务只绑定回环地址，不直接读取或修改编辑器数据。需要访问 Zustand 状态的工具
//! 会通过 Tauri 事件转发到前端，再由前端调用 `mcp_respond` 返回结果。这样文件和
//! 工程数据仍然受编辑器现有权限边界控制。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

const DEFAULT_PORT: u16 = 8765;
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const IMAGE_GENERATION_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_GENERATED_BASE64_BYTES: usize = 14 * 1024 * 1024;
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";
const LATEST_PROTOCOL_VERSION: &str = "2026-07-28";

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
pub struct McpStatus {
    pub enabled: bool,
    pub endpoint: String,
    pub token: String,
    pub protocol_version: &'static str,
    pub image_generation_configured: bool,
}

#[derive(Clone)]
pub struct McpServerState {
    pub status: McpStatus,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn token_from_environment() -> String {
    if let Ok(value) = std::env::var("SVGA_MCP_TOKEN") {
        let trimmed = value.trim();
        if !trimmed.is_empty() && trimmed.len() <= 128 {
            return trimmed.to_string();
        }
    }

    format!("svga-{}", uuid::Uuid::new_v4().simple())
}

fn configured_port() -> u16 {
    std::env::var("SVGA_MCP_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(DEFAULT_PORT)
}

pub fn start(app: tauri::AppHandle) -> McpServerState {
    let token = token_from_environment();
    let requested_port = configured_port();
    let pending = Arc::new(Mutex::new(HashMap::new()));

    let listener = TcpListener::bind(("127.0.0.1", requested_port));
    let (enabled, endpoint) = match listener {
        Ok(listener) => {
            let port = listener
                .local_addr()
                .map(|address| address.port())
                .unwrap_or(requested_port);
            let endpoint = format!("http://127.0.0.1:{port}/mcp");
            let state_pending = Arc::clone(&pending);
            let state_token = token.clone();
            let server_app = app.clone();
            thread::Builder::new()
                .name("svga-mcp".to_string())
                .spawn(move || serve(listener, server_app, state_pending, state_token))
                .expect("无法启动 MCP 服务线程");
            (true, endpoint)
        }
        Err(error) => {
            log::warn!("MCP 服务未启动，端口 {requested_port} 不可用：{error}");
            (false, format!("http://127.0.0.1:{requested_port}/mcp"))
        }
    };

    McpServerState {
        status: McpStatus {
            enabled,
            endpoint,
            token,
            protocol_version: LATEST_PROTOCOL_VERSION,
            image_generation_configured: openai_api_key().is_some(),
        },
        pending,
    }
}

pub fn respond(state: &McpServerState, request_id: String, response: Value) -> Result<(), String> {
    let sender = state
        .pending
        .lock()
        .map_err(|_| "MCP 响应队列已损坏".to_string())?
        .remove(&request_id)
        .ok_or_else(|| "MCP 请求不存在或已超时".to_string())?;
    sender
        .send(response)
        .map_err(|_| "MCP 客户端已断开".to_string())
}

fn serve(
    listener: TcpListener,
    app: tauri::AppHandle,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    token: String,
) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let app = app.clone();
                let pending = Arc::clone(&pending);
                let token = token.clone();
                let _ = thread::Builder::new()
                    .name("svga-mcp-request".to_string())
                    .spawn(move || handle_connection(stream, app, pending, token));
            }
            Err(error) => log::warn!("MCP 接收请求失败：{error}"),
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    app: tauri::AppHandle,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    token: String,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let result = read_http_request(&mut stream)
        .and_then(|request| route_request(request, &app, &pending, &token));
    let (status, body) = match result {
        Ok((status, body)) => (status, body),
        Err((status, body)) => (status, body),
    };
    let _ = write_http_response(&mut stream, status, &body);
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, (u16, Value)> {
    let mut headers = Vec::with_capacity(2048);
    let mut one = [0u8; 1];
    loop {
        if headers.len() > 16 * 1024 {
            return Err((431, json!({"error":"请求头过大"})));
        }
        stream
            .read_exact(&mut one)
            .map_err(|_| (400, json!({"error":"请求不完整"})))?;
        headers.push(one[0]);
        if headers.ends_with(b"\r\n\r\n") {
            break;
        }
    }

    let text = String::from_utf8(headers).map_err(|_| (400, json!({"error":"请求头编码无效"})))?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_uppercase();
    let path = request_parts.next().unwrap_or_default().to_string();
    if method.is_empty() || path.is_empty() {
        return Err((400, json!({"error":"请求行无效"})));
    }

    let mut request_headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        request_headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
    }

    let content_length = match request_headers.get("content-length") {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| (400, json!({"error":"Content-Length 无效"})))?,
        None => 0,
    };
    if content_length > MAX_BODY_BYTES {
        return Err((413, json!({"error":"请求体超过 16 MiB 限制"})));
    }
    let mut body = vec![0u8; content_length];
    stream
        .read_exact(&mut body)
        .map_err(|_| (400, json!({"error":"请求体不完整"})))?;

    Ok(HttpRequest {
        method,
        path,
        headers: request_headers,
        body,
    })
}

fn route_request(
    request: HttpRequest,
    app: &tauri::AppHandle,
    pending: &Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    token: &str,
) -> Result<(u16, Value), (u16, Value)> {
    if request.method == "OPTIONS" {
        return Ok((204, Value::Null));
    }
    if request.method == "GET" && request.path == "/health" {
        return Ok((200, json!({"ok":true,"service":"svga-editor-mcp"})));
    }
    if request.path != "/mcp" || request.method != "POST" {
        return Err((404, json!({"error":"仅支持 POST /mcp"})));
    }

    let supplied_token = request
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| request.headers.get("x-mcp-token").map(String::as_str));
    if supplied_token != Some(token) {
        return Err((401, json!({"error":"MCP 令牌无效"})));
    }

    let rpc: RpcRequest = serde_json::from_slice(&request.body)
        .map_err(|error| (400, json!({"error":format!("JSON-RPC 请求无效：{error}")})))?;
    if rpc.jsonrpc.as_deref() != Some("2.0") {
        return Err((400, json!({"error":"只支持 JSON-RPC 2.0"})));
    }

    let is_notification = rpc.id.is_none();
    let response = match rpc.method.as_str() {
        "initialize" => json!({
            "protocolVersion": negotiate_protocol_version(&rpc.params),
            "capabilities":{"tools":{"listChanged":false}},
            "serverInfo":{"name":"svga-editor-pro","version":env!("CARGO_PKG_VERSION")}
        }),
        "notifications/initialized" | "ping" => json!({}),
        "tools/list" => json!({"tools": tool_definitions()}),
        "tools/call" => call_tool(&rpc.params, app, pending)?,
        _ => {
            return Err((
                404,
                json!({"error":format!("未知 MCP 方法：{}", rpc.method)}),
            ))
        }
    };

    if is_notification {
        Ok((202, Value::Null))
    } else {
        Ok((200, json!({"jsonrpc":"2.0","id":rpc.id,"result":response})))
    }
}

fn negotiate_protocol_version(params: &Value) -> &'static str {
    match params.get("protocolVersion").and_then(Value::as_str) {
        Some(LATEST_PROTOCOL_VERSION) => LATEST_PROTOCOL_VERSION,
        Some(DEFAULT_PROTOCOL_VERSION) => DEFAULT_PROTOCOL_VERSION,
        _ => DEFAULT_PROTOCOL_VERSION,
    }
}

fn call_tool(
    params: &Value,
    app: &tauri::AppHandle,
    pending: &Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
) -> Result<Value, (u16, Value)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| (400, json!({"error":"tools/call 缺少 name"})))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if name == "generate_and_import_image" {
        return generate_and_import_image(&arguments, app, pending);
    }
    call_frontend_tool(name, arguments, app, pending)
}

fn call_frontend_tool(
    name: &str,
    arguments: Value,
    app: &tauri::AppHandle,
    pending: &Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
) -> Result<Value, (u16, Value)> {
    let request_id = format!("mcp-{}", REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed));
    let (sender, receiver) = mpsc::channel();
    pending
        .lock()
        .map_err(|_| (500, json!({"error":"MCP 响应队列已损坏"})))?
        .insert(request_id.clone(), sender);

    if let Err(error) = app.emit(
        "mcp-request",
        json!({"requestId":request_id,"tool":name,"arguments":arguments}),
    ) {
        if let Ok(mut queue) = pending.lock() {
            queue.remove(&request_id);
        }
        return Err((500, json!({"error":format!("无法转发到编辑器：{error}")})));
    }

    match receiver.recv_timeout(REQUEST_TIMEOUT) {
        Ok(response) => Ok(response),
        Err(_) => {
            if let Ok(mut queue) = pending.lock() {
                queue.remove(&request_id);
            }
            Err((504, json!({"error":"编辑器未在 30 秒内响应 MCP 工具调用"})))
        }
    }
}

fn openai_api_key() -> Option<String> {
    std::env::var("OPENAI_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.len() <= 512)
}

fn tool_error(message: impl Into<String>) -> Value {
    json!({
        "content": [{"type":"text","text":message.into()}],
        "isError": true
    })
}

fn string_argument<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn generate_and_import_image(
    arguments: &Value,
    app: &tauri::AppHandle,
    pending: &Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
) -> Result<Value, (u16, Value)> {
    if arguments.get("confirm").and_then(Value::as_bool) != Some(true) {
        return Ok(tool_error(
            "生成图片会产生 API 费用并修改工程；请在确认后将 confirm 设为 true",
        ));
    }
    let Some(api_key) = openai_api_key() else {
        return Ok(tool_error(
            "未配置 OPENAI_API_KEY，无法生成图片；请在启动编辑器前设置环境变量",
        ));
    };
    let Some(layer_id) = string_argument(arguments, "layerId") else {
        return Ok(tool_error("缺少 layerId"));
    };
    let Some(prompt) = string_argument(arguments, "prompt") else {
        return Ok(tool_error("缺少图片提示词 prompt"));
    };
    if prompt.chars().count() > 8_000 {
        return Ok(tool_error("图片提示词不能超过 8000 个字符"));
    }

    let model = string_argument(arguments, "model").unwrap_or("gpt-image-2.5-flare");
    if !matches!(
        model,
        "gpt-image-2.5-flare" | "gpt-image-2.5-sunburst" | "gpt-image-2"
    ) {
        return Ok(tool_error(
            "model 仅支持 gpt-image-2.5-flare、gpt-image-2.5-sunburst 或 gpt-image-2",
        ));
    }
    let size = string_argument(arguments, "size").unwrap_or("1024x1024");
    if !matches!(size, "1024x1024" | "1536x1024" | "1024x1536") {
        return Ok(tool_error("size 仅支持 1024x1024、1536x1024 或 1024x1536"));
    }
    let quality = string_argument(arguments, "quality").unwrap_or("medium");
    if !matches!(quality, "low" | "medium" | "high") {
        return Ok(tool_error("quality 仅支持 low、medium 或 high"));
    }
    let background = string_argument(arguments, "background").unwrap_or("transparent");
    if !matches!(background, "transparent" | "opaque" | "auto") {
        return Ok(tool_error("background 仅支持 transparent、opaque 或 auto"));
    }
    let output_format = string_argument(arguments, "outputFormat").unwrap_or("webp");
    if !matches!(output_format, "png" | "webp") {
        return Ok(tool_error("outputFormat 仅支持 png 或 webp"));
    }

    let request = json!({
        "model": model,
        "prompt": prompt,
        "size": size,
        "quality": quality,
        "background": background,
        "output_format": output_format,
        "output_compression": 90,
        "n": 1
    });
    let generated = tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(IMAGE_GENERATION_TIMEOUT)
            .build()
            .map_err(|error| format!("无法创建 OpenAI 请求：{error}"))?;
        let response = client
            .post("https://api.openai.com/v1/images/generations")
            .bearer_auth(api_key)
            .json(&request)
            .send()
            .await
            .map_err(|error| format!("OpenAI 图片生成请求失败：{error}"))?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .map_err(|error| format!("OpenAI 响应不是有效 JSON：{error}"))?;
        if !status.is_success() {
            let message = payload
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("未知错误");
            return Err(format!(
                "OpenAI 图片生成失败（{}）：{}",
                status.as_u16(),
                message
            ));
        }
        let image_base64 = payload
            .pointer("/data/0/b64_json")
            .and_then(Value::as_str)
            .ok_or_else(|| "OpenAI 响应未包含图片数据".to_string())?;
        if image_base64.len() > MAX_GENERATED_BASE64_BYTES {
            return Err("生成图片超过 10 MiB 导入限制，请降低尺寸或质量".to_string());
        }
        let revised_prompt = payload
            .pointer("/data/0/revised_prompt")
            .and_then(Value::as_str)
            .map(str::to_string);
        Ok::<_, String>((image_base64.to_string(), revised_prompt))
    });

    let (image_base64, revised_prompt) = match generated {
        Ok(value) => value,
        Err(error) => return Ok(tool_error(error)),
    };
    let mime_type = if output_format == "png" {
        "image/png"
    } else {
        "image/webp"
    };
    let mut result = call_frontend_tool(
        "replace_layer_image",
        json!({"layerId":layer_id,"imageBase64":image_base64,"mimeType":mime_type}),
        app,
        pending,
    )?;
    if let Some(object) = result.as_object_mut() {
        object.insert(
            "generation".to_string(),
            json!({
                "model": model,
                "size": size,
                "quality": quality,
                "background": background,
                "outputFormat": output_format,
                "revisedPrompt": revised_prompt
            }),
        );
    }
    Ok(result)
}

fn tool_definitions() -> Value {
    json!([
        {"name":"get_editor_state","description":"读取当前 SVGA 工程的安全摘要（不包含图片二进制）","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"get_canvas_snapshot","description":"读取指定帧的画布截图，让模型看到当前 SVGA 合成效果；frame 从 0 开始","inputSchema":{"type":"object","properties":{"frame":{"type":"integer","minimum":0},"maxDimension":{"type":"integer","minimum":256,"maximum":2048,"default":1024}},"additionalProperties":false}},
        {"name":"get_layer_image","description":"读取指定图片图层的实际素材，包括当前替换素材","inputSchema":{"type":"object","properties":{"layerId":{"type":"string"}},"required":["layerId"],"additionalProperties":false}},
        {"name":"replace_layer_image","description":"用 PNG、JPEG 或 WebP Base64 图片替换图层素材；共享同一图片 Key 的图层会一起更新","inputSchema":{"type":"object","properties":{"layerId":{"type":"string"},"imageBase64":{"type":"string"},"mimeType":{"type":"string","enum":["image/png","image/jpeg","image/webp"]}},"required":["layerId","imageBase64","mimeType"],"additionalProperties":false}},
        {"name":"generate_and_import_image","description":"调用 OpenAI 图片生成 API 并将结果替换到指定图层；会产生 API 费用并修改工程，必须显式确认","inputSchema":{"type":"object","properties":{"layerId":{"type":"string"},"prompt":{"type":"string","minLength":1,"maxLength":8000},"model":{"type":"string","enum":["gpt-image-2.5-flare","gpt-image-2.5-sunburst","gpt-image-2"],"default":"gpt-image-2.5-flare"},"size":{"type":"string","enum":["1024x1024","1536x1024","1024x1536"],"default":"1024x1024"},"quality":{"type":"string","enum":["low","medium","high"],"default":"medium"},"background":{"type":"string","enum":["transparent","opaque","auto"],"default":"transparent"},"outputFormat":{"type":"string","enum":["png","webp"],"default":"webp"},"confirm":{"type":"boolean","description":"确认产生 API 费用并修改工程"}},"required":["layerId","prompt","confirm"],"additionalProperties":false}},
        {"name":"select_layer","description":"选中一个图层","inputSchema":{"type":"object","properties":{"layerId":{"type":"string"},"additive":{"type":"boolean"}},"required":["layerId"],"additionalProperties":false}},
        {"name":"update_layer","description":"更新图层的可编辑属性，例如名称、可见性、不透明度、时间范围、画布变换或 imageKey","inputSchema":{"type":"object","properties":{"layerId":{"type":"string"},"updates":{"type":"object"}},"required":["layerId","updates"],"additionalProperties":false}},
        {"name":"set_current_frame","description":"跳转到指定帧","inputSchema":{"type":"object","properties":{"frame":{"type":"integer","minimum":0}},"required":["frame"],"additionalProperties":false}},
        {"name":"set_playing","description":"开始或暂停预览播放","inputSchema":{"type":"object","properties":{"playing":{"type":"boolean"}},"required":["playing"],"additionalProperties":false}},
        {"name":"set_preview_background","description":"设置预览背景颜色","inputSchema":{"type":"object","properties":{"color":{"type":"string","pattern":"^#[0-9a-fA-F]{6,8}$"}},"required":["color"],"additionalProperties":false}},
        {"name":"undo","description":"撤销最近一次编辑","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"redo","description":"重做最近一次撤销","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"save_project","description":"请求编辑器保存当前工程；若目标路径尚未确定会打开保存对话框","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"focus_export","description":"打开导出面板，准备导出当前动画","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}
    ])
}

fn write_http_response(stream: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let bytes = if body.is_null() {
        Vec::new()
    } else {
        serde_json::to_vec(body)
            .unwrap_or_else(|_| b"{\"error\":\"response encoding failed\"}".to_vec())
    };
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        504 => "Gateway Timeout",
        _ => "Error",
    };
    write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nMCP-Protocol-Version: {DEFAULT_PROTOCOL_VERSION}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Authorization, Content-Type, Accept, X-MCP-Token, MCP-Protocol-Version\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", bytes.len())?;
    stream.write_all(&bytes)
}

#[tauri::command]
pub fn mcp_status(state: tauri::State<'_, McpServerState>) -> McpStatus {
    state.status.clone()
}

#[tauri::command]
pub fn mcp_respond(
    state: tauri::State<'_, McpServerState>,
    request_id: String,
    response: Value,
) -> Result<(), String> {
    respond(&state, request_id, response)
}

#[cfg(test)]
mod tests {
    use super::tool_definitions;

    #[test]
    fn tool_schema_contains_safe_editor_operations() {
        let definitions = tool_definitions();
        let tools = definitions.as_array().expect("tools array");
        assert!(tools.iter().any(|tool| tool["name"] == "get_editor_state"));
        assert!(!tools.iter().any(|tool| tool["name"] == "read_file"));
        assert!(tools.iter().any(|tool| tool["name"] == "save_project"));
        assert!(tools
            .iter()
            .any(|tool| tool["name"] == "get_canvas_snapshot"));
        assert!(tools.iter().any(|tool| tool["name"] == "get_layer_image"));
        assert!(tools
            .iter()
            .any(|tool| tool["name"] == "replace_layer_image"));
        assert!(tools
            .iter()
            .any(|tool| tool["name"] == "generate_and_import_image"));
    }
}
