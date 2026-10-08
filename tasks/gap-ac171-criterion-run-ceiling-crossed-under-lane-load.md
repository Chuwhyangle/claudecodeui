---
id: gap-ac171-criterion-run-ceiling-crossed-under-lane-load
title: AC-171 判据在 fan-in 车道载荷下越过 55s 运行看门狗而假红（Channel
  closed）：削减判据的运行级固定成本（客户端冷加载 4 次→1 次），让 e2e/resident-enable-consent.spec.ts 在
  60s 门限内稳定跑绿，载重读数一条不动
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-171
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，2026-10-08）：`grep -rl "^goal_ac: *AC-171" tasks/*.md` 只命中 `tasks/gap-claude-resident-consent-gate.md`、`tasks/gap-resident-i18n-duplicate-key-shadows-toggle-and-notice.md`、`tasks/gap-ac171-criterion-red-is-mid-run-hmr-load-stabilize.md`，三者均 `status: done`；`grep -rl "AC-171" tasks/*.md` 命中的 16 条也全部 `done` —— 无 todo/ready/needs-human 认领。`task-granularity-advice.js --touches e2e/resident-enable-consent.spec.ts --touches playwright.config.ts` 的 `peers: []` ⇒ 无同文件在途任务，本条既非重复也无可合并对象。已 done 的 `gap-ac171-criterion-red-is-mid-run-hmr-load-stabilize`（5fee2e1a，2026-10-05）是「上一次修复没扛住」的证据（见下）。

**判据物。** 逐字取自 `goals/AC-171-真实浏览器里开启常驻须先勾选知情-未勾选不能发送或转换.md`（文件名是旧题，frontmatter `title` 已是现行「常驻开关打开即生效，hint 仅作说明不门控发送或转换」）的 `criterion:`：`npx playwright test e2e/resident-enable-consent.spec.ts`。担保（yale 2026-09-29 与 2026-10-04 有意修订，仍是现行意图）：常驻开关打开即生效，hint 是默认收起、悬停/触碰才展开、**不门控**发送或转换的只读提示，不存在任何需要先勾选的确认态。

**本轮读数（自己直跑，不是台账推断）。** 隔离态 `npx playwright test e2e/resident-enable-consent.spec.ts` → `4 passed (27.5s)`，exit **0**；逐用例 4.1s / 5.4s / 2.8s / 2.9s。⇒ **担保今天是真的**；这是载荷假红，不是行为回归（见 [[left-reverify-ac-ledger-red-can-be-a-flaky-rerun]]）。

**driver 红在哪（读判据自己的工件，不读台账 reason）。** 同一棵树 `6bfc3141ff221e5b7ed05c0d685e63c78836acde`（== HEAD `62f3b3eb`）上，AC-171 的 gate 事件 4 绿 1 红：pass `06:23:40Z` / `06:25:22Z` / `06:27:11Z` / `06:29:02Z`，fail `06:31:38Z`（exit 1）。红的两处工件：

1. `~/.cache/quay-e2e-tmp/quay-e2e-88c0uk/watchdog-state.json`（run 14:30 本地）= `{"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55006ms"}`；`quay-e2e-q5SDLB`（14:22）同形，`ceiling crossed at 55005ms`。
2. 两处 `test-results/*/error-context.md` 逐字：`Error: Channel closed`（88c0uk 落在 spec `:646`，q5SDLB 落在 `:701`），88c0uk 另有一行 `Error: page.waitForTimeout: Target page, context or browser has been closed`。

⇒ 是**整条 run** 在 fan-in 车道载荷下越过 `playwright.config.ts` 的 55s run watchdog（`SINGLE_SPEC_CEILING_MS`），watchdog 关闭浏览器、exit 非零，台账记为 `verdict: fail`；不是某条断言失败，因此没有任何可读的失败点（与 [[e2e-onboarding-walk-unbounded-mid-run-reload-kills-beforeall]] 同类）。

**为什么「上一次修复」没扛住。** `5fee2e1a`（前身 `gap-ac171-criterion-red-is-mid-run-hmr-load-stabilize`）加固的是**每用例**预算（5s→20s）与运行中 HMR 重挂载。真正在载荷下膨胀的是**运行级固定成本**：config 评估 + 两个 webServer 启动（API `npx tsx server/index.ts` 与 `npx vite`）+ 浏览器启动 + beforeAll 的 onboarding 走查（`bootstrapAuth`→`ensureSignedIn`），再加 4 条 serial 用例**各自**一次 `page.goto('/')` 的客户端冷加载（全文件 5 处 `page.goto('/')`、5 处 `waitForTimeout`）。这些当时没动。与本仓 mcp-settings 那一线的做法同类：`689f2aa2`（共用一个 Vite 客户端）、`4c605927`（去掉未用的 webServer 对）、`98304765`（run 天花板直接起表）、`a0695b7b`（把服务端启动叠到客户端预热上）。

**要建的东西（最小充分集）。** 削减判据的**运行级**墙钟，使载荷下的 run 在 55s watchdog 之下留出余量——主要手段是**去掉整次客户端冷加载**：4 条 serial 用例共享**一个** browser context/page（或把客户端预热成一次、在任何用例之前），并删掉 `openComposer` 里仅用于凑时的固定 `waitForTimeout(500)`。目标：隔离态墙钟从 27.5s 基线下降 **≥ 5s（≥ 20%）**，使观测到的 ~2x 载荷膨胀仍落在 55s 以内。beforeAll 的 onboarding 走查保持只走一次。

**非目标。** 不改常驻运行时行为，不改 `residentEnabled` 的生产语义；**不弱化任何载重读数**——7 处 `toBe('resident')|toBe('per-run')`（`:441` resident 腿 + per-run 正控制、silent-conversion 腿、capability 腿）逐字保留，不得减少；不改验收门的 60s 上限（在仓外，不在 Touches）；不把 watchdog 抬到 config 自身推导之上；不额外起并发压测（见 [[defer-load-problems-do-not-stress-test-inline]]）。

## Plan

1. **红态与定位（第一步）**：读 `~/.cache/quay-e2e-tmp/quay-e2e-88c0uk` 与 `quay-e2e-q5SDLB` 的 `watchdog-state.json` 与 `error-context.md`，逐字登记；隔离态连跑判据 3 次，登记每次总 duration、逐用例 duration、`watchdog-state.json` 的 `fired`。
2. **运行级成本削减（承重）**：把 4 条 serial 用例改为共享一个 browser context/page（文件级 fixture 或 beforeAll 里建一次），让客户端冷加载从 4 次降到 1 次；若共享后某腿需要干净状态，只在必要处 `page.reload()` 而不要整次新建 context。删掉 `openComposer` 重试环里无信息量的 `waitForTimeout(500)`（`:346` 一带）。
3. **必要时叠一层预热**：若共享 context 后仍余量不足，可在 cases 前对本 run 的 `CLIENT_URL` 预热一次（先加载一次 `/`，使 Vite 依赖预打包变热），放进 beforeAll 而非每条用例，与 step 2 同属同一条削减。
4. **跑绿与余量**：连续 5 次 `npx playwright test e2e/resident-enable-consent.spec.ts` 均 exit 0，逐次登记 duration、逐用例 duration、`watchdog-state.json` 的 `fired:false`，确认隔离态与 27.5s 基线相比有 ≥5s 的削减且最慢一次仍有明显余量。
5. **载重读数不弱化**：`grep -cE "toBe\('resident'\)|toBe\('per-run'\)" e2e/resident-enable-consent.spec.ts` = 7；silent-conversion 腿（`SEEDED_SESSION_ID` 仍 per-run）与 capability 腿逐字保留。
6. **假形态承重**：提交后在 `src/modules/chat/hooks/useChatComposerState.ts` 的新会话分支去掉 `if (residentEnabled)` 的 `await api.providers.setSessionLifecycleMode(provider, targetSessionId, 'resident')` 整块，`:441` 腿必须在 `createdMode === 'resident'` 上红（Received `per-run`）；`git checkout` 恢复后复绿。先提交再变异，跑完恢复（见 [[uncommitted-worker-implementation-wiped-by-checkout-restore]]）。
7. **契约面**：`npm run lint`、`npm run typecheck` 绿；`git diff --name-only $(git merge-base develop HEAD) HEAD` 落在 Touches 内。

## AC

- [ ] AC1 红已定位到运行 watchdog 而非断言：`## Evidence` 逐字登记 `quay-e2e-88c0uk` 与 `quay-e2e-q5SDLB` 的 `watchdog-state.json`（`armed:true`、`fired:true`、`ceilingMs:55000`、`ceiling crossed at 55006ms` / `55005ms`）与 `error-context.md` 的 `Error: Channel closed`（`:646` / `:701`），以及同一棵树 `6bfc3141` 上 4 绿 1 红（4 个 pass 时间戳 + `06:31:38Z` fail）。
- [ ] AC2 运行级墙钟削减（承重）：隔离态 `npx playwright test e2e/resident-enable-consent.spec.ts` 的总 duration 比 27.5s 基线下降 **≥ 5s（≥ 20%）**（登记 before/after 各 3 次的实测值与逐用例 duration）；实现方式为使客户端冷加载从 4 次降到 1 次（共享 context/page，必要时叠一次预热）。
- [ ] AC3 载重读数不弱化（承重）：`grep -cE "toBe\('resident'\)|toBe\('per-run'\)" e2e/resident-enable-consent.spec.ts` = **7**（不少于现行值），且 silent-conversion 腿与 capability 腿逐字保留。
- [ ] AC4 稳定：连续 5 次 `npx playwright test e2e/resident-enable-consent.spec.ts` 均 exit **0**，逐次登记 duration 与 `watchdog-state.json` 的 `fired:false`。
- [ ] AC5 假形态必须红（承重）：在 `src/modules/chat/hooks/useChatComposerState.ts` 新会话分支去掉 `if (residentEnabled)` 的 resident 写入 ⇒ `:441` 腿红在 `createdMode === 'resident'`（Received `per-run`）；登记变异 diff、失败断言逐字、退出码；恢复后复绿。
- [ ] AC6 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内。

## DoD

- 判据隔离态比 27.5s 基线削减 **≥ 5s**：连续 5 次绿、每次 `watchdog-state.json` `fired:false`；这条削减使观测到的 ~2x 载荷膨胀仍落在 55s watchdog 之内（红态基线：2026-10-08 `quay-e2e-88c0uk` / `quay-e2e-q5SDLB`，`ceiling crossed at ~55006ms`；载荷确认由 driver 下一轮给出）。
- 客户端冷加载从每条用例一次降到整文件一次；`openComposer` 不再用固定 `waitForTimeout` 凑时。
- 载重读数（`:441` resident + per-run 正控制、silent-conversion、capability）与今天逐字相同。
- 假形态真跑、真红，红落在 resident 读数上；只动 `## Touches` 列出的文件。

## Touches

- `e2e/resident-enable-consent.spec.ts`
- `playwright.config.ts`
- `tasks/gap-ac171-criterion-run-ceiling-crossed-under-lane-load.md`（自触）