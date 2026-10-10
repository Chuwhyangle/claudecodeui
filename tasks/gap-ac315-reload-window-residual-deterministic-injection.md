---
id: gap-ac315-reload-window-residual-deterministic-injection
title: AC-315 残余（page.reload 后判定窗超时）30 次未复现：先用确定性慢 reload
  注入把红造出来再修到绿；稳定性读数改用家族惯例（连续 ≥5 次 + 一次并发臂），不再用不可证的「连跑 10 次全绿」
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-315
---
## Proposal

来源：`gap-ac315-upload-criterion-boot-race`（needs-human → 人 yale 2026-10-10 裁定）把该任务 AC2 的「第一条命令连跑 ≥10 次全部 exit 0」判为**不可判定**的目标，改判成本条：先造出确定的红，再修到绿，稳定性读数用本族惯例。

### 为什么改判（不是放弃，是换成可证形式）

- 「连跑 N 次全绿」只能被反例推翻、不能被证明；每重跑一轮烧掉一整次 worker 会话。该任务已因此烧掉两轮。
- 现在**没有可修的对象**：残余的第一族（`page.reload()` 后 `.chat-messages-pane` 30s 判定窗超时）在 30 次运行里**一次都没复现**；第二族（两条 leg 共用同一 `page` + `mode: 'serial'`，375px leg 的等待在首次求值就命中上一轮的旧文本）已根因定位并修好 —— commit `3e856ef7`，修后 20/20。
- 同族先例走的是另一条路：AC-184 → `gap-ac266-criterion-startup-guard-cannot-afford-a-replay`（已 done）把「希望它别红」换成「**先注入确定性慢首载把红造出来**，再修到绿」。那是可证的。

### 现状读数（立案时实测，不是复述）

- `.quay/gate-events.jsonl` 中 AC-315 的 `gate: goal` 记录共 **116 次评估、20 次红**，且 **20 次红全部早于 `2026-10-09T15:26:51Z`**；其后到 `2026-10-10T02:00:26Z` 连续 30 次 pass —— **约 13.5 小时零红**。
- 该判据间歇红是**已记录的历史属性**：两个前序任务追过它（`gap-ac315-upload-criterion-repoint-under-voice-bar` :: done、`gap-ac315-upload-criterion-second-upload-flake`），前者的 DoD 原话是「这条判据历史上就是间歇红的，单次绿不算数」。
- AC-315 现 `achieved`，criterion 逐字为 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts && npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`。

### 修什么

1. 把残余变成**可复现**：注入一个确定性慢 reload —— 只在「注入开启」且只在 `beforeAll` 首次 `page.goto('/')` 之后的那次 `page.reload()` 触发的文档/入口请求上，把响应拖过判定窗（其后正常服务）。先证明判据**红**，再修。
2. 修到绿：让 reload 路径的判定窗有界且留得下重放（照 AC-184 在 `e2e/activity-dock-truthful.spec.ts` 上的成例：预算算术要算得过来，重放签名地记进日志），而不是加 sleep / 放宽断言。
3. 稳定性读数改用家族惯例（见 AC3）。⛔ 不动判据命令、⛔ 不动 `playwright.config.ts`、⛔ 不加 retries/skip、⛔ 不改既有实质断言、⛔ 不动 `goals/**`。

## AC

- [x] AC1 确定性注入可红（承重）：注入上述慢 reload 后，判据物逐字不改地跑必须**非零退出**，且红落在被点名的那个窗/守卫上（不是「文件不存在」式的空洞红）。登记注入 diff、逐字失败行、`echo $?`。
- [x] AC2 同一注入下修到绿（承重）：改后同一注入 `exit 0`，且逐字日志里能读出 reload 路径的**有界重放**确实被执行（署名日志：首跳 / 第 N 次 reload），随后还原注入并证明零残留（`git status --porcelain` 回到注入前）。
- [x] AC3 稳定性读数（家族惯例，非 10 次）：无注入条件下判据连续 **≥5 次** `exit 0`；其中**至少一次与 ≥4 份兄弟 e2e spec 并发**。如实登记：并发那次若兄弟 spec 自己红，须点名归因、不计入本条。⛔ 不再以「连跑 10 次全绿」为判据（经裁定为不可证伪）。
- [x] AC4 判定面一字未改：`git diff develop -- e2e/voice-realtime-upload-fixture.spec.ts | grep -c "^-.*expect("` 为 **0**；`git diff develop -- playwright.config.ts` 为空；判据命令逐字不变；既有实质断言（`audioFrameCount` 增量、`mediaCallCount` 为 0、`page.reload()` 后仍可见等）原样。
- [x] AC5 静态门：`npm run typecheck` 退出 0；`npx oxlint e2e/voice-realtime-upload-fixture.spec.ts` 的新增诊断数为 0（与 develop 版本同跑对照）。

## DoD

真实落地判据：残余不再是「不可复现的偶发」，而是被**观测到**的机制 —— 确定性慢 reload 注入下判据先红、修后绿，两组读数（注入前后、修复前后）与注入 diff 一并入档，任何人在同一 checkout 上可复现；还原后 `git status --porcelain` 干净。稳定性以连续 ≥5 次（含一次与 ≥4 份兄弟 spec 并发）为读数，如实登记每次的 exit code 与 wall。

若注入下**无法**把红造出来（即慢 reload 不是该窗的触发条件），必须停手上报：置 `needs-human` 并写明「残余不可归因于 reload 路径，原判据的不稳定另有来源」——不得把造不出红写成修好了，也不得据此改断言。

交付物只落在 `e2e/voice-realtime-upload-fixture.spec.ts` 与本任务文件；⛔ 不以 jsdom/组件层绿替代浏览器层绿；⛔ 不改 `goals/**`。

## Touches

- e2e/voice-realtime-upload-fixture.spec.ts
- tasks/gap-ac315-reload-window-residual-deterministic-injection.md (self)

## Notes

- 前身：`gap-ac315-upload-criterion-boot-race`（AC1/AC3/AC4/AC5 已交付并 ticked；AC2 经人裁定移交本条）。AC-315 本体保持 `achieved`，未被 supersede。
- 判据物是**出货中的 spec 本体**，不是本地临时改动：`git cat-file -e develop:e2e/voice-realtime-upload-fixture.spec.ts` 必须存在。

## Evidence

读数取自 worktree `claudecodeui-wt/gap-ac315-reload-window-residual-deterministic-injection`（branch `task/gap-ac315-reload-window-residual-deterministic-injection`），2026-10-10。代码 commit `25e6fb28`，随后 `git merge --no-edit develop` 干净合并（`b953b8a4`，develop 侧只带进 `tasks/gap-ac315-upload-criterion-boot-race.md`，spec 无冲突）；下列 AC1/AC2 读数是在**合并后**的树上重取的。

### 注入（登记物）

- 注入 diff：`/tmp/ac315-injection.diff`（63 行，**45 insertions / 0 deletions**，两个 hunk）：块插在 `const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;` 之后（`@@ -73,6 +73,50 @@`），安装行插在 `page = await context.newPage();` 之后（`@@ -638,6 +682,7 @@`）。
- 生成器 `/tmp/ac315-injection.py`（`argv[1]` = spec 路径，只写该路径；锚点不唯一即拒绝；已注入则拒绝；幂等）。
- 注入自武装于 page 自身的 load 事件：**首个 session 路由的 document load 就是残余读到的那次 reload**（`beforeAll` 开 `/`，session 是客户端进入的），其 `/api/` 启动突发被扣住 `INJECTED_HOLD_MS = 32_000`（突发窗 `INJECTED_BURST_MS = 2_000`），其后的每次 session 路由 load（守卫的重放）正常服务 —— 「先扣过窗、再正常服务」是注入自身的性质，不是被测代码的性质。
- 测试对象与同一性：AC1 用 `git checkout develop -- e2e/voice-realtime-upload-fixture.spec.ts` + 注入 ⇒ `git diff develop --stat` = `45 insertions(+)`；AC2 用本任务 HEAD 的 spec + 同一注入 ⇒ `git diff HEAD --stat` = `45 insertions(+)`；两次的 diff 与登记 diff 逐字比对 `diff /tmp/ac315-injection.diff /tmp/ac315-injection-ac1-current.diff` → 无差异（同一注入）。
- **注入通道为何是 reloaded document 的 `/api/` 启动突发**：`public/sw.js` 代理除 `/api/`、`/ws`、`/oauth/`、`/.well-known/`、`/mcp` 之外的一切，document/module 请求不经 `page.route`；且 document/module 上的延迟会被 `page.reload()` 等待 load 事件吸收（实测：单独扣 `/api/auth/status` 时 reload 返回 26.8s 而用例仍绿）。该窗由 load 之后约 40ms 内的 6 个 `/api/` 请求决定（`plugins`×2、`auth/status`×2、`taskmaster/installation-status`×2），其后 30s 内无请求。

### AC1 —— 注入可红（`/tmp/ac315-ac1-postmerge.log`，`AC1_CRITERION_EXIT=1`）

```
✘  1 e2e/voice-realtime-upload-fixture.spec.ts:705:3 › voice realtime upload fixture › injecting a fixed-corpus fixture sends its instruction through the ordinary transcript, with no draft step (34.1s)
    Error: expect(locator).toBeVisible() failed
    Locator: locator('.chat-messages-pane')
    Expected: visible
    Timeout: 30000ms
    Error: element(s) not found
      758 |     // History, not this page's live state.
      759 |     await page.reload();
    > 760 |     await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  1 failed
  2 did not run
```

注入侧逐字：`[ac315-injection] document load: http://127.0.0.1:11103/session/8f9c2d93-…` → `holding this document's boot requests for 32000ms (burst window 2000ms)` → 六条 `holding … for 32000ms`。红落在被点名的那个窗（`.chat-messages-pane`，`Timeout: 30000ms`，`element(s) not found`）—— 与历史红的签名一致，非「文件不存在」式空洞红。

### AC2 —— 同一注入下绿 + 有界重放（`/tmp/ac315-ac2-postmerge.log`，`AC2_CRITERION_EXIT=0`）

e2e 相 `3 passed (27.9s)`；server 相 `ℹ tests 11 / ℹ pass 11 / ℹ fail 0`。署名重放逐字：

```
[e2e] reload pane: hop 1 (page.reload) begins with 5000ms of navigation budget
[e2e] reload pane: hop 1 (page.reload) returned after 967ms
[e2e] reload pane: the transcript pane after the history reload was not up 4000ms after hop 1 (page.reload); replaying the reload
[e2e] reload pane: hop 2 (page.reload (replay 1)) begins with 5000ms of navigation budget
[e2e] reload pane: hop 2 (page.reload (replay 1)) returned after 972ms
[e2e] reload pane: the transcript pane after the history reload came up after 6447ms (attempt 2, page.reload (replay 1))
[e2e] reload pane: hop 1 (page.reload) returned after 1016ms
[e2e] reload pane: the transcript pane after the 375px reload came up after 1485ms (attempt 1, page.reload)
```

（375px leg 是注入突发用尽后的第三次 session load，正常服务，所以首跳即落地 —— 这也说明重放不是无条件触发的。）预算算术写在代码注释里：首跳 `PANE_RELOAD_HOP_MS = 5_000` + 首落 `PANE_FIRST_LANDING_MS = 4_000` + 重放跳 `5_000` + 重放落 `PANE_REPLAY_LANDING_MS = 3_000` = **17_000 ≤ `PANE_RELOAD_DEADLINE_MS = 18_000`**，即首跳花光整份预算后仍留得下一次完整重放；落不下时以 `explain()` 具名抛出并附页面正文（不再是「某个 30s 等待跑完了」）。还原注入后：`git status --porcelain` 为空、spec 内注入标记计数 0。

### AC3 —— 稳定性（`/tmp/ac315-ac3/summary.txt` 与 run1..4 / run5 / run6 日志）

| 轮次 | 条件 | exit | wall | 结果 |
| --- | --- | --- | --- | --- |
| run1 | 无注入 | 0 | 31s | 3 passed |
| run2 | 无注入 | 0 | 35s | 3 passed |
| run3 | 无注入 | 0 | 26s | 3 passed |
| run4 | 无注入 | 0 | 25s | 3 passed |
| run6 | 无注入，**与 4 份兄弟 e2e spec 并发** | 0 | 48s | 3 passed；兄弟 `exit=0`，9 passed |

⇒ 计 **5 次连续 `exit 0`**，其中一次为并发臂（`e2e/model-env-kind-explanations.spec.ts`、`e2e/ui-navigate.spec.ts`、`e2e/workspace-overflow-menu.spec.ts`、`e2e/sidebar-resize.spec.ts`，各自独立 invocation、独立 data-dir 与端口）。

**不计入的一轮（点名归因）**：run5 判据 `exit=0`（并发），但兄弟 invocation `1 failed 6 passed` —— `e2e/css-global-rules.spec.ts:145` 在 `beforeAll` 抛 `no token for the css-global-rules account`。归因：服务端是单用户系统（`server/modules/auth/auth.service.ts:69`：已有用户时 `register` 抛 403 `User already exists. This is a single-user system.`），而该 ad-hoc 组以 `e2e/ask-user-question-other-input.spec.ts` 起头，它注册了共享账号 `e2euser/e2epassword`；css-global-rules 的私有账号（`css-global-rules-e2e`）随后既注册不了（403）也登不进（401）。同组单独复跑复现同一行同一消息（`/tmp/ac315-ac3/group-alone.log` → `1 failed 6 passed`），与本任务 delta 无关；run6 因此改用四份共用 `e2euser` 的 spec，并先单独验证其绿（`/tmp/ac315-ac3/group2-alone.log`，exit 0，9 passed）再作并发臂。

### AC4 —— 判定面（合并 develop 后重取）

- `git diff develop --stat` → 只有 `e2e/voice-realtime-upload-fixture.spec.ts | 93 +++…`（**90 insertions(+), 3 deletions(-)**）；删除的三行只有旧注释与两处裸 `await page.reload();`。
- `git diff develop -- e2e/voice-realtime-upload-fixture.spec.ts | grep -c "^-.*expect("` → **0**；`grep -c "^+.*expect("` → **0**（无新增断言）。
- `git diff develop -- playwright.config.ts | wc -l` → **0**；`git diff develop -- goals/ | wc -l` → **0**。
- 判据命令逐字不变：`goals/AC-315-*.md:7-8` 与运行命令逐字一致（两条命令含 `&&`）。
- 既有实质断言原样：两处 `await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 })`、`expect.poll(() => paneText(page), …).toContain(PROPOSED_TEXT)`、`USER_ROW` 计数、`audioFrameCount` 增量、`mediaCallCount` 为 0 均未被触碰（改动只在两处 `await page.reload();` 一行之内替换为守卫调用，断言行字节不变）。

### AC5 —— 静态门

- `npm run typecheck` → `TYPECHECK_EXIT=0`（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 三个 project）。
- `npx oxlint e2e/voice-realtime-upload-fixture.spec.ts` → 1 条：`e2e/voice-realtime-upload-fixture.spec.ts:157:7: error eslint(no-unused-vars): Variable 'CRITERION_BUDGET_MS' is declared but never used.`；develop 版本同跑（`/tmp/ac315-spec-develop-postmerge.ts:157:7`）为**同一条、同一行** ⇒ 新增诊断 **0**（`CRITERION_BUDGET_MS` 是 develop 上既有的未使用声明）。

### 交付面

`git diff develop --stat` 只有 `e2e/voice-realtime-upload-fixture.spec.ts` 一个文件；worktree `git status --porcelain` 为空（注入已还原、无残留）；HEAD = `b953b8a4`（`25e6fb28` + `git merge --no-edit develop`）。
