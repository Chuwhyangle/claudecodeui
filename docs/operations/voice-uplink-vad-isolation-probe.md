# 上行 VAD 三后端本机权重 / ABI 隔离实测

本文件由 `experiments/voice-uplink-vad-isolation-probe/probe.mts` **生成**，请勿手改（手改会在下次运行探针时被覆盖）。

探针走 `voice-realtime-uplink-vad.ts` 的**默认**加载路径（动态 `import()` + `statSync`，不传任何 `loadDependency` / `weightsExist` seam），对 Silero / TEN / WebRTC 三个后端各取一次真实读数，并把结果归档在这份文档里。

生成时刻：`2026-10-14T00:19:42.943Z`

## 复现

```bash
npx tsx --tsconfig server/tsconfig.json experiments/voice-uplink-vad-isolation-probe/probe.mts --report-only /tmp/uplinkvad-iso
```

## 1. 三后端状态表

| 后端 | 生产默认臂 status（无 weightsPath） | 权重（只读探测） | 权重臂 status | 5 帧分类形状 | classify/flush verdict 数 |
| --- | --- | --- | --- | --- | --- |
| silero | unavailable — no weights path was configured for the silero backend | 命中 `/data/home/yale/work/voice-vad-engines/silero/silero_vad.onnx` | available | ok (verdict 形状合法) | 3 + 2 = 5 |
| ten | unavailable — no weights path was configured for the ten backend | 命中 `/data/home/yale/work/voice-vad-engines/ten-vad/ten-vad.onnx` | available | ok (verdict 形状合法) | 4 + 1 = 5 |
| webrtc | available | 无需权重 | n/a — webrtc has no weights to resolve | ok (verdict 形状合法) | 5 + 0 = 5 |

### 1.1 逐后端细节

**silero**

- 生产默认臂（`createUplinkVadClassifier({ backend: 'silero' })`）：`unavailable — no weights path was configured for the silero backend`
- 权重候选（只读 `statSync` 探测，按序取首个命中的普通文件）：
  - `/data/home/yale/work/voice-vad-engines/silero/silero_vad.onnx` — 命中
  - `/data/home/yale/silero-vad-probe/silero_vad.onnx` — 未命中
- 权重臂（`weightsPath = /data/home/yale/work/voice-vad-engines/silero/silero_vad.onnx`）：`available`
- 5 帧真实 PCM16：classify 返回 3 条 verdict，flush 返回 2 条，合计 5 条 = 帧数；classify 返回 `null` 的推入下标：0, 2。
- verdict 形状：ok (verdict 形状合法)

**ten**

- 生产默认臂（`createUplinkVadClassifier({ backend: 'ten' })`）：`unavailable — no weights path was configured for the ten backend`
- 权重候选（只读 `statSync` 探测，按序取首个命中的普通文件）：
  - `/data/home/yale/work/voice-vad-engines/ten-vad/ten-vad.onnx` — 命中
- 权重臂（`weightsPath = /data/home/yale/work/voice-vad-engines/ten-vad/ten-vad.onnx`）：`available`
- 5 帧真实 PCM16：classify 返回 4 条 verdict，flush 返回 1 条，合计 5 条 = 帧数；classify 返回 `null` 的推入下标：0。
- verdict 形状：ok (verdict 形状合法)

**webrtc**

- 生产默认臂（`createUplinkVadClassifier({ backend: 'webrtc' })`）：`available`
- 权重：WebRTC 检测器是编译进包的 C 实现，**不需要权重文件**。
- 5 帧真实 PCM16：classify 返回 5 条 verdict，flush 返回 0 条，合计 5 条 = 帧数；classify 返回 `null` 的推入下标：（无）。
- verdict 形状：ok (verdict 形状合法)

## 2. 权重路径现状（如实记录）

> **权重路径不受本仓库管理，没有生产代码指向它。**

本仓库不 check in 任何 `.onnx` 权重；`voice-realtime-uplink-vad.ts` 里 Silero / TEN 的 `weightsPath` 是**必填项**，而生产代码里**没有任何地方**给它赋值——所以这两个后端在「生产默认臂」下如实报告 `unavailable`（原因 `no weights path was configured …`）。

本机能找到的 `.onnx` 权重（若上表有命中）位于用户 `$HOME` 下的实验目录，例如 `/data/home/yale/silero-vad-probe/` 与 `/data/home/yale/work/voice-vad-engines/`。这些是**探针/测例自行指路的实验副本**，不受本仓库管理、不被任何生产代码引用；探针把它们当作**只读的权重臂输入**用来验证「ABI + 加载路径能跑」，⛔ 不把它读作「生产权重已就位」。

## 3. 运行时 / 包版本 / ABI 匹配

- node：`v24.21.0`；npm：`11.19.0`
- 平台/架构：`linux-x64`；`process.versions.modules`（node ABI）：`137`

| 包 | 版本 |
| --- | --- |
| onnxruntime-node | 1.30.0 |
| sherpa-onnx-node | 1.13.8 |
| webrtcvad | 1.0.1 |

| 已编译绑定产物 | 存在 |
| --- | --- |
| `node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node` | 存在 |
| `node_modules/webrtcvad/build/Release/vad.node` | 存在 |

**ABI 结论**：`onnxruntime-node` 出的是 N-API（napi-v6）绑定，N-API 是跨 node 版本的 ABI 稳定面，因此它对 `process.versions.modules` 不敏感；`webrtcvad` 的 `vad.node` 是安装期用 node-gyp 针对本机 ABI 编出来的。两者都在本机（未碰 `:3001` 的独立子进程里）成功 `require()`/加载——上表「存在」列与三后端 status 列共同构成这条结论的机械读数。

## 4. ":3001 未重启" 证据

- 探针开始时监听 :3001 的 pid：`2908057`
- 探针结束时监听 :3001 的 pid：`2908057`
- 前后一致：`yes`

- 探针未改任何生产 env、未新建/未写任何 `.env*` 文件：仓库根 `.env*` 的 mtime 前后一致：`yes`

| `.env*` | mtimeMs（前） | mtimeMs（后） |
| --- | --- | --- |
| .env.example | 1791936996939.5476 | 1791936996939.5476 |

## 5. 零外联证据

探针静态扫描（构造判据，非自述）：对探针自身源码与被审计模块源码抽取**字面量 import 说明符**，断言无一是网络模块；并扫描若干全局逃逸口 token，断言零命中。

| 文件 | import 说明符 | 其中网络模块 | 全局逃逸口 token 命中 |
| --- | --- | --- | --- |
| `experiments/voice-uplink-vad-isolation-probe/probe.mts` | `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:url` | 无 | 0 |
| `server/modules/voice-realtime/voice-realtime-uplink-vad.ts` | `node:fs` | 无 | 0 |

## 6. 边界与未做

- ⛔ 未下载任何模型权重；缺权重如实记 `unavailable`。
- ⛔ 未触碰 `server/`、`src/` 的生产代码路径（本任务只新增 `experiments/` 与 `docs/`）。
- ⛔ 未重启 `:3001`、未改生产 env、未写任何 `.env*`。
