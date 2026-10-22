# 语音链路实验记录

本目录记录语音输入链路（识别、前处理、后处理）的**实测实验**，与 `docs/proposals/` 的分工是：

- `docs/proposals/` —— 方案与决策（做什么、为什么）
- 本目录 —— 实验的过程与读数（**量到了什么**，包括没量到的）

实验记录的价值一半在结果，一半在**哪些结论被证伪、哪些假设还没被解释**。所以每份记录都必须包含「未解释 / 未验证」一节，且不得用未经测量的机制去补因果链的洞。

## 协议（新增实验必须遵守）

1. **配对比较，不跨运行比较。** 所有条件在同一批片段上跑；某个条件少返回一条就缩小配对集合，而不是和另一个集合比。每条读数旁边打印 `n`。
2. **必须有能红的负对照。** 一个永远为绿的判据没有测量任何东西。本目录的 `flat`（去掉句末标点的同一个 prompt）就是这种对照：它必须**相对「只差被检验的那一个变量」的参照条件按预测方向移动**，否则那个解释不成立。预测必须在取数**之前**写下来，参照条件是哪一个由每份记录自己声明 —— 关键是**单变量**：`2026-09-22-voice-provider-paired-quality.md` 声明的参照是 `none`（在那一份里被测 provider 不接受上下文，`none`/`punct`/`flat` 三个条件发出去的请求逐字节相同，那一格的位移是采样噪声）；`2026-09-23-gemini.md` 声明的参照是 `punct`（那里上下文真的被接受，`none` 与 `flat` 之间换的是两个变量）；`2026-09-24-omni-written.md` 声明的参照是 `omni|raw`，对照条件是**同一条音的前 2 秒**（同一个 provider、模型、提示词、MIME，唯一变的是音），轴是语义判定的满分条数，方向 `down` —— 语料里那些事实分布在整句里，只剩开头的音装不下它们。
3. **被测实现必须是出货模块。** 用绝对路径 import 仓库里的实现（`src/shared/voiceTrim.ts`、`src/shared/identifierFidelity.ts`），**不得在工装里放第二份算法**。这条代价已经付过一次（AC-113 的旧判据量的是副本，与出货模块 16 条里 6 条不一致）。
4. **指标自己先自测。** 每个计数口径都要有若干已知答案的用例，包含**中文用例**。本目录的第一版蒙版正则在英文上正确、在中文上把整句删空 —— 只测英文会得到一个干净且完全错误的结论。
5. **不能拿参考文本当标点真值。** 语料脚本本身不带句末标点（`Change the timeout … to thirty seconds`），所以「标点准确率」不可计算，只能做条件间配对比较；标点**位置**是否合理靠人读配对文本判断。
6. **口径要写清楚是哪一个。** 本仓库存在两个 `identifierFidelity`（见下），数字不可跨口径比较。
7. **串行执行。** `groq.mjs` 的节流是**按进程**的（约 18.7 RPM）。两个 runner 并发会一起超过 Groq on_demand 的 20 RPM，把预算花在 429 重试上。
8. **结果落盘缓存**（`out/*-cache.json`），分析脚本从缓存重算，改口径不必重花请求。

## 已知的口径分歧（跨实验比较前必读）

| 口径 | 大小写/空格 | 同一批英文转写对的读数 |
|---|---|---|
| 工装 `tools/identifier-fidelity.mjs` | **不敏感**（`Use voice input` 算命中 `useVoiceInput`） | 77.8% (14/18) |
| 出货 `src/shared/identifierFidelity.ts` | **逐字敏感**（`Voice.service.ts` **不**算命中 `voice.service.ts`） | 33.3% (6/18) |

两者在 32 个片段里有 **8 个不一致**。`docs/proposals/voice-identifier-repair-and-temporal-compression.md` 里「英文标识符 77.8%」用的是**宽松口径**，不能与出货遥测（AC-114 打印的那个数）直接比较。本目录的表格一律用**出货口径**。

## 实验索引

| 日期 | 主题 | 文件 |
|---|---|---|
| 2026-09-22 | 标点：prompt 偏置与停顿上限 | [2026-09-22-voice-punctuation.md](./2026-09-22-voice-punctuation.md) |
| 2026-09-22 | 风格化：双向负对照（标识符逐字保留 ×「确实发生了」） | [2026-09-22-voice-style-negative-control.md](./2026-09-22-voice-style-negative-control.md) |
| 2026-09-22 | 配对质量：provider × 裁剪 × 上下文（n=8，含能红的负对照） | [2026-09-22-voice-provider-paired-quality.md](./2026-09-22-voice-provider-paired-quality.md) |
| 2026-09-23 | Gemini 配对质量：multimodal × 裁剪 × 上下文 × 模型（n=8，`pauseCues: 'useful'` 的证据记录） | [2026-09-23-gemini.md](./2026-09-23-gemini.md) |
| 2026-09-23 | **webm/opus 上传**的 ASR 候选：七个服务 × 裁剪 × 上下文 × 数字写法归一（n=8，单一运行，含能红的负对照） | [2026-09-23-webm-asr-candidates.md](./2026-09-23-webm-asr-candidates.md) |
| 2026-09-24 | **DashScope omni**（仓库里唯一 `style: 'written'` 的识别器）配对质量：omni × whisper 基线 × 裁剪（n=8，单一运行，含能红的负对照；`pauseCues: 'neutral'` 的证据记录） | [2026-09-24-omni-written.md](./2026-09-24-omni-written.md) |
| 2026-10-04 | **VAD 切分参数**（`endpointMs` / `maxSegmentSec`）：T1 合成真值单因素扫描（675 条时间线，15 格 ≥45）+ T2 CORAAL 人工标注 + T4 小样本识别确认（预算闸 ≤ ¥2；本次识别读数来自离线 fixture provider，真实服务待人工填价后执行） | [2026-10-04-voice-vad-sweep.md](./2026-10-04-voice-vad-sweep.md) |
| 2026-10-04 | **停顿切开对自我更正的影响**：4 脚本 × 3 停顿（2/5/10 s）× 整段/切开配对（每格 n=20，Wilson 95%，含能红的 swap-order 负对照；**真实 dashscope-omni 调用**，预算闸 ≤ ¥1）—— 切开全 0/60、整段全 60/60，选定 `flushSilenceSec = 10` | [2026-10-04-voice-pause-split.md](./2026-10-04-voice-pause-split.md) |
| 2026-10-06 | **客户端本地识别可行性（D2）**：真实 Chromium 里的 SenseVoice-Small int8（onnxruntime-web 1.30.0 + 自写前端），60 条片段、单线程 vs `--isolated` 4 线程、移动视口 390×844 与 4× CPU 节流；T1 RTF p90 · T2 二次打开 · T3 WASM 堆 · T4 ≥0.85 置信度一致率 四闸全过 = 桌面 **go**；真机**待外部** | [2026-10-06-voice-client-asr-probe.md](./2026-10-06-voice-client-asr-probe.md) |
| 2026-10-09 | **Realtime vs ASR→文本**的四类歧义 / world-model 配对理解质量：同批 24 条冻结语料（同音 6 · 自我更正 5 · 指代 5 · world-model 8）× 2 臂，单次运行；**A 10/24 · B 22/24**，7 条负对照全按预测方向移动（离线确定性替身，无 TTS、无 `--live`）；登记「bridge 工具集缺 `ui_selected_text`」 | [2026-10-09-voice-realtime-ambiguity.md](./2026-10-09-voice-realtime-ambiguity.md) |
| 2026-10-09 | **真实音频 paired 对比**：同一段真实 TTS 音频（30 条，16 kHz WAV）喂两条**真**臂——A 真实 DashScope ASR→文本 vs B 真实 `qwen3.8-omni-flash-realtime` + Task A bridge（模型自主 function call + 真实 executor 回填）；24 条冻结语料 × 2 臂 × 3 次，单次运行，**180 条真实付费读数**。**A 21/72 · B 32/72**；B 的优势几乎全在**指代类**（A 0/15 是**结构性**：A 无工具通道，0→7 量的是「有没有通道」不是「理解更好」），而**纯语言理解类（自我更正）B 反而更弱**（4/15 vs 6/15）；工具风险两类各 1 次（未按要求调用 · 参数幻觉）如实登记；7 条对照全按预测方向移动；无 `SUSPECTED_STAND_IN`；**8/72 条 Arm B 退化读数**（连接掉 / 45 s 超时 / 空正文）——**GO（有条件）**：值得另立案 `gap-voice-realtime-session-send-smoke`，不给「理解更好」 | [2026-10-09-voice-realtime-real-paired.md](./2026-10-09-voice-realtime-real-paired.md) |
| 2026-10-22 | **`dashscope-omni-relay` 的 `pauseCues` 证据继承**：同一服务/模型、同一条音频轴；relay 只改提示词与上下文位置，因此沿用 2026-09-24 的裁剪配对读数（不是一次新的音频轴运行） | [2026-10-22-omni-relay-pause-cues.md](./2026-10-22-omni-relay-pause-cues.md) |

## 工装

工装在仓库外 `/data/home/yale/work/tc-verify`（按 proposal 待确认问题 6 的既有决定，语料不入库）。

```bash
cd /data/home/yale/work/tc-verify

# 标点实验（读缓存，不联网）
node tools/test11-summary.mjs

# 停顿上限的成本侧（纯 DSP，不联网）
node tools/test9-caps-savings.mjs

# 新跑一个条件组合（联网，按条件数计请求）
LANG_TARGET=en LEVELS=all CONDS=raw,trimFrozen,trimMild node tools/test10-punct-run.mjs
```

| 文件 | 作用 |
|---|---|
| `tools/punct-lib.mjs` | WAV 编解码、标点口径、prompt 对、停顿表；import 出货模块 |
| `tools/test8-punctuation-prompt.mjs` | 首个 prompt 实验（英文，n=32） |
| `tools/test9-caps-savings.mjs` | 停顿上限的成本曲线（离线） |
| `tools/test10-punct-run.mjs` | 通用 runner，条件由 `CONDS` 选 |
| `tools/test11-summary.mjs` | 从缓存重算全部配对表 |

**未采纳的实验**：`LANG_TARGET` / `language` 参数。真实使用是混合语种，错误的语言判定比不判定更糟 —— 这是产品决定，不是测量结论。

### 仓库内工装（例外，逐条登记）

惯例是工装在仓库外（同上，针对的是**音频语料不入库**）。下面这一条**在仓库内**，理由逐条登记，不作为惯例的松动：

| 文件 | 作用 | 为什么在仓库内 |
|---|---|---|
| `experiments/voice-style-negative-control/run.mjs` | 风格化（`style: written`）的双向负对照：离线控制、反假变体、真实服务读数（见 [2026-09-22-voice-style-negative-control.md](./2026-09-22-voice-style-negative-control.md)） | 协议第 3 条要求被测实现是**出货模块**，仓库外的工装 `import` 不到 `src/shared/identifierFidelity.ts`；且该任务由 `## Touches` 指定了这个路径。它没有音频语料，真实读数落在被 git 忽略的 `out/` |
| `experiments/voice-provider-paired-quality/run.mjs` | provider × 裁剪 × 上下文的配对质量读数：离线重算配对表与负对照方向、七条自检变异、真实服务读数（见 [2026-09-22-voice-provider-paired-quality.md](./2026-09-22-voice-provider-paired-quality.md)） | 同上：协议第 3 条要求被测实现是**出货模块**（`src/shared/voiceTrim.ts`、`src/shared/identifierFidelity.ts`），且该任务由 `## Touches` 指定了这个路径 |
| `experiments/voice-gemini-paired-quality/run.mjs` | **Gemini** × whisper 基线 × 裁剪 × 上下文 × 模型的配对质量读数：同上协议、同一批片段、七条自检变异、真实服务读数（见 [2026-09-23-gemini.md](./2026-09-23-gemini.md)） | 同上，且更强：协议第 3 条在这里要求被测实现是**出货适配器**本身 —— 每个 Gemini 条件都经 `shared/asr/list/multimodal/multimodal.asr-provider.ts#transcribe`（由 registry 解析）发出，工装不包装 `fetch`、不自己拼请求；该任务由 `## Touches` 指定了这个路径 |
| `experiments/voice-webm-asr-paired-quality/run.mjs` | **七个候选服务 × webm/opus 上传 × 裁剪 × 上下文 × 数字写法归一**的配对质量读数：同一协议、同一批片段、七条自检变异、单一运行的真实服务读数（见 [2026-09-23-webm-asr-candidates.md](./2026-09-23-webm-asr-candidates.md)） | 同上前一条的理由，另加一条：本记录换的是**上传容器**，而容器转换必须由被测链路之外的工具完成并把字节钉住 —— webm 由主机 `ffmpeg`（`-fflags +bitexact -flags +bitexact`）编出，每条片段 × 每条裁剪列的 sha256 写进冻结快照、离线逐字节比对，缺 `ffmpeg` 就非零退出而**不**静默回退到 wav。OpenRouter/Groq 条件经 registry 解析出的出货 `openai-compatible` 适配器发出；DashScope 没有出货适配器，它的列在快照里如实标为 `runner-local wire (no shipped adapter)`；该任务由 `## Touches` 指定了这个路径 |
| `experiments/voice-dashscope-omni-paired-quality/run.mjs` | **DashScope omni × whisper 基线 × 裁剪**的配对质量读数：同一协议、同一批片段、七条自检变异、单一运行的真实服务读数（见 [2026-09-24-omni-written.md](./2026-09-24-omni-written.md)） | 同上前两条的理由（被测实现是出货模块、该任务由 `## Touches` 指定了这个路径），另加这一条特有的：它是 ADR-004 决策 1 **纪律那一半**的证据 —— `dashscope-omni` 声明的是非默认的 `pauseCues: 'neutral'`，而 `scripts/asr-trim-capability-check.mjs` 的 `discipline` 检查要的是**这个服务自己**的成对测量，所以记录必须落在这条跑得起来的路径上。omni 条件一律经 registry 解析出的出货适配器 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#transcribe` 发出（工装不包装 `fetch`、不自己拼请求），裁剪列的音由出货 `src/shared/voiceTrim.ts#trimVoiceAudio` 产生，语义判定经 `experiments/voice-omni-written/raw/judge.mts#judge` **import**（不抄第二份 rubric）；探针与自检连线在 `<run.mjs> --probe` |
| `experiments/voice-client-asr-probe/{index.html,probe.mjs,serve.mjs}` | 客户端本地识别（D2）探针：真实浏览器里跑 SenseVoice-Small int8 的读数 + T1–T4 判定（见 [2026-10-06-voice-client-asr-probe.md](./2026-10-06-voice-client-asr-probe.md)） | 协议第 3 条要求被测实现是**出货规格**：前端必须与项目自己的 `experiments/voice-index-loop/sv/svlib.py`（v5/v6 的「自写前端」）逐帧一致（fbank 410 帧逐位相等、LFR+CMVN `max|Δ| = 1.7e-5`），规格抄到仓库外就断了这条对照；且读数必须在**真实浏览器**里经 `window.__probe` 取（jsdom / node 的 wasm 不算），仓库外工装起不了这个被测页。它**没有**任何音频 / 模型权重 / 构建产物入库：`serve.mjs` 从 `VOICE_PROBE_CLIPS_DIR` / `MODEL_DIR` 外挂挂载，下载物与读数 JSON 落在被 git 忽略的 `.cache/` |
| `experiments/voice-realtime-ambiguity/run-real.mjs` | **真实音频** paired 对比：A 臂经出货 ASR 适配器、B 臂经 Task A 的出货 transport + bridge（`qwen3.8-omni-flash-realtime`）自主 function call；离线从冻结快照重算四类读数 / 工具行为（含「未按要求调用」与「工具/参数幻觉」两类）/ 三节点延迟 / 7 条负对照 / 三项自检变异（见 [2026-10-09-voice-realtime-real-paired.md](./2026-10-09-voice-realtime-real-paired.md)） | 同上前几条：协议第 3 条要求被测实现是**出货模块**——A 臂必须经 `shared/asr/asrRegistry.ts#resolve('dashscope-omni')` → 出货适配器 `#transcribe`，B 臂必须经 `server/modules/voice-realtime/index.ts#connect` + `voice-realtime-dashscope-transport.ts#createDashscopeTransport`，工装**不**包装 `fetch`、**不**自己拼 ASR 请求、**不**自己路由 function call；且该任务由 `## Touches` 指定了这个路径。`--probe` 断言这些路径都在**出货树内、且不在工装内**，并自扫源码里没有第二份 ASR 请求构造（`FORBIDDEN_LITERALS`） |

```bash
# 离线负对照 + 正面控制（无网络，确定性）
node experiments/voice-style-negative-control/run.mjs

# 真实服务读数（联网 + 凭据，串行，写 out/style-cache.json）
node experiments/voice-style-negative-control/run.mjs --live

# 只读缓存重算（无网络）
node experiments/voice-style-negative-control/run.mjs --replay

# 配对质量：离线从冻结快照重算全部读数 + 负对照方向 + 七条自检变异（不联网）
node experiments/voice-provider-paired-quality/run.mjs

# Gemini 配对质量：同一批片段，被测实现是出货的 multimodal 适配器（不联网）
node experiments/voice-gemini-paired-quality/run.mjs

# 只打印所驱动的出货模块的绝对路径 + 符号名（AC：被测实现必须是出货模块）
node experiments/voice-gemini-paired-quality/run.mjs --probe

# webm 候选配对质量：离线从冻结快照重算全部读数 + 负对照 + 七条自检变异（不联网）
node experiments/voice-webm-asr-paired-quality/run.mjs

# 同上，只打印所驱动的出货模块的绝对路径与符号名，并断言冻结快照里没有 wav 上传记录
node experiments/voice-webm-asr-paired-quality/run.mjs --probe

# 把每条片段 × 每条裁剪列编码成 webm 并打印请求计划（要 ffmpeg；不联网、不用凭据）
node experiments/voice-webm-asr-paired-quality/run.mjs --live --dry-run

# DashScope omni 配对质量：同一批片段，omni 条件经出货适配器、裁剪列经出货 trimVoiceAudio（不联网）
node experiments/voice-dashscope-omni-paired-quality/run.mjs

# 同上，只打印所驱动的出货模块的绝对路径与符号名，并断言 runner 里没有第二份请求构造或 rubric
node experiments/voice-dashscope-omni-paired-quality/run.mjs --probe

# 客户端本地识别探针（D2）：起静态服务后，用**真实浏览器**打开并调 window.__probe
node experiments/voice-client-asr-probe/serve.mjs              # 默认（无 COOP/COEP，单线程）
node experiments/voice-client-asr-probe/serve.mjs --isolated   # COOP/COEP（4 线程）
# 取数前置：JS 前端必须与 svlib.py 逐帧一致（见实验记录 §3），不一致就不取数

# 真实音频 paired 对比：离线从冻结快照重算四类读数 + 工具行为 + 延迟 + 负对照 + 三项自检变异（不联网）
node experiments/voice-realtime-ambiguity/run-real.mjs

# 同上，只打印所驱动的出货模块的绝对路径与符号名，并自扫源码里没有第二份 ASR 请求构造
node experiments/voice-realtime-ambiguity/run-real.mjs --probe

# 真实付费取数（联网 + 凭据 + 花钱；串行；每取完一条语料就落一次缓存，可断点续跑）
set -a; . .env.test; set +a
node experiments/voice-realtime-ambiguity/run-real.mjs --live          # 续跑（读 out/ 缓存）
node experiments/voice-realtime-ambiguity/run-real.mjs --live --fresh  # 从零
node experiments/voice-realtime-ambiguity/run-real.mjs --freeze        # 冻结到 fixtures/real-paired.json

# 三个自检变异（都必须非零退出）
node experiments/voice-realtime-ambiguity/run-real.mjs --corpus=empty
node experiments/voice-realtime-ambiguity/run-real.mjs --control=inverted
node experiments/voice-realtime-ambiguity/run-real.mjs --runs=straddle
```

### 仓库内**音频**（例外，逐条登记）

音频语料不入库是常态（`experiments/voice-trim/fixtures/*.wav` 是本项目里唯一既有的例外）。第二、三条例外登记在这里，理由与第一条同形：

| 文件 | 作用 | 为什么在仓库内 |
|---|---|---|
| `experiments/voice-provider-paired-quality/fixtures/d01..d08-o65.wav`（8 条，3.9 MB） | 配对质量实验的固定片段 | 冻结快照 `fixtures/paired.json` 里的**每个数字**（句读、CER、标识符、`savedRatio`、音频哈希）都要能在这个仓库里离线重算，而重算必须**重新解码原始音频**（对应关系检查还会用出货模块重新编码并比对 sha256）。语料全集（o65 档 16 条 × 多档）仍在仓库外，只有这 8 条固定片段进来 |
| `experiments/voice-omni-written/fixtures/webm/n01..n05-o65.webm`（5 条，1.2 MB） | qwen3.8-omni-flash 书面化与上下文实验的扩展片段（路径、自我更正、指代、否定四类） | 这 5 条没有 wav 母本在仓库里，webm 本身就是唯一的原件：`raw/e-ctx-ext.jsonl`、`raw/e-ctx-real.jsonl`、`a2/results.jsonl` 的全部读数都是把它们原样上传得到的，重新取数必须用同一批字节。参考文本在 `fixtures/ext-refs.json` |
| `experiments/voice-realtime-ambiguity/fixtures/audio/*.wav`（30 条，3.3 MB） | GOAL-029 冻结的 24 条语料 + 6 条有音频的负对照的**真实 TTS 音频**（`zh-CN-XiaoxiaoNeural`，16 kHz 单声道 WAV，由 `script` 合成） | 「**同一段音频**喂两条真实臂」是本任务的**字面被测变量**。若音频母本只在仓库外，冻结快照 `fixtures/real-paired.json` 里每条的 **sha256** 就无法在本仓库离线重算，paired 的「同一条音」也就不可机检（协议第 1 / 7 条）。语料**文本**早在 `fixtures/`（GOAL-029），这里只补音；`out/*-cache.json` 被 git 忽略，入库的只有音频 + 冻结读数 |

`fixtures/paired.json` 是**读数原文**不是缓存（缓存 `out/` 被 git 忽略）—— 记录里的表格全部由它离线重算，`--live` 取新读数才需要凭据。

这 8 条片段**一份语料一个家**：Gemini 的记录（`experiments/voice-gemini-paired-quality/`）与 omni 的记录（`experiments/voice-dashscope-omni-paired-quality/`）都**不复制**它们，两者从 `../voice-provider-paired-quality/fixtures/` 原地读音频与参考文本，并在自己的冻结快照里记下每条片段 × 每条音频列的 sha256 —— 离线重算时会用出货模块重新编码并逐字节比对，所以「三份记录的数字在同一批片段上」这句话是可机检的，而不是靠人记得。跨记录比较前仍请读上面那条口径分歧。

