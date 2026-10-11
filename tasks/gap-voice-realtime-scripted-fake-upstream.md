---
id: gap-voice-realtime-scripted-fake-upstream
title: 共享脚本化 Fake DashScope/Realtime 上游：事件脚本（字幕/function_call/延迟/上游
  error/MODEL_TEXT_REPLY/忙时排队）驱动真 transport+真 proxy，完全离线且不可误触云端
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-11 逐文件复核，带 file:line）

**两个标准假上游，都不足以承载"场景"。**

1. **冻结反应式**：`server/modules/voice-realtime/tests/voice-realtime-dashscope-harness.ts:84-206` 的 `createFakeDashscopeServer` 对每个 client 帧只回**一个固定反应**（`session.update`→created+updated；`input_audio_buffer.append`→`response.created`+`function_call_arguments.done`；`conversation.item.create(function_call_output)`→`response.done`）。它有 `failOpens` 旋钮，但**没有脚本能力**：不能发字幕事件、不能注入延迟、不能注入 `error`。
2. **每 spec 内联一份**：四个真浏览器 spec 各自手写上游——`e2e/voice-realtime-live-session-send.spec.ts:157`、`voice-realtime-upload-fixture.spec.ts:492-660`、`voice-realtime-composer-embedded.spec.ts:189-317`、`voice-realtime-turn-unanswered.spec.ts:161-259`。没有共享模块，能力参差。

**因此有一整类真实故障从来没有 stand-in**（grep 全 e2e 零命中）：上游 `error` 帧、`transcription.failed`、`response.text.done`（模型自答而不调工具）、会话中途断连、乱序/重复帧。这三个恰好都在生产 journal 里真实发生过：

- **`MODEL_TEXT_REPLY`**：2026-10-11 手机会话（`891da48b`，journal `c8b0ee15`）里用户说了 7 句，第 2–7 句上游模型回文本 "OK" 而**不调用 `session_send`**，服务端逐条发 `MODEL_TEXT_REPLY (recoverable)`；桥的判定点在 `server/modules/voice-realtime/voice-realtime-bridge.service.ts:706-716`（`response.text.done` 非空且非 follow-up ⇒ throw），且这是 `tool_choice: required` 下仍发生的上游限制（`voice-realtime-dashscope-transport.ts:80-86`）。
- **上游 `error` / `transcription.failed`**：桥在 `:717-730` 把它转成 fault，但没有任何假上游发得出来。

**已有的确定性范式（复用，不重建）**：`server/modules/voice-realtime/tests/voice-realtime-replay.test.ts` 已证明"事件脚本 → 真 transport → 真 proxy → 断言浏览器收到的帧"这条纵切可行：真 `createDashscopeTransport` + 假 `socketFactory`（`:78`）、真 `handleVoiceRealtimeConnection` + executor 替身（`:70-81`）、按 `TIME_SCALE=30` 压缩派发脚本事件（`:86-90`），首条断言即"健康会话 0 error 帧"（`:94-95`）。本任务把这套形状**提取成共享的、可脚本化的上游**，并把上面那类没有 stand-in 的故障补上。

### 隔离性质（本任务的核心保证）

假上游是 `DashscopeSocketFactory`——正是 transport 的凭据守卫视为"无真实端点、无凭据"的那条缝（`voice-realtime-dashscope-transport.ts:866-873`：无 `socketFactory` 且 `apiKey === ''` 即 `MISSING_API_KEY` 抛错；给了 socketFactory 才拨号）。它**不开 socket、不读凭据、不发起任何网络调用**，所以用它的场景**不可能误触云端**。这一点由 AC7 机械断言，而不是靠注释声称。

### SCOPE BOUNDARY（有意划下）

- ⛔ **不改** `src/modules/chat/voice-realtime/audioSource.ts` 的 `fileAudioSource`——它的帧间 `await Promise.resolve()` 是微任务、是承重的（改成宏任务会让握手竞态假形态变绿、废掉 AC-315 守卫）。独立 paced audio source 是后续任务。
- ⛔ 不迁移/改写四个既有 e2e spec（它们的 Touches 与三个 Live Voice 功能任务重叠，留给后续任务）。
- ⛔ 不做 Playwright/UI 层。
- ⛔ 不改任何生产代码路径（本任务只新增 `tests/` 下的文件）。

<!-- dedup-ref --> 机制去重（立案时实测，2026-10-11）：于 `tasks/*.md` 对 `fake upstream` / `scripted` / `脚本化` / `scenario runner` / `createFakeDashscopeServer` / `voice-realtime-replay` 逐个 grep，open 任务（`status: todo|ready`）0 命中；`假上游` / `harness` 仅命中 `gap-live-voice-voice-terminated-interrupt`（本任务为它提供能力，不重复其判据），`重放` 仅命中 `gap-voice-turn-detection-p0-15-worst-cases-replay`（轮次检测模型基准，机制不同）。`task-granularity-advice.js` 对本任务 Touches 报 `peers: []`。

## Plan

1. **新共享 helper**：`server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts`（**不叫 `*.test.ts`**，与既有 `voice-realtime-dashscope-harness.ts` 同理：它是被 import 的 helper，不得移动套件的测试文件计数）。导出：
   - `createScriptedUpstream(options)` → `{ socketFactory, clientFrames, endpointFrames, dialedUrl, dialedHeaders, emit(wire), runScript(events), drop() }`；socket 管道照搬既有 fixture 的微任务 `onopen` 约定（`:174`），`session.update` 仍自动回 created+updated（否则 transport 到不了 open），其余事件**全部由脚本拥有**。
   - 事件构造器（让场景可读、字段名不再各写一遍）：`captionDelta(itemId, stash)`、`captionCompleted(itemId, transcript)`、`functionCall(name, args, callId)`、`endpointError(code, message)`、`modelTextReply(text)`——字段名取自桥的读取处（delta 的正文在 `stash`、completed 在 `transcript`，见 `voice-realtime-bridge.service.ts:735-748`）。
   - `ScriptedEndpointEvent = { wire, afterMs? }`，`runScript` 按 `afterMs` 顺序派发并 await 完最后一个。
2. **新判据文件**：`server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts`。boot 形状照搬 `voice-realtime-replay.test.ts:65-82`（真 transport + 真 proxy + 假浏览器 socket + executor 替身），只把"录制重放"换成"脚本派发"。
3. **六个场景**（每个带协议级断言，不是快照）：
   - 健康脚本：2 条 item 各 delta+completed，其后两条 `session_send` function_call ⇒ **0 error 帧**、finals == 脚本顺序、executor 收到顺序一致、每条恰好一次。
   - 字幕：interim（正文在 `stash`、`text` 为空）**永远不产生空文本 final**。
   - 延迟：第二项带显著 `afterMs` ⇒ 顺序不变、无丢失（延迟不重排）。
   - 上游 `error` ⇒ 浏览器收到 error 帧，且 executor **未被调用**。
   - `MODEL_TEXT_REPLY`（模型自答不调工具）⇒ 浏览器收到该 code 的 error 帧，executor **未被调用**。
   - 忙时排队：executor 前两次返回 `{queued:true}`，脚本派 3 条 ⇒ 3 句全部按序投递，`sent` 帧的 `depth` 非降。**只断言"全部准入 + 有序 + depth 可读"，不断言上限数值**——上限轴正由 `gap-live-voice-queue-byte-budget-and-visible-backlog` 从条数改为字节，本任务不得与之冲突。
4. **离线保证**：场景全程用 `apiKey: ''` + 脚本 socketFactory 拨号；AC7 断言这样能成功、且 `dialedUrl` 是脚本自己的。若哪天有人把它换成真端点，凭据守卫会立刻 `MISSING_API_KEY`。
5. **静态门**：新增服务端测试文件会牵动 `server/shared/tests/quay-test-script.test.ts` 的收集集与 `scripts/suite-duration-baseline.tsv`（覆盖率为 ≥90% 比例断言，非硬计数），按实测同步；跑 `npm run typecheck`、`npm run lint`。

## AC

- [ ] AC1 健康脚本零 error（**取假形态，排在判据文件最前**）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts` 退出 0，且该文件**首条断言**即「健康脚本下 outbound 帧里 `error` 计数为 0」。
- [ ] AC2 字幕语义：同文件断言 finals 文本序列 == 脚本 `transcript` 序列，且**不存在** `final:true` 且文本为空/空白 的 caption 帧（interim 只带 `stash`，不得被当成 final）。
- [ ] AC3 延迟不重排：第二项带大 `afterMs` 时，`session_send` 的投递顺序仍与脚本顺序相同、条数不减（给出实际顺序读数）。
- [ ] AC4 上游 error 可见：脚本注入 `endpointError(...)` ⇒ outbound 出现 `type:'error'` 帧，且 executor 的调用计数为 0（给出 code 读数）。
- [ ] AC5 MODEL_TEXT_REPLY 可见：脚本注入 `modelTextReply('...')` ⇒ outbound 出现该 fault 对应的 `type:'error'` 帧，executor 调用计数为 0。
- [ ] AC6 忙时排队有序可见：executor 前两次返回 `queued:true` ⇒ 3 条 `session_send` 全部投递、顺序不变、`sent` 帧 `depth` 序列非降（给出 depth 轨迹）。**不断言上限数值。**
- [ ] AC7 完全离线（隔离断言）：transport 以 `apiKey: ''` + 脚本 socketFactory 拨号成功（无 socketFactory 时同参数必抛 `MISSING_API_KEY`，该对照在本 AC 内断言），且 `dialedUrl` 等于脚本自己的端点字符串。
- [ ] AC8 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0（新测试文件牵动其收集集时已同步）。

## DoD

一个**真实对象**被这套机制操作过：脚本化上游真的驱动了**生产 transport + 生产 proxy**（不是替身），浏览器收到的 outbound 帧序列被证明是脚本的确定性函数——同一脚本重跑得到逐条相同的帧序列；并且**此前没有任何 stand-in 能演的三类故障**（上游 `error`、模型自答的 `MODEL_TEXT_REPLY`、忙时排队）在这一层被真实复现并断言。证据落在本任务 `## 验证记录`：emitted/sent/outbound 三类帧计数、finals 与投递顺序读数、depth 轨迹、0 error 读数、以及"真端点必抛 MISSING_API_KEY"的负控读数。⛔ 本任务的 DoD 是**离线确定性**；真实云端对照与 UI 层是后续任务，不得在此声称。

## Touches

- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts (new)（共享脚本化上游 helper）
- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts (new)（本任务判据文件）
- server/modules/voice-realtime/tests/voice-realtime-dashscope-harness.ts (only if the socket plumbing is reused rather than re-implemented)
- server/shared/tests/quay-test-script.test.ts (only if the collected-file set or the baseline pin moves)
- scripts/suite-duration-baseline.tsv (only if the new test file needs a baseline row)
- tasks/gap-voice-realtime-scripted-fake-upstream.md (self)
