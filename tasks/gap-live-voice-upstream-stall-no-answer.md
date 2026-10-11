---
id: gap-live-voice-upstream-stall-no-answer
title: Live Voice 上游静默（听到但不回答）后该轮话语无归宿：实测 31 s 静默、8 s 已抛
  UPSTREAM_STALLED，用户体感「说完没反应」——先归因再定形态
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra: {}
---
## Proposal

**来源**：真人使用 Live Voice 的现场记录（`server.log`，时刻均为 UTC）。用户体感原话（通过 Live Voice 说出，被模型原文转写并投递，`d88c6722` 会话 2026-10-10T18:38:06Z）：

> 「我说完之后就没反应了。」

**现场证据（逐字）**：`UPSTREAM_STALLED (recoverable): The voice service heard you but has not answered for 8 s; it may be slow or stuck.` 在真实会话上出现过 **2 次**：

- `2026-10-09T16:13:35.400Z`（会话 `439bce2b`）
- `2026-10-11T01:56:35.223Z`（会话 `d88c6722`）

第二次有完整时序，可作回归基线：

```
01:56:22.190  << input_audio_buffer.speech_started      ← 上游听到人开始说话
01:56:22.333  << conversation.item.created
（01:56:22 → 01:56:53 之间：上游零事件，浏览器每 ~5 s 仍在推音频帧）
01:56:35.223  to-browser error UPSTREAM_STALLED (recoverable)   ← 8 s 静默时抛出
01:56:47.537  teardown: the browser socket closed               ← 浏览器先关了
01:56:53.118  << input_audio_buffer.speech_stopped      ← 上游 31 s 后才收尾
01:56:53.319  << transcription.completed "现在我看见只有…"
01:56:53.679  << function_call session_send {"message": "…"}
```

⇒ 上游真的静默了约 **31 s**，之后自己恢复（恢复后 0.56 s 内就走完了转写 + 投递）。关键：**8 s 抛出 `UPSTREAM_STALLED` 之后，这一轮用户话语的归宿没有被定义**——今天只有一条 recoverable error 帧，"屏幕上没反应"就是它的可见后果。

**去重（按机制，逐条核实过）**：本症状**无既有任务拥有**。

- `gap-voice-realtime-connection-resilience`（**done**）覆盖的是 **response 并发冲突**（AC1–AC4：在飞 response 状态跟踪 + 重放 `"Conversation already has an active response"`），不覆盖上游静默。
- `gap-voice-realtime-upstream-pool-rotation`（**done**）把 `UPSTREAM_STALLED` 当作**既有重连能力**引用（「断线重连逻辑已有（`UPSTREAM_STALLED` 处理）」），不是它修的缺陷。
- `gap-live-voice-caption-removal-on-shown`（ready）把 01:56 那次当作它 P3「关闭时刻的余波」的**时间线背景**，机制不同（它修 caption 移除时机）。
- `gap-live-voice-bounded-queue-refusal-visible`（ready）讲忙时有界排队与拒单可见；`gap-voice-realtime-empty-transcript-delivery-guard`（ready）讲空转写不得转发。两者都不碰上游静默。

**要做的事（先归因，再定形态，⛔ 本任务不预设结论）**：

1. **归因**：给出静默窗口内我方寄出/收到的帧逐条读数，判定静默发生在哪一侧（上游不回 vs 我方没在等/没在推）。
2. **定形态**：`UPSTREAM_STALLED` 之后该轮话语怎么收尾——有界等待后重发该轮 / 明确告知「没听到回答，可再说一次」/ 超时后换上游会话；把选择与理由写进 `## Resolution`。
3. **边界**：⛔ 不改上游（DashScope）行为、⛔ 不动 turn-detection 语义。若归因结论是「上游本就会偶发长静默，而产品形态已足够」，则本任务以**如实记录 + 标 won't-fix** 收口（同样算完成）。

## AC

- [x] AC1 **归因读数**：给出 `01:56:22–01:56:53` 这 31 s 窗口内寄往上游（`>>`）与收到（`<<`）的帧逐条（或"零事件"的计数），据此判定静默在哪一侧；结论与证据写进本任务（⛔ 不许只写「疑似上游」）。
  - 结论：**静默在上游侧**。逐条读数见 `## Resolution`「归因」：22.333→53.118 上游零事件（30.8 s），同期我方持续寄出 8 批音频（frames 6750→8000，至关闭共 8039 帧）。
- [x] AC2 **形态定死并落地**：在**可编排的假上游**（能"听到后静默 N 秒再回答"）下，`UPSTREAM_STALLED` 之后该轮话语的处置有**明确且可观测的归宿**（屏幕上出现明确状态 / 该轮被重发 / 明确告知用户），且该断言在**真实浏览器** e2e 上取真。
  - 归宿＝**明确告知**：棒条状态位显示 `voice-realtime-unanswered`（"No answer — say it again"），并在回答落地后清零。真实浏览器 e2e：`e2e/voice-realtime-turn-unanswered.spec.ts` AC2 用例绿（14.2s）。
- [x] AC3 **取假必红**：① 把注入静默设为 0（上游即时回答）⇒ AC2 的断言仍绿（证明它不是在测"上游慢"本身）；② 去掉处置逻辑 ⇒ AC2 红。逐条记录 diff、失败行与恢复命令。
  - ① `stallSilenceMs = 0` 的 control 用例绿（3.2s）。② 去掉处置（还原 proxy 两处）⇒ `✘ AC2 (20.3s)` 于 spec `:452` 红、`AC3(i) did not run`、EXIT=1。diff/失败行/恢复命令见 `## Resolution`「取假」。
- [x] AC4 **真机基线对照**：把上面那条 31 s 的真实窗口作为对照基线记录——修复后同一形态（真上游静默）下用户可见结局不再是"没反应"；若上游不再复现该形态，如实记「未在真机复现，只有注入式证据」。
  - 基线已录（见 `## Resolution`「基线」）：旧形态在 35.223 只上一条 recoverable error、棒条停在「Listening…」。修复后该形态可见结局改为「No answer — say it again」状态。真机未再复现该静默 ⇒ **只有注入式证据**，如实记录。
- [x] AC5 **静态门**：`npm run typecheck` 与 `npm run lint` 退出 0。
  - 二者 exit 0（lint 仅既有 warning，改动文件无一）。读数见 `## 验证记录`。

## DoD

真实读数：至少一条**注入式**（可编排静默）的端到端读数 + 对该轮话语归宿的明确断言；并记录 31 s 真实窗口作为对照基线。⛔ 只改错误文案、或只在单测里断言「抛了 UPSTREAM_STALLED」⇒ 不算达成（那正是今天的行为）。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-streaming-stages.test.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- e2e/voice-realtime-turn-unanswered.spec.ts (new)（可编排上游静默的浏览器 e2e：AC2 的 arm 与 AC3(i) 的 control）
- playwright.config.ts
- docs/operations/voice-realtime-test-stages.md
- tasks/gap-live-voice-upstream-stall-no-answer.md

## Notes

- 判据来源：`gap-voice-realtime-microphone-human-smoke-test`（needs-human）在执行"检查最近若干次 live voice 使用记录"时发现的现场症状；该任务是人工走查项，本任务接管其中**可自动化**的那一半。
- 相邻但不同：`gap-live-voice-caption-removal-on-shown` 的 P3 处理的是「关闭时刻未上屏话语的留痕」，与本任务的「静默期话语归宿」是两条不同的可见性缺口，⛔ 不要合并。

## Resolution

**归因（AC1）——静默在上游侧。** 真实窗口 `d88c6722`（连接 `95a9d738-4f11-4431-a156-659c4b8c2f51`，日志 `~/.cloudcli/voice-realtime-log/95a9d738-4f11-4431-a156-659c4b8c2f51.jsonl`，`mode: continuous`）逐条：

收到（`<<`，上游→我方）：

```
01:56:22.190  << input_audio_buffer.speech_started
01:56:22.333  << conversation.item.created
（此后 30.8 s 零条 <<）
01:56:53.118  << input_audio_buffer.speech_stopped
01:56:53.119  << input_audio_buffer.committed
01:56:53.320  << transcription.completed "现在我看见只有…"
01:56:53.679  << function_call session_send {…}
```

寄出（浏览器→我方，日志按批计数 `from-browser audio frames=N`）：

```
01:56:21.752  frames=6750        01:56:36.751  frames=7500
01:56:26.765  frames=7000        01:56:41.731  frames=7750
01:56:31.748  frames=7250        01:56:46.762  frames=8000
01:56:47.536  teardown: the browser sent a close frame (audio frames received=8039)
```

⇒ 22.333→53.118 之间上游**零事件**（30.8 s），而我方每 ~5 s 一批、每批 250 帧持续寄出（6750→8000，至浏览器主动关闭共 8039 帧）。**我方既在等也在推；静默完全在上游。**（`UPSTREAM_STALLED` 于 35.223 抛出；日志未记 arming 时刻，但整段窗口内没有任何 `<<` 会使计时器延后——即上游确无事件。）

**形态（AC2）——明确告知。** 把 `UPSTREAM_STALLED` 之后该轮话语做成一个**会话状态**（不是错误）：棒条状态位显示「No answer — say it again」，直到下一次投递回答它（或连接结束）。理由：

- ⛔ 不选「有界等待后重发该轮」：`continuous` 路径的音频**边流边弃**、从未留存，没有可重放的缓冲；且人可能早已改口，重发陈旧一轮会制造幽灵投递。
- ⛔ 不选「超时后换上游会话」：现场那台上游**并没有死**——31 s 后它在**同一 socket** 上完成了同一轮（`speech_stopped`→`transcription.completed`→`session_send`，恢复后 0.56 s 走完）。换会话会把一轮正要被回答的话丢掉。
- ✅ 「明确告知」诚实且零成本：真相就是「这轮没有被回答」，也没有可重试的损失。

落地三处：

1. **桥** `voice-realtime-bridge.service.ts`：计时器到期时**关闭该轮**（`awaitingTranscription = false`）。每个上游事件都会重新 arm；留着 `true` 会让下一个事件（迟到 caption / 上游刚醒）再开一个 8 s 窗口并**第二次**上报同一 stall（判据 B4 钉住）。
2. **代理** `voice-realtime-ws-proxy.service.ts`：该结局作为**自己的出站帧** `turn_unanswered` 发出（走桥的 `onError` hook，不进通用 error 通道；`'UPSTREAM_STALLED'` 从 `RECOVERABLE_ERROR_CODES` 移除），同时仍写一行人类可读日志到 server 侧（判据 P5 同时断言「有 `turn_unanswered`」与「没有同码 `error`」）。
3. **前端** `useVoiceRealtimeSession.ts` 持有 `unansweredSeconds`（投递 `sent` 时清空、重连清空），`VoiceRealtimeBar.tsx` 在**状态位**渲染 `voice-realtime-unanswered`——是状态变化，不是改文案。

**取假（AC3）。**

- ① 注入静默 `stallSilenceMs = 0`（上游即时回答）⇒ AC2 的同一读数仍绿：`✓ AC3(i) … (3.2s)`。
- ② 去掉处置：在 `voice-realtime-ws-proxy.service.ts` 删掉 `onError` 里的 `if (error.code === 'UPSTREAM_STALLED') { … return; }` 分支（使其回落到 `errorFrame`），并把 `'UPSTREAM_STALLED'` 放回 `RECOVERABLE_ERROR_CODES`（即还原 commit `af361c61` 在该文件的这两处改动）。读数：
  - `✘ 1  AC2 … (20.3s)`，失败行 `e2e/voice-realtime-turn-unanswered.spec.ts:452` —— `await expect(notice).toBeVisible({ timeout: 20_000 })` → `Error: element(s) not found`；
  - `- 2  AC3(i) … did not run`（`test.describe.configure({ mode: 'serial' })`）；
  - 进程 EXIT=1。
- 恢复命令：`git restore server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`。复原后复跑：`✓ AC2 (14.2s) ✓ AC3(i) (3.2s)`，EXIT=0。

**基线（AC4）。** 上面 31 s 真实窗口记为**旧形态**基线：`error UPSTREAM_STALLED (recoverable)` 于 35.223 上屏，此后棒条停在「Listening…」，该轮话语无归宿。修复后**同一形态下用户可见结局不再是「没反应」**（改为「No answer — say it again」的状态，直到回答落地）——以注入式 e2e 为准。**真机未再复现该静默形态 ⇒ 只有注入式证据**，按 AC4 允许如实记录。

## 验证记录

- `npm run typecheck` → exit 0；`npm run lint` → exit 0（仅既有的无关 warning，改动文件无一命中）。
- 桥（stage B）：`server/modules/voice-realtime/tests/voice-realtime-streaming-stages.test.ts` → **16/16**（含新 B4「stall 关闭该轮、迟到的上游事件不再二次上报」）。
- 代理（stage P）：同文件 P5 → 绿（`turn_unanswered` 到达且无同码 `error` 帧）。
- 桥既有判据：`…/voice-realtime-bridge.test.ts` → **6/6**（本任务未改该文件）。
- 前端 hook：`src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` → **28/28**（含 3 条新用例：unanswered 是独立状态非错误且会话继续 / 投递回答后清零 / 不跨连接存活）。
- 浏览器 e2e（新文件）：`npx playwright test e2e/voice-realtime-turn-unanswered.spec.ts` → **2 passed (26.9s)**，整次调用墙钟 27.3s（暖）。归属与理由：arm 必须**跨过**桥的 8 s 截止，~14s 是别的 voice 用例都不付的；放进 `voice-realtime-upload-fixture.spec.ts` 会把该文件推过其 55s 看门狗并因此弄红已 achieved 的 AC-315/AC-317（那是时钟的事实，不是行为的事实），故独立成文件。
- 配置登记：新文件已加入 `playwright.config.ts` 的 `DEBUG_AGENT_SPEC_FILES` 与 `voiceRealtimeSelection`，并声明 `SPEC_BUDGET_MS['voice-realtime-turn-unanswered.spec.ts'] = 120_000`（实测 2026-10-11）。
- 未回归核对：还原后 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` → **5 passed (36.8s)**（该文件与本分支 byte-identical，工作树 diff 为空）。
