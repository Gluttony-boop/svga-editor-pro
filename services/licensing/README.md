# 授权服务原型（尚未上线）

这是桌面商业授权的控制面原型，与现有编辑器隔离。不会上传设计文件，不会自动部署，不会自动开启收费限制。当前 JS 校验器只用于协议回归，不是桌面防破解边界；原生验签、受保护的设备凭据、可信时间策略、真实网络及付费流程验收完成前，不应对外宣称商业授权已可用。

## 已实现

- 管理员发码：正整数小时/天，1 小时至 366 天；单设备；激活码采用 160 位随机值，数据库只存 SHA-256。
- 首次成功激活按服务端 UTC 秒起算，单条 D1 SQL 原子写入设备、起点和绝对到期时间。并发不同设备只有一个成功，同设备重复激活不延长期限。
- `jose` Ed25519 JWT 短期授权：默认 900 秒，可设 60–3600 秒，且永不超过授权绝对到期时间。
- 独立 HMAC 刷新凭据，响应绑定请求 nonce；同设备重试得到相同刷新 handle，刷新不会重新开始计时。
- 吊销后停止签发；已取得的离线凭据最多继续有效到其既有 `exp`，无法离线即时撤销。
- 限制正文大小、明确认证/格式错误、秘密不回显、未配置私钥或限流器时失败关闭。

## 本地验证

独立使用 Node.js 22+。根目录编辑器仍可使用其原有 Node.js 版本。

```powershell
npm ci --prefix services/licensing
npm test --prefix services/licensing
npm run build --prefix services/licensing
```

测试使用官方 Miniflare 的真实本地 D1 存储和临时 Ed25519 密钥。不会连接生产数据库、发放生产激活码或把私钥写进仓库。服务构建产物在本目录 `dist/`，已由仓库规则忽略。

## API 契约

所有业务端点为 HTTPS POST、`Content-Type: application/json`。不提供浏览器跨站 CORS 授权；未来桌面端由原生请求层调用。成功/错误响应均 `Cache-Control: no-store`。不要将激活码、刷新 handle、请求正文或 Authorization 记录到平台日志。

| 路径 | 输入 | 权限 |
| --- | --- | --- |
| `/v1/admin/licenses` | `duration: { value: 6, unit: "hours" }`，可选 `leaseSeconds: 900` | 管理员 Bearer |
| `/v1/admin/licenses/<id>/revoke` | 空 JSON | 管理员 Bearer |
| `/v1/activate` | `code`、`deviceId`、`nonce` | 激活码及限流 |
| `/v1/refresh` | `licenseId`、`deviceId`、`refreshToken`、新 `nonce` | 刷新凭据及限流 |

发码示例正文：

```json
{ "duration": { "value": 7, "unit": "days" }, "leaseSeconds": 900 }
```

`activationCode` 只在成功创建响应中返回，管理员需安全交付；不要把生产码放进样例或提交历史。`deviceId` 当前为 32–128 位字母数字/下划线/连字符的客户端安装标识，不能宣称它不可复制。`nonce` 为客户端每次请求生成的 32–128 位随机十六进制字符串。

JWT claims：`iss=svga-editor-pro-licensing`、`aud=com.svga.editor.pro`、`sub=licenseId`、`iat`、`nbf`、`exp`、`licenseExpiresAt`、`deviceHash`、`nonce`、`plan=pro`。`kid` 只在受保护 header 中，不能伪造为 payload 字段；授权公钥是独立的 Ed25519 公钥 JWK，不能复用 updater minisign 公钥。`pro` 仅为协议占位权益名，不代表已决定价格或给现有功能加锁。桌面源码已经按此契约接入原生请求和验签，但生产配置与端到端桌面运行尚未完成。

## 需要经营者准备后才能上线

1. 确认使用 Cloudflare 托管（不是完全无远端服务），准备账号和可达的 HTTPS 域名/路由，实测目标用户网络。
2. 在账号中创建 D1，复制 `wrangler.example.jsonc` 为本地 `wrangler.jsonc`，填数据库 ID 与路由；禁止把它当作现成生产配置直接发布。
3. 使用平台 Secrets 分别保存随机 `ADMIN_TOKEN`、独立随机 `REFRESH_SECRET`、Ed25519 私钥 JWK `LICENSE_PRIVATE_JWK`，配置 `LICENSE_KID`。每个环境分开，密钥备份由经营者控制。示例和测试中没有生产密钥。
4. 审核并执行迁移，确认 Rate Limiting binding、预算告警、操作审计、管理员入口访问控制与密钥轮换策略；限流为保护措施，不等于账单硬封顶。
5. 完成桌面原生验签/设备凭据保护/重启和回拨时间测试。清楚选择离线宽限，过期或网络故障不应扣住已有工程和用户成果。

本轮没有部署脚本自动执行远端迁移，没有支付回调、批量发码后台、换绑、自助续费或机器指纹收集。这些是后续迭代，而不是隐藏的已完成项。

风险与方案依据见 [授权设计](../../docs/commercial/licensing-design.md)。
