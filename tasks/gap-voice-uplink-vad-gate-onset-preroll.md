---
id: gap-voice-uplink-vad-gate-onset-preroll
title: Live Voice 上行 VAD 门控加起音回补（pre-roll）：起点前回补最近被丢的 P 帧，修 80–100 ms 削头
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**来源：2026-10-14 傍晚第七次 Live Voice 实测**（连接 `af12cbaf-9ca7-4218-b0c3-d371ec16ee1d`；服务端 `VOICE_REALTIME_UPLINK_VAD=silero`；server build gitSha `d7766ded5`）。人问："这段音频在服务端 VAD 的处理情况怎么样，实际发给 realtime 模型的音频有多长？"读数如下。

**离线重放与服务端逐帧一致。** 本次上行录音 `~/.cloudcli/voice-realtime-capture/af12cbaf-….wav`（16 kHz 单声道，13684 帧 = 273.7 s）用同一个 silero 模型、同样的参数重放：512 样本窗加 64 样本上下文、阈值 0.5、`aFrames` 21、"最后覆盖窗"归属。得到 `sent=3454 headKept=801 dropped=10230`，与服务端 journal 的 `uplink_vad summary: browserFrames=13684 sent=3454 headKept=801 dropped=10230` 逐项相同。实际发给 realtime 的音频是 **69.1 s（25%）**；上游 server_vad 的语音窗合计 70.5 s，基本吻合。浏览器上行中 73% 的帧是数字零（浏览器/OS 侧已在静音）；被丢的非零帧只有 571 帧（11.4 s），多为低电平尾巴。

**缺陷：门控没有 pre-roll，会削掉起音。** `voice-realtime-uplink-vad-gate.ts` 的三条规则是：语音帧发送；语音后的静音只保留前 `aFrames` 帧；其余丢弃。语音起点之前**没有任何回补**，silero 判晚的那几十毫秒直接丢掉。在 31 次起音中，被丢的高于 -45 dBFS 的帧大多 ≤20 ms，但有 3 次达到 80–100 ms：
- offset 56.76 s（09:52:53.8Z，"再改成十秒"，ASR 转成"大概能十秒"）
- 66.78 s（09:53:03.8Z，"哦"）
- 227.28 s（09:55:44.3Z，"那现在这个 queue…"）
浏览器侧开门是平滑的：78 次零→非零跳变中，没有一次首帧超过 -40 dBFS，所以缺口只在服务端门控这一层。

**改法。** 在门控里加起音回补：保留最近 `P` 个被丢弃的帧（环形缓冲，帧的原始字节）；遇到"上一帧被丢、本帧判为语音"时，先按原顺序发出这 `P` 帧，再发本帧。
- `P` 默认 10 帧（200 ms），以毫秒派生，写法与 `uplinkHeadKeepFrames` 并列（例如 `uplinkPreRollFrames`）；部署可调，但不必为此新增环境变量。
- 第一次说话之前同样回补（首段静音整段丢弃的规则不变，只是起音前补 `P` 帧）。
- **不重复**：已经作为 `send-head-kept` 发出的帧不进缓冲；静音间隔短于 `aFrames + P` 时，只补真正被丢的那部分。
- **不合成**："只发调用方自己的 base64、从不构造帧"这一结构性质保持不变。
- stats 新增 `preRoll` 计数，`uplink_vad summary:` 行追加 `preRoll=N`（在 `voice-realtime-ws-proxy.service.ts:3983` 附近），原有字段逐字保留。
- 代价估算：本次 31 次起音 × 0.2 s ≈ 6.2 s，约占已发送量的 +9%。

**验收要用真实代码重放，而不是另写一份 Python 实现**：在 `experiments/voice-uplink-vad-preroll-replay/replay.mts` 里，用 `createUplinkVadGate` + `createUplinkVadClassifier`（silero 后端，权重取 `VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH`）逐帧驱动 wav，输出 summary 和逐起音读数。用 `npx tsx --tsconfig=server/tsconfig.json …` 运行（必须是等号形式，空格形式会静默不执行）。录音是人的语音数据，**不得复制进仓库**，只能以路径参数读取。

<!-- dedup-ref --> **相关任务与粒度决定**：granularity 工具未发现 Touches 重叠的开放任务（peers=[]）。与 `gap-voice-relay-busy-hold-host-rounds-and-queue-visibility` 共享 `voice-realtime-ws-proxy.service.ts`，但改的是不同的位置（这里只动 summary 日志行），机制和验收都独立，所以分开立；调度器会按 Touches 串行。门控模块 `voice-realtime-uplink-vad-gate.ts` 没有被任何既有 AC 用字面 grep 钉住，可以直接改原文件，不必另起同级文件。

## AC

- [x] AC1（单元：回补正形态）：`server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts` 新增用例，用脚本化分类器按以下序列驱动：非语音 ×30 → 语音 ×5 → 非语音 ×(aFrames+P+5) → 语音 ×3。断言：第一个语音帧之前恰好多发 `P` 帧，并且是**被丢弃的最后 P 帧、原顺序、字节逐一相同**；第二次起音同样回补 `P` 帧；没有任何帧被发出两次；`stats.preRoll === 2P`。`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts` 退出 0，pass 数记入 `## Notes`。
- [x] AC2（单元：短间隔不重复）：同一文件有一个用例，静音间隔 < `aFrames + P`：回补帧数等于该间隔中真正被丢的帧数（可能为 0），所有发出的帧 index 严格递增且无重复。随 AC1 的同一命令退出 0。
- [x] AC3（假形态）：临时把 `P` 改为 0，单跑 AC1 的测试文件，AC1 用例**必须红**；复原后再变绿。红、绿读数逐字记入 `## Notes`（改动不提交）。
- [x] AC4（summary 可审计）：`grep -n "preRoll=" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 有输出，并且 `grep -n "uplink_vad summary: browserFrames=" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 仍有输出（原前缀未改）。
- [x] AC5（真实代码重放本次录音）：`experiments/voice-uplink-vad-preroll-replay/replay.mts` 已提交；`npx tsx --tsconfig=server/tsconfig.json experiments/voice-uplink-vad-preroll-replay/replay.mts ~/.cloudcli/voice-realtime-capture/af12cbaf-9ca7-4218-b0c3-d371ec16ee1d.wav` 退出 0，并且：(a) 以 `--preroll-ms 0` 运行时，输出逐字含 `sent=3454 headKept=801 dropped=10230`（与服务端 summary 一致，证明重放的保真度）；(b) 默认 `P` 运行时，offset 56.76 s / 66.78 s / 227.28 s 这三次起音前被丢的高于 -45 dBFS 的帧都 ≤20 ms，总发送秒数较 (a) 增加不超过 12%。两次输出逐字记入 `## Notes`。录音文件不存在时，**不得**改用合成音频凑数，停手 needs-human。
- [x] AC6（不削弱既有判据）：`npm run typecheck` 与 `npm run lint` 各自退出 0；按 AGENTS.md 加载 `$backend-module-standards`；单跑 `server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts` 和 `server/modules/voice-realtime/tests/voice-realtime-uplink-vad-arm-point.test.ts` 退出 0。

## DoD

生产门控（`createUplinkVadGate`）在每次语音起点前，把真实丢弃的最近 `P` 帧原样回补给上游，不合成、不重复。证据是用这份生产代码和真实 silero 分类器重放第七次实测的真实录音：基线逐字复现服务端当时的 summary，开启回补后，三处被削 80–100 ms 的起音不再被削，额外上行代价在 +12% 以内。另有单元正形态、假形态两组读数。人下一次实测的 journal summary 会出现 `preRoll=` 计数（观察项，不作为执行侧 AC）。

## Touches

- server/modules/voice-realtime/voice-realtime-uplink-vad-gate.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad-arm-point.test.ts
- experiments/voice-uplink-vad-preroll-replay/replay.mts
- tasks/gap-voice-uplink-vad-gate-onset-preroll.md

### Touches 增补说明（执行侧）

`server/modules/voice-realtime/tests/voice-realtime-uplink-vad-arm-point.test.ts` 是**入库后**才发现的必需的第六个文件（原 Touches 里没有，属执行侧的真实产物，故经 task ABI 补声明，不手改）。原因：`preRoll` 是 `UplinkVadGateStats` 的**必填**字段，proxy 里那行兜底字面量 `const stats = uplinkVadStats ?? { sent: 0, headKept: 0, dropped: 0, bypassed: 0, preRoll: 0 };` 必须随之加 `preRoll: 0`；arm-point 的 AC4 假形态把这一**整行**当 anchor 钉住唯一性，于是它必须同步更新。同时它的 AC4 数值读数按新语义重锚（回补帧计入 `sent`/`preRoll`、不再计入 `dropped`）——该任务的 AC4 只要求「有一行汇总、字段覆盖 sent/headKept/dropped/bypassed」，不钉数值，所以这是**如实重锚**而非削弱。

## Notes

### AC1 / AC2（单元正形态）

```
$ npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts
✔ AC1 — an onset replays the last P dropped frames, byte for byte and in order, and never twice
✔ AC2 — a gap shorter than `a + P` replays only what was actually dropped, never a head-kept frame
ℹ tests 27
ℹ pass 27
ℹ fail 0
```

`P` = `uplinkPreRollFrames(UPLINK_VAD_PRE_ROLL_MS=200)` = 10 帧。

### AC3（假形态：把 `P` 改为 0）

把 `UPLINK_VAD_PRE_ROLL_MS` 临时由 `200` 改为 `0`（**未提交**，已复原），单跑同一文件：

```
✖ AC9 — the first non-speech segment is dropped whole BUT FOR the pre-roll tail before the onset
✖ AC9 — a LAGGING classifier preserves the order: the gate buffers rather than guesses
✖ AC1 — an onset replays the last P dropped frames, byte for byte and in order, and never twice
  AssertionError [ERR_ASSERTION]: the default P is the 200 ms budget at 20 ms/frame
✖ AC2 — a gap shorter than `a + P` replays only what was actually dropped, never a head-kept frame
  AssertionError [ERR_ASSERTION]: exactly the frames this gap dropped are replayed, no more
ℹ tests 27
ℹ pass 23
ℹ fail 4
```

复原为 `200` 后再跑：`ℹ tests 27 / pass 27 / fail 0`（绿）。红/绿两次读数如上；该改动不提交。

### AC5(a) — `--preroll-ms 0`（基线，逐字）

```
$ npx tsx --tsconfig=server/tsconfig.json experiments/voice-uplink-vad-preroll-replay/replay.mts ~/.cloudcli/voice-realtime-capture/af12cbaf-9ca7-4218-b0c3-d371ec16ee1d.wav --preroll-ms 0
voice-uplink-vad-preroll-replay: wav=/data/home/yale/.cloudcli/voice-realtime-capture/af12cbaf-9ca7-4218-b0c3-d371ec16ee1d.wav
  frames=13684 (273.68 s)  weights=/data/home/yale/work/voice-vad-engines/silero/silero_vad.onnx
  tested P=0 ms (0 frames); baseline P=0

[baseline] uplink_vad summary: browserFrames=13684 sent=3454 headKept=801 dropped=10230 bypassed=0 preRoll=0

onsets: 63 (speech starts after a non-speech run); 7 still have >20 ms of >-45 dBFS audio dropped before them

the three onsets the 7th live test clipped (baseline P=0 → tested P=0):
  onset @ 56.76 s (frame 2838): baseline loud dropped 100 ms → tested 100 ms (459 dropped total, 0 replayed)
  onset @ 66.78 s (frame 3339): baseline loud dropped 80 ms → tested 80 ms (450 dropped total, 0 replayed)
  onset @ 227.28 s (frame 11364): baseline loud dropped 100 ms → tested 100 ms (1798 dropped total, 0 replayed)

cost: baseline sent=3454 (69.1 s), P=0 sent=3454 (69.1 s); +0.0 s = +0.0%
(P=0: the tested arm IS the baseline — AC5(b) onset/cost checks do not apply to this run)
voice-uplink-vad-preroll-replay: done (exit 0)
```

退 0；输出逐字含 `sent=3454 headKept=801 dropped=10230`，与服务端 journal 逐项相同。

### AC5(b) — 默认 `P`（逐字）

```
$ npx tsx --tsconfig=server/tsconfig.json experiments/voice-uplink-vad-preroll-replay/replay.mts ~/.cloudcli/voice-realtime-capture/af12cbaf-9ca7-4218-b0c3-d371ec16ee1d.wav
voice-uplink-vad-preroll-replay: wav=/data/home/yale/.cloudcli/voice-realtime-capture/af12cbaf-9ca7-4218-b0c3-d371ec16ee1d.wav
  frames=13684 (273.68 s)  weights=/data/home/yale/work/voice-vad-engines/silero/silero_vad.onnx
  tested P=200 ms (10 frames); baseline P=0

[baseline] uplink_vad summary: browserFrames=13684 sent=3454 headKept=801 dropped=10230 bypassed=0 preRoll=0
[P=200] uplink_vad summary: browserFrames=13684 sent=3690 headKept=801 dropped=9994 bypassed=0 preRoll=236

onsets: 63 (speech starts after a non-speech run); 4 still have >20 ms of >-45 dBFS audio dropped before them

the three onsets the 7th live test clipped (baseline P=0 → tested P=200):
  onset @ 56.76 s (frame 2838): baseline loud dropped 100 ms → tested 0 ms (449 dropped total, 10 replayed)
  onset @ 66.78 s (frame 3339): baseline loud dropped 80 ms → tested 0 ms (440 dropped total, 10 replayed)
  onset @ 227.28 s (frame 11364): baseline loud dropped 100 ms → tested 0 ms (1788 dropped total, 10 replayed)

cost: baseline sent=3454 (69.1 s), P=200 sent=3690 (73.8 s); +4.7 s = +6.8%
voice-uplink-vad-preroll-replay: done (exit 0)
```

退 0。三处点名起音被丢的高于 -45 dBFS 的帧均降到 0 ms（≤20 ms）；总发送秒数 +6.8%（≤12%）。`P=200` 行里 `sent` 由 3454 升到 3690（+236=preRoll）、`dropped` 由 10230 降到 9994（−236）——回补帧从 `dropped` 移入 `sent`，`sent + dropped` 仍 = browserFrames。

### AC4（summary 可审计）

```
$ grep -n "preRoll=" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
4088:          `preRoll=${stats.preRoll} ` +
$ grep -n "uplink_vad summary: browserFrames=" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
4086:        `uplink_vad summary: browserFrames=${audioFramesFromBrowser} sent=${stats.sent} ` +
```

原前缀未改。另：arm-point 的 AC4 汇总腿在同一次运行里断言到 `preRoll=5`（首段 5 帧被回补）。

### AC6（不削弱既有判据）

```
$ npm run typecheck        → exit 0
$ npm run lint             → exit 0（仅既有 warning）
$ npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts
  ℹ tests 10 / pass 10 / fail 0
$ npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-uplink-vad-arm-point.test.ts
  ℹ tests 28 / pass 28 / fail 0
```

已按 AGENTS.md 加载 `$backend-module-standards`（改动全在既有 feature module `server/modules/voice-realtime/` 内，无新跨模块 import、无新 barrel 面）。

### 实现要点

- 门控：`UPLINK_VAD_PRE_ROLL_MS=200` + `uplinkPreRollFrames(ms)`（与 `uplinkHeadKeepFrames` 并列）；`UplinkVadGateOptions.preRollMs`（默认出货值，`0` 关闭）；`UplinkVadGateStats.preRoll`；`UplinkVadGate.preRollFrames` 读数。环形缓冲在**每次发送时清空**，因此只可能装「以本次起音结尾的那段静音run里被丢的尾部」——短间隔只补真正被丢的部分，`send-head-kept` 的帧永不入环、永不重放，补出的帧就是调用方自己的 base64（不合成）。
- 语义：回补帧从 `dropped` 移到 `sent`（`preRoll` 是 `sent` 的细分），于是 `sent + dropped` 仍逐帧划分全部被判帧，且与字节账 `droppedBytes = In − Out` 自洽。
- proxy：`uplink_vad summary:` 行在 `bypassed=` 后追加 `preRoll=${stats.preRoll} `；兜底字面量同步加 `preRoll: 0`。

### 未做 / 边界

- 未改任何 env 接线（task 明说不必新增环境变量）；生产 arm 点仍由既有 `VOICE_REALTIME_UPLINK_VAD` 路径提供。
- 未重启 `:3001`、未改线上 `.env`。
- 残留：默认 `P` 下仍有 4 处起音「起音前被丢的 >-45 dBFS 帧 >20 ms」（基线 7 处）；这三处点名起音已归零。这些残留是**其它**起音形态（间隔很长、被丢的响亮帧多于 P），不在本 AC 的判据内，留待观察。
