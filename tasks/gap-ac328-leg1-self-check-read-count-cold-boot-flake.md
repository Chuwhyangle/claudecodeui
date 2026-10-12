---
id: gap-ac328-leg1-self-check-read-count-cold-boot-flake
title: "AC-328 判据在负载下假红：leg 1 的 `userReads >= 3` 15s 谓词在冷启动窗口内超时（Received: 0）⇒
  让应用启动就绪等待与预算鲁棒，两条腿读数一条不动"
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

- [ ] AC1 红态基线逐字登记：把 driver 重跑留下的失败工件（GateEvent `2026-10-12T05:44:56.338Z` fail + 其 `test-results/…/error-context.md` 的断言文本）与同 treeSha fail→pass 对照（`03:35:23` fail `b9f7628c5b5a` → `03:36:58` pass 同 treeSha）写进 Notes，证明红是 `userReads` 计数的启动就绪假红、不是产品回归。
- [ ] AC2 判据在负载/冷启动下稳定跑绿（承重）：修复后连续 ≥5 次 `npx playwright test e2e/session-lapse-transient.spec.ts` 全部 `exit 0`、每次 `2 passed`，逐次登记 duration 与 wall-clock，且每次远低于 60s 门限、不是被 watchdog/门限 kill 成 fail。取假形态（红态可复现）：把新加的「应用确已启动」就绪等待去掉（或恢复成一个与启动赛跑的定长等待）⇒ 在冷启动/宿主并发下一次实测红在 `userReads` 谓词上（登记该红跑输出与退出码），证明加固真的作用在这个就绪等待上。
- [ ] AC3 读数逐字未改（承重）：`grep -nF` 逐条取证——`toBeGreaterThanOrEqual(3)`、`expect(loginField(page)).toHaveCount(0)`、`expect(await storedToken(page)).toBe(authToken)`（两处）、leg 2 的 `await expect(loginField(page)).toBeVisible`、`await expect(page.getByText(SESSION_EXPIRED_TEXT).first()).toBeVisible`、`await expect.poll(() => storedToken(page), …).toBe(null)` 全部逐字仍在；`git diff develop -- e2e/session-lapse-transient.spec.ts` 的改动只落在就绪等待/预算，不落在任何断言文本上。
- [ ] AC4 判据仍有鉴别力（承重，先 commit 实现再变异）：把 `src/modules/auth/context/AuthContext.tsx` 的判定改回「任意非 2xx 即 lapse」（`if (!userResponse.ok)`）⇒ leg 1 必红（登记逐字红行与退出码）；恢复后重跑回绿。
- [ ] AC5 契约面：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`quay goal gate AC-328` 退出 0；`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（无未申报文件）。
- [ ] AC6 范围纪律：`git diff develop -- src/ server/` 为 0 行（不碰产品源码）。

## DoD

- 判据在宿主并发下稳定绿：≥5 次连续 `npx playwright test e2e/session-lapse-transient.spec.ts` exit 0，每次 duration 有明确余量（登记实测值）——不是只在安静机器上一次绿。
- 加固的是启动就绪等待与预算，不是断言：`userReads >= 3` 与两条腿全部读数逐字未动（AC3 的 grep 取证），并已用就绪等待的红态复现（AC2）与策略回归复现（AC4）证明判据仍会因真问题而红。
- 遵守 AGENTS.md；无新依赖；测试按 `docs/operations/process-isolation-and-memory-caps.md` 单文件/有界运行，不做无界扇出。

## Touches

- e2e/session-lapse-transient.spec.ts（leg 1 的应用启动就绪等待与从每用例预算派生的等待上限；两条腿读数逐字不动）
- tasks/gap-ac328-leg1-self-check-read-count-cold-boot-flake.md
