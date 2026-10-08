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

- [ ] AC1（整文件绿 + 改前对照）`npx playwright test e2e/activity-dock-truthful.spec.ts`（不加 `-g`）exit 0，逐字记录整次输出（测试数、每个 describe 的结果）；同时逐字记录改前同一命令 exit 1 的 `AUTH_USER_ALREADY_CONFIGURED` 红作为对照。
- [ ] AC2（夹具共享，可 grep 判定）`grep -nE "USERNAME|PHASE_USERNAME|CONSOLIDATION_USER|createAccount\(|signIn|login" e2e/activity-dock-truthful.spec.ts` 的输出证明注册路径唯一、其后各 describe 都是登录；`createAccount` 里对 403 `AUTH_USER_ALREADY_CONFIGURED` 的分支逐字贴出。
- [ ] AC3（瞬时失败有界重试，带证据）`armScenario` 与账号 bootstrap 对 5xx / `ECONNREFUSED` 做有限次重试（有上限、有退避），**并用证据**证明它吞掉过一次真实瞬时失败（可注入的失败探针产物，或日志里一次被重试后转成功的 5xx），而不是只贴代码。
- [ ] AC4（墙钟 vs 两道天花板）在真实负载下量出判据整次调用墙钟 `T` 与 case body `dock.wall`，把 `T` 与 `60_000`（`DEFAULT_ACCEPTANCE_TIMEOUT_MS`）和 `55_000`（`SINGLE_SPEC_CEILING_MS`）同列比较、写明余量；若削了固定成本，写明削掉的是哪一段及其前后读数。
- [ ] AC5（稳定性）`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` 连续 ≥5 次 exit 0，其中至少一次在起始 load1 ≥ 60 的高负载下跑；记录每次起始 load1、`dock.wall`、整次调用墙钟，并逐字贴一次完整读数汇总。
- [ ] AC6（证伪形态仍红 ×2，改完还原）(i) 临时恢复 `src/modules/chat/composer/ActivityIndicator.tsx` 的旧挂载（`chat-activity-tab` + `data-slot="chat-activity-inline"`）⇒ 数量读数必须红（`legacy.tab`/`legacy.inline` ≠ 0）；(ii) 临时让 `src/modules/sidebar/RunningView.tsx` 读 1 秒 `/api/session-hosts` 轮询 ⇒ `consistency.afterTurnLive` 必须红。两者逐字记录失败断言，并各自还原到 clean。
- [ ] AC7（静态闸）`npm run typecheck` exit 0；若改动落在 vitest 覆盖的 tsx/ts 上，`npx vitest run <改动文件>` exit 0（用仓库真实闸门，不用 `node --test` 去跑 vitest 文件）。

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

## Touches

- `e2e/activity-dock-truthful.spec.ts`（共享夹具账号、setup 有界重试、判据负载墙钟测量）
- `playwright.config.ts`（仅在本 spec 的固定成本确实需要削时才动；否则不动）
- `tasks/gap-ac188-case-bootstrap-collision-and-gate-kill.md`（自触：本任务状态翻转的记录）
