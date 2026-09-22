//! 原生授权网络与系统安全存储层。
//!
//! 只有当编译配置通过 `license_config` 门卫时才会发起请求。激活码只存在于当前调用栈，
//! lease/refresh token 写入操作系统 keyring，不回传给前端；前端只得到粗粒度状态。

use crate::license_config::{client_config, LicenseClientConfig};
use crate::license_verify::{
    parse_ed25519_public_jwk, verify_lease, verify_lease_for_status, LeaseClaims, LeaseExpectation,
};
use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const SERVICE: &str = "com.svga.editor.pro.license";
const STATE_KEY: &str = "lease-state-v2";
const LEGACY_STATE_KEY: &str = "lease-state-v1";
const DEVICE_KEY: &str = "device-id-v1";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredLease {
    schema_version: u8,
    license_id: String,
    refresh_token: String,
    lease_token: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeLicenseStatus {
    pub configured: bool,
    pub state: String,
    pub reason: String,
    pub expires_at: Option<i64>,
    pub license_expires_at: Option<i64>,
    pub advanced_enabled: bool,
}

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|error| format!("系统安全存储不可用：{error}"))
}

fn is_missing(error: &keyring::Error) -> bool {
    matches!(error, keyring::Error::NoEntry)
}

fn operation_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn load_state() -> Result<Option<StoredLease>, String> {
    match entry(STATE_KEY)?.get_password() {
        Ok(value) => {
            let stored: StoredLease = serde_json::from_str(&value)
                .map_err(|_| "授权状态损坏，请重新激活。".to_string())?;
            if stored.schema_version != 2
                || !valid_license_id(&stored.license_id)
                || !is_refresh_token(&stored.refresh_token)
                || stored.lease_token.len() > 16 * 1024
            {
                return Err("授权状态版本或字段无效，请重新激活。".to_string());
            }
            Ok(Some(stored))
        }
        Err(error) if is_missing(&error) => Ok(None),
        Err(_) => Err("无法读取系统授权状态。".to_string()),
    }
}

fn save_state(value: &StoredLease) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|_| "无法序列化授权状态。".to_string())?;
    entry(STATE_KEY)?
        .set_password(&json)
        .map_err(|_| "无法写入系统授权状态。".to_string())
}

fn delete_entry(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(error) if is_missing(&error) => Ok(()),
        Err(_) => Err("无法清理系统授权状态。".to_string()),
    }
}

fn delete_state() -> Result<(), String> {
    delete_entry(STATE_KEY)?;
    delete_entry(LEGACY_STATE_KEY)
}

fn load_device_id(create_if_missing: bool) -> Result<String, String> {
    let store = entry(DEVICE_KEY)?;
    match store.get_password() {
        Ok(value) if valid_device_id(&value) => Ok(value),
        Ok(_) => Err("系统设备标识损坏，请清理桌面授权后重试。".to_string()),
        Err(error) if is_missing(&error) && create_if_missing => {
            let value = Uuid::new_v4().simple().to_string();
            store
                .set_password(&value)
                .map_err(|_| "无法写入系统设备标识。".to_string())?;
            Ok(value)
        }
        Err(error) if is_missing(&error) => Err("系统设备标识不存在，请重新激活。".to_string()),
        Err(_) => Err("无法读取系统设备标识。".to_string()),
    }
}

fn valid_device_id(value: &str) -> bool {
    (32..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn sha256_hex(value: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(value.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_license_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn nonce() -> String {
    Uuid::new_v4().simple().to_string()
}

fn now_utc() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .map_err(|_| "系统时间不可用。".to_string())
}

fn base_url(config: &LicenseClientConfig, path: &str) -> String {
    format!("{}{path}", config.endpoint)
}

async fn post_json(config: &LicenseClientConfig, path: &str, body: Value) -> Result<Value, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        // 授权端点是编译时配置；禁止跟随重定向，避免把激活码发送到另一主机。
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建授权网络客户端。".to_string())?;
    let response = client
        .post(base_url(config, path))
        .json(&body)
        .send()
        .await
        .map_err(|_| "无法连接授权服务。".to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("授权服务返回 HTTP {}。", status.as_u16()));
    }
    if !response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("application/json"))
    {
        return Err("授权服务响应格式无效。".to_string());
    }
    if response
        .content_length()
        .is_some_and(|length| length > 64 * 1024)
    {
        return Err("授权服务响应过大。".to_string());
    }
    let mut response = response;
    let mut bytes = Vec::with_capacity(4096);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "授权服务响应读取失败。".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > 64 * 1024 {
            return Err("授权服务响应过大。".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "授权服务响应格式无效。".to_string())
}

fn string_field(body: &Value, key: &str) -> Result<String, String> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("授权响应缺少 {key}。"))
}
fn verify_response(
    config: &LicenseClientConfig,
    body: &Value,
    device_hash: &str,
    nonce: &str,
) -> Result<(String, String, LeaseClaims), String> {
    let lease_token = string_field(body, "lease")?;
    let license_id = string_field(body, "licenseId")?;
    let refresh_token = string_field(body, "refreshToken")?;
    if !is_refresh_token(&refresh_token) {
        return Err("授权响应的刷新凭据格式无效。".to_string());
    }
    let public_key =
        parse_ed25519_public_jwk(&config.public_key).map_err(|_| "授权公钥无效。".to_string())?;
    let claims = verify_lease(
        &lease_token,
        &public_key,
        &LeaseExpectation {
            issuer: &config.issuer,
            audience: &config.audience,
            kid: &config.kid,
            device_hash,
            nonce: Some(nonce),
            // 随机 nonce 证明这是本次在线请求的签名响应；可信时间来自已签名 iat，
            // 不要求用户先把可能错误的本机时钟校准到服务器时间。
            now_utc: None,
            skew_seconds: 0,
        },
    )
    .map_err(|_| "授权签名或字段校验失败。".to_string())?;
    if claims.sub != license_id {
        return Err("授权响应的许可编号与签名不匹配。".to_string());
    }
    Ok((license_id, refresh_token, claims))
}

fn verify_stored_claims(
    config: &LicenseClientConfig,
    stored: &StoredLease,
    device_hash: &str,
    now_utc: Option<i64>,
) -> Result<LeaseClaims, String> {
    let public_key =
        parse_ed25519_public_jwk(&config.public_key).map_err(|_| "授权公钥无效。".to_string())?;
    let claims = verify_lease_for_status(
        &stored.lease_token,
        &public_key,
        &LeaseExpectation {
            issuer: &config.issuer,
            audience: &config.audience,
            kid: &config.kid,
            device_hash,
            nonce: None,
            now_utc,
            skew_seconds: if now_utc.is_some() { 60 } else { 0 },
        },
    )
    .map_err(|_| "本机授权凭据验签失败。".to_string())?;
    if claims.sub != stored.license_id {
        return Err("本机授权凭据身份不匹配。".to_string());
    }
    Ok(claims)
}

fn is_refresh_token(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn status(
    configured: bool,
    state: &str,
    reason: &str,
    claims: Option<&LeaseClaims>,
) -> NativeLicenseStatus {
    NativeLicenseStatus {
        configured,
        state: state.to_string(),
        reason: reason.to_string(),
        expires_at: claims.map(|value| value.exp),
        license_expires_at: claims.map(|value| value.license_expires_at),
        advanced_enabled: state == "active" || state == "offline" || state == "near-expiry",
    }
}

pub fn current_status(config: &tauri::AppHandle) -> NativeLicenseStatus {
    let config = match client_config(config.config()) {
        Ok(value) => value,
        Err(reason) => return status(false, "unlicensed", &reason, None),
    };
    let stored = match load_state() {
        Ok(value) => value,
        Err(reason) => return status(true, "storage-error", &reason, None),
    };
    let Some(stored_ref) = stored.as_ref() else {
        return status(true, "unlicensed", "尚未激活桌面授权。", None);
    };
    let now = match now_utc() {
        Ok(value) => value,
        Err(reason) => return status(true, "clock-suspect", &reason, None),
    };
    let device_hash = match load_device_id(false).map(|value| sha256_hex(&value)) {
        Ok(value) => value,
        Err(reason) => return status(true, "storage-error", &reason, None),
    };
    // 旧版本把 keyring 中的 claims 当作事实；这些字段可被复制或篡改，
    // 所有状态元数据必须来自本次验签后的 JWT。离线状态不要求历史 nonce，
    // 但仍验证设备摘要、issuer、audience、kid 和完整时间范围。
    let claims = match verify_stored_claims(&config, stored_ref, &device_hash, Some(now)) {
        Ok(value) => value,
        Err(reason) => return status(true, "signature-invalid", &reason, None),
    };
    if now < claims.iat.saturating_sub(300) {
        return status(
            true,
            "clock-suspect",
            "本机时间早于上次可信时间，需要联网校时。",
            Some(&claims),
        );
    }
    if now >= claims.license_expires_at {
        return status(true, "expired", "授权已到绝对截止时间。", Some(&claims));
    }
    if now >= claims.exp {
        return status(
            true,
            "expired",
            "短期授权凭据已到期，请联网刷新。",
            Some(&claims),
        );
    }
    let state = if claims.exp - now <= 300 {
        "near-expiry"
    } else {
        "offline"
    };
    status(
        true,
        state,
        if state == "offline" {
            "使用仍有效的离线授权凭据，不能延长绝对期限。"
        } else {
            "授权即将到期，请联网刷新。"
        },
        Some(&claims),
    )
}

pub async fn activate(
    config: &tauri::AppHandle,
    code: String,
) -> Result<NativeLicenseStatus, String> {
    let _operation = operation_lock().lock().await;
    if code.trim().is_empty() || code.len() > 512 || code.chars().any(|char| char.is_control()) {
        return Err("激活码无效。".to_string());
    }
    let settings = client_config(config.config())?;
    let device = load_device_id(true)?;
    let device_hash = sha256_hex(&device);
    let request_nonce = nonce();
    let body = post_json(
        &settings,
        "/v1/activate",
        json!({ "code": code.trim(), "deviceId": device, "nonce": request_nonce }),
    )
    .await?;
    let (license_id, refresh_token, claims) =
        verify_response(&settings, &body, &device_hash, &request_nonce)?;
    let stored = StoredLease {
        schema_version: 2,
        license_id,
        refresh_token,
        lease_token: string_field(&body, "lease")?,
    };
    save_state(&stored)?;
    Ok(status(true, "active", "授权已激活。", Some(&claims)))
}

pub async fn refresh(config: &tauri::AppHandle) -> Result<NativeLicenseStatus, String> {
    let _operation = operation_lock().lock().await;
    let settings = client_config(config.config())?;
    let mut stored = load_state()?.ok_or_else(|| "尚未激活授权。".to_string())?;
    let device = load_device_id(false)?;
    let device_hash = sha256_hex(&device);
    let previous_claims = verify_stored_claims(&settings, &stored, &device_hash, None)
        .map_err(|reason| format!("{reason}请重新激活。"))?;
    let request_nonce = nonce();
    let body = post_json(&settings, "/v1/refresh", json!({ "licenseId": stored.license_id, "deviceId": device, "refreshToken": stored.refresh_token, "nonce": request_nonce })).await?;
    let (license_id, refresh_token, claims) =
        verify_response(&settings, &body, &device_hash, &request_nonce)?;
    if license_id != stored.license_id
        || claims.license_expires_at != previous_claims.license_expires_at
    {
        return Err("刷新响应改变了授权身份或绝对期限。".to_string());
    }
    stored.refresh_token = refresh_token;
    stored.lease_token = string_field(&body, "lease")?;
    save_state(&stored)?;
    Ok(status(true, "active", "授权已刷新。", Some(&claims)))
}

pub async fn clear() -> Result<(), String> {
    let _operation = operation_lock().lock().await;
    delete_state()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../services/licensing/test/fixtures/jose-lease.json"
        ))
        .unwrap()
    }

    fn config(fixture: &Value) -> LicenseClientConfig {
        LicenseClientConfig {
            endpoint: "https://license.example.com".to_string(),
            public_key: fixture.get("publicJwk").unwrap().to_string(),
            issuer: "svga-editor-pro-licensing".to_string(),
            audience: "com.svga.editor.pro".to_string(),
            kid: "interop-key-1".to_string(),
        }
    }

    fn stored(fixture: &Value) -> StoredLease {
        StoredLease {
            schema_version: 2,
            license_id: "00000000-0000-4000-8000-000000000007".to_string(),
            refresh_token: "c".repeat(64),
            lease_token: fixture.get("token").unwrap().as_str().unwrap().to_string(),
        }
    }

    #[test]
    fn verifies_worker_response_and_binds_signed_subject() {
        let fixture = fixture();
        let response = json!({
            "lease": fixture.get("token").unwrap(),
            "licenseId": "00000000-0000-4000-8000-000000000007",
            "refreshToken": "c".repeat(64),
        });
        let (_, _, claims) = verify_response(
            &config(&fixture),
            &response,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .unwrap();
        assert_eq!(claims.iat, 1_790_000_000);

        let mut mismatched = response;
        mismatched["licenseId"] = Value::String("00000000-0000-4000-8000-000000000008".into());
        assert!(verify_response(
            &config(&fixture),
            &mismatched,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .is_err());
    }

    #[test]
    fn stored_state_contains_no_mutable_claim_copy_and_is_reverified() {
        let fixture = fixture();
        let stored = stored(&fixture);
        let serialized = serde_json::to_string(&stored).unwrap();
        assert!(!serialized.contains("licenseExpiresAt"));
        let claims = verify_stored_claims(
            &config(&fixture),
            &stored,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            Some(1_790_000_000),
        )
        .unwrap();
        assert_eq!(claims.license_expires_at, 1_790_007_200);

        let mut mismatched = stored;
        mismatched.license_id = "00000000-0000-4000-8000-000000000008".to_string();
        assert!(verify_stored_claims(
            &config(&fixture),
            &mismatched,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            Some(1_790_000_000),
        )
        .is_err());
    }
}
