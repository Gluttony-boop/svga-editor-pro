-- 首次激活的设备与绝对到期时间在单条 UPDATE 中写入，重试不能延长时长。
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL CHECK (plan = 'pro'),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 3600 AND 31622400),
  lease_seconds INTEGER NOT NULL CHECK (lease_seconds BETWEEN 60 AND 3600),
  created_at INTEGER NOT NULL,
  device_hash TEXT,
  activated_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  CHECK ((device_hash IS NULL AND activated_at IS NULL AND expires_at IS NULL)
    OR (device_hash IS NOT NULL AND activated_at IS NOT NULL AND expires_at = activated_at + duration_seconds))
);
