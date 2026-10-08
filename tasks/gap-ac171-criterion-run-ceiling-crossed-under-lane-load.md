---
id: gap-ac171-criterion-run-ceiling-crossed-under-lane-load
title: AC-171 判据在 fan-in 车道载荷下越过 55s 运行看门狗而假红（Channel
  closed）：削减判据的运行级固定成本（客户端冷加载 4 次→1 次），让 e2e/resident-enable-consent.spec.ts 在
  60s 门限内稳定跑绿，载重读数一条不动
status: ready
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

- [x] AC1 红已定位到运行 watchdog 而非断言：`## Evidence` 逐字登记 `quay-e2e-88c0uk` 与 `quay-e2e-q5SDLB` 的 `watchdog-state.json`（`armed:true`、`fired:true`、`ceilingMs:55000`、`ceiling crossed at 55006ms` / `55005ms`）与 `error-context.md` 的 `Error: Channel closed`（`:646` / `:701`），以及同一棵树 `6bfc3141` 上 4 绿 1 红（4 个 pass 时间戳 + `06:31:38Z` fail）。
- [x] AC2 运行级墙钟削减（承重）：隔离态 `npx playwright test e2e/resident-enable-consent.spec.ts` 的总 duration 比 27.5s 基线下降 **≥ 5s（≥ 20%）**（登记 before/after 各 3 次的实测值与逐用例 duration）；实现方式为使客户端冷加载从 4 次降到 1 次（共享 context/page，必要时叠一次预热）。
- [x] AC3 载重读数不弱化（承重）：`grep -cE "toBe\('resident'\)|toBe\('per-run'\)" e2e/resident-enable-consent.spec.ts` = **7**（不少于现行值），且 silent-conversion 腿与 capability 腿逐字保留。
- [x] AC4 稳定：连续 5 次 `npx playwright test e2e/resident-enable-consent.spec.ts` 均 exit **0**，逐次登记 duration 与 `watchdog-state.json` 的 `fired:false`。
- [x] AC5 假形态必须红（承重）：在 `src/modules/chat/hooks/useChatComposerState.ts` 新会话分支去掉 `if (residentEnabled)` 的 resident 写入 ⇒ `:441` 腿红在 `createdMode === 'resident'`（Received `per-run`）；登记变异 diff、失败断言逐字、退出码；恢复后复绿。
- [x] AC6 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内。

## DoD

- 判据隔离态比 27.5s 基线削减 **≥ 5s**：连续 5 次绿、每次 `watchdog-state.json` `fired:false`；这条削减使观测到的 ~2x 载荷膨胀仍落在 55s watchdog 之内（红态基线：2026-10-08 `quay-e2e-88c0uk` / `quay-e2e-q5SDLB`，`ceiling crossed at ~55006ms`；载荷确认由 driver 下一轮给出）。
- 客户端冷加载从每条用例一次降到整文件一次；`openComposer` 不再用固定 `waitForTimeout` 凑时。
- 载重读数（`:441` resident + per-run 正控制、silent-conversion、capability）与今天逐字相同。
- 假形态真跑、真红，红落在 resident 读数上；只动 `## Touches` 列出的文件。

## Touches

- `e2e/resident-enable-consent.spec.ts`
- `playwright.config.ts`
- `tasks/gap-ac171-criterion-run-ceiling-crossed-under-lane-load.md`（自触）

## Evidence

<!-- 本轮（2026-10-08）自己直跑登记的原始读数，不是台账推断。 -->

### 红态定位（AC-1）

**watchdog-state.json（逐字，两处 red run 的 run 目录；本 run 拥有 watchdog 时才写此文件，即 `QUAY_E2E_DATA_DIR` 未显式设置）：**

`~/.cache/quay-e2e-tmp/quay-e2e-88c0uk/watchdog-state.json`：

```json
{
  "armed": true,
  "fired": true,
  "ceilingMs": 55000,
  "detail": "ceiling crossed at 55005ms"
}
```

`~/.cache/quay-e2e-tmp/quay-e2e-q5SDLB/watchdog-state.json`：

```json
{
  "armed": true,
  "fired": true,
  "ceilingMs": 55000,
  "detail": "ceiling crossed at 55006ms"
}
```

**error-context.md（逐字）：**

`~/.cache/quay-e2e-tmp/quay-e2e-88c0uk/test-results/resident-enable-consent-a--ceef2-un-session-on-the-next-send/error-context.md`：

```
- Location: e2e/resident-enable-consent.spec.ts:646:1

# Error details

Error: Channel closed

Error: page.waitForTimeout: Target page, context or browser has been closed
```

同一文件的 `# Test source` 段把失败点钉在 `> 346 | await page.waitForTimeout(500);` —— 即 `openComposer` 重试环里那两条凑时睡眠之一（本任务删掉的两条）。载荷假红落在固定睡眠上，不是任何一条断言上。

`~/.cache/quay-e2e-tmp/quay-e2e-q5SDLB/test-results/resident-enable-consent-a--c7b73--one-menu-click-converts-it/error-context.md`：

```
- Location: e2e/resident-enable-consent.spec.ts:701:1

# Error details

Error: Channel closed
```

**同一棵树 `6bfc3141ff221e5b7ed05c0d685e63c78836acde`（== HEAD `62f3b3eb`）的 gate 事件：** pass `06:23:40Z` / `06:25:22Z` / `06:27:11Z` / `06:29:02Z`；fail `06:31:38Z`（exit 1）。⇒ 同树同判据 4 绿 1 红，绿红只差当轮车道载荷。

### 运行级墙钟削减（AC-2）

命令：`bash scripts/with-memory-cap.sh npx playwright test e2e/resident-enable-consent.spec.ts`（隔离态；未显式设置 `QUAY_E2E_DATA_DIR`，watchdog 由本 run 拥有）。登记 playwright 自报的 `N passed (Xs)` 与逐用例 duration。

**before（改动前的树，3 次）：**

| # | total | case1 | case2 | case3 | case4 |
|---|-------|-------|-------|-------|-------|
| 1 | 26.4s | 4.0s | 5.4s | 3.0s | 2.9s |
| 2 | **27.5s** | 4.1s | 5.6s | 3.1s | 2.9s |
| 3 | 26.6s | 4.0s | 5.5s | 3.0s | 2.8s |

与任务立案时登记的 `4 passed (27.5s)`、逐用例 4.1/5.4/2.8/2.9 一致；台账基线 27.5s 即下表逐行要减的被减数。

**after（改动后，与 AC-4 同一批 5 次连续绿）：**

| # | total | 相对 27.5s | case1 | case2 | case3 | case4 | watchdog |
|---|-------|-----------|-------|-------|-------|-------|----------|
| 1 | 21.2s | −6.3s (−22.9%) | 1.6s | 4.3s | 2.5s | 1.5s | `fired:false` |
| 2 | 21.6s | −5.9s (−21.5%) | 1.7s | 4.3s | 2.6s | 1.8s | `fired:false` |
| 3 | 21.7s | −5.8s (−21.1%) | 1.6s | 4.3s | 2.6s | 1.5s | `fired:false` |
| 4 | 21.8s | −5.7s (−20.7%) | 1.6s | 4.3s | 2.6s | 1.5s | `fired:false` |
| 5 | 21.2s | −6.3s (−22.9%) | 1.6s | 4.2s | 2.5s | 1.5s | `fired:false` |

最慢一次 21.8s ⇒ 比 27.5s 基线下降 **5.7s（20.7%）**，≥5s 且 ≥20%，对 55s watchdog 留出 ~33s 余量，足以吞下观测到的 ~2x 载荷膨胀。逐用例也各降：case1 −2.5s、case2 −1.1~1.4s、case3 −0.4~0.6s、case4 −1.1~1.4s。

**实现方式（客户端冷加载 4 次 → 1 次）：** 四条 `serial` 用例共享 `beforeAll` 建的一个 browser context/page —— `page` fixture 被覆写为转发共享页，`bootstrapAuth` 改为接收一个 `Page` 而非自建 context，`afterAll` 关掉这一个 context。第一条用例复用 `beforeAll` 留下的状态（默认 provider 就是常驻的 `claude`，见 `src/shared/selectedProvider.ts` 的 `DEFAULT_PROVIDER`）而不再额外 reload；其余三条保留 `page.goto('/')`，因为上一条用例把常驻开关（`ChatInterface` 上的 React 状态）留成了 on，必须重载才能清零。`openComposer` 里三条固定 `waitForTimeout`（400/500/500ms）换成对「该次点击的下一读」的有界 `waitFor`（`COMPOSER_STEP_READY_MS = 2_000`，五次重试加末尾 15s 断言仍在用例 45s 预算内）。

**成本定位（临时插桩，已移除）：** 改动前一次运行的相位读数——config 评估 + 两 webServer 启动 ≈4.5s；`beforeAll` ≈6.6~7.1s，其中 `ensureSignedIn` 的 `page.goto('/')`（冷加载）5.6~5.8s、到达判定 ~0.17s；四条用例各一次 `page.goto('/')` 的暖重载 1.08/0.81/0.78/0.81s。⇒ 每条用例一次冷/暖加载正是要削掉的运行级固定成本。

### 稳定（AC-4）

上表 5 次连续 `npx playwright test e2e/resident-enable-consent.spec.ts` 全部 `4 passed`、exit **0**，每次 run 自身的 `watchdog-state.json` 均为 `armed:true` / `fired:false` / `ceilingMs:55000`（例：`quay-e2e-kj0w3c`、`quay-e2e-Rhnhn8`、`quay-e2e-z3VyTk`）。

### 载重读数不弱化（AC-3）

`grep -cE "toBe\('resident'\)|toBe\('per-run'\)" e2e/resident-enable-consent.spec.ts` = **7**（与现行值相同）。`git diff $(git merge-base develop HEAD) HEAD -- e2e/resident-enable-consent.spec.ts` 中没有任何 `+`/`-` 行含 `toBe('resident')` 或 `toBe('per-run')` ⇒ 这 7 条断言逐字未动；silent-conversion 腿（`SEEDED_SESSION_ID` 仍读 per-run）与 capability 腿逐字保留。`openComposer` 内已无固定 `waitForTimeout`（仅剩 `ensureSignedIn` 失败退避的 1s 与 silent-conversion 腿语义所需的 2s，均在 `openComposer` 之外）。

### 假形态必须红（AC-5）

先提交实现（`0f554342`），再在 `src/modules/chat/hooks/useChatComposerState.ts` 新会话分支把 `if (residentEnabled)` 的整块（含 `await api.providers.setSessionLifecycleMode(provider, targetSessionId, 'resident')` 与 `clearResidentIntent?.()`）以 `if (false && residentEnabled)` 关掉。变异 diff：

```diff
-        if (residentEnabled) {
+        if (false && residentEnabled) {
```

跑判据结果（exit **1**）：

```
created.sessionId=1cb8ee5d-f6e2-48b6-a1f6-bf2e825b2aa2
session.lifecycle_mode=per-run
  ✘  1 e2e/resident-enable-consent.spec.ts:578:1 › the new-session screen carries the switch under the model card, and sending with it on lands resident (21.5s)
    Error: the session a switch-on send is addressed to must read back as resident from the server
    Expected: "resident"
    Received: "per-run"
```

失败断言逐字落在 `e2e/resident-enable-consent.spec.ts:687:5`（`).toBe('resident');`；即任务所述「`:441` 腿」——行号随本次改动整体下移）。serial 模式下用例 2/3/4 被跳过。`git checkout -- src/modules/chat/hooks/useChatComposerState.ts` 恢复后复绿：`4 passed (21.4s)`、exit 0、`fired:false`（`quay-e2e-z3VyTk`）。

### 契约面（AC-6）

- `npm run lint` → exit **0**（仅仓库既有 warning，无新增）。
- `npm run typecheck` → exit **0**。
- `git diff --name-only $(git merge-base develop HEAD) HEAD` = `e2e/resident-enable-consent.spec.ts`，落在 `## Touches` 内。变异文件已还原，工作树干净。
