---
id: gap-live-voice-stream-delivery-not-command
title: Live Voice 生产者去模型化 + 语音交付不再画 PendingResidentMessage：settle 边界确定性投递（模型
  response 覆盖则用之、否则 ASR 逐字整 span）、voice 来源打标并从命令渲染剔除、R1 next 契约固化
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

<!-- 人的裁定（已接受，2026-10-17）：live voice 的三条设计前提 -->

人已接受三条前提，本任务把它们落成实现与判据：

1. **R1 投递档位**：live voice 一律用 `HostInputPriority = 'next'`（并入在飞回合、下一个工具边界合流）；idle 投递不写 tier（立即开回合）；绝不 `now`。
2. **R2 发送触发**：生产端在输入"质量足够好（即 realtime 模型 response）/ 按规则不再改变（ASR final commit）"时即发送——投递由确定性 settle 边界触发，不再由模型是否/何时调用 `session_send` 决定；settle 时文本 = 模型 response（若覆盖该 span）否则 ASR final 逐字整 span。
3. **R3 切分不变性**：同样的文本分/不分更细的小节被 Claude Code 收到并处理，行为语义无显著差异——允许粗合并、允许按 settle 边界成条、允许删掉按切分补偿的启发式。

### 现状（逐文件复核，带 file:line）

- R1 已基本满足：`VOICE_BUSY_RELEASE_PRIORITY = 'next'`（`voice-realtime-ws-proxy.service.ts:499`，用在 `:3304` 静窗释放、`:4282` 打断更正）；idle 不写 tier；`now` 无任何 shipped 路径发送（`later` 只是文本忙写的默认 `claude-host-driver.provider.ts:437`）。本任务只需固化并复核，不新写。
- R2 违反：生产端缓冲（`pendingParts`+`coalesceMs=1000`，`ws-proxy:3131-3132` / `server/index.ts:504`）只装模型 `session_send` 的 piece，不装 ASR final；投递触发是模型调 `session_send`（过 `proceedRelay` 闸），模型是"投递裁判"——丢输入 A/B 类（`experiments/livevoice-discussion-transcripts-20261017/DROPPED-INPUT-AUDIT-2026-10-17.md` 的"commit 后无 response""truncated-by-turn 不 re-send"）与重复投递（同句三投）都长在这一层。
- 逐字兜底是 span guard（`voice-realtime-fragment-coverage.ts` 的 `selectUncoveredFragments`，0.5 字对覆盖 / ≥5 字，默认 off `voice-realtime-span-guard.ts:43`）——是"补丁+启发式"，不是核心规则；盲区见审计 D/E 类（短句 <5 字、模型自造无转写依据片段）。
- 表示层违反"语音不是命令"：语音 `session_send` → `buildSessionSend`（`mcp-session-send.ts:520`）→ `control.send`（caller `via:'mcp'`）→ delivery 账本 → 前端 `deliveryRowsFromSnapshot`（`useSessionStore.ts:1116`，"Deduplicated by deliveryId, and by nothing else"）对每条 delivery 画 `PendingResidentMessage`（带 [撤回]，`PendingResidentMessage.tsx:109-118`），于是语音也出现可撤回命令行——正是人指出的"live voice 不应当经过的"。

### 目标（一句话）

ASR final 逐 item 进 per-session 缓冲 → settle 边界关闭 → 质量覆盖（模型 response 覆盖此 span 则用之，否则 ASR 逐字整 span）→ 一条投递（busy 时 `next`）→ watermark 前移（同 span 不二次投递）→ 消费端（resident host）回合/工具边界 drain；UI 只有一张只读卡 + 真实 user 消息，无 PendingResidentMessage、无撤回。

<!-- dedup-ref --> 相关但已落地的任务（机制不同，仅溯源）：`gap-live-voice-span-guard-flag`（span guard 打 flag 默认 off，本任务把它转正并去启发式）、`gap-live-voice-continuous-duplicate-session-send-without-new-audio`（伪调用闸按计数器+字面去重，本任务用 watermark 前移替代同 span 去重）、`gap-ac387-pending-deliveries-from-activity-snapshot`（pending 行从快照派生，本任务给 voice 来源打标并从该派生中剔除）、`gap-claude-resident-busy-send-ui`（PendingResidentMessage 与撤回，文本命令模型保留不动）。

## Plan

1. **阶段 0 —— 回放验证（先测后写）**：用真实 journal 序列回放 `57279cc1`（同句三投）、`764f0c7a`（5 丢 3）、`3d2d3b2c`（span guard 重复）三条，喂进"settle + 整 span 二选一 + watermark"的模拟生产者，断言每次 settle 恰一条投递、无丢段、无重复。
2. **阶段 1 —— 表示层收敛**：给语音投递打 `source: 'voice'`（`ActivityDeliverySource` 现只有 `'user'|'scheduled'|'unattended'|'mcp'`，两侧 `shared/types.ts` 各加一个成员）；落点在 `control.send` 的 caller/input 带 via（`mcp-session-send.ts:564` 现读 `run.source`，queued 时 run 不存在 → 落 `'mcp'`，须改成从 caller 带 voice 标记）；`deliveryRowsFromSnapshot` 对 `source==='voice'` 不画 `PendingResidentMessage`；核对 `applyCommandLifecycle` 不会为语音 `command_lifecycle` 帧再 mint 出行。
3. **阶段 2 —— 生产者去模型化**：producer buffer 改以 ASR final settle 为源（不再是模型 piece）；flush 由 settle 边界触发；质量覆盖 = "模型 response 覆盖 span 则用之，否则逐字"；span guard 转正并删掉 `selectUncoveredFragments` 的 0.5 覆盖 / 5 字下限 / fragment 概念（R3 授权）；去重简化为 watermark 前移（复用 `coveredThroughItemId`/`transcribedSinceWatermark` 机件）；`77b632bf` 的 forced-commit 恢复降级为"质量通道恢复"，不再是投递唯一条路。
4. **阶段 3 —— 契约固化**：R1/R2/R3 写入 SPEC 锚点（对照 `resident-delivery-turn-ledger-SPEC.md` 的既有写法）；`next` 全路径统一并写明"已满足"的复核证据；写明残留边界（`next` 仍受"当前回合无工具边界"约束，`session_interrupt` 仍是"尽快消费"的唯一人工强干预）。

## AC

- [ ] AC1 e2e（faked provider + scripted upstream，真实接线）：新判据 `e2e/live-voice-stream-representation.spec.ts` 退出 0——用 `e2e/voiceRealtimeScriptedUpstream.ts` 的脚本化上游驱动 live voice，落到 `server/modules/debug-agent/` 的 faked 常驻 provider（如需则先改进该 provider 使其能发出并记录 `source:'voice'` 的 delivery）；断言：脚本化"模型从不 response"臂仍产生一条携带 ASR 逐字文本的投递；transcript 里语音投递的 `data-resident-withdraw` 计数为 0、`voice-pending-message`（只读卡）计数为 1；回合结束后真实 user 消息出现且不带撤回按钮。命令逐字含文件路径，不用 glob。
- [ ] AC2 回放（R2 正确性）：`server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` 新增/扩展用例重放 57279cc1 / 764f0c7a / 3d2d3b2c 三条序列，断言每个 settle span 恰好投递一次（无丢段、无重复）；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` 退出 0。未修复树上必红（登记一次红读数）。
- [ ] AC3 表示层单测：`src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx` 新增用例——`source:'voice'` 的 delivery 不画 `PendingResidentMessage`（`data-resident-withdraw` 为 0），`source:'user'`/`'mcp'` 仍画（负控）；`npx vitest run src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx` 退出 0。
- [ ] AC4 来源打标（实际接线）：两侧 `shared/types.ts` 的 `ActivityDeliverySource` 各新增 `'voice'`；语音 `session_send` 路径（经 `buildSessionSend`→`control.send`）给其 delivery 标 `source:'voice'` 而非 `'mcp'`；机械判定：`grep -n "source" server/modules/mcp-gateway/mcp-session-send.ts` 读到 voice 分支标注，且 `grep -n "'voice'" server/shared/types.ts src/shared/types.ts` 各命中新增成员。
- [ ] AC5 R1 档位契约：`grep -n "VOICE_BUSY_RELEASE_PRIORITY" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 读到 `= 'next'`；`grep -rn "priority: 'now'" server/ --include=*.ts` 只命中类型定义/校验函数、无任何 shipped 投递路径发送 `now`；语音 busy 写入（静窗释放与打断更正）都带 `next`、idle 不写 tier。
- [ ] AC6 R2 生产者转正：`voice-realtime-span-guard.ts` 的 `DEFAULT_VOICE_REALTIME_SPAN_GUARD` 翻为 `true`（或 settle 生产者成为无条件默认）；`selectUncoveredFragments` 的 0.5 覆盖阈值 / `MIN_JUDGED_CHARACTERS=5` / fragment 概念从投递路径移除——`grep -rnE "0\.5|MIN_JUDGED_CHARACTERS|selectUncoveredFragments" server/modules/voice-realtime/` 在投递路径读数为 0（或只剩注释）。
- [ ] AC7 契约面：`npm run typecheck`、`npm run lint` 退出 0。
- [ ] AC8 重启后的真实语音页面读数由人 yale 确认：对话区不出现带 [撤回] 的语音命令行、只读卡与底部转写仍显示（待外部）

## DoD

真实落地（不是"测试存在"）：一个真实对象被这套机制操作过——用脚本化上游（本地模拟 realtime endpoint）+ faked 常驻 provider（debug-agent，本地模拟 Claude Code 消费端）在真浏览器 e2e 里跑通"ASR final → settle → 投递 → 无撤回命令行 → 真实消息"整条链路；脚本化"模型从不 response"臂证明丢输入 A/B 类不再发生（逐字兜底），同 span 不重复投递；transcript 里语音投递的 `data-resident-withdraw` 计数为 0、只读卡计数为 1。R1/R2/R3 三条规则写成文档锚点。`npm run typecheck`/`npm run lint` 退出 0。**不重启生产服务**：`:3001` 与 `claudecodeui-server.service` 保持原样，重启与重启后的真实语音复测由人 yale 执行。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-fragment-coverage.ts
- server/modules/voice-realtime/voice-realtime-span-guard.ts
- server/modules/voice-realtime/index.ts
- server/index.ts
- server/modules/mcp-gateway/mcp-session-send.ts
- server/modules/websocket/services/chat-control.service.ts
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/shared/types.ts
- src/shared/types.ts
- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/hooks/useChatRealtimeHandlers.ts
- e2e/live-voice-stream-representation.spec.ts (new)
- e2e/voiceRealtimeScriptedUpstream.ts
- server/modules/debug-agent/debug-agent.provider.ts
- server/modules/debug-agent/debug-agent.scenario.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- server/modules/voice-realtime/tests/voice-realtime-partial-relay-fragments.test.ts
- src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx
- tasks/gap-live-voice-stream-delivery-not-command.md (self)
