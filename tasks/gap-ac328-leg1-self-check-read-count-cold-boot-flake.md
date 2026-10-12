---
id: gap-ac328-leg1-self-check-read-count-cold-boot-flake
title: "AC-328 判据在负载下假红：leg 1 的 `userReads >= 3` 15s 谓词在冷启动窗口内超时（Received: 0）⇒
  让应用启动就绪等待与预算鲁棒，两条腿读数一条不动"
status: done
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

现状（直接测量，2026-10-12，本仓 develop tip）：AC-328 的判据 `npx playwright test e2e/session-lapse-transient.spec.ts` 在宿主并发/冷启动下**非确定性** exit 1，而**不是**产品策略回归——判据自身与其依赖的源码自 `7867d962`（该 spec 的创建提交）起一字未改（`git log --oneline develop -- e2e/session-lapse-transient.spec.ts` 只有它一条），且本轮三连绿（19.0s / 19.1s / 19.3s，`exit 0`、每次 `2 passed`）。

红态逐字（取自 driver 重跑留下的失败工件，非转述）：GateEvent `2026-10-12T05:44:56.338Z` `verdict: fail`（treeSha `cd1ca9e5ebab`），该次运行数据目录 `…/quay-e2e-rs7AQX/test-results/session-lapse-transient-a--5890b--does-not-sign-the-user-out/error-context.md` 逐字：

```
- Name: session-lapse-transient.spec.ts >> a gateway 502 on the user read does not sign the user out
- Location: e2e/session-lapse-transient.spec.ts:165:1
Error: expect(received).toBeGreaterThanOrEqual(expected)
Expected: >= 3
Received:    0
Call Log:
- Timeout 15000ms exceeded while waiting on the predicate
```

`Received: 0`（不是 1 或 2）说明 `page.route('**/api/auth/user')` 在 15s 内**一次都没被调用**：StrictMode 双调用至少会给出 2，只有「应用在 15s 内根本没启动到发出这次读」才会是 0。也就是说腿 1 的承重读数（「同一自检已读到 ≥3 次」）在**它自己都还没被发出**之前就到期了。

同一 treeSha 的 fail→pass 对照证明这是 flake 而非确定性缺陷：`2026-10-12T03:35:23.045Z` fail（treeSha `b9f7628c5b5a`）→ `03:36:58.310Z` pass（**同** treeSha `b9f7628c5b5a`）。

机制：leg 1（`e2e/session-lapse-transient.spec.ts:165`）在 `await page.goto('/')` 之后立刻 `await expect.poll(() => userReads, { timeout: 15_000 }).toBeGreaterThanOrEqual(3)`。`goto` 默认等 `load`，而本 SPA 的模块图（main.tsx → React）是 ES module、由 Vite 按需 transform——`load` 之后应用仍可能尚未挂载。宿主并发、或 Vite 对依赖做重优化（`browserHash` 变化 ⇒ 依赖 URL 全换、重新预打包）时，这一窗口可以超过 15s，于是谓词先于应用启动到期，读数为 0。`beforeAll` 的预热导航跑在它**自己的 context** 里（第 104 行 `browser.newContext()`，末尾 `context.close()`），两条腿却在默认 `page` fixture 的全新 context 中运行（浏览器 HTTP 缓存为空），所以那次预热只暖了 Vite 的**服务端** transform 缓存，暖不了腿启动时这一段窗口。

修法方向（**只加固应用启动的就绪等待与预算，读数一条不动**）：把 leg 1 的「读计数」断言建立在「应用确已启动」的可观测就绪信号之上，而不是一个与冷启动赛跑的定长 15s——例如先等应用挂载/进入它在该故障下的可观测态，再把计数等待的上限从该 spec 已有的每用例预算（`test.describe.configure({ timeout: 45_000 })`，第 59 行）派生，而非硬编码 15s。承重读数 `userReads >= 3`、`expect(loginField(page)).toHaveCount(0)`、两处 `expect(await storedToken(page)).toBe(authToken)`、以及 leg 2 的全部断言**逐字保留**。预期只改这一个判据文件（与同格先例 `gap-ac142-recording-evidence-load-flake` 的修法形态一致）。

非目标：不改任何读数；不改 `src/`、`server/` 任何产品源码（本次红的成因不在产品行为）；不改 `beforeAll` 的真登录 / 一次性账号 fixture 语义；不新增 spec 文件；不改其它 spec。

<!-- dedup-ref -->
去重（按机制，非症状）：`grep -rlE '^goal_ac: *AC-328' tasks/*.md` → **0**（无认领任务）。提及本 spec 的 3 条任务（`gap-session-lapse-only-on-server-401`、`gap-client-clock-cannot-expire-the-session`、`gap-goal-037-e2e-evidence-ac`）**全部 done**，产出（策略实现、e2e 产物、goal 级 AC 立案）均已落地——本轮不是「修复没守住」（策略逐字正确、三连绿），而是判据自身的启动就绪在负载下假红，机制不同，按「done 不构成 duplicate」立新案。同格先例（判据启动/预算鲁棒化，读数不动）：`gap-ac180-enter-criterion-load-flake-stabilize`（AC-180）、`gap-ac142-recording-evidence-load-flake`（AC-142，其红态签名 `Received: 0 / Timeout 15000ms exceeded` 与本案逐字同形）；二者均已 done，本案例的是它们未覆盖的第三个 spec。merge 候选：`task-granularity-advice.js --touches e2e/session-lapse-transient.spec.ts --json` → `peers: []`（none found）。

## AC

- [x] AC1 红态基线逐字登记：把 driver 重跑留下的失败工件（GateEvent `2026-10-12T05:44:56.338Z` fail + 其 `test-results/…/error-context.md` 的断言文本）与同 treeSha fail→pass 对照（`03:35:23` fail `b9f7628c5b5a` → `03:36:58` pass 同 treeSha）写进 Notes，证明红是 `userReads` 计数的启动就绪假红、不是产品回归。
- [x] AC2 判据在负载/冷启动下稳定跑绿（承重）：修复后连续 ≥5 次 `npx playwright test e2e/session-lapse-transient.spec.ts` 全部 `exit 0`、每次 `2 passed`，逐次登记 duration 与 wall-clock，且每次远低于 60s 门限、不是被 watchdog/门限 kill 成 fail。取假形态（红态可复现）：把新加的「应用确已启动」就绪等待去掉（或恢复成一个与启动赛跑的定长等待）⇒ 在冷启动/宿主并发下一次实测红在 `userReads` 谓词上（登记该红跑输出与退出码），证明加固真的作用在这个就绪等待上。
- [x] AC3 读数逐字未改（承重）：`grep -nF` 逐条取证——`toBeGreaterThanOrEqual(3)`、`expect(loginField(page)).toHaveCount(0)`、`expect(await storedToken(page)).toBe(authToken)`（两处）、leg 2 的 `await expect(loginField(page)).toBeVisible`、`await expect(page.getByText(SESSION_EXPIRED_TEXT).first()).toBeVisible`、`await expect.poll(() => storedToken(page), …).toBe(null)` 全部逐字仍在；`git diff develop -- e2e/session-lapse-transient.spec.ts` 的改动只落在就绪等待/预算，不落在任何断言文本上。
- [x] AC4 判据仍有鉴别力（承重，先 commit 实现再变异）：把 `src/modules/auth/context/AuthContext.tsx` 的判定改回「任意非 2xx 即 lapse」（`if (!userResponse.ok)`）⇒ leg 1 必红（登记逐字红行与退出码）；恢复后重跑回绿。
- [x] AC5 契约面：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`quay goal gate AC-328` 退出 0；`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（无未申报文件）。
- [x] AC6 范围纪律：`git diff develop -- src/ server/` 为 0 行（不碰产品源码）。

## DoD

- 判据在宿主并发下稳定绿：≥5 次连续 `npx playwright test e2e/session-lapse-transient.spec.ts` exit 0，每次 duration 有明确余量（登记实测值）——不是只在安静机器上一次绿。
- 加固的是启动就绪等待与预算，不是断言：`userReads >= 3` 与两条腿全部读数逐字未动（AC3 的 grep 取证），并已用就绪等待的红态复现（AC2）与策略回归复现（AC4）证明判据仍会因真问题而红。
- 遵守 AGENTS.md；无新依赖；测试按 `docs/operations/process-isolation-and-memory-caps.md` 单文件/有界运行，不做无界扇出。

## Touches

- e2e/session-lapse-transient.spec.ts（leg 1 的应用启动就绪等待与从每用例预算派生的等待上限；两条腿读数逐字不动）
- tasks/gap-ac328-leg1-self-check-read-count-cold-boot-flake.md

## Notes

### AC1 红态基线逐字登记（+ 本轮对同一工件的直接新取证）

- GateEvent `2026-10-12T05:44:56.338Z` `verdict: fail`（treeSha `cd1ca9e5ebab`），其数据目录 `…/quay-e2e-rs7AQX/test-results/session-lapse-transient-a--5890b--does-not-sign-the-user-out/error-context.md` 逐字：

```
Error: expect(received).toBeGreaterThanOrEqual(expected)

Expected: >= 3
Received:    0

Call Log:
- Timeout 15000ms exceeded while waiting on the predicate
```

- 同 treeSha fail→pass 对照：`2026-10-12T03:35:23.045Z` fail（treeSha `b9f7628c5b5a`）→ `03:36:58.310Z` pass（**同** treeSha `b9f7628c5b5a`）⇒ flake，不是确定性缺陷。
- 本轮直接读同一失败工件的 `trace.zip`（新取证，非转述，用来把机制定到层）：该次 leg 1 的 `frame-snapshot` 在谓词到期时是 `<div id="root"></div>`（**空**）；console 有 118 条 `Failed to load resource: net::ERR_NETWORK_CHANGED`，每条对应一个模块 URL（`/src/modules/sidebar/SessionBranchBadge.tsx`、`/@fs/…/vite-cache/deps/chunk-*.js?v=5731b542` …），发生在 goto 起约 420ms；HAR 侧 547 条资源里同样有 118 条 `_failureText: net::ERR_NETWORK_CHANGED`，且失败项与成功项的 `browserHash` 同为 `v=5731b542`（**不是** 二次预打包换 URL）。⇒ 文档 `load` 了，但应用**从未挂载**（`main.tsx` 未执行），0 次读是「应用没起来」而不是「策略把会话清了」。红 = 启动就绪假红，不是产品回归；机制落在「模块图整批被判死」这一层（比「单纯慢」更硬），所以修法必须既能等、又能重载。

### AC2 承重：负载/冷启动下稳定绿 + 假形态可复现红

连续 5 次未改判据的单文件运行（每次都是全新 browser context ⇒ 每次都是冷启动；命令 `bash scripts/with-memory-cap.sh npx playwright test e2e/session-lapse-transient.spec.ts`，worktree 内）：

| # | exit | playwright | wall-clock | 就绪读数（应用挂载） |
|---|------|------------|-----------|----------------------|
| 1 | 0 | `2 passed (17.0s)` | 17.8s | `rendered into #root after 1459ms over 1 load` |
| 2 | 0 | `2 passed (16.7s)` | 17.5s | 1356ms / 1 load |
| 3 | 0 | `2 passed (17.2s)` | 17.9s | 1458ms / 1 load |
| 4 | 0 | `2 passed (16.9s)` | 17.7s | 1320ms / 1 load |
| 5 | 0 | `2 passed (16.5s)` | 17.4s | 1306ms / 1 load |

五次全部 `exit 0`、每次 `2 passed`，整轮 16.5–17.2s（wall 17.4–17.9s），远低于 60s 门限，不是被 watchdog/门限 kill 成的 fail；判据链自带的两测 `quay goal gate AC-328` 也是 18.0s / 17.3s、exit 0。

假形态（红态**确定性**可复现）：把新加的就绪等待去掉、恢复成原来那条与启动赛跑的定长等待，并把实测到的那一层故障按原样注入（`page.route('**/src/**', r => r.abort('connectionfailed'))`，只作用于第一次 load；诊断副本 `e2e/zz-ac328-induction-racing.spec.ts`，跑完即删、未进提交）：

```
  ✘  1 e2e/zz-ac328-induction-racing.spec.ts:314:1 › a gateway 502 on the user read does not sign the user out (15.0s)
  -  2 e2e/zz-ac328-induction-racing.spec.ts:356:1 › a credential the server rejects falls through to the login page with the banner

    Error: expect(received).toBeGreaterThanOrEqual(expected)

    Expected: >= 3
    Received:    0

    Call Log:
    - Timeout 15000ms exceeded while waiting on the predicate

  1 failed
  1 did not run
EXIT=1
```

与 AC1 的 gate 工件逐字同形（含 leg 2 因 `mode: 'serial'` 而 `did not run`）。

同一注入故障 + 本改动（诊断副本 `e2e/zz-ac328-induction-fixed.spec.ts`）⇒ 恢复绿：

```
[e2e] no render into #root after load 1 of "/"; loading "/" again
[e2e] the app rendered into #root after 9197ms over 2 load(s) of "/" (2 **/api/auth/user read(s) so far)
  ✓  1 … a gateway 502 on the user read does not sign the user out (11.5s)
  ✓  2 … a credential the server rejects falls through to the login page with the banner (1.5s)
  2 passed (24.8s)
EXIT=0
```

⇒ 加固确实作用在这个就绪等待上：同一故障，去掉就红（`Received: 0`）、装上就绿（第 2 次 load 恢复）。

### AC3 读数逐字未改（worktree 内 `e2e/session-lapse-transient.spec.ts`，`grep -cF` 逐条）

| 逐字串 | 计数 |
|---|---|
| `toBeGreaterThanOrEqual(3)` | 1 |
| `expect(loginField(page)).toHaveCount(0)` | 1 |
| `expect(await storedToken(page)).toBe(authToken)` | 2 |
| `await expect(loginField(page)).toBeVisible` | 2（`beforeAll` + leg 2） |
| `await expect(page.getByText(SESSION_EXPIRED_TEXT).first()).toBeVisible` | 1 |
| `await expect.poll(() => storedToken(page), { timeout: 10_000 }).toBe(null)` | 1 |

改动面（`git diff develop...HEAD` 去掉注释行后的**全部**代码行）：新增 5 个预算/信号常量（`CASE_BUDGET_MS`/`APP_START_BUDGET_MS`/`APP_START_ATTEMPT_MS`/`READ_COUNT_BUDGET_MS`/`APP_ROOT_RENDERED`）、`appears` 与 `loadApp` 两个 helper、`test.describe.configure` 的 `45_000` → `CASE_BUDGET_MS`（**同值**）、leg 1 的 `await page.goto('/')` → `await loadApp(page, () => userReads)`、以及那一条 poll 的选项（`timeout: READ_COUNT_BUDGET_MS` + `message`）。`git diff develop...HEAD | grep '^+' | grep 'expect('` ⇒ **1 行**（就是 poll 的开括号行；`toBeGreaterThanOrEqual(3)` 在 diff 里是未变的上下文行）。leg 2 一行未动。

### AC4 判据仍有鉴别力（先 commit 实现 `01d5644d`，再变异）

把 `src/modules/auth/context/AuthContext.tsx:339` 的 `if (userResponse.status === 401)` 改回「任意非 2xx 即 lapse」（`if (!userResponse.ok)`）⇒ leg 1 必红，逐字：

```
[e2e] the app rendered into #root after 1312ms over 1 load(s) of "/" (2 **/api/auth/user read(s) so far)
  ✘  1 e2e/session-lapse-transient.spec.ts:314:1 › a gateway 502 on the user read does not sign the user out (6.2s)

    Error: the app was on screen, but the startup self-check made only this many **/api/auth/user reads
    Expected: >= 3
    Received:    2

  1 failed
  1 did not run
EXIT=1
```

（`Received: 2` = StrictMode 双调用；变异下第一个 502 即判 lapse 清 token ⇒ 第三次读永不发出。注意就绪读数仍是 1.3s/1 load：红发生在**计数**上，不在就绪上——这正是加固没有把鉴别力吃掉的样子。）`git checkout -- src/modules/auth/context/AuthContext.tsx` 复原后重跑 ⇒ `✓ 1 (3.8s) ✓ 2 (1.5s) 2 passed (17.2s)`、`EXIT=0`。

### AC5 契约面

- `npm run typecheck` ⇒ `EXIT=0`（三份 tsconfig；worktree 内；合并 develop 后复跑仍 `EXIT=0`）。
- `npm run lint` ⇒ `EXIT=0`，`: error ` 计数 **0**（`: warning ` 242 行，全为既有告警，本改动未引入新行）。
- `cd <worktree> && quay goal gate AC-328` ⇒ `verdict: pass`、exit 0、18.0s（合并前，`evaluationRoot` = 本 worktree、treeSha `c2675dee…`）；合并 develop 后复跑 ⇒ `verdict: pass`、exit 0、17.3s（treeSha `87952a9f…`）。
- `git diff --name-status develop...HEAD` ⇒ **只有** `M e2e/session-lapse-transient.spec.ts`，与 `## Touches` 第 1 条逐条对齐、无未申报文件；第 2 条（本任务文件）由 `task_write` 自己提交在 store 分支，不在本分支 diff 里。

### AC6 范围纪律

`git diff develop -- src/ server/ | wc -l` ⇒ **0**（AC4 的临时变异已 `git checkout --` 复原；`git status --porcelain` 干净）。

### 边界与后续（不扩大本轮范围）

- leg 2 的入口等待（`goto` + `loginField` 20s 可见性）**未动**：本条 AC 的修法方向与 `## Touches` 只点名 leg 1 的读计数谓词，leg 2 的断言按 AC3 逐字保留。同一「模块图整批死」的故障在 leg 2 上也会红（它的 `goto` 之后是可见性等待，没有计数谓词可分辨），这属于**另一个**判据面；本轮不顺手扩面，登记在此供后续按需立案。
- 诊断副本（`e2e/zz-ac328-induction-*.spec.ts`）只存在于两次实测之间，已删除，未进任何提交；`git status --porcelain` 干净可证。
- 未新增依赖；所有测试均单文件、经 `scripts/with-memory-cap.sh` 有界运行，无无界扇出（遵守 AGENTS.md 与 `docs/operations/process-isolation-and-memory-caps.md`）。
