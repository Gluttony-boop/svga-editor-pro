//! 桌面授权配置门卫。
//!
//! 这里只读取编译进应用的摘要配置，不接受前端激活码、端点、公钥或设备标识。
//! 原生验签、安全存储和网络客户端配置齐全前，始终返回未配置。

use reqwest::Url;
use serde::Serialize;
use serde_json::Value;
use tauri::utils::config::Config as TauriConfig;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LicenseConfiguration {
    pub configured: bool,
    pub reason: String,
    pub current_version: String,
}

#[derive(Debug, Clone)]
pub struct LicenseClientConfig {
    pub endpoint: String,
    pub public_key: String,
    pub issuer: String,
    pub audience: String,
    pub kid: String,
}

pub fn inspect_config(config: &TauriConfig) -> LicenseConfiguration {
    let current_version = config
        .version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    inspect_value(config.plugins.0.get("license"), current_version)
}

fn inspect_value(license: Option<&Value>, current_version: String) -> LicenseConfiguration {
    let (configured, reason) = match license {
        None => (false, "桌面授权服务尚未配置；不会发送激活码。".to_string()),
        Some(value) => match client_config_value(value) {
            Ok(_) => (
                true,
                "授权配置已存在；使用受保护的原生请求和系统安全存储。".to_string(),
            ),
            Err(reason) => (false, reason.to_string()),
        },
    };
    LicenseConfiguration {
        configured,
        reason,
        current_version,
    }
}

pub fn client_config(config: &TauriConfig) -> Result<LicenseClientConfig, String> {
    let value = config
        .plugins
        .0
        .get("license")
        .ok_or_else(|| "桌面授权服务尚未配置；不会发送激活码。".to_string())?;
    client_config_value(value).map_err(str::to_owned)
}

fn client_config_value(value: &Value) -> Result<LicenseClientConfig, &'static str> {
    validate_value(value)?;
    let object = value
        .as_object()
        .ok_or("license 配置不是对象，已禁用授权。")?;
    Ok(LicenseClientConfig {
        endpoint: object
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap()
            .trim_end_matches('/')
            .to_string(),
        public_key: object
            .get("publicKey")
            .and_then(Value::as_str)
            .unwrap()
            .to_string(),
        issuer: object
            .get("issuer")
            .and_then(Value::as_str)
            .unwrap()
            .to_string(),
        audience: object
            .get("audience")
            .and_then(Value::as_str)
            .unwrap()
            .to_string(),
        kid: object
            .get("kid")
            .and_then(Value::as_str)
            .unwrap()
            .to_string(),
    })
}

fn validate_value(value: &Value) -> Result<(), &'static str> {
    let object = value
        .as_object()
        .ok_or("license 配置不是对象，已禁用授权。")?;
    let endpoint = object
        .get("endpoint")
        .and_then(Value::as_str)
        .ok_or("license.endpoint 缺失，已禁用授权。")?;
    let parsed_endpoint = Url::parse(endpoint).ok();
    if parsed_endpoint.as_ref().map_or(true, |url| {
        url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
    }) || endpoint.chars().any(char::is_whitespace)
    {
        return Err("授权端点必须是无凭据、无查询参数的 HTTPS 地址，已禁用授权。");
    }
    let public_key = object
        .get("publicKey")
        .and_then(Value::as_str)
        .ok_or("license.publicKey 缺失，已禁用授权。")?;
    if public_key.trim().is_empty() || public_key.len() > 4096 {
        return Err("授权公钥无效，已禁用授权。");
    }
    crate::license_verify::parse_ed25519_public_jwk(public_key)
        .map_err(|_| "授权公钥无效，已禁用授权。")?;
    let issuer = object
        .get("issuer")
        .and_then(Value::as_str)
        .ok_or("license.issuer 缺失，已禁用授权。")?;
    let audience = object
        .get("audience")
        .and_then(Value::as_str)
        .ok_or("license.audience 缺失，已禁用授权。")?;
    if issuer != "svga-editor-pro-licensing" || audience != "com.svga.editor.pro" {
        return Err("授权 issuer/audience 与桌面产品协议不匹配，已禁用授权。");
    }
    let kid = object
        .get("kid")
        .and_then(Value::as_str)
        .ok_or("license.kid 缺失，已禁用授权。")?;
    if kid.is_empty()
        || kid.len() > 48
        || !kid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("授权 kid 无效，已禁用授权。");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_config_is_safe_and_does_not_expose_secrets() {
        let config = inspect_value(None, "2.0.0".to_string());
        assert!(!config.configured);
        assert!(config.reason.contains("不会发送"));
    }

    #[test]
    fn config_is_ready_only_after_real_url_and_jwk_validation() {
        let value = json!({
            "endpoint": "https://license.example.com",
            "publicKey": r#"{"kty":"OKP","crv":"Ed25519","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}"#,
            "issuer": "svga-editor-pro-licensing",
            "audience": "com.svga.editor.pro",
            "kid": "current"
        });
        let config = inspect_value(Some(&value), "2.0.0".to_string());
        assert!(config.configured);
        assert!(config.reason.contains("系统安全存储"));
    }

    #[test]
    fn unsafe_endpoint_and_private_key_are_rejected() {
        assert!(validate_value(&json!({ "endpoint": "http://license.example.com", "publicKey": "public", "issuer": "i", "audience": "a" })).is_err());
        assert!(validate_value(&json!({ "endpoint": "https://license.example.com?token=x", "publicKey": "public", "issuer": "i", "audience": "a" })).is_err());
        assert!(validate_value(&json!({ "endpoint": "https://license.example.com", "publicKey": "private key", "issuer": "i", "audience": "a" })).is_err());
    }
}
