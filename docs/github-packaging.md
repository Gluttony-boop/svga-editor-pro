# GitHub 一键 Windows 打包

Windows 可直接双击项目根目录的 `package-github.cmd`。终端中也可以运行：

```powershell
npm run package:github
```

默认会自动处理本地修改：检查代码、提交、推送至 GitHub，触发 `Package Windows Installer`，等待完成，再下载 Windows `.exe` 安装包。不再因为普通的未提交修改直接中止。脚本不打 Tag、不创建 GitHub Release，也不会运行下载的安装程序。

**默认发布的是整个仓库当前更改**，包括新增、修改、删除和已暂存内容，不仅是某一个功能。部分暂存文件会按当前工作区内容纳入提交，仅取消暂存不能把文件排除在外。被 `.gitignore` 忽略的未跟踪产物不会加入提交；已跟踪文件不会因为后来加入 `.gitignore` 就自动退出版本控制。建议首次执行前先用 `--dry-run` 查看全部待提交路径，存在不希望发布的改动时先自行整理再执行。

## 首次准备

1. 安装 Node.js 20+ 和 Git，执行 `npm ci`。
2. 确认 `origin` 指向目标 GitHub 仓库，并且 Git 已设置正确的提交者姓名和邮箱。脚本不会更改你的全局 Git 配置、安装依赖或修改 PowerShell 执行策略。
3. 使用已登录的 GitHub CLI（`gh auth login`）或系统 Git Credential Manager。也可通过环境变量 `GH_TOKEN` / `GITHUB_TOKEN` 提供凭据；不要把 Token 写入脚本、Git 仓库或命令参数。
4. 确认当前分支允许你推送，并查看 dry run 的文件清单。在通常使用的默认分支 `master` 上，本脚本和新版工作流会随本次更改一起提交推送，不需要先手动 commit。若使用功能分支而默认分支还没有新版工作流，则须先按仓库流程把工作流合入默认分支；脚本不会擅自修改默认分支。

自动提交推送模式的细粒度 Token 应选择目标仓库，并授予 **Contents: Read and write**、**Actions: Read and write**；当本次提交修改 `.github/workflows/` 时，还需要 **Workflows: Read and write**。GitHub 隐含 Metadata 读取权限，组织仓库还可能要求 SSO 授权。经典 Token 需要相应仓库授权，修改工作流还需要 `workflow` scope。仅 `--no-publish` / `--allow-dirty` 模式不写仓库内容，Contents 读取权限即可，Actions 仍需写权限以触发构建。权限依据见 [GitHub 仓库内容文档](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)、[OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) 和 [工作流 API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。

凭据按以下顺序选择：`--token-stdin`、`GH_TOKEN`、`GITHUB_TOKEN`、`gh auth token`、Git 凭据管理器。环境变量中的 Token 也可用于 HTTPS Git 推送；SSH 远端还需要可用的 SSH 认证。认证信息不会输出或写入构建记录；下载的预签名地址不会携带 GitHub Token，也不会输出到日志。

## 默认执行过程与边界

1. 列出所有待提交文件，检查 Git 操作状态、路径及常见敏感内容。
2. 运行 `typecheck`、`lint`、`test:run`、`test:packaging`、`build:web`。本机只做 Web 构建，Windows 安装包在 GitHub Actions 中编译，本机不必安装 Rust/MSVC。
3. 复核检查期间文件没有变化。任何检查失败或文件被其他进程继续修改，都停止自动提交。
4. 暂存已列出的文件并提交；工作区无更改则不创建空提交。已有的本地未推送提交也会正常推送。可用 `--message` 设置本次自动提交的说明。
5. 使用普通 Git push；不会 force push、rebase、stash，也不会替你处理合并或丢弃本地内容。
6. 核对远端提交，触发唯一请求的打包运行，等待并下载校验后的安装包。

自动生成的提交信息会附加 `[skip ci]`，避免这次 push 再启动已有的 push 构建；随后脚本显式触发的 `workflow_dispatch` 仍会运行。该标记也影响 `pull_request` 检查，受保护分支可能禁止直接推送，要求的检查也可能保持 Pending。脚本不会绕过分支保护；这类仓库应按原有 PR 流程发布，再使用 `--no-publish` 打包。已存在的提交不会为了补此标记而被修改，因此推送旧的未推送提交仍可能触发原有 push 工作流。参见 [GitHub 跳过工作流说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)。

冲突、正在进行的 merge/rebase、敏感文件或疑似凭据、异常路径、远端领先/分叉及权限失败都会阻止相应后续操作。敏感内容扫描是防误提交检查，不是完整安全审计；发布前仍应审阅文件清单。

若提交已生成但 push 或后续打包失败，已产生的本地提交会保留，脚本不会自动撤销历史。修复阻碍后重试时不会为相同内容再创建空提交；若 GitHub 请求结果未知，请先按请求 ID 确认是否已有构建，避免重复运行。

## 常用命令

```powershell
# 只查看帮助
npm run package:github -- --help

# 离线查看所有待提交文件：允许存在修改，不读取凭据/联网/提交/推送
npm run package:github -- --dry-run

# 自动检查、提交、推送及打包，并定制自动提交说明
npm run package:github -- --message "完善关键帧工作区"

# 只打包干净且已推送的 HEAD，不执行 commit 或 push
npm run package:github -- --no-publish

# 明确忽略本地修改，只打包已推送的旧 HEAD（隐含 --no-publish）
npm run package:github -- --allow-dirty

# 指定远端分支、等待上限（分钟）、轮询间隔（秒）
npm run package:github -- --ref master --timeout 90 --poll 15

# 独立离线测试，不触发任何 GitHub 任务
npm run test:packaging
```

`--dry-run` 默认就允许工作区有修改，不必再附加 `--allow-dirty`；它不运行质量检查，也不确认远端是否已推送。`--no-publish` 要求工作区干净且 HEAD 已推送；`--allow-dirty` 隐含不发布，允许忽略工作区修改，但仍要求 HEAD 已在远端，安装包不会包含这些本地修改。两者都不会自动推送此前已提交但未推送的内容。

默认读取 `origin`，可用 `--remote <名称>` 指定其他 Git remote。当前仅支持 `github.com` 的 HTTPS/SSH 仓库，不支持企业版自定义域名。`--ref` 指定目标分支，但不会代为切换或合并分支；分离 HEAD 不适合自动发布，应先自行切换到要发布的本地分支。

`package-github.cmd` 会先切换到脚本所在项目目录，再把参数传给 npm，并在结束后保留窗口等待按键，便于双击时查看错误及下载位置；它保留 npm 的退出码。CI、自动任务和已有终端请使用 npm 入口，不会等待按键。例如在 PowerShell 中可用 `.\package-github.cmd --dry-run` 查看计划。

## 产物与校验

成功后在已被 Git 忽略的目录中生成独立子目录：

```text
release/<提交前8位>-<run ID>-<随机后缀>/
  SVGA Editor Pro_2.0.0_x64-setup.exe
  svga-editor-pro-windows-installer.zip
  SHA256SUMS.txt
  build-receipt.json
```

实际安装包名称随项目版本变化。已有安装包不会被覆盖。`build-receipt.json` 记录完整提交 SHA、唯一请求 ID、GitHub 运行链接、artifact ID 和两份 SHA-256；其中不包含认证信息。

校验分两层：先把 ZIP 的 SHA-256 与 GitHub 返回的 artifact digest 对比，再把安装包 SHA-256 与 Windows 构建阶段生成的 `SHA256SUMS.txt` 对比。摘要缺失、不匹配、产物已过期、ZIP 含路径穿越或异常文件时都会停止，不保存未经校验的安装包。这是传输完整性校验，不等同于 Windows 代码签名；未经代码签名的程序仍可能出现系统安全提示。

工作流运行名包含随机 `request_id`，脚本同时核对事件类型、工作流 ID、分支及完整 SHA。因此同一提交的自动 push 构建、其他人同时手动打包、重复点击都不会被误认为本次任务。若远端分支在检查与触发之间发生变化，工作流与脚本都会拒绝错误版本。

## GitHub 网页一键运行

进入仓库 **Actions → Package Windows Installer → Run workflow**，选择分支即可，两个输入框可留空。完成后下载 `svga-editor-pro-windows-installer` artifact。网页只处理已在 GitHub 上的代码，不会提交你电脑上的修改，也不会自动下载到电脑；本地一键入口才包含提交、推送、等待、下载、解压和校验的完整流程。

## 常见失败

- **工作区存在修改**：默认模式会检查、提交并推送；若仍看到旧版“请先提交”提示，确认使用了更新后的脚本，且没有指定 `--no-publish`。不要为了打包最新内容使用 `--allow-dirty`，它只打包旧 HEAD。
- **质量检查失败**：修复终端中的检查错误后重试，不会跳过测试强行提交。未安装依赖时先执行一次 `npm ci`。
- **检查期间文件发生变化**：停止其他编辑/格式化进程后重试，确保将要提交的内容就是通过验证的内容。
- **存在冲突或 merge/rebase 尚未完成**：先自行完成或处理该 Git 操作。脚本不会替你取消操作或丢弃内容。
- **敏感内容或路径被拒绝**：检查所列文件，移除凭据或将不应提交的未跟踪本地配置加入 `.gitignore`。不要把真实 Token 当作测试样例提交。
- **远端领先或历史分叉**：先按团队流程同步分支后重试；脚本不会 force push 或自动 rebase。`--no-publish` 模式下，本地未推送 HEAD 也会被拒绝。
- **缺少新版 workflow / HTTP 422**：默认分支上的新版工作流通常会随自动发布一起推送。若在功能分支而默认分支尚未配置，请先通过团队流程把配套工作流合入默认分支。
- **401 / 403 / push 被拒绝**：检查登录状态、Contents/Actions 权限、工作流修改授权、组织 SSO、API 频率限制和分支保护。脚本不会自动放宽仓库权限；若已经生成本地提交，该提交会保留。
- **GitHub Actions 服务异常**：先看 [GitHub Status](https://www.githubstatus.com/)。脚本检测到 Actions 非正常状态时不发起构建。
- **构建失败**：终端会列出失败步骤及运行链接，不会把旧安装包当成本次产物。
- **等待超时、关闭终端或触发请求网络中断**：远端运行不会被自动取消，也不会自动重发 POST。先用终端已显示的请求 ID 在 Actions 中确认结果，避免重复构建；产物仍可从网页下载。

接口依据：[手动触发工作流](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[运行查询](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs)、[artifact 下载和摘要](https://docs.github.com/en/rest/actions/artifacts#download-an-artifact)、[动态 run-name](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#run-name)。脚本兼容 dispatch 返回运行 ID 的新响应，以及不带响应体、需通过唯一请求 ID 查询的旧响应。
