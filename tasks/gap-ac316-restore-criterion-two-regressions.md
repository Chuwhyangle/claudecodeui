---
id: gap-ac316-restore-criterion-two-regressions
title: 恢复 AC-316 判据绿（两条 serial e2e spec 文件的确定性回归）：补 e2e 假 AudioContext 的
  statechange 支持 + 改写中继认领全部待定 caption
status: ready
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

### 现象（2026-10-12 直接重跑判据，不是台账尾巴）

AC-316 的 criterion 是三条命令的链：

```
npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts && npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts && npx playwright test e2e/voice-trim.spec.ts -g "AC-120"
```

本轮逐条实跑：第 2 条 exit 0（19/19）；第 3 条 exit 0（1 passed）；**第 1 条 exit 1**（`5 passed, 2 failed, 4 did not run`）。两个 spec 文件都是 `test.describe.configure({ mode: 'serial' })`（`live-session-send.spec.ts:411`、`upload-fixture.spec.ts:949`），所以每个失败会跳过该文件余下的用例（`live-session-send` 的 759，`upload-fixture` 的 1401/1499/1633）。两个失败在 standalone 下各复现两次，且在默认（segmented）与 `VOICE_REALTIME_MODE=continuous` 两种模式下都红 —— **确定性红，不是负载 flake**。

AC-316 自身的断言（进入 Live Voice / 互斥 testid / 固定栏几何：`live-session-send` 的 559、667，`upload-fixture` 的 1089、1160）都是绿的。判据红纯粹因为**两个后置 AC 的保证**在同一批 serial spec 文件里回归；二者的实现任务都已是 `done` —— 即「早先的修复没守住」，故这是新一轮修复而不是重复立案。

<!-- dedup-ref --> 相关但不同机制、且都已是 `done`（非前置、非在飞）：`gap-live-voice-mic-audiocontext-suspend-resume`（提交 `99790d1f`，根因一的那次改动本身）、`gap-live-voice-recoverable-error-console-only`（提交 `6518f8b2`，它建立的「可恢复错误只进 console」保证在根因一下被夹具崩溃旁路）、`gap-live-voice-single-transcript-row`（AC-326，它建立的「一次想法一行、交付就地定型」保证被根因二破坏）。本任务不重做它们，只把被它们引入/破坏的两个回归修回，使 AC-316 判据恢复绿。

### 根因一：e2e 假 `AudioContext` 缺 `addEventListener`（`live-session-send.spec.ts:745`）

- `99790d1f feat(voice-realtime): resume a browser-suspended microphone AudioContext` 在 `src/modules/chat/voice-realtime/audioSource.ts:102` **无条件**调用 `activeContext.addEventListener('statechange', …)`。该提交只更新了姊妹 spec `e2e/voice-realtime-scripted-scenarios.spec.ts:259-310` 的假图，**没更新** `e2e/voice-realtime-live-session-send.spec.ts`。
- 后者的假 `FakeAudioContext`（`:511-526`）只实现 `sampleRate / destination / audioWorklet / createGain / createMediaStreamSource / close`，没有 `addEventListener`、没有 `state`。`start()` 因此在异步体里抛 `TypeError: activeContext.addEventListener is not a function` → promise reject → `beginCapture` 的 `.catch`（`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:694-697`）执行 `setError(failure.message)` 与 `setPhase('failed')`。
- 随后服务端 `state: open` 帧把 phase 拉回 `listening`（所以 `:725` 的 `waitForPhase('listening')` 通过），但**没有任何东西清 `error`** —— 只有 `sent` 帧会 `setError(null)`（`useVoiceRealtimeSession.ts:917-918`），而这个 leg 在 `:745` 之前从不说话、不会有 `sent`。于是栏上渲染 `voice-realtime-error`（`src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx:318`），`:745` 断言 count 0 得 1。
- malformed 帧本身没问题：`validateDeclaredCall` 对非 JSON 返回 null 交给 bridge（`server/modules/voice-realtime/voice-realtime-dashscope-transport.ts:909-915`），bridge 抛 `MALFORMED_FUNCTION_CALL`（`voice-realtime-bridge.service.ts:852-855`），proxy 的 `errorFrame` 因为该 code 在 `RECOVERABLE_ERROR_CODES` 内而标 `recoverable: true`（`voice-realtime-ws-proxy.service.ts:792-811`）。浏览器只收到这一条 recoverable 帧 → `useVoiceRealtimeSession.ts:1017-1019` 走 `console.warn`（所以 `:739-741` 的 warning 断言通过）。**没有第二条非可恢复帧**；错误元素来自上面那条非帧的采集启动失败路径。

**修法**：把 `e2e/voice-realtime-live-session-send.spec.ts` 的 `FakeAudioContext` 补齐为与 `e2e/voice-realtime-scripted-scenarios.spec.ts:259-310` 同形（`state = 'running'`、`addEventListener(type, listener)`、`resume()`）。这正是 `99790d1f` 对姊妹 spec 已做过的同一修法；**生产代码不改**。

### 根因二：改写中继只认领最后一条待定 caption（`upload-fixture.spec.ts:1337/1343`）

- `14b8e9ed fix(voice-realtime): attribute a delivery by its own message, not every unclaimed caption` 把 `sent` 帧的认领规则从「认领全部未归属 final caption」改成文本匹配，落在 `useVoiceRealtimeSession.ts:963`：
  `const carried = relayed === '' ? [] : matched.length > 0 ? matched : pending.slice(-1);`
- AC-326 的 e2e fixture 是 **rewrite 形态**：假上游发三条 final caption 携带 `ROW_HEARD`（`alfa bravo charlie` / `delta echo foxtrot` / `golf hotel india`，`upload-fixture.spec.ts:517-541`），一次 `session_send` 的 message 是 `ROW_DELIVERED`（`send the summary of the release notes to the team channel`，`:544-558`）—— 两者**无共同词**。于是 `matched=[]`，`carried=pending.slice(-1)` = 仅最后一条 `item_…_2`。
- 交付只认领 `item_…_2`：`src/modules/chat/voice-realtime/placeCaptions.ts:160-171` 的 fold 保留 `item_…_0/1` 折成第二行（行 id 取首条 `voice-caption-item_…_0`，`:180`）；`markDeliveredVoiceMessages`（`:343-361`）只吸收 `voice-caption-item_…_2`；`dropCaptionsDeliveredAsMessages`（`:375-397`）也留下它（其词不在 `ROW_DELIVERED` 里）。结果：交付行 + 残留 caption 行 = **2 行**，`:1337` 的「全程 ≤1」与 `:1343` 的「恰好 1」双双红（`:1347` 的徽章 title 也会缺前两段）。
- 为什么既有单测没抓住：`placeCaptions.test.ts` / `voiceSingleTranscriptRow.test.ts` 直接构造带**显式 `itemIds`** 的 `VoiceRealtimeDelivery`，绕过 hook 的 `carried` 启发式；`voiceStopVsExit.test.tsx`（`14b8e9ed` 自己加的）与 `useVoiceRealtimeSession.test.tsx:566-580` 用**逐字**中继（caption 词是 message 子串）走 `matched` 分支；`voiceCaptionShownState.test.tsx:289-313` 虽是 rewrite 但只有**一条** pending，`pending.slice(-1)` 恰好等于全部。AC-326 自己的 criterion 只跑单测文件（`voiceSingleTranscriptRow.test.ts` 等），e2e 不在其内 —— 这个缺口因此落进了 develop。

**修法**：让「rewrite 中继」认领**整个合并想法**的全部待定 caption（至少把 `:963` 的回退从 `pending.slice(-1)` 改为覆盖该想法的全部 `pending`），使 AC-326 的「一次想法 → 一行 → 徽章 heard 含三段」重新成立。

⚠️ **必须显式调和的张力**：`useVoiceRealtimeSession.ts:945-951` 的注释解释了 `14b8e9ed` 的意图 —— 宁可少认领（少认领的词留在屏上、可进制 composer），也不可静默丢词。简单回退成「一律认领全部未归属 final caption」会重新吞掉 `14b8e9ed` 要保护的那些「模型认出了但从未转发」的 utterance。作者需在 Plan 里给出判据能区分、且不破坏 `14b8e9ed` 自身单测的形态（例如按「同一次连续语音」边界限定认领范围），并在实现注释里写明取舍。

### 边界 / 不做

- 不改 AC-316 自身的实现形态（互斥渲染 / 固定栏 / Mute 语义 / 无草稿确认）—— 它们本就绿。
- 不改协议、`session_send` 白名单 / 参数校验、DashScope 连接/重连逻辑。
- 不放松 `voice-realtime-error` 的渲染条件、不改 `sent` 清 error 的既有语义（根因一不是渲染问题，是夹具崩溃）。

### 相关 / 粒度

`node scripts/dist/task-granularity-advice.js --touches <上述文件> --json` 读数 `peers: []` / `mentions: []`，判定 **separate / none found**。两个根因虽分属不同机制，但共用同一条判据链与同一批 serial spec 文件，一个任务内一起修才能一次性把判据跑绿（否则 serial 跳过会把另一个失败藏住）。

## Plan

1. 修根因一：`e2e/voice-realtime-live-session-send.spec.ts:511-526` 的 `FakeAudioContext` 补齐 `state` / `addEventListener` / `resume()`，与 `e2e/voice-realtime-scripted-scenarios.spec.ts:259-310` 同形。
2. 修根因二：重做 `useVoiceRealtimeSession.ts:952-963` 的 `carried` 回退，使 rewrite 中继认领整个合并想法的全部待定 caption；按需同步 `placeCaptions.ts` 的 fold / 吸收口径。实现注释必须写明与 `14b8e9ed`（`:945-951`）的取舍。若发现更稳的形态需要改 `audioSource.ts`（生产侧对 `addEventListener` 加 guard）而不是改夹具，在 Worktree Notes 说明并只选其一。
3. 新增 hook 级单测（`useVoiceRealtimeSession.test.tsx`）：构造 **≥2 条待定 final caption + 一条 message 与它们无共同词** 的 `sent` 帧，断言一次 delivery 的 `itemIds` 覆盖全部 pending（`heard` 含全部片段、fold 只剩一行）。这是当前无人覆盖的分支。
4. 复跑 AC-316 三条判据命令（逐条），并复跑 AC-326 的单测判据确认未弱化。
5. `npm run typecheck`、`npm run lint`。

## AC

- [x] AC1（验收判据本体）AC-316 的三条命令链式 exit 0，且第 1 条不再有 `did not run`（serial 下两个 spec 文件整体绿）：`npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts && npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts && npx playwright test e2e/voice-trim.spec.ts -g "AC-120"`。
- [x] AC2（新增覆盖）`npx vitest run src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` exit 0；其中新用例在「≥2 条待定 final caption + `sent.message` 与它们无共同词」下断言一次 delivery 的 `itemIds` 覆盖**全部** pending（`heard` = 全部片段），且在未修树上必红（实施者记一次红读数）。
- [x] AC3（取假形态，现场红后还原）(a) 去掉 `FakeAudioContext` 的 `addEventListener` ⇒ `e2e/voice-realtime-live-session-send.spec.ts:745` 必红（现场复现）；(b) 把 `carried` 回退改回 `pending.slice(-1)` ⇒ `e2e/voice-realtime-upload-fixture.spec.ts:1337` 与 `:1343` 必红（现场复现）。两处均须留红/绿两组输出。
- [x] AC4（回归不弱化）`npx vitest run src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts src/modules/chat/voice-realtime/tests/placeCaptions.test.ts src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx` exit 0；AC-326 的 criterion 命令仍 exit 0。
- [x] AC5（静态门）`npm run typecheck` exit 0；`npm run lint` exit 0，且无新增 voice-realtime 相关告警。

## DoD

真实浏览器 + 假上游（`e2e/voice-realtime-live-session-send.spec.ts` / `e2e/voice-realtime-upload-fixture.spec.ts` 自带的 scripted fake，零云调用）下，两个 spec 文件整体绿且无 skipped，并给出**修前/修后对照读数**：

- 根因二：修前 `upload-fixture.spec.ts:1265` 的 user-row 计数台账出现 `2`（残留 caption 行 + 交付行同屏）；修后全程恒 ≤1，交付后仍是**同一行**、文本为 `ROW_DELIVERED`、`voice-transcript-badge` 的 title 含全部三段 `ROW_HEARD`。
- 根因一：修前 `live-session-send.spec.ts:745` 的 `voice-realtime-error` 计数为 1；修后为 0，且页面 console 出现含 `MALFORMED_FUNCTION_CALL` 的 warning。

AC-316 的三条判据命令链在本任务 worktree 上实测 exit 0，输出写入 `## Notes`。不是「测试存在」—— 是判据链真的全绿、两组读数都来自真实运行。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- e2e/voice-realtime-live-session-send.spec.ts
- e2e/voice-realtime-upload-fixture.spec.ts
- src/modules/chat/voice-realtime/audioSource.ts（仅当作者选择生产侧 guard 而非改夹具）
- src/modules/chat/voice-realtime/placeCaptions.ts（仅当修 `carried` 需同步 fold/吸收口径）
- tasks/gap-ac316-restore-criterion-two-regressions.md

## Notes

立项：gap-filing（AC-316 离开 reverify scope 后判据当前为假）。本轮已直接重跑 AC-316 的 criterion 并逐条定位两个确定性回归的根因（含提交 sha 与 file:line），故本任务为直接测量得出的修复，不是台账尾巴继承。

### 落地记录（worktree，2026-10-12）

实现提交：`d526a5ff`（本 worktree 分支 `task/gap-ac316-restore-criterion-two-regressions`）。改动 3 文件：

- **根因一**：`e2e/voice-realtime-live-session-send.spec.ts` 的 `FakeAudioContext` 补齐 `state = 'running'` / `addEventListener('statechange', listener)` / `resume()`，与 `e2e/voice-realtime-scripted-scenarios.spec.ts` 同形。**选改夹具，生产代码 `audioSource.ts` 未改**（AC3(a) 已证夹具缺 `addEventListener` 即红；若改生产侧 guard 则该证伪不成立）。
- **根因二**：`useVoiceRealtimeSession.ts` 的 `carried` 回退由 `pending.slice(-1)` 改为 `thought` —— rewrite 中继认领「自上次交付以来所说的整段想法」的全部 pending caption。新增 `priorDeliveryWindowRef`：每次 `sent` 后记录当时屏上 caption 的 itemId 集合；下一次 rewrite 只认领**不在该集合中**的 pending，故 `14b8e9ed` 保护的「模型认出但从未转发」的 utterance 不会被后续 rewrite 吞掉。取舍（同一次连续语音窗口内、模型主动不转发的 utterance 无法与 rewrite 携带者区分，会多认领）已写入实现注释。
- **新增覆盖**：`useVoiceRealtimeSession.test.tsx` 两条用例（rewrite 覆盖全部 pending；rewrite 不认领上一次交付窗口内的 utterance）。

AC-316 判据链（本 worktree 实测，逐条 exit 0）：
1. `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts` → **11 passed (1.3m)**，0 failed，**0 did not run**（修前读数：`5 passed, 2 failed, 4 did not run`）。（经 `scripts/with-memory-cap.sh` 包裹。）
2. `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` → **19 passed / 0 fail**。
3. `npx playwright test e2e/voice-trim.spec.ts -g "AC-120"` → **1 passed**。

修前/修后对照读数（真实浏览器 + scripted fake，零云调用）：
- **根因二**（`upload-fixture.spec.ts:1265`，AC-326 用例）：修前台账 `counts=[1×61, 2×8]`（交付落定后恒为 2 = 残留 caption 行 + 交付行同屏），`:1337` `toBeLessThanOrEqual(1)` `Received: 2`、`:1343` `toHaveCount(1)` `Received: 2`。修后该用例 exit 0：全程 max ≤1，交付后仍是同一行、文本 `ROW_DELIVERED`、`voice-transcript-badge` title 含全部三段 `ROW_HEARD`。
- **根因一**（`live-session-send.spec.ts` 可恢复错误用例，原 `:745`，本轮加注后落在 `:759`）：修前 `voice-realtime-error` count = 1（`Expected: 0, Received: 1`）；修后 = 0，且 `MALFORMED_FUNCTION_CALL` warning 断言通过。

AC3 假形态现场红（红/绿两组均留存）：
- (a) 去掉假 `FakeAudioContext.addEventListener` ⇒ 该用例 exit 1，`Expected: 0, Received: 1`（红）；还原后 exit 0（绿）。
- (b) `carried` 改回 `pending.slice(-1)` ⇒ `:1337` `Received: 2`、`:1343` `Received: 2`，用例 exit 1（红）；还原后 exit 0（绿）。

单测（AC2/AC4）：`useVoiceRealtimeSession.test.tsx` **42 passed**（含新增两条）；AC4 五文件 **90 passed**。未修树红读数：两条新用例分别得到 `itemIds=['c']`（应 `['a','b','c']`）与 `['c']`（应 `['b','c']`）。

静态门（AC5）：`npm run typecheck` exit 0；`npm run lint` exit 0（无新增 voice-realtime 相关告警；余为既有他模块 warning）。
