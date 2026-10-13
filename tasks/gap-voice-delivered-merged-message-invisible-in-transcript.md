---
id: gap-voice-delivered-merged-message-invisible-in-transcript
title: 已投递的合并消息在界面上零行：continuous 场景里 Claude 收到的合并投递（U3+U4）没有任何承载行，人看不到自己刚说的话进了会话
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra: {}
depends_on:
  - gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop
---
## Proposal

**现状（读数来自 `e2e/voice-realtime-continuous-experience.spec.ts` 自己的 dump，非推断）**：continuous 体验场景里，`routing.sends` 中 `outcome: 'delivered'` 的**合并投递**（`MERGED_MESSAGE = U3「我想想」+ U4「然后跑一下测试」）在 `transcript.rows` 上**零行**——同一场景里第一条投递（U1）却以真实 user 行出现。于是「Claude 收到了什么」在人这一侧不可见：人说了两句话、模型合并投递给了会话，界面上什么都不显示。

该读数目前由本 spec 的 X-1 合并投递腿以 `expectKnownDefect` 记录，其 `fixTask` 原文指向 `gap-voice-unforwarded-utterance-visible-disposition`。**那个 owner 已 done 且不覆盖本缺陷**：它的修复只在 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 的 `error.code === 'MODEL_TEXT_REPLY'` 分支（约 :3077）发 `heard_not_forwarded`，其自带夹具驱动一次 `response.text.done`；而本场景的合并投递走的是正常投递路径，该分支永不触发（合并树 dump 中 `not forwarded` 命中 0 次）。⇒ 本缺陷当前**无主**。

**机制假设（执行者须复核，不得照抄）**：第一条投递的 `coveredThroughItemId` 把 `item_vad_2`（U3）连同它真正答过的句子一起 claim 了；`2b7dfc17`（`gap-live-voice-remove-transcript-caption-rows`）删掉对话区 caption 行之后，被 claim 的后半句没有任何面可落。客户端 `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts` 的 `claimThrough` 口径与 `sent` 帧的 `coveredThroughItemId` 是这条链的两端。

**做法**：让每条 `outcome: 'delivered'` 的消息在界面上都有一个承载行；投递归属继续按 **delivery 的 item id** 认领（不得退回按文本包含匹配），然后把 spec 的合并投递腿从 `expectKnownDefect` 改为直接断言。产品侧只改归因/投影，不改协议字段。

## Plan

1. 复现并取读数：跑 `e2e/voice-realtime-continuous-experience.spec.ts` 并 dump（`QUAY_CONTINUOUS_EXPERIENCE_DUMP`），确认合并投递在 `routing.sends` 里 `outcome='delivered'`、在 `transcript.rows` 上零行，且第一条投递的 `coveredThroughItemId` 覆盖了 U3 的 item。
2. 定位归因链两端（`voice-realtime-ws-proxy.service.ts` 的 `coveredThroughItemId` 发出点；`useVoiceRealtimeSession.ts` 的 `claimThrough` 消费点），判定「谁把合并投递吸进了前一条」。
3. 改归因使每条 delivered 消息各有一行；补/改夹具（服务端或客户端两侧取其实际所在侧），并保留取假形态：恢复旧归因口径 ⇒ 该行消失、spec 腿必须转红。
4. 把 `e2e/voice-realtime-continuous-experience.spec.ts` 的合并投递腿改为直接断言（`expectKnownDefect` 包装去掉，签名断言改为归因口径断言）。
5. 全量跑该 spec（11 用例）、零外联读数、`npx oxlint` 于改动文件。

## AC

- [ ] AC1 在 develop 树上 `npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 退出 0，11 个用例全部运行（无 did not run、无 skip）。
- [ ] AC2 该 spec 内 `grep -c "expectKnownDefect"` 读数为 **0**（合并投递腿已改为直接断言；与 `gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop` 的收窄裁定合起来，spec 内不再有任何 known-defect 腿）。
- [ ] AC3 归因按 **item id** 而不是文本匹配：`transcript.rows` 里承载合并消息的那一行由 delivery 的 item 认领（给出该行的 `text` + 认领它的 `coveredThroughItemId` / item id 读数，落在 `## Evidence`）。
- [ ] AC4 取假形态：把归因改回旧口径（前一条投递吞掉 U3）⇒ 合并投递行消失、AC2 的断言转红；记录该次运行的失败行原文。
- [ ] AC5 零外联（AC-360 守卫读数：loopback 拒绝数 0）且 `npx oxlint <改动的每个文件>` 退出 0。

## DoD

真实落地 = continuous 场景里「Claude 收到的每条消息在人这一侧都有一行」在 develop 树上被**直接断言**且绿；该断言在删掉产品侧修复时必须转红（AC4 的取假形态读数）。不是「测试文件里多了一条断言」，而是产品当前画出的面上真的多出那一行。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- e2e/voice-realtime-continuous-experience.spec.ts
- tasks/gap-voice-delivered-merged-message-invisible-in-transcript.md

## Notes

**与 `gap-voice-unforwarded-utterance-visible-disposition`（done）的区别**：那条覆盖的是「模型给出文本作答但未被转发」（`MODEL_TEXT_REPLY`）的形态，其处置是底部状态格的一行提示；本条覆盖的是「**投递成功**但对话区没有行」的形态，二者的触发分支与可见面都不同。⛔ 不要复用它的 `heard_not_forwarded` 帧当作本条的修复。

**范围**：本条只处理 `outcome: 'delivered'` 的消息不可见。`policy: 'silent'`（听到但模型什么都没答）那一类**不再要求可见处置**——2026-10-13 人裁定收窄，由 `gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop` 改为直接断言。⛔ 不得把本条扩大成「所有听到的句子都要有行」。


### 2026-10-13 顺序要求（depends_on）

本条与 `gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop` **改同一个文件**（`e2e/voice-realtime-continuous-experience.spec.ts`）⇒ 二者不能并发（`slot-refill` 判 overlapping file-sets）。顺序也不可颠倒：那条任务先把该 spec 重锚到 `2b7dfc17` 之后的投影、清掉 21 处已删 testid 引用（`voice-row-heard` / `voice-row-delivering`）并把 3 条 `policy:silent` 腿转成直接断言，本条才有一条**能跑绿的** spec 可改；在本条里顺手重锚会与它冲突、并让两个任务的产物互相打架。故本条 `depends_on` 那条任务。

⛔ 执行前先读一次：若你所在树上的 spec 仍含 `voice-row-heard` / `voice-row-delivering`（`grep -c` > 0），说明重锚尚未落地 —— 此时**不要自行重锚、不要改 spec**，按未就绪等待下一轮。