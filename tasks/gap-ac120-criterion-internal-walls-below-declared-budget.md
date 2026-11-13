---
id: gap-ac120-criterion-internal-walls-below-declared-budget
title: AC-120 判据内墙 35s/40s 低于其 240s 文件预算且小于自身等待之和：配额 EDQUOT 中断时以 Test timeout
  吞掉四条断言 ⇒ 抬内墙、断言逐字不动（depends_on 在飞配额任务）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac323-e2e-scratch-quota-headroom-and-interrupted-run-reclaim
goal_ac: AC-120
---
## Proposal

<!-- dedup-ref --> **机制去重（本轮实测，2026-11-13，checkout `/data/home/yale/work/claudecodeui`，HEAD `8eb3848e7` = tree `57a75c3199e0a4bd00fcdc9de2eac5c0ebbc3ed9`）**：`grep -l '^goal_ac: *AC-120' tasks/*.md` 命中 4 份，`status` 逐字全为 `done`（`gap-voice-file-upload-input`、`gap-voice-upload-leg-unmeasured-under-shipped-recogniser`、`gap-ac120-upload-input-locator-ambiguous`、`gap-ac120-criterion-run-budget-below-cold-start-wall`），**无** todo/ready/needs-human 的 AC-120 认领者 ⇒ 本条不是重复，是更早修法没兜住的新一格。granularity 仪器：`node /data/home/yale/.claude/plugins/cache/quay/quay/0.31.1/scripts/dist/task-granularity-advice.js --root /data/home/yale/work/claudecodeui --touches e2e/voice-trim.spec.ts --touches tasks/gap-ac120-criterion-internal-walls-below-declared-budget.md --json` ⇒ `peers: []`、`mentions: []`。相关但**不同机制**的在飞任务 `gap-ac323-e2e-scratch-quota-headroom-and-interrupted-run-reclaim`（status `ready`，`goal_ac: AC-323`）拥有宿主 XFS 用户配额耗尽（EDQUOT −122）与 e2e 暂存池/未收尾运行回收机制，Touches 是 `scripts/e2e-data-dir-*.mjs` 与 `playwright.config.ts`；本条 `depends_on` 它、**不复制其修复、不与它争 `playwright.config.ts`**，只修 AC-120 判据自身的内墙。

### 一、本轮直接测量：台账两红是运行中途写盘失败 + 判据自己的 35s 墙，不是四条断言

`.quay/gate-events.jsonl` 中 AC-120 尾部两拍（逐字）：

1. `2026-11-13T03:10:38.646Z`，actor `goal-sweep`，treeSha `57a75c3199e0a4bd00fcdc9de2eac5c0ebbc3ed9`，verdict `fail`：`acceptance failed (exit 1) — … 1 failed e2e/voice-trim.spec.ts:711:3 › the voice path end to end › AC-120 an uploaded audio file travels the same transcription chain`。
2. `2026-11-13T03:11:29.980Z`，actor `goal-cli`，**同一 treeSha**，verdict `fail`，同一行。

两次失败运行自己的工件仍在（`~/.cache/quay-e2e-tmp/quay-e2e-XwMGGP` 与 `quay-e2e-x9s8Bl`；两份 `watchdog-state.json` 均 `fired:false`、`boot completed at 3474/3486ms (config-eval-ms≈251)` ⇒ 不是看门狗、不是冷启动）：

- `quay-e2e-XwMGGP/test-results/voice-trim-the-voice-path--607bd-he-same-transcription-chain/error-context.md` 逐字：`Test timeout of 35000ms exceeded.` / `Error: browserContext._wrapApiCall: Unknown system error -122: Unknown system error -122, write` / `Error: locator.click: Target page, context or browser has been closed`，Call log 停在 `waiting for getByRole('button', { name: /^voice-trim-workspace/ }).first()`。
- `quay-e2e-x9s8Bl/…/error-context.md` 逐字：`Error: browserContext._wrapApiCall: Unknown system error -122: Unknown system error -122, write`；页面快照停在 fleet overview（`Select a project from the sidebar to open a session.`），一个 session 都没打开。

errno −122 是 Linux `EDQUOT`（用户配额耗尽）。同一时刻在飞任务 `gap-ac323-e2e-scratch-quota-headroom-and-interrupted-run-reclaim` 已实测 `xfs_quota -c 'quota -u yale' /data` 的硬限额余量只剩 ≈0.49 GiB，而 e2e 选择器读 statfs 仍报 1739 GiB。⇒ 两红的**根因**是宿主配额，已由那条在飞任务认领；本条不重复。

### 二、本条的独立机制：AC-120 判据自己的墙还停在 60s 闸时代，且小于判据自己的等待之和

`e2e/voice-trim.spec.ts:714` 逐字 `test.setTimeout(35_000);`，其注释逐字写「the goal gate kills the command at 60s」；`:588` 的 `beforeAll` 是 `test.setTimeout(40_000);`。但 AC-120 记录的 `timeoutMs` 已是 `260000`（上一轮 `gap-ac120-criterion-run-budget-below-cold-start-wall` 落地），`playwright.config.ts` 的 `SPEC_BUDGET_MS` 已有 `'voice-trim.spec.ts': 240_000`（`:932`）。内墙与外预算脱节，且内墙小于判据自身的等待之和：

- 单腿内部等待之和已超过 35s：`openComposer` 的 composer `toBeVisible` 15s（:468）+ `uploadFixture` 的入口 `toBeVisible` 10s（:571）+ 上传到达 poll 15s（:576）+ `expectTranscript` 的 `toHaveValue` 10s（:491）= **50s**；
- 于是任何一条腿在负载下变慢，先撞 35s 墙，报 `Test timeout of 35000ms exceeded`，四条断言一条都不表态 —— 03:10 那拍正是这个形状。

这条机制与配额不同：即使配额健康，35s 墙也会在负载下先把量具杀掉；配额修复后它仍会复现。house precedent 是 stabilize（`gap-ac180-enter-criterion-load-flake-stabilize`、`gap-ac142-recording-evidence-load-flake`），不是产品修复。

### 三、立案时的直接复跑（同一棵树，配额已回落后）

`xfs_quota` 现值：blocks `446205652` / soft `471859200` / hard `524288000`（软余量 ≈24.5 GiB）；暂存池 `du -sh ~/.cache/quay-e2e-tmp` = `7.6G`、22 个目录（03:00Z 时是 `82G` / 118 个目录）。`load1 ≈ 14.5`。

`npx playwright test e2e/voice-trim.spec.ts -g "AC-120"` 连跑 2 次：

1. exit 0，`1 passed (18.0s)`，`[voice-upload] file=2.600s uploaded=1.500s bytes=48044`，`[e2e] boot: both webServers answered at 3540ms`；
2. exit 0，`1 passed (15.9s)`，同一 `[voice-upload]` 行，`boot … at 3497ms`。

⇒ 判据的产品保证当前成立（上传体来自 fixture、composer 持有识别器文本、fidelity 打印到达、关闭时入口不存在）；红是量具/宿主，不是产品。

### 四、修法（只动判据内墙）

1. 把 `:714` 的 35s 与 `:588` 的 40s 换成一个具名常量并两处共用（建议 `CRITERION_WALL_MS = 100_000`：hook + case = 200s < 文件预算 240s，且远大于内部等待之和 50s）；注释改成当前事实（文件预算 240s / 闸 260s；健康整轮 16–18s；内墙的用途是让判据自己读完并打印诊断，而不是被外闸或 35s 墙杀掉）。
2. **明确不动**：四条断言、`AC120_*`/`FIXTURE_SEC`/`CAPTURE_TOLERANCE_SEC` 等常量、`uploadFixture`/`openComposer`/`expectTranscript` 的等待值、`criterion:` 命令、`expect:` 全文、`playwright.config.ts`（在飞 AC-323 任务的 Touches）、`scripts/e2e-data-dir-*.mjs`、`goals/AC-120-…md`。
3. 依赖：`depends_on: gap-ac323-e2e-scratch-quota-headroom-and-interrupted-run-reclaim`。配额修复先落地，本条再在健康余量上证明 3 连绿；不复制其 diff。

## AC

- [ ] AC1 判据复绿且稳定（承重）：在依赖任务已 `done` 的树上连续 3 次 `npx playwright test e2e/voice-trim.spec.ts -g "AC-120"` 均 exit 0，每次 `1 passed`，逐次登记 wall、`[e2e] watchdog-armed`/`[e2e] boot` 两行与 `[voice-upload] file=… uploaded=… bytes=…` 行；3 次输出均不含 `[e2e] watchdog:` 越界行、`Test timeout of … exceeded`、`Unknown system error -122`。立案基线（同一 treeSha 两次 fail 的时间戳/原文，与本人两次直跑绿 18.0s/15.9s）逐字保留在完成记录。
- [ ] AC2 内墙与文件预算对齐（承重）：`grep -n 'test.setTimeout(' e2e/voice-trim.spec.ts` 只剩具名常量（不再出现 `35_000` / `40_000` 裸值），且该常量满足 `2 × 值 < 240_000`；`grep -n 'goal gate kills the command at 60s' e2e/voice-trim.spec.ts` 命中 0（陈旧注释已改）；完成记录给出推导：内部等待之和 15+10+15+10 = 50s > 旧 35s，hook+case = 2×值 < 240s 文件预算。
- [ ] AC3 判据语义未弱化（承重）：`git diff <merge-base(HEAD,develop)> -- e2e/voice-trim.spec.ts` 只含 timeout 常量与注释行；以下原行逐字仍在：`expect(upload.subarray(0, 4).toString('ascii')).toBe('RIFF')`、`expect(uploadSec).toBeLessThanOrEqual(FIXTURE_SEC + CAPTURE_TOLERANCE_SEC)`、`await expect.poll(() => fidelityMessages` + `.toBeGreaterThan(fidelityBefore)`、`await expect(uploadEntry()).toHaveCount(0)`、`await expect(uploadInput()).toHaveCount(0)`、`expect(requests.length).toBe(requestsBefore + 1)`；新增行匹配 `retries|repeat-each|test\.skip|test\.only|page\.route\(` 的条数为 0。
- [ ] AC4 内墙承重（诱导对，除变异外完全同构）：(a) 临时把内墙还原为 `35_000` 并在测试体开头注入 `await page.waitForTimeout(45_000)` ⇒ exit 1，输出逐字含 `Test timeout of 35000ms exceeded`；(b) 保留新墙 + 同一注入 ⇒ exit 0；(c) 去掉注入后复绿，`git status --porcelain` 无变异残留。三份原始输出与 wall 入档。
- [ ] AC5 假形态仍红（承重，证明不是把判据放宽换绿）：(a) 临时把上传入口改成旁路（选中文件后直接 `onTranscript('fixed')`、不经上传）⇒ 判据 exit 1，红在识别器请求/上传体断言上（AC-120 的假形态 (1)）；(b) 临时让入口无视开关（`?voiceDebug=off` 也渲染）⇒ exit 1，红在 leg 2 的 `toHaveCount(0)` 上（假形态 (4)）。两个变异各自登记 diff 与失败断言逐字，还原后复绿。
- [ ] AC6 契约面不被改窄：`npm run typecheck` 与 `npm run lint` exit 0；`git diff --name-only $(git merge-base develop HEAD)` 全部落在 `## Touches` 内；依赖任务的 `status` 读回为 `done`。

## DoD

真实落地：依赖的配额任务（e2e 暂存池回收 + 配额余量读数）合入后，本条在健康余量上让 AC-120 判据连续 3 次由**它自己的四条断言**决定为绿；随后 driver 的下一轮 goal gate 重跑 AC-120 时读到新树，`.quay/gate-events.jsonl` 的 AC-120 尾部重新是 `pass`（贴出该 GateEvent 的 `timestamp` / `treeSha` / `verdict` / `reason` 原文，且 `treeSha ==` 落地树 `HEAD^{tree}`）。完成记录须写明：这次修的是判据内墙（35s/40s → 具名常量 100s×2），`criterion:` 命令与 `expect:` 全文逐字未动、四条断言逐字未动；2026-11-13 两红的根因是宿主配额 EDQUOT(−122)（已由 `gap-ac323-e2e-scratch-quota-headroom-and-interrupted-run-reclaim` 认领，本条不复制其 diff），本条只保证配额健康后 35s 内墙不再先于断言把量具杀掉。AC4 的诱导对与 AC5 的两个假形态都要真跑并贴退出码与红态原文；任一读绿须说明是哪一杠杆吸收的，不得静默换过。

⛔ 不得用 `retries`、`repeat-each`、`test.skip`、`test.only`、`page.route(`、改判据命令、改任何 `expect` 或放宽 `AC120_*` 常量换绿；不得改 `playwright.config.ts` 或 `scripts/e2e-data-dir-*.mjs`（在飞 AC-323 任务的 Touches）。若依赖任务落地后判据仍稳定红在产品面上，停手上报置 `needs-human`，不得把量具红写成产品绿。

该轴仍暗,理由:本任务只调整 e2e 判据自身的 duration 墙与注释，未新增或移除模块、依赖或跨层引用，L_D/L_G 无可比读数。

## Touches

- e2e/voice-trim.spec.ts（只改 `beforeAll` 与 AC-120 用例的 `test.setTimeout` 及其注释；断言零改动）
- tasks/gap-ac120-criterion-internal-walls-below-declared-budget.md（自触）