# 无自有服务器的桌面远程更新

调研日期：2026-09-20。目标是让桌面用户在编辑器内获得可信的新版本提示与安装流程，而不是要求购买或维护一台服务器。

## 当前已完成与未完成

- 已新增 `scripts/release-manifest.mjs`：离线生成、校验 Tauri 2 静态更新清单，默认只预览；不上传、不打 Tag、不创建 Release、不读取私钥。
- 已新增独立 Node 测试，覆盖错误版本、错误签名格式、错误下载域名、平台遗漏和文件覆盖等边界。
- 现有 `npm run package:github` 是“提交 → 云端构建 → 下载安装包”，不是客户端自动更新。不能把 Actions artifact 链接直接当作稳定、公开的生产更新源。
- 本文的签名发布流程尚未启用：当前没有生产更新公钥、公开下载端点、签名 Secrets 或已发布的签名更新包。不能把“未配置”“断网”显示成“已是最新版”。
- 当前已接入 Tauri updater 的 npm/Rust 插件、最小 capability、前端“检查桌面更新”入口和可测试更新策略；由于生产公钥、HTTPS endpoint、签名安装包和 `latest.json` 尚未配置，桌面检查在正式环境仍会安全地显示“未配置”，不会假报最新版或安装未签名文件。
- 新增手动 `.github/workflows/publish-windows-release.yml`：使用 GitHub Releases 作为静态分发端点，先创建 draft Release，再由负责人确认发布；工作流通过临时 overlay 注入 updater 公钥和 GitHub `latest.json` 地址，不把公钥/私钥写进源码。没有配置仓库变量 `TAURI_UPDATER_PUBLIC_KEY` 与两个签名 Secrets 时，工作流会在构建前停止。
- 原生启动门卫已接入：`src-tauri/src/app_updates.rs` 只在编译进 `plugins.updater` 的配置同时满足静态 HTTPS 端点、minisign 公钥、`requireSignedVersion: true` 且所有危险开关关闭时注册 updater。当前 `tauri.conf.json` 没有 updater 配置，因此桌面仍正常启动但更新保持禁用。
- 原生 `get_update_configuration` 命令只返回 `{ configured, reason, currentVersion }`，不接受前端传入公钥/端点，也不回传配置内容。缺字段、空对象、非 HTTPS、URL 凭据/查询参数、危险 TLS、降级开关和无效公钥都会 fail-closed；网页没有 updater 插件时保持 disabled。
- capability 只授予 `updater:allow-check`、`updater:allow-download` 和 `updater:allow-install`；不授予组合式 `download_and_install`，下载与安装在界面中保持分离。
- 更新界面已将句柄释放做成幂等清理：检查结果在窗口关闭或请求过期时会释放，安装不会重复关闭同一句柄；交付包生成/保存也会阻止安装。工程有未保存修改时，默认要求保存，另提供带确认的“放弃修改并安装”路径。

本轮没有生成生产密钥、改变仓库可见性、上传文件或发布版本。

## 推荐方案

采用“源码仓库与安装包发布仓库分离”的静态分发：源码仓库可保持私有；另建公开的 releases-only 仓库，仅存发布说明、安装包及更新元数据。客户端只需要公开 HTTPS 下载地址和验签公钥，不需要 GitHub Token。

Tauri 2 支持静态 JSON 更新端点，且安装包签名校验不可关闭。公钥可以放进应用；私钥仅在受控的发布环境中签名。Windows 开启 `bundle.createUpdaterArtifacts: true` 后，使用 NSIS `.exe` 与同名 `.exe.sig`；不要沿用 Tauri 1 的 ZIP 清单。配置项是 `plugins.updater.pubkey`（公钥内容，不是路径）和 `plugins.updater.endpoints`（HTTPS 数组）。详见 [Tauri 2 Updater 官方文档](https://v2.tauri.app/plugin/updater/)。

### 原生配置门卫（接通生产更新前）

`tauri-plugin-updater 2.12.0` 的 `Config.pubkey` 是必填字段。不要在没有真实公钥时写空字符串、示例公钥或假端点；空配置直接注册插件会在插件初始化阶段失败。生产配置应由受保护的发布流程注入，形状示例（仅说明字段，不是可发布占位配置）：

当前开发依赖已升级到 Tauri CLI 2.11.5、Updater 插件 2.12.0。正式启用 `requireSignedVersion: true` 前必须用同一版本或更高版本重新签发所有安装包；旧版签名可能没有可信的 version 元数据。`release-manifest.mjs` 会接受旧签名格式以便迁移，但生产 CI 应额外要求签名 version 与清单版本一致。

```json
{
  "plugins": {
    "updater": {
      "pubkey": "<真实 .pub 文本的外层 base64>",
      "endpoints": ["https://updates.example.com/latest.json"],
      "requireSignedVersion": true,
      "allowDowngrades": false,
      "dangerousInsecureTransportProtocol": false,
      "dangerousAcceptInvalidCerts": false,
      "dangerousAcceptInvalidHostnames": false
    }
  }
}
```

应用侧门卫要求端点使用无凭据、无查询参数的静态 HTTPS URL；访问令牌、用户名、密码和危险 TLS 配置不能放进桌面二进制。`pubkey` 必须是 Tauri signer 生成的 `.pub` 文本经过外层 Base64 编码的内容（不是文件路径，也不是直接把 `RW...` 行填入配置）。通过门卫后才注册官方插件，官方插件仍负责下载字节的 minisign 验签。`get_update_configuration` 只用于显示“已配置/未配置”原因，不是前端自定义更新服务的入口。门卫的 Rust 单元测试覆盖空配置、缺字段、公钥基本格式、非 HTTPS、URL 凭据/查询参数、签名版本开关、降级和危险 TLS 开关。

静态方案不提供授权计时、设备解绑或激活码核销；这些属于独立授权服务。更新签名密钥与授权签名密钥必须分开管理。不能承诺“完全不可能破解”，也不能把阻止下载当作付费授权保护。

### 分发渠道选择

| 渠道 | 使用建议 | 注意事项 |
| --- | --- | --- |
| 公开 GitHub Releases | 第一阶段，先完成可信升级闭环 | 另建只含二进制的仓库；验证目标用户网络可达性，不能承诺所有地区高速 |
| Cloudflare R2 + 自有域名 | 需要更可控域名/CDN 时接入 | 需要 Cloudflare 账号、存储配置与域名；不是“无成本/无第三方” |
| 私有仓库 Release | 不直接给大众客户端使用 | 不得把 PAT、仓库访问令牌或管理员凭据打进客户端 |

R2 的自定义域名可使用缓存；`r2.dev` 属于限速开发端点，不作为正式付费产品更新源。参见 [Cloudflare R2 公共存储桶](https://developers.cloudflare.com/r2/buckets/public-buckets/)。公网可读的是安装程序，不应有用户工程、客户素材、激活数据或签名私钥。

网页不安装桌面 updater。网站重新部署后加载新版资源即可；如未来引入 Service Worker，应提示用户保存工作后刷新，不在有未保存编辑时自动刷新页面。

## 客户端接入约束

以下为实施与验收要求，不代表当前已经开启自动升级：

1. 仅桌面环境使用官方 updater 插件；前端网页模式显示“网页版本随部署更新”。当前桌面版未配置公钥/端点时显示“自动更新未配置”，不发出假请求、不返回假成功。
2. 检查更新只读取元数据；显示当前版本、新版本和发布说明，提供“稍后”和“下载”。下载中允许继续编辑，并显示进度/取消或重试状态。
3. **安装前重新检查未保存状态**。如果用户下载期间又编辑了工程，必须再次拦截。“保存并安装”必须等待保存成功并确认编辑状态已落盘；保存失败或取消时禁止安装。提供“取消”和明确的“放弃修改并安装”，不隐式丢弃。
4. 正在导出、写文件或保存时禁止安装；暂停播放，结束未提交的画布操作。检查时获取的旧 dirty 值不能替代安装瞬间的检查。
5. Windows 的安装 API 会启动安装器并退出应用，不能依赖普通关闭窗口回调兜底。将未保存保护放在实际安装调用之前；下载与安装分离。依据 [Tauri updater 安装实现及平台行为](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/src/updater.rs)。
6. 下载失败、签名错误、格式错误、未匹配平台分别给出可操作提示；禁止忽略验签、关闭 TLS 校验或自动回退到未签名安装程序。
7. 默认只接受更高版本；不修改版本比较器绕过降级保护。坏版本应先停止发布，再以更高版本号修复，不偷偷复用已发布版本号覆盖产物。
8. 发布说明按文本或安全 Markdown 渲染，不执行服务器返回的 HTML/脚本。更新不能访问素材、上传用户文件，也不应成为使用编辑器的强制前提。

验收至少包含：清单 404/断网、空签名、包被篡改、缺当前平台、旧版本/相同版本、不完整配置、下载过程中修改工程、保存取消/失败、导出进行中、安装失败后可继续编辑。

## 本地清单工具

## GitHub 免费发布路径

本项目提供手动工作流 `.github/workflows/publish-windows-release.yml`。它不在每次提交时发布，只在 GitHub Actions 中手动输入版本 Tag 和更新说明后运行：先跑检查、测试和签名构建，再创建 draft Release。负责人检查资产后点击 Publish，客户端从固定的
`https://github.com/<owner>/<repo>/releases/latest/download/latest.json` 读取清单。

首次启用需要在仓库设置中配置：

1. 生成一套 Tauri updater 密钥；公钥放到仓库 Variables 的 `TAURI_UPDATER_PUBLIC_KEY`，私钥只放到 Actions Secrets 的 `TAURI_SIGNING_PRIVATE_KEY`，密码放到 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。私钥不要提交、不要放进 `VITE_*`、不要发到聊天中。
   可选设置仓库 Variable `TAURI_UPDATER_ENDPOINT` 为国内镜像的公开 HTTPS `latest.json` 地址；留空时使用当前 GitHub 仓库的 Releases 地址。端点不能包含 Token、用户名/密码、查询参数或非标准端口；镜像必须提供与签名安装包匹配的清单。
2. 确认仓库为公开仓库，或接受私有仓库的 Actions 免费额度限制。公开仓库的标准 GitHub-hosted runner 可免费使用；Release 资产不应放入 Git 历史，而应作为 Release 资产。
3. 手动运行 `Publish signed Windows release`，输入例如 `v2.1.0`。工作流只创建 draft，确认安装包、`.sig` 和 `latest.json` 后再发布。
4. 真实旧版桌面包执行“检查 → 下载验签 → 安装 → 重启”验收。当前代码没有生产公钥，因此工作流在配置前会安全停止，不能直接生成可更新安装包。

这条路径不需要自建服务器，也不需要把 GitHub Token 放进客户端；Actions 使用运行时的 `GITHUB_TOKEN` 上传 Release。它不等于绝对零成本：私有仓库超出免费 Actions 额度、使用大型 runner 或其他 GitHub 计费产品时可能产生费用，正式启用前应设置预算和用量告警。

### 中国大陆网络与备用分发

GitHub 在中国大陆并非所有网络都需要代理才能访问，但仓库页面、Release 大文件和 `github.com`/跳转下载链路可能出现慢、超时或间歇不可达。社区反馈也把这种状态描述为不一致；这不是 GitHub 官方 SLA，不能据此承诺任何运营商都能下载。[GitHub 社区讨论](https://github.com/orgs/community/discussions/169871)

因此当前产品不应对国内客户承诺“直接打开 GitHub 就一定能更新”。上线前至少用目标地区的电信、联通、移动和企业网络分别实测：仓库页、`latest.json`、`.exe`、`.sig`、断点重试和安装器启动。

建议分发策略：

- 全球用户：GitHub Releases 作为公开源；
- 中国大陆用户：准备一个可控的国内镜像或对象存储域名，镜像同一份 `latest.json`、安装包和 `.sig`，仍使用同一 Tauri 公钥验签；
- 已支持通过 `TAURI_UPDATER_ENDPOINT` 选择镜像清单地址；该设置在构建时写入客户端，因此切换源之后需要发布新安装包，不能修改已安装旧版的内置 URL；
- 不使用来路不明的 GitHub 代理或把代理 URL 写进正式安装包；
- Tauri 多 endpoint 只有在前一个 endpoint 返回非 2xx 时才继续下一个，网络超时不一定会自动切换，因此不能仅靠 endpoint 数组解决跨境超时。[Tauri updater endpoint 行为](https://v2.tauri.app/plugin/updater/)

在没有完成国内镜像和真实网络矩阵前，GitHub 方案应标记为“可用但不保证大陆稳定可达”，而不是“国内无需翻墙”。

只需要 Node.js 20+，无新增依赖。首次先查看帮助：

```powershell
node scripts/release-manifest.mjs --help
node --test scripts/release-manifest.node-test.mjs
```

下面是**命令模板**，版本号、仓库名、安装包路径和更新说明需替换为本次真实构建数据。不会为占位符生成可发布签名：

```powershell
# 默认仅预览，.sig 必须来自同次真实 Tauri 签名构建
node scripts/release-manifest.mjs build `
  --version 2.1.0 `
  --platform windows-x86_64 `
  --url "https://github.com/OWNER/RELEASES_REPO/releases/download/v2.1.0/SVGA%20Editor%20Pro_2.1.0_x64-setup.exe" `
  --signature-file "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/SVGA Editor Pro_2.1.0_x64-setup.exe.sig" `
  --notes-file "release-notes.md" `
  --pub-date "2026-09-20T00:00:00Z"
```

检查后，在同一命令追加 `--out "release/2.1.0/latest.json" --write` 才会写入新文件。已有文件必定拒绝覆盖，没有 `--force`。单独传 `--out` 仍然是 dry-run。

```powershell
# 只读校验所有平台，不请求网络
node scripts/release-manifest.mjs validate --file "release/2.1.0/latest.json"
```

自定义 CDN 需要显式添加 `--allow-host downloads.你的域名`，且应使用 ASCII/Punycode 主机名；不能写协议、端口或通配符。生成与校验使用相同允许列表。默认只接受 `github.com` 的固定版本资产地址；`latest/download/latest.json` 用于客户端清单端点，而清单内的安装包 URL 应固定到具体 `releases/download/vX.Y.Z/...`，防止新版清单配到旧版签名。

工具的 `build` 当前一次生成一个平台，面向现有 Windows 构建。`validate` 支持完整多平台清单并逐个验证；将来采用官方 Tauri Action 汇集多平台时也应验证整份 JSON。当前范围为 Windows `.exe/.msi`、macOS `.app.tar.gz`、Linux `.AppImage`；不支持自定义 target 和 Tauri 1 兼容 ZIP。

### 签名校验的准确含义

工具检查规范 Base64、Tauri/Minisign 封装、算法/长度、非空签名字节与签名中的文件名元数据；安装包 URL 文件名、`.sig` 文件名和 `file:` 必须一致。它能拦住路径误填、空值、显式占位符和明显损坏，但**不能判断一段格式正确的伪造签名是否真实**，也没有下载并检查 URL 的可达性或包内容。

最终安全边界是 Tauri 客户端使用内置公钥对实际下载字节验签。SHA-256 仅用于追踪构建/传输完整性，不能替代签名。封装依据 [Tauri 签名生成实现](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/helpers/updater_signature.rs) 和 [Minisign 格式说明](https://jedisct1.github.io/minisign/)。测试在内存中生成临时 Ed25519 密钥，签的是文字样本，未将任何生产私钥、激活签名或可发布安装包写入仓库。

## GitHub 签名发布流程（生产配置前不得启用）

现有“一键打包”保持可用；生产签名发布应单独加受保护的发布作业，而不是每次提交就自动推送所有用户升级：

1. 明确发布版本，校验 `package.json`、`Cargo.toml`、Tauri 配置三者一致，代码检查及测试全部通过。
2. 使用受保护的 GitHub Environment，给正式发布设置审核；生产密钥不开放给不可信分支或 PR 工作流。
3. CI 构建时由 Secrets 注入 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。签名密钥离线备份；不写入 `.env`、源代码、日志、artifact 或下载配置。
4. 使用官方 `tauri-apps/tauri-action` 生成签名产物与 `latest.json`；项目只使用 NSIS 时指定 NSIS，混合 MSI/NSIS 时确认 `updaterJsonPreferNsis`。也可继续现有构建步骤并调用本工具生成/校验静态清单。两条路线择一，不需要自己实现签名算法。
5. 先上传安装包与 `.sig` 到 draft Release，再校验版本、完整目标平台、说明与清单。使用真实旧版本桌面包测试“检查 → 下载验签 → 保存 → 安装 → 启动新版本”。通过后才发布；客户端下载端点只指向公开正式版，测试版另走单独渠道。
6. 若采用 CDN，版本化安装包设置不可变地址；最后更新清单，清单使用短缓存策略。保留可追溯的提交、构建编号与 SHA-256，不覆盖历史资产。

官方 Action 支持生成 updater JSON、优先使用 NSIS，以及上传到另一个 `owner/repo`；跨仓库发布需要发布凭据与目标提交配置，参见 [Tauri Action 参数](https://github.com/tauri-apps/tauri-action)。现有工作流的 `contents: read` 不足以发布 Release；应在独立发布作业内按需授予最小权限，而非给所有作业扩大授权。

源码仓库的 `GITHUB_TOKEN` 仅限该仓库；跨仓库发布应使用受限 GitHub App 安装令牌，或仅有目标发布仓库 Contents 写权限的细粒度 PAT，仅存于 Actions Secrets。不要将这些凭据放进桌面二进制。参见 [GitHub 工作流令牌权限](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)。

Windows Authenticode 代码签名与 Tauri 更新签名是两件事：后者确保应用内更新来源，前者关联 Windows 发布者信任/系统提示。商业发布若需要可信发布者，应另行准备代码签名服务或证书；本工具没有申请证书或规避系统校验。

## 开通前需要用户确定的事项

- 公开 releases-only 仓库的归属与名称；是否需要 CDN 域名。本文不会代为创建或改变私有/公开状态。
- 在可信本机一次生成生产 updater 密钥，备份到密码管理器/离线安全存储；仅把公钥提供给客户端配置，把私钥及其密码放入受保护的 Actions Secrets。不要在聊天中发送私钥。
- 发布作业使用的目标仓库写权限；跨仓库授权凭据只在 CI 内可见。
- 是否购买 Windows 代码签名服务；没有代码签名时必须如实说明系统可能提示未知发布者。
- 第一版正式更新的版本号、发布说明及试运行范围。

开始接通前按 `github-actions-packaging-debug` 的流程先检查 [GitHub Status](https://www.githubstatus.com/)，再检查工作流与权限，避免把服务端故障误判成 YAML 问题。本次调研时 Actions 为 operational；这是当时的状态，不是对下一次发布的保证。
