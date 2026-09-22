/// Tauri Commands
/// 定义前端可调用的所有后端命令
use crate::app_updates;
use crate::license_client;
use crate::license_config;
use crate::parser;
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

/// 打开文件对话框
#[tauri::command]
pub async fn open_file_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_title("打开 SVGA 文件")
        .add_filter("SVGA Files", &["svga"])
        .add_filter("Image Files", &["png", "jpg", "jpeg", "webp"])
        .add_filter("All Files", &["*"])
        .pick_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });

    rx.await.map_err(|e| format!("对话框错误: {}", e))
}

/// 保存文件对话框
#[tauri::command]
pub async fn save_file_dialog(
    app: tauri::AppHandle,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();

    let mut builder = app
        .dialog()
        .file()
        .set_title("保存文件")
        .add_filter("SVGA Files", &["svga"])
        .add_filter("PNG Files", &["png"])
        .add_filter("All Files", &["*"]);

    if let Some(name) = default_name {
        builder = builder.set_file_name(&name);
    }

    builder.save_file(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });

    rx.await.map_err(|e| format!("对话框错误: {}", e))
}

/// 解析 SVGA 文件（从文件路径）
#[tauri::command]
pub async fn parse_svga(file_path: String) -> Result<parser::SvgaData, String> {
    parser::parse_svga_file(&file_path)
}

/// 解析 SVGA 文件（从 base64 编码的缓冲区）
#[tauri::command]
pub async fn parse_svga_buffer(buffer_base64: String) -> Result<parser::SvgaData, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    let buffer = BASE64
        .decode(&buffer_base64)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    parser::parse_svga_data(&buffer)
}

/// 读取文件为 base64
#[tauri::command]
pub async fn read_file(file_path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    let buffer = std::fs::read(&file_path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(BASE64.encode(&buffer))
}

fn is_svga_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svga") || ext.eq_ignore_ascii_case("svgaproj"))
}

/// Get the .svga file path passed by the OS file association launch.
#[tauri::command]
pub fn get_launch_svga_file() -> Option<String> {
    std::env::args_os().skip(1).find_map(|arg| {
        let path = std::path::PathBuf::from(arg);
        if !is_svga_path(&path) {
            return None;
        }

        Some(
            std::fs::canonicalize(&path)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned(),
        )
    })
}

/// 写入文件（从 base64）
#[tauri::command]
pub async fn write_file(file_path: String, data_base64: String) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    let buffer = BASE64
        .decode(&data_base64)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    std::fs::write(&file_path, &buffer).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
}

/// 工程专用写入：尺寸受限，原文件只在完整写入临时文件后替换。
#[tauri::command]
pub async fn write_project_file(file_path: String, data_base64: String) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    if data_base64.len() > ((128 * 1024 * 1024 + 2) / 3) * 4 {
        return Err("工程超过 128 MiB，未写入".into());
    }
    let buffer = BASE64
        .decode(&data_base64)
        .map_err(|_| "工程数据编码无效".to_string())?;
    crate::project_io::write_project(Path::new(&file_path), &buffer)
        .map_err(|error| format!("工程写入失败：{}", error))
}

/// 读取工程时先限制大小，避免在前端校验之前分配超大 Base64 缓冲区。
#[tauri::command]
pub async fn read_project_file(file_path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use std::io::Read;
    let path = Path::new(&file_path);
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svgaproj"))
    {
        return Err("请选择 .svgaproj 工程文件".into());
    }
    let file = std::fs::File::open(path).map_err(|error| format!("读取工程失败：{}", error))?;
    let mut bytes = Vec::new();
    file.take(128 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取工程失败：{}", error))?;
    if bytes.len() > 128 * 1024 * 1024 {
        return Err("工程文件超过 128 MiB".into());
    }
    Ok(BASE64.encode(bytes))
}

/// 获取平台信息
#[tauri::command]
pub fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

/// 获取应用版本
#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.config().version.clone().unwrap_or_default()
}

/// 返回桌面 updater 的只读配置摘要；不接受前端传入端点、公钥或凭据。
#[tauri::command]
pub fn get_update_configuration(app: tauri::AppHandle) -> app_updates::UpdateConfiguration {
    app_updates::inspect_config(app.config())
}

/// 返回桌面授权配置摘要；不接受前端激活码或任何密钥字段。
#[tauri::command]
pub fn get_license_configuration(app: tauri::AppHandle) -> license_config::LicenseConfiguration {
    license_config::inspect_config(app.config())
}

/// 返回不含 token 的授权状态摘要。
#[tauri::command]
pub fn get_license_status(app: tauri::AppHandle) -> license_client::NativeLicenseStatus {
    license_client::current_status(&app)
}

/// 激活码只在原生请求层短暂存在，不返回激活码、refresh token 或 lease 内容。
#[tauri::command]
pub async fn activate_license(
    app: tauri::AppHandle,
    code: String,
) -> Result<license_client::NativeLicenseStatus, String> {
    license_client::activate(&app, code).await
}

#[tauri::command]
pub async fn refresh_license(
    app: tauri::AppHandle,
) -> Result<license_client::NativeLicenseStatus, String> {
    license_client::refresh(&app).await
}

#[tauri::command]
pub async fn clear_license() -> Result<(), String> {
    license_client::clear().await
}

/// 在外部浏览器打开 URL
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("打开 URL 失败: {}", e))
}
