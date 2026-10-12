---
id: gap-live-voice-continuous-experience-spec-realign-after-ac355
title: continuous 体验验收 spec 随 AC-355 投影变化回归：翻转已修复的缺陷腿、恢复「实际投递内容可见」断言（只改测试）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-361
---
## Proposal

### 现状（2026-10-13 Opus 常驻会话复核，确定性复现两次）

`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 在当前 develop 上 **1 failed / 8 did not run / 2 passed**（AC-361 落地时为 11 passed）。首个失败（`e2e/voice-realtime-continuous-experience.spec.ts:994`）：

```
Error: the merged message must have one carrier
Expected length: 1   Received length: 0
```

成因（读代码与提交）：
- AC-361 落地时，「我想想」+「然后跑一下测试」合并投递的那条消息，由一行被折叠、标记为 `voice-row-delivering` 的字幕行承载。
- `8a87620b fix(voice-realtime): show a segment as heard or not-recognized, never as delivering`（AC-355，`gap-live-voice-segment-honest-heard-unrecognized-state`）把每段改为单独显示为「已听到」或「未识别」，不再折叠、不再显示「投递中」。因此没有任何一行包含合并后的整句。
- 同一 spec 第 1018–1035 行有一条 `expectKnownDefect(... fixTask: 'gap-live-voice-segment-honest-heard-unrecognized-state')`（「delivered but still shown as delivering」）。该缺陷已被 AC-355 修复，这条腿一旦运行会以 `defect no longer reproduces` 变红。AC-355 的 Touches 只含 segmented 回放 spec，没有翻转这里。
- fan-in 全量 suite 不跑 Playwright，所以回归没有被机械 fan-in 拦下。

### 要做的事（只改测试；若需改产品则停下）

1. 翻转第 1018–1035 行指向 AC-355 的已知缺陷腿，改为直接断言（已投递的消息不再显示为投递中）。
2. 重新确定 X-1 / X-3 对「实际投递内容可见」的期望，**不得削弱**：
   - 若当前产品在观察窗口内以会话自身的用户消息行（或 AC-355 定义的已转发处置）显示了实际投递的合并文本 ⇒ 断言改为读那一行（`testid` 与状态写明）。
   - 若产品在任何地方都**不显示**实际投递的文本（用户看不到 Claude 实际收到了什么）⇒ 这是可追溯性缺陷：用 `expectKnownDefect` 记录，签名包含当前实际的 rows（变化部分用正则），`fixTask` 指向 `gap-live-voice-run-digest-evaluation-signal`，并在 `## Notes` 写明证据；不得删除这条断言。
3. 整个 spec 在 develop 上 11 个用例全部运行并通过（含已知缺陷腿按签名通过），三次运行一致，零外联。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


- ⛔ 只改 `e2e/voice-realtime-continuous-experience.spec.ts`。若判定必须改产品代码才能恢复可见性，停在 needs-human 并写明理由，不得顺手改产品。

<!-- dedup-ref --> 机制去重：本任务与 AC-361 同 goal_ac（AC-361 已 achieved 但其判据当前失败），用于承接该判据的修复，goal-driver 的 achieved-failing 跟进按顶层 goal_ac 去重。

## Plan

1. 本地复现失败并取 rows 读数；2. 翻转 AC-355 腿；3. 按第 2 点二选一处理合并消息的可见性断言；4. 三次运行读数；5. lint。

## AC

- [ ] AC1：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 退出 0，11 个用例全部运行（无 did not run）。
- [ ] AC2：spec 中不再有 `fixTask: 'gap-live-voice-segment-honest-heard-unrecognized-state'`。
- [ ] AC3：「实际投递的合并文本可见」仍被断言：要么直接断言其承载行，要么以带实际 rows 的签名记录为已知缺陷（`fixTask` 为 `gap-live-voice-run-digest-evaluation-signal`），二者之一，并在 `## Notes` 说明选择依据。
- [ ] AC4：三次运行一致；零外联（AC-360 守卫读数）；`npm run lint` 退出 0。

## DoD

continuous 基线验收 spec 在当前 develop 上恢复全量运行且通过，AC-361 判据重新为真；不改产品代码，不削弱「投递内容可见」的验收。

## Touches

- e2e/voice-realtime-continuous-experience.spec.ts
- tasks/gap-live-voice-continuous-experience-spec-realign-after-ac355.md

## Notes

立项：Opus 常驻会话 2026-10-13（GOAL-044 / AC-361 回归）。证据：两次本地运行输出与 error-context（`~/.cache/quay-e2e-tmp/quay-e2e-92ngfV/…`、`quay-e2e-1ldI83/…`）。
