---
id: gap-ac188-case-bootstrap-collision-and-gate-kill
title: AC-188 判据在 gate 上仍转红：夹具账号在单用户服务端上抢占（整文件必红）+ setup 无重试且负载下整次调用撞 goal gate 60s 击杀
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-188
---
---
id: gap-ac188-case-bootstrap-collision-and-gate-kill
title: AC-188 判据在 gate 上仍转红：夹具账号在单用户服务端上抢占（整文件必红）+ setup 无重试且负载下整次调用撞 goal gate 60s 击杀
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-188
---
## Proposal

**现象：AC-188 判据在校验账本里持续转红，但直接重跑是绿的 —— 红是两个不同机制叠出来的**

`GOAL-014` 的 `AC-188`（`criterion: npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"`）在 gate 账本 `.quay/gate-events.jsonl`（`pipeline_id=AC-188`, `gate=goal`）里累计 **550 pass / 541 fail**。只看 2026-10-08T00:00Z 之后：55 条事件；上一件修复 `2b774f6d`（2026-10-08T16:48Z）之后是 **14 pass / 2 fail**，两红在 17:47:22Z（tree `951bda5e`）与 17:54:11Z（tree `b619c84d`，== 本轮立案时 HEAD `7b2043af` 的 tree）。同一个 spec 里的兄弟判据稳定得多：AC-184 54 事件 1 fail、AC-185 13 事件 0 fail、AC-187 13 事件 0 fail —— 只有 AC-188 在翻。

账本里 AC-188 的 `reason` 全被截断到 WebServer 的 stderr（`[BABEL] … exceeds the max of 500KB`、`[DEP0190]`），读不出失败落点。所以本轮不依赖 reason 尾巴，而是：① 直接重跑判据；② 从驱动留下的失败现场（`/data/home/yale/.cache/quay-e2e-tmp/*/test-results/*/error-context.md`）里读逐字断言。

**直接重跑（立案前；HEAD `7b2043af`，tree `b619c84d`；`e2e/activity-dock-truthful.spec.ts` 与 `playwright.config.ts` 均 clean；立案时 load1≈41）**

- `bash scripts/with-memory-cap.sh npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` —— **连续 5 次 exit 0**。起始 load1 46.51 / 31.75 / 25.17 / 19.70 / 20.88；case body（`dock.wall`）17416 / 17406 / 17389 / 17562 / 19114 ms；整次调用 31.9 / 27.6 / 27.5 / 28.0 / 45.2 s。读数全部正确（desktop+mobile `dock.count=1`、`legacy.tab=0`、`legacy.inline=0`、`resident.activityMarkers=[]`、`consistency.turn={"dock":"in-turn","sidebar":true,"send":"stop"}`、`consistency.afterTurnLive` 由 `in-turn`→`absent`、`consistency.afterTurn` 三条全 `{"dock":"absent","sidebar":false,"send":"send"}`）。日志 `/tmp/ac188-refile-1..5.log`。
- `npx playwright test e2e/activity-dock-truthful.spec.ts`（**不加 `-g`，跑整个文件**）—— **exit 1，稳定复现的红**：测试 1–3（AC-184、AC-185、单 spec 天花板）通过，测试 4（AC-188，describe `activity dock consolidation`，用例起点 `:1236`）红，逐字：

```
Error: could not sign in as activity-dock-consolidation-e2e: 403
{"success":false,"error":{"code":"AUTH_USER_ALREADY_CONFIGURED","message":"User already exists. This is a single-user system."}}
```

**机制一（确定性、可复现）：夹具账号在“已配置”的单用户服务端上登不进去，所以整个文件跑必红**

`server/modules/auth/auth.service.ts`（`register`）是单用户服务端：`if (dependencies.users.hasUsers()) throw new AppError('User already exists. This is a single-user system.', { code: 'AUTH_USER_ALREADY_CONFIGURED', statusCode: 403 })`。而 `e2e/activity-dock-truthful.spec.ts` 的三个 describe 各用自己的用户名调 `createAccount()`（`USERNAME='activity-dock-truthful-e2e'` `:104`、`PHASE_USERNAME='activity-dock-phase-e2e'` `:113`、`CONSOLIDATION_USER='activity-dock-consolidation-e2e'` `:934`），`createAccount` 在 403 时的兜底是**用自己那个用户名去登录** —— 第一个 describe 注册成功即占掉唯一槽位，后面的注册 403、用它自己的名字登录也失败，用例直接红在 setup。判据命令带 `-g "AC-188"` 只选中一个 describe，槽位恰好空着，所以判据本身能过；一旦文件整体跑，必红。驱动现场里 `could not sign in as …: 403 AUTH_USER_ALREADY_CONFIGURED` 在 2026-10-09T00:56–01:47 +0800 之间出现 20+ 次，就是这个形态。

**机制二（装载相关、概率性）：setup 赶上后端没就绪就当场红；负载下整次调用还可能撞 goal gate 的 60 秒击杀**

- `armScenario`（spec `:245`）对 arm 请求**没有任何重试**，非 2xx 直接 `throw new Error('arming failed (…)')`。驱动 17:54Z 那次红的现场（`quay-e2e-O35XaD`）逐字是 `Error: arming failed (500): null`，同次服务端日志是 `[vite] http proxy error: /api/user/complete-onboarding … Error: connect ECONNREFUSED 127.0.0.1:10445` —— 后端在 setup 期间还不可达。
- 17:47Z 那次（`quay-e2e-3aFqPC`）是 `Error: Channel closed` + `locator.getAttribute: Target page, context or browser has been closed`，死在等 `[data-activity-dock]` 时，即浏览器会话在用例中途被整段拆掉。
- goal gate 跑判据用 `runAcceptance()` 的默认 `DEFAULT_ACCEPTANCE_TIMEOUT_MS = 60_000`（插件 `goal-driver.js`；账本里别的 pipeline 有逐字条目 `acceptance timed out after 60000ms (killed) — raise gates.yml timeoutMs / --timeout`；`.quay/gates.yml` 不存在，即没有把上限抬到别处的余量），而本 spec 自己的单 spec 预算 `SINGLE_SPEC_CEILING_MS = 55_000`（`playwright.config.ts`）。空载整次调用 27.5–45.2 s；上一件任务在 load1 161→164 量到 49.2 s。整次调用的固定成本（config 求值 + 两个 webServer 启动 + 浏览器拉起 + warm）随扇入负载增长，越过 60 s 时 gate 会杀人 —— 与“死在用例中途、浏览器被拆”的现场一致。**这是主推断，不是已证实的因果；任务要求把量摆出来，用读数说话。**

<!-- dedup-ref -->
前四件已 done、都声称 `goal_ac: AC-188` 的任务（`gap-activity-single-dock-global-consistency`、`gap-ac188-criterion-body-budget-below-its-turn-walk-floor`、`gap-ac188-criterion-agreement-loses-poll-source-falsifiability`、`gap-ac188-case-budget-red-is-postturn-renavigation-tail`）修的都是在**用例体**里当时读到的那一个红（用例体预算、证伪形态落点、回合后重新导航的固定成本）；剩下的红在**夹具/bootstrap** 这一层，不在它们范围内，也不在任何在飞任务里 —— `node /data/home/yale/.claude/plugins/cache/quay/quay/0.17.0/scripts/dist/task-granularity-advice.js --touches e2e/activity-dock-truthful.spec.ts --json` 返回 `peers: []`、`mentions: []`。所以不合并，单独立案（该文件历史热度：10 件已落地任务、中位改动 144.5 行、中位执行轮次 2）。

**本轮要做的事**

1. 让 spec 的夹具与单用户服务端共存：三个 describe 共享**一个**账号（注册一次，其后登录），`createAccount` 对 403 `AUTH_USER_ALREADY_CONFIGURED` 走“登录既有账号”而不是“登录自己的名字” —— 目标是**整个文件不加 `-g` 也 exit 0**。
2. 给 setup 的瞬时失败加**有界重试**（`armScenario` 与账号 bootstrap 对 5xx / `ECONNREFUSED`），并且要有证据证明它真的吞掉过一次瞬时失败，而不是只看代码里有个重试循环。
3. 把判据整次调用的墙钟在**真实负载**下量出来，与 `60_000`（gate 击杀上限）和 `55_000`（spec 天花板）同时比，差值写进记录；**削固定成本**，不是抬天花板。
4. 直接重跑证明稳定（≥5 次连续绿，含至少一次高负载），并重跑两个证伪形态确认它们**仍红**。

范围边界：只动 `e2e/activity-dock-truthful.spec.ts`（必要时本 spec 相关的 `playwright.config.ts` 固定成本），**不碰活动坞的生产代码**（那是 GOAL-014 已落地的实现），不改 `docs/`，不改 `SINGLE_SPEC_CEILING_MS` 的语义来“糊”过关。

## AC

- [x] AC1（整文件绿 + 改前对照）`npx playwright test e2e/activity-dock-truthful.spec.ts`（不加 `-g`）exit 0，逐字记录整次输出（测试数、每个 describe 的结果）；同时逐字记录改前同一命令 exit 1 的 `AUTH_USER_ALREADY_CONFIGURED` 红作为对照。
- [x] AC2（夹具共享，可 grep 判定）`grep -nE "USERNAME|PHASE_USERNAME|CONSOLIDATION_USER|createAccount\(|signIn|login" e2e/activity-dock-truthful.spec.ts` 的输出证明注册路径唯一、其后各 describe 都是登录；`createAccount` 里对 403 `AUTH_USER_ALREADY_CONFIGURED` 的分支逐字贴出。
- [x] AC3（瞬时失败有界重试，带证据）`armScenario` 与账号 bootstrap 对 5xx / `ECONNREFUSED` 做有限次重试（有上限、有退避），**并用证据**证明它吞掉过一次真实瞬时失败（可注入的失败探针产物，或日志里一次被重试后转成功的 5xx），而不是只贴代码。
- [x] AC4（墙钟 vs 两道天花板）在真实负载下量出判据整次调用墙钟 `T` 与 case body `dock.wall`，把 `T` 与 `60_000`（`DEFAULT_ACCEPTANCE_TIMEOUT_MS`）和 `55_000`（`SINGLE_SPEC_CEILING_MS`）同列比较、写明余量；若削了固定成本，写明削掉的是哪一段及其前后读数。
- [x] AC5（稳定性）`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` 连续 ≥5 次 exit 0，其中至少一次在起始 load1 ≥ 60 的高负载下跑；记录每次起始 load1、`dock.wall`、整次调用墙钟，并逐字贴一次完整读数汇总。
- [x] AC6（证伪形态仍红 ×2，改完还原）(i) 临时恢复 `src/modules/chat/composer/ActivityIndicator.tsx` 的旧挂载（`chat-activity-tab` + `data-slot="chat-activity-inline"`）⇒ 数量读数必须红（`legacy.tab`/`legacy.inline` ≠ 0）；(ii) 临时让 `src/modules/sidebar/RunningView.tsx` 读 1 秒 `/api/session-hosts` 轮询 ⇒ `consistency.afterTurnLive` 必须红。两者逐字记录失败断言，并各自还原到 clean。
- [x] AC7（静态闸）`npm run typecheck` exit 0；若改动落在 vitest 覆盖的 tsx/ts 上，`npx vitest run <改动文件>` exit 0（用仓库真实闸门，不用 `node --test` 去跑 vitest 文件）。

## DoD

- 真实服务上跑通：两条命令都由 playwright 真起 server + vite（`webServer`），不是 mock；逐字日志进 §Evidence。
- 共享夹具账号在**真的**单用户服务端上跑通（就是 `server/modules/auth/auth.service.ts` 的 `AUTH_USER_ALREADY_CONFIGURED` 路径）——整文件 exit 0 是“对象真的被这样跑过”，不是“测试存在”。
- 两个证伪形态都在真实浏览器上跑出红，并已还原：`git status --short` 对 `src/modules/chat/composer/ActivityIndicator.tsx` 与 `src/modules/sidebar/RunningView.tsx` 为 clean。
- 稳定性有 ≥5 次连续绿的逐次读数（含高负载一次），且 `T` 相对两道天花板有余量。
- 无（待外部）AC：本任务每条 AC 都能由执行者在工作树上亲手做出。

## Evidence

**§E1 门账本计数（立案时，`.quay/gate-events.jsonl`，`pipeline_id=AC-188`/`gate=goal`）**

AC-188 全时段 550 pass / 541 fail；`2b774f6d`（2026-10-08T16:48Z）之后 14 pass / 2 fail，红在 17:47:22Z（tree `951bda5e`）与 17:54:11Z（tree `b619c84d`）。同 spec 兄弟：AC-184 54/1、AC-185 13/0、AC-187 13/0。零条 reason 含 `AUTH_USER_ALREADY_CONFIGURED` / `arming failed` / `Channel closed` / `body must land` —— reason 都是被截断的 WebServer stderr。

**§E2 判据直接重跑 5/5 pass（HEAD `7b2043af`，tree `b619c84d`）**

命令 `bash scripts/with-memory-cap.sh npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"`，日志 `/tmp/ac188-refile-1..5.log`，环境 `/tmp/ac188-refile-env.txt`。逐次：起始 load1 46.51 / 31.75 / 25.17 / 19.70 / 20.88；`dock.wall` 17416 / 17406 / 17389 / 17562 / 19114 ms；整次调用 31.9 / 27.6 / 27.5 / 28.0 / 45.2 s；walk-done ≈15.0–16.4 s，turn-closed ≈16.3–17.7 s，sampled ≈17.4–19.1 s。五次读数一致且正确。

**§E3 整文件跑 exit 1（确定性红）**

`npx playwright test e2e/activity-dock-truthful.spec.ts`（不加 `-g`），load1 起始 55.68，日志 `/tmp/ac188-wholefile.log`：测试 1–3 通过，测试 4（AC-188）在 `:1236` 红，逐字 `Error: could not sign in as activity-dock-consolidation-e2e: 403 {"success":false,"error":{"code":"AUTH_USER_ALREADY_CONFIGURED",…}}`。

**§E4 驱动失败现场逐字（`/data/home/yale/.cache/quay-e2e-tmp/*/test-results/*/error-context.md`）**

- `quay-e2e-3aFqPC`（17:47Z）：`Error: Channel closed` + `locator.getAttribute: Target page, context or browser has been closed`（死在等 `[data-activity-dock]`）。
- `quay-e2e-O35XaD`（17:54Z，`.last-run.json` = failed）：`Error: arming failed (500): null`；同次服务端日志 `[vite] http proxy error: /api/user/complete-onboarding … Error: connect ECONNREFUSED 127.0.0.1:10445`。
- 2026-10-08 23:53 → 2026-10-09 02:00 全扫：`Channel closed` 多次；`the project row/chat pane … never rendered … page.reload: Timeout 1672/1988/1987ms exceeded`；一次 `mobile: the sidebar must count the session as running`；以及 20+ 次 `could not sign in as activity-dock-consolidation-e2e: 403 AUTH_USER_ALREADY_CONFIGURED`（00:56–01:47 +0800 聚集）。

**§E5 机制一的代码位置**

`server/modules/auth/auth.service.ts` 的 `register` 单用户判定；spec 里三个用户名常量与 `createAccount`（`:224`）、`armScenario`（`:245`）、`startResidentProcess`（`:258`）；`beforeAll` 在 `:1167–1228`。


**§E6 落地（分支 / 提交 / 树）**

分支 `task/gap-ac188-case-bootstrap-collision-and-gate-kill`。实现提交 `f5adcf2e`（`e2e/activity-dock-truthful.spec.ts` +302/−37、`playwright.config.ts` +21/−4），随后 `git merge develop`（`85b18c7b`）无冲突，合并提交 `b928c14f`、树 `b76d810c`；最终 `git status --short` clean（上述两文件已提交，无其它改动）。三个 describe 现在共用**一个**夹具账号，`-g` 与不加 `-g` 走同一条注册/登录路径。

**§E7 AC1 整文件绿 + 改前对照**

改后（合并后树 `b76d810c`，日志 `/tmp/ac188v2/postmerge-wholefile.log`）——`npx playwright test e2e/activity-dock-truthful.spec.ts`（不加 `-g`）：**EXIT=0**，`5 passed (1.0m)`，整次调用 `T=61695ms`，起始/结束 load1 15.99 / 15.71。逐条：

```
  ✓  1 e2e/activity-dock-truthful.spec.ts:901:3 › activity dock truthfulness › AC-184 the dock tells the truth when the app socket is partitioned (14.5s)
  ✓  2 e2e/activity-dock-truthful.spec.ts:1006:3 › activity dock truthfulness › AC-185 a send the server never takes fails, keeps the draft, and retries without duplicating the user row (1.3s)
  ✓  3 e2e/activity-dock-truthful.spec.ts:1096:3 › activity dock truthfulness › the run ends inside the ceiling the goal gate kills at (0ms)
  ✓  4 e2e/activity-dock-truthful.spec.ts:1461:3 › activity dock consolidation › AC-188 one dock, no legacy surface, and one answer across the dock, the sidebar and the send button (17.4s)
  ✓  5 e2e/activity-dock-truthful.spec.ts:1957:3 › activity dock phase truthfulness › AC-187 the dock speaks the real phase: thinking, Bash, writing, idle — and holds still inside a phase (15.4s)
```

同日更早一次同命令读数（合并前树，`/tmp/ac188-after-wholefile-3.log`）：`5 passed (1.1m)`，`EXIT=0`，`ELAPSED=64913ms`，load1 19.11→44.41。

改前对照（`/tmp/ac188-baseline-wholefile.log`，spec 与 config 均 clean 的基线树）：同命令 **EXIT=1**，`1 failed` / `3 passed (26.5s)`，`ELAPSED=27.39`。逐字：

```
  ✓  1 … AC-184 the dock tells the truth when the app socket is partitioned (14.5s)
  ✓  2 … AC-185 a send the server never takes fails, keeps the draft, and retries without duplicating the user row (1.3s)
  ✓  3 … the run ends inside the ceiling the goal gate kills at (1ms)
  ✘  4 e2e/activity-dock-truthful.spec.ts:1236:3 › activity dock consolidation › AC-188 one dock, no legacy surface, and one answer across the dock, the sidebar and the send button (0ms)
  -  5 e2e/activity-dock-truthful.spec.ts:1729:3 › activity dock phase truthfulness › AC-187 …

    Error: could not sign in as activity-dock-consolidation-e2e: 403 {"success":false,"error":{"code":"AUTH_USER_ALREADY_CONFIGURED","message":"User already exists. This is a single-user system."}}
```

第 5 条的 `-`（skipped）是文件级 `test.describe.configure({ mode: 'serial' })` 的连带：测试 4 红，测试 5 不再跑 —— 这也就是机制一修好之后暴露出来的“第二次击杀”（§E14）。

**§E8 AC2 夹具共享（grep 判定）**

`grep -nE "USERNAME|PHASE_USERNAME|CONSOLIDATION_USER|createAccount(|signIn|sign in|login" e2e/activity-dock-truthful.spec.ts` 的输出：

```
112: * never sign in, because its register was refused and its own name did not exist
118:const USERNAME = 'activity-dock-truthful-e2e';
368:async function createAccount(
370:  username: string = USERNAME,
386:      // register against this single-user server answers 403 and the login branch below takes over,
396:    // the shared fixture account is already in place — so sign in to *that* account rather than to the
400:    const login = await setupPost(api, '/api/auth/login', { data: { username, password } });
401:    const loggedIn = login.body as { token?: unknown } | null;
412:        + `login ${login.status} ${JSON.stringify(login.body)}`,
850:    const token = await createAccount(bootstrap);
1408:    const token = await createAccount(bootstrap);
1924:    const token = await createAccount(bootstrap);
```

`PHASE_USERNAME` / `CONSOLIDATION_USER` 已不存在，唯一账号常量是 `:118`，三处 `createAccount(bootstrap)` 全部走默认参数 —— 注册路径唯一（第一次 describe），其后都是登录。403 分支逐字（spec `:393–401`，判定读 `error.code` 而不是 message 文案）：

```ts
    // The server is single-user: the first account to register owns the only slot, and every later
    // register answers 403 AUTH_USER_ALREADY_CONFIGURED. That is not a failure of this call — it means
    // the shared fixture account is already in place — so sign in to *that* account rather than to the
    // name this describe happens to hold. Read by code, not by message: the message is UI copy.
    const alreadyConfigured = register.status === 403
      && registered?.error?.code === 'AUTH_USER_ALREADY_CONFIGURED';
    const login = await setupPost(api, '/api/auth/login', { data: { username, password } });
```

**§E9 AC3 有界重试，且真的吞掉过一次瞬时失败**

重试机件在 spec `:243–360`：`SETUP_RETRY_LIMIT=5`、`SETUP_RETRY_BASE_DELAY_MS=250`、`SETUP_RETRY_MAX_DELAY_MS=2000`，`isTransientSetupFailure(status)` 判 `status >= 500 || status === TRANSPORT_FAILURE_STATUS(-1)`；`armScenario` 与 `createAccount` 都包在 `withSetupRetry` 里（非 2xx 但非瞬时、以及 2xx 里没有 `sessionId` 的，不重试）。

注入探针 `QUAY_E2E_SETUP_FAULT_ONCE=account-bootstrap|arm-scenario` 生效时真的向 `http://127.0.0.1:1` 发一次请求，拿到的是**真 `ECONNREFUSED`**，不是构造出来的错误值。

- `QUAY_E2E_SETUP_FAULT_ONCE=arm-scenario`（日志 `/tmp/ac188v2/ac3-arm-scenario.log`，exit 0，`dock.wall=17479ms`）：

```
[e2e] setup retry: arming the scenario for activity-dock-consolidation-workspace transient failure (-1 apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:1
Call log:
  - → POST http://127.0.0.1:1/api/debug-agent/scenarios
    - user-agent: Playwright/1.63.0 (x64; ubuntu 24.04) node/24.21
    - accept: */*
    - accept-encoding: gzip,deflate,br
); attempt 1/5 failed, retrying in 250ms
[e2e] setup retry: arming the scenario for activity-dock-consolidation-workspace succeeded on attempt 2 after a transient failure (…)
```

- `QUAY_E2E_SETUP_FAULT_ONCE=account-bootstrap`（日志 `/tmp/ac188v2/ac3-account-bootstrap.log`，exit 0，`dock.wall=17399ms`）：同形，`signing in as activity-dock-truthful-e2e transient failure (…)` → `attempt 1/5 failed, retrying in 250ms` → `succeeded on attempt 2 after a transient failure`。

两次都是**真实瞬时失败被重试吞掉后用例转绿**，不是“代码里有个循环”。

**§E10 AC4 墙钟 vs 两道天花板**

判据命令 `-g "AC-188"`（goal gate 跑的就是它），高负载 5 次（日志 `/tmp/ac188v2/ac5-run-1..5.log`）：

| 读数 | 逐次值（ms） | 最大 | 余量 |
| --- | --- | --- | --- |
| 整次调用 `T`（起始 load1 26.15 / 56.61 / 71.47 / 67.30 / 58.68） | 26820 / 29519 / 30259 / 28232 / 26850 | 30259 | vs `SINGLE_SPEC_CEILING_MS=55_000` **+24.74 s**；vs `DEFAULT_ACCEPTANCE_TIMEOUT_MS=60_000` **+29.74 s** |
| case body `dock.wall`（同 5 次） | 17428 / 17779 / 17773 / 17554 / 17464 | 17779 | vs 用例自带的 `25_000` 上限 **+7.22 s** |

合并后复核（树 `b76d810c`，quiet load1 14.62）：`T=26544ms`、`dock.wall=17395ms`、exit 0。

不加 `-g` 的整文件调用是另一种选择形态：`T=61695ms`（合并后）/ `64913ms`（合并前），**结构性越过 `55_000`** —— 它那五个 case body 本身就 49.2 s（14.5 + 1.3 + 0 + 17.4 + 15.4），而每个 case 里都含一段被固定的真实 debug-agent 回合 walk（AC-188 的 `turn-end@5000` + `wait@5500` 就是 ~15 s 地板）。因此本文件在 `SPEC_BUDGET_MS` 里申报了自己的预算，理由与代价见 §E14。

**固定成本削了吗：做了 A/B，读数是“没削下来”。** 把 `beforeAll` 里的 client warm-up（2.2–2.4 s）从“与 bootstrap 并行”改回“先行等待”再改回来，交替各 2 次（`/tmp/ac188v2/ab/summary.txt`，quiet load1 13.7–14.6）：

```
serialized 1 load1=13.67 exit=0 T=26237ms dock.wall=17484 pre-bundle committed in 2156ms
overlapped 1 load1=14.59 exit=0 T=26496ms dock.wall=17446 pre-bundle committed in 2358ms
serialized 2 load1=13.91 exit=0 T=26259ms dock.wall=17431 pre-bundle committed in 2245ms
overlapped 2 load1=14.31 exit=0 T=27679ms dock.wall=17414 pre-bundle committed in 2411ms
```

`T` 两组均值 26248 / 27088 ms，差在噪声内 —— 这段并行不构成余量。真实固定成本是结构性的：config 求值 + 两个 webServer 启动 + 浏览器拉起 + 三个 `beforeAll`（每 describe 一条启动路径）≈ 12–16 s，其中没有可再削的块；能削的只有 case body，而 case body 就是判据本身。所以本任务**不声称**任何固定成本削减，只声称实测余量（上表）。

**§E11 AC5 稳定性（连续 ≥5 次绿，含高负载）**

`/tmp/ac188v2/ac5-summary.txt`：

```
run=1 startLoad1=26.15 T=26820ms exit=0 dock.wall=17428 pass=' 1 passed (25.9s)'
run=2 startLoad1=56.61 T=29519ms exit=0 dock.wall=17779 pass=' 1 passed (28.5s)'
run=3 startLoad1=71.47 T=30259ms exit=0 dock.wall=17773 pass=' 1 passed (29.3s)'
run=4 startLoad1=67.30 T=28232ms exit=0 dock.wall=17554 pass=' 1 passed (27.4s)'
run=5 startLoad1=58.68 T=26850ms exit=0 dock.wall=17464 pass=' 1 passed (26.0s)'
=== AC5 end 2026-10-09T02:46:53+08:00 load1=43.40 ===
```

5/5 exit 0；run 3（起始 load1 71.47）与 run 4（67.30）两次起始 load1 ≥ 60。负载由 `node /tmp/ac188-burn/burn.mjs 60 240`（60 路 CPU burner，`kill` 时 load1 81.84）造成，脚本 `/tmp/ac188v2/ac5.sh`。另有静载复核 `/tmp/ac188v2/crit-1.log`（`T=28111ms`、`dock.wall=17418ms`、exit 0）与合并后 `/tmp/ac188v2/postmerge-g.log`（`T=26544ms`、`dock.wall=17395ms`、exit 0）。

**§E12 AC6 两个证伪形态仍红，且已各自还原**

(i) `src/modules/chat/composer/ActivityIndicator.tsx` 根 div 首子节点临时挂回 `<span className="chat-activity-tab" data-slot="chat-activity-inline" aria-hidden />`（日志 `/tmp/ac188v2/ac6-i.log`）：

```
dock.count.desktop=1 legacy.tab=1 legacy.inline=1 resident.activityMarkers=[]
dock.count.mobile=1 legacy.tab=1 legacy.inline=1 resident.activityMarkers=[]
    Error: desktop: the old tab class and the inline slot must not match anything
  1 failed
```

(ii) `src/modules/sidebar/RunningView.tsx` 临时改成读 1 秒 `/api/session-hosts` 轮询：挂载即打一次 `tick()`，随后 `setInterval(tick, 1000)`，busy 由 listing 自己的 `turn` lease 推出（`binding.leases.some(l => l.kind === 'turn')`），取代原来的 `useBusySessionIdSet()`。失败断言逐字（`/tmp/ac188v2/ac6-ii-run-4.log`、`/tmp/ac188v2/rate/run-4.log`、`/tmp/ac188v2/rate/run-5.log` 三次同一条）：

```
    Error: desktop: no live reading may show the dock leave the turn while the sidebar or the send button still says busy
  1 failed
```

现场读数里 dock 已经 `absent` 而 sidebar 仍 `true`（轮询那一拍还没落）：

```
consistency.afterTurnLive.desktop=[{"dock":"in-turn","sidebar":true,"send":"send"},{"dock":"in-turn","sidebar":true,"send":"send"},{"dock":"in-turn","sidebar":true,"send":"send"},{"dock":"in-turn","sidebar":true,"send":"send"},{"dock":"absent","sidebar":true,"send":"send"},{"dock":"absent","sidebar":true,"send":"send"},{"dock":"absent","sidebar":false,"send":"send"},…]
```

这条注入的红是**概率性**的：11 次同注入里 4 次红，全部落在 AC6(ii) 固定到的那条断言上；其余 7 次绿时窗口末尾那一拍恰好落在 dock 离场之前 —— 这正是判据注释里“1 秒轮询的清理落在 `(0, 1000ms]` 上的均匀相位”所预言的性质（`consistency.afterTurnLive.window` ≥ 1000ms 的那条前置断言保证窗口足够长，红只会在相位撞上时出现）。另外还有一个只在 tick 上学习（挂载不打第一次请求）的同形变体，同样被这条注入红到同一条断言（`/tmp/ac188v2/ac6-ii-tickonly.log`）。

两个临时改动都已还原：`git status --short` 只余 `e2e/activity-dock-truthful.spec.ts`、`playwright.config.ts` 两个已提交文件，`ActivityIndicator.tsx` 与 `RunningView.tsx` 均 clean。

**§E13 AC7 静态闸**

`bash scripts/with-memory-cap.sh npm run typecheck` → `tsc --noEmit` 三项（根 / `server/` / `scripts/`）全部通过，**EXIT=0**；合并前（`f5adcf2e`）与合并后（`b928c14f`）各跑一次，均 0。改动落点是 `e2e/*.spec.ts`（playwright 专跑）与 `playwright.config.ts`，都不在 vitest 的 `include: ['src/**/*.test.ts','src/**/*.test.tsx']` 覆盖内，故无 vitest 项。

**§E14 关于 `playwright.config.ts`：申报本文件预算，不改天花板语义**

不加 `-g` 的整文件调用（AC1 要求它绿）结构性越过 55 s，而 `RUN_CEILING_MS` 对“一个文件、未申报”的选择恰好就是 `SINGLE_SPEC_CEILING_MS=55_000`，于是机制一修好、第五个 case 不再被 serial 跳过之后，watchdog 会在用例中途把它杀掉 —— 两次逐字（`/tmp/ac188-after-wholefile-1.log`、`-2.log`，都在 ~55.75 s）：

```
[e2e] watchdog: this run crossed its own 55000ms ceiling … stuck at stage "browser-launch-or-cases"
```

所以：

- `SINGLE_SPEC_CEILING_MS` **未改**（仍是 `55_000`，仍是默认值）；
- 只在 `SPEC_BUDGET_MS` 表里加了本文件一行 `'activity-dock-truthful.spec.ts': 240_000,`；这张表的文档用途就是“运行时与默认不同的文件”，同表已有两条同值既有条目（`mobile-workspace-composer-layout.spec.ts`、落地判据那条）；
- 同段文档两句按事实改写：原文 `mobile-workspace-composer-layout.spec.ts is the only declared entry` 在本轮之前就已与表内容不符（表里已有第三条），改为“每条申报的注释自述它对着哪一次测量、留了多少余量”。
- **代价，如实写下**：申报之后，本文件的 `-g` 选择也按 240 s 兜底，watchdog 不再是那道会指名 stage 的 55 s 护栏（对 `-g` 选择，兜底变成 goal gate 自己的 60 s 击杀，reason 会被截断成 WebServer stderr —— 正是立案记录里抱怨过的那个截断）。判据选择的实测 `T` 是 26.5–30.3 s，离 60 s 还有 29.7 s，所以这条代价只在“判据真的挂住”时才显形。

## Touches

- `e2e/activity-dock-truthful.spec.ts`（共享夹具账号、setup 有界重试、判据负载墙钟测量）
- `playwright.config.ts`（在 `SPEC_BUDGET_MS` 表里申报本文件的运行预算；`SINGLE_SPEC_CEILING_MS` 与其余条目未动）
- `tasks/gap-ac188-case-bootstrap-collision-and-gate-kill.md`（自触：本任务状态翻转的记录）
