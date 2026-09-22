//! 桌面自动更新的原生配置门卫。
//!
//! Tauri updater 的 `Config.pubkey` 是必填字段。即使没有配置 `plugins.updater`，
//! 直接注册官方插件也会在初始化时因为反序列化空对象而让整个应用启动失败。因此
//! 这里先检查编译进应用的配置，只有完整且 fail-closed 的配置才注册插件。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use serde_json::Value;
use tauri::utils::config::Config as TauriConfig;

/// 前端可见的更新配置摘要。
///
/// 这里只返回是否已启用、原因和当前版本，绝不回传公钥、端点、请求头或任何凭据。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfiguration {
    pub configured: bool,
    pub reason: String,
    pub current_version: String,
}

const READY_REASON: &str = "已启用签名桌面更新。";

/// 从 Tauri 编译配置中读取 updater 摘要。
pub fn inspect_config(config: &TauriConfig) -> UpdateConfiguration {
    let current_version = config
        .version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let updater = config.plugins.0.get("updater");
    inspect_value(updater, current_version)
}

/// 检查插件配置，并返回不会暴露敏感字段的状态。
///
/// 该函数故意只接受已经编译到应用内的 JSON，不接受前端传入的公钥或端点。
pub fn inspect_value(updater: Option<&Value>, current_version: String) -> UpdateConfiguration {
    let reason = match updater {
        None => "未配置 updater；请先配置签名公钥和 HTTPS 更新端点。".to_string(),
        Some(value) => match validate_value(value) {
            Ok(()) => READY_REASON.to_string(),
            Err(reason) => reason.to_string(),
        },
    };

    UpdateConfiguration {
        configured: reason == READY_REASON,
        reason,
        current_version,
    }
}

/// 判断是否允许注册 updater 插件。
pub fn is_configured(config: &TauriConfig) -> bool {
    inspect_config(config).configured
}

/// 对 `plugins.updater` 做应用侧的更严格校验。
///
/// 官方插件本身会校验 URL 的 scheme，但允许空公钥、允许 `allowDowngrades`，并且在
/// debug 构建下会放行非 HTTPS URL。商业发行版不能依赖这些宽松默认值，所以这里在
/// 注册插件前统一拒绝：空/缺字段、非 HTTPS、URL 凭据或查询参数、危险 TLS 开关、
/// 降级更新，以及未开启签名版本绑定。
pub fn validate_value(updater: &Value) -> Result<(), &'static str> {
    let object = updater
        .as_object()
        .ok_or("updater 配置必须是对象，已禁用自动更新。")?;

    let pubkey = object
        .get("pubkey")
        .and_then(Value::as_str)
        .ok_or("updater.pubkey 缺失，已禁用自动更新。")?;
    if !looks_like_public_key(pubkey) {
        return Err("updater.pubkey 不是可识别的 minisign 公钥，已禁用自动更新。");
    }

    let endpoints = object
        .get("endpoints")
        .and_then(Value::as_array)
        .ok_or("updater.endpoints 缺失，已禁用自动更新。")?;
    if endpoints.is_empty() {
        return Err("updater.endpoints 为空，已禁用自动更新。");
    }
    for endpoint in endpoints {
        let endpoint = endpoint
            .as_str()
            .ok_or("updater.endpoints 含有无效端点，已禁用自动更新。")?;
        if !is_static_https_endpoint(endpoint) {
            return Err("更新端点必须是无凭据、无查询参数的静态 HTTPS URL，已禁用自动更新。");
        }
    }

    // updater Config 不应携带账号、token 或自定义认证头；未知字段也不能成为
    // “看起来已配置”但实际上绕过发布约束的后门。
    if object.contains_key("credentials") || object.contains_key("headers") {
        return Err("updater 不允许内置凭据或认证请求头，已禁用自动更新。");
    }
    if contains_sensitive_key(updater) {
        return Err("updater 配置疑似包含私钥或 token，已禁用自动更新。");
    }

    if object.get("requireSignedVersion").and_then(Value::as_bool) != Some(true) {
        return Err("updater.requireSignedVersion 必须为 true，已禁用自动更新。");
    }

    for field in [
        "allowDowngrades",
        "dangerousInsecureTransportProtocol",
        "dangerousAcceptInvalidCerts",
        "dangerousAcceptInvalidHostnames",
    ] {
        if let Some(value) = object.get(field) {
            if !value.is_boolean() {
                return Err("updater 安全开关必须是布尔值，已禁用自动更新。");
            }
            if value.as_bool() == Some(true) {
                return Err("updater 启用了不安全选项，已禁用自动更新。");
            }
        }
    }

    if let Some(windows) = object.get("windows") {
        validate_windows_config(windows)?;
    }

    Ok(())
}

fn contains_sensitive_key(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let key = key.to_ascii_lowercase();
            key.contains("private")
                || key.contains("secret")
                || key.contains("token")
                || key.contains("credential")
                || key.contains("authorization")
                || key.contains("header")
                || contains_sensitive_key(value)
        }),
        Value::Array(values) => values.iter().any(contains_sensitive_key),
        _ => false,
    }
}

fn validate_windows_config(windows: &Value) -> Result<(), &'static str> {
    if windows.is_null() {
        return Ok(());
    }
    let Some(object) = windows.as_object() else {
        return Err("updater.windows 必须是对象，已禁用自动更新。");
    };
    for key in ["installerArgs", "installer-args"] {
        if let Some(args) = object.get(key) {
            let Some(args) = args.as_array() else {
                return Err("updater.windows.installerArgs 必须是字符串数组，已禁用自动更新。");
            };
            if args.iter().any(|arg| !arg.is_string()) {
                return Err("updater.windows.installerArgs 必须是字符串数组，已禁用自动更新。");
            }
        }
    }
    for key in ["installMode", "install-mode"] {
        if let Some(mode) = object.get(key) {
            let Some(mode) = mode.as_str() else {
                return Err("updater.windows.installMode 必须是字符串，已禁用自动更新。");
            };
            if !matches!(mode, "basicUi" | "quiet" | "passive") {
                return Err("updater.windows.installMode 无效，已禁用自动更新。");
            }
        }
    }
    Ok(())
}

/// Tauri 配置里的公钥是“整个 minisign `.pub` 文本”的外层 base64，而不是文件路径。
/// 这里只做格式和敏感内容的基本门卫，真正的验签仍由官方 updater 完成。
fn looks_like_public_key(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed != value
        || trimmed.len() > 4096
        || trimmed.chars().any(char::is_whitespace)
        || trimmed.to_ascii_lowercase().contains("private key")
        || trimmed.to_ascii_lowercase().contains("secret key")
    {
        return false;
    }

    let Ok(decoded) = BASE64.decode(trimmed) else {
        return false;
    };
    let Ok(decoded) = std::str::from_utf8(&decoded) else {
        return false;
    };
    let mut lines = decoded.lines();
    let Some(comment) = lines.next() else {
        return false;
    };
    let Some(payload) = lines.next() else {
        return false;
    };
    comment.starts_with("untrusted comment: minisign public key:")
        && payload.starts_with("RW")
        && payload.len() >= 40
        && payload
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

/// 更新清单必须是静态 HTTPS 地址，不把 token、用户名、密码放进 URL。
fn is_static_https_endpoint(value: &str) -> bool {
    let endpoint = value.trim();
    if endpoint != value
        || endpoint.contains("{{")
        || endpoint.contains("}}")
        || !has_valid_percent_encoding(endpoint)
    {
        return false;
    }

    // 复用 Tauri 已经使用的 URL 解析器，避免仅靠字符串检查把坏 URL 交给插件，
    // 从而在启动阶段触发 Config 反序列化错误。查询串/片段和 URL credentials 均拒绝。
    let Ok(parsed) = tauri::Url::parse(endpoint) else {
        return false;
    };
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return false;
    }

    // 静态清单不应把 access token、密码等拼进路径；这是 fail-closed 的额外保护。
    !endpoint.to_ascii_lowercase().contains("token")
        && !endpoint.to_ascii_lowercase().contains("password")
        && !endpoint.to_ascii_lowercase().contains("secret")
        && !endpoint.to_ascii_lowercase().contains("apikey")
}

fn has_valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::{inspect_value, is_static_https_endpoint, looks_like_public_key, validate_value};
    use serde_json::{json, Value};

    const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEUwNDRGMjkwRjg2MDhCRDAKUldUUWkyRDRrUEpFNEQ4SmdwcU5PaXl6R2ZRUUNvUnhIaVkwVUltV0NMaEx6VTkrWVhpT0ZqeEEK";

    fn config(extra: serde_json::Value) -> serde_json::Value {
        let mut value = json!({
            "pubkey": KEY,
            "endpoints": ["https://updates.example.com/latest.json"],
            "requireSignedVersion": true,
        });
        if let (Some(base), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
        value
    }

    #[test]
    fn empty_config_is_disabled_without_panicking() {
        let result = inspect_value(Some(&json!({})), "2.0.0".to_string());
        assert!(!result.configured);
        assert!(result.reason.contains("pubkey"));
        assert_eq!(result.current_version, "2.0.0");
    }

    #[test]
    fn missing_plugin_is_disabled() {
        let result = inspect_value(None, "2.0.0".to_string());
        assert!(!result.configured);
        assert!(result.reason.contains("HTTPS"));
    }

    #[test]
    fn complete_config_is_enabled() {
        let value = config(json!({}));
        let result = inspect_value(Some(&value), "2.0.0".to_string());
        assert!(result.configured);
        assert_eq!(result.reason, "已启用签名桌面更新。");

        let wire = serde_json::to_value(result).expect("summary serializes");
        assert_eq!(
            wire.as_object().map(|object| object.len()),
            Some(3),
            "命令只暴露三个稳定字段"
        );
        assert_eq!(
            wire.get("currentVersion").and_then(Value::as_str),
            Some("2.0.0")
        );
        assert!(wire.get("pubkey").is_none());
        assert!(wire.get("endpoints").is_none());
    }

    #[test]
    fn security_requirements_are_fail_closed() {
        for patch in [
            json!({"requireSignedVersion": false}),
            json!({"allowDowngrades": true}),
            json!({"dangerousInsecureTransportProtocol": true}),
            json!({"dangerousAcceptInvalidCerts": true}),
            json!({"dangerousAcceptInvalidHostnames": true}),
            json!({"allowDowngrades": "false"}),
            json!({"dangerousAcceptInvalidCerts": "false"}),
            json!({"endpoints": ["http://updates.example.com/latest.json"]}),
            json!({"endpoints": ["https://updates.example.com/latest.json?token=abc"]}),
            json!({"credentials": {"token": "secret"}}),
            json!({"privateKey": "not-for-client"}),
            json!({"windows": {"metadata": {"authorization": "secret"}}}),
            json!({"windows": "not-an-object"}),
            json!({"windows": {"installerArgs": [1]}}),
            json!({"windows": {"installMode": "unsupported"}}),
            json!({"pubkey": "private key"}),
        ] {
            assert!(validate_value(&config(patch)).is_err());
        }
    }

    #[test]
    fn key_and_endpoint_basic_shapes_are_checked() {
        assert!(looks_like_public_key(KEY));
        assert!(!looks_like_public_key("not-a-public-key"));
        assert!(!looks_like_public_key(&format!(" {KEY}")));
        assert!(!looks_like_public_key(
            "RWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        ));
        assert!(is_static_https_endpoint(
            "https://updates.example.com/latest.json"
        ));
        assert!(!is_static_https_endpoint(
            "https://user:pass@updates.example.com/latest.json"
        ));
        assert!(!is_static_https_endpoint(
            "https://updates.example.com/latest.json?token=x"
        ));
        assert!(!is_static_https_endpoint(
            "https://updates.example.com/{{target}}.json"
        ));
        assert!(!is_static_https_endpoint("https://updates.example.com/%zz"));
    }
}
