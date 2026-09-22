// 在不引入 Tauri/WebView 的独立 crate 中复用原生验签模块，供 Linux CI 运行密码学回归。
#[path = "../../../src-tauri/src/license_verify.rs"]
mod license_verify;
