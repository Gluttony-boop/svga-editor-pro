mod app_updates;
mod commands;
mod license_client;
mod license_config;
mod license_verify;
mod mcp;
mod parser;
mod project_io;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let mcp_state = mcp::start(app.handle().clone());
            log::info!(
                "MCP 服务：{} ({})",
                if mcp_state.status.enabled {
                    "已启用"
                } else {
                    "未启用"
                },
                mcp_state.status.endpoint
            );
            app.manage(mcp_state);
            #[cfg(desktop)]
            // updater 的 Config.pubkey 是必填字段；未配置发行公钥/端点时跳过插件
            // 注册，避免官方插件因空配置反序列化失败而阻断编辑器启动。
            if app_updates::is_configured(app.config()) {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_file_dialog,
            commands::save_file_dialog,
            commands::parse_svga,
            commands::parse_svga_buffer,
            commands::read_file,
            commands::get_launch_svga_file,
            commands::write_file,
            commands::write_project_file,
            commands::read_project_file,
            commands::get_platform,
            commands::get_app_version,
            commands::get_update_configuration,
            commands::get_license_configuration,
            commands::get_license_status,
            commands::activate_license,
            commands::refresh_license,
            commands::clear_license,
            commands::open_external,
            mcp::mcp_status,
            mcp::mcp_respond,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
