---
id: gap-ac323-composer-embedded-arming-first-frame-and-criterion-deadline
title: 恢复 AC-323 判据绿：composer-embedded spec 仍在首帧前等 listening（arming 相位）、首帧吃掉
  fake upstream 每连接唯一一次 call、115s 判据截止低于实测串行 ≈156s
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-323
---
## Proposal

（去重 / 粒度）<!-- dedup-ref --> 声明 `goal_ac: AC-323` 的 6 个任务全部是 `done`，仓内无 todo/ready/needs-human 任务认领 AC-323 ⇒ 本任务为新案。同一 arming 机制在兄弟判据上已分别修过：`gap-ac316-arming-prewarm-red-e2e`（AC-316）、`gap-ac345-intent-control-spec-first-frame-before-listening`（AC-345）、`gap-continuous-experience-arming-phase-before-first-frame`（AC-361），它们各自只改自家 spec，均未覆盖 AC-323 的 `e2e/voice-realtime-composer-embedded.spec.ts`。`task-granularity-advice --touches e2e/voice-realtime-composer-embedded.spec.ts` 报 `peers: []`、`mentions: []` ⇒ 无合并候选。

### 现象（2026-10-19 本轮直接重跑判据，不是台账尾巴）

AC-323 criterion 的三条命令本轮实测：CMD2 exit 0（`Test Files 20 passed` / `Tests 196 passed`），CMD3 exit 0（`6 passed (27.2s)`），**CMD1 exit 1**。CMD1 的失败是确定性的，不是负载 flake：

```
1) e2e/voice-realtime-composer-embedded.spec.ts:775:3 › voice realtime composer embedded bar ›
   1280px: the bar holds one geometry through listening, mute and an executing call, ...
   Error: expect(received).toBe(expected) // Object.is equality
   Expected: "listening"
   Received: "arming"
   at waitForPhase (e2e/voice-realtime-composer-embedded.spec.ts:490:55)
   at enterLiveVoice (e2e/voice-realtime-composer-embedded.spec.ts:557:9)
```

该文件是 `test.describe.configure({ mode: 'serial' })`（`:589`），首个用例失败后其余 6 个用例没有运行（`1 failed / 6 did not run / 11 passed`）。**台账的「1 failed」会骗人**：修复入口后必须整份文件重跑，才能看到后面用例的红。

### 根因一：`arming` 相位要求首帧，而本 spec 的假图从不主动送帧

- `c99a0eaba feat(voice): add an arming phase until the first captured frame`（2026-10-18 10:16 +0800）把相位数成 `idle | connecting | arming | listening | muted | failed`：上游 `state: open` 只到 `arming`，**第一帧真实采集帧**到达才进 `listening`（`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:1317,1439,1538`）。
- 本 spec 的 `enterLiveVoice`（`:538`）在 `entry.click()`、栏可见、文本框 hidden 之后**直接** `waitForPhase(page, 'listening')`（`:557`）；内联假采集图只在 `__voiceFake.speak()` 时推进 `port.onmessage`（`:679-690`），从不在进入时送帧 ⇒ 25 s poll 停在 `arming`。
- 这不是产品回归：`arming` 是故意语义（AC-316 / AC-345 / AC-361 各自的判据都已把它钉住）。**不允许**把 `arming` 改回 `listening`，也不允许删掉这条等待。
- 兄弟 spec 的现成修法：`e2e/voice-realtime-live-session-send.spec.ts:388-410` 与 `e2e/voice-realtime-intent-control.spec.ts` 的 `pushFirstCaptureFrame`——等 `start()` 把 `port.onmessage` 接上后推一帧 200 ms/16 kHz 的 PCM，并推进共享的 `atSample` 账本。本 spec 没有这个 helper，是那次同步遗漏的第三个文件。

### 根因二：首帧会吃掉 fake upstream「每连接唯一一次 call」的预算

只加首帧推送能让整份文件 7 个用例全部通过（本轮实测 `7 passed (52.5s)`），但它同时暴露了一个被 serial 首红藏住的确定性红：`the leave control and the running turn's stop are told apart...`（`:1096`）在 `:1121` 红：

```
Expected: >= 7
Received:    6
await expect.poll(() => upstream.callCount(), { timeout: 25_000 }).toBeGreaterThanOrEqual(callsBefore + 1);
```

原因是 fake upstream 的契约：每个 WebSocket 连接最多发一次 `session_send`（`startFakeUpstream` 的 `let callSent = false`，`:296-299`），而首帧一旦被转发成 `input_audio_buffer.append` 就立即消耗掉这次 call。于是 `callsBefore` 在 `enterLiveVoice` 之后读到的已经包含它，随后的 `speak()` 再也不会新增 call。**不得**把断言放宽成 `>= callsBefore` 或删掉它；正确修法是让首帧推进时 fake 还没有绑定会话（`setBoundSessionId('')`，进入后恢复；或在 case 6 延后绑定 `heldSessionId`），这样首帧只标记 capture-ready，下一次 `speak()` 才触发它本来要测的 call。

### 根因三：115 s 判据截止低于现在的三段串行墙钟

本轮带修复实测：CMD1 `18 passed (2.0m)`，wall **124.05 s**；CMD2 **5.16 s**；CMD3 **27.2 s** ⇒ 串行 floor ≈ **156.4 s**。AC-323 记录声明 `timeoutMs: 115000` ⇒ 判据会在 CMD1 跑完前被杀，即使 spec 全绿也只会得到 `not-evaluated (timeout)`。

旧的「必须 < 120000」来自上一版 goal-driver 的固定 `CRITERION_TIMEOUT_MS = 12e4`。**当前发布版 0.20.0 已改成从记录派生**：`gateCriterion2` → `goalDriverChildTimeoutMs(record.timeoutMs, "gate") = resolveAcceptanceTimeout(record.timeoutMs).timeoutMs + GOAL_DRIVER_SPAWN_GRACE_MS(15000)`（`scripts/dist/goal-driver.js`），`resolveAcceptanceTimeout` 对正整数 record 值原样采用、没有 120000 上限。所以把 `timeoutMs` 抬到 200000（≈156 s 的 1.28 倍）即可；不需要也不允许改判据文本或删命令。

### 为什么上一次修复没挺住

- AC-323 在 `2026-10-18T01:51:39Z` 仍是 pass，早于 `c99a0eaba`（10:16 +0800）与 `b455586c5`（18:39 +0800）落地。arming 变更改掉了判据所测的「进入即 listening」前提，而同一波只同步了 AC-316 / AC-345 / AC-361 的 spec。
- `timeoutMs: 115000` 由 `gap-ac323-gate-deadline-below-criterion-serial-time` 在串行墙钟 76–100 s 时定档；此后 spec 增长（case 6 的 held scenario 睡 20 s、upload-fixture 的 byte-budget 用例 22.2 s），115 s 已经结构性不够。

### 做法

1. 在 `e2e/voice-realtime-composer-embedded.spec.ts` 的内联假图里加 `pushFirstFrame()`（等 `port.onmessage !== null` 后推 200 ms/16 kHz PCM，并推进 `state.atSample`），照兄弟 spec 加 `pushFirstCaptureFrame(page)` helper。
2. 在 `enterLiveVoice` 的 `waitForPhase(page, 'listening')` 之前调用它；`375px: the controls a disconnected bar still offers...`（`~:988`）的 bare-click 腿同样调用。
3. 首帧推进时 fake 的 `boundSessionId` 必须为空：在 helper 里「清空 → 点击/推帧 → 恢复」最近的绑定（需要一个 getter，或由调用方传入），或在 case 6 延后 `setBoundSessionId(heldSessionId)`。case 6 的 `callsBefore + 1` 断言保持原样。
4. 把 `goals/AC-323-…md` 的 `timeoutMs` 从 115000 抬到 200000（或按当次实测串行 + ≥15% 余量取值），记录其余字段逐字节不变。

### 边界 / 不做

- ⛔ 不改 `criterion` / `expect` 文本一个字；不删任何命令，不删/跳过任何 e2e 用例，不放大 `waitForPhase` 的 25 s 或文件原有 30 s 超时。
- ⛔ 不改产品代码。`arming` 是 shipped 语义；本任务只改测试 seam 与记录 deadline。
- <!-- dedup-ref --> AC-323 的 `expect` 第三节写 `voice-realtime-retry`，但 `gap-voice-ui-strip-to-caption-and-connection-state`（2026-10-14）已把重连控件删除，spec 现在以「a disconnected bar must offer no way back」断言这段语义（`e2e/voice-realtime-composer-embedded.spec.ts:881` 起）。判据面是 `criterion` 的三条命令，本任务**不**恢复 retry，也不据此改 goal 文本。
- 不靠改 `playwright.config.ts` 的 `workers` / 预算来「报出」绿；e2e 仍需 `scripts/with-memory-cap.sh` 包住（AGENTS.md「Running tests from a Claude session」）。

## AC

- [x] **AC1 spec 适配 arming**：`grep -c "pushFirstCaptureFrame" e2e/voice-realtime-composer-embedded.spec.ts` ≥ 3（1 处定义 + `enterLiveVoice` 内 1 处 + 375px bare-click 腿 1 处）；`pushFirstFrame()` 只在 `port.onmessage` 已由 `start()` 接线后推帧；`waitForPhase` 的 25 s 与 `mode: 'serial'` 不变。
- [x] **AC2 首帧不吃 call 预算**：fake upstream 的「每连接最多一次 `session_send`」（`callSent`）语义不变；首帧推进时 `boundSessionId` 为空（进入前后清空/恢复或 case 6 延后绑定）；case 6 的 `upstream.callCount() >= callsBefore + 1` 断言原样保留并通过。
- [x] **AC3 整份 spec 绿**：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` exit 0，`7 passed`、0 failed、0 skipped（serial 文件必须整份跑，不能用 `-g` 单跑代替）。
- [x] **AC4 CMD1 绿**：`npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts` exit 0、0 failed（本轮基线 18 passed），记录 wall time；贴 list reporter 摘要。
- [x] **AC5 CMD2 / CMD3 绿**：`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime` 与 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` 均 exit 0；贴 `Test Files 20 passed` / `Tests 196 passed` 与 `6 passed` 形状原文。
- [x] **AC6 判据截止抬高**：`goals/AC-323-composer-内双语音入口-容器内-live-voice-紧凑栏-波形-时长-字幕-模型-mute-end-桌面与.md` 的 `timeoutMs` 改为 > 本次实测三段串行墙钟且留 ≥15% 余量（基线 124.05 + 5.16 + 27.2 ≈ 156.4 s ⇒ 建议 200000）；`git diff -- goals/` 的增删行只有 `-timeoutMs: 115000` / `+timeoutMs: <N>`，其余字段逐字节不变。
- [x] **AC7 闸自证**：`quay goal gate AC-323 --dry-run --root <工作树>` exit 0，stdout `verdict == "pass"`、`cause == null`、`timeoutMs == <声明值>`，贴原文。若 `--root` 仍解析到主检出的旧记录，用 store 方言（如 `--store --root <工作树>`）或把 goal 目录指到工作树；必须证明读到的 `timeoutMs` 是声明值，不得谎报。
- [x] **AC8 取假形态 (a)（首帧回归）**：临时删掉 `enterLiveVoice` 里的 `pushFirstCaptureFrame` 调用 ⇒ 整份 spec 在 `waitForPhase('listening')` 红（`Expected: "listening" / Received: "arming"`）；record 原始输出后恢复。
- [x] **AC9 取假形态 (b)（call 预算回归）**：临时去掉首帧前的绑定清空/恢复（让首帧仍带绑定）⇒ case 6 在 `:1121` 红（`Expected: >= N+1 / Received: N`）；记录后恢复。
- [x] **AC10 取假形态 (c)（deadline 回归）**：把 `timeoutMs` 临时改回 115000 ⇒ `quay goal gate AC-323 --dry-run` 报 `verdict == "not-evaluated"`、`cause == "timeout"`（reason 含 `timed out after 115000ms`）；恢复声明值后同命令复绿。
- [x] **AC11 隔离性**：`git diff --stat develop HEAD` 恰好只有 `e2e/voice-realtime-composer-embedded.spec.ts`、`goals/AC-323-…md`（+ 本任务文件）；无产品代码改动、无其他 goal 记录 diff；假形态恢复后 `git status --porcelain` 为空。

## DoD

- 在带可写 `.quay/` 的根上真实跑 `quay goal gate AC-323`（非 `--dry-run`）拿到 `verdict: "pass"` 的 GateEvent，留下该条原文；AC-323 的台账尾随之翻 pass。
- 三条判据命令各跑一次，记 wall time 与 exit code；至少贴出 CMD1 的 `N passed` 摘要、CMD2 的 `Test Files / Tests` 读数、CMD3 的 `6 passed`、以及整份 composer-embedded spec 的 `7 passed`。
- 三条假形态（删首帧、恢复 call 预算、115000 deadline）各自现场红、恢复绿，原始输出留档。
- 不放水：不删/跳过用例，不放大等待，不改 `criterion` / `expect`，不改产品代码；case 6 的 `callsBefore + 1` 与整份 serial 文件的所有断言保持原意。
- Evidence 逐条记明：(a) 本轮三段实测值与声明值的余量；(b) 115000 的来历（上一版 `CRITERION_TIMEOUT_MS = 12e4`）与 0.20.0 驱动改为 `record.timeoutMs + 15000` 派生的原文位置；(c) fake upstream 的每连接单 call 契约为什么要求首帧在未绑定状态下推进。

## Touches

- e2e/voice-realtime-composer-embedded.spec.ts
- goals/AC-323-composer-内双语音入口-容器内-live-voice-紧凑栏-波形-时长-字幕-模型-mute-end-桌面与.md
- tasks/gap-ac323-composer-embedded-arming-first-frame-and-criterion-deadline.md（self）
