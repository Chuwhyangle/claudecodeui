---
id: gap-live-voice-intent-control-browser-e2e
title: Live Voice 意图控制浏览器验收：Scripted Fake+Paced
  Audio+Playwright，故障注入、跨文本/语音顺序、幂等（阶段 1d）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-interrupt-after-revision-enqueued
  - gap-live-voice-interrupt-run-utterance-fence
  - gap-live-voice-interrupt-honest-aftermath
goal_ac: AC-345
---
## Proposal

### 范围

把 GOAL-041 的服务端行为放到真实浏览器里验收，**零云调用**（`DASHSCOPE_API_KEY` 置空，scripted fake 上游 `e2e/voiceRealtimeScriptedUpstream.ts`），音频用实时节拍音源（`src/modules/chat/voice-realtime/audioSource.ts`，`gap-voice-realtime-paced-audio-source` 已落地），执行面用可控时长的假会话。单文件 `e2e/voice-realtime-intent-control.spec.ts`，单次运行须 < 100 s（goal 判据硬闸 120 s）。

### 用例

1. 执行中连说 N 句后说一句修正 ⇒ 屏上逐条可见；bar 深度与 host 真实值一致；下一轮输入含修正且在后。
2. composer 打字与语音交错 ⇒ CLI 收到顺序 = 发生顺序。
3. 模型对同一修正重复中断 ⇒ 只有一次 abort，屏上只有一条停止回执。
4. 故障注入：中断途中上游断连 ⇒ backlog 不丢、退出后转 composer。
5. 故障注入：abort 失败 ⇒ 诚实回执，不显示「已停止」。
6. 故障注入：修正期上游给出畸形函数调用（MALFORMED_FUNCTION_CALL，2026-10-12 真实出现过）⇒ recoverable，不 abort，后续修正仍可投递。
7. 幂等：重放同一 `itemId` 不二次投递。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. scripted 上游补所需构件（重复中断、中途断连、畸形调用）；2. spec 文件；3. 本地单文件运行三次取稳定性读数；4. `npm run lint`。

## AC

- [x] AC1：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-intent-control.spec.ts` 退出 0，7 个用例全绿。
- [x] AC2：连续 3 次单文件运行全绿，记录每次耗时（均 < 100 s）。
- [x] AC3：spec 内断言「零云调用」（拦截到的上游连接只指向本地 scripted 端点）。
- [x] AC4：既有 `e2e/voice-realtime-scripted-scenarios.spec.ts` 退出 0。
- [x] AC5：`npm run lint` 退出 0。

## DoD

三次运行的 Playwright 报告摘要与关键截图路径（`artifacts/`，不入 diff）写入 `## Notes`。

## Touches

- e2e/voice-realtime-intent-control.spec.ts (new)
- e2e/voiceRealtimeScriptedUpstream.ts（新增故障构件）
- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts（仅当共享构件在此）
- playwright.config.ts（选中该 spec 的单文件预算与 debug-agent fixture home）
- src/modules/chat/voice-realtime/audioSource.ts（仅当需暴露测试 seam）
- tasks/gap-live-voice-intent-control-browser-e2e.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale 授权（GOAL-041 / AC-345）。依赖 AC-342、AC-343、AC-344。

### 实现落点

- `e2e/voice-realtime-intent-control.spec.ts`（新，七个用例，共用一台 scripted 上游与一个浏览器）。
- `server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts` 新增 `malformedFunctionCall(name, rawArguments, callId)`：`functionCall` 收 Record 并 `JSON.stringify`，结构上无法产出「非合法 JSON 对象」的 arguments，用例 6 的畸形调用必须有这条构件；沿 `e2e/voiceRealtimeScriptedUpstream.ts` 逐字 re-export（不重定义，AC4 的 registry 钉子仍绿）。
- `playwright.config.ts`：`SPEC_BUDGET_MS` 加 `voice-realtime-intent-control.spec.ts: 240_000`（七个用例共用一台上游，每句投递都付 2.5 s 合流窗，单文件 55 s 上限不够）；`DEBUG_AGENT_SPEC_FILES` 加该文件（读的是真实 resident 会话自己的 CLI 队列，需要 debug-agent fixture home）；`voiceRealtimeSelection` 加该文件（所有话都是模型的 `session_send`/`session_interrupt`，必须拨到 spec 自己的监听口，也才让 AC3 的「升级不带 authorization」有意义）。

### DoD 读数（2026-10-12）

命令 = `QUAY_LIVE_VOICE_SHOT_DIR=<检出外目录> DASHSCOPE_API_KEY= bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-intent-control.spec.ts`（AGENTS.md 规定从会话内跑测试必须套 `with-memory-cap.sh`）。

**读数取在合并 develop 之后**：本分支这次合并进来的 develop 改动落在 voice-realtime 的 ws-proxy（+130）、bridge（+114）、upstream-pool（+18）、`useVoiceRealtimeSession`（+10）与一个新测试文件上，而自证的浏览器读数只在分支上绿过——AC 的自证必须在将要落地的树上重跑，所以下面三次是合并后的连续三次：

| 运行（合并后，连续三次） | Playwright 摘要 | 同一条命令的整体墙钟 |
| --- | --- | --- |
| run4 | `7 passed (1.5m)`，exit 0 | 89 s |
| run5 | `7 passed (1.5m)`，exit 0 | 90 s |
| run6 | `7 passed (1.5m)`，exit 0 | 90 s |

run4 各用例耗时：14.5 / 11.4 / 9.4 / 8.2 / 7.5 / 12.0 / 14.7 s（合计 77.7 s，其余是 fixture 与收尾）。两条读数都在 AC2 的 100 s 之内。合并前也跑过连续三次（`7 passed (1.5m)`，89 / 90 / 90 s），结论一致；两次读数都在证据目录里。合并进来的 hunk 没有一处碰到本 spec 钉住的名字（`queuedDepth` / `cliQueueTerm` / `pendingQueuedInputs` / `sessionInterrupt` / `deliverSessionSend` / `enqueueConfirmed`），这也是两次结论一致的原因。

截图（9 张/次，检出之外，未入 diff）：`/data/home/yale/.cache/voice-intent-control-evidence/run{1..6}/`（run1-3 合并前、run4-6 合并后），关键几张 `intent-control-queued.png`、`intent-control-correction-queued.png`、`intent-control-stopped.png`、`intent-control-refused-correction.png`、`intent-control-draft-rehomed.png`、`intent-control-replay-once.png`；同目录另存每次运行的 `playwright.log`。放检出之外而不放仓库 `artifacts/` 的原因有二：本任务 DoD 要求截图不入 diff，且 worktree 在 fan-in ff 之后会被删，写进 worktree 的路径会变成悬空证据（sibling 语音 spec 的用法也是 `<dir outside the checkout>`）。

其余判据读数（均在合并后的树上重取）：AC4 `e2e/voice-realtime-scripted-scenarios.spec.ts` → `11 passed (1.5m)`，exit 0（整体 90 s）；AC5 `npm run lint` → exit 0；`npm run typecheck`（三段 project）→ exit 0；改动后的窄测 `voice-realtime-scripted-upstream-state.test.ts` 20/20、`voice-realtime-streaming-stages.test.ts` 20/20。日志同存上述证据目录。

### 读数的两处校准（与 Proposal 措辞的偏离，均在 spec 注释内就地写明）

1. **音频载体**：`pacedFileAudioSource` 已落地但**没有浏览器 seam**——只有 `startWithFile` 且需要调用方传 `options.schedule`，唯一的 UI 调用点（`VoiceRealtimeBar.tsx` 的隐藏 file input）不传，原生 file input 也载不了 JS 函数。本任务范围不是新开音频 seam，所以七句「话」都按 sibling spec 的做法，以上游自己的 final transcript 事件驱动（proxy 侧仍是同一个 `utteranceSeq` + 围栏 + 词句投递，读数等价）。文件头已记录该偏离。
2. **bar 深度**：Proposal 用例 1 写「bar 深度与 host 真实值一致」，本环境**结构上读不到那个等式**，故 case 1 改为读「拥有该数的当事方」：`data-queued-depth` = `queuedDepth()` = 代理自己持有的句子 + CLI 队列项，而 CLI 项来自 pull seam `hostQueueReading → providerRuntimeService.pendingQueuedInputs`（`server/index.ts:734` 接线），debug agent 的 host-driver 条目**没有这个动词**，seam 答 `null`，`provider-runtime.service.ts:812` 的文档把「driver without the verb」列为 UNKNOWN（Claude provider 有此动词，debug agent 没有）。所以 e2e 里该属性只反映代理自己的持有量，host 队列数另读一处、只作读数打印，不断言相等。要断言相等就得改 `server/` 的生产模块，超出本任务 Touches。

另有一处环境事实写进了 case 5 的注释与断言：**debug agent 两张登记表会漂移**——driver 的 `turnByAppSession` 不被一次 `busy` 派发清理（`debug-agent.host-driver.ts` 的 `finally` 只在非 busy 时 `endUnattendedTurn`），而那次 push 的 carrier run 在 chat 登记表里已 resolve；于是网关对一条**已经被 driver 压进队列**的命令回 `{queued:false, queuedMessageUuid:null}`，relay 只读「确认」，于是否决停止并给出 `reason:'revision-not-enqueued'`。因此 case 5 断言的是「回执诚实 + 线上/屏上都没有停止 + 拒绝没有从队列里拿走任何东西」，而不是「队列里没有那句修正」——后者在本环境不成立，且错在 debug agent 的替身实现，不在 relay。
