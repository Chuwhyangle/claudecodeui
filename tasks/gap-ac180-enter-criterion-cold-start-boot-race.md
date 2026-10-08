---
id: gap-ac180-enter-criterion-cold-start-boot-race
title: AC-180 的 Enter 判据冷启动即假红（三倍冷加载 + 首次导航无就绪门，报
  chrome-error://chromewebdata）：让 e2e/resident-enter-send.spec.ts
  一次付清客户端冷加载并给首屏就绪有界等待，载重读数一条不动
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-180
---
## Proposal

<!-- dedup-ref -->
机制去重读数（本轮立案时实测，2026-10-08）：`grep -rl "^goal_ac: AC-180" tasks/*.md` 命中三条——`tasks/gap-ac180-enter-criterion-load-flake-stabilize.md`、`tasks/gap-resident-enter-send-bypasses-intent-and-consent-gate.md`、`tasks/gap-resident-enter-send-spec-still-drives-retired-tick.md`，**三者均 `status: done`**，无 todo/ready/needs-human 的认领任务。`task-granularity-advice --touches e2e/resident-enter-send.spec.ts` → `peers: []`（无 open 任务声明同一文件）。⇒「AC-180 判据冷启动即假红」这一机制目前无人认领，不是重复；那三条 done 恰恰是它没守住的证据（见下）。

**现象（台账读数）。** AC-180 的判据 `npx playwright test e2e/resident-enter-send.spec.ts` 在本轮 goal-driver 的直接重跑里退出非 0：`.quay/gate-events.jsonl` 逐字 `timestamp 2026-10-08T13:15:30.305Z, item_id AC-180, actor goal-cli, verdict fail`，reason `acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of …/quay-e2e-LbhnzE/vite-cache/deps/react-scan.js… as it exceeds the max of 500KB`；`anchor.json` 的 `bundle.at = 2026-10-08T13:15:30.811Z`。而**在同一 HEAD tree**（`13a94deddc0bbc7c338f5e7da99bdc85aad0bd4d`，即 `git rev-parse HEAD^{tree}`）上，该判据 gate-events 逐条读数 **32 pass / 2 fail**（pass 段连续 15 次，12:50:58–13:13:19），且 `goal-round.jsonl` round 1730/1744–1749 的 `frozenRecheck` 逐字 `verdict=pass, outcome=cleared, cause=now-true, headSha=2fb2cbb8…, durationMs 19.6–33.7s`。⇒ 一个红点夹在同 tree 的一长串绿之间，是**负载/启动假红**，不是担保本身为假（`[[left-reverify-ac-ledger-red-can-be-a-flaky-rerun]]`）。

**红落在哪（读判据自己的工件，不读台账 reason）。** 失败运行数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-LbhnzE/`：`.last-run.json` 逐字 `{"status":"failed","failedTests":[ …2 条… ]}`；`test-results/resident-enter-send-AC-180-da07f-nd-a-resident-host-holds-it/error-context.md` 逐字 `Error: the app never reached a sign-in, onboarding or signed-in screen at chrome-error://chromewebdata/: <empty body>`，Location `e2e/resident-enter-send.spec.ts:341:1`。这条消息由 `ensureSignedIn`（`e2e/resident-enter-send.spec.ts:96-101`）抛出，调用链是 `test.beforeAll`（`:338`）→ `bootstrapAuth`（`:127`）→ `ensureSignedIn`（`:85` 的 `page.goto('/')`）。`chrome-error://chromewebdata/` 是浏览器自己的网络错误页——**首次导航根本没拿到客户端**；红**不是** (a) 的 `lifecycle_mode=resident` 读数，也**不是** (b) 的 `per-run` 正控制。

**根因（初判；worker 先复现再定论）。** `ensureSignedIn`（`:84-94`）对首次导航只做 3 次 `page.goto('/').catch(() => undefined)` + 15s 等就绪：`goto` 的网络错误被吞掉，一旦落到错误页就对着错误页空等 15s，3 轮 ≈45s 直接吃掉 `beforeAll` 的预算，而 `playwright.config.ts` 的 run watchdog 只有 55s、gate 只有 60s（spec `:328-332` 自述这两个 ceilings）。客户端在冷启动时于 Vite **依赖预打包重启**窗口内会短暂不可达——该次失败运行自己的 stderr 就打印了 `react-scan.js` 被 deoptimise 的 Vite `[BABEL]` note——首次导航撞上这个窗口即红。此外本文件把客户端冷加载**付了三次**：`bootstrapAuth` 自建一个 context（`:125-129`），两个用例各自还有 test-scoped 的 `page`/context；AC-171 的姊妹文件刚用「整文件共享一个 context、冷加载只付一次」治好同类问题（`0f554342`），但那是文件内的修复，**没到本文件**。

**为什么上一版修复不再成立（不是回归）。** `gap-ac180-enter-criterion-load-flake-stabilize`（done）只把 **(b) 腿** `openComposer` 的 `projectRow` 固定 5s 预算改成 `PROJECT_ROW_READY_MS` 20s 有界等待；今天的红在它**上游**——`beforeAll` 的 bootstrap/onboarding 首次导航，那处它没碰。设计面的两条 done（`gap-resident-enter-send-bypasses-intent-and-consent-gate`、`gap-resident-enter-send-spec-still-drives-retired-tick`）今天仍正确：Enter 分支仍只 `event.currentTarget.form?.requestSubmit()`，提交仍统一落到 ChatComposer 的 `handleComposerSubmit`。⇒ 本条措辞是「让判据**稳定**跑绿」，不是「把坏掉的东西修好」。

**要建的东西（最小充分集）。** 让 `e2e/resident-enter-send.spec.ts` 的冷启动**有界且只付一次**：(1) 整文件共享一个 context（在 `beforeAll` 建、`afterAll` 关，`page` fixture override 转发），客户端冷加载只付一次——照搬姊妹文件 `0f554342` 的成熟做法；(2) 首次导航前加一个有界就绪门（轮询本 run 的客户端 URL `QUAY_E2E_CLIENT_PORT`；把 `chrome-error://` 错误页与「只是慢」区分开，在预算内重试；真的加载不上时**命名 URL 与原因**，而不是只报 `<empty body>`），预算须低于 55s watchdog；(3) **载重读数一条不动**。

**非目标。** 不改常驻运行时行为；不弱化 (a) 的 `lifecycle_mode === 'resident'` + 真宿主持有读数，也不弱化 (b) 的 `per-run` 正控制；不动 `e2e/resident-enable-consent.spec.ts`（AC-171）与 `playwright.config.ts`；不在本条内加并发压测（`[[defer-load-problems-do-not-stress-test-inline]]`）。

## Plan

1. **红态复现与定位（先做）**：静默态连跑 3 次，登记每次 `duration` 与读数；读失败运行自己的 `error-context.md`/`.last-run.json`，确认红在 `beforeAll`→`bootstrapAuth`→`ensureSignedIn` 的首次导航，而不是载重断言。
2. **冷加载只付一次**：把整文件改为一个共享 context（`beforeAll` 建 / `afterAll` 关、`page` fixture override 转发、`bootstrapAuth` 收 page），与 `e2e/resident-enable-consent.spec.ts` 的 `0f554342` 同形。
3. **首次导航有界就绪门**：`ensureSignedIn` 的 `goto` 不再吞掉网络错误；加客户端 URL 轮询/就绪等待，把 `chrome-error://` 视为可重试、在单一有界预算内恢复；失败时错误串带上 URL 与状态。
4. **载重读数逐字保留**：(a) 的 `toBe('resident')` + `waitForHost`/`heldByResidentHost`；(b) 的 `toBe('per-run')`。
5. **跑绿**：连续 3 次 exit 0，登记 `duration`（须有明显余量，判据自己读完收尾、不是被 watchdog kill）。
6. **假形态承重**：提交后把 `handleSubmit` 内的常驻意图写入禁用（`useChatComposerState.ts` ~:1044 的 `if (residentEnabled)` 改为 `if (false && residentEnabled)`），(a) 必须红；恢复后复绿。先提交再变异、跑完恢复（`[[uncommitted-worker-implementation-wiped-by-checkout-restore]]`）。
7. **契约面**：`npm run lint`、`npm run typecheck` 绿；`git diff --name-only $(git merge-base develop HEAD) HEAD` 落在 Touches 内。

## AC

- [x] AC1 判据绿且稳定：连续 3 次 `npx playwright test e2e/resident-enter-send.spec.ts` 均 exit 0，逐次登记 `duration` 与读数。红态基线：`2026-10-08T13:15:30.305Z` 该判据 exit 1（gate-events 逐字 `verdict fail`）。
- [x] AC2 红已定位到冷启动 bootstrap，而非载重断言：在 `## Evidence` 逐字登记失败运行自己的工件（`test-results/*/error-context.md` 的 `chrome-error://chromewebdata/: <empty body>` 与 `.last-run.json`），证明消息出自 `ensureSignedIn`（`:96-101`）经 `beforeAll`（`:338`）。
- [x] AC3 冷加载只付一次（承重）：`grep -nE "base\.extend<\{ page: Page \}>|sharedPage" e2e/resident-enter-send.spec.ts` 命中 ≥ **1**（`page` fixture 被 override 到一个共享 page），且 `grep -cE "browser\.newContext\(\)" e2e/resident-enter-send.spec.ts` ≤ **1**（本文件自建 context 至多一处）。
- [x] AC4 首次导航有界就绪（承重）：`grep -nE "QUAY_E2E_CLIENT_PORT|clientBaseURL|waitForClient" e2e/resident-enter-send.spec.ts` 命中 ≥ **1**——首次导航前对本 run 客户端 URL 的有界就绪等待存在。
- [x] AC5 载重读数不弱化（承重）：`grep -cE "toBe\('resident'\)|toBe\('per-run'\)" e2e/resident-enter-send.spec.ts` ≥ **2**；`grep -nE "waitForHost|heldByResidentHost" e2e/resident-enter-send.spec.ts` 命中 ≥ **1**。
- [x] AC6 假形态必须红（承重）：禁用 `handleSubmit` 内的常驻意图写入（`src/modules/chat/hooks/useChatComposerState.ts` ~:1044 的 `if (residentEnabled)` 改为 `if (false && residentEnabled)`）⇒ (a) 腿非 **0**，红落在 resident 读数上（`Expected "resident"` / `Received "per-run"`）；登记变异 diff、失败断言逐字与退出码，恢复后复绿。（人工裁定 2026-10-08 option (i)：原措辞「Enter 分支直调 `handleSubmit`」因祖提交 `gap-resident-toggle-relocate-drop-consent-gate` 已不承重，改述为本形态；正控制实测 exit=1、红在 `e2e/resident-enter-send.spec.ts:464`，见 Evidence。）
- [x] AC7 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内。

## DoD

- 判据的冷启动在装载状态下**不再以启动竞态假红**：3 次孤立绿每次有明显余量，且首次导航有界就绪、客户端冷加载只付一次；判据是自己读完收尾，不是被 55s watchdog / 60s gate kill 成 fail（真正的判官是 driver 下一轮 `frozenRecheck` 在 lane 负载下的读数）。
- 载重读数（(a) 的 resident + 真宿主；(b) 的 per-run 正控制）与今天逐字相同——加固的是启动与就绪，不是断言。
- 假形态真的跑过、真的红，红落在 (a) 的 resident 读数上：禁用 `handleSubmit` 内的常驻意图写入（`if (false && residentEnabled)`）⇒ (a) 红（`Expected "resident"` / `Received "per-run"`，`:464`），恢复后复绿（人工裁定 option (i)，见 Evidence）。
- 只动 `## Touches` 列出的文件；若触及 `src/`（预计不触及）则遵守 `$frontend-module-standards`。

## Touches

- `e2e/resident-enter-send.spec.ts`
- `tasks/gap-ac180-enter-criterion-cold-start-boot-race.md`（自触）

## Evidence

### 红态基线（立案时台账读数，逐字）
- `.quay/gate-events.jsonl` 逐字：`{"item_id":"AC-180","gate":"goal","actor":"goal-cli","verdict":"fail","timestamp":"2026-10-08T13:15:30.305Z","payload":{"reason":"acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-LbhnzE/vite-cache/deps/react-scan.js?v=81dbb5f5 as it exceeds the max of 500KB.","treeSha":"13a94deddc0bbc7c338f5e7da99bdc85aad0bd4d"}}`

### AC2 —— 红定位到冷启动 bootstrap（逐字工作件）
- `~/.cache/quay-e2e-tmp/quay-e2e-LbhnzE/test-results/resident-enter-send-AC-180-da07f-nd-a-resident-host-holds-it/error-context.md` 逐字：
  - `- Name: resident-enter-send.spec.ts >> AC-180 (a): Enter with the resident switch on allocates a resident session, and a resident host holds it`
  - `- Location: e2e/resident-enter-send.spec.ts:341:1`
  - 错误详情逐字：`Error: the app never reached a sign-in, onboarding or signed-in screen at chrome-error://chromewebdata/: <empty body>`
- 该消息出自 `ensureSignedIn`（改前 `:96-101`），调用链 `test.beforeAll`（改前 `:338`）→ `bootstrapAuth`（改前 `:127`）→ `ensureSignedIn`（改前 `:85` 的 `page.goto('/')`）。`chrome-error://chromewebdata/` 是浏览器自己的网络错误页，证明首次导航没拿到客户端，不是 (a)/(b) 的载重读数。

### 绿态（实现提交 `6fdafa12`，本 worktree 同一 HEAD，孤立静默态）
- 4 次 `npx playwright test e2e/resident-enter-send.spec.ts` 均 exit 0：`duration` = 17.4s / 17.7s / 17.6s / 16.9s，全部 `2 passed`。
- 读数逐字保留：(a) `session.lifecycle_mode=resident` + `host.resident.bindsSession=true`；(b) `control.lifecycle_mode=per-run`。
- 余量：~17s 对 `playwright.config.ts` 的 55s run watchdog 有 ~37s 余量；判据自己读完收尾，未被 watchdog/gate kill。

### AC3/AC4/AC5 读数（逐字 grep，实现后）
- AC3：`grep -cE "base\.extend<\{ page: Page \}>|sharedPage"` = **7**（含 `const test = base.extend<{ page: Page }>({` 与共享 `sharedPage`）；`grep -cE "browser\.newContext\(\)"` = **1**（仅注释中一处字面，本文件无真实自建 context）。
- AC4：`grep -cE "QUAY_E2E_CLIENT_PORT|clientBaseURL|waitForClient"` = **9**（`clientBaseURL()` + `waitForClient()` 首次导航就绪门）。
- AC5：`grep -cE "toBe\('resident'\)|toBe\('per-run'\)"` = **2**；`grep -cE "waitForHost|heldByResidentHost"` = **4**（`:315` 定义、`:466/468/471` 调用）。

### AC6 —— 原命名假形态实证不红；改述后的假形态（正控制）实证红
实现提交 `6fdafa12` 后，按 Plan step 6 原取假形态：把 `src/modules/chat/hooks/useChatComposerState.ts` 的 Enter 分支 `event.currentTarget.form?.requestSubmit()` 换成直调 `handleSubmit(event)`（即祖任务记录的「退休形态」）。**跑绿**：`exit=0`、`2 passed`、`session.lifecycle_mode=resident`、`host.resident.bindsSession=true` —— (a) 腿非 0 未成立，红未落在 resident 读数上。该形态已记录为过时。

机制：原 AC6 假定「Enter 路由到表单」是 (a) 的 resident 读数的承重路径。该假定在祖提交 `gap-resident-toggle-relocate-drop-consent-gate`（退休知情门控）之后已失效——常驻意图的记录已从 `ChatComposer.handleComposerSubmit` 移入 hook 自己的 `handleSubmit`（`useChatComposerState.ts:1044` 的 `if (residentEnabled)`）。Enter 分支直调的还是同一个 `handleSubmit`，故记录照旧发生，(a) 不红（`[[dod-mandated-falsification-form-can-be-invalidated-by-ancestor-commits]]`）。

**敏感性正控制（现为 AC6 的假形态）**：把 `handleSubmit` 内的 `if (residentEnabled)` 改成 `if (false && residentEnabled)` ⇒ `exit=1`、`1 failed`，红逐字落在 (a)：
```
  ✘  1 e2e/resident-enter-send.spec.ts:445:1 › AC-180 (a): Enter with the resident switch on allocates a resident session, and a resident host holds it
    Expected: "resident"
    Received: "per-run"
    > 464 |   ).toBe('resident');
```
⇒ 判据对 resident 读数敏感。两处变体均已 `git checkout --` 恢复，恢复后 `git status --porcelain` 为空。

### AC7 契约面
- `npm run lint` exit **0**（仅存量 warning）。
- `npm run typecheck` exit **0**（tsc 三份 project 全过）。
- `git diff --name-only $(git merge-base develop HEAD) HEAD` = `e2e/resident-enter-send.spec.ts`，落在 Touches 内。

### 人工裁定
Human adjudication 2026-10-08: option (i) — AC6 与对应 DoD 条的假形态重述为「禁用 `handleSubmit` 内的 resident 意图写入 ⇒ (a) 腿红在 resident 读数上」；上述正控制即该形态的实测（exit=1，红在 `:464`），认定判据承重面已验证。
