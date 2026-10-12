---
id: gap-live-voice-continuous-experience-spec-realign-after-ac355
title: continuous 体验验收 spec 随 AC-355 投影变化回归：翻转已修复的缺陷腿、恢复「实际投递内容可见」断言（只改测试）
status: done
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

- [x] AC1：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 退出 0，11 个用例全部运行（无 did not run）。
- [x] AC2：spec 中不再有 `fixTask: 'gap-live-voice-segment-honest-heard-unrecognized-state'`。
- [x] AC3：「实际投递的合并文本可见」仍被断言：要么直接断言其承载行，要么以带实际 rows 的签名记录为已知缺陷（`fixTask` 为 `gap-live-voice-run-digest-evaluation-signal`），二者之一，并在 `## Notes` 说明选择依据。
- [x] AC4：三次运行一致；零外联（AC-360 守卫读数）；`npm run lint` 退出 0。

## DoD

continuous 基线验收 spec 在当前 develop 上恢复全量运行且通过，AC-361 判据重新为真；不改产品代码，不削弱「投递内容可见」的验收。

## Touches

- e2e/voice-realtime-continuous-experience.spec.ts
- tasks/gap-live-voice-continuous-experience-spec-realign-after-ac355.md

## Notes

立项：Opus 常驻会话 2026-10-13（GOAL-044 / AC-361 回归）。证据：两次本地运行输出与 error-context（`~/.cache/quay-e2e-tmp/quay-e2e-92ngfV/…`、`quay-e2e-1ldI83/…`）。

### 实施读数（2026-10-13，工作树 `…-wt/gap-live-voice-continuous-experience-spec-realign-after-ac355`，分支 `task/gap-live-voice-continuous-experience-spec-realign-after-ac355`，实现提交 `e2be1843`）

- 复现（改前）：`1 failed / 8 did not run / 2 passed`，失败在 `:994`（`the merged message must have one carrier`，Expected length 1 / Received length 0 / Received array `[]`）。`test.describe.configure({ mode: 'serial' })` 使后续 8 条不运行——所以这个回归不只是「一条腿红」，而是整套基线读数停摆。
- 改后三次运行（`bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-continuous-experience.spec.ts`）：`11 passed`（32.2s / 32.6s / 32.5s），退出码 0，无 did not run，无 skip；三次 rows 载荷逐字节相同，已知缺陷腿各命中签名一次。
- **合并 develop 后在合并树上复跑一次**（merge 提交 `03158003`，只带进 goal/task 文档与 `server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts`，无 `src/`、无 `e2e/` 改动）：`11 passed`（31.6s），退出码 0，11 条全跑 0 skip，rows 载荷与前三次逐字节相同，外联读数相同，已知缺陷腿同样命中签名。自证的 Playwright 判据因此在**合并后的树**上复核过。
- 零外联（AC-360 守卫读数，四次一致）：守卫日志存在（preload 跑过）、无非回环拨号被拒（`blocked=false`）、`dials=1` 且就是本次自己的服务、`authorizationSeen=false`、被本 spec 自己的 route 拒掉的 URL 里没有一个回环地址、`pageErrors=[]`。
- `npm run lint` 退出 0。注：`lint` 脚本是 `oxlint src/ server/ scripts/ shared/`，**不含 `e2e/`**，所以另行 `npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` 退出 0 一并记录（该文件无诊断）。`tsconfig.json` 的 `include` 只有 `src, shared, vite.config.js`，e2e 不在 `npm run typecheck` 覆盖面内。

### AC3 的选择依据：走 (b)——记录为可追溯性缺陷，保留且不削弱断言

读数（四次一致，dump `/tmp/ec355/run{3,4,5}.json` 与 `run6-postmerge.json`）：

```
rows  5 {"style":"user","testid":"voice-row-delivering","text":"我想想"}
rows  6 {"style":"user","testid":"voice-row-delivering","text":"然后跑一下测试"}
carriers("我想想然后跑一下测试") = 0
sends  [{"msg":"把 server 的日志贴出来","outcome":"delivered"},
        {"msg":"我想想然后跑一下测试","outcome":"delivered"}]
```

即 journal 说合并消息 **delivered**，而界面上**没有任何一行**承载它，两个半句各自停在被标记 `voice-row-delivering` 的行上：用户看不到 Claude 实际收到了什么；对一条会话已经拿到的消息，界面给出的处置是「投递中」而非 已转发 / 未转发 / 未识别。所以 (a)「产品在会话自身的用户消息行上显示了实际投递的合并文本」**不成立**。旁证：本次运行的会话 transcript（`transcript.jsonl`）里也没有为这条合并投递新增任何行——它只写到 `sends` 为止，没有落到会话自己的一行上。

因此按 (b) 处理，且断言未被削弱：仍在要求「承载合并文本的行恰好一行」（`toHaveLength(1)`），只是以 `expectKnownDefect` 记录，签名包含当前实际的 rows（两个半句所在的两条 delivering 行，其间与两侧用 `.*`），`fixTask: 'gap-live-voice-run-digest-evaluation-signal'`。已知缺陷腿按签名通过，签名之外的失败会以 `unexpected failure signature` 变红，缺陷一旦不再复现会以 `defect no longer reproduces` 变红。

选这个 `fixTask` 的理由：它正是「持续评估信号 / 处置词汇」那条任务（RunDigest 进状态行与 `session_status`、无需动作不报错、空条目不投递），其 Plan/item 5 本身就是「翻转 `fixTask` 指向本任务的已知缺陷腿」，与「已投递的消息必须如实可见」属于同一处置族。

⚠️ 给下游的提醒：该任务的 Touches **不含**本 spec（与本任务的立项同因——AC-355 修了缺陷却没有翻转这里指向它的腿）。它落地时必须一并翻转本腿，否则同一类 stale 腿会再次出现。

### 与 X-1 那条腿的关系（避免把绿读过头）

被翻转的 `delivered but still shown as delivering` 腿现在直接通过，但**通过的原因不是「投递可见性恢复了」**：它的过滤器要求一行同时满足「标记 delivering」且「承载整句」，而合并文本根本不在任何行上，所以它找不到东西。这一点已写进该腿的注释，并指向上面那条已知缺陷腿。也就是说：AC-355 修掉的是「投递中的折叠行」，没有修掉「实际投递内容不可见」。

### 未改产品

只改 `e2e/voice-realtime-continuous-experience.spec.ts`（`git diff --stat` 仅此一文件，48 insertions / 19 deletions）；没有任何产品文件被触碰，因此不涉及 needs-human。
