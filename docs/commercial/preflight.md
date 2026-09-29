# 商业化上线前预检

`npm run commercial:preflight` 是一个只读的本地门禁。它用于把“代码原型已经存在”和“可以安全发布、接收真实用户”区分开来。

## 检查内容

- `package.json`、`src-tauri/tauri.conf.json` 与 `Cargo.toml` 的版本是否一致；
- Windows NSIS 安装目标是否存在；
- Tauri updater 的 HTTPS 端点、公钥、签名版本和危险开关；
- 桌面授权 endpoint、Ed25519 公钥 JWK、issuer/audience/kid；
- 一键打包、更新清单、授权服务测试和 CI 工作流；
- 资源目录边界，以及是否有明显敏感文件名被 Git 跟踪；
- 当前工作区是否有未提交修改。

预检不会读取环境变量中的密钥，不会解析或输出私钥，不会联网，不会提交、推送、部署或修改文件。授权和更新配置缺失会标为“待配置”，而不是假报通过；明显结构错误会标为“阻断”。

## 常用命令

```powershell
# 日常开发：看到完整报告，但允许授权/更新尚未配置
npm run commercial:preflight

# 发布前或 CI：任何待配置项都失败
npm run commercial:preflight -- --strict

# 给 CI 使用结构化结果
npm run commercial:preflight -- --strict --json
```

当前仓库没有生产授权公钥、更新签名公钥、托管端点或生产 Secrets，因此普通预检预期会显示待配置项。只有在经营者确认 Cloudflare/GitHub 发布账户、密钥保管、价格/退款和目标地区可达性后，才应把 `--strict` 纳入正式发布作业。

预检通过也不等于完成真实桌面安装升级、系统 keyring、Cloudflare HTTPS、支付、换机或退款验收；这些仍按 [STATUS](./STATUS.md)、[桌面更新方案](./desktop-updates.md) 和 [授权设计](./licensing-design.md) 中的清单逐项验证。
