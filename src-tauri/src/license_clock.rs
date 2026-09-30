//! 授权时间门卫。
//!
//! 系统墙上时钟可以被用户回拨，不能单独用它延长离线 lease。这个模块把签名
//! `iat`、系统时间、进程内 `Instant` 和 keyring 中的高水位组合起来：小幅回拨
//! 不会倒退有效时间，超过容差则 fail-closed。它不是防篡改时钟；删除或复制整套
//! 本机 keyring、虚拟机回滚和重启后的离线时间欺骗仍需要服务端重新签发来发现。

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

pub const CLOCK_SKEW_SECONDS: i64 = 300;
pub const CLOCK_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClockCheckpoint {
    pub schema_version: u8,
    pub license_id: String,
    pub lease_iat: i64,
    pub last_wall_utc: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockState {
    Normal,
    Suspect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockObservation {
    /// 用于到期判断的单调不回退时间；不会低于已保存的高水位。
    pub logical_now: i64,
    pub state: ClockState,
    /// 只在墙上时钟前进时更新持久化高水位。
    pub next_last_wall_utc: i64,
}

/// 进程内单调时间锚。`Instant` 不暴露真实时间，只用于阻止同一进程内回拨延长
/// lease；墙上时钟重新前进后，高水位再交给持久化 checkpoint。
#[derive(Debug)]
pub struct MonotonicAnchor {
    license_id: String,
    lease_iat: i64,
    base_utc: i64,
    started: Instant,
}

impl MonotonicAnchor {
    pub fn new(license_id: &str, lease_iat: i64, base_utc: i64) -> Self {
        Self {
            license_id: license_id.to_string(),
            lease_iat,
            base_utc,
            started: Instant::now(),
        }
    }

    pub fn matches(&self, license_id: &str, lease_iat: i64) -> bool {
        self.license_id == license_id && self.lease_iat == lease_iat
    }

    pub fn monotonic_utc(&self) -> i64 {
        self.base_utc
            .saturating_add(self.started.elapsed().as_secs().min(i64::MAX as u64) as i64)
    }
}

pub fn validate_checkpoint(
    checkpoint: &ClockCheckpoint,
    license_id: &str,
    lease_iat: i64,
) -> Result<(), &'static str> {
    if checkpoint.schema_version != CLOCK_SCHEMA_VERSION
        || checkpoint.license_id != license_id
        || checkpoint.lease_iat != lease_iat
        || checkpoint.last_wall_utc < 0
    {
        return Err("本机授权时间锚无效，请联网刷新。");
    }
    Ok(())
}

pub fn observe(
    checkpoint: &ClockCheckpoint,
    wall_utc: i64,
    monotonic_utc: i64,
) -> Result<ClockObservation, &'static str> {
    if wall_utc < 0 || monotonic_utc < 0 {
        return Err("系统时间不可用。");
    }
    validate_checkpoint(checkpoint, &checkpoint.license_id, checkpoint.lease_iat)?;
    let high_water = checkpoint.last_wall_utc.max(monotonic_utc);
    let state = if wall_utc.saturating_add(CLOCK_SKEW_SECONDS) < high_water {
        ClockState::Suspect
    } else {
        ClockState::Normal
    };
    Ok(ClockObservation {
        logical_now: wall_utc.max(high_water),
        state,
        next_last_wall_utc: checkpoint.last_wall_utc.max(wall_utc),
    })
}

pub fn checkpoint(license_id: &str, lease_iat: i64, wall_utc: i64) -> Result<ClockCheckpoint, &'static str> {
    if license_id.is_empty() || lease_iat < 0 || wall_utc < 0 {
        return Err("授权时间锚字段无效。");
    }
    Ok(ClockCheckpoint {
        schema_version: CLOCK_SCHEMA_VERSION,
        license_id: license_id.to_string(),
        lease_iat,
        last_wall_utc: wall_utc,
    })
}

/// 测试辅助：不依赖真实等待即可验证单调时钟的计算边界。
pub fn elapsed_seconds(duration: Duration) -> i64 {
    duration.as_secs().min(i64::MAX as u64) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkpoint_at(wall: i64) -> ClockCheckpoint {
        checkpoint("license", 1_000, wall).unwrap()
    }

    #[test]
    fn small_wall_clock_rollback_never_extends_logical_time() {
        let result = observe(&checkpoint_at(2_000), 1_900, 2_100).unwrap();
        assert_eq!(result.logical_now, 2_100);
        assert_eq!(result.state, ClockState::Normal);
        assert_eq!(result.next_last_wall_utc, 2_000);
    }

    #[test]
    fn large_rollback_is_fail_closed_but_keeps_monotonic_expiry_boundary() {
        let result = observe(&checkpoint_at(2_000), 1_000, 2_100).unwrap();
        assert_eq!(result.logical_now, 2_100);
        assert_eq!(result.state, ClockState::Suspect);
        assert_eq!(result.next_last_wall_utc, 2_000);
    }

    #[test]
    fn forward_wall_clock_advances_persisted_high_water() {
        let result = observe(&checkpoint_at(2_000), 2_500, 2_100).unwrap();
        assert_eq!(result.logical_now, 2_500);
        assert_eq!(result.next_last_wall_utc, 2_500);
        assert_eq!(result.state, ClockState::Normal);
    }

    #[test]
    fn checkpoint_binds_license_and_signed_issue_time() {
        let value = checkpoint_at(2_000);
        assert!(validate_checkpoint(&value, "other", 1_000).is_err());
        assert!(validate_checkpoint(&value, "license", 999).is_err());
        assert_eq!(elapsed_seconds(Duration::from_secs(9)), 9);
    }
}
