# MeeWoo SVGA 压缩导出流程核对

> 核验日期：2026-09-07。只读研究第一方源码，固定提交 [`f3a59e25cabe754edff7e1a66a81b3322c80a138`](https://github.com/vincentline/MeeWoo.me/commit/f3a59e25cabe754edff7e1a66a81b3322c80a138)。范围为素材压缩、SVGA 导出、预览与取消；没有执行参考站或验证其线上版本。不复制第三方代码。

## 本地实现结果

本项目已独立实现“生成导出预览”：

- 实际生成当前编辑未优化副本及优化结果；三栏区分来源文件、编辑后未优化、优化后字节，收益只相对编辑后基准计算。真实增大时使用警告而非绿色成功提示。
- 弹窗重新解码两个产物，不使用主画布截图或改动主编辑文档；同帧并排显示，支持同步播放、逐帧查看及透明/黑/白背景。只对比画面，不播放音频；打开时暂停主播放。
- 保存复用预览 Blob，不二次优化；提供同快照的未优化副本保存。取消保存位置选择会保留预览。保存导出副本不清除编辑器未保存标记。
- 资源、图层、参数、插槽或配置变化会使缓存失效；生成途中变化时丢弃旧结果，选择保存位置后再次核对输入，禁止写入已经失效的结果。预览帧、选择与缩放不使产物失效。
- 使用独立优化器实例，避免共享统计混入其他任务。预览解析器收集全部临时图片 URL，包括解码失败的资源，在关闭或失败时释放；播放不缓存全帧 Canvas。超大画布跳过画面预览，仍保留体积信息和保存能力。
- 本轮没有新增运行中立即取消优化、GIF/MP4 编码或跨播放器兼容性认证；兼容性与精简风险仅作提示，仍需在目标播放器验收。

验证：42 项单元测试、TypeScript、lint、Web 生产构建通过。浏览器验证了并排解码、播放/逐帧、主文档与撤销历史不受比较操作影响、取消后重试保存、缓存复用、预览关闭后临时 URL 清空、生成途中变更丢弃、保存位置选择期间变更阻止写入。

实际浏览器下载文件与生成产物的 SHA-256 一致：`a91083afb424c3812faa9802804c54665d2f68d8fc22c4b0d89c0b1c178dd2f2`；同次测试优化器仅执行一次，保存没有重新压缩。截图：`output/playwright/export-preview-comparison.png`。尚未执行 Tauri 安装包/原生保存对话框测试；原有主预览 Worker CSP 限制未在本轮修改。

## 已确认与本项目衍生

| 能力 | 固定提交的实现证据 | 本项目取舍 |
| --- | --- | --- |
| 压缩参数 | 弹窗提供 PNG 质量与静音开关。[模板 952–988 行](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/index.html#L952-L988) | 借鉴“设置→生成→检查”工作流，不照搬参数或编码器。 |
| 压缩后预览 | 逐图覆盖素材预览与替换映射；完成后调用 `applyReplacedMaterials`，通过现有播放器的动态图片替换更新画面，并非重新解析导出文件。[压缩流程](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/core/app.js#L5173-L5259)、[动态预览](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/core/app.js#L5062-L5107) | **独立解析实际导出产物、不改编辑状态的结果预览是本项目衍生。** |
| 导出 | `startCompressAndExport` 在压缩完成后调用导出；重新读取源 SVGA、替换图片、按需去音频，编码 Blob 后直接下载。[入口](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/core/app.js#L5151-L5158)、[导出实现](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/core/app.js#L5347-L5458) | **生成后等待用户确认、复用同一产物保存是本项目衍生。** |
| 进度与取消 | 素材处理按已处理数量更新百分比，按钮显示进度；该循环未见取消检查，弹窗“取消”只关闭设置且压缩中禁用。[循环](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/core/app.js#L5197-L5251)、[进度按钮](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/index.html#L1771-L1778)、[关闭与禁用](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/index.html#L984-L988) | 真正的运行中取消与阻止过期结果提交需独立实现；不能把其他视频/GIF 转换链的取消能力归给此链。 |
| 撤销 | 压缩前备份素材列表和替换映射，撤销恢复后重应用播放器替换。[备份](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/core/app.js#L5185-L5186)、[撤销](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/core/app.js#L5285-L5304) | 试算不修改文档，则不应产生压缩撤销项或污染编辑历史。 |

“未见”仅限上述链及其模板，不代表整个项目没有相关功能。仓库另有 MP4/YYEVA 转 SVGA 的文件大小预估，但其公式是宽×高×帧数×经验系数，不是已生成产物测量，不能作为本轮压缩试算的依据。[预估源码](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/core/app.js#L11137-L11247)

## 三种整包体积必须分开

本项目建议口径如下；这是设计建议，不是参考站已具备的三栏比较：

| 显示项 | 测量对象 | 对比意义 |
| --- | --- | --- |
| 导入原文件 | 导入时原始 SVGA buffer 的 `byteLength` | 仅作来源基准；不包含本次图层、插槽等编辑。参考站导入大小取 `file.size`。[源码](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/core/app.js#L1428-L1429) |
| 当前编辑（优化前） | 同一文档快照应用全部编辑并正常编码后的完整 SVGA | 优化收益的公平基准，不能用导入原文件替代。 |
| 优化后 | 对该快照按所选优化设置生成的完整 SVGA | 以真实字节计算节省量与百分比；变大须如实显示。 |

推荐节省比例为 `(当前编辑字节 − 优化后字节) / 当前编辑字节`，分母为零时不显示百分比。若另算相对导入原文件的变化，要独立标注，不能称为纯优化收益。

参考源码中有两处容易误读的统计：

- 素材压缩先用 `width × height × 4` 作 `originalSize`，成功后把素材 `fileSize` 改成 PNG 编码字节，再由 `_recalculateTotalMemory` 合计。像素内存和编码大小不能互相比“压缩率”。[赋值](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/core/app.js#L5215-L5244)、[汇总](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/core/app.js#L5337-L5344)
- 压缩服务的 `originalBytes` 累计传入 PNG 字节；Canvas 路径先重新编码 PNG，故它既不是原图片编码字节，也不是原始/编辑后 SVGA 的整包体积。服务失败会返回输入 PNG，不代表一定缩小。[服务统计与降级](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/service/image-compression-service.js#L126-L166)、[比例](https://github.com/vincentline/MeeWoo.me/blob/f3a59e25cabe754edff7e1a66a81b3322c80a138/src/assets/js/service/image-compression-service.js#L203-L208)

## 本地实现验收提醒

以下是从参考流程推导的工程建议，不是参考站实测缺陷清单：

1. 一次试算绑定文档快照及设置；编辑或设置改变后明确使结果失效。取消、切换文件、卸载面板后不得由旧任务回写结果或触发下载。
2. 预览解析与保存共用已经生成的字节，不通过再次编码获得“看似相同”的结果。独立播放器不得改变主编辑器帧位置、播放状态、选区或撤销历史。
3. 取消应说明粒度：不可中断的解码/编码步骤结束后忽略结果，不声称点击即可立刻释放 CPU。阶段进度不要把“素材已处理 100%”误当作整包编码、解析、保存全完成。
4. 结果失败或取消不破坏上一次有效文档；关闭预览需释放播放器、音频和对象 URL。去音频、删未用资源、图片转码的兼容性由真实产物解析和目标播放器验证，不凭体积变小承诺成功。
5. 用原图已高度压缩、替换图变大、隐藏图层、静音和重复生成等样例验证；尤其确认原文件/当前编辑/优化后体积差异及负收益显示。

本文件只记录研究与验收建议，不声明本项目上述功能已经通过测试。
