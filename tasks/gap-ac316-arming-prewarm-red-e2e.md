---
id: gap-ac316-arming-prewarm-red-e2e
title: 恢复 AC-316 判据绿：arming 相位要求首帧而 live e2e 假图从不送帧；麦克风预热在注入 seam 下仍调 getUserMedia
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-316
---
## Proposal

### 现象（2026-10-18 本轮直接重跑判据，不是台账尾巴）

AC-316 的 criterion 是三条命令的 `&&` 链。本轮重跑（gate event `2026-10-18T11:29:40Z`，前一轮 `11:26:30Z`）**第 1 条 exit 1**，链在此中断，第 2/3 条本轮未被执行。e2e 运行留档在 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-WJDIwc/test-results/`：

- `voice-realtime-live-sessio-…/error-context.md`：`Expected: "listening" / Received: "arming"`，25s poll 超时；对应用例自 `e2e/voice-realtime-live-session-send.spec.ts:595`，首个 listening 等待在 `:618`。
- `voice-realtime-upload-fixt-…/error-context.md`：`Expected: 0 / Received: 1`；trace 的最终失败栈指向 `e2e/voice-realtime-upload-fixture.spec.ts:1205`（`expect(await mediaCallCount(page)).toBe(0)`）。同一 trace 显示 `injectFixture` 的 poll 最终通过——上传确实落进了 transcript，红的只有麦克风读数。

两个失败都是今天新增的确定性回归，不是负载 flake：两次 gate 运行（11:26、11:29）同读，且两个根因提交都落在今天。

### 根因一：`arming` 相位要求首帧，而 live spec 的假采集图从不主动送帧

- `c99a0eaba feat(voice): add an arming phase until the first captured frame`（2026-10-18 10:16 +0800）把相位数成 `idle | connecting | arming | listening | muted | failed`：上游 `state: open` 只到 `arming`，**第一帧真实采集帧**到达才进 `listening`（`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:1317,1439,1538`）。
- `e2e/voice-realtime-live-session-send.spec.ts` 的假图是惰性的：`FakeWorkletNode` 只保存 `port`，帧只由 `__voiceFake.speak()` 推进端口（同文件 389、516-530）。四个用例都在 `speak()` **之前** `waitForPhase(page, 'listening')`（618、715、761、799），所以四个都停在 `arming` 直到 25s poll 过期。
- 这不是产品回归：`arming` 是 `gap-ac345-intent-control-spec-first-frame-before-listening` 引入并验证过的故意语义。**不允许**用「把 arming 改回 listening」或删帧来修判据。
- 同一 arming 变更的姊妹修法已经在 `bd9ac22c5`（2026-10-18 19:25）落进 `e2e/voice-realtime-intent-control.spec.ts`（`pushFirstCaptureFrame`），但那一轮只覆盖 AC-345 自己的 spec；AC-316 的两个文件没有同步，也没有被重跑。

### 根因二：麦克风预热不认 e2e 的注入 seam

- `b455586c5 fix(voice-realtime): prewarm the microphone on the Live Voice tap`（2026-10-18 18:39 +0800）在 `enterVoiceMode` 顶部无条件 `void warmMicrophoneSource()`（`src/modules/chat/ChatInterface.tsx:426`）。
- `e2e/voice-realtime-upload-fixture.spec.ts` 的判据前提是「本 case 全程不碰麦克风」：init script 设 `__voiceRealtimeSkipAutoStart = true`（1108），并装一个**会 reject、且计数**的 `navigator.mediaDevices.getUserMedia`（1115-1122）；相关用例末尾读 `mediaCallCount === 0`。
- `__voiceRealtimeSkipAutoStart` 目前只让 pane 的 effect 跳过 `startVoiceCapture()`（`ChatInterface.tsx:573-580`），**没有**阻止 tap 上的预热。于是进入 Live Voice 仍调用一次 `getUserMedia`，读数 1（`:1205`；第二条腿 `:1270`、`:1284` 同读）。
- **不得**放宽这条读数（不允许改成 ≤1，不允许删断言）：AC-316 §四要求不弱化既有判据；正确修法是让注入 seam 对预热的语义也成立。

### 根因三：upload spec 的 `PHASE_STATES` 枚举缺 `arming`

- `e2e/voice-realtime-upload-fixture.spec.ts:91` 仍是 `['idle','connecting','listening','muted','failed']`，而 `enterLiveVoice` 会把观测相位断言在这个集合里（`:916`）。`arming` 是 shipped 相位，bar 刚出现时读到它是合法的；缺枚举会让 helper 非确定性地红。补 `'arming'` 是修正 seam 的枚举，不是放水。

### 为什么早先的修复没守住

- AC-316 在 `2026-10-18T01:51:39Z` 仍是 pass（gate event，treeSha `1747a6de…`）。今天更晚落地的两个提交分别改了判据所测的两个不变量（首帧才 listening；进入模式不碰麦克风），但都没有更新 AC-316 的两个 e2e 文件，也没有重跑 AC-316 的 criterion。
- 已 `done` 的相关任务不收口本机制：`gap-live-voice-exclusive-mode-fixed-bar`（AC-316 原实现）、`gap-ac316-restore-criterion-two-regressions`、`gap-ac316-upload-arms-stale-fold`、`gap-ac345-intent-control-spec-first-frame-before-listening`（同一 arming 变更，但只修自家 spec）。<!-- dedup-ref --> 本任务不依赖这些任务，也不重做它们，只把今天新增的两个回归修回，并补上同一 seam 的枚举遗漏。

### 修法（最小、无产品语义变更）

1. `e2e/voice-realtime-live-session-send.spec.ts`：照 `e2e/voice-realtime-intent-control.spec.ts` 的 `pushFirstCaptureFrame` 实现，装 `__voiceCaptureProbe`（最近构造的 worklet + `constructed`/`pushed` 计数），等 `start()` 真正把 `port.onmessage` 接上后推一帧 200ms/16kHz PCM；在每个初始 `waitForPhase('listening')` 前各调一次（4 处）。PC 腿的 `framesBeforeFirstBurst` 必须在这帧之后采样，保持「speak 后帧数增长」的读数不含糊。
2. `src/modules/chat/ChatInterface.tsx`：`enterVoiceMode` 的预热尊重 `__voiceRealtimeSkipAutoStart`——seam 置位时不调用 `warmMicrophoneSource()`；未置位的 shipped 路径保持「tap 上、allocation 之前预热一次」。
3. `src/modules/chat/tests/liveVoiceMicPrewarmEntry.test.tsx`：新增一条用例——带 skip seam 时 `warmMicrophoneSource` 不被调用（`warmCalls === 0`）；原有「无 seam 时恰好一次、且在 createSession 之前」的用例保持绿。
4. `e2e/voice-realtime-upload-fixture.spec.ts`：`PHASE_STATES` 加 `'arming'`。

## AC

- [x] AC-1 判据整体 exit 0：`npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts && npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts && npx playwright test e2e/voice-trim.spec.ts -g "AC-120"`；把完整 list reporter 摘要和退出码留在交付说明里。
- [x] AC-2 第一条命令单独 exit 0：4 + 7 = 11 passed、0 failed、0 skipped；两个 serial 文件没有新增 `.skip`/`.only`，`waitForPhase` 的 25s 与文件原有 timeout 未被放大。
- [x] AC-3 arming 修复可机读：`grep -c "pushFirstCaptureFrame" e2e/voice-realtime-live-session-send.spec.ts` ≥ 5（1 处定义 + 4 处初始 listening wait 前调用）；helper 只在 `port.onmessage` 已被 `start()` 接线后推帧，且有 `constructed`/`pushed` 防重复。
- [x] AC-4 预热 seam：新增单测在 `__voiceRealtimeSkipAutoStart = true` 时断言 `warmCalls === 0`；原有 unflagged 用例仍断言 `warmCalls === 1` 且 `'warm'` 在 `'createSession'` 之前。
- [x] AC-5 上传判据重跑：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts -g "injecting a fixed-corpus fixture"` 通过，`mediaCallCount === 0` 断言原样保留（修前读数见 trace 的 `:1205` 红）。
- [x] AC-6 取假形态 (a)（预热回归）：临时让 `enterVoiceMode` 恢复无条件预热，`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts -g "injecting a fixed-corpus fixture"` 必须在 `voice-realtime-upload-fixture.spec.ts:1205` 红（Expected 0 / Received 1）；记录原始输出后恢复。
- [x] AC-7 取假形态 (b)（首帧回归）：临时删掉初始 `pushFirstCaptureFrame` 调用，`npx playwright test e2e/voice-realtime-live-session-send.spec.ts -g "PC: entering Live Voice"` 必须在 `waitForPhase('listening')` 红（Expected "listening" / Received "arming"）；记录后恢复。
- [x] AC-8 第二/三条命令：protocol simulation exit 0（当前文件 24 tests；原 5 个场景 chunk 时序、Mute 即打断、断线清理、并发竞态、工具回填都在且绿）；`voice-trim -g "AC-120"` exit 0（1 passed）。
- [x] AC-9 `npm run typecheck` 与 `npm run lint` 均 exit 0，无新增 voice-realtime 告警。
- [x] AC-10 375px 两条腿在第一条命令里通过（live 的 375px 用例与 upload 的 375px 用例），bar 仍在视口内、composer 仍不可见。

## DoD

- 判据在合并树上整体绿（exit 0），下一轮 goal 重跑把 AC-316 台账尾翻成 pass；交付说明贴出命令、摘要，以及 2026-10-18 的两个回归提交 `c99a0eaba` / `b455586c5`。
- 产品 seam 是真实读回来的：有 skip seam 时 `getUserMedia` 调用数为 0；无 seam 时 tap 上预热一次且在 allocation 之前（单测读数）。
- 不放水：`mediaCallCount === 0` 与四处 `waitForPhase('listening')` 都还在；修复落在假图/产品 seam 上，不在断言上。
- 两个取假形态的红都实际观察到并记录，然后才恢复为绿。

## Touches

- e2e/voice-realtime-live-session-send.spec.ts
- e2e/voice-realtime-upload-fixture.spec.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/tests/liveVoiceMicPrewarmEntry.test.tsx
- tasks/gap-ac316-arming-prewarm-red-e2e.md