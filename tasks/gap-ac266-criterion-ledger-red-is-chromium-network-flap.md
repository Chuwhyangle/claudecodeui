---
id: gap-ac266-criterion-ledger-red-is-chromium-network-flap
title: AC-266 台账尾红是浏览器级瞬时网络抖动（net::ERR_NETWORK_CHANGED）：同树 75d1ce58 上 16:18:44
  pass / 16:20:18 fail、净检出 3×绿（17.3s/16.5s/16.6s，首跳 attempt 1）、watchdog
  fired:false、node 侧 warm-up 正常而浏览器子资源全 ERR_NETWORK_CHANGED —— verification-only
  归因入档，不重实现既有修复
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-266
---
## Proposal

来源：本轮 gap-filing 的**直接现测 + 同树对照**（不是复述台账尾巴）。AC-266（`goals/AC-266-真实浏览器里设置页能管理已连接的应用与-oauth-客户端-吊销授权后该行消失-手工创建客户端时密钥只显示一次.md`，`status: achieved`；其 GOAL-021 已 `achieved`、不再活、未声明 `long-term: true`）被台账按 CURRENTLY FALSE 交办。

判据物（逐字取自该 goal 文件的 `criterion:`，逐字不改）：

```
for f in e2e/connected-apps-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/connected-apps-settings.spec.ts
```

**本轮直接现测：判据在净检出上 3/3 退出 0。** 在 `/data/home/yale/work/claudecodeui`（branch `author`；`git rev-parse HEAD` = `300e5fa93a269661132a4992f707e1197d608844`；`git rev-parse HEAD^{tree}` = `75d1ce58aa1c48679c296318851254be883e030a`；tracked 改动只有无关的 `.quay/config.yml`）连跑 3 次，读数逐字：

```
run1: 1 passed (17.3s)  exit 0
run2: 1 passed (16.5s)  exit 0   startup: the account form or the app shell landed after 2026ms (attempt 1); the app shell (Settings button) landed after 1102ms / 999ms (attempt 1)
run3: 1 passed (16.6s)  exit 0   startup: the account form or the app shell landed after 1985ms (attempt 1); the app shell (Settings button) landed after 1107ms / 1005ms (attempt 1)
```

三次都**首跳 attempt 1 即落地**，墙体 16.5–17.3s。

**为什么台账读 fail：一次浏览器级瞬时网络抖动（`net::ERR_NETWORK_CHANGED`），不是产品面为假、也不是判据设计缺陷。**

- **同树对照**：`.quay/gate-events.jsonl` 里 AC-266 的 `gate=goal` 尾巴逐字为 `2026-10-07T16:17:01.967Z goal-cli pass tree=75d1ce58…` → `2026-10-07T16:18:44.753Z goal-cli pass tree=75d1ce58…` → `2026-10-07T16:20:18.948Z goal-cli fail tree=75d1ce58…`（`payload.reason` 逐字前段 `acceptance failed (exit 1) — [WebServer] [BABEL] Note: …react-scan.js…`）。**pass 与 fail 的 `treeSha` 都是 `75d1ce58…` —— 正是本条直跑为绿的那棵树**，两分钟之差、同一棵树先 pass 后 fail，是抖动而非回归。窗口内 16:00–16:18 之间 AC-266 另有 10 次 `goal-cli pass`（16:00:15 / 16:01:33 / 16:03:03 / 16:04:36 / 16:05:54 / 16:07:19 / 16:09:02 / 16:10:39 / 16:12:06 / 16:13:32 / 16:15:17 / 16:17:01 / 16:18:44，逐字 `acceptance passed (exit 0)`）。
- **本次交办的触发**：`.quay/anchor.json` 的 `bundle.at` = `2026-10-07T16:20:19.207Z`，与末拍 fail `16:20:18.948Z` 同刻 —— 即「本轮 RE-RAN 直接测量」的那一拍。
- **失败运行自己的工件**（`~/.cache/quay-e2e-tmp/quay-e2e-YZr4zv/`，仍在盘上）：`test-results/connected-apps-settings-co-945fc-whose-token-is-then-refused/error-context.md` 逐字 `Error: the account form or the app shell never rendered, so this run's client never came up to a document that stays: the page shows ""; console errors: Failed to load resource: net::ERR_NETWORK_CHANGED | …(×5); failed requests: http://127.0.0.1:28895/src/modules/sidebar/SessionFilterEditor.tsx — net::ERR_NETWORK_CHANGED | …groupSessionsByLineage.ts | …useSidebarResize.ts | …SidebarFooter.tsx | …SidebarHeader.tsx — net::ERR_NETWORK_CHANGED`。
- **不是服务器死、也不是判据的固定预算不够**：同目录 `test.trace` 显示 **node 侧 `warmClientStartup` 成功**（`[e2e] client warm-up: pre-bundle committed in 4580ms`，即 `/`、`/src/main.tsx`、优化依赖都从同一个 Vite 服务器 200），浏览器 `Navigate \"/\"` 也完成（~1.1s）；随后 `appears(#username)` 8s 超时、`appears(Settings)` 再 8s 超时，红落在 `navigateBounded`（`e2e/connected-apps-settings.spec.ts:203`）。**node fetch 同源成功、浏览器子资源全 `ERR_NETWORK_CHANGED`** ⇒ 故障在浏览器网络栈的一次网络变更事件，不在服务端，也不在判据的探测预算（`navigateBounded` 本来就有界重放：`STARTUP_PROBE_DEADLINE_MS = 14_000`）。
- **不是被自己的天花板杀的**：同目录 `watchdog-state.json` 逐字 `{\"armed\":true,\"fired\":false,\"ceilingMs\":55000,\"detail\":\"boot 40000ms, re-armed to 55000ms once past boot\"}` —— 55s 运行天花板未触发，运行是自己按守卫失败收尾的（与内存 `suite-red-*` 一族「负载假红」同判法；同族先例 `gap-ac199-criterion-ledger-red-is-silent-e2e-death` 是**无测试输出的静默死**，本条是**有逐字守卫失败的可读死**，但同为宿主级瞬时故障）。

**上一次修复没有失效。** 认领 AC-266 的实现任务 `gap-ac266-connected-apps-settings-browser-ui`（`status: done`）交付的 UI/接口/e2e 仍在：判据文件在场、`/mcp` 200→401、一次性密钥刷新后 0 命中、禁用后 401 等读数在本轮 3 次直跑里逐字复现。台账那拍 fail 与那些实现无关，只与那一瞬的浏览器网络状态有关。

要交付：**verification-only 归因入档** —— 把「净检出满足 AC-266」与「台账尾红是浏览器级瞬时网络抖动」两件事按可复现命令逐字入档；**不改判据、不改实现、不动 `goals/**`**。判据本体（`e2e/connected-apps-settings.spec.ts`）与既有实现一个字节不改，只重跑与取证。

<!-- dedup-ref -->
机制去重复核：`grep -l "^goal_ac: *AC-266" tasks/*.md` 立案前只命中 `tasks/gap-ac266-connected-apps-settings-browser-ui.md`（`status: done`，认领 AC-266 的唯一实现任务）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-266`）**0 命中**；此前**没有**任何任务把 AC-266 的台账红归因。「浏览器级瞬时网络抖动 / ERR_NETWORK_CHANGED」这一机制在任务库无命中。同族归因先例 `gap-ac199-criterion-ledger-red-is-silent-e2e-death`、`gap-ac156-criterion-ledger-red-is-undici-bad-port-lottery`、`gap-ac153-ledger-red-is-host-quota`、`gap-ac135/178/244/245/246/247/249/250/269-criterion-ledger-red-is-merge-race` 各为**另一条** AC，机制相同但 AC 不同。本条只归因，不重新实现既有修复。

残留未钉死假设（如实登记）：本条证「判据在净检出上为真」+「台账尾红是瞬时浏览器网络抖动」；它**证不了**抖动不再复发 —— 抖动是宿主/浏览器网络栈事件，不在判据控制范围内。若该红在静默态复现，应停手上报按缺陷另立（见 DoD 末条）。

## AC

- [x] AC1 判据在**净检出**直跑 ≥3 次全部退出 **0**：命令 `for f in e2e/connected-apps-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/connected-apps-settings.spec.ts`（逐字不改），逐次登记 `passed/N`、墙体秒数与退出码；并登记 `git rev-parse HEAD` 与 `git rev-parse HEAD^{tree}`。红态基线（立案读数）：末拍 `2026-10-07T16:20:18.948Z` `verdict: fail`，`treeSha=75d1ce58aa1c48679c296318851254be883e030a`。
- [x] AC2 失败运行**自己的工件**逐字入档（不读台账 reason 下结论）：登记失败 run 的数据目录、`test-results/*/error-context.md` 的整段 Error（含 `net::ERR_NETWORK_CHANGED` 的 5 条 console error 与 5 条 failed request）、`watchdog-state.json` 逐字（须 `fired:false`）、`test.trace` 里 `client warm-up: pre-bundle committed …ms`、`Navigate \"/\"` 的完成时刻、两次 `appears` 的 8s 超时与红落点行号（`navigateBounded`）。
- [x] AC3 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-266`、`gate=goal` 的末三拍（两 pass + 末拍 fail）逐字（`timestamp`/`actor`/`verdict`/`payload.treeSha`/`payload.reason`），并抄出 `16:00–16:18` 之间的 10+ 次 `goal-cli pass`；写明**pass 与 fail 的 `treeSha` 相同**（`75d1ce58…`）。附 `.quay/anchor.json` 的 `bundle.at=2026-10-07T16:20:19.207Z` 与末拍 fail 同刻。
- [x] AC4 机制去重复核：`grep -l "^goal_ac: *AC-266" tasks/*.md` 的命中集合与各自 `status:` 逐字入档（立案前只 `gap-ac266-connected-apps-settings-browser-ui`，done；本条自身写出后为第 2 条，须按内存 `retirement-grep-criterion-matches-its-own-obituary` 排除自身读）；在飞扫描 0 命中。
- [x] AC5 承重面未被本条触碰：`git diff --name-only develop...HEAD -- e2e server src goals playwright.config.ts` **为空**；未 `stash`、未 `git checkout --`、未编辑 `e2e/connected-apps-settings.spec.ts` 与任何 `server/**`、`src/**`、`goals/**`；交付物只动 `tasks/<本条 id>.md`（经 `task_write`）。
- [x] AC6 如实登记：完成记录逐字写明「**净检出满足 AC-266**（3 次直跑 exit 0，逐次墙体）」与「台账末拍红由**浏览器级瞬时网络抖动**（node 侧 warm-up 成功、浏览器子资源全 `ERR_NETWORK_CHANGED`、watchdog `fired:false`、同树 16:18:44 pass / 16:20:18 fail）造成」，并登记残留未钉死假设；不得用「接口存在/组件存在」替代判据本体读数。

## DoD

- 出货判据命令（`for f in e2e/connected-apps-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/connected-apps-settings.spec.ts`，逐字不改；不改断言、不改判据、不改实现）在检出上真的跑过、退出 0，逐次的 `passed/墙体` 与退出码入档 —— 不是复述 AC 文字，不是读台账尾巴。
- 归因的每一条读数（同树 pass/fail 的 `treeSha`、失败 run 的 `error-context.md` 整段、`watchdog-state.json`、`test.trace` 的 node warm-up 成功 vs 浏览器 `ERR_NETWORK_CHANGED`、`anchor.json` 的 `bundle.at`）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「既有实现有效；台账末拍 fail 是浏览器级瞬时网络抖动，不是回归」**，并给出残留未钉死假设（抖动不在判据控制内、可能复发）。
- 交付物只动 `tasks/<本条 id>.md`：判据、实现、`goals/**`、工作树一个字节未动。
- 若直跑为**红**（即判据在净检出上也稳定红），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」—— 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- tasks/gap-ac266-criterion-ledger-red-is-chromium-network-flap.md（自触）
- e2e/connected-apps-settings.spec.ts（本条只跑不改：判据本体，含 `warmClientStartup`/`navigateBounded` 守卫）
- playwright.config.ts（本条只读不改：`watchdog-state.json` / 运行天花板的读数来源）
- goals/AC-266-真实浏览器里设置页能管理已连接的应用与-oauth-客户端-吊销授权后该行消失-手工创建客户端时密钥只显示一次.md（本条只读不改：`criterion:` / `expect:` 逐字来源）

## Evidence

### 立案读数（filing baseline，逐字保留）

**立案读数（本轮现测，逐字）。** `git rev-parse HEAD` = `300e5fa93a269661132a4992f707e1197d608844`；`git rev-parse HEAD^{tree}` = `75d1ce58aa1c48679c296318851254be883e030a`。3 次直跑：`1 passed (17.3s)` / `1 passed (16.5s)` / `1 passed (16.6s)`，均 exit 0；后两次 startup 逐字 `the account form or the app shell landed after 2026ms / 1985ms (attempt 1)`、`the app shell (Settings button) landed after 1102ms / 999ms / 1107ms / 1005ms (attempt 1)`。

**末拍红（台账逐字）。** `2026-10-07T16:20:18.948Z actor=goal-cli item_id=AC-266 verdict=fail payload.treeSha=75d1ce58aa1c48679c296318851254be883e030a payload.reason="acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-YZr4zv/vite-cache/deps/react-scan.js?v=822fa4d7 as it exceeds the max of 500KB."`；紧前两拍 `16:17:01.967Z` / `16:18:44.753Z` 同为 `verdict=pass`、同 `treeSha`。

**失败 run 工件（逐字）。** 数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-YZr4zv/`；`watchdog-state.json` = `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}`；`error-context.md` 整段见 Proposal；`test.trace` 序列：`[e2e] client warm-up: pre-bundle committed in 4580ms` → `Navigate "/"`（~1.1s）→ `locator('#username') waitFor Timeout 8000ms exceeded` → `Settings button waitFor Timeout 8000ms exceeded` → 红落 `connected-apps-settings.spec.ts:203`（`navigateBounded`）。

**判法。** 同树（`75d1ce58…`）两分钟内先 pass 后 fail、净检出 3/3 绿且首跳即落地、watchdog 未触发、node 侧 warm-up 成功而浏览器子资源全 `ERR_NETWORK_CHANGED` ⇒ 台账尾红是**浏览器级瞬时网络抖动**，既有实现有效。本条 verification-only，不重实现。

### 本条归因复核（verification，本轮现测）

#### AC1 — 判据在净检出直跑（真实 chromium，浏览器层）

worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac266-criterion-ledger-red-is-chromium-network-flap`。
开工快照：`git rev-parse HEAD` = `c367f16893f1f3e0df9761c31166727cb41c036e`；`git rev-parse HEAD^{tree}` = `7e095f64b3b218eeb40fe9031bcf037e55f2f784`（== 开工时 `develop`）；`git status --porcelain` 空。

出货命令逐字不改：

```
for f in e2e/connected-apps-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/connected-apps-settings.spec.ts
```

净检出直跑 3 次（真实 chromium）：

```
RUN 1 start=2026-10-08T00:27:52+08:00 EXIT=0 WALL=17133ms   1 passed (16.3s)
RUN 2 start=2026-10-08T00:28:09+08:00 EXIT=0 WALL=17401ms   1 passed (16.7s)
RUN 3 start=2026-10-08T00:28:27+08:00 EXIT=0 WALL=17489ms   1 passed (16.7s)
```

三次都**首跳 attempt 1 即落地**；node 侧 warm-up `pre-bundle committed in 4016ms / 3981ms / 3962ms`。产品读数逐字（三次一致）：`(a) connected-app rows = 2`；`(e) PAT rows = 0; the advanced OAuth section is collapsed (aria-expanded=false, data-state=closed)`；`(b) /mcp with the preset token -> 200 before revoke, 401 after; connected-app rows 2 -> 1`；`(b) after reload: rows for the revoked grant = 0, for the untouched grant = 1`；`(c) POST /api/oauth/clients -> 201; … the alert shows the same secret as the response = true`；`(c) after reload: secret hits in content=0, body.innerText=0, localStorage=0, sessionStorage=0`；`(d) /mcp with the client's grant token -> 200 before disabling, 401 after`。

**红态基线树直跑（同树对照）。** 同一 worktree `git checkout 300e5fa93a269661132a4992f707e1197d608844`（`git rev-parse 300e5fa9^{tree}` = `75d1ce58aa1c48679c296318851254be883e030a`，**正是末拍 fail 的 `payload.treeSha`**）：

```
REDTREE HEAD=300e5fa9… TREE=75d1ce58…
REDTREE RUN 1 start=2026-10-08T00:28:55+08:00 EXIT=0 WALL=17239ms   1 passed (16.5s)
REDTREE RUN 2 start=2026-10-08T00:29:12+08:00 EXIT=0 WALL=16845ms   1 passed (16.1s)
```

两跑皆 attempt 1；跑完 `git checkout task/gap-ac266-criterion-ledger-red-is-chromium-network-flap` 复原 → `HEAD=c367f168… TREE=7e095f64…`，`git status --porcelain` 空。

**红树与当前树的同一性（机械复算）。**

```
git diff --name-only 300e5fa9 develop -- e2e server src playwright.config.ts package.json package-lock.json   → 空
git diff --name-only 300e5fa9 develop                                                                         → 只有 tasks/gap-ac266-criterion-ledger-red-is-chromium-network-flap.md（本条自身）
```

⇒ 台账判红的那棵树（`75d1ce58`）与当前树（`7e095f64`）**除本条任务文件外逐字相同**；判据文件 blob `50322741fc27cf5bf07471e525dfd0a8abe6f547`、`playwright.config.ts` blob `b91ab1b65c7953ed94bd16afe478ff658b6d2c92` 在两棵树上逐字相同。该树在两处净检出上共 **5 跑皆绿**（17.1s/17.4s/17.5s/17.2s/16.8s）⇒ 红不是产品回归。

#### AC2 — 失败 run 自己的工件（本 run 自己的产物，非台账 reason）

数据目录（仍在盘上）：`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-YZr4zv/`（本地 mtime `2026-10-08 00:19–00:20` = UTC `2026-10-07 16:19–16:20`；run `wallTime=1791389996863` = `2026-10-07T16:19:56.863Z`）。

`test-results/connected-apps-settings-co-945fc-whose-token-is-then-refused/error-context.md` 整段 Error（逐字；`Location: e2e/connected-apps-settings.spec.ts:386:3`）：

```
Error: the account form or the app shell never rendered, so this run's client never came up to a document that stays: the page shows ""; console errors: Failed to load resource: net::ERR_NETWORK_CHANGED | Failed to load resource: net::ERR_NETWORK_CHANGED | Failed to load resource: net::ERR_NETWORK_CHANGED | Failed to load resource: net::ERR_NETWORK_CHANGED | Failed to load resource: net::ERR_NETWORK_CHANGED; failed requests: http://127.0.0.1:28895/src/modules/sidebar/SessionFilterEditor.tsx — net::ERR_NETWORK_CHANGED | http://127.0.0.1:28895/src/modules/sidebar/utils/groupSessionsByLineage.ts — net::ERR_NETWORK_CHANGED | http://127.0.0.1:28895/src/modules/sidebar/hooks/useSidebarResize.ts — net::ERR_NETWORK_CHANGED | http://127.0.0.1:28895/src/modules/sidebar/SidebarFooter.tsx — net::ERR_NETWORK_CHANGED | http://127.0.0.1:28895/src/modules/sidebar/SidebarHeader.tsx — net::ERR_NETWORK_CHANGED
```

（console error ×5、failed request ×5，**全为 `net::ERR_NETWORK_CHANGED`**。）

`watchdog-state.json` 逐字：

```
{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}
```

⇒ `fired:false`：55s 运行天花板未触发，运行自己按守卫失败收尾。

`test.trace` 序列（逐字，时间戳单位 ms）：

```
stdout  9614.1    [e2e] client warm-up: pre-bundle committed in 4580ms      ← node 侧同源 warm-up 成功
Navigate "/"     start 9670.365  → end 10763.875   (1093.5ms，~1.1s，完成)
Wait #username   start 10766.281 → end 18774.402   (8008.1ms)  TimeoutError: locator.waitFor: Timeout 8000ms exceeded
Wait Settings    start 18775.734 → end 26777.448   (8001.7ms)  TimeoutError: locator.waitFor: Timeout 8000ms exceeded
error            navigateBounded @ e2e/connected-apps-settings.spec.ts:203:15（调用点 :336:5）
```

⇒ node fetch 同源成功（`/`、`/src/main.tsx`、优化依赖都从同一个 Vite 服务器 200）而**浏览器子资源全 `ERR_NETWORK_CHANGED`**；红落在 `navigateBounded` 的 `STARTUP_PROBE_DEADLINE_MS` 上 —— 不是服务端死，也不是判据预算不够。

#### AC3 — 台账尾巴（逐字）

`.quay/gate-events.jsonl` 行数 **109805**（mtime `2026-10-08 00:27:12.871 +0800`）；`item_id=AC-266` ∧ `gate=goal` 共 **128** 条。**末三拍**（逐字）：

```
2026-10-07T16:17:01.967Z actor=goal-cli verdict=pass treeSha=75d1ce58aa1c48679c296318851254be883e030a reason="acceptance passed (exit 0)"
2026-10-07T16:18:44.753Z actor=goal-cli verdict=pass treeSha=75d1ce58aa1c48679c296318851254be883e030a reason="acceptance passed (exit 0)"
2026-10-07T16:20:18.948Z actor=goal-cli verdict=fail treeSha=75d1ce58aa1c48679c296318851254be883e030a reason="acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-YZr4zv/vite-cache/deps/react-scan.js?v=822fa4d7 as it exceeds the max of 500KB."
```

**pass 与 fail 的 `payload.treeSha` 相同，都是 `75d1ce58aa1c48679c296318851254be883e030a`** —— 两分钟之差、同一棵树先 pass 后 fail。

`16:00–16:18` 之间的 `goal-cli pass`（逐字时间戳，共 **12** 条，均 `verdict=pass treeSha=75d1ce58… reason="acceptance passed (exit 0)"`）：

```
16:00:15.068Z 16:01:33.698Z 16:03:03.859Z 16:04:36.392Z 16:05:54.891Z 16:07:19.338Z
16:09:02.498Z 16:10:39.974Z 16:12:06.320Z 16:13:32.858Z 16:15:17.528Z 16:17:01.967Z
```

**触发交办的锚** `.quay/anchor.json`：立案时 `bundle.at=2026-10-07T16:20:19.207Z`，与末拍 fail `16:20:18.948Z` 同刻（该读数记于本条任务文件立案提交 `0abcd972` 与 `.quay/goal-round.jsonl` round-885 的 `gap_spawns.stdout`）。⚠️ `anchor.json` 是**可变单例**（未被 git 跟踪）：复核时盘上读数为 `"at":"2026-10-07T16:29:45.128Z"`（anchor driver 已重写）；立案值只能从上述两处存档复得，不能再从盘上读出。

末拍 fail 的 goal 侧记录（`.quay/goal-round.jsonl` round-885 `frozenRecheck.entries[0]`，逐字字段）：`ac=AC-266 verdict=fail durationMs=27959 hostFreeBytes=2459996160 load1=11.9 headSha=300e5fa93a269661132a4992f707e1197d608844 behindDevelop=0 outcome=confirmed-failing cause=still-false`（`durationMs≈27.96s` 与 `test.trace` 的 ~26.9s 收尾一致）。

**尾巴已被 driver 重判为 pass（写本条时）**：末拍 fail 之后 goal driver 又重跑两次，均 pass：

```
2026-10-07T16:27:34.475Z goal-cli pass tree=7e095f64b3b218eeb40fe9031bcf037e55f2f784 reason="acceptance passed (exit 0)"
2026-10-07T16:29:10.305Z goal-cli pass tree=7e095f64b3b218eeb40fe9031bcf037e55f2f784 reason="acceptance passed (exit 0)"
```

#### AC4 — 机制去重（逐字）

```
grep -l "^goal_ac: *AC-266" tasks/*.md
  → tasks/gap-ac266-connected-apps-settings-browser-ui.md             :: status: done
  → tasks/gap-ac266-criterion-ledger-red-is-chromium-network-flap.md  :: status: ready   ← 本条自身
```

按内存 `retirement-grep-criterion-matches-its-own-obituary` 排除本条自身 → 唯一既有认领者 = `gap-ac266-connected-apps-settings-browser-ui`（`done`，认领 AC-266 的唯一实现任务），**非重复**。在飞扫描（`^status:` ∈ {todo,ready,needs-human} ∧ `^goal_ac: *AC-266`）排除本条自身 → **0 命中**。机制「浏览器级瞬时网络抖动 / `ERR_NETWORK_CHANGED`」在任务库无既有认领；同族先例 `gap-ac199…silent-e2e-death`、`…undici-bad-port-lottery`、`…host-quota`、`merge-race` 集各为**另一条** AC。

#### AC5 — 承重面未被触碰

```
git -C <worktree> diff --name-only develop...HEAD -- e2e server src goals playwright.config.ts   → 空
git -C <worktree> status --porcelain                                                              → 空
```

未 `stash`、未 `git checkout --`（仅一次临时 `git checkout 300e5fa9` 直跑红树并已复原，见 AC1）、未编辑任何 `e2e/**`、`playwright.config.ts`、`server/**`、`src/**`、`goals/**`。e2e 运行会由判据自身写出 `artifacts/gap-settings-access-tokens-dod-oauth-{collapsed,expanded}.png`（未跟踪副产品），跑完已清除，worktree 复原为**空 delta**。本条唯一写入是 `tasks/gap-ac266-criterion-ledger-red-is-chromium-network-flap.md`（经 `task_write`）。

#### AC6 — 判法 + 残留未钉死假设

**判法（逐字结论）：既有实现有效；台账末拍 fail 是浏览器级瞬时网络抖动（`net::ERR_NETWORK_CHANGED`），不是回归。** 证据链：同树 `75d1ce58` 两分钟内先 pass 后 fail（pass/fail 同 `treeSha`）→ 该树在净检出上 5 跑皆绿（首跳 attempt 1）→ 失败 run 自己的 `test.trace` 显示 node 侧 warm-up 成功（`pre-bundle committed in 4580ms`）而**浏览器子资源全 `ERR_NETWORK_CHANGED`**、`watchdog fired:false` → 红落 `navigateBounded`（有界重放，`STARTUP_PROBE_DEADLINE_MS=14000`），非服务端死、非判据预算不足 → 台账尾巴此后被 driver 重判为 pass ×2。

**残留未钉死假设（如实登记）：**

1. 本条证「判据在净检出上为真」+「台账尾红是瞬时浏览器网络抖动」；**证不了**抖动不再复发。抖动是宿主/浏览器网络栈事件，不在判据控制范围内。
2. 失败那次 goal 侧还记到 `hostFreeBytes=2459996160`（≈2.46 GB free）与 `load1=11.9`；这是**相关性**读数，**未**钉死「内存压力/负载 → 浏览器网络栈抖动」的因果（也可能是宿主网络接口变更事件，与负载无关）。⛔ 不得用「负载」一句抹掉其它候选。
3. 复核期间（本地 00:27–00:30）宿主 `load1` 13.3–13.6、`free` ~25 GB，5 跑仍皆绿 ⇒ 高负载本身**不充分**触发该抖动。

**若该红在静默态复现**：按 DoD 末条停手上报，置 `needs-human`、按缺陷另立；⛔ 不得据此改断言、不得把环境红写成产品绿。**本条未触发该分支（净检出全绿）。**
