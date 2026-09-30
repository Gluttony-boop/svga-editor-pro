// 在不引入 Tauri/WebView 的独立 crate 中复用原生验签模块，供 Linux CI 运行密码学回归。
#[path = "../../../src-tauri/src/license_verify.rs"]
mod license_verify;

// 复用授权时间门卫的纯策略测试；桌面 crate 还会把它接入 keyring 与 Tauri 命令。
#[path = "../../../src-tauri/src/license_clock.rs"]
mod license_clock;
