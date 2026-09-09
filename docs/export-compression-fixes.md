# 导出与压缩修复记录

日期：2026-09-07。范围：主 SVGA 压缩、预设选择、资源替换导出与保存结果；不是所有动画格式或目标播放器的兼容性认证。

## 已复现的根因

1. `handlePresetChange` 先设置预设 ID，随后调用会将 ID 重置为 custom 的配置 setter。浏览器断言实测 aggressive → custom。改为一次 store 操作原子更新配置和 ID，并保留单步撤销。
2. 原有 PNG 质量 20 与 100 均调用 Canvas PNG 编码（实际质量参数固定为 1），样例两次输出均为 104,350 字节。取消无效百分比，PNG 改为显式调色板色数，WebP 保留质量控制。
3. 图片缩放使用所有素材的最小统一比例，并同时改写 viewBox、layout、transform；100% 缩放时最大尺寸限制又未生效。现在逐图限制尺寸，画布、坐标和帧序列不随纹理降采样变化。
4. 去重仅依赖抽样哈希；同哈希不同数据被错误合并，且遮罩 Key 可能被删除。现在逐字节核对，保护遮罩和音频引用。
5. 帧精简只比较 alpha/transform，忽略 clipPath、layout、shapes 和字段存在性。现在这些语义不同时禁止合并，数值精度处理也不再为缺省字段写入新值。
6. 原生保存取消返回 void，外层仍返回成功；浏览器选定路径写入失败后悄悄改为下载文件。现在先选择并固定原生路径，取消返回空目标，写入失败向上传播，不静默改换目的地。
7. 替换素材读取失败被 catch 后跳过，导出仍成功却保留旧图片。现在明确报出素材 Key 并中止导出。

同时移除了属性面板与导出面板两套互不对应的压缩界面。原来的保存/当前帧内部兼容配置未做全系统迁移，主 SVGA 导出使用导出面板的配置。

## 回归与探针

```powershell
npx vitest --run src/core/optimizer.regression.test.ts src/core/save-file.regression.test.ts src/core/exporter.failure.test.ts src/stores/editorStore.preset.test.ts
npm run test:run
npm run typecheck
npm run lint
npm run build:web
```

最初优化器/保存最小命令连续两次运行均 7 项失败；预设和替换资源失败另有红测试/浏览器断言。修复后 80 项测试、类型检查、lint 和 Web 生产构建通过。结构回归使用真实 protobuf/zlib 编解码，位图编码在单元测试中模拟；浏览器探针另使用真实 Canvas、PNG Worker 和浏览器解码器验证。

浏览器样例：`output/playwright/preview-export.svga`，源文件 104,351 字节。各预设原始字节实测如下，**不能当成所有 SVGA 的压缩率承诺**：

| 预设 | 输出字节 | 减少约 |
| --- | ---: | ---: |
| 保真 PNG | 104350 | 0% |
| 均衡 PNG（256 色） | 103331 | 1% |
| 高压缩 PNG（128 色、75% 纹理） | 56198 | 46% |
| 极限 PNG（64 色、50% 纹理） | 25341 | 76% |
| WebP 85% | 67297 | 36% |

五种结果均重新解码，无图片处理失败；与源文件逐项比较 params 与 sprites，画布、时序、动画坐标完全一致。1×1、2×2、4×4 半透明 PNG 由浏览器原生解码验证，alpha 128 正确保留。

Web 生产包验证：隔离的无界面 Edge 中载入样例，选择高压缩预设，Worker 压缩、双画布预览、保存下载均成功。下载 `output/playwright/fixed-compressed.svga` 为 56,198 字节，另用 Node protobuf/zlib 重新解析，与源文件 params/sprites 对比通过（720×760、15 FPS、15 帧）。截图：`output/playwright/export-compression-fixed.png`。

## PNG 实现与边界

仅采用 `upng-js@2.1.0` 的量化函数；没有使用其存在小图截断问题的 encode。独立构造 PLTE/tRNS/IDAT/IEND、长度和 CRC，量化运行在专用 Worker；只传输 Canvas 的工作副本。包的 MIT 声明随 `public/third-party-licenses/upng-js.txt` 分发。一手资料见 [编码器核对](png-compression-research.md)。

PNG 量化是有损的，透明度也参与量化；可能出现色带或柔和边缘变化。量化上限约 419 万像素，Worker 25 秒超时；单图处理 30 秒超时，失败保留原图并显示警告。单图和整包只在不增大文件时采用结果，效果有限时不能凭空提高压缩率。

## 未验证与后续

- 尚未拿到用户特定失败文件、复现操作、目标播放器版本；不能断言所有“有时不好”均已解决。
- 尚未运行 Tauri 安装包的真实系统文件对话框；原生成功/取消/权限失败使用真实适配层加模拟后端验证。
- PNG 序列、当前帧等其它格式未进行同等级全面回归，主预览既有 Worker CSP 限制未在本轮处理。
- npm audit 报告 24 项依赖告警；本轮未执行可能破坏兼容性的全量依赖升级或 audit fix --force。新增量化器有已知 encode 缺陷，已绕开并单独验证 writer，不等于该包或整个依赖树经过完整安全审计。
- 无生产调试探针；实验脚本留在明确标记的 `output/playwright/`，应用中没有新增 `[DEBUG-*]` 日志。

建议变更摘要：修正压缩预设状态覆盖、无效 PNG 质量控制、纹理缩放污染坐标、抽样去重/帧精简丢失语义，以及导出与保存路径吞掉失败的问题。
