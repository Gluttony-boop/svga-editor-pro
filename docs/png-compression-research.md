# PNG 真压缩编码器核对

核对日期：2026-09-07。范围：UPNG 官方源码、npm 发布包与 Vite 官方文档；没有修改应用或依赖，没有进行浏览器自动化。

## 结论

UPNG 可作为 RGBA 调色板量化候选，但**不建议直接上线 npm `upng-js@2.1.0.encode()`**：本次从 npm 发布包运行最小探针，发现 1×1 图片输出被截断，缺少完整 IEND。PNG 输出必须通过独立结构/解码验证后再交付。

建议优先把它作为量化器，配合可验证的 PNG writer（或量化后由 Canvas 生成有效 PNG，需实测压缩收益）；如要 vendor 新版编码器，需另行修复模块和 Worker 环境假设并保留 MIT 声明。无损模式保留原素材字节作为基线，有损结果不更小时回退基线；尺寸缩放必须与颜色量化分开表达，不能把“质量 80%”当成确定的 PNG 参数或节省比例。

## 包、许可证与导入

- npm registry 的 latest 是 **2.1.0**，发布日期 **2017-12-12**，main 为 `UPNG`，MIT，依赖 `pako ^1.0.5`；无内置 TypeScript 类型。发布 gitHead 为 `5e5af183a3dda1e320b90a1830b3f64bc92010d4`。本次读取实际 tarball 中 `UPNG.js` 为 **31,508 bytes（未压缩源码，不含 pako，不是最终 bundle 体积）**。[npm metadata](https://registry.npmjs.org/upng-js)、[确切发布包](https://registry.npmjs.org/upng-js/-/upng-js-2.1.0.tgz)
- 官方 master 的 package.json 已写 **2.2.0**，不能把 master API/修复当成已发布的 2.1.0 功能。[master package.json](https://github.com/photopea/UPNG.js/blob/master/package.json)
- MIT 允许修改与分发，但分发时需保留版权和许可文本；这不是要求公开本项目源码。[官方 LICENSE](https://github.com/photopea/UPNG.js/blob/master/LICENSE)

Vite 项目建议使用 npm bare import，交给打包器处理 CommonJS，而非把上游脚本当原生 ESM：

```ts
import UPNG from 'upng-js'

// 概念演示：encode 有下文所述发布版缺陷，不可直接照搬上线。
const rgba = new Uint8Array(width * height * 4)
const bytes = UPNG.encode([rgba.buffer], width, height, 256)

// 2.1.0 的内部量化 API（与 master 不同）：
const result = UPNG.quantize([rgba.buffer], 256, false)
const quantizedRgba = result.bufs[0]
```

发布版通过 `module.exports = UPNG` 与 `require('pako')` 导出。Vite 5 官方说明开发使用 esbuild、生产使用 CommonJS 插件转换依赖，因此默认导入是合理接入方式；**这是源码与文档支持的集成建议，本研究没有宣称已在本项目完成 Vite dev/build/Worker 验证**。本项目还需本地类型声明或核验后的外部类型，且 pako 1.x 可能与已有 2.x 同时进入依赖图。[发布源码](https://github.com/photopea/UPNG.js/blob/5e5af183a3dda1e320b90a1830b3f64bc92010d4/UPNG.js)、[Vite 5.0.12 官方说明](https://github.com/vitejs/vite/blob/v5.0.12/docs/guide/dep-pre-bundling.md)

## 参数与透明度

公开 `encode(imgs, w, h, cnum, dels?)` 接收 RGBA8 帧 ArrayBuffer 数组，静态 PNG 只传一帧；返回 PNG ArrayBuffer。`cnum = 0` 表示不做颜色量化，`256` 表示允许有损调色板压缩，**不是质量百分比、压缩等级或只保留 256 个 RGB 值且完整保留 alpha**。最多颜色数可能未用满。[官方 Encoder 说明](https://github.com/photopea/UPNG.js#encoder)

2.1.0 的 `quantize` 对预乘透明度后的四维 RGBA 聚类，最终 alpha 也来自聚类中心。它支持半透明，但不保证每个像素 alpha 原样保留；低色数可能影响阴影、辉光、渐变与抗锯齿边缘。不要在调用 encode/quantize 前自行再次预乘，内部已经处理。`roundAlpha = false` 避免主动把 alpha 阈值化为 0/255，却不代表 alpha 不参与量化。[发布源码：quantize / alphaMul / estats](https://github.com/photopea/UPNG.js/blob/5e5af183a3dda1e320b90a1830b3f64bc92010d4/UPNG.js)

## 发布版真实探针与边界风险

探针在内存下载、解包 npm `upng-js-2.1.0.tgz` 与 `pako-1.0.11.tgz`，通过 Node vm 加载两者 CommonJS；没有安装包或写文件。输入 `RGBA = [255, 0, 0, 128]`，宽高 1×1：

| cnum | 输出 bytes | 末尾 12 bytes（hex） | 完整 IEND |
| --- | ---: | --- | --- |
| 0 | 104 | `0082008177cd72b600000000` | 缺失 |
| 256 | 104 | `0082008177cd72b600000000` | 缺失 |

原因：2.1.0 encode 仅预分配 `bufs[0].byteLength * bufs.length + 100` 字节，而头、调色板和压缩块可能超过该空间；最终 slice 不能补回越界丢失字节。这是**本次从发布包执行得到的实验结果**，不是猜测的浏览器差异。使用项目 pako 2.x 的另一轮探针也复现，不能靠升级 pako 解决。[发布包](https://registry.npmjs.org/upng-js/-/upng-js-2.1.0.tgz)、[pako 1.0.11 发布包](https://registry.npmjs.org/pako/-/pako-1.0.11.tgz)

由此提出的回归要求：1×1/2×2/4×4、纯透明、半透明渐变、高熵素材；逐块检查 PNG 长度/CRC/IEND，并用独立解码器验证尺寸与像素。不能只用 UPNG 自己 decode 来证明自己的输出有效。

## Worker 与内存建议

编码和量化 API 都是同步函数，没有内建 Worker、取消或进度接口。直接调用会占用所在 JS 线程；包装 Promise 不会迁移工作。2.1.0 通过打包后的 CommonJS 路径可以避免 `window` 分支；直接 `importScripts` 加载裸源码则会触发 `window.UPNG`，不能认为天然兼容 Worker。master 源码还有大数据分支 `window.UZIP`，也须独立处理。[发布源码](https://github.com/photopea/UPNG.js/blob/5e5af183a3dda1e320b90a1830b3f64bc92010d4/UPNG.js)、[master 源码](https://github.com/photopea/UPNG.js/blob/master/UPNG.js)

量化需要 RGBA 工作副本、拼接缓冲与输出等，不能只按压缩文件大小估算内存；单张 4096×4096 RGBA 已是 64 MiB，峰值还会更高（推算，不是性能实测）。建议逐素材串行处理、限制总像素数、检查 cancellation 于素材之间；需要中止单次计算时终止专用 Worker。只 transfer 新建工作缓冲，不可 detach 编辑器仍持有的原素材。以上是依据源码分配行为提出的集成策略，不是库自身提供的保障。
