//! 原生授权 lease 验签核心。
//!
//! 授权服务使用独立的 Ed25519 JWK。这里不能复用 updater 的 minisign 公钥，
//! 也不能仅解码 JWT；只有通过签名、字段、设备、挑战和时间边界的凭据才可进入
//! 上层授权状态机。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fmt;

const MAX_LEASE_SECONDS: i64 = 3_600;
const MAX_TOKEN_BYTES: usize = 16 * 1024;
const MAX_JWT_PART_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeaseClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub iat: i64,
    pub nbf: i64,
    pub exp: i64,
    pub license_expires_at: i64,
    pub device_hash: String,
    pub nonce: String,
    pub plan: String,
}

#[derive(Debug, Clone)]
pub struct LeaseExpectation<'a> {
    pub issuer: &'a str,
    pub audience: &'a str,
    pub kid: &'a str,
    pub device_hash: &'a str,
    pub nonce: Option<&'a str>,
    /// 在线响应依靠随机 nonce 与签名 iat 建立时间锚，可为 None；离线状态必须传本机 UTC。
    pub now_utc: Option<i64>,
    pub skew_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    InvalidToken,
    InvalidPublicKey,
    InvalidHeader,
    InvalidSignature,
    ClaimMismatch(&'static str),
    Time(&'static str),
}

impl fmt::Display for VerifyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for VerifyError {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicJwk {
    kty: String,
    crv: String,
    x: String,
    #[serde(default)]
    alg: Option<String>,
}

/// 配置中的公钥是 JSON 编码的 RFC 8037 Ed25519 公钥 JWK。
///
/// 该值只允许公钥字段，不接受私钥 `d`，不接受 updater 的 minisign 文本，
/// 也不接受带填充的 Base64URL，以免两套密钥协议被误接。
pub fn parse_ed25519_public_jwk(value: &str) -> Result<VerifyingKey, VerifyError> {
    if value.len() > 4 * 1024 {
        return Err(VerifyError::InvalidPublicKey);
    }
    reject_duplicate_object_keys(value.as_bytes()).map_err(|_| VerifyError::InvalidPublicKey)?;
    let jwk_value: Value =
        serde_json::from_str(value).map_err(|_| VerifyError::InvalidPublicKey)?;
    let object = jwk_value.as_object().ok_or(VerifyError::InvalidPublicKey)?;
    if object.contains_key("d") {
        return Err(VerifyError::InvalidPublicKey);
    }
    let jwk: PublicJwk =
        serde_json::from_value(jwk_value).map_err(|_| VerifyError::InvalidPublicKey)?;
    if jwk.kty != "OKP"
        || jwk.crv != "Ed25519"
        || jwk.alg.as_deref().is_some_and(|alg| alg != "EdDSA")
    {
        return Err(VerifyError::InvalidPublicKey);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(jwk.x.as_bytes())
        .map_err(|_| VerifyError::InvalidPublicKey)?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| VerifyError::InvalidPublicKey)?;
    VerifyingKey::from_bytes(&key).map_err(|_| VerifyError::InvalidPublicKey)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JwtHeader {
    alg: String,
    typ: String,
    kid: String,
}

/// serde 默认会覆盖重复 JSON 键。JWT header/payload 是安全边界的一部分，
/// 因此先用 MapAccess 检查顶层对象不存在重复键，再做严格类型反序列化。
fn reject_duplicate_object_keys(bytes: &[u8]) -> Result<(), VerifyError> {
    struct ObjectVisitor;

    impl<'de> Visitor<'de> for ObjectVisitor {
        type Value = ();

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("JSON object")
        }

        fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
        where
            M: MapAccess<'de>,
        {
            let mut keys = HashSet::new();
            while let Some(key) = map.next_key::<String>()? {
                if !keys.insert(key) {
                    return Err(de::Error::custom("duplicate JSON key"));
                }
                let _: Value = map.next_value()?;
            }
            Ok(())
        }
    }

    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    de::Deserializer::deserialize_map(&mut deserializer, ObjectVisitor)
        .map_err(|_| VerifyError::InvalidToken)?;
    deserializer.end().map_err(|_| VerifyError::InvalidToken)
}

fn decode_json_part(encoded: &str, invalid: VerifyError) -> Result<Vec<u8>, VerifyError> {
    if encoded.is_empty() || encoded.len() > MAX_JWT_PART_BYTES || encoded.contains('=') {
        return Err(invalid);
    }
    URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid)
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

fn valid_hex(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn verify_lease_inner(
    token: &str,
    public_key: &VerifyingKey,
    expected: &LeaseExpectation<'_>,
    allow_expired: bool,
) -> Result<LeaseClaims, VerifyError> {
    if token.len() > MAX_TOKEN_BYTES
        || expected.now_utc.is_some_and(|now| now < 0)
        || expected.skew_seconds < 0
        || expected.skew_seconds > 300
    {
        return Err(VerifyError::InvalidToken);
    }
    let mut parts = token.split('.');
    let header_encoded = parts.next().ok_or(VerifyError::InvalidToken)?;
    let payload_encoded = parts.next().ok_or(VerifyError::InvalidToken)?;
    let signature_encoded = parts.next().ok_or(VerifyError::InvalidToken)?;
    if parts.next().is_some() {
        return Err(VerifyError::InvalidToken);
    }

    let header_bytes = decode_json_part(header_encoded, VerifyError::InvalidHeader)?;
    reject_duplicate_object_keys(&header_bytes).map_err(|_| VerifyError::InvalidHeader)?;
    let header: JwtHeader =
        serde_json::from_slice(&header_bytes).map_err(|_| VerifyError::InvalidHeader)?;
    if header.alg != "EdDSA" || header.typ != "JWT" || header.kid != expected.kid {
        return Err(VerifyError::InvalidHeader);
    }

    let payload_bytes = decode_json_part(payload_encoded, VerifyError::InvalidToken)?;
    reject_duplicate_object_keys(&payload_bytes)?;
    if signature_encoded.is_empty()
        || signature_encoded.len() > MAX_JWT_PART_BYTES
        || signature_encoded.contains('=')
    {
        return Err(VerifyError::InvalidSignature);
    }
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature_encoded)
        .map_err(|_| VerifyError::InvalidSignature)?;
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| VerifyError::InvalidSignature)?;
    let signing_input = format!("{header_encoded}.{payload_encoded}");
    public_key
        .verify(signing_input.as_bytes(), &signature)
        .map_err(|_| VerifyError::InvalidSignature)?;

    let claims: LeaseClaims =
        serde_json::from_slice(&payload_bytes).map_err(|_| VerifyError::InvalidToken)?;
    if claims.iss != expected.issuer {
        return Err(VerifyError::ClaimMismatch("issuer"));
    }
    if claims.aud != expected.audience {
        return Err(VerifyError::ClaimMismatch("audience"));
    }
    if !valid_license_id(&claims.sub) {
        return Err(VerifyError::ClaimMismatch("subject"));
    }
    if !valid_hex(&claims.device_hash, 64, 64) || claims.device_hash != expected.device_hash {
        return Err(VerifyError::ClaimMismatch("device"));
    }
    if !valid_hex(&claims.nonce, 32, 128)
        || expected.nonce.is_some_and(|nonce| claims.nonce != nonce)
    {
        return Err(VerifyError::ClaimMismatch("nonce"));
    }
    if claims.plan != "pro" {
        return Err(VerifyError::ClaimMismatch("plan"));
    }
    if claims.iat < 0
        || claims.nbf != claims.iat
        || claims.exp <= claims.iat
        || claims.exp > claims.license_expires_at
    {
        return Err(VerifyError::Time("range"));
    }
    if let Some(now_utc) = expected.now_utc {
        let latest_accepted_iat = now_utc
            .checked_add(expected.skew_seconds)
            .ok_or(VerifyError::Time("overflow"))?;
        if claims.iat > latest_accepted_iat {
            return Err(VerifyError::Time("not-yet-valid"));
        }
        if !allow_expired && claims.exp <= now_utc {
            return Err(VerifyError::Time("expired"));
        }
    }
    if claims.exp - claims.iat > MAX_LEASE_SECONDS {
        return Err(VerifyError::Time("lease-too-long"));
    }
    Ok(claims)
}

/// 验证 JWT header、Ed25519 签名、固定 claims 和短租约/绝对到期边界。
pub fn verify_lease(
    token: &str,
    public_key: &VerifyingKey,
    expected: &LeaseExpectation<'_>,
) -> Result<LeaseClaims, VerifyError> {
    verify_lease_inner(token, public_key, expected, false)
}

/// 供原生状态页读取已过期凭据的已签名字段；不会开放任何高级能力。
/// 调用方必须自行将返回值映射为 expired，而不能把它当作有效 lease。
pub(crate) fn verify_lease_for_status(
    token: &str,
    public_key: &VerifyingKey,
    expected: &LeaseExpectation<'_>,
) -> Result<LeaseClaims, VerifyError> {
    verify_lease_inner(token, public_key, expected, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn fixture() -> (String, String) {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let public = serde_json::json!({
            "kty": "OKP",
            "crv": "Ed25519",
            "x": URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes())
        })
        .to_string();
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","typ":"JWT","kid":"current"}"#);
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "iss":"issuer","aud":"audience","sub":"00000000-0000-4000-8000-000000000007",
                "iat":100,"nbf":100,"exp":1000,"licenseExpiresAt":2000,
                "deviceHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","nonce":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","plan":"pro"
            }))
            .unwrap(),
        );
        let input = format!("{header}.{payload}");
        let token = format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(signing.sign(input.as_bytes()).to_bytes())
        );
        (public, token)
    }

    fn expectation(now_utc: i64) -> LeaseExpectation<'static> {
        LeaseExpectation {
            issuer: "issuer",
            audience: "audience",
            kid: "current",
            device_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            nonce: Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            now_utc: Some(now_utc),
            skew_seconds: 0,
        }
    }

    #[test]
    fn verifies_real_ed25519_jwk_and_claims() {
        let (public, token) = fixture();
        let key = parse_ed25519_public_jwk(&public).unwrap();
        let claims = verify_lease(&token, &key, &expectation(500)).unwrap();
        assert_eq!(claims.exp, 1000);
        assert!(claims.sub.ends_with('7'));
    }

    #[test]
    fn verifies_token_generated_by_jose_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../services/licensing/test/fixtures/jose-lease.json"
        ))
        .unwrap();
        let public = fixture.get("publicJwk").unwrap().to_string();
        let key = parse_ed25519_public_jwk(&public).unwrap();
        let expected = fixture.get("expectation").unwrap();
        let claims = verify_lease(
            fixture.get("token").unwrap().as_str().unwrap(),
            &key,
            &LeaseExpectation {
                issuer: "svga-editor-pro-licensing",
                audience: "com.svga.editor.pro",
                kid: expected.get("kid").unwrap().as_str().unwrap(),
                device_hash: expected.get("deviceHash").unwrap().as_str().unwrap(),
                nonce: Some(expected.get("nonce").unwrap().as_str().unwrap()),
                now_utc: Some(expected.get("now").unwrap().as_i64().unwrap()),
                skew_seconds: 0,
            },
        )
        .unwrap();
        assert_eq!(claims.sub, "00000000-0000-4000-8000-000000000007");
        assert_eq!(claims.exp, 1_790_000_900);
    }

    #[test]
    fn rejects_header_kid_signature_claim_and_time_tampering() {
        let (public, token) = fixture();
        let key = parse_ed25519_public_jwk(&public).unwrap();
        for expectation in [
            LeaseExpectation {
                kid: "other",
                ..expectation(500)
            },
            LeaseExpectation {
                nonce: Some("cccccccccccccccccccccccccccccccccccc"),
                ..expectation(500)
            },
            LeaseExpectation {
                now_utc: Some(1000),
                ..expectation(1000)
            },
        ] {
            assert!(verify_lease(&token, &key, &expectation).is_err());
        }
        let mut bytes = token.into_bytes();
        *bytes.last_mut().unwrap() = b'x';
        assert_eq!(
            verify_lease(
                std::str::from_utf8(&bytes).unwrap(),
                &key,
                &expectation(500)
            )
            .unwrap_err(),
            VerifyError::InvalidSignature
        );
    }

    #[test]
    fn rejects_private_keys_unknown_fields_and_duplicate_claims() {
        let (public, token) = fixture();
        assert!(parse_ed25519_public_jwk("PRIVATE KEY").is_err());
        let mut object: Value = serde_json::from_str(&public).unwrap();
        object["d"] = Value::String("private".into());
        assert!(parse_ed25519_public_jwk(&object.to_string()).is_err());
        let key = parse_ed25519_public_jwk(&public).unwrap();
        let mut parts = token.split('.');
        let header = parts.next().unwrap();
        let payload = parts.next().unwrap();
        let signature = parts.next().unwrap();
        assert!(parts.next().is_none());
        let duplicate = URL_SAFE_NO_PAD.encode(br#"{"iss":"issuer","iss":"issuer","aud":"audience","sub":"00000000-0000-4000-8000-000000000007","iat":100,"nbf":100,"exp":1000,"licenseExpiresAt":2000,"deviceHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","nonce":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","plan":"pro"}"#);
        let input = format!("{header}.{duplicate}");
        let signing = SigningKey::from_bytes(&[7; 32]);
        let duplicate_token = format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(signing.sign(input.as_bytes()).to_bytes())
        );
        assert_eq!(
            verify_lease(&duplicate_token, &key, &expectation(500)).unwrap_err(),
            VerifyError::InvalidToken
        );
        assert!(verify_lease(
            &format!("{header}.{payload}.{signature}="),
            &key,
            &expectation(500)
        )
        .is_err());
    }
}
