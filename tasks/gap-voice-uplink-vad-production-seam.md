---
id: gap-voice-uplink-vad-production-seam
title: 上行 VAD 接入生产缝（ws-proxy:3369–3395）且 DEFAULT OFF：关着时逐字节不变、localSpeechGate 与
  noteLocalActivity 不受影响、只改 append 帧型、exit 由用户动作触发 commit+response.create
status: done
labels:
  - gap
parent: null
children: []
extra:
  acceptance: test -f
    server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts
    && npx tsx --tsconfig server/tsconfig.json --test
    server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts
depends_on:
  - gap-voice-uplink-vad-node-backends
---
## Proposal

把已实测的上行 VAD **接进生产链路**，但 **DEFAULT OFF**：关着的时候老链路的行为**逐字节不变**。本轮**不重启服务、不打开任何生产配置**。

**接线位置（本轮勘察实测，已定位）**：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:3369–3395` —— STS 门控就装在这里，且它已经解决了本任务最危险的耦合。

**既有先例给出的三条纪律（必须原样遵守）**：

1. **`reportLocalSpeechBoundary(localSpeechGate.observe(frame.audio))` 必须先喂、无条件喂**（`:3381`）。理由是代码注释明写的：continuous 模式下**上游自己的 `server_vad` 才是 endpointing**，若这段音频变哑，relay 就再也无法知道发生过一句。
2. **`bridge.noteLocalActivity?.()` 必须对每一个浏览器帧调用，转发与否都一样**（`:3393` 前）。理由（`voice-realtime-bridge.service.ts:668–684` 逐字）：上游池把 `sendAudioFrame` 当**连接活动时钟**，删帧会让它按 `idleRotateMs` 轮换到一个"其实从未空闲"的会话上，实测上游 ~304 s 无接收会被对方关闭。**这正是"过滤上行 PCM"最容易踩断的一根线。**
3. **关着的时候必须是同一条快路径**：现有代码 `if (silenceTail === null) { bridge.sendAudioFrame(frame.audio); return; }` —— 新门控也要有等价的 `=== null` 快路径，让默认行为在**代码路径上**而不是只在结果上等于今天。

**exit 路径**：由**用户点击退出这一显式动作**触发 `input_audio_buffer.commit` + `response.create`，随后有界等待再关闭。它是「不发 response.create」的**唯一有界例外**，作用域仅限退出；⛔ 正常流的发送决策**不得**由上游 VAD 边界事件驱动。

## Plan

1. 在 `:3369–3395` 的缝上加一层新门控，形状照 STS：读入帧 → 决定哪些 append 出线。`=== null` 快路径与今天逐字节相同。
2. 保持纪律 1、2 不动：`localSpeechGate` 与 `noteLocalActivity` 的喂法原样保留在门控之前、无条件执行。
3. **与 STS 的关系必须显式定案**（两者都开会怎样）：给出明确规则（互斥并报错读数，或定义组合顺序）与实测读数。⛔ 不允许"两个都开着时行为未定义"。
4. `a` 由**解析后的** `turn_detection.silence_duration_ms` 导出（`voice-realtime-turn-detection.ts` 是唯一来源），不写死；首段静音整段丢弃；短于 a 的停顿与轻声**整段保留**；零合成。
5. exit 路径接线：用户动作触发的 commit + response.create + 有界等待，假形态（直接关闭）可红。
6. 确定性测试：默认关时喂入一串帧，断言送出的帧序列与今天**逐帧逐字节相同**；开启时断言首段丢弃/开头 a 保留/短停顿保留/localSpeechGate 与 noteLocalActivity 的调用次数不变。
7. 经 Provider ABI 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [x] AC1 **默认 OFF 且逐字节不变**：默认配置下把同一串浏览器帧喂进 proxy，断言 `sendAudioFrame` 收到的帧序列与改动前**逐帧逐字节相同**（给出前后对照读数）；假形态：默认值被打开 ⇒ 红。
- [x] AC2 `=== null` 快路径存在：默认路径**不构造任何门控对象**、不加载任何模型（`## Evidence` 给出该分支的调用读数或代码路径证据）。
- [x] AC3 **`localSpeechGate` 无条件先喂**：开启门控后，被过滤掉的那些帧**仍然**产生相同的 `observe` 调用（给出计数前后对照）。
- [x] AC4 **`noteLocalActivity` 对每一帧调用**：开启门控后其调用次数 = 浏览器帧数（不是转发帧数）；假形态：只在转发帧上调用 ⇒ 红。
- [x] AC5 **只改 append**：正常流里代码发送的帧型集合与今天相同 —— ⛔ 无 `response.create`、无 `input_audio_buffer.commit`、无 `session.update`、无 `conversation.item.create`；`turn_detection` 未被改（给出帧型审计读数）。
- [x] AC6 **与 STS 的关系已定案**：给出两者都开时的明确规则与实测读数；⛔ 未定义行为 ⇒ 红。
- [x] AC7 exit 路径：用户动作触发 `commit` → `response.create` → 有界等待 → 关闭，顺序被断言；假形态（直接关闭）⇒ 该断言红。
- [x] AC8 `a` 由解析值导出：把 `VOICE_REALTIME_TURN_DETECTION_SILENCE_MS` 配成非默认值，断言保留窗跟随；写死 400 ⇒ 红。
- [x] AC9 确定性测试 `npx tsx --tsconfig server/tsconfig.json --test <本任务测试文件>` 退出 0；含首段丢弃、开头 a 保留、短停顿整段保留、零合成四类。
- [x] AC10 不改其它默认值、不重启 :3001（前后 pid 相同，写出读数）；`VOICE_REALTIME_SILENCE_TAIL` 仍为关。

## Evidence

**Branch `task/gap-voice-uplink-vad-production-seam`；本轮 head `afb6fedec`（impl `1e339d31b`，merge develop `39527af27`）；criterion 22 pass / 0 fail, exit 0。**

**重试轮（上一轮 exited-not-landed 之后）—— 上一轮红的真因与修法。** 上一轮套件红在两处，都不是环境/滞后：(1) `server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts` 的 AC5/AC7/AC8 三条断言 —— 本任务的接线把**流式门控**（它必须解码一帧 base64 回 PCM 才能喂分类器，并在注释里点名生产缝）追加进了那个**契约上零分配、不命名任何 relay 路径**的纯分类器模块，于是 `Buffer\.from\(` 计数 1≠0、`voice-realtime-ws-proxy` 计数 2≠0、`ws-proxy` 计数 2≠0。修法：把整段流式门控移入新文件 `server/modules/voice-realtime/voice-realtime-uplink-vad-gate.ts`（与同级 STS 门控 `voice-realtime-silence-tail.ts` **同形** —— 那也是自带 base64 解码的独立门控文件），分类器模块除导出 `bypassedVerdict`（两处必须对"未判定"给出同一个 verdict，不能各写一份字面量而漂移）外与 develop **逐字节相同**；proxy 与 criterion 改从新文件取门控符号。该文件现 **10 pass / 0 fail**。(2) `server/shared/tests/quay-test-script.test.ts` —— 本任务新增的服务器测试文件把 collected 从 326 推到 **327**，两条派发计数 pin 随动（`known=3 unknown=324`、`known=1 unknown=326`），同时压破 AC7 的 90% 覆盖地板（294/327 < 0.9）；已补 `scripts/suite-duration-baseline.tsv` 一行（**295/327 ≥ 0.9**，top-8 最慢仍含 `voice-error-classification.false-forms.test.ts`）。该文件现 **14 pass / 0 fail**。另：`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

- **AC1/AC9 — the criterion**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts` → **tests 22 / pass 22 / fail 0, exit 0**。
- **AC1 — before/after**：门控关时 `appends(wired)` 与浏览器帧序列 **deep-equal**（同一次调用、同字节、同顺序；这就是"改动前"的读数）；假形态 `fast-path-withholds` 使该断言变红。关着时 `uplink_vad:` 日志 **0 行**。
- **AC2 — 代码路径证据**：快路径 `if (silenceTail === null && uplinkVad === null) {` 全文件**恰出现 1 次**；`const uplinkVadRequested = seams.uplinkVad !== undefined && !segmentedRelay;` —— 无 seam 即无门控；唯一一处 `createUplinkVadGate({…})` 在该分支内。测试断言以上三条原文均存在。
- **AC3 — 计数前后对照**：门控**开**时，喂入一段只有越过 head 窗才会闭合的语料（`a=21 < DEFAULT_EXIT_FRAMES=25`），`turn_unanswered ≥ 1` —— 边界由 VAD **丢弃**的帧触发；门控**关**的对照产生同一读数。假形态 `local-gate-only-when-forwarded` ⇒ `turn_unanswered = 0`（红）。非真空性：闭合所需的帧确实全在 head 窗之外且确实未上线。
- **AC4 — 计数**：`idleRotateMs=300`，喂 120 个全非语音帧（线上静默 `appends=0`），`rotations=0`；停喂后对照轮换发生。假形态 `no-activity-clock` ⇒ 喂入途中 `rotations ≥ 1`（红）。
- **AC5 — 帧型审计**：`new Set(sentTypes)` 在关/开两侧**完全相同**（实测集合 `{session.update, input_audio_buffer.append}`）；正常流无 `response.create`、无 `input_audio_buffer.commit`；`turn_detection` 未被改（`voice-realtime-turn-detection.ts` 未修改）。非真空性：开的那次 append 数严格更少。
- **AC6 — 定案读数**：两个 seam 同时在场 ⇒ 日志 `uplink_vad refused: silence tail suppression is also enabled, … the incumbent STS gate wins`；被拒的 VAD **从未**调用其 classifier（`fed.length === 0`），实际运行的是 STS 的 `silence_tail event=` 行。
- **AC7 — 顺序**：浏览器发 `{type:'close'}` 再 `socket.close()` ⇒ 线上最后两条恰为 `input_audio_buffer.commit`、`response.create`（相邻，close 在其后），socket 最终 CLOSED；`uplinkVadExitIsWellFormed` 与 `uplinkVadExitHasCommitAndResponse` 均成立。假形态：谓词对 `['socket-close']` 为 false，源突变 `exit-no-commit-pair` 使线上两条**都不出现**（红）。
- **AC8 — 导出值**：`VOICE_REALTIME_TURN_DETECTION_SILENCE_MS=800` 时连接日志 `silenceMs=800 aFrames=41`（= `uplinkHeadKeepFrames(800)`）；假形态 `hardcoded-400`（现打在 `voice-realtime-uplink-vad-gate.ts` 上）使其停在 400 的窗口（21）⇒ 红。
- **AC10 — 生产未动**：`:3001` 监听 pid **766174**（`node dist-server/server/index.js`），启动于 2026-10-13 23:54:31，读数时已运行 ~2h07m —— 未被重启。`/proc/766174/environ` 中 `VOICE_REALTIME_{SILENCE_TAIL,TURN_DETECTION,MODE,UPLINK}_*` **一个都没有**，故 `VOICE_REALTIME_SILENCE_TAIL` 为关、新门控在生产中为关。默认行为相关文件（`server/index.ts`、`voice-realtime-turn-detection.ts`、`voice-realtime-silence-tail.ts`）相对 develop **未修改**。

**未做（刻意）**：不打开任何生产配置；不重启服务；不改 STS 与 `localSpeechGate` 自身行为。

## DoD

上行 VAD 已在生产缝上可用且默认关闭；关着时老链路逐字节不变（有前后对照读数）；开着时不破坏 `localSpeechGate` 的上游边界读数、不破坏上游池的活动时钟、只改 append 帧型；exit 路径由用户动作触发且顺序被断言；与 STS 的组合关系已定案；生产配置未被打开、服务未被重启。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-uplink-vad.ts
- server/modules/voice-realtime/voice-realtime-uplink-vad-gate.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts (new)
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-uplink-vad-production-seam.md

## Notes

**依赖**：实现依据是 `gap-voice-uplink-vad-node-backends` 交付的 Node 侧后端层（`depends_on` 已设该边）。

**为什么强调 `noteLocalActivity`**：`voice-realtime-bridge.service.ts:668–684` 逐字记载了这条耦合的实测代价（`idleRotateMs` 轮换 + 上游 ~304 s 无接收被关闭）。删帧而不喂活动时钟，会把"过滤省字节"变成"会话被轮换掉"。

**为什么门控另起一个文件**：分类器模块（`voice-realtime-uplink-vad.ts`）的判据按**字面 grep** 要求它零 `Buffer.from(`、不出现 `voice-realtime-ws-proxy`/`ws-proxy` —— 它必须是纯的、可被单独审计的分类器。流式门控**必须**解码一帧回 PCM，所以它天生违反那条契约；把它放进 `voice-realtime-uplink-vad-gate.ts`（同级 STS 门控同形）才能让两边各自的判据都成立。

**不做**：不打开任何生产配置；不重启服务；不改 STS 与 localSpeechGate 自身的行为。

## Blocker

**2026-10-13T18:12:31.279Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts:   AssertionError [ERR_ASSERTION]: the module contains a Buffer\.from\( call site
- run_id：wk-prod-anchor
- session_id：7d6e3962-9ee4-42f1-982d-272a278a7065
