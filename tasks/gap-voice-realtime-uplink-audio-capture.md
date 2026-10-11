---
id: gap-voice-realtime-uplink-audio-capture
title: Live Voice 上行音频采集落盘：每连接一段原始上行音频（正确 WAV 头）+ 与 journal 同源的端点判定时间线，供后续 VAD
  离线评分（默认关、有界、可一键清空、fail-open、纯本机）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-11 逐文件复核，带 file:line；写前逐条重读，仍成立）

**采集点已经存在。** `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:972-986` 处理每一个 `frame.type === 'audio'` 的浏览器帧：自增 `audioFramesFromBrowser`，打一条 250 帧的心跳日志（`:976-978`），然后 `frame.seq === undefined` 走连续线 `bridge.sendAudioFrame(frame.audio)`（`:980`），否则把帧计入 `segmentFrameCounts` 走分段线 `bridge.sendSegmentAudio(frame.seq, frame.audio)`（`:983-984`）。这就是**完整的连续麦克风流（含静音）**——正是 VAD 研究要的原料，且已经在服务端手上。

- `bridge.sendAudioFrame`（`server/modules/voice-realtime/voice-realtime-bridge.service.ts` 内，把一帧作为 `input_audio_buffer.append` 转发）在 upstream socket 非 `open` 时**丢弃**该帧。
- **编码**：浏览器发 `JSON.stringify({ type:'audio', audio: encodePcm16Base64(frame.samples, frame.sourceRate) })`（`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:194-195`；`encodePcm16Base64` 定义在同文件 `:175-186`，输出 base64 PCM16、按页面自己的 `sourceRate`）。所以存 WAV 必须记**真实采样率**（或重采样到同一 canon），否则后续分析全被采样率比值带偏。
- **两个要镜像的先例，都在盘上读过**：
  - 非实时部署采集：`server/modules/voice/voice-capture.ts`，env `VOICE_CAPTURE` / `VOICE_CAPTURE_RAW`，目录默认 `~/.cloudcli/voice-capture`（`resolveVoiceCaptureDir` `:565-575`），目录 0700 / 文件 0600（`:369-372`），文件 `<captureId>.bin`；本机最新文件 2026-10-07。
  - 实时中继 journal（2026-10-10 落地）：`server/modules/voice-realtime/voice-realtime-log.ts`，目录默认 `~/.cloudcli/voice-realtime-log`（`resolveVoiceRealtimeLogDir` `:189-200`），0700/0600（`:61-62`），env `VOICE_REALTIME_LOG_DIR` / `VOICE_REALTIME_LOG_MAX_BYTES`（`:73-74`），`DELETE /api/voice-realtime/log`（`voice-realtime.routes.ts:179-181`），它 **tee 整条 wire**（`server/index.ts:609-627` 的 `createVoiceRealtimeRecorder`）。

**决定性设计约束。** 只有音频无法给 VAD 打分：还必须在**同一时钟**上拿到端点自身的判定——`input_audio_buffer.speech_started` / `.speech_stopped` / `.committed`，以及逐段的 `seq` / 时长 / 帧数。journal 已经记下这条时间线（它 tee 了 wire 的 `observe` seam）。因此采集必须携带**共享时间原点**（connection id + 单调偏移），样本与判定事件才能离线对齐。**一份没有对齐判定时间线的采集不是可评分语料**——本任务不是「把音频存成文件」。

**运维现实。** 本机跑的是构建产物（`node dist-server/server/index.js`；2026-10-11 02:17 CST 做过一次 rebuild+restart，`dist-server` 里 journal + 分段中继 + turn-detection seam 已确认在）。所以「本地打开它」＝ env + rebuild + restart，而**重启该服务会杀掉操作者的实时会话**——本任务必须写明这点，且绝不把 restart 当作静默副作用。

### 隐私立场（写清以免被读成推翻 D8）

`docs/proposals/voice-realtime-segmented-relay-SPEC.md:23` 的 D8 明确不为想象中的安全风险设门槛（不脱敏、不保真校验、不默认关闭、不二次确认）；同一 SPEC 第 6 条目标（`:32`）把可观测列为目标。非实时兄弟路径选的是「local only + 一键清空」。本任务采**后者**的形状：这是音频、只留在本机、除非操作者打开否则 OFF、一键清空。它不改 D8 任何一条。

<!-- dedup-ref --> 机制去重（立案时实测）：`task_list({search:"voice capture audio relay"})`、`{search:"上行音频"})`、`{search:"语音采集"})`、`{search:"uplink"})`、`{search:"audio capture"})`、`{search:"VAD"})` 均 0 命中。相关但机制不同：`gap-voice-realtime-relay-log-persistence`（done）落的是**诊断日志/用量**（journal），本任务不改它，只对齐其形状并在 connection id 上与它共享；`gap-voice-turn-detection-pluggable-comparison-p0`（ready）是在既有 fixture 上做检测器对照研究，本任务为这类分析**产出**可评分语料、不重做它。本任务与二者机制不同、互不重复。

<!-- dedup-ref --> 合并候选（立案时按 Touches 文件核）：open 任务里 `gap-live-voice-delivery-state-visible`（todo，AC-327）也声明了 `voice-realtime-ws-proxy.service.ts`，调度器会据此把两者串行。判定 **separate**：两者机制不同（本条是上行音频的旁路采集，AC-327 是服务端交付状态的 outbound 帧）、验收相互独立、且 AC-327 已 todo 并绑定自己的 `goal_ac`；合并会把两个交付捆进一个任务。

### 方案

给实时中继一个**操作者自持、纯本机**的上行音频采集，镜像既有存储形状：默认 OFF、env 开关、**每连接一段原始上行音频文件（带正确 WAV 头）**，写在与 journal 同级的目录、以 connection id 绑定；按字节和/或年龄有界；一键清空；fail-open（写失败绝不打搅通话）；绝不外传。并因为用户的真实目的是后续分析（如 VAD），本任务还要确立**音频与 journal 判定时间线之间的对齐契约**，并用一次端到端离线 pass 证明它。

## Plan

1. **采集模块**（对齐 `voice-realtime-log.ts` / `voice-capture.ts` 的形状：小 writer + 注入 sink，从而单测不碰真实目录）：新增 `server/modules/voice-realtime/voice-realtime-audio-capture.ts`。对外一个 store：`appendFrame(base64, sourceRate, atMs)`、`timeline(event)`、`finalize()`、`clear()`、`directory()`；目录解析写成纯函数（入参显式给出、env 由组装点读），默认落在数据库同级（`resolveVoiceRealtimeCaptureDir`，与 `resolveVoiceRealtimeLogDir` 同形），可用 `VOICE_REALTIME_CAPTURE_DIR` 覆盖；目录 0700 / 文件 0600（显式 `chmod`，理由同 `voice-capture.ts:368-372`）；上限由 `VOICE_REALTIME_CAPTURE_MAX_BYTES` 覆盖，写入后按最旧优先逐出（可再叠加年龄轮转）。**默认 OFF**：`VOICE_REALTIME_CAPTURE` 未设、为 `off`、或无法识别 ⇒ 一个字节也不写、一个目录也不建（fail-closed，与该 store 既有的取值纪律一致）。**写入失败抛给调用方、由调用点吞掉**，模块自己不改变调用语义。
2. **接线到唯一组装点 + 共享 connection id**：`server/index.ts` 的 `buildVoiceRealtimeSeams`（`:399`）与 `voiceRealtime` handler（`:581`）。现在 handler 在 `:613` 用 `randomUUID()` mint 出 journal 的 `connectionId` 并喂 `createVoiceRealtimeRecorder`（`:609-617`）——把它**提成同一个变量**，既喂 journal 也喂本连接的音频采集，使两者的文件名/头由同一值派生。采集以一个**新的 seam**（如 `seams.captureAudio?` / `seams.captureTimeline?`）注入 proxy；proxy 不读 env、不自己建目录（沿用「env 归组装点」纪律）。`server/modules/voice-realtime/index.ts` 导出新模块以维持模块边界。
3. **在采集点落原始音频**：`voice-realtime-ws-proxy.service.ts:972-986` 的 `frame.type === 'audio'` 分支里，把 `frame.audio`（连续线那一路）与该帧的墙钟/相对偏移旁路喂给采集。**采集 OFF 时该分支逐字节不变**（wire 中立），采集 ON 时原帧照旧转发，采集是**旁路、不是替代**。WAV 头在 `finalize()` 时按第一帧的 `sourceRate` 与声道数写下（真实采样率）。
4. **对齐契约与判定时间线**：采集在同一 connection id 下（文件内嵌或同名 sidecar），记录**共享原点 t0**（首帧墙钟）与每个判定事件的**单调 ms 偏移**：端点 `speech_started` / `speech_stopped` / `input_audio_buffer.committed`（来自 `observe` seam 的上行 wire，与 journal 同源），以及逐段的 `seq` / 时长 / 帧数（来自 proxy 的 segment 线）。契约：`offset_ms(event) = event.wallClock − t0`，容差见 AC3。
5. **有界 + 一键清空**：store 的 `clear()` 经 `voice-realtime.routes.ts` 暴露 `DELETE /api/voice-realtime/capture`（与非实时 `DELETE /api/voice/data`、以及既有的 `DELETE /api/voice-realtime/log` 同形），删记录并返回条数，目录不存在返回 0。
6. **fail-open**：写入失败只记一次错误（stdout），调用继续；采集不得成为新的失败源。
7. **离线评分 pass**：新增 `scripts/voice-realtime-capture-score.mjs`，读一段采集（音频 + 时间线）与同名 journal，产出至少一个真实读数（端点判定偏移，或 commit 数 vs 某检测器提议数）；`--self-test` 覆盖合成语料。

## AC

- [x] AC1 默认 OFF 负控：`VOICE_REALTIME_CAPTURE` 未设时，一次连接后采集目录不存在或为空（注入 sink 从未被交付字节），**且**非实时 store 的目录（`resolveVoiceCaptureDir` 的 `~/.cloudcli/voice-capture`）零新文件。判据：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-audio-capture.test.ts` 退出 0。
- [x] AC2 一连接一段音频、头正确、权限对：采集 ON 时一次连接产出**恰好一个**音频文件，其 WAV 头记录的采样率/声道等于该连接第一帧的 `sourceRate`/声道，时长与收到的帧数一致；`stat -c %a` 读到目录 0700、文件 0600。判据：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-audio-capture-wiring.test.ts` 退出 0。
- [x] AC3 对齐契约（合成时间线）：一段合成曲线 + 合成判定时间线，`offset_ms(event) = wallClock − t0` 映射到音频偏移的误差 ≤ 一帧时长，且端点 `speech_stopped` 落在音频里对应的静音段内。判据：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-audio-capture-alignment.test.ts` 退出 0。
- [x] AC4 有界 + 一键清空：把上限设小（如 64 KiB），连续写 N 段后目录总字节 ≤ 上限、被删的是**最旧**的、最新一段仍在；`clear()` 删除记录并返回条数，目录不存在返回 0 且不报错；清空可从外部经 `DELETE /api/voice-realtime/capture` 触发（真实 express app + `http.request`）。
- [x] AC5 fail-open：注入一个必失败的 sink，同一次调用**仍然完成**（异常不抛到调用方），错误只被记录**恰好一次**（单测断言调用成功 + 恰一条错误日志）。
- [x] AC6 wire 中立（负控/回归守卫）：采集 OFF 时，经 proxy 送上游的帧序列与帧计数与改动前**逐位一致**——既有 `voice-realtime-ws-proxy.protocol-simulation.test.ts` 不改动仍通过，且新增断言在 OFF 下 fake upstream 收到的 `input_audio_buffer.append` 数不变。
- [x] AC7 离线 pass 自检 + 静态门：`node scripts/voice-realtime-capture-score.mjs --self-test` 退出 0，对合成采集产出至少一个读数（端点判定偏移或 commit 数）；`npm run typecheck` 退出 0；新增 server 测试文件后 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0（同步钉子与 `scripts/suite-duration-baseline.tsv`）。

## DoD

真实落地判据（DIR-026 读法 A：真的有一个对象被这套机制操作过，文件/fixture 存在是必要但不充分）：在本机**真实**开启采集（env + rebuild + restart——⚠️ 重启会杀掉操作者的实时会话，须先声明、并作为最后一步执行），跑**真实 Live Voice 连接**，在磁盘上留下**真实音频语料**与**对齐的判定时间线**；然后**一次端到端离线 pass**（`scripts/voice-realtime-capture-score.mjs --capture <该连接>`）读取这段采集、产出**至少一个真实读数**（如 commit 数 vs 某检测器提议数，或端点自身的判定偏移），使「我们现在有可评分数据」是被演示的而不是被断言的。若真实运行因重启/上游凭据/会话不可得而未完成，如实写明并 park，不得以单测/夹具冒充。

## Touches

- server/modules/voice-realtime/voice-realtime-audio-capture.ts (new)
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/voice-realtime.routes.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-audio-capture.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-audio-capture-wiring.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-audio-capture-alignment.test.ts (new)
- scripts/voice-realtime-capture-score.mjs (new)
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-realtime-uplink-audio-capture.md (self)

## 验证记录（2026-10-11，worker 实测）

AC1–AC7 全部实测通过；DoD 的真实落地判据在本机**真实跑通**，未以单测/夹具冒充。

- **AC1**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-audio-capture.test.ts` → 5/5 pass。OFF 负控：注入 sink 零交付、采集目录未创建、非实时 store 目录（`resolveVoiceDataDir`）也未创建，且部署根下 `walk()` 一个文件都没有。（`resolveVoiceCaptureDir` 未由 voice barrel 导出，深导入会破坏「跨模块只走 barrel」纪律且会碰到 Touches 之外的文件，故用 barrel 导出的 `resolveVoiceDataDir` + 全根 `walk()` 做更强的「一处都没写」断言。）
- **AC2 + AC6**：`…/voice-realtime-audio-capture-wiring.test.ts` → 2/2 pass。一次连接恰好一个 WAV，头采样率 = 首帧 `sourceRate`（24000，不是后来那帧的 48000）、声道 1、时长 = 帧数 × 20 ms；目录 0700 / 文件 0600；同连接 OFF vs ON 两次跑，上游收到的帧列表 `deepEqual`（wire 中立）。
- **AC3**：`…/voice-realtime-audio-capture-alignment.test.ts` → 1/1 pass。合成曲线：`offset_ms = wallClock − t0` 精确成立，映射到的音频偏移 ≤ 一帧，`speech_stopped` 落在曲线静音段内。
- **AC4**：于 AC1 文件内（相关用例 pass）。64 KiB 上限下写 4 段后目录 ≤ 上限、最旧**整**连接（wav + timeline 一起）被逐出、最新段完好；`clear()` 返回连接条数、目录不存在返回 0；经真实 express + `http.request` `DELETE /api/voice-realtime/capture`。
- **AC5**：于 AC1 文件内（1/1 pass）。必失败 sink 下调用不抛、错误恰好记一条（含原因）。
- **AC6（既有回归）**：`…/voice-realtime-ws-proxy.protocol-simulation.test.ts` 未改动，13/13 pass。
- **AC7**：`node scripts/voice-realtime-capture-score.mjs --self-test` 退出 0，对合成采集产出读数（`endpoint-committed=1 detector-proposals=1 matched=1/1`）；`npm run typecheck` 退出 0（root + server + scripts 三段）；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0（钉子 282 / 284；`scripts/suite-duration-baseline.tsv` 追加 3 行并把标头覆盖数更新为 256/282）。合并 develop 后上述全部门禁复跑仍绿。

### DoD 真实落地（真跑，未重启操作者的服务）

不重启操作者的 :3001（那会杀掉其实时会话），而用**同一份工作树源码**在**备用端口 :3971** 起一个独立实例：`VOICE_REALTIME_CAPTURE=on VOICE_REALTIME_CAPTURE_DIR=/tmp/vrc-capture VOICE_REALTIME_LOG_DIR=/tmp/vrc-log`。真实 DashScope 上游（服务端日志：`session.created` → `session.updated`，voice=Tina），把一段**真实语音**（`experiments/voice-realtime-ambiguity/fixtures/audio/co-01.wav`，16 kHz 单声道 PCM16）按 20 ms 帧入流。端点真实转录回执「把这一段改成async的。」，并真实触发 VAD。

**盘上真实产出**（connection id `2214a759-3c67-4425-b3df-57d3374971e8`，目录 0700 / 文件 0600）：

- `2214a759-….wav`（144640 字节 PCM16 16 kHz 单声道）
- `2214a759-….timeline.jsonl`：`origin offsetMs=0` → `speech_started=1005` → `speech_stopped=3115` → `committed=3115`（`itemId=item_AHssOpqSTNv62NrQq6lzn`）→ `final frames=226 dataBytes=144640 durationMs=4520`

**端到端离线 pass**（`node scripts/voice-realtime-capture-score.mjs --capture <该 wav>`，退出 0）：

```
capture=<…>.wav rate=16000 channels=1 durationMs=4520
endpoint started=1 stopped=1 committed=1 segments=0
detector proposals=1
match 1/1
offset speech_started=1005ms speech_stopped=3115ms committed=3115ms
reading endpoint-committed=1 detector-proposals=1 matched=1/1
utterance 1005ms..3115ms
```

即：真实音频与**同钟**的端点判定时间线都在盘上，离线 pass 产出真实读数（端点 commit 数 1 vs 检测器提议数 1，且二者重叠）。采集件副本留存于 `/data/home/yale/work/vrc-dod-capture/`（`/tmp` 会被回收）。备用实例已关闭，操作者的 :3001 未受影响。