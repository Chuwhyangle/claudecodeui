---
id: gap-voice-realtime-scripted-fake-upstream
title: 共享脚本化 Fake DashScope/Realtime 上游：事件脚本（字幕/function_call/延迟/上游
  error/MODEL_TEXT_REPLY/忙时排队）驱动真 transport+真 proxy，完全离线且不可误触云端
status: ready
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
2. **每 spec 内联一份**：四个真浏览器 spec 各自手写上游——`e2e/voice-realtime-live-session-send.spec.ts:156-266`、`voice-realtime-upload-fixture.spec.ts:492-660`、`voice-realtime-composer-embedded.spec.ts:189-317`、`voice-realtime-turn-unanswered.spec.ts:161-260`。没有共享模块。（另有一份第三形态：`voice-realtime-follow-up-credit.test.ts:96-127` 自带的 `createScriptedUpstream`。）

**因此有一整类真实故障从来没有 stand-in**（grep 全 e2e 零命中）：上游 `error` 帧、`transcription.failed`、`response.text.done`（模型自答而不调工具）、会话中途断连、乱序/重复帧。前三个恰好都在生产 journal 里真实发生过：

- **`MODEL_TEXT_REPLY`**：2026-10-11 手机会话（`891da48b`，journal `c8b0ee15`）里用户说了 7 句，第 2–7 句上游模型回文本 "OK" 而**不调用 `session_send`**，服务端逐条发 `MODEL_TEXT_REPLY (recoverable)`；桥的判定点在 `server/modules/voice-realtime/voice-realtime-bridge.service.ts:706-716`（`response.text.done` 非空且非 follow-up ⇒ throw），且这是 `tool_choice: required` 下仍发生的上游限制（`voice-realtime-dashscope-transport.ts:80-86`）。
- **上游 `error` / `transcription.failed`**：桥在 `:717-730` 把它转成 fault，但没有任何假上游发得出来。

**已有的确定性范式（复用，不重建）**：`server/modules/voice-realtime/tests/voice-realtime-replay.test.ts` 已证明"事件脚本 → 真 transport → 真 proxy → 断言浏览器收到的帧"这条纵切可行：真 `createDashscopeTransport` + 假 `socketFactory`（`:78`）、真 `handleVoiceRealtimeConnection` + executor 替身（`:70-81`）、按 `TIME_SCALE=30` 压缩派发脚本事件（`:86-90`），首条断言即"健康会话 0 error 帧"（`:94-95`）。本任务把这套形状**提取成共享的、可脚本化的上游**，并把上面那类没有 stand-in 的故障补上。

### 隔离性质（本任务的核心保证）

假上游是 `DashscopeSocketFactory`——正是 transport 的凭据守卫视为"无真实端点、无凭据"的那条缝（`voice-realtime-dashscope-transport.ts:866-873`：无 `socketFactory` 且 `apiKey === ''` 即 `MISSING_API_KEY` 抛错；给了 socketFactory 才拨号）。它**不开 socket、不读凭据、不发起任何网络调用**，所以用它的场景**不可能误触云端**。这一点由验证记录里的负控机械断言，而不是靠注释声称。

### SCOPE BOUNDARY（有意划下）

- ⛔ **不改** `src/modules/chat/voice-realtime/audioSource.ts` 的 `fileAudioSource`——它的帧间 `await Promise.resolve()` 是微任务、是承重的（改成宏任务会让握手竞态假形态变绿、废掉 AC-315 守卫）。独立 paced audio source 是后续任务。
- ⛔ 不迁移/改写四个既有 e2e spec（它们的 Touches 与三个 Live Voice 功能任务重叠，留给后续任务）。
- ⛔ 不做 Playwright/UI 层。
- ⛔ 不改任何生产代码路径（本任务只新增 `tests/` 下的文件 + 一个计数钉子）。

<!-- dedup-ref --> 机制去重（立案时实测，2026-10-11）：于 `tasks/*.md` 对 `fake upstream` / `scripted` / `脚本化` / `scenario runner` / `createFakeDashscopeServer` / `voice-realtime-replay` 逐个 grep，open 任务（`status: todo|ready`）0 命中；`假上游` / `harness` 仅命中 `gap-live-voice-voice-terminated-interrupt`（本任务为它提供能力，不重复其判据），`重放` 仅命中 `gap-voice-turn-detection-p0-15-worst-cases-replay`（轮次检测模型基准，机制不同）。`task-granularity-advice.js` 对本任务 Touches 报 `peers: []`。

## Plan

1. **新共享 helper**：`server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts`（**不叫 `*.test.ts`**，与既有 harness 同理：被 import 的 helper 不得移动套件的测试文件计数）。导出 `createScriptedUpstream`（`socketFactory` / `clientFrames` / `endpointFrames` / `dialedUrl` / `dialedHeaders` / `emit` / `runScript` / `drop`）与 `SCRIPTED_ENDPOINT_URL`（`ws://scripted.invalid/...`，`.invalid` 不可解析），外加事件构造器 `captionDelta` / `captionCompleted` / `functionCall` / `endpointError` / `modelTextReply` / `transcriptionFailed`——字段名取自桥的读取处（delta 正文在 `stash`、completed 在 `transcript`，见 `voice-realtime-bridge.service.ts:749-756`）。
2. **新判据文件**：`server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts`。boot 形状照搬 `voice-realtime-replay.test.ts`（真 transport + 真 proxy + 假浏览器 socket + executor 替身）。
3. **八个场景**（每个是协议级断言，不是快照）：健康脚本（0 error + finals/投递各一次且同序）、interim 不产生空 final、延迟不重排、上游 `error`、`MODEL_TEXT_REPLY`、`transcription.failed`、忙时排队有序且 depth 可读、隔离证明（拨的是脚本地址 + 无 socketFactory 时必拒）。
4. **离线保证**：全程 `apiKey: ''` + 脚本 socketFactory + `endpoint: SCRIPTED_ENDPOINT_URL`。
5. **静态门**：新测试文件牵动 `server/shared/tests/quay-test-script.test.ts` 的两个 `unknown=` 计数钉子，按实测同步。

## AC

- [x] AC1 健康脚本零 error（**取假形态，排在判据文件最前**）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts` 退出 0，且该文件**首条断言**即「健康脚本下 outbound 帧里 `error` 计数为 0」。
- [x] AC2 字幕语义：finals 文本序列 == 脚本 `transcript` 序列，且**不存在** `final:true` 且文本为空/空白 的 caption 帧（interim 只带 `stash`）。
- [x] AC3 延迟不重排：第二项带 50 ms `afterMs` 时，投递顺序仍与脚本顺序相同、条数不减。
- [x] AC4 上游 error 可见：脚本注入 `endpointError(...)` ⇒ outbound 出现 `code === 'UPSTREAM_ERROR'` 的 error 帧，且 executor 调用计数为 0。
- [x] AC5 MODEL_TEXT_REPLY 可见：脚本注入 `modelTextReply('OK')` ⇒ outbound 出现 `code === 'MODEL_TEXT_REPLY'` 的 error 帧，executor 调用计数为 0、投递为空。
- [x] AC6 忙时排队有序可见：executor 前两次返回 `queued:true` ⇒ 3 条 `session_send` 全部按序投递、无 error，且 `sent` 帧各带一个 depth 读数、其中**至少 2 条 > 0**。实测轨迹 `[1,2,0]`（第三条开始了一个 run，故归零）——**本 AC 只断言"被报告为持有工作"，不断言任何上限数值**：上限轴正由 `gap-live-voice-queue-byte-budget-and-visible-backlog` 从条数改为字节，本任务不得与之冲突。
- [x] AC7 完全离线（隔离断言）：`dialedUrl` 以 `SCRIPTED_ENDPOINT_URL` 开头；同一参数**去掉 socketFactory** 时 `open()` 必拒（`/DASHSCOPE_API_KEY is required/`），故场景不可能拨到真端点。
- [x] AC8 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

一个**真实对象**被这套机制操作过：脚本化上游真的驱动了**生产 transport + 生产 proxy**（`createDashscopeTransport` + `handleVoiceRealtimeConnection`，即 `server/index.ts` 生产装配的同一对函数），浏览器收到的 outbound 帧序列是脚本的确定性函数；并且**此前没有任何 stand-in 能演的三类故障**（上游 `error`、模型自答的 `MODEL_TEXT_REPLY`、忙时排队）在这一层被真实复现并断言。证据见 `## 验证记录`。⛔ 本任务的 DoD 是**离线确定性**；真实云端对照与 UI 层是后续任务，此处不声称。

## 验证记录

**实现（worktree `gap-voice-realtime-scripted-fake-upstream`，分支 `task/gap-voice-realtime-scripted-fake-upstream`）。** 新增共享 helper `voice-realtime-scripted-upstream.ts`（227 行）与判据文件 `voice-realtime-scripted-scenarios.test.ts`（288 行），并同步 `server/shared/tests/quay-test-script.test.ts` 的两个计数钉子（`unknown=286`→`287`、`288`→`289`；新测试文件使收集集 +1）。已合并 develop 后再验，无冲突。

**AC1–AC7（判据文件）** `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts` → **8/8 pass，fail 0**（文件内各例 2.1–57.4 ms；整次含导入 5.667 s）。八例即 AC1–AC7 的载体：健康脚本 / interim 不含空 final / 延迟不重排 / 上游 error / MODEL_TEXT_REPLY / transcription.failed / 忙时排队 / 隔离证明。

**取假形态（falsification）**：把 `endpointError('FALSIFY', 'a deliberately injected failure')` 临时插入"健康脚本"的脚本末尾后重跑 `--test-name-pattern="healthy script"` → `✖` + `AssertionError: a healthy script must produce no error frames`，exit 1（actual 为 `[{type:'error', code:'UPSTREAM_ERROR', …}]`）；撤销后 8/8 复绿。故首条断言是活的、非空过。

**实测读数**（一次性探针 `server/probe-scripted-readings.mts`，跑完即删、树内无残留）：
`VERDICT {"delivered":["第一句","第二句","第三句"],"finals":["第一句","第二句","第三句"],"depths":[1,2,0],"outboundFrames":7,"endpointFrames":11,"clientFrames":7,"errors":0,"dialedUrl":"ws://scripted.invalid/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime"}`
—— 投递与字幕同序且各一次；忙时 depth 轨迹 `[1,2,0]`；拨号地址是脚本自己的（离线）；0 error。

**AC7 负控**：同参数去掉 `socketFactory` 的 transport，`open()` 以 `DASHSCOPE_API_KEY is required to open the real DashScope realtime transport` 拒绝（断言在判据文件内）。故"用脚本工厂就不可能上云"是被机械保证的，不是注释声称。

**AC8 静态门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0（仅既有 warning，未新增）；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 11/11 pass。⚠️ 该文件在**未**同步钉子时是 2 红（AC2/AC3 的 `unknown=` 计数），已实测复现并修复（移走新文件 → 11/11；放回 → 2 红；改钉子 → 11/11）。

**提交**：`5f36f3d2 test(voice-realtime): add a scripted offline endpoint for Live Voice scenarios`（+517/−2，3 文件），其后合并 `develop`。

**范围外/未做（如实登记）**：未改 `fileAudioSource` 的微任务 yield；未迁移四个既有 e2e spec；未做 Playwright/UI 层；**未跑全量 suite**（会话 cgroup 8 GiB，全量只在 quay fan-in 跑），故 develop 的 ff 落地属 fan-in 步骤。

## Touches

- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts (new)（共享脚本化上游 helper）
- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts (new)（本任务判据文件）
- server/modules/voice-realtime/tests/voice-realtime-dashscope-harness.ts (only if the socket plumbing is reused rather than re-implemented)
- server/shared/tests/quay-test-script.test.ts (only if the collected-file set or the baseline pin moves)
- scripts/suite-duration-baseline.tsv (only if the new test file needs a baseline row)
- tasks/gap-voice-realtime-scripted-fake-upstream.md (self)
