---
id: gap-voice-uplink-vad-real-prefix-a-and-exit-commit
title: 上行 VAD 改版实现：非语音段保留开头 a 的真实音频（段首段丢弃）、退出路径
  commit+response.create，deterministic 测试 + 真实 Realtime 复验
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-voice-uplink-vad-scheme-doc
---
## Proposal

把定稿方案（`docs/operations/voice-realtime-uplink-vad-scheme.md`）的第 5 节与第 6 节**实现并复验**。范围**刻意收窄**：只改实验侧的下行投喂实现，不碰生产默认值、不接线到服务端 continuous 路径。

**要实现的三件事**：

1. **非语音段保留开头 a 的真实音频**（取代现有的合成零样本补发）：后置滤波后每个非语音段的开头 `a` 毫秒原样转发真实样本，其余丢弃；`a` 由**解析后的** `turn_detection.silence_duration_ms` + 1 帧导出（不得写死）；**不合成任何样本**。
2. **段首段整段丢弃**：流开头、任何语音帧之前的非语音段不保留 —— 上游此时没有待闭合的东西。这是相对已验证变体的**刻意偏离**，必须单独复验。
3. **退出路径**：由**用户动作**（模拟退出）触发一次 `input_audio_buffer.commit` + `response.create`，随后有界等待 `input_audio_buffer.committed` / 转写 / 转发再关闭 socket。**这是「不发 response.create」的唯一有界例外**，作用域仅限退出；正常流的发送决策仍完全由「掩码 + 保留窗」决定，⛔ 不得由上游 VAD 边界事件触发任何提交。

**现状（已落地的旧形态）**：`experiments/voice-realtime-vad-three-arm/probe.mts` 的 `--vad-filtered` 目前用 `Buffer.alloc` 造**全零样本**补发，且**退出时不发任何帧**（`ws.close()` 收场）。

**查重**：`gap-voice-three-vad-filtered-pcm-real-upstream-replay`（done）是旧形态的实测，其读数保持有效但设计已被取代；本任务不复跑离线五方案对比、不复跑 STS 三臂回放。已确认没有其它非 done 任务承载这件事。

## Plan

1. 把门控逻辑从 290 KB 的 `probe.mts` 里抽成可单测的小模块 `uplinkVadGate.mts`：输入 = 逐帧掩码 + `aFrames` + 是否已见过语音；输出 = 每帧的动作（`send-real` / `drop` / `send-head-kept`）。纯函数、无 IO。
2. 按方案实现三条规则，并把 `a` 的导出接到**出货解析器**给出的 `silence_duration_ms`（不写死）。
3. deterministic 测试：段首段丢弃、每段只保留开头 a 且样本**逐字节等于原流**（非零样本）、`a` 跟随非默认 `silence_duration_ms`（假形态：写死 400 ⇒ 红）、短于 a 的段整段保留。
4. 退出路径：在 `--vad-filtered` 的收尾改为 `commit` + `response.create` → 有界等待 → 关闭；断言顺序，并断言退出后末句仍被转写/转发。
5. 真实 Realtime 复验：Silero 单臂 × 2 次重复（先验证规则成立），通过后再四臂 × 1 次；`a` 取解析值 + 1 帧。
6. 读数写进 `docs/operations/voice-vad-filtered-pcm-upstream-replay.md` 的新一节，并标注它取代该报告头部的合成零样本形态。
7. 经 Provider ABI 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [x] AC1 `experiments/voice-realtime-vad-three-arm/uplinkVadGate.mts` 存在，导出纯函数式门控；**不含任何 `Buffer.alloc` 造的零样本**。假形态：`grep -c "Buffer.alloc" <模块>` > 0 且用途是造补发样本 ⇒ 红。
- [x] AC2 deterministic 测试 `npx tsx --tsconfig server/tsconfig.json --test experiments/voice-realtime-vad-three-arm/uplinkVadGate.test.mts` 退出 0，且至少覆盖四条：段首段整段丢弃；非语音段保留开头 a；被保留的样本**逐字节等于原流对应位置**（证明不是合成）；短于 a 的段整段保留。逐条给出测试名与断言文本。
- [x] AC3 假形态（`a` 的导出）：把解析出的 `silence_duration_ms` 设为非默认值（如 800），断言保留窗随之变化；硬编码 400 的实现 ⇒ 该用例必须红。`## Evidence` 写出「写死版」确实读红的证据（把实现临时改成写死后该用例红，再改回）。
- [x] AC4 退出路径：实测日志显示顺序为 `input_audio_buffer.commit` → `response.create` → 等待 → 关闭；且退出后末句仍出现在 `transcription.completed` 中。假形态：把收尾改回直接 `ws.close()` ⇒ 该断言红。
- [x] AC5 ⛔ 正常流的发送决策**不得**由上游 VAD 边界事件驱动：`## Evidence` 给出该模块与探针里 `speech_started`/`speech_stopped`/`committed` 的全部引用点，并逐点说明它们只被读作读数、不进入任何发送分支。
- [x] AC6 真实 Realtime 复验：Silero 单臂 × 2 次先行；通过后四臂 × 1 次。每臂给出上行帧/字节（含被保留的段首字节）、transcribed 条数、forwarded 条数与文本、首 `function_call` 延时、上游错误数、最长无发送间隔、花费。
- [x] AC7 费用上限：单次连接 ≤ ¥0.05、本任务总计 ≤ ¥0.15；写出实际花费。时长上限：单次运行 ≤ 8 分钟。
- [x] AC8 生产默认值零改动：`git diff --name-only <fan-in 基线>..HEAD` 不含 `server/**` 与 `src/**`；`VOICE_REALTIME_SILENCE_TAIL` 仍为关。
- [x] AC9 不重启服务：运行前后 :3001 pid 相同，`## Evidence` 写出前后 pid。
- [x] AC10 与旧形态的对照：同一窗口下给出「旧（合成零样本，已实测）」与「新（真实开头 a）」的上行字节与转写条数对照；若新形态**更差**必须如实写出并停下，不得只报好的。

## Evidence

**AC1** — 模块 `experiments/voice-realtime-vad-three-arm/uplinkVadGate.mts`（提交 55bdca2b6）导出 `uplinkHeadKeepFrames`/`reduceUplinkVadFrame`/`planUplinkVadGate`/`materializeUplinkVadFrames`/`uplinkExitIsWellFormed` 等纯函数。`grep -c "Buffer.alloc" experiments/voice-realtime-vad-three-arm/uplinkVadGate.mts` = **0**；被保留的帧是 `pcm.subarray(start, start+frameBytes)` 的**视图**，从不合成。

**AC2** — `npx tsx --tsconfig server/tsconfig.json --test experiments/voice-realtime-vad-three-arm/uplinkVadGate.test.mts` ⇒ `ℹ pass 9 / ℹ fail 0`，退出码 0。逐条：
- 段首段整段丢弃：`test('段首段（任何语音帧之前的非语音）整段丢弃，一帧不留')` — `assert.deepEqual(actions.slice(0,10), Array(10).fill('drop'))` 且 `count(actions.slice(0,10),'send-head-kept')===0`；负对照 `test('负对照：把段首段换成相同长度的「已见语音」后置段…')` 断言同长度后置段保留 HEAD 帧（证明非空洞）。
- 非语音段保留开头 a：`test('每个非语音段只保留开头 a 帧，其余丢弃；每段独立重置')` — `assert.equal(summary.headKept, HEAD+HEAD+2)` 且 `assert.deepEqual(actions.slice(1,6), ['send-head-kept','send-head-kept','send-head-kept','drop','drop'])`。
- 逐字节等于原流：`test('被保留的样本逐字节等于原流对应位置，且非全零 —— 证明不是合成零样本')` — `assert.ok(frame.frame.equals(pcm.subarray(...)))` 且 `assert.equal(frame.frame.every(b=>b===0), false)`。
- 短于 a 整段保留：`test('短于 a 的非语音段整段保留（逐帧全发）')` — `assert.equal(count(actions,'drop'), 0)`。

**AC3** — 假形态证据：把 `uplinkHeadKeepFrames` 的实现临时改成 `return 21;`（写死 420 ms）后，跑同一测试文件得 `✖ a 由解析后的 silence_duration_ms 导出：400⇒21 帧/420 ms，800⇒41 帧/820 ms —— 写死即红` / `AssertionError [ERR_ASSERTION]: actual: 21, expected: 41` / `ℹ pass 8 / ℹ fail 1`，退出码 **1**；改回导出实现后 9/9 通过、退出码 0。真实读数：四臂 + 阶段一每轮 `a 帧 / a ms = 21 / 420`，与 `silence_duration_ms=400` 导出吻合。

**AC4** — 真实运行每臂观测序列均为 `input_audio_buffer.commit → response.create → bounded-wait → socket-close`，`wellFormed=true`、`hasCommitAndResponse=true`（见报告「AC4 退出路径」表，6 条连接逐条 ✓）。末句「顺序还是错的。」在四臂的 `transcription.completed` 中全部出现（5/5、遗漏 0）。如实说明：本窗口 45 s、末句源内偏移 35.1 s，**全部 5 条在退出信号发出前已到**（`退出前/后 transcription = 5 / 0`），故「退出后末句仍出现」成立但**不是**由退出信号补出来的；退出路径在本窗口的价值是「不发也不丢」的顺序不变式。假形态（收尾直接 `ws.close()`）：离线校验器用例 `test('退出路径良构：commit → response.create → bounded-wait → close')` 断言 `uplinkExitHasCommitAndResponse(['socket-close']) === false`（该假形态判红）；探针侧对乱序序列 `throw`。

**AC5** — 引用点审计：
- `uplinkVadGate.mts`：唯一涉及 `input_audio_buffer.commit` 的位置是退出顺序常量 `UPLINK_EXIT_STEPS` 与校验器 `uplinkExitHasCommitAndResponse`；对 `speech_started`/`speech_stopped` **零引用**。门控唯一输入是掩码位。
- `probe.mts`（`--vad-filtered` 路径）：`input_audio_buffer.committed` 仅出现在 `link.inboundOfType(...)` 的**读数**（headKeep/exit 读数块）与退出路径的 `link.sendRaw({type:'input_audio_buffer.commit'})`（触发源是「窗口结束=模拟用户退出」这一显式动作，不是任何边界事件）；`speech_started`/`speech_stopped` 仅被 `inboundOfType` 计数为读数（`speechSegments`）。head-keep 的逐帧发送循环只查 `plannedByIndex`（掩码派生），**无任何**边界事件进入发送分支。probe 里其它 `speech_stopped` 引用属**另一模式**的取假形态开关 `--falsify-b-boundary-response-create`，与 `--vad-filtered` 无关。

**AC6** — 真实 Realtime 两阶段（同窗口 0–45000 ms，源会话 `af5559c0-d347-41f3-a6f0-f02a597af1e9`，`turn_detection` = `{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`），读数写入 `docs/operations/voice-vad-filtered-pcm-upstream-replay.md` 末尾「上行 VAD 新形态复验」。阶段一 Silero ×2：`846 帧 / 541440 字节（37.6%）`、transcribed 5、forwarded 5（5）、missed 0、firstCall 7311/10192 ms、err 1/2、gapMax 7381 ms、¥0.0066/¥0.0064。阶段二四臂 ×1：A 2250/1440000/5/5(5)/0/7459ms/err1/gap23/¥0.0066；silero 846/541440/5/5(5)/0/7322ms/err1/gap7381/¥0.0066；ten 802/513280/5/5(5)/0/12508ms/err3/gap10860/¥0.0062；webrtc 2021/1293440/5/5(5)/0/7412ms/err1/gap2219/¥0.0066。转发原文逐臂见报告。

**AC7** — 阶段一合计 **¥0.0130**、阶段二合计 **¥0.0260**，本任务总计 **¥0.0390** ≤ ¥0.15；单连接最大 ¥0.0066 ≤ ¥0.05。两次运行各 ≤ 8 分钟（阶段一 ~2 min、阶段二 ~4 min，均 `settled=quiet`）。

**AC8** — `git diff --name-only $(git merge-base develop HEAD)..HEAD` = 仅 `experiments/voice-realtime-vad-three-arm/{probe,uplinkVadGate,uplinkVadGate.test}.mts`，**不含** `server/**` 或 `src/**`。`VOICE_REALTIME_SILENCE_TAIL` 仍为关（探针不写任何生产环境变量；服务端未设）。

**AC9** — 运行前 `:3001` pid **366403** → 运行后 **366403**（阶段一、阶段二两次运行均相同，未重启）。

**AC10** — 同一窗口旧 vs 新（旧读数逐值取自旧形态实测报告，**每轮值**；新取自本轮快照，同样每轮）：A 1440000→1440000 字节、transcribed 5→5、forwarded(有文本) 4→5；silero 554880(补发 80640)→541440(真实保留 67200)、5→5、4→5；ten 526720(67200)→513280(53760)、5→5、4→5；webrtc 1302400(80640)→1293440(71680)、5→5、4→5。**新形态不比旧形态差**：transcribed 全部 5/5、forwarded(有文本) 5/5、遗漏 0（旧形态 silero/ten/webrtc 各有 1 条遗漏），上行字节略少。**未出现更差项**，无需停下。附带如实记录：退出路径的 `commit` 会让上游回一条 `Error committing input audio buffer: buffer too small`（本窗口末段已被上游自行切分，提交时缓冲为空）—— 无害，出现在每臂 err 计数里（1 或 3）。

## DoD

门控实现按定稿方案成立：真实音频、段首段丢弃、`a` 由解析值导出、退出由用户动作触发 commit+response.create；deterministic 测试可跑且假形态可红；真实 Realtime 上复验通过并留下可复算读数；生产默认值与线上服务未被触碰。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts
- experiments/voice-realtime-vad-three-arm/uplinkVadGate.mts (new)
- experiments/voice-realtime-vad-three-arm/uplinkVadGate.test.mts (new)
- docs/operations/voice-vad-filtered-pcm-upstream-replay.md
- tasks/gap-voice-uplink-vad-real-prefix-a-and-exit-commit.md

## Notes

**依赖**：本任务的实现依据是 `gap-voice-uplink-vad-scheme-doc` 落地的方案文档（`depends_on` 已设该边）。

**边界**：只改实验侧。服务端 continuous 路径的接线（`sendAudioFrame` 上的门控、默认关闭的开关）**不在本任务**，需另立任务。

**不做**：不重跑离线五方案对比；不重跑 STS 三臂回放；不改任何出货默认值。

## Blocker

**2026-10-13T14:39:07.126Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=6810 e2e/session-lifecycle-scenario.spec.ts passed=false end_ms=1791902311585
- run_id：wk-prod-anchor
- session_id：6e07bcbd-30e0-4b51-ab5e-fee74cc2379a

## Needs-Human

**执行 2026-10-13T14:39:07.664Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed：suite 红已归因到 1 个失败文件（e2e/session-lifecycle-scenario.spec.ts）——这些红点没能被判为既存红（基线比较 / 落地未通过）⇒ 停止重派，⛔ 不再拿新会话撞同一堵墙：suite red was attributed to 1 failing file(s) (e2e/session-lifecycle-scenario.spec.ts) but could not be cleared as pre-existing red in 2 consecutive rounds (bounded to at most one retry) — baseline comparison not evaluated: no baseline rerun command: no-rerun-command-declared — stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=6810 e2e/session-lifecycle-scenario.spec.ts passed=false end_ms=1791902311585
- run_id：wk-prod-anchor
- session_id：6e07bcbd-30e0-4b51-ab5e-fee74cc2379a
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-uplink-vad-real-prefix-a-and-exit-commit~wk-prod-anchor~1791902155325-a2e04e.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-uplink-vad-real-prefix-a-and-exit-commit-wk-prod-anchor.log
