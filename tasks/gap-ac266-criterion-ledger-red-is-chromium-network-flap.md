---
id: gap-ac266-criterion-ledger-red-is-chromium-network-flap
title: AC-266 台账尾红是浏览器级瞬时网络抖动（net::ERR_NETWORK_CHANGED）：同树 75d1ce58 上 16:18:44
  pass / 16:20:18 fail、净检出 3×绿（17.3s/16.5s/16.6s，首跳 attempt 1）、watchdog
  fired:false、node 侧 warm-up 正常而浏览器子资源全 ERR_NETWORK_CHANGED —— verification-only
  归因入档，不重实现既有修复
status: ready
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
- **不是服务器死、也不是判据的固定预算不够**：同目录 `test.trace` 显示 **node 侧 `warmClientStartup` 成功**（`[e2e] client warm-up: pre-bundle committed in 4580ms`，即 `/`、`/src/main.tsx`、优化依赖都从同一个 Vite 服务器 200），浏览器 `Navigate "/"` 也完成（~1.1s）；随后 `appears(#username)` 8s 超时、`appears(Settings)` 再 8s 超时，红落在 `navigateBounded`（`e2e/connected-apps-settings.spec.ts:203`）。**node fetch 同源成功、浏览器子资源全 `ERR_NETWORK_CHANGED`** ⇒ 故障在浏览器网络栈的一次网络变更事件，不在服务端，也不在判据的探测预算（`navigateBounded` 本来就有界重放：`STARTUP_PROBE_DEADLINE_MS = 14_000`）。
- **不是被自己的天花板杀的**：同目录 `watchdog-state.json` 逐字 `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}` —— 55s 运行天花板未触发，运行是自己按守卫失败收尾的（与内存 `suite-red-*` 一族「负载假红」同判法；同族先例 `gap-ac199-criterion-ledger-red-is-silent-e2e-death` 是**无测试输出的静默死**，本条是**有逐字守卫失败的可读死**，但同为宿主级瞬时故障）。

**上一次修复没有失效。** 认领 AC-266 的实现任务 `gap-ac266-connected-apps-settings-browser-ui`（`status: done`）交付的 UI/接口/e2e 仍在：判据文件在场、`/mcp` 200→401、一次性密钥刷新后 0 命中、禁用后 401 等读数在本轮 3 次直跑里逐字复现。台账那拍 fail 与那些实现无关，只与那一瞬的浏览器网络状态有关。

要交付：**verification-only 归因入档** —— 把「净检出满足 AC-266」与「台账尾红是浏览器级瞬时网络抖动」两件事按可复现命令逐字入档；**不改判据、不改实现、不动 `goals/**`**。判据本体（`e2e/connected-apps-settings.spec.ts`）与既有实现一个字节不改，只重跑与取证。

<!-- dedup-ref -->
机制去重复核：`grep -l "^goal_ac: *AC-266" tasks/*.md` 立案前只命中 `tasks/gap-ac266-connected-apps-settings-browser-ui.md`（`status: done`，认领 AC-266 的唯一实现任务）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-266`）**0 命中**；此前**没有**任何任务把 AC-266 的台账红归因。「浏览器级瞬时网络抖动 / ERR_NETWORK_CHANGED」这一机制在任务库无命中。同族归因先例 `gap-ac199-criterion-ledger-red-is-silent-e2e-death`、`gap-ac156-criterion-ledger-red-is-undici-bad-port-lottery`、`gap-ac153-ledger-red-is-host-quota`、`gap-ac135/178/244/245/246/247/249/250/269-criterion-ledger-red-is-merge-race` 各为**另一条** AC，机制相同但 AC 不同。本条只归因，不重新实现既有修复。

残留未钉死假设（如实登记）：本条证「判据在净检出上为真」+「台账尾红是瞬时浏览器网络抖动」；它**证不了**抖动不再复发 —— 抖动是宿主/浏览器网络栈事件，不在判据控制范围内。若该红在静默态复现，应停手上报按缺陷另立（见 DoD 末条）。

## AC

- [ ] AC1 判据在**净检出**直跑 ≥3 次全部退出 **0**：命令 `for f in e2e/connected-apps-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/connected-apps-settings.spec.ts`（逐字不改），逐次登记 `passed/N`、墙体秒数与退出码；并登记 `git rev-parse HEAD` 与 `git rev-parse HEAD^{tree}`。红态基线（立案读数）：末拍 `2026-10-07T16:20:18.948Z` `verdict: fail`，`treeSha=75d1ce58aa1c48679c296318851254be883e030a`。
- [ ] AC2 失败运行**自己的工件**逐字入档（不读台账 reason 下结论）：登记失败 run 的数据目录、`test-results/*/error-context.md` 的整段 Error（含 `net::ERR_NETWORK_CHANGED` 的 5 条 console error 与 5 条 failed request）、`watchdog-state.json` 逐字（须 `fired:false`）、`test.trace` 里 `client warm-up: pre-bundle committed …ms`、`Navigate "/"` 的完成时刻、两次 `appears` 的 8s 超时与红落点行号（`navigateBounded`）。
- [ ] AC3 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-266`、`gate=goal` 的末三拍（两 pass + 末拍 fail）逐字（`timestamp`/`actor`/`verdict`/`payload.treeSha`/`payload.reason`），并抄出 `16:00–16:18` 之间的 10+ 次 `goal-cli pass`；写明**pass 与 fail 的 `treeSha` 相同**（`75d1ce58…`）。附 `.quay/anchor.json` 的 `bundle.at=2026-10-07T16:20:19.207Z` 与末拍 fail 同刻。
- [ ] AC4 机制去重复核：`grep -l "^goal_ac: *AC-266" tasks/*.md` 的命中集合与各自 `status:` 逐字入档（立案前只 `gap-ac266-connected-apps-settings-browser-ui`，done；本条自身写出后为第 2 条，须按内存 `retirement-grep-criterion-matches-its-own-obituary` 排除自身读）；在飞扫描 0 命中。
- [ ] AC5 承重面未被本条触碰：`git diff --name-only develop...HEAD -- e2e server src goals playwright.config.ts` **为空**；未 `stash`、未 `git checkout --`、未编辑 `e2e/connected-apps-settings.spec.ts` 与任何 `server/**`、`src/**`、`goals/**`；交付物只动 `tasks/<本条 id>.md`（经 `task_write`）。
- [ ] AC6 如实登记：完成记录逐字写明「**净检出满足 AC-266**（3 次直跑 exit 0，逐次墙体）」与「台账末拍红由**浏览器级瞬时网络抖动**（node 侧 warm-up 成功、浏览器子资源全 `ERR_NETWORK_CHANGED`、watchdog `fired:false`、同树 16:18:44 pass / 16:20:18 fail）造成」，并登记残留未钉死假设；不得用「接口存在/组件存在」替代判据本体读数。

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

**立案读数（本轮现测，逐字）。** `git rev-parse HEAD` = `300e5fa93a269661132a4992f707e1197d608844`；`git rev-parse HEAD^{tree}` = `75d1ce58aa1c48679c296318851254be883e030a`。3 次直跑：`1 passed (17.3s)` / `1 passed (16.5s)` / `1 passed (16.6s)`，均 exit 0；后两次 startup 逐字 `the account form or the app shell landed after 2026ms / 1985ms (attempt 1)`、`the app shell (Settings button) landed after 1102ms / 999ms / 1107ms / 1005ms (attempt 1)`。

**末拍红（台账逐字）。** `2026-10-07T16:20:18.948Z actor=goal-cli item_id=AC-266 verdict=fail payload.treeSha=75d1ce58aa1c48679c296318851254be883e030a payload.reason="acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-YZr4zv/vite-cache/deps/react-scan.js?v=822fa4d7 as it exceeds the max of 500KB."`；紧前两拍 `16:17:01.967Z` / `16:18:44.753Z` 同为 `verdict=pass`、同 `treeSha`。

**失败 run 工件（逐字）。** 数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-YZr4zv/`；`watchdog-state.json` = `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}`；`error-context.md` 整段见 Proposal；`test.trace` 序列：`[e2e] client warm-up: pre-bundle committed in 4580ms` → `Navigate "/"`（~1.1s）→ `locator('#username') waitFor Timeout 8000ms exceeded` → `Settings button waitFor Timeout 8000ms exceeded` → 红落 `connected-apps-settings.spec.ts:203`（`navigateBounded`）。

**判法。** 同树（`75d1ce58…`）两分钟内先 pass 后 fail、净检出 3/3 绿且首跳即落地、watchdog 未触发、node 侧 warm-up 成功而浏览器子资源全 `ERR_NETWORK_CHANGED` ⇒ 台账尾红是**浏览器级瞬时网络抖动**，既有实现有效。本条 verification-only，不重实现。