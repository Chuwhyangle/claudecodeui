---
id: GOAL-045
title: 常驻会话的 Delivery/Turn 语义与执行账本：run 即 turn、delivery 独立成状态、「处理中」单一写者，根除
  Working… 差一格不消失
status: achieved
kind: goal
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC 全文。
activatedAt: 2026-10-16T09:19:39.721Z
statusLog:
  - at: 2026-10-16T09:19:39.721Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-16T17:03:33.053Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
  - at: 2026-10-16T17:24:43.779Z
    from: achieved
    to: active
    actor: yale
    reason: AC-397（生产装配守护）以 active 立案后，本 goal 按自身的关账规则 goalAchievedFromRecords
      已不再成立——该规则要求域内（active|achieved|needs-human）全部 achieved。同时
      checkAchievedFailing 的入域条件是「achieved AC 且其 goal 处于
      active」（goal-driver.js:40035-40037），所以 goal 停在 achieved 时，本 goal 的 21 条 AC
      一条都不在任何复验扫描里。人 yale 裁定退回 active：让 AC-397 被立案，并让全部 21 条 AC
      重新进入复验域。依据：达成后接线检查的变异实验——在临时 worktree 删除 server/index.ts:1063 的
      setTurnOpener 一行后，AC-382 与 AC-384 仍全绿，因为二者在测试里各自调用
      setTurnOpener，没有判据读取或执行真实的 composition root；manager.openTurn 在未装配时静默返回
      null，误删不报错。GOAL-037 是一次同形先例（2026-10-11T00:44:51Z 由 goal-cli 退回
      active，2026-10-11T02:20:17Z 重新 achieved）。
  - at: 2026-10-16T17:54:07.838Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

2026-10-16 会话「LiveWire 第一次测试」（resident，app session fdd3e920-2b90-4af5-abf5-fe69559e1b9d）底部的 Working… 在 turn 早已结束后持续 1h59m，之后新消息结束后再次出现。机制：注册表（每次 send 一个 run）与 claude-host-driver（state.rounds FIFO，每个 result 只 shift 一个 round）两本账靠位置对账；10-13 的合并 turn 修复在其上叠了第二层位置代理 resultsSeenAtStart，而冷启动或空闲时 arm 的 round 因 queuedUuids 为空永远打不上戳，合并扫描被整段跳过，FIFO 从此永久领先一格，最新一条消息的 run 永远 running、turn lease 永不释放。连带后果：陈旧 round 让无人 turn 识别失效，isProcessing 恒真而调度器跳过排队消息，帧写进前一个 run。fake 进程逐帧回放复现，armRound 加三行后读数全部归零（因果对照）。生产 SDK 路径的实测还确认了 CLI 契约：started 先于 init（折叠时发生在回合内）、终态与 RESULT 先后不固定、interrupt 只 cancel 在飞命令。细节见 docs/proposals/resident-delivery-turn-ledger-SPEC.md。

## 范围与非目标

范围按 SPEC 分阶段：S0 三行热修与回归夹具；S1 driver 内按 command_uuid 建账本，取代 rounds FIFO、resultsSeenAtStart 与手工 lease 配平，interrupt 只请求不改账，性质测试与真 CLI 契约哨兵先行；S2 run 即 turn、delivery 状态走 activity 协议快照、退役顶替 run（一个开关整体上线）；S3 session_send 等返回 deliveryId、runId 可空、run_get 双 id、一个 minor 的兼容窗口；S4 前端待发行读快照、活动坞如实、Escape 守卫；S5 对账转强制与日志补全；文档修订。非目标：不改 CLI；不改 later、next、now 三档含义；不改语音中继的投递规则；不引入会话级统一 seq；不在本目标内重启 :3001 或发布，各阶段生效需人工 build 与 restart。

## 退出条件

逐条对应本 GOAL 的 AC，由各 AC 的 criterion 机械判定：1. AC-377 冷队首回归。2. AC-378 账本不变量 I1 到 I6 在种子化随机交错下恒成立。3. AC-379 CLI 契约哨兵（真 claude 加 mock 端点）。4. AC-380 interrupt 无残留。5. AC-381 无人 turn 识别不被陈旧状态遮蔽。6. AC-382 run 即 turn。7. AC-383 delivery 状态通道。8. AC-384 处理中单写者。9. AC-385 send 返回 deliveryId、runId 可空与兼容窗口。10. AC-386 run_get 双 id。11. AC-387 前端待发行读快照。12. AC-388 活动坞如实。13. AC-389 Escape 守卫。14. AC-390 对账与可观测。15. AC-391 文档锚点。激活节奏：AC-377 到 AC-381（S0、S1）随 GOAL 激活，AC-382 到 AC-391 先以 draft 写入，待前一阶段的出口 AC 全部 achieved 后逐批激活（SPEC §0.3、§12）。

## 风险

CLI 契约漂移：设计依赖 SPEC §2 的帧顺序，哨兵是唯一保护，升级 claude 前先跑它。未测形态：now 抢占、进程被杀、cancel_async_message 各时机、权限暂停、compaction，S1 影子期专门盯。旧客户端：PWA 缓存的旧 bundle 在重启后仍会连上，双发窗口要足够长。S2 之后重连时快照与 turn 流的先后须单独设计并测。后一阶段的 AC 提前激活会被 goal-driver 自动立案，而各任务彼此不知先后。各阶段生效都需重启服务，会断开所有会话，由人决定时机。

## 与其他 goal 的关系

GOAL-040（draft）的 AC-298（run_get 参数收敛）与 AC-301（session_send 返回明确状态）同 SPEC §8 重叠，S3 开工前须决定并入或被取代，本目标不改它们。GOAL-041、GOAL-043、GOAL-044（Live Voice）依赖 command_lifecycle 帧与队列行，S2 的双发窗口与 S4 的前端改动须与其串行协调，不改其投递规则。既有已 achieved 的 AC-230、AC-231、AC-235、AC-248、AC-249、AC-250、AC-337 钉着每次 send 一个 run 的语义，S2、S3 须按 SPEC §13 改写，不得悄悄让它们变红。
