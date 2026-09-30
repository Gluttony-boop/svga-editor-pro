# 桌面授权客户端边界（当前策略层）

`src/core/license-policy.ts` 是可测试的纯策略层；`src/core/license-client.ts` 进一步提供可注入 transport、verifier 和 secure-storage 的客户端编排层，但默认没有网络、密钥或存储实现。两者都不是授权服务本身，也不在浏览器伪造 JWT 签名验证。它们只接收已经由未来 Rust 原生层验签、并从安全存储读取的 lease claims。

## 已固定的语义

- 小时按 3,600 秒、天按 86,400 秒计算；首次激活时间由服务端决定。
- `exp` 到达的瞬间即失效；`exp` 不能超过 `licenseExpiresAt`，刷新不能延长绝对截止时间。
- 断网时只允许继续使用仍在有效期内的已验签 lease，不赠送隐藏离线宽限。
- 回拨超过 5 分钟、错误 `kid` / `iss` / `aud` / 设备摘要 / nonce、非整数时间和非法时间范围都不开放高级能力。
- JWT 头、载荷和公钥 JWK 只接受协议定义的字段；重复字段、未知字段、负时间和超过 366 天的绝对期限都会拒绝。在线短租约最多 1 小时。
- 吊销、到期、未激活或时钟异常不会关闭编辑器、删除工程或阻止保存/迁出已有成果；这些状态只返回 `advancedEnabled: false`，未来由明确的高级功能入口使用。

## 尚未接通的生产部分

客户端编排层已经测试激活码不写入快照、缓存加载重新验签、刷新单飞、清除后旧响应不能复活、绝对期限不延长和安全存储写入失败回滚。激活、刷新、缓存加载会按用户意图串行；清除会立即取消旧代际，并在同一安全存储队列中排在迟到的 `write` 后面，避免清除完成后旧写入再次复活凭据。Rust 原生层已加入与 Worker 契约一致的 Ed25519 公钥 JWK/JWT lease 验签、HTTPS activate/refresh/clear 命令和系统 keyring 存储实现；授权公钥与 updater 的 minisign 公钥严格分离。没有完整 `license` 配置时门卫保持关闭，不会发起网络请求。正式接入仍需真实公钥、Cloudflare endpoint、账户/Secrets、安装包桌面验收和换机/退款流程。激活码、refresh token、设备标识不能放在 localStorage、IndexedDB 或普通 React 状态里。

本机 Visual Studio Build Tools 未自动加入当前 shell，但显式加载其 MSVC/Windows SDK 路径后，完整 Tauri `cargo check --locked` 已通过，16 项 Rust 单元测试也已执行通过；其中含 4 项独立 Ed25519/JWT 验签测试、固定 `jose SignJWT` 互操作样本、响应 `licenseId` 与签名 `sub` 绑定、缓存不保存可篡改 claims 副本，以及 updater 配置门卫。仓库保留只复用原生验签源码的 `tools/native-license-core` crate，在 Linux CI 重跑密码学回归；Windows CI 重跑完整原生类型检查。上述结果仍不等于真实 Cloudflare HTTPS、系统 keyring、安装/重启和跨机器流程已端到端验收。

当前 `services/licensing` 仍是 Cloudflare Workers + D1 原型，未部署、未接入付款，也没有 CORS；本策略测试不能证明客户端抗篡改，更不能声称“不可破解”。复制整份本机授权状态仍是可预期威胁，需要设备密钥/PoP 协议和售后换机流程后再评估。

## 上线前测试矩阵

当前源码和已执行单测固定了 `alg`/`typ`/`kid`、`sub`、nonce、设备摘要、`iat === nbf`、最大 1 小时 lease、最多 366 天绝对期限和严格 JSON/JWK 字段；授权 POST 禁止跟随重定向，响应要求 JSON 并限制为 64 KiB，原生激活/刷新/清除串行化。在线响应使用随机 nonce 与签名 `iat` 建立时间锚，不信任不存在于真实 Worker 响应中的 `serverNowUtc`；离线状态每次从已验签 token 重新派生。仍必须端到端覆盖：真实错误公钥与轮换、断网前后、明确吊销与网络错误区分、回拨/前跳/休眠/重启、各目标系统 secure storage 读写失败、实际并发请求，以及授权到期期间继续保存和导出已有工程。

没有生产公钥、托管域名、账户/Secrets、支付与退款流程前，产品保持开发/测试状态；不会暗中给现有功能加收费锁。
