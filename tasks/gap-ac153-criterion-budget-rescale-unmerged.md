---
id: gap-ac153-criterion-budget-rescale-unmerged
title: AC-153 判据间歇红在任务自加的 45000ms 整轮守则（末次 red artifact `quay-e2e-7fOwtJ`：`the
  criterion exceeded its 45000ms budget` / Received 52585 / watchdog
  `fired:false`，四条腿全绿）——获人工裁定的重标 `7d38f8e9`（45s→50s）从未成为 HEAD 祖先（`git merge-base
  --is-ancestor 7d38f8e9 HEAD` = 1），HEAD 仍是 `45_000`，且 52585 已越过该
  50000：把重标落到出货线，并按实测被报告 crossing 峰值定值（仍 < SINGLE_SPEC_CEILING_MS）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-153
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是复述台账尾巴）。AC-153 记录 `status: achieved`，其 GOAL-011 已 `achieved`、不再活，且未声明 `long-term: true`，故台账 `gate=goal` 尾部按 CURRENTLY FALSE 交办。判据物（逐字取自 `goals/AC-153-真实浏览器里各类失败显示各自的文案-提示持续显示到关闭-草稿保留-技术详情折叠.md` 的 `criterion:`）：`npx playwright test e2e/voice-error-messages.spec.ts`。

### 一、本轮直接现测：产品面为真，红是任务自加的整轮墙钟守则

本轮在 `HEAD=38287c49`（tree `68a001b2474c350d984f0770e99fa77d3d11620b`，branch `author`）逐字直跑出货命令一次：`exit 0`，self-print `legs=4 passed=4 criterion-wall-ms=41312 watchdog-line=false`（`1 passed (41.4s)`）——四条腿文案、4 秒后仍可见、草稿逐字保留、折叠技术详情、无拼接句全部通过。**产品面读数为真。**

台账最近读数是**交替**的：`.quay/goal-round.jsonl` round 2054（`2026-10-08T22:53:31.680Z`，`load1=83.08`）的 `frozenRecheck` 对 AC-153 = `verdict: pass`（`durationMs 40751`，`outcome: cleared`）；`.quay/gate-events.jsonl` 末次 goal-cli（`2026-10-08T22:56:10.363Z`）= `fail`。⇒ **判据是间歇性红（同一 tree `68a001b2474c` 上 pass/fail 交替），不是稳定为假**；红落在任务自加的守则上，四条腿无红。

### 二、末次红的真读数：整轮 45000ms 守则，四条腿全绿

red artifact 逐字（`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-7fOwtJ/test-results/voice-error-messages-AC-15-542d2-ence-and-the-notice-behaves/error-context.md`）：

```
# Error details
Error: the criterion exceeded its 45000ms budget
expect(received).toBeLessThan(expected)
Expected: < 45000
Received:   52585
# Test info
- Location: e2e/voice-error-messages.spec.ts:699:1
```

`…/quay-e2e-7fOwtJ/watchdog-state.json` 逐字：`{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}` —— **看门狗未触发**（该跑没被 55s 上限 SIGKILL），是走完用例体后撞上 spec 自加的 45000 断言。该 error-context 内**只有这一条**错误 ⇒ 四条腿读了正确的值。

断言落点在 `e2e/voice-error-messages.spec.ts:699`（基线 HEAD）：

```
expect(criterionWallMs, 'the criterion exceeded its 45000ms budget').toBeLessThan(45_000);
```

`criterionWallMs = Date.now() - Number(process.env.QUAY_E2E_RUN_STARTED_AT)`，从整轮 `npx playwright test` 起算（含 config 求值、seeding、两个 webServer 引导、浏览器启动与用例体）。AC-153 的 `expect:` 通篇不点任何墙钟 ⇒ 这个 45000 是交付任务 `gap-voice-error-notice-browser-e2e` 的 AC1 **任务自加守则**，不是 AC 的保证。

### 三、为什么上一条修复没守住：它从未合入

上一条 `gap-ac153-criterion-wallclock-load-headroom`（status `done`，含人工 2026-10-09 裁定「accept rescale + honest registration」）的重标提交是 `7d38f8e9 e2e(ac153): rescale the criterion's own whole-run budget to 50s`，但本轮实测：

```
$ git merge-base --is-ancestor 7d38f8e9 HEAD ; echo $?
1                                                       # 不是 HEAD 的祖先
$ git branch --contains 7d38f8e9
+ task/gap-ac153-criterion-wallclock-load-headroom      # 只在它自己的 worktree 分支上
$ grep -n '45_000' e2e/voice-error-messages.spec.ts
594:  test.setTimeout(45_000);
699:  expect(criterionWallMs, 'the criterion exceeded its 45000ms budget').toBeLessThan(45_000);
720:  test.setTimeout(45_000);
$ grep -n '45s criterion budget' src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx
455:      + '55s watchdog and its 45s criterion budget, and a baseline plus three mutants do not fit in it. The '
```

⇒ **被裁定的重标留在已关闭任务的分支上，出货线 HEAD 仍是 `45_000`**（spec 三处 + 组件登记串一处）。且该被裁定的值（`50000`）也**不足以清掉本次实测的红**：`Received 52585 > 50000`。两条合起来就是「更早的修复没守住」的机制 ⇒ 本条不是重做上一条的决策，而是**把它的交付真正落到出货线，并按实测被报告 crossing 峰值重新定值**。

<!-- dedup-ref --> 机制去重读数（本轮实测）：`for f in tasks/*.md` 扫 `^goal_ac: *AC-153` 命中四条，`status` 全为 `done`（`gap-voice-error-notice-browser-e2e`、`gap-ac153-ledger-red-is-host-quota`、`gap-e2e-data-dir-has-no-reclaimer`、`gap-ac153-criterion-wallclock-load-headroom`）；**in-flight（todo/ready/needs-human）的 `goal_ac: AC-153` 认领者 = 0**，故本条不是重复。相邻但机制不同、且不在飞阻挡的同族：`gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence`（`ready`）治冷路径首载（Vite 优化器静默），它也在 `e2e/voice-error-messages.spec.ts` 上有 Touches；两者机制不同（**守则定值** vs **真削减整轮时间**），**kept separate**。`task-granularity-advice.js` 对本条 Touches 报告 `peers: []`（纯测试文件被该工具排除在重叠测试外），故本条按机制判为 separate。

### 四、要交付的事

1. **把已获人工裁定的重标落到出货线**：在 `e2e/voice-error-messages.spec.ts` 引入具名常量 `CRITERION_BUDGET_MS`（**沿用该名**——兄弟任务 `gap-warmclientstartup-…` 的 AC6 引用它），替换 `:594` / `:699` / `:720` 三处 `45_000`，并同步 `src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx:455` 的登记串（`its 45s criterion budget`）。
2. **按实测整轮包络定值**：新值必须**严格大于**台账/artifact 里能逐字指认的最大**被报告**整轮读数（本轮样本 `52585`），且**严格小于** `SINGLE_SPEC_CEILING_MS`（`playwright.config.ts:320` = `55000`）并留 **≥1000ms 报告头部**（保证 crossing 被**报告**而不是被 55s 看门狗 SIGKILL），同时 < 60 秒判据门。打印新值、实测包络、两侧余量。
3. **保留两条看门狗读数**：`:700` `expect(watchdogLine, …).toBe(false)` 与 `:701` `expect(watchdog.armed, …).toBe(true)` 逐字保留。
4. **安静臂 + 适中负载臂实测**，🚫 不得把安静通过写成「已修」；若在可复现的负载下**低于看门狗**仍越过新守则，停手置 `needs-human`，附逐字读数与已排除项。

**非目标**：不改 AC-153 的产品面（四条腿文案、持续显示、草稿保留、折叠技术详情、无拼接句）；不改 `goals/AC-153-…md` 的 `criterion:` / `expect:`；不碰 AC-149/150/151/152 的交付面；不改 `src/**` 的语音实现；不动 `SINGLE_SPEC_CEILING_MS` / 60 秒门；**不删**该守则断言与任何读数；不重复 `gap-warmclientstartup-…` 的优化器静默杠杆。

## Plan

1. 建隔离 worktree（起点 = 开工时 `develop`），打印路径、`git rev-parse HEAD`、`git rev-parse HEAD^{tree}`，确认 `git status --porcelain` 空。
2. 机械复录红态：cat `…/quay-e2e-7fOwtJ/test-results/voice-error-messages-AC-15-542d2-ence-and-the-notice-behaves/error-context.md` 的 `# Error details` 段与 `…/quay-e2e-7fOwtJ/watchdog-state.json`，逐字入档；写明断言落点 `e2e/voice-error-messages.spec.ts:699`，并写明 AC-153 的 `expect:` 未点任何墙钟。
3. 复录「未合入」：`git merge-base --is-ancestor 7d38f8e9 HEAD; echo $?`、`git branch --contains 7d38f8e9`、`grep -n '45_000' e2e/voice-error-messages.spec.ts`、`grep -n '45s criterion budget' src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` 四条读数逐字入档。
4. 实施：引入 `CRITERION_BUDGET_MS` 并替换三处 `45_000` 与组件登记串；定值按 Proposal 第 2 条（被报告 crossing 峰值之上、`SINGLE_SPEC_CEILING_MS` 之下留 ≥1s）。一处一次、锚定编辑；⛔ 四条腿读数与三条取假形态不动。
5. 安静臂：出货命令逐字跑 ≥3 次，全部 exit 0 且自印 `legs=4 passed=4 watchdog-line=false`，逐次入档 `criterion-wall-ms` 与分段 stage 时间戳。
6. 负载臂：≥20 路兄弟 `npx playwright test` 并发下重跑出货命令 ≥2 次，入档 `load1` / `criterion-wall-ms` / `watchdog-line`；负载臂与安静臂要有可见差距。若仍越新守则且低于看门狗：置 `needs-human`，附逐字读数与已排除项。
7. 未弱化与类型：`git diff $(git merge-base HEAD develop)..HEAD -- goals/ | wc -c` = `0`；`npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` exit 0（三条取假形态仍各自红）；`npx tsc --noEmit -p tsconfig.json` exit 0。
8. 写完成记录，置终态（若第 6 步触发逃逸则 `needs-human`）。

## AC

- [x] AC1 红态真因机械入档：`quay-e2e-7fOwtJ` 的 `error-context.md` 的 `# Error details` 逐字为 `Error: the criterion exceeded its 45000ms budget` + `Expected: < 45000` + `Received: 52585`，location 为 `e2e/voice-error-messages.spec.ts:699:1`；`watchdog-state.json` 逐字含 `"armed":true` 与 `"fired":false`；档案内写明该 error-context 只有这一条错误（四条腿无红）、AC-153 的 `expect:` 未点任何墙钟。
- [x] AC2 「未合入」机械入档：`git merge-base --is-ancestor 7d38f8e9 HEAD; echo $?` 输出非 0；`git branch --contains 7d38f8e9` 只列 `task/gap-ac153-criterion-wallclock-load-headroom`；开工基线 `grep -n '45_000' e2e/voice-error-messages.spec.ts` 列出 `:594` / `:699` / `:720`，`grep -n '45s criterion budget' src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` 列出 `:455`。四条读数逐字入档。
- [x] AC3 重标已落到出货线：`grep -n 'CRITERION_BUDGET_MS' e2e/voice-error-messages.spec.ts` 显示具名常量定义与各使用点；`grep -n '45_000\|45000' e2e/voice-error-messages.spec.ts` 无任何可执行命中（若有散文命中须逐条说明）；`grep -n '45s criterion budget' src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` 无命中。打印新值。
- [x] AC4 新值按实测包络定：打印新值、实测被报告 crossing 峰值、`SINGLE_SPEC_CEILING_MS`；证明 `峰值 < 新值 < 55000`、`55000 − 新值 ≥ 1000`、`新值 < 60000`；逐字证明两条看门狗读数（`watchdogLine===false` / `watchdog.armed===true`）仍在文件内。
- [x] AC5 安静臂全绿：出货命令 `npx playwright test e2e/voice-error-messages.spec.ts` 逐字跑 ≥3 次，全部 `exit 0`，每次自印 `legs=4 passed=4 watchdog-line=false`，逐次入档 `criterion-wall-ms` 与 worktree HEAD / `HEAD^{tree}`。
- [x] AC6 负载臂实测：≥20 路并发兄弟 `npx playwright test` 下重跑出货命令 ≥2 次，入档 `load1`、每次 `criterion-wall-ms`、`watchdog-line`；负载臂相对安静臂有可见差距。若在该负载下仍越新守则且低于看门狗：置 `needs-human` 并逐字入档，🚫 不把安静通过写成「已修」。
- [x] AC7 读数与判据未弱化：`git diff $(git merge-base HEAD develop)..HEAD -- goals/ | wc -c` 输出 `0`；`npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` exit 0；`npx tsc --noEmit -p tsconfig.json` exit 0；该 spec 的 `git diff` 只触及守则常量与其使用点（含注释里的 45s 表述）与组件登记串，四条腿断言与三条取假形态逐字未改。

## DoD

真实落地：出货命令 `npx playwright test e2e/voice-error-messages.spec.ts` 逐字不变，在安静宿主上 ≥3/3 `exit 0` 且自印 `legs=4 passed=4 watchdog-line=false`，且**在实测被报告 crossing 峰值之上**设定守则（本轮样本 `52585`），使末次那类红（52.585s、看门狗未触发、四条腿全绿）在新守则下为绿；由执行读数证明，不由段落文字声明。承重性由三件读数证明：

(a) **红是守则红，不是判据为假**：末次 red artifact 的 `# Error details` 只有守则断言，四条腿无红（AC1）。
(b) **不是「放宽 AC」**：`goals/AC-153-…md` 的 `criterion:` / `expect:` 逐字未改（AC7），新值仍 < `SINGLE_SPEC_CEILING_MS`（55000）与 60 秒门，两条看门狗读数仍在（AC4）。
(c) **不是重做上一条**：上一条的交付 `7d38f8e9` 从未成为 HEAD 祖先（AC2），本条把它落到出货线并按实测包络归因定值。

**已知不等价点与逃逸**：本机 ≥28–36 路并发下整轮膨胀以 runner boot 为主，尾部会越过 55s 看门狗（`gap-ac194-criterion-wallclock-load-scaled-fixed-cost` / `gap-e2e-runner-boot-inflation-under-fan-in-concurrency` 的读数）；`< 55000` 的任何定值都清不掉那条尾。若负载臂在**低于看门狗**处出现可复现的 crossing，本条按 Proposal 第 4 条置 `needs-human` 并附逐字读数，🚫 不得删守则、不得删读数、不得把安静通过写成「已修」。冷路径（Vite 优化器在预热返回后又提交）的真削减由 `gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence` 承担，本条不重复其杠杆。

## Touches

- e2e/voice-error-messages.spec.ts
- src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx
- tasks/gap-ac153-criterion-budget-rescale-unmerged.md

## 完成记录

把已获人工裁定的重标真正落到出货线，并按实测被报告 crossing 峰值**重新定值**。交付物只动两个源文件（`e2e/voice-error-messages.spec.ts` + `src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx`）与本任务记录（经 Provider ABI 写入）。

### 运行环境
- worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac153-criterion-budget-rescale-unmerged`
- branch：`task/gap-ac153-criterion-budget-rescale-unmerged`，fork 自 `develop` @ `9b584ff69ccc11ff83394ef5c4f8d8f3bcdf29ec`
- 实现提交：`f0c9ae4ab7885bba91c012d2b0c0352393beeb6d`，tree `28eaada81b6bf9e429a95ff5db73ac3ad34a4b67`

### AC1 红态真因（机械入档）
判据 artifact `quay-e2e-7fOwtJ` 已被 e2e 临时根回收（`config.outputDir = path.join(dataDir,'test-results')`，`/data/home/yale/.cache/quay-e2e-tmp/` 下无副本，任何检出内也无），故红态从其**独立台账记录**逐字入档：

- `.quay/gate-events.jsonl:114816` 逐字：`{"item_id":"AC-153","gate":"goal","actor":"goal-cli","verdict":"fail","timestamp":"2026-10-08T22:56:10.363Z","payload":{"reason":"acceptance failed (exit 1) — [WebServer] …quay-e2e-7fOwtJ/vite-cache/deps/react-scan.js…","treeSha":"68a001b2474c350d984f0770e99fa77d3d11620b"}}`
- `.quay/goal-round.jsonl`（round 2055，`ts":"2026-10-08T23:02:08.897Z"`）的 `frozenRecheck` 条目逐字引该 artifact 的 `# Error details`：`Error: the criterion exceeded its 45000ms budget` / `Expected: < 45000` / `Received: 52585`；watchdog `{"armed":true,"fired":false}`；`legs=4 passed=4`（该 entry：`verdict:"fail", durationMs:54635, load1:83.62, headSha:"38287c49b17aac30113de14e4f02243b346bf14d", outcome:"confirmed-failing", cause:"still-false"`）。
- 结构核实：`git show 68a001b2474c:e2e/voice-error-messages.spec.ts | grep -n '45000ms budget'` → line **699**（red tree = commit `38287c49`，tree `68a001b2474c`，与台账 `treeSha` 一致）。5 个存活兄弟 artifact（`quay-e2e-6vD7jF / UfVa6f / QivcoP / 4C0DFS / Viv5YN`）同形断在 `…:719:1` 的预算断言上；其中 `UfVa6f`(47400)、`QivcoP`(48475) 的 `watchdog-state.json` 同样 `"fired":false`。
- **artifact 一次性回收的披露 + 存活兄弟对照**：`quay-e2e-7fOwtJ` 目录已被 e2e 临时根回收（`/data/home/yale/.cache/quay-e2e-tmp/` 现存 `quay-e2e-*` 池 397 个，无 `7fOwtJ`；其 stderr 里 ENOENT 的 `…/7fOwtJ/vite-cache/deps/react-scan.js` 亦不可再取），故补一份**同日同树存活兄弟对照**（均 tree `19b222c559484f6621e56832499b64b021d39184`，比 `7fOwtJ` 的 `68a001b2474c` 更晚）：
  - `quay-e2e-QivcoP/watchdog-state.json` 逐字 = `{"armed": true, "fired": false, "ceilingMs": 55000, "detail": "boot 40000ms, re-armed to 55000ms once past boot"}`；mtime `2026-10-09 07:55:42.663410087 +0800`（=`2026-10-08T23:55:42.663Z`）；其 goal 记账 `.quay/gate-events.jsonl:114906` ts `2026-10-08T23:56:32.072Z` verdict `fail` treeSha `19b222c5`。
  - `quay-e2e-4C0DFS/watchdog-state.json` 逐字 = `{"armed": true, "fired": true, "ceilingMs": 55000, "detail": "ceiling crossed at 55001ms"}`；mtime `2026-10-09 07:52:49.985053630 +0800`（=`2026-10-08T23:52:49.985Z`）；其 goal 记账 `.quay/gate-events.jsonl:114899` ts `2026-10-08T23:52:50.127Z` verdict `fail` treeSha `19b222c5`（mtime↔记账 Δ = **142ms**）。
  - 同形另有 `quay-e2e-6vD7jF`（fired:true，`ceiling crossed at 55003ms`）、`quay-e2e-Viv5YN`（fired:true，`ceiling crossed at 55000ms`）、`quay-e2e-UfVa6f`（fired:false）。⇒ **同一树、同一约 5 分钟窗口内 `fired:false` 与 `fired:true` 并存的同形兄弟**，是看门狗**间歇触发**（越顶即 55s SIGKILL、非产品面红）的直接证据。
- `goals/AC-153-真实浏览器里各类失败显示各自的文案-提示持续显示到关闭-草稿保留-技术详情折叠.md` 的 `expect:` 通篇不点任何墙钟 ⇒ 该 45000 属交付任务自加守则，非 AC 的保证。该 error-context 内只有这一条错误 ⇒ 四条腿读了正确的值（无红）。

### AC2 「未合入」（机械入档）
- `git merge-base --is-ancestor 7d38f8e9 HEAD; echo $?` → `1`
- `git branch --contains 7d38f8e9` → `+ task/gap-ac153-criterion-wallclock-load-headroom`（仅此一条）
- 开工基线 `grep -n '45_000' e2e/voice-error-messages.spec.ts` → `594` / `699` / `720`；`grep -n '45s criterion budget' src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` → `455`

### AC3 重标已落到出货线
`grep -n 'CRITERION_BUDGET_MS' e2e/voice-error-messages.spec.ts`：

```
260:  … above it stops reading at `CRITERION_BUDGET_MS` — …
332:const CRITERION_BUDGET_MS = 54_000;
613:  … inside `CRITERION_BUDGET_MS` and therefore inside the goal gate's …
617:  test.setTimeout(CRITERION_BUDGET_MS);
722:  expect(criterionWallMs, `the criterion exceeded its ${CRITERION_BUDGET_MS}ms budget`)
723:    .toBeLessThan(CRITERION_BUDGET_MS);
744:  test.setTimeout(CRITERION_BUDGET_MS);
```

`grep -n '45_000\|45000' e2e/voice-error-messages.spec.ts` 只剩一处**散文**命中 `:317`——常量文档注释里「The value this replaces (45_000)」，解释旧值，非可执行；`grep -n '45s criterion budget' src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` **无命中**（exit 1）。**新值 = `54_000`。**

### AC4 新值按实测包络定
- 新值 `54_000`；实测被报告 crossing 峰值 `52_585`（AC1 台账）；`SINGLE_SPEC_CEILING_MS` = `55_000`（`playwright.config.ts:320`）。
- `52_585 < 54_000 < 55_000` ✓；`55_000 − 54_000 = 1_000 ≥ 1_000` ✓；`54_000 < 60_000`（goal gate）✓。
- 两条看门狗读数逐字仍在文件内：`:724 expect(watchdogLine, 'this run\'s own watchdog fired…').toBe(false)`、`:725 expect(watchdog.armed, 'the watchdog was never armed…').toBe(true)`。

### AC5 安静臂全绿（出货命令逐字，6 次）
`npx playwright test e2e/voice-error-messages.spec.ts`，worktree HEAD `f0c9ae4a` / tree `28eaada8`：

| # | exit | criterion-wall-ms | watchdog-line | legs | load1 |
|---|------|-------------------|---------------|------|-------|
| 1 | 0 | 30473 | false | 4/4 | 40.33 |
| 2 | 0 | 30219 | false | 4/4 | 37.18 |
| 3 | 0 | 29028 | false | 4/4 | 27.33 |
| 4 | 0 | 27762 | false | 4/4 | 19.42 |
| 5 | 0 | 27283 | false | 4/4 | 17.04 |
| 6 | 0 | 32209 | false | 4/4 | 42.27 |

6/6 `exit 0`，每次自印 `legs=4 passed=4 watchdog-line=false`。安静臂最大值 32209，距 `54_000` 余量 21.8s。逐次日志 `/tmp/ac153-budget/quiet-{1..6}.log`。

### AC6 负载臂实测（20 路并发兄弟）
`QUAY_MEMORY_MAX=48G bash scripts/with-memory-cap.sh bash /tmp/ac153-budget/load-arm.sh`：20 路兄弟 `npx playwright test e2e/model-env-kind-explanations.spec.ts`（各 5 轮）并发下重跑出货命令 2 次（20 路全部 exit 0；各 criterion 起跑时 `live_siblings=20`）：

- criterion-A：exit 0，`criterion-wall-ms=37587`，`load1=71.72`，watchdog-line=false
- criterion-B：exit 0，`criterion-wall-ms=36000`，`load1=66.29`，watchdog-line=false

负载臂相对安静臂有**可见差距**（~+7s）。**未出现「低于看门狗处可复现的 crossing」**（两次都 exit 0、远低于 `54_000`）⇒ Proposal 第 4 条 / DoD 的逃逸条款**未触发**。DoD 已声明的 ≥28–36 路看门狗尾部属**已知不等价点**（`< 55000` 的任何定值都不清它），本条 20 路落在其下。🚫 未把安静通过写成「已修」——产品面读数与守则读数分开记录。全量输出 `/tmp/ac153-budget/load-arm.out`。

**追加负载臂（24 路）**（`QUAY_MEMORY_MAX=48G QUAY_MEMORY_UNIT=ac153-load24 bash scripts/with-memory-cap.sh bash /tmp/ac153-budget/load-arm-24.sh`，24 路兄弟 × 2 轮）：

- settle 后 `live_siblings=24`、`load1=57.34`；criterion-A exit 0，`criterion-wall-ms=32753`、`watchdog-line=false`（收时 `load1=48.45`）。
- criterion-B exit 0，`criterion-wall-ms=28555`、`watchdog-line=false`（跑时 `live_siblings=0`，兄弟已排空 ⇒ **非负载读数**）。
- ⇒ 24 路**无 crossing**（输出 `/tmp/ac153-budget/load-arm-24.out`）。

**追加负载臂（28 路，越预算即报废）**：`load-arm-28.sh`（28 路 × 6 轮）在 `ac153-load28.scope`（MemoryMax=48G、MemorySwapMax=0）下 28.8s 后**被 OOM killer 击杀**——`journalctl --user -u ac153-load28.scope`：`A process of this unit has been killed by the OOM killer … Failed with result 'oom-kill'`（CPU 26min44s）。即 28 路并发已超 48G 预算，**非判据读数**；故本条可信负载包络为 **20 / 24 路**。

**负载量级对齐红点**：红当日 ledger `load1` 读数为 `83.62`（round 2055，`2026-10-08T23:02:08.897Z`）与 `150.47 / 130.51 / 211.18 / 138.26`（`.quay/goal-round.jsonl` 行 16703–16706，`2026-10-08T23:47:54–23:57:24Z`——正是上面存活兄弟 artifact 的生成窗口）。本轮负载臂 `load1` ≤72（20 路峰值 71.72、24 路 57.34），**低于红点量级**；而 `load1` ≥130 量级处 5 个同形兄弟里 3 个越 55s 看门狗（`4C0DFS`/`6vD7jF`/`Viv5YN`），正对应 DoD 已声明的 ≥28–36 路**已知不等价点**（尾部 > 55000、SIGKILL）。本条的 `54_000` 清掉的是**被报告**的 52.585s 红（`load1` 83.62）；> `55000` 的尾部任何值都不清，属声明外、非本条逃逸。

### AC7 读数与判据未弱化
- `git diff $(git merge-base HEAD develop)..HEAD -- goals/ | wc -c` → `0`
- `npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` → exit 0（3 tests passed；登记串现印 `…55s watchdog and its 54s criterion budget…`）
- `npx tsc --noEmit -p tsconfig.json` → exit 0
- 该 spec 的 `git diff` 只触及守则常量（`CRITERION_BUDGET_MS`）与其三处使用点、两条注释里的 45s 表述、组件登记串一处；四条腿断言与三条取假形态（`voiceErrorNoticePersistence.test.tsx`）**逐字未改**。`git diff --name-only $(git merge-base HEAD develop)..HEAD` = `e2e/voice-error-messages.spec.ts` + `src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx`（+ 本记录，经 ABI）。

### 结论
守护值定为 `54_000`：在被报告 crossing 峰值（`52_585`）之上、`SINGLE_SPEC_CEILING_MS`（`55_000`）之下留足 1000ms 报告头部。末次那类红（52.585s、看门狗未触发、四条腿全绿）在新守则下**为绿**；安静臂 6/6 全绿（max 32209），负载臂 20 路 ×2（37587 / 36000）与 24 路 ×1（32753）全绿，`load1` 至 71.72；28 路越 48G 预算被 OOM 击杀（非读数）。**未出现「低于看门狗处可复现的 crossing」⇒ 逃逸条款未触发**；`> 55000` 的看门狗尾部（`load1` ≥130 量级、5 个同形兄弟中 3 个越顶）属 DoD 已声明的**已知不等价点**（`< 55000` 的任何定值都不清它），本条不声称清除。未改 AC-153 的产品面与 `goals/AC-153-…md` 的 `criterion:`/`expect:`。
