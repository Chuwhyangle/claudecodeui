# voice-kit SPEC —— 把语音处理与识别抽成可开源的 workspace 包，并加入浏览器端说话人分离

状态：Draft / 待评审
决策输入：人 yale 2026-10-04（见「已确认的决策」）
关系：

- 建立在 `adr/ADR-004`（ASR provider 缝）与 `docs/proposals/voice-asr-provider-seam.md` 之上；本 SPEC 不改写它们的决策，只把它们的产物搬进包里。
- 取代 `docs/proposals/voice-vad-trim-before-asr.md` 中「裁剪模块位于 `src/shared`」的位置假设（行为不变）。
- diarization 的路线（V1→V3）来自 2026-10-04 的讨论；其中对 Community-1 的尺寸、ONNX Runtime 平台支持等外部事实**尚未核实**，列入「未核实的前提」，在阶段 2 开工前必须逐条证实或证伪。

---

## 已确认的决策

| # | 决策 | 含义 |
|---|---|---|
| D1 | 形态：先 **npm workspaces**，同仓库 `packages/*` | 边界稳定后再拆独立仓库；import 路径在拆分前后不变 |
| D2 | **对外开源** | 许可证审计是硬前置；仓库内不得带真实录音、密钥、内部路径 |
| D3 | **(Mobile) Web 优先** | 第一个可用目标是手机浏览器本地跑通；Android native 不在本 SPEC 范围，但接口不得堵死它 |
| D4 | **宿主后端继续持有 provider 密钥** | kit 的浏览器侧任何 API 都不接受、不存储、不转发 provider 密钥 |

## 目标

1. 现有语音输入 / 识别能力（ASR provider 缝、裁剪、采集、解码、播放、服务端路由工厂）以包的形式存在，宿主通过依赖导入使用，**行为零变化**。
2. 新增浏览器端本地 diarization：会议录音期间只做轻量采集（VAD + embedding + 时间戳），结束后全局聚类，得到说话人数量与时间线。
3. diarization 时间线能与 ASR 分段对齐，输出「谁在什么时候说了什么」。
4. 有可重复的评测台（DER + 资源占用），任何版本的 diarizer 都能在冻结语料上跑出同口径读数。
5. 包可被第三方在不依赖本宿主的情况下安装和使用。

## 非目标

- 不在本 SPEC 内移植完整 pyannote.audio / 复刻 Community-1 行为一致（V3 才逼近，且不承诺逐字一致）。
- 不做 Precision-3 本地化（它是云服务）；可以作为评测基线或可选的云端精修适配器。
- 不做 Android / iOS native 实现。
- 不改宿主的设置页、i18n、Composer 按钮、数据库表结构（它们留在宿主，经端口接入）。
- 不在本 SPEC 内改变现有 provider 的选择逻辑与裁剪策略。

---

## 包划分

```
packages/
├─ voice-kit-core      纯 TS，不碰 DOM / Node API
├─ voice-kit-web       浏览器：采集、解码、播放、推理、Worker、存储
├─ voice-kit-server    Node：路由工厂、capture、provider 适配器的服务端调用
├─ voice-kit-models    模型清单（URL、SHA-256、许可证、尺寸）、下载与缓存、转换脚本
└─ voice-kit-eval      DER 评测台、冻结语料清单、实验 runner（不随运行时包发布）
```

| 包 | 内容 | 来源（现有代码） |
|---|---|---|
| core | asr 契约 / registry / 错误分类 / wire；trim；diarization 算法（聚类、时间线合并、与 ASR 对齐）；`ModelRunner` 接口 | `shared/asr/*`、`src/shared/voiceTrim.ts`；diarization 为新增 |
| web | `AudioCapture`（AudioWorklet）、解码、播放、`OrtWebRunner`、embedding 增量存储 | `audioDecode.ts`、`voicePlayer.ts`、`useVoiceInput` 中的采集部分 |
| server | `createVoiceRouter(deps)`、capture sink、upload 校验 | `server/modules/voice/*` |
| models | 模型 manifest 与加载器 | 新增 |
| eval | 评测台 | `experiments/voice-*` 的通用部分 |

**宿主保留**：设置页与 `voiceConfig` 的存取、`voiceSettingsDb`、i18n 文案、`Voice*Button.tsx`、鉴权、WebSocket、React hook 外壳。

### 依赖方向（硬约束，由 lint / 依赖检查强制）

```
core  ←  web
core  ←  server
core  ←  models  ←  web
core  ←  eval  →  (web | server | models)
宿主  →  任意 kit 包
kit 包  ↛  宿主（任何 `@/…` 路径、宿主的 db / api / i18n / React 组件）
core  ↛  DOM、Node 内建、任何网络
```

## 端口（宿主注入，kit 不自行读取外部状态）

| 端口 | 用途 | 替代现有的 |
|---|---|---|
| `SettingsPort` | 读取当前语音设置（provider id、模型名等**非密钥**部分） | `voiceSettingsDb`、`voiceConfig` 对 `api` 的依赖 |
| `SecretsPort`（仅 server） | 服务端解析 provider 密钥 | 服务端对设置表中密钥列的读取 |
| `LogPort` | 结构化日志 | `VoiceLogPort`（已有） |
| `AuthPort`（仅 web） | 取得访问宿主后端所需的凭据 | `getStoredAuthToken` |
| `StoragePort`（web） | 持久化 embedding 与录音元数据 | 新增，默认 IndexedDB 实现 |
| `ClockPort` | 可注入时钟（测试与评测） | 新增 |

服务端包只导出工厂，**自己不读 `process.env`**；`VOICE_CAPTURE*` 等环境变量仍由宿主的组合根读一次后以参数传入（沿用 `voice.module.ts` 现有约定）。

## 密钥规则（D4 的落地）

- web 包的 ASR 调用**只**打宿主后端的代理端点；没有任何接受 `apiKey` / `Authorization` 头的参数。
- 现有「直连模式」（浏览器持有 key 直连服务商）**不进入 kit**。它在宿主里是否保留、何时下线，是宿主自己的决定，不阻塞本 SPEC；kit 的 web API 不为它留口子。
- server 包的 provider 适配器经 `SecretsPort` 取密钥，密钥不进日志、不进 capture、不进错误对象（沿用 `voice-capture-secrets` 现有判据，随代码迁移）。
- 开源检查项：仓库中不得出现真实密钥、内部主机名、`/data/home/...` 之类路径（包括测试夹具与实验记录）。

---

## diarization 设计

### 推理抽象

```ts
interface ModelRunner {
  load(model: ModelRef): Promise<LoadedModel>;
  run(model: LoadedModel, inputs: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  dispose(): Promise<void>;
}
```

- core 里的算法只依赖 `ModelRunner`，不依赖 ORT。
- `web` 提供 `OrtWebRunner`（WASM 为基线，WebGPU 为可选加速）；`eval` 可提供 Node 实现以便离线跑评测。
- 这是为 Android native 留的口，不是现在要做的事。

### 两阶段流水线（手机友好）

**录音期（轻量、增量、可恢复）**

```
麦克风 → AudioWorklet → 16 kHz mono PCM
       → VAD → 语音窗口
       → embedding（每 ~0.5–1.5 s 一个窗口，静音不跑）
       → 追加 {t, dur, vector} 到 StoragePort，并同时写原始录音（Opus/AAC 或分块 PCM）
```

**结束后（一次性）**

```
全部 embedding → 全局聚类（自动估计说话人数）→ speaker timeline
              → 不确定区域回到原录音做精修（可选）
              → 与 ASR 分段按时间对齐 → 带说话人标签的转写
```

### 版本路线

| 版本 | 内容 | 退出条件 |
|---|---|---|
| V1 | VAD + embedding + AHC / 谱聚类 | 在冻结语料上给出 DER 与手机资源读数；与 Community-1 对比 |
| V2 | 加 segmentation 模型处理重叠语音；embedding 时排除重叠区 | DER 的差距主要来自重叠 / 边界时才启动 |
| V3 | VBx + PLDA + 全局调和 | 仅当 V2 与 Community-1 的差距仍有意义 |

升级由评测读数驱动，不由「更接近 pyannote」驱动。

### 与 ASR 的对齐（接口缺口）

`AsrCapabilities` 需新增对**分段 / 词级时间戳**的声明（有 / 无 / 粒度），`AsrSuccess` 在支持时返回分段时间戳。**现有适配器是否已返回时间戳尚未核实**；若多数 provider 不返回，对齐退化为「按 VAD 窗口切片后逐窗识别」，成本模型要重算（见 ADR-004 的计费下限）。这是阶段 2 的第一个待查项。

---

## Mobile Web 约束（D3 的落地）

| 约束 | 要求 |
|---|---|
| iOS Safari 无 WebGPU | **WASM 是基线**，WebGPU 只作 Android Chrome / 桌面的可选加速；任何功能不得以 WebGPU 为前提 |
| 多线程 WASM 需 `SharedArrayBuffer` | 需要 COOP/COEP 响应头；宿主能否加这些头会影响第三方嵌入（如跨源 iframe、图片）。**必须明确：单线程 WASM 能否满足实时预算**，否则这是宿主部署层面的改动 |
| 页面可能被冻结 / 杀死 | embedding 与录音**增量落盘**；重开页面能恢复并继续聚类，不丢已录部分 |
| 后台 / 锁屏 | 使用 Wake Lock（可用时），并在 UI 契约里声明「锁屏可能中断」的降级行为；不承诺后台持续录音 |
| 内存上限（移动 Safari 标签内存紧） | 模型按需加载 / 释放；主线程不持有长 PCM；推理在 Worker |
| 模型体积与首次加载 | 模型不进 npm 包；清单 + 运行时下载 + Cache API / OPFS 缓存；下载可断点、可校验哈希；首次加载进度可见 |
| 长录音（1–2 h） | embedding 序列体积与聚类复杂度要有上界：窗口数 N 的聚类要么 O(N²) 内存可承受，要么降采样 / 分层 |
| 电量 / 发热 | 评测台记录单位录音时长的 CPU 时间；设预算而不是事后观察 |

## 开源要求（D2 的落地）

- **许可证审计先于接入**：每个候选模型（Silero、WeSpeaker、pyannote segmentation / Community-1、ReDimNet2、3D-Speaker 等）逐个记录许可证、是否允许再分发、是否要求署名、是否有使用限制，写入 `voice-kit-models` 的 manifest。不确定的一律按「不可再分发」处理，改为用户侧下载。
- **仓库不带模型权重**。
- **评测语料**：只用公开可再分发的数据集，或合成语音（TTS）与已取得明确书面许可的录音。现有 `experiments/` 里的 fixture 逐个检查来源，不合格的留在宿主，不进 kit。
- **包自身许可证**与 NOTICE 在阶段 1 之前定下。
- 对外 README 说明：这是一个独立可用的库；宿主只是第一个使用者。
- 不得在文档或测试里出现个人邮箱、内部路径、内部任务编号的必需性引用。

---

## 迁移顺序

| 阶段 | 内容 | 退出判据（概要） |
|---|---|---|
| 0 | **就地划界**：不搬文件，加依赖规则，证明 `shared/asr`、`voiceTrim` 不依赖宿主路径 | 规则存在且当前全绿；故意加一条越界 import 会红 |
| 1 | 建 workspace 与 `core`，迁入 asr 契约与 trim；旧路径留 re-export 垫片；验证 `build:client`、`build:server`、`typecheck`、两套测试 | 宿主全量测试与构建无变化；垫片存在 |
| 2 | 建 `models`、`eval`；定 `ModelRunner`；补 ASR 时间戳能力声明；做 diarization V1 | 冻结语料上有 DER 读数与手机资源读数；核实全部「未核实的前提」 |
| 3 | 迁 `web` 采集 / 解码 / 播放；宿主 hook 改为薄外壳 | 现有语音输入 e2e 不变；增量落盘可恢复 |
| 4 | 迁 `server` 工厂，端口注入 | 现有 voice 服务端测试在包内通过；宿主集成测试通过；密钥规则判据仍成立 |
| 5 | 许可证、README、NOTICE、发布流程；评估拆独立仓库 | 第三方可在空项目里安装并跑通示例 |

**不并行迁移与新增**：阶段 1 完成前不开始 diarization 的代码，只做阶段 2 的「未核实前提」调研。

## 迁移期的仓库约束

- 旧路径垫片保留到所有引用旧路径的任务、判据、ADR 已更新或关闭为止；移除垫片是单独的一步。
- 迁移的 `*.test.ts` 与 `false-forms` 判据**随代码移动**，原位置只留宿主集成层仍需要的那几条。
- 每一阶段结束时，路径锚定的判据（行号窗口、`Touches`、grep 类）要逐条重新对齐，不靠「全量测试绿」代替。
- 新包遵循的模块标准（server 侧 / src 侧各自的 standards）需在阶段 1 前决定：建议 core / web 按前端标准，server 按后端标准，并在包内 README 写明。

## 未核实的前提（阶段 2 前必须逐条处理）

1. Community-1 各组件的实际体积与许可证（讨论中引用约 33.7 MB：embedding 26.6 / segmentation 5.9 / PLDA 0.13，**来源是讨论，未核实**）。
2. segmentation 与 WeSpeaker 能否无损转为 ONNX 并在 ORT-Web 的 WASM 上跑通，算子是否全部受支持。
3. ORT-Web 在 iOS Safari / Android Chrome 的 WASM 与 WebGPU 支持状态（讨论中的结论**未核实**）。
4. 单线程 WASM 下 embedding 的实时因子（每秒音频需要多少 CPU 秒）。
5. 现有 ASR 适配器是否返回分段 / 词级时间戳。
6. 现有 `experiments/` fixture 的来源与可再分发性。
7. npm workspaces 下，`tsc-alias` 后端构建与 vite 前端构建能否同时解析 workspace 包（阶段 1 的第一件事是做一个最小验证）。

## 风险

| 风险 | 缓解 |
|---|---|
| 搬文件使路径锚定的判据 / Touches / ADR 引用失效 | 垫片 + 分阶段 + 每阶段重新对齐；不一次性搬 |
| 手机上实时预算不达标 | 录音期只做 VAD + embedding；聚类放结束后；不达标则降低 embedding 频率，评测台给出读数 |
| 许可证阻止再分发某模型 | manifest 记录；改为用户侧下载；必要时换模型 |
| 多线程 WASM 需要宿主改响应头 | 先量单线程；若必须多线程，作为宿主部署层面的显式变更单独评审 |
| 开源后把内部信息带出去 | 阶段 5 前做一次全仓扫描；fixture 与实验记录逐个审 |
| 过早追求 Community-1 一致性 | 升级由 DER 差距驱动，V3 默认不做 |
