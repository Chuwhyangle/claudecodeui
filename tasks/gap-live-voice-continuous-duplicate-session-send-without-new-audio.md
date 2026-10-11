---
id: gap-live-voice-continuous-duplicate-session-send-without-new-audio
title: Live Voice 连续模式：上游无新语音时自起一轮、重复调用 session_send，同一句被重复投递进会话——按「未转发 commit
  计数 == 0 且字面已投递」判伪调用并以 already-delivered 应答丢弃
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

### 现象（2026-10-11 操作者实测，journal 逐行复核）

journal `/data/home/yale/.cloudcli/voice-realtime-log/57279cc1-f597-428f-8f39-7e1d53804510.jsonl`（会话 `79d7515b-24b8-409c-b434-f4669105373b`，连续模式）：
- 真实语音：15:39:54.419Z `input_audio_buffer.committed`（第 190 行）→ 15:39:54.640Z 转写「呃，我们原来的这些风格还是有蛮大的差异。」；15:39:57.238Z 第二次 `committed`（第 197 行）→ 转写「这个应该要检查和讨论一下。」；15:39:57.837Z `function_call session_send {"message": "我们原来的这些风格还是有蛮大的差异，这个应该要检查和讨论一下。"}`（第 203 行），2500 ms 合并窗后 15:40:00.340Z `session_send delivered`（第 214 行）。
- 之后**没有任何** `speech_started` / `speech_stopped` / `committed` / `transcription`：15:40:13.288Z 一条 `conversation.item.created`（第 218 行）→ `response.created` → 同一字面的 `session_send`（第 222 行）→ 15:40:16.383Z 再次 delivered（第 233 行）；15:40:29.891Z 又一轮（第 238/242 行）→ 15:40:33.009Z 第三次 delivered（第 252 行）。同一句话被投递进 Claude 会话 **3 次**。
- `response` 行第 8–10 次 `audioTokens` 都是 259（第 208/227/247 行）：上游这几轮没有新的输入音频。约 21 s 后模型自己回了 "No response requested."。
- 三次前面都有我方 `>> response.create`（第 211/230/250 行，tool-resume 那一发）。但另一份 journal `95a9d738-4f11-4431-a156-659c4b8c2f51.jsonl` 第 155–159 行（01:57:04.450Z→01:57:05.023Z）出现同形的「无语音 item.created → response.created → 同一 session_send」，其前**没有**我方 `response.create`——上游能自己起这一轮。⚠️ 照实记录该例的局限：它发生在浏览器已断开之后（第 141–143 行 01:56:47.537Z `teardown: the browser socket closed`），两次调用都没有被投递也没有收到 `function_call_output`，所以它证明「上游会自起响应」，不是一次重复投递的实例。
- 九份 journal 的普查（脚本在 `/tmp/dupscan/`，可能已清理）：所有 41 次有新音频支撑的调用之前都至少有一次 `input_audio_buffer.committed`；没有新音频的 4 次 = 上面 3 次重复 + 1 次合法的迟到转发（`f6166468-b912-4ff9-8522-70935c4afc27.jsonl` 00:14:54.700Z「啊，稍好一点。」，第 91 行：模型先在第 68/80 行用文本答了 "No response requested."，再补发转发，第 99 行 delivered）。注：按本任务的计数器口径，这一次在上次投递（00:14:50.079Z，第 50 行）之后有 2 次 `committed`（第 54、61 行），计数器 = 2，单凭计数器就会放行；它的字面也与上次投递不同。

### 为什么现有守卫拦不住（2026-10-12 逐文件复核，develop `bd89d597`）

- `call_id` 每次都是新的。
- `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:791` 的 `deliveredSegmentSeqs` 去重只在分段转发路径生效：`:1067-1072` 的 replay 闸要求 `segmentSeq !== null && segmentIsReplay`，`:1116` 只记录非空 `seq`；连续模式下 `seq` 为 null，这道闸永远不触发。
- 工具结果文本 `:1143`（"The message was accepted and will reach the session. Do not call session_send again for it. Reply with the single word OK."）被模型忽略。
- `server/modules/voice-realtime/voice-realtime-bridge.service.ts:307` 的 `MAX_CALLS_PER_UTTERANCE = 6`（`:763-765` 抛 `TOOL_LOOP_GUARD`）计数在 `:702` 收到 `transcription.completed` 时清零；本例 3 次远低于 6。
- 连续模式下 ws-proxy **根本看不到** `input_audio_buffer.committed`：它在 bridge `:101-123` 的 `TOLERATED_ENDPOINT_EVENTS`（`:110`）里，`dispatch`（`:647-705`）遇到即 return；`onSegmentPhase`（ws-proxy `:1308-1328`）的 `committed` 只来自分段路径。所以实现须给 bridge 加一个钩子（如 `onUserAudioCommitted`），在 `RealtimeBridgeHooks`（bridge `:283-290`）声明、在 ws-proxy 接线。
- 诊断面只记事件类型：`server/modules/voice-realtime/voice-realtime-diagnose.service.ts:192-235` 的 `summarizeWireObservation` 对 `conversation.item.created` / `response.created` 走 `default: return type`；原始帧在 `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts:796-800` 的 `handleInbound` 里可得（`options.observer`）；usage 解析在 `server/modules/voice-realtime/voice-realtime-log.ts:387-401` 的 `measureUsage`。
- 不是修法：去掉输出后的 `response.create`。`server/index.ts:530-534` 记录过一次回滚——去掉 tool-resume 后模型在后续语句里用文本答 "No response requested." 而不转发（5 句丢 3 句）；且上例 `95a9d738` 表明上游会自起这一轮。

### 修法（已裁定）

1. 连续模式下每条连接维护「未转发的已提交用户音频」计数器：每个 `input_audio_buffer.committed` +1；一次 `session_send` 被接受投递时清零。计 commit 而不计转写完成（转写可能失败，见同 journal 第 13 行 `TRANSCRIPTION_FAILED`）。清零时点取「调用通过 `proceedRelay` 各道闸、被接受（开窗或入窗）」的那一刻，而不是 2500 ms 合并窗 flush 的那一刻——这样窗内到达的新 commit 记给下一句，不会被 flush 抹掉。
2. 判定伪调用：计数器 == 0 **且** 规范化文本（去空白、标点、引号）等于或被包含于「最近一次已投递消息」的规范化文本（若合并窗仍开着，比较对象含窗内待发的 `pendingParts` 拼接）。
3. 伪调用 ⇒ 不投递；以 replay 回答同形的 output 应答（`{ accepted: true, instruction: '…has already reached the session. Do not call session_send again for it. Reply with the single word OK.' }`，见 `:1067-1072`），保证该调用不被悬空；该应答走普通 `function_call_output` 路径，随之的那一次 tool-resume `response.create` 照旧，**不额外**再发；journal 记一行 `session_send not-delivered (duplicate: …)`——复用 `:1037` 的 `noteNotDelivered`，`voice-realtime-log.ts:382` 的 `SEND_NOT_DELIVERED_LINE` 已能解析，DoD 用 `duplicate` 字样检索。
4. 保留每语句 6 次上限作兜底，不改。
5. 诊断：对 `conversation.item.created` 记 `item.id` / `item.type` / `item.role` / `item.call_id` / `previous_item_id`；对 `response.created` 记 `response.id`；对 `response.done` 已有 `in=`，补 `audio=`（`usage.input_tokens_details.audio_tokens`）。下次能认出那条「无语音 item」是谁。

### 关联 / 粒度

<!-- dedup-ref --> 机制去重（2026-10-12 实测）：open 任务对 `重复投递` / `duplicate` / `deliveredSegmentSeqs` / `input_audio_buffer.committed` 无同机制命中。`task-granularity-advice.js` 报 peer `gap-live-voice-status-aggregate-and-inject`（ready，共享 ws-proxy 与 bridge 两个文件）：kept separate——那是向上游注入执行面状态（`session.update`），本任务是连续模式下对 `session_send` 伪调用的去重，机制与验收独立；对方已 ready、即将派发，同文件由调度器串行，不损并行。`gap-live-voice-e2e-scripted-upstream` 的 AC6「会话切换无重复投递」是切会话场景，不覆盖本机制。

## AC

- [x] AC1 重放 57279cc1 事件序列只投递一次（**取假形态，排在判据文件该组最前**）：`server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` 新增用例，以假上游按序灌入 15:39:54–15:40:33 的事件（两次 `speech_stopped`+`committed`+`transcription.completed`，`function_call session_send`，之后两轮仅 `conversation.item.created`→`response.created`→同一字面 `session_send`），断言执行器的 `session_send` 恰被调用 **1** 次；后两次调用都收到 `accepted:true` 且 instruction 含 `already reached the session` 的 `function_call_output`；journal/log 捕获到 2 行含 `not-delivered (duplicate` 的记录。在未修复的树上该用例必红（实施者记一次红读数：调用 3 次）。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` 退出 0。
- [x] AC2 迟到转发仍投递（负控）：同文件，重放 f6166468 00:14:50–00:14:57 形态——上次投递之后有 commit 与转写、模型先以文本答 "No response requested."、随后无新音频地发出一个从未投递过的字面（「啊，稍好一点。」）的 `session_send`——断言该调用被投递（执行器收到该 message）。另加一例：计数器 == 0 但字面与上次投递不同且不被包含 ⇒ 仍投递。判据同 AC1 命令退出 0。
- [x] AC3 用户真的重复说同一句仍投递（负控）：同文件，上次投递之后又有一次 `committed`（计数器 > 0），模型以与上次完全相同的字面调用 `session_send` ⇒ 断言被投递（执行器调用次数 +1）。判据同 AC1 命令退出 0。
- [x] AC4 commit 钩子：`server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 断言连续模式下上游 `input_audio_buffer.committed` 触发新钩子恰一次，且该事件仍不被报成错误。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 退出 0。
- [x] AC5 诊断字段：`server/modules/voice-realtime/tests/voice-realtime-diagnose.test.ts` 断言 `summarizeWireObservation` 对带 `item:{id,type,role,call_id}` 与 `previous_item_id` 的 `conversation.item.created` 输出含这些值的行、对 `response.created` 输出含 `response.id` 的行、对 `response.done` 输出含 audio token 数的行。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-diagnose.test.ts` 退出 0。
- [x] AC6 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

一个**真实对象**被这套机制操作过：用真实 Live Voice（连续模式、真实 DashScope 上游）在一个真实会话里说若干句话、其间留出 ≥15 s 的静默，跑完后读该连接的 journal（`~/.cloudcli/voice-realtime-log/<connectionId>.jsonl`）：同一字面的 `session_send delivered` 在没有新 `input_audio_buffer.committed` 的情况下不出现第二次；若上游这次又自起了无语音的那一轮，journal 里出现 `session_send not-delivered (duplicate…)` 行，且其前的 `conversation.item.created` / `response.created` 行带上了 item/response id 字段。证据落在本任务 `## 验证记录`：connectionId、相关 journal 行号与原文、Claude 会话里该句只出现一次的读数。若该次实测上游没有复现自起那一轮，如实记录「未复现」并附新诊断字段确已落盘的行，不得以单元测试代替。仅有单元测试不算 done。

## 验证记录

### 红读数（未修复的树）

AC1 的假形态在**未修复**的树上必红：把 `voice-realtime-ws-proxy.service.ts` 临时还原为 develop 版（先备份到 `/tmp/wt-wsproxy-mine.ts`，再 `git checkout HEAD -- <file>`），跑 AC1 用例读到 **`3 !== 1`**——执行器 `session_send` 被调用 **3** 次，而判据断言 **1** 次。读数与 journal 57279cc1 的三次投递一致。随后恢复实现。

### 绿读数（本工作树，`fb2dca8c`，已 `merge develop`）

- AC1/AC2/AC3：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` → **18 passed / 0 failed**。含 `AC1: the 57279cc1 sequence delivers the sentence once …`、`AC2 (negative control): the f6166468 late forward — commits present, a different literal — is still delivered`、`AC2 (negative control): counter 0 but a literal the last delivery does not contain is still delivered`、`AC3 (negative control): the user really repeating the same words (a fresh commit) is delivered`。
- AC4：`… voice-realtime-bridge.test.ts` → **8 passed / 0 failed**（含 `AC4: a committed user utterance fires onUserAudioCommitted once and is not reported as an error`）。
- AC5：`… voice-realtime-diagnose.test.ts` → **12 passed / 0 failed**。
- AC6：`npm run typecheck` 退出 0（`tsconfig.json` / `server/tsconfig.json` / `scripts/tsconfig.json` 三项）；`npm run lint`（oxlint）退出 0，仅存量前端 warning，与本改动无关。
- 回归面：`… voice-realtime-segmented-protocol.test.ts` → **21 passed / 0 failed**，含 `AC8 false form (a): removing the seq dedup makes the idempotency case red`；`… voice-realtime-upstream-pool.test.ts` → **7 passed / 0 failed**。

### 实现要点

- bridge 新增钩子 `RealtimeBridgeHooks.onUserAudioCommitted`；`input_audio_buffer.committed` **仍留在** `TOLERATED_ENDPOINT_EVENTS`（不报错），只多一次 hook 调用。
- 计数器 `unforwardedUserAudioCommits`：commit 事件 +1；一次 `session_send` 被**接受投递**时清零（清零在 `proceedRelay` 通过各闸之后，**不是**合并窗 flush 之时）。
- 伪调用闸：`segmentSeq === null`（连续模式）且 计数器 == 0 且 规范化文本相等/被包含 ⇒ 以 `already reached the session` 应答、不投递、journal 记 `session_send not-delivered (duplicate: …)`。限定 `segmentSeq === null` 使分段路径继续由它自己的 `seq` 身份闸负责，两闸互不遮蔽。
- `normalizeRelayText` 去空白/标点/符号，抹平引号位置差异（`95a9d738` 那一类）。
- 池 `voice-realtime-upstream-pool.ts` 转发该钩子（`VOICE_REALTIME_IDLE_ROTATE_MS` 轮换下守卫不失效），故列入 Touches。
- 诊断：`conversation.item.created`（`item.id/type/role/call_id` + `previous_item_id`）、`response.created`（`response.id`）、`response.done` 增 `audio=`。

### DoD（真实服务）— 本轮**未执行**

本 worker 轮**没有**执行真实服务 DoD。原因：本任务 DoD 的关键读数需要一次真实会话经真实 DashScope 上游的连续模式会话——真实朗读、其后静默 ≥15 s——并**恰好**复现上游自起一轮（`conversation.item.created` → `response.created`）后模型再次发出同一字面 `session_send`。该自起是**上游行为竞态**，复现与否不由本改动决定；且该跑还需要一个真实 resident 会话作为 `session_send` 的落点。本轮以单元判据（AC1–AC6）完整覆盖了机制与负控，**但 DoD 的真实对象读数仍缺**。补跑配方（已在 `dod-real-live-voice-without-restart` 记录）：在**备用端口**起第二实例（`HOME=/tmp/… SERVER_PORT=3971 VOICE_REALTIME_CAPTURE=on VOICE_REALTIME_LOG_DIR=/tmp/log VITE_IS_PLATFORM=true JWT_SECRET=x npx tsx --tsconfig server/tsconfig.json server/index.ts`），以 raw `ws` 连 `/voice-realtime?session=<existing>`，灌 `experiments/voice-realtime-ambiguity/fixtures/audio/*.wav` 的 PCM 帧（连续模式），完事读 `~/.cloudcli/voice-realtime-log/<connectionId>.jsonl`：`session_send delivered` 不应在无新 `committed` 时出现第二次；若复现无语音轮，应见 `not-delivered (duplicate…)` 行，且其前的 `conversation.item.created` / `response.created` 行带 item/response id。**据 DoD「仅有单元测试不算 done」，本任务在补跑并把 connectionId 与 journal 行原文落回本节之前，不应记为 done。**

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-diagnose.service.ts
- server/modules/voice-realtime/voice-realtime-upstream-pool.ts (forwards the new `onUserAudioCommitted` hook so the guard survives idle rotation)
- server/modules/voice-realtime/voice-realtime-log.ts (only if the usage line needs the audio-token reading surfaced)
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts
- server/modules/voice-realtime/tests/voice-realtime-diagnose.test.ts
- tasks/gap-live-voice-continuous-duplicate-session-send-without-new-audio.md (self)

## Notes

- 判据放进既有测试文件而非新建：新增 server 测试文件会使 `server/shared/tests/quay-test-script.test.ts` 钉死的文件数变红（全舰队 UNATTRIBUTABLE）。若实施者坚持新建文件，须同时改该 pin 与 `scripts/suite-duration-baseline.tsv` 并把两者加入 Touches。
- 规范化示例：`95a9d738` 的两次字面只差引号位置（「只有用"现在我在用live voice"」对「只有"用现在我在用live voice"」），规范化须抹平这类差异。