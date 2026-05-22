/// Tauri Commands
/// 定义前端可调用的所有后端命令

use crate::parser;
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

/// 打开文件对话框
#[tauri::command]
pub async fn open_file_dialog(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
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
    
    rx.await
        .map_err(|e| format!("对话框错误: {}", e))
}

/// 保存文件对话框
#[tauri::command]
pub async fn save_file_dialog(
    app: tauri::AppHandle,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    
    let mut builder = app.dialog()
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
    
    rx.await
        .map_err(|e| format!("对话框错误: {}", e))
}

/// 解析 SVGA 文件（从文件路径）
#[tauri::command]
pub async fn parse_svga(
    file_path: String,
) -> Result<parser::SvgaData, String> {
    parser::parse_svga_file(&file_path)
}

/// 解析 SVGA 文件（从 base64 编码的缓冲区）
#[tauri::command]
pub async fn parse_svga_buffer(
    buffer_base64: String,
) -> Result<parser::SvgaData, String> {
    use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
    let buffer = BASE64.decode(&buffer_base64)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    parser::parse_svga_data(&buffer)
}

/// 读取文件为 base64
#[tauri::command]
pub async fn read_file(
    file_path: String,
) -> Result<String, String> {
    use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
    let buffer = std::fs::read(&file_path)
        .map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(BASE64.encode(&buffer))
}

fn is_svga_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svga"))
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
pub async fn write_file(
    file_path: String,
    data_base64: String,
) -> Result<(), String> {
    use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
    let buffer = BASE64.decode(&data_base64)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    std::fs::write(&file_path, &buffer)
        .map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
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

/// 在外部浏览器打开 URL
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("打开 URL 失败: {}", e))
}
