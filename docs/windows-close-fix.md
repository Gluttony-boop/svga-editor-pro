# Windows 关闭窗口修复

日期：2026-09-09。

## 根因与复现

项目安装的 `@tauri-apps/api/window.js` 中 `onCloseRequested` 会等待业务回调完成，然后在未阻止默认行为时调用 `destroy()`。项目主窗口 capability 只授予 `core:window:allow-close`，缺少 `core:window:allow-destroy`；`core:default` 中的 window 默认权限也不含 destroy。

最小反馈命令：

```powershell
npx vitest --run src/lib/window-close.test.ts
```

测试调用真实 Tauri SDK `Window.prototype.onCloseRequested` / `destroy`，在 IPC 边界按项目 capability 模拟权限。修复前关闭路径失败：`window.destroy not allowed by main capability`；不是浏览器 close() 的测试，也不声称等价于真实 WebView2 安装包实测。

## 修改

- 在只绑定 `main` 窗口的 capability 中加入 `core:window:allow-destroy`。
- 把关闭业务流程抽离到 `src/lib/window-close.ts`：同步阻止 SDK 默认关闭，串行处理确认、保存、最终 destroy；不递归发送第二个 close 请求。
- 无修改直接关闭；不保存直接关闭；保存成功才关闭；保存取消/失败和用户取消都保留窗口。
- 确认或保存期间连续关闭不会覆盖确认处理；异步错误显示到应用错误提示，之后可重试。
- 监听销毁后不会继续执行悬挂的关闭操作；应用自绘关闭按钮的 IPC 失败也有错误提示。

## 验证与限制

- 11 项关闭回归覆盖真实 SDK 权限路径、无修改、保存、不保存、取消、保存取消/异常、连续点击、保存期间重复关闭、关闭异常后重试、监听释放、不会由 SDK 再次 destroy。
- TypeScript、lint 和 Web 构建通过；最终全量 101 项测试通过，其中 11 项覆盖关闭流程。
- 尝试 `npm run tauri -- build --no-bundle`。Web 构建成功，Rust 构建在 vswhom-sys 处失败：找不到 `cl.exe`。通过 vswhere 找到 Visual Studio 2026 BuildTools，但只安装了基础/MSBuild 内容；运行其 VsDevCmd 后 `where cl.exe` 仍找不到编译器。未自动安装系统组件。
- 因而没有生成修复后的原生 EXE、没有对安装包实际点击关闭。`src-tauri/target/release/svga-editor-pro.exe` 原有文件是旧产物，不能当作本次修复版本。

## 更新 Windows 包

先在 Visual Studio Installer 中为 Build Tools 安装“使用 C++ 的桌面开发”（包括 MSVC x64/x86 工具与 Windows SDK），或使用已具备完整工具链的 Windows CI 环境。

```powershell
cd D:\CompanyProject\svga-editer
npm run build:win
```

重新安装新包后，检查系统标题栏关闭、自绘关闭按钮、Alt+F4，以及未保存提示的保存/不保存/取消分支。修改 capability 需要重新编译原生包，网页刷新或只替换前端开发文件不能修复已发布的旧 EXE。
