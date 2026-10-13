---
id: gap-ac328-fixture-and-leg2-boot-readiness-wait
title: AC-328 判据仍在负载下假红（第二轮）：fixture 的登录页等待与 leg 2 入口仍是裸 `goto` + 定长 20s 可见性等待 ⇒
  把 leg 1 的「应用确已渲染」就绪/重载纪律扩到这两处，全部读数一条不动
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-328
---
## Proposal

现状（直接测量，2026-10-14 01:54–01:56，本仓）：AC-328 的判据 `npx playwright test e2e/session-lapse-transient.spec.ts` 又在宿主并发下非确定性 exit 1，而红点**不在任何一条腿的读数上**，在 `beforeAll` 的假登录 fixture 的**第一屏**。

红态逐字（本轮 driver 重跑留下的失败工件，非转述）：该次运行数据目录 `…/quay-e2e-0VjlXy/test-results/session-lapse-transient-a--5890b--does-not-sign-the-user-out/error-context.md` 逐字：

```
Error: expect(locator).toBeVisible() failed
Locator: getByRole('button', { name: 'Create Account' }).or(locator('#username')).first()
Expected: visible
Timeout: 20000ms
Error: element(s) not found
```

该定位器组合在 spec 里只出现一处——`beforeAll` 第 258 行（`await page.goto('/')`（第 255 行）之后立刻等的正是登录页）。`error-context.md` 的 `Location: e2e/session-lapse-transient.spec.ts:314:1` 与 Test source 光标（落在 258 行）合起来说明：Playwright 把 `beforeAll` 的失败挂到首用例显示，而真正到期的是 fixture 里的这条登录页可见性等待。即：**登录页在 20s 内根本没渲染出来**，fixture 死在第一屏，两条腿一条都没跑。

同目录 `watchdog-state.json` = `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}` ⇒ 这一跑**没被 watchdog kill**（已越过 boot 阶段、运行上限 55000 未触发），判据确实跑到了断言并真红，不是引导越界；`test-results/.last-run.json` `status:"failed"` 佐证。同一形态今天还有第二跑（数据目录 `…/quay-e2e-8j5Qq3/…/error-context.md` 逐字同形、同 watchdog 读数），说明它不是单次噪声。

同 treeSha 的直接对照证明这是 flake 不是产品回归：本 agent 于 01:56 直接单文件重跑 ⇒ `2 passed (24.1s)`、`EXIT=0`、就绪读数 `[e2e] the app rendered into #root after 1477ms over 1 load(s) of "/"`。产品策略（`src/modules/auth/context/AuthContext.tsx`）与判据自 `7867d962`（spec 创建）/`01d5644d5`（上一轮修）起一字未改。

机制：`beforeAll`（第 255–258 行）与 leg 2 入口（第 363–367 行）至今仍是**裸 `await page.goto('/')` + 定长 20s 可见性等待**。`goto` 等的是 `load`，而本 SPA 的模块图（`main.tsx` → React）是 Vite 按需 transform 的 ES module，`load` 之后应用可能尚未挂载；宿主并发（本次同窗 748 个 `quay-e2e-*` 数据目录、56 个 01:50 后新建）下这一窗口可超过 20s，于是登录页等不到、fixture 先死。**这正是上一轮 done 任务 `gap-ac328-leg1-self-check-read-count-cold-boot-flake`（commit `01d5644d5`）已经识别并修过的同一机制**——但那一轮只把「应用确已渲染」的就绪/重载纪律（`loadApp`）装到 **leg 1 的读计数谓词**上，并在其「边界与后续」里**明示未动** fixture 的 `goto`+可见性等待与 leg 2 的入口等待（原文：「leg 2 的入口等待…未动…这属于**另一个**判据面；本轮不顺手扩面，登记在此供后续按需立案」）。所以本轮不是「策略没守住」，而是那条被显式缓议的同一层面**现在真的红在了判据上**：先前的修复没覆盖到这个代码路径。

修法方向（**只加固启动就绪与预算，读数一条不动**）：把 leg 1 已经用的就绪/重载纪律扩到剩余两处裸 `goto`+定长可见性等待——(i) `beforeAll` 的登录页等待（第 255–258 行）与 fixture 内第二次 `goto('/')`→`loginField` 等待（第 275–276 行），(ii) leg 2 的入口等待（第 363–367 行）。形态：复用/泛化 spec 已有的 `appears`/`loadApp`——在一个由预算派生的窗口内「等应用渲染 +（需要时）等目标定位器出现」，一次 load 没渲染/没到位即 reload，直到到位或预算用尽；预算不得超出现有 `test.setTimeout`（fixture 40_000、每用例 45_000），也不得把整轮推过门限（本 agent 实测单次 24.1s）。所有承重读数逐字保留：`toBeGreaterThanOrEqual(3)`、`expect(loginField(page)).toHaveCount(0)`、两处 `expect(await storedToken(page)).toBe(authToken)`、leg 2 的 `await expect(loginField(page)).toBeVisible`、`await expect(page.getByText(SESSION_EXPIRED_TEXT).first()).toBeVisible`、`await expect.poll(() => storedToken(page), ...).toBe(null)`。

非目标：不改任何读数；不改 `src/`、`server/` 任何产品源码（本次红的成因不在产品行为）；不改 `beforeAll` 的真登录 / 一次性账号 fixture **语义**（只改它的启动就绪等待，不改它「真建号 → 真登出 → 真登录」的步骤）；不新增 spec 文件；不改其它 spec（同窗 `oauth-consent-page.spec.ts` 的红是另一处 `Expected: 6 / Received: 7` 计数断言，机制不同，不在本轮）。

<!-- dedup-ref -->
去重（按机制，非症状）：`grep -rlE '^goal_ac: *AC-328' tasks/*.md` → **1**：`gap-ac328-leg1-self-check-read-count-cold-boot-flake`，状态 **done**（非 in-flight）——按「done 不构成 duplicate、而是先前修复没守住的证据」，立新案。无任何 `todo`/`ready`/`needs-human` 任务认领本 AC。同格先例（判据启动/预算鲁棒化，读数不动）：`gap-ac180-enter-criterion-load-flake-stabilize`、`gap-ac142-recording-evidence-load-flake`，均已 done。合并候选（`node …/dist/task-granularity-advice.js --touches e2e/session-lapse-transient.spec.ts --json`）⇒ `peers: []`、`mentions: []`，**none found**，立新案。

## AC

- [ ] AC1 红态基线逐字登记：把本轮失败工件（数据目录 `…/quay-e2e-0VjlXy/test-results/session-lapse-transient-a--5890b--does-not-sign-the-user-out/error-context.md` 的 `toBeVisible` 断言文本 + `beforeAll:258` 定位、同目录 `watchdog-state.json` 的 `fired:false/ceilingMs:55000`、以及 `…/quay-e2e-8j5Qq3/` 的第二跑同形）与本 agent 01:56 的直接重跑对照（`2 passed (24.1s)`、exit 0、`rendered into #root after 1477ms over 1 load`）写进 Notes，证明红是 fixture 的启动就绪假红、不是产品回归。
- [ ] AC2 判据在负载/冷启动下稳定跑绿（承重）：修复后连续 ≥5 次 `npx playwright test e2e/session-lapse-transient.spec.ts`（经 `scripts/with-memory-cap.sh`）全部 `exit 0`、每次 `2 passed`，逐次登记 duration 与 wall-clock，且每次远低于门限、不是被 watchdog/门限 kill 成 fail。取假形态（红态可复现）：把新加的 fixture/leg 2 就绪等待去掉（恢复成裸 `goto` + 定长 20s 可见性等待），注入实测到的那层「模块图整批判死」故障（`page.route('**/src/**', r => r.abort('connectionfailed'))`，只作用于第一次 load；诊断副本跑完即删、不进提交）⇒ 实测红在 fixture 的 `toBeVisible` 上（登记逐字红行与退出码）；同一注入 + 本改动 ⇒ 回绿。
- [ ] AC3 读数逐字未改（承重）：`grep -cF` 逐条取证——`toBeGreaterThanOrEqual(3)`、`expect(loginField(page)).toHaveCount(0)`、`expect(await storedToken(page)).toBe(authToken)`（两处）、`await expect(loginField(page)).toBeVisible`、`await expect(page.getByText(SESSION_EXPIRED_TEXT).first()).toBeVisible`、`await expect.poll(() => storedToken(page), { timeout: 10_000 }).toBe(null)` 全部逐字仍在；`git diff develop -- e2e/session-lapse-transient.spec.ts` 的改动只落在就绪等待/预算，不落在任何断言文本上。
- [ ] AC4 判据仍有鉴别力（承重，先 commit 实现再变异）：把 `src/modules/auth/context/AuthContext.tsx` 的判定改回「任意非 2xx 即 lapse」（`if (!userResponse.ok)`）⇒ leg 1 必红（登记逐字红行与退出码）；`git checkout --` 复原后重跑回绿。
- [ ] AC5 契约面：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`quay goal gate AC-328` 退出 0；`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（无未申报文件）。
- [ ] AC6 范围纪律：`git diff develop -- src/ server/` 为 0 行（不碰产品源码）。

## DoD

- 判据在宿主并发下稳定绿：≥5 次连续 `npx playwright test e2e/session-lapse-transient.spec.ts` exit 0，每次 duration 有明确余量（登记实测值）——不是只在安静机器上一次绿。
- 加固的是 fixture 与 leg 2 的启动就绪等待与预算，不是断言：两条腿与 fixture 的全部承重读数逐字未动（AC3 的 grep 取证），并已用就绪等待的红态复现（AC2）与策略回归复现（AC4）证明判据仍会因真问题而红。
- 遵守 AGENTS.md；无新依赖；测试按 `docs/operations/process-isolation-and-memory-caps.md` 单文件/有界运行，不做无界扇出。

## Touches

- e2e/session-lapse-transient.spec.ts（`beforeAll` 登录页等待与 fixture 内第二次 `goto`→`loginField` 等待、leg 2 入口等待的就绪/重载化与预算；两条腿与 fixture 读数逐字不动）
- tasks/gap-ac328-fixture-and-leg2-boot-readiness-wait.md

## Notes

### AC1 红态基线（本 agent 已直接取证，供执行者引用）

- 失败工件数据目录 `…/quay-e2e-0VjlXy/`（2026-10-14 01:54 运行）：
  - `test-results/session-lapse-transient-a--5890b--does-not-sign-the-user-out/error-context.md` 逐字 `Error: expect(locator).toBeVisible() failed / Locator: getByRole('button', { name: 'Create Account' }).or(locator('#username')).first() / Expected: visible / Timeout: 20000ms / Error: element(s) not found`，`Location: e2e/session-lapse-transient.spec.ts:314:1`，Test source 光标落在 **258 行**（`beforeAll`）。
  - `watchdog-state.json` = `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}`；`test-results/.last-run.json` `status:"failed"`。
- 第二跑同形：`…/quay-e2e-8j5Qq3/…/error-context.md` 逐字同上、watchdog 同上。
- 同 treeSha fail→pass 对照：本 agent 01:56 直接单文件重跑 ⇒ `[e2e] the app rendered into #root after 1477ms over 1 load(s) of "/"` + `2 passed (24.1s)` + `EXIT=0` ⇒ flake，不是产品回归。

### 边界与后续（不扩大本轮范围）

- 同窗 `oauth-consent-page.spec.ts` 的红是 `Expected: 6 / Received: 7` 计数断言（另一机制），不在本轮；本轮只收本 spec 的两处裸 `goto`+定长可见性等待。
- 诊断副本（`e2e/zz-ac328-*.spec.ts`）只存在于两次实测之间，跑完即删、不进任何提交；以 `git status --porcelain` 干净为证。
- 未新增依赖；所有测试均单文件、经 `scripts/with-memory-cap.sh` 有界运行，无无界扇出（遵守 AGENTS.md 与 `docs/operations/process-isolation-and-memory-caps.md`）。
