---
id: gap-ac323-live-session-bare-reload-and-loaded-criterion-budget
title: 恢复 AC-323 判据绿：live-session-send 的两处历史 reload 仍是裸
  page.reload（upload-fixture 的 reloadPaneBounded 重放守卫未同步）⇒ reload 后 boot
  请求中断、.chat-messages-pane 30s 不出现（本轮 04:02Z fail 复现：1 failed / 3 did not run）+
  记录 timeoutMs 200000 低于负载下三段实测墙钟
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-323
---
## Proposal

<!-- dedup-ref --> 声明 `goal_ac: AC-323` 的任务全部是 `done`（立案时 `tasks/` 内无 todo/ready/needs-human 认领 AC-323）⇒ 本任务为新案。`task-granularity-advice --touches e2e/voice-realtime-live-session-send.spec.ts --touches e2e/voice-realtime-upload-fixture.spec.ts --touches e2e/support/pane-reload.ts --touches goals/AC-323-…md` 报 `peers: []`、`mentions: []` ⇒ 无合并候选。相关但不同机制：`gap-ac345-omission-fill-race-and-loaded-criterion-budget`（ready，AC-345，改的是另一份 spec 的 `openSession` 有界 reload 与 AC-345 记录预算）；`gap-ac315-reload-window-residual-deterministic-injection`（done，AC-315，2026-10-10 把 `reloadPaneBounded` 落到 `e2e/voice-realtime-upload-fixture.spec.ts`，commit `25e6fb28b`）。

### 现象（2026-10-21 本轮直接重跑判据 + 台账原文，不是转述）

- 本轮逐字跑判据 CMD1：
  `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts`
  ⇒ **exit 1**，`14 passed (4.9m)` / `1 failed` / `3 did not run`，wall **294 s**（主机 load average ≈ 112）。
- 红在 `e2e/voice-realtime-live-session-send.spec.ts:767`：
  ```
  await page.reload();
  await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  Error: expect(locator).toBeVisible() failed
  Locator: locator('.chat-messages-pane')
  Timeout: 30000ms
  Error: element(s) not found
  ```
  该文件 `test.describe.configure({ mode: 'serial' })`（`:484`）⇒ 首红把其余 3 例标成 `did not run`；台账若只读「1 failed」会看不到后面的腿。
- 失败 trace（`test-results/voice-realtime-live-sessio-21270-nd-lands-with-no-draft-step/trace.zip`）读数：reload 的文档与 `/src/main.tsx` 均 200；reload 后约 3 s 起一批 boot 模块请求以 `net::ERR_NETWORK_CHANGED` / `net::ERR_FAILED` 失败（`/src/modules/chat/utils/transcript/streamingMarkdown.ts`、`/src/modules/chat/tools/ToolRenderer.tsx`、`react-syntax-highlighter` 等）；此后页面**不再发出任何请求**（最后一条 `2026-10-21T04:09:41.004Z`），也没有 `/api/projects` ⇒ App 从未挂载 ⇒ `.chat-messages-pane` 永不出现。reload 之前同一测试的 bar/End/geometry 断言全部通过，失败点只在历史 reload 之后。
- 台账（`.quay/gate-events.jsonl`，`item_id=AC-323`，2026-10-21 UTC 全天）：`pass 14` / `fail 14` / `not-evaluated(timeout) 9`。14 条 `fail` 全在 `00:18–01:22Z`（当地 08:18–09:22，早于 `gap-ac323-composer-embedded-disconnect-draft-carry-hides-entry` 于 09:23 落地）；其后 `01:29–03:30Z` 为 pass 与 timeout 交替，**最新一条 `04:02:19Z` 是 fail——与本轮复现的 `:767` 同签名**。
- 判据记录 `goals/AC-323-…md` 当前 `timeoutMs: 200000`；同日 9 次 `not-evaluated(timeout)` 全是被这 200000 ms 杀掉的（最近 `03:43:29Z`），而本轮 CMD1 单条就已 294 s。

### 根因一：同族的有界 reload 守卫只落到 upload-fixture，live-session-send 两处历史 reload 仍是裸 `page.reload()`

- `e2e/voice-realtime-upload-fixture.spec.ts` 已有 `reloadPaneBounded`（`:820` 起的注释逐字写明它替代的正是「裸 `page.reload()` + pane 的 30 s 窗」）：有界 hop（5 s）+ 落地探测（4 s / 3 s）+ 一次 reload 重放，截止 18 s，每次 hop 与重放都署名进日志；它在历史 reload 与 375px reload 两处被调用（`:1277` 一带）。
- `e2e/voice-realtime-live-session-send.spec.ts` 的两处历史 reload 仍是裸的：`:766`（PC 腿「History, not this page's live state」）与 `:821`（375px 腿）。`grep -n 'page.reload'` 现为 `650`（beforeEach 的 project-row 兜底）、`766`、`821`。
- 为什么上一次修复没挺住：AC-323 的历次修复分别落在 composer-embedded（arming / 首帧 / 断线草稿）与 upload-fixture（交付行读数），**没有一次把 upload-fixture 的 reload 重放守卫同步到 live-session-send**。该文件的绿一直是概率性的：`01:29–03:30Z` 的 pass 与 `04:02Z` 的 fail 是同一棵树，只有当 reload 后的 boot 请求批量被中断时才红；单次绿不能证明这条腿。

### 根因二：AC-323 记录的 200000 ms 截止低于负载下的三段串行墙钟

- 本轮 CMD1 = 294 s（含一次 30 s 失败等待与 3 个未跑用例；修复后预计 CMD1 ≈ 290 s），CMD2（vitest）≈ 5–10 s，CMD3（mobile idle）≈ 27–30 s ⇒ 负载下串行 ≈ 325–330 s。
- 200000 ms 是 2026-10-19 按当时 ≈156 s 串行 floor 定的；今天 load average ≈ 112 时 9 次评估全部超时，记录截止必须按负载实测重定，否则判据本身永远读成 `not-evaluated(timeout)`。

### 做法

1. 把 `reloadPaneBounded` 与其常量（`PANE_RELOAD_DEADLINE_MS` / hop / landing 预算）和署名日志从 `e2e/voice-realtime-upload-fixture.spec.ts` 提取到新文件 `e2e/support/pane-reload.ts` 并导出；upload-fixture 改为 import（行为逐字不变），live-session-send 的两处历史 reload（`:766`、`:821`）改调 `reloadPaneBounded(page, '<label>')`。beforeEach 的 project-row 兜底 `page.reload()`（`:650`）保持原样——那时 session 尚未点开，PANE 本来就不应出现。
2. 守卫签名允许把 spec 自己的 `explain(page, what)` 作为参数传入（两份 spec 各已有一份），不要为提取再造第二套页面文本读取；若选择模块内自带报告，必须同样在失败文本里带上 label 与页面文本。
3. 把 `goals/AC-323-…md` 的 `timeoutMs` 从 200000 抬到「本任务三次实测三段串行最大墙钟 M × 1.15」以上，且不低于 420000；建议 480000。记录其余字段逐字节不变。

### 边界 / 不做

- ⛔ 不改 `criterion` / `expect` 一个字；不删任何命令或 e2e 用例；不加 `test.fixme` / `skip` / `retries`；不放大 `waitForPhase` 的 25 s、PANE 的 30 s 或全文件 60 s 超时；不放宽任何实质断言。
- ⛔ 不改产品代码（`src/`、`server/`）；⛔ 不改 `playwright.config.ts` 的 `workers` / 预算来「报出」绿。
- ⛔ 不把 `expect` 第三节的 `voice-realtime-retry` 找回来：`gap-voice-ui-strip-to-caption-and-connection-state` 已删除重连控件，spec 现在断言「a disconnected bar must offer no way back」；判据面是三条命令，不是那段散文。
- 重放守卫不是「重试掩盖红」：它只在 boot 请求被中断一次时换一个新文档（upload-fixture 既有机制的逐字推广），并在截止内失败时按 label 带页面文本报错；假形态要证明这两半都成立。

## AC

- [ ] AC1 守卫共享且不复制：`test -f e2e/support/pane-reload.ts`；`grep -c 'export const reloadPaneBounded' e2e/support/pane-reload.ts` == 1；`grep -c 'const reloadPaneBounded =' e2e/voice-realtime-upload-fixture.spec.ts` == 0；两份 spec 都从支持模块 import（`grep -c "from './support/pane-reload'" e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-live-session-send.spec.ts` 各 == 1）。
- [ ] AC2 两处历史 reload 都走守卫：`grep -n 'await page.reload' e2e/voice-realtime-live-session-send.spec.ts` 只剩 beforeEach 兜底那一行（`:650` 一带）；`grep -c 'reloadPaneBounded(' e2e/voice-realtime-live-session-send.spec.ts` ≥ 2；`npm run typecheck` exit 0。
- [ ] AC3 判据三条命令逐字绿：CMD1 exit 0 且 `18 passed` / `0 failed` / `0 skipped`，CMD2 exit 0（`Test Files` / `Tests` 均无 failed），CMD3 exit 0（`6 passed`）；各贴 list reporter 摘要与 `echo $?`，并记 wall time。
- [ ] AC4 负载稳定性：同一 CMD1 在主机负载与今天同量级（load average ≥ 50）时连跑 ≥3 次全部 exit 0；贴每次 wall time，最大值记为 M。
- [ ] AC5 deadline 与实测匹配：`grep -n '^timeoutMs:' goals/AC-323-*.md` 的值为 N，N ≥ max(420000, 1.15×M)；`git diff -- goals/` 只有 `-timeoutMs: 200000` / `+timeoutMs: N` 两行。
- [ ] AC6 闸自证：在带新 `timeoutMs` 的树上跑 `quay goal gate AC-323 --dry-run`（必要时 `--root <工作树>` 或 store 方言）⇒ `verdict == "pass"`、`cause == null`、读到的 `timeoutMs == N`；贴原始输出。若 `--root` 仍读主检出的旧记录，必须改用能读到工作树记录的方式，不得谎报。
- [ ] AC7 确定性假形态（重放这一半）：临时在历史 reload 前装一个只生效一次的 route，把该次 reload 后的 `/src/main.tsx` 请求 `abort()`（复刻「boot 请求被中断一次」）⇒ 判据仍 exit 0，且日志出现 `reload pane: ... (replay 1)`；记录注入 diff 与逐字日志后还原。
- [ ] AC8 确定性假形态（有界报错这一半）：同一注入改为每次都 `abort()`（或把 `PANE_RELOAD_DEADLINE_MS` 临时降到 500 ms）⇒ 该用例在守卫自己的期限内失败，错误文本是被点名的 label + 页面文本，而不是裸 `locator('.chat-messages-pane')` 的 30 s 超时；记录后还原，`git status --porcelain` 回到注入前。
- [ ] AC9 不回归兄弟腿：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts`（整份 serial）exit 0、`7 passed`；`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` exit 0、`7 passed`。
- [ ] AC10 隔离性：`git diff --stat develop HEAD` 恰好只有 `e2e/support/pane-reload.ts`（新）、`e2e/voice-realtime-live-session-send.spec.ts`、`e2e/voice-realtime-upload-fixture.spec.ts`、`goals/AC-323-…md`（+本任务文件）；全部注入已还原。

## DoD

- 真实落地：修复合入后，`quay goal gate AC-323`（非 dry-run，gate=goal）在带新记录的树上写出 `verdict: "pass"` 的 GateEvent，AC-323 的台账尾随之翻 pass；贴该条原文。
- 三条判据命令各跑一次并贴 exit code + list reporter 摘要；CMD1 必须是 `18 passed`（不是把 in-flight 红藏掉的 `14 passed / 3 did not run`）。
- 两半假形态各自现场红/绿并留原始输出：一次中断 → 重放后绿；持续中断 → 有界命名失败；还原后 `git status --porcelain` 为空。
- 负载余量写清：CMD1 三次 wall time、M、N 及 N/M 的比值；N 取 max(420000, 1.15×M)，且记录 diff 只有那两行。
- 不放水：不删/跳过用例、不加 retries、不放宽等待与断言、不改 `criterion` / `expect`、不改产品代码与 `playwright.config.ts`。
- 证据逐条记明：本轮 `04:02Z` 的 fail 签名与 trace 读数（reload 后 boot 请求中断、无 `/api/projects`、页面静默）、为什么 `01:29–03:30Z` 的 pass 不能证明稳定（概率性）、以及 upload-fixture 的守卫为何没有覆盖到本文件。

## Touches

- e2e/support/pane-reload.ts
- e2e/voice-realtime-live-session-send.spec.ts
- e2e/voice-realtime-upload-fixture.spec.ts
- goals/AC-323-composer-内双语音入口-容器内-live-voice-紧凑栏-波形-时长-字幕-模型-mute-end-桌面与.md
- tasks/gap-ac323-live-session-bare-reload-and-loaded-criterion-budget.md（self）