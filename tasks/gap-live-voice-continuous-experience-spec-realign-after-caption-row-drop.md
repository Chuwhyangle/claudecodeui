---
id: gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop
title: 连续体验验收 spec 随「移除对话区转写气泡」（2b7dfc17 /
  gap-live-voice-remove-transcript-caption-rows）回归：重锚可见处置断言到新投影（真实行 + 诚实状态行 +
  底部语音框），清掉已删 testid voice-row-heard/voice-row-delivering（只改测试）
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

### 现状（本轮直接复跑实测一次）

`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 在当前 develop（HEAD = `4c03f2e9`，含 `2b7dfc17`）上 **1 failed / 8 did not run / 2 passed，exit 1**（`test.describe.configure({ mode: 'serial' })` 使后 8 条不运行）。首个失败在 `e2e/voice-realtime-continuous-experience.spec.ts:994`：

```
Error: "不对，改成跑 lint" must be on screen: [{"style":"user","testid":null,"text":"seeded turn for continuous experience"},{"style":"unattended","testid":null,"text":"常驻会话里正在跑的一轮（先占住执行面）"},{"style":"user","testid":null,"text":"把 server 的日志贴出来"},{"style":"unattended","testid":null,"text":"常驻会话里正在跑的一轮（先占住执行面）"}]
Expected length: 1   Received length: 0   Received array: []
```

判据的 L1 半边是绿的：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts` → 13 pass / 0 fail / exit 0。红只在 Playwright 半边。

### 成因（读提交与代码，实测 rows）

- 提交 `2b7dfc17`（任务 `gap-live-voice-remove-transcript-caption-rows`，2026-10-13 14:21，人的裁定「不再显示转写气泡」）把对话区里 `heard`/`delivering` 两态的转写行整个删除：`heardUtteranceRows` / `foldCaptionsIntoTranscriptRow` / `dropCaptionsDeliveredAsMessages` 及两个 `data-testid`（`voice-row-heard` / `voice-row-delivering`）一并从 `MessageComponent.tsx` / `placeCaptions.ts` / `types.ts` 移除。当前保留的可见面是：真实 user 消息行（带 `voice-transcript-badge`）、`voice-row-undelivered`（拒收）、`voice-row-unrecognized`、`voice-row-segment-outcome`、`voice-closed-unshown-utterance`，以及底部语音框的转写位 `voice-realtime-caption`。
- 本 spec 仍逐字读取那两个已删 testid（`grep -c 'voice-row-heard\|voice-row-delivering' e2e/voice-realtime-continuous-experience.spec.ts` = **21**），因此：
  - X-1 的 `[U1, U5]` carrier 直断言里 **U5**（`不对，改成跑 lint`，detector 处置 `interrupted`）原本靠一行 `voice-row-heard` 承载 —— 该行已不存在 ⇒ `carries(rows, U5)` 为 0 ⇒ :994 红。（U5 的纠正只走 stop 的 `intent`、从不作为消息投递，见本 spec X-5 自己的注释，所以它不会以真实 user 行出现。）
  - U2 的已知缺陷腿与合并投递腿的多处 `expectKnownDefect` **签名**（要求 `voice-row-delivering` / `voice-row-heard` 邻行）也不再匹配；一旦运行到，会以 `unexpected failure signature` 变红。
  - `:843` 的 fold 观察 filter（`row.testid === 'voice-row-delivering'`）永远读空，fold 判定失真。

### 前一次修复为何未持久

上一轮 `gap-live-voice-continuous-experience-spec-realign-after-watermark`（提交 `a43bc1e9`，已 done）声称 11 passed；但 `git merge-base --is-ancestor 2b7dfc17 a43bc1e9` = **NO** —— 它在**不含** `2b7dfc17` 的基上验证，而 fan-in 的 suite **不含 playwright e2e**，所以合入 develop（把 `2b7dfc17` 带进来）之后本 spec 从未被重跑。于是判据（AC-361 的 Playwright 半边）在合一棵树上是红的。`gap-live-voice-remove-transcript-caption-rows` 的完成记录已把 `e2e/voice-realtime-continuous-experience.spec.ts` 逐字列为「范围外文件（另立 follow-up）」——本条就是那条 follow-up。

### 要做的事（只改测试）

把 spec 重新锚到 `2b7dfc17` 之后的真实投影，保持「每句话语一个可见处置、无静默丢失」的验收不削弱：

1. **可见面重锚**：凡靠 `voice-row-heard` / `voice-row-delivering` 承载的腿，改读产品当前实际画出的面 —— 已投递句读真实 user 行（`voice-transcript-badge` 的 `Heard as: …`）；拒收读 `voice-row-undelivered`；未识别读 `voice-row-unrecognized`；段丢失读 `voice-row-segment-outcome`；对话区确实无行的句（如 `interrupted` 的 U5）读底部语音框转写位（`voice-realtime-caption`）—— 若该面也不承载该处置，则按下面第 2 条记为已知缺陷。
2. **逐条二选一**：成立（新投影仍以某个面承载该保证）⇒ 直接断言，写明 testid/状态；不成立（新投影静默吞掉了该处置）⇒ 以 **expectKnownDefect** 记录，签名包含**当前实际的 rows**（变体部分用 `.*`），断言**原样保留、不删弱**，`fixTask` 指向一个 `task_get` 读出**非 done** 的在飞任务。
3. **fixTask 有效性**：spec 内不得再出现任何 done 任务的 id 作为 `fixTask`；每处 `fixTask` 用 `task_get` 读出为 todo / ready / needs-human。当前 `gap-voice-unforwarded-utterance-visible-disposition` 仍是 `ready`（其实现提交 `4245cfe4` 只在任务分支 `task/gap-voice-unforwarded-utterance-visible-disposition`、**不在** HEAD），是「听了、未转发必须有可见处置」的产品侧在飞所有者，可作为 U2 腿的 `fixTask`。
4. **fold 观察**：`:843` 的 filter 随投影改（例如改读底部语音框是否仍含未落地句）。
5. **边界**：若判定必须改产品代码才能恢复某条 AC-361 保证，**停在 needs-human** 并写明理由，不得顺手改产品。本条的 siblings（`e2e/voice-realtime-double-drop.spec.ts`、`e2e/voice-realtime-scripted-scenarios.spec.ts`，同样是 caption-rows 任务的「范围外」文件）不由本条覆盖 —— 它们不属 AC-361 判据命令的选中范围。

<!-- dedup-ref --> 机制去重：`gap-live-voice-continuous-experience-spec-realign-after-ac355`、`gap-live-voice-continuous-experience-spec-realign-after-watermark`（均 done，均声索 AC-361）是同一机制的前两次发生；本条是「移除对话区转写行」这一**新的**投影变化（`2b7dfc17`）导致的第三次，按「done 的 AC 声明不是重复、而是前次修复未持久的证据」立新任务。`gap-live-voice-remove-transcript-caption-rows`（done）是造成本次投影变化的任务、并已把本文件列为 follow-up。`task-granularity-advice --touches e2e/voice-realtime-continuous-experience.spec.ts` → `peers: []`、`mentions: []`，无同文件在飞实现任务，**separate**。

## Plan

1. 本地复现并取全部 rows 读数（`QUAY_CONTINUOUS_EXPERIENCE_DUMP`），逐帧确认新投影里每个口语 run 的可读面。
2. 按上面第一、二条逐腿重锚 / 记录；把选择依据写进 `## Notes`（逐条给出「直接断言 / 已知缺陷记录」与理由）。
3. 同一种子连续 3 次运行，读数一致。
4. 零外联读数（AC-360 守卫）+ `npx oxlint e2e/voice-realtime-continuous-experience.spec.ts`（`npm run lint` 的 glob 不含 `e2e/`）。

## AC

- [ ] AC1：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 退出 0，11 个用例全部运行（无 did not run、无 skip）。
- [ ] AC2：`grep -c 'voice-row-heard\|voice-row-delivering' e2e/voice-realtime-continuous-experience.spec.ts` 读数为 0（这两个 testid 已从产品删除）。
- [ ] AC3：spec 内每处 `expectKnownDefect` 的 `fixTask` 用 `task_get` 读出为**非 done**（todo / ready / needs-human）；`grep -o "fixTask: '[^']*'" <spec> | sort -u` 的每个 id 都通过该读取，且 spec 内不再出现任何已 done 任务 id 作为 `fixTask`。
- [ ] AC4：「每句话语一个可见处置、无静默丢失」仍被断言：U2（unforwarded）腿、X-2、X-6 各自的保证仍在（直接断言或带**当前实际 rows** 签名的已知缺陷二者之一），并在 `## Notes` 逐条写明选择依据。
- [ ] AC5：`QUAY_CONTINUOUS_EXPERIENCE_DUMP` 三次运行的归一化读数 sha256 逐字相同（同一种子连续 3 次一致）。
- [ ] AC6：零外联（AC-360 守卫读数：loopback 拒绝数 0）；`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` 退出 0。

## DoD

continuous 体验基线 spec 在当前 develop 上恢复全量运行且通过（AC-361 判据的 Playwright 半边 exit 0）；不削弱「每句一个可见处置、无静默丢失」；只改 spec，不改产品代码（若必须改产品才能恢复保证，停在 needs-human）。真实落地不是「测试存在」：spec 读的是产品**当前**画出的面，而非已删的 testid。

## Touches

- e2e/voice-realtime-continuous-experience.spec.ts
- tasks/gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop.md