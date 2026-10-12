---
id: gap-live-voice-pending-utterance-withdraw
title: 语音待投递条目逐条撤回：UI 确定性按钮复用 cancelQueued 链路，只撤单条、不给模型工具、不清空队列（阶段 2，D-11）
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
goal_ac: AC-351
---
## Proposal

### 问题与裁定（SPEC §0.3 D-11，阶段 2）

用户说错一句时，今天只能再说一句修正、靠模型中断来覆盖。已入 CLI 队列但未出队的话语其实可以**单条撤回**（E9、E10/U4 实测 `cancel_async_message` 有效）。打字消息已有这条链路：`src/modules/chat/transcript/PendingResidentMessage.tsx`（待执行行，按 `command_lifecycle` 三态渲染，`queued` 态带撤回按钮）→ `ChatInterface.tsx:999` `handleWithdrawResidentCommand` → 控制服务 `cancelQueued`。

**待核实的第一件事**：语音投递走 MCP `session_send` → 控制服务（不经聊天 websocket 的 send），这些消息今天是否也渲染成 `PendingResidentMessage` 行、是否带得到 `queuedMessageUuid`。本任务第一步先取读数并写进 `## Notes`，再决定是复用该行还是在 Live Voice 行上接同一撤回动作。

### 约束

- 仅 UI 确定性按钮（I-4）；只撤单条；⛔ 不给语音模型撤回/清空工具（C-1、D-2）；⛔ 不做清空队列。
- 撤回不触发 abort；撤回后深度读数（AC-338 的 host 对账）同步减一。
- 与栅栏（`gap-live-voice-interrupt-run-utterance-fence`）一致：被撤回的 `utteranceSeq` 不再计入任何 run 的 `covers`。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 读数：语音投递在聊天 UI 的渲染与 uuid 可得性；2. 接入撤回（复用优先）；3. vitest 判据；4. 若涉及服务端，新测试同步 quay-test-script 钉子；typecheck / lint。

## AC

- [x] AC1（取假形态排最前）：`npx vitest run src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` 退出 0；文件内对「撤回按钮不调 cancelQueued」的假形态断言会红。
- [x] AC2：语音投递且 `queued` 的话语有撤回按钮，`started` 后按钮消失（两条断言）。
- [x] AC3：点撤回 ⇒ `cancelQueued(sessionId, queuedMessageUuid)` 被调用一次；`cancelled` ⇒ 行标记已撤回；`already-started` ⇒ 诚实提示无法撤回；均不调用 abort。
- [x] AC4：语音工具面仍恰为 `session_send`/`session_interrupt`/`session_status`（`voice-realtime-status-tool.test.ts` 绿）。
- [x] AC5：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

在真浏览器（Playwright 或手工截图，零云调用、scripted fake 上游、假 resident 会话）里完成一次「语音 3 句排队 → 撤回中间一句 → 回合边界只送达另两句」，读数（截图路径、CLI 侧收到的文本条数）写入 `## Notes`。

## Touches

- src/modules/chat/voice-realtime/useVoicePendingWithdraw.ts (new)
- src/modules/chat/voice-realtime/VoicePendingUtterance.tsx (new)
- src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx (new)
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts（携带 `queuedMessageUuid`）
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx（撤回入口槽位）
- src/modules/chat/voice-realtime/index.ts（导出 hook 与行）
- src/modules/chat/ChatInterface.tsx（接入撤回、发 `chat.cancel-queued`）
- src/modules/i18n/locales/en/chat.json（撤回行文案）
- src/modules/i18n/locales/de/chat.json（撤回行文案）
- src/modules/i18n/locales/es/chat.json（撤回行文案）
- src/modules/i18n/locales/fr/chat.json（撤回行文案）
- src/modules/i18n/locales/id/chat.json（撤回行文案）
- src/modules/i18n/locales/it/chat.json（撤回行文案）
- src/modules/i18n/locales/ja/chat.json（撤回行文案）
- src/modules/i18n/locales/ko/chat.json（撤回行文案）
- src/modules/i18n/locales/ru/chat.json（撤回行文案）
- src/modules/i18n/locales/tr/chat.json（撤回行文案）
- src/modules/i18n/locales/zh-CN/chat.json（撤回行文案）
- src/modules/i18n/locales/zh-TW/chat.json（撤回行文案）
- e2e/voice-pending-utterance-withdraw.spec.ts (new)
- playwright.config.ts（SPEC_BUDGET_MS 与 debug-agent / voice 选择位）
- src/modules/chat/transcript/PendingResidentMessage.tsx（未触发：见 `## Notes` 第一步读数）
- src/modules/chat/transcript/ChatMessagesPane.tsx（未触发：见 `## Notes` 第一步读数）
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts（未触发：`queuedMessageUuid` 已在 `sent` 帧内）
- server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts（顺带修复：并行 `__criterion-falsify-*` 瞬时副本导致的 ENOENT 套件红，见 `## Notes`）
- tasks/gap-live-voice-pending-utterance-withdraw.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale「按建议推进」（GOAL-041 / AC-351，SPEC D-11 阶段 2）。依赖先入队后中断（1a）与栅栏（1b）。

### 第一步读数（动手前取，决定复用还是另接）

语音投递**不走**会话存储的行渲染路径：它经 MCP `session_send` → 控制服务入队，宿主只把一条投递已落地的读数交给页面，而命令自己的队列 id（`queuedMessageUuid`）此前被页面丢弃。因此语音话语今天**没有** `PendingResidentMessage` 行可供挂撤回按钮 —— "复用该行" 这一支在本仓库不成立，`PendingResidentMessage.tsx` 与 `ChatMessagesPane.tsx` **未改动**（Touches 里那两条按此标为未触发）。采取的支路：把 `queuedMessageUuid` 从语音 socket 的 `sent` 帧带进 delivery（`useVoiceRealtimeSession.ts`），在 **Live Voice 条**上立撤回入口（`useVoicePendingWithdraw.ts` + `VoicePendingUtterance.tsx`），复用同一条 `cancelQueued` 控制链路（浏览器 `chat.cancel-queued` 帧 → 控制服务 `cancelQueued`）。⛔ 未给模型任何工具、未改能力位、无清空队列；撤回路径唯一的外发就是一条按 id 的 `cancelQueued`，**不可能** abort。

已知边界：该入口只在 `composerMode === 'voice'`（Live Voice 条挂着）时存在；打字模式仍走 `PendingResidentMessage` 原路。

### DoD 读数（2026-10-12，worktree `…-pending-utterance-withdraw`）

命令：`QUAY_LIVE_VOICE_SHOT_DIR=/data/home/yale/work/claudecodeui-worktrees/.shots/gap-live-voice-pending-utterance-withdraw bash scripts/with-memory-cap.sh npx playwright test e2e/voice-pending-utterance-withdraw.spec.ts`（1 worker）。结果 `1 passed (1.5m)`（用例本身 1.4 min）；零云调用：`cloud.strayHosts=[] cloud.webSockets=[]`。

**合并 develop 后的树上复跑**（合并提交 `349f09bd`，即本分支将 ff 到 develop 的那棵树）：同样 `1 passed (1.5m)`、同样 `selfcheck.rowsDelta=6`、`selfcheck.failures=[]`、`cloud.strayHosts=[]`、`summary.queued=3 summary.delivered=2 summary.withdrawn=1`。下面引的是这次复跑的读数（uuid 每次重铸，形状逐项相同）。

场景：真浏览器 + 假 resident 会话（debug-agent 脚本钟）+ scripted fake DashScope 上游。语音 3 句全部 `queued=true` 入队：

- `first — keep this sentence and run it` → `7eaf8694-7888-46e6-9226-36895bf21951`
- `second — take this one back` → `c026c184-0e72-4f88-b407-e5627b2846a8`
- `third — keep this sentence too` → `b3736672-6689-4bd6-b632-67e21fc7c46e`

**CLI 侧收到的文本条数**：`cli.received.count=3`（三句各一条 `session_send`），`cli.queue.held` 恰为这三个 uuid。

UI：`ui.withdrawable.uuids` 与宿主铸造的三个 uuid 逐字相同（行按 id 寻址，行文即该句原文）。点中间一行的撤回按钮：线上 `wire.cancelFrames=1 wire.abortFrames=0`，`wire.cancel.uuid=c026c184-…` —— 一次点击就是一条撤回、且**从不 abort**。

回合边界（CLI 侧账目 `transcript.lifecycle`）：`cancelled` = 恰 `c026c184-…`；`started` = `[7eaf8694-…, b3736672-…]`（另两句，按序）。`queue.queued=[]`、`queue.withdrawn=["c026c184-…"]`、`queue.controlResponses=0`；`selfcheck.failures=[]`、`selfcheck.rowsDelta=6`。

汇总：`summary.queued=3 summary.delivered=2 summary.withdrawn=1`。

截图（每次运行覆盖同名文件，路径固定）：

- `…/.shots/gap-live-voice-pending-utterance-withdraw/voice-pending-withdraw-queued.png`（三行齐、都可撤回）
- `…/.shots/gap-live-voice-pending-utterance-withdraw/voice-pending-withdraw-clicked.png`（点撤回之后、宿主尚未落账：没有行自称已撤回）
- `…/.shots/gap-live-voice-pending-utterance-withdraw/voice-pending-withdraw-after-boundary.png`（回合边界之后页面的自身视图）

### 浏览器可观测边界（为何「行标记」的断言落在单元判据里）

被撤回那一行的**标记**不在浏览器 e2e 里读，也读不到：语音投递经 `session_send`，该控制调用**不带 connection**（`mcp-session-send.ts`），它开的 run 不属于任何 socket；宿主把一次 walk 的帧从**最后一条 dispatch 的 writer** 转发（`debug-agent.host-driver.ts` 只有一个 `lastWriter`，每次 dispatch 都写它，包括 busy send 的 carrier），而那正是那条无连接 carrier 的 writer；页面只在「订阅时该 run 恰是会话当前、running 的 run」时才 `attachConnection`（`chat-websocket.service.ts`），而客户端只在会话打开与 socket 重连时订阅。持有投递的页面按构造是**发送之前**打开的页面，所以没有任何页面能既持有投递、又挂在边界帧所乘的 writer 上。故：标记在单元判据里用直接交给 hook 的帧断言；边界在 CLI 侧读；页面在边界后的自身视图被截图并按「仍是三行、零标记」钉住 —— 哪天真能听见这个 run，这条钉子就是先红的那一行。此结论写在 `e2e/voice-pending-utterance-withdraw.spec.ts` 文件头的 "WHERE THE BROWSER HALF ENDS, AND WHY" 段，与断言同处一份文件。

### AC 证据

- AC1：`npx vitest run src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` → `Test Files 1 passed (1) / Tests 9 passed (9)`，退出 0；文件按假形态（无 uuid 的投递、已 `started` 的话语）排在最前。
- AC2/AC3：同上文件内的对应断言（按钮随 `queued` 出现、`started` 消失；点击一次 `cancelQueued(sessionId, uuid)`；`cancelled` 标记；`already-started` 诚实提示；`onAbort` 全程未调用）。
- AC4：`bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-status-tool.test.ts` → `pass 6 / fail 0`，退出 0；其内 AC1 明言工具面恰为 `session_send`/`session_interrupt`/`session_status`。
- AC5：`npm run typecheck` 退出 0；`npm run lint` 退出 0（仅既有 warning，无一涉及本任务改动文件）。

### 备注

- 语音 socket 不承载队列 / lifecycle 帧，`sent` 帧的 `result` 里才有 `queuedMessageUuid`；`queued_input_cancel_result` 被判据读取（聊天处理器有意丢弃它）。
- 深/浅读数一致：撤回不产生控制响应（`queue.controlResponses=0`），也不触发 abort（`wire.abortFrames=0`）。

### 上一轮套件红的真因与修复（2026-10-12 本轮，`server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts`）

上一轮 exited-not-landed 的红是 `oauth-metadata-mount.test.ts` 的 `Error: ENOENT … server/modules/voice/__criterion-falsify-env-only-configured-…-<pid>.ts`。**真因不在本任务 delta**（本任务对 `server/` 零改动，该文件与 develop 逐字节相同），而是一条**已知通道在另一个消费者上的未修实例**：`voice-*.false-forms.test.ts` 把 `__criterion-falsify-*` 瞬时副本写进 `server/modules/voice/`（相对导入要求副本必须在模块同目录）再在用例收尾删除；而 `oauth-metadata-mount.test.ts` 的 `(f)` 判据 `walkTsFiles(SERVER_DIR)` 先 `readdirSync` 整树、再逐个 `readFileSync`——套件并发下副本在"遍历"与"读取"两步之间消失，未捕获的 ENOENT 让整个文件红。`gap-voice-false-forms-siblings-pid-attribution`（已 done）修的是同一通道在 `voice-dashscope-settings.test.ts` 的 `collectSourceFiles` 上的实例（按名前缀排除），本文件是它的同形未修兄弟（该任务正文只点了 dashscope 那一半）。

**复现**（本仓 worktree，`with-memory-cap.sh` 下）：裸两文件并发（本文件 + `voice-dashscope-settings.false-forms.test.ts`）8 轮 **2 轮红**，形态与 fan-in 日志逐字相同（`-base-` 与 `-mut-` 两种后缀都观测到）；fan-in 并发 16 下窗口更宽。附带查证：`agent-retirement.test.ts` 同样整树扫 `SERVER_DIR`，但 16 轮（含三写者并发）0 次命中，未改动。

**修法**（沿用 dashscope 已确立的约定，最小且行为保持）：`walkTsFiles` 按名跳过 `__criterion-falsify-` 前缀（套件自己的产物，非产品源码；该前缀已进 `.oxlintrc.json` 的 ignore，且 `git ls-files` 无任何带此前缀的受跟踪文件）；`countLiteral` 对"遍历时在、读取时已不在"的文件跳过而非抛出（**其余错误照抛**，ENOENT 之外不吞）。

**修复后读数**（合并 develop `39d481e7` 后、修复提交 `3d63fa2c`）：本文件单跑 `pass 6 / fail 0`；判据读数逐字不变——`[production] count=1 files=["server/modules/mcp-gateway/mcp-gateway.loopback.ts:1"]`、`[with tests] count=49`；同复现循环 10 轮 **0 红**；`npm run typecheck` 退出 0、`npm run lint` 退出 0。

## Blocker

**2026-10-12T12:12:47.237Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=2039 server/modules/mcp-gateway/tests/oauth-metadata-mount.test.ts passed=false end_ms=1791807097799
- run_id：wk-prod-anchor
- session_id：896a5e40-4a61-4d73-b122-ee3b24281d94
