---
id: gap-voice-server-vad-three-arm-replay-on-third-test-corpus
title: 服务端 VAD 只做上行 PCM 的 speech/non-speech 过滤：三臂同源实验（A 全量 / B 仅滤无语音 / C 只观察全量上传）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

人 yale 2026-10-13 裁定（**本任务的唯一职责定义**）：

> **「服务端 VAD」唯一职责是对上行 PCM 做 speech / non-speech 分类，过滤无语音音频帧，减少传到 Realtime upstream 的音频数据。**

**绝不**（硬禁令，违反即本任务失败）：

- 不引入 turn detection / endpointing / 语义提交 / `response.create`；
- 不改变 Realtime 上游的 `turn_detection` 参数或其检测时机；
- **不把服务端 VAD 的边界事件用于模型触发、commit 或任何 Claude Code 操作**。

即：它是**纯传输侧的节流器**，与"什么时候算说完"完全正交。

**素材已核验存在**（本轮只读查证）：第三次实测（journal/连接 `af5559c0`）有完整可回放素材——原始音频 `~/.cloudcli/voice-realtime-capture/af5559c0….wav`（PCM16/16000 Hz/单声道，11,925,120 数据字节 = **372.66 s 连续**）、同 id `timeline.jsonl`（`origin` 声明时间基；18×`speech_started`/`speech_stopped`/`committed`，带 `offsetMs`+`itemId`；`final` 与 WAV 逐位吻合）、以及同 id voice journal 里的 `session_send`（**模型转发文本，不是 CLI transcript**）。来源对应：capture `committed` 18 ↔ `transcription.completed` 18 ↔ `session_send` **13**。

**耦合检查已完成（本轮代码查证，必答项）**：

- `localSpeechGate`（`server/modules/voice-realtime/voice-realtime-local-speech.ts`，proxy :1454 建）→ `reportLocalSpeechBoundary`（:1459）→ 看门狗。**只观察不裁剪**。
- `silenceTail`（`server/modules/voice-realtime/voice-realtime-silence-tail.ts`，proxy :1665 建）→ :3322 的 `decision.frames` 决定转发哪些帧。**这才是会过滤的那个**。
- 两者**各自 `observe()` 同一帧，互不喂对方**；STS 决策**不进入** `reportLocalSpeechBoundary`，也**不进入**任何 commit / `response.create` 路径。
- 唯一相邻接触是 STS 分支内的 `bridge.noteLocalActivity?.()`（注释：a suppressed stretch is not an idle one）——那是**为切断误读而做的解耦**，不是泄漏。

⇒ **结论：`reportLocalSpeechBoundary` / watchdog 是既有旁路，明确不纳入本任务的"服务端 VAD"功能范围**；STS 与它无功能耦合，无需解耦，但实现与报告里必须把它标注为旁路，不得把它的边界事件算作本功能的行为。

**必须如实报告的风险（人点名）**：长时间不向上游发送数据会导致 upstream 断线；本功能应使用**不改语义的必要 keepalive**。⚠️ 但既有读数是：上游空闲超时是**按 response 计**的——`~300 s` 无 **response** 即 `1007 response_idle_timeout`，而**连续上传底噪 297.6 s 同样不重置**（见 `[[upstream-realtime-idle-timeout-is-response-based]]`）。因此"发连续静音 PCM 当 keepalive"可能与节流目标冲突**且未必有效**；若实验显示需要连续静音才能存活，**如实写明这个冲突**，不得为了保住节流数字而隐瞒。

## Plan

1. 实验脚本：复用 `experiments/voice-realtime-large-append-probe/probe.mts` 的骨架（raw WS / 手动 commit / usage 计费 / JSONL journaling），读源 WAV，按实时墙钟逐 20 ms 帧推进。
2. **A**：完整 PCM 原样上传（第三次实测的生产形态即 A，其读数可直接引用，无需重跑）。
3. **B**：只用**出货的** `createSilenceTailGate` 做 speech/non-speech 过滤（探针内构造，**不改任何生产环境变量**）；不得附加任何 endpointing / commit / response 副作用。
4. **C**：同一 gate **只观察**——决策被记录，但**所有 PCM 原样上传**（对齐 `localSpeechGate` 的既有旁路语义）。
5. 三臂同源：同一 WAV、同一起点、同一 excerpt 长度、同一 `turn_detection`、同一 instructions/tools、同一采样率。
6. 记录并报告 keepalive 需要与否及其与节流目标的冲突。

## AC

- [ ] AC1 **职责边界是判据**：实验脚本与报告**不得**出现由服务端 VAD 边界事件触发的 `response.create` / commit / `turn_detection` 变更；取假形态：让 B 臂的边界事件驱动一次 `response.create` ⇒ 对应断言红。
- [ ] AC2 三臂跑同一源音频、同一起点、同一 excerpt；`npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-vad-three-arm/probe.mts --work /tmp/vad3` 退出 0 并产出 `snapshot.json`。
- [ ] AC3 **C 臂证明"只观察"**：其上传帧数与字节数与 A 臂**逐帧逐字节相等**，同时决策被记录；取假形态：让 C 也过滤 ⇒ AC3 红。
- [ ] AC4 六项指标齐备 × 三臂：**上行发送帧/字节**、**误删语音**（对源 timeline 的 speech 区间）、**前滚保留**、**时延**（首 token / 首次 `function_call`）、**转发保真**（对源语料句数）、**连接存活**。
- [ ] AC5 **keepalive 如实报告**：记录 B 臂是否出现"长时间不发送导致 upstream 断线"，以及所用 keepalive 是否改变语义；若需要连续静音 PCM 才能存活，**必须写出这与节流目标的冲突**（取假形态：为保住节流数字而隐去该冲突 ⇒ 红）。
- [ ] AC6 报告中 `localSpeechGate` / watchdog 被**显式标注为既有旁路**，且其边界事件未被计入本功能行为。
- [ ] AC7 成本时长上限生效并实测记录：`--cap` 每连接 CNY、总上限、excerpt ≤ 90 s、单次运行；写出实际花费与时长。
- [ ] AC8 未改生产配置、未重启 :3001（pid 前后相同）；除上游本身外零外联。
- [ ] AC9 读数不足时写「不足以判断」，不得把不足写成结论。

## DoD

在**同一份真实上行音频**上，A/B/C 三臂的上行发送量、误删语音、前滚保留、时延、转发保真与连接存活读数齐备；服务端 VAD 被证明（或被证否）为**纯传输侧过滤**——即：它减少上行数据，且**不改变** `turn_detection`、不触发 `response.create`、不参与任何 commit 或 Claude Code 操作；`localSpeechGate`/watchdog 被标注为旁路；keepalive 的需求与其同节流目标的冲突被如实写明。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts (new)
- docs/operations/voice-realtime-vad-three-arm-probe.md (new)
- tasks/gap-voice-server-vad-three-arm-replay-on-third-test-corpus.md

## Notes

**查重**：AC-362（continuous 校准 C-1..C-6 单次读数）无配对臂；AC-363（STS 真实探针 V-1..V-8）**已有两臂配对**（V-7）但语料为脚本内构造、**无 C 臂**、未用本次真实语料；AC-364 是产品实现（开关默认关）。本任务增量＝真实语料 + 第三臂 + 误删语音/前滚/keepalive 分解；**不得**重跑或改写 AC-362/363 既有报告。

**范围纪律**：本任务**不改生产默认值**（`VOICE_REALTIME_SILENCE_TAIL` 默认仍为关），不在探针外构造 gate，不把 STS 与任何 endpointing 语义绑在一起。若实现中发现 STS 与 `reportLocalSpeechBoundary` 存在耦合，**先解耦或标注为旁路再谈实验**，不得带着耦合做读数。