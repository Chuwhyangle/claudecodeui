---
id: gap-ac228-criterion-startup-guard-cannot-afford-a-replay
title: AC-228 判据启动守卫的预算算不过来：e2e/access-tokens-settings.spec.ts 的
  STARTUP_PROBE_DEADLINE_MS=14_000 < 首跳 8_000 + FIRST_LANDING 两次 appears 各 8_000
  ⇒ attempt
  2（page.reload）是死代码；浏览器级瞬时网络抖动（net::ERR_NETWORK_CHANGED）本可由一次重放自愈，却成硬红（同树
  bfd79a71 上 3/3 直跑绿、台账 20 连 pass 后 1 拍 fail）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-228
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（判据物 + 同树台账 + 失败跑自己的工件 + 静默态三次直跑 + 判据文件的静态算式），不是复述台账尾巴。

判据物（逐字取自 `goals/AC-228-真实浏览器里设置页能创建个人访问令牌-明文只显示一次-刷新后只剩前缀-吊销后消失-旧的-api-key-创建入口不再存在.md` 的 `criterion:`，逐字不改）：

```
for f in e2e/access-tokens-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/access-tokens-settings.spec.ts
```

AC 状态：`goals/AC-228-*.md` 记 `status: achieved`；其 GOAL-018 已 achieved、已离开 reverify 范围、且未声明 `long-term: true`；台账最近一拍为 fail ⇒ 按 CURRENTLY FALSE 立案。

**（1）本轮直接现测：判据在 HEAD 树上 3/3 退出 0，且 HEAD 树正是末拍 fail 的同一 `treeSha`。**

- `git rev-parse HEAD` = `0fb38c653453602dadc835a1af36b0df11accf0e`；`git rev-parse HEAD^{tree}` = `bfd79a71d5fdab9e4021fe58f322ae6a5448dc2b`。
- 判据物逐字直跑 3 次：`1 passed (21.8s)` / `1 passed (20.6s)` / `1 passed (21.8s)`，均 `EXIT=0`。产品读数逐字齐：(a) `POST /api/settings/access-tokens -> 201; plaintext matches ccp_<64 hex> = true`；(b) `after reload: plaintext hits in content = 0, in body.innerText = 0, in localStorage = false, in sessionStorage = false; row shows prefix "ccp_674d"`；(c) `option values = ["7","30","90"]; default = 30`；(d) `token-info with the live token -> 200`、`after revoke: id=1 row still present and marked Revoked; token-info -> 401`；(e) `body.innerText contains "New API Key" = false; contains "api-docs.html" = false; anchors to it = 0`。
- **末拍 fail 的 `payload.treeSha` = `bfd79a71d5fdab9e4021fe58f322ae6a5448dc2b` —— 与本轮直跑为绿的 HEAD 树逐字相同。** 同一棵树，driver 拍红、本条拍绿。

**（2）台账尾巴是同树 flake 签名，不是产品退化。** `.quay/gate-events.jsonl` 里 AC-228 `gate=goal` 的最近 20 拍：`2026-10-10T01:27:05.469Z`→`03:35:29.710Z` 连续 **20 次** `verdict=pass`（`acceptance passed (exit 0)`），末拍 `2026-10-10T03:40:16.800Z` **fail**，`payload.treeSha=bfd79a71d5fdab9e4021fe58f322ae6a5448dc2b`，`payload.reason` 逐字 `acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-Rf36Aj/vite-cache/deps/react-scan.js?v=5731b542 as it exceeds the max of 500KB.`。触发：`.quay/anchor.json` 的 `bundle.at=2026-10-10T03:40:34.018Z`，与末拍 fail `03:40:16.800Z` 同刻。

**（3）红不在设置页任何断言上 —— 死在 beforeAll 的启动守卫里；红因是瞬时浏览器网络抖动，而守卫本可自愈却没有重放可走。** 失败跑自己的数据目录 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-Rf36Aj/`：

- `test-results/access-tokens-settings-per-305e9-evocation-really-rejects-it/error-context.md` 逐字：`Error: the account form or the app shell never rendered, so this run's client never came up to a document that stays: the page shows ""; console errors: Failed to load resource: net::ERR_NETWORK_CHANGED | …(×5); failed requests: http://127.0.0.1:26419/src/modules/i18n/locales/zh-CN/auth.json?import — net::ERR_NETWORK_CHANGED | …sidebar.json | …chat.json | …codeEditor.json | …tasks.json — net::ERR_NETWORK_CHANGED`。跑点 `Location: e2e/access-tokens-settings.spec.ts:373:3`，抛点在 `navigateBounded` 的预算耗尽分支（`:167`）。
- `watchdog-state.json` 逐字 `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}` ⇒ 55s 运行天花板未触发，运行自己按守卫失败收尾。
- **node 侧预热成功**（同目录 `vite-cache` 在场、`[e2e] client warm-up: pre-bundle committed`），但浏览器子资源整批 `net::ERR_NETWORK_CHANGED` ⇒ 故障在浏览器网络栈的一次网络变更事件（宿主 netlink / docker-veth 一族），不在服务端，也不在判据的断言面。

**（4）机制（本条承重的静态读数）：守卫的预算算不过来，attempt ≥2（`page.reload`）是死代码。**

`e2e/access-tokens-settings.spec.ts` 常数逐字（`grep -n`）：`STARTUP_PROBE_MS = 8_000`（`:29`）、`STARTUP_RELOAD_PROBE_MS = 3_000`（`:31`）、`NAVIGATION_PROBE_MS = 8_000`（`:33`）、`STARTUP_PROBE_DEADLINE_MS = 14_000`（`:35`）。`navigateBounded`（`:145`）逐字算，两种情形都不重放：

- 首跳 `page.goto`（`:153`）用满 `8_000` ⇒ `budgetMs()=6_000` ⇒ 落点预算 `min(8_000,6_000)=6_000`；而 `FIRST_LANDING.present`（`:179-180`）是 `appears(#username,budget) || appears(Settings,budget)` —— 两次各用满 budget ⇒ `present` 最多 `2×6_000=12_000` ⇒ `elapsed=8_000+12_000=20_000 ≥ 14_000` ⇒ 抛在 `:167`，attempt 2 从未开始。
- 首跳即便瞬间返回 ⇒ `budgetMs()=14_000` ⇒ 落点预算 `min(8_000,14_000)=8_000` ⇒ `present` 最多 `16_000` ⇒ `elapsed ≥ 16_000 ≥ 14_000` ⇒ 同样抛。

⇒ 只要首跳的落点探针不中，循环必然在第一次迭代就抛；`:155` 的 `await page.reload(...)` 在这份 spec 上**永远不会执行**。守卫头注释（`:139-144`）声称「on a missed landing replay the navigation (a fresh document, which recovers from module requests interrupted once) until the deadline」，该意图被 `present` 的 2× 超支与 `14_000` 的 deadline 一起抹掉 —— 与本次失败逐字吻合：一次瞬时的模块请求中断，本可由一次 `page.reload` 自愈，却被放大成硬红。

**（5）为什么先前的修复没兜住（如实区分）。**

- `gap-ac228-criterion-red-is-mid-run-hmr-load-stabilize`（`goal_ac: AC-228`，done）：引入了这道守卫，但沿用了与 `gap-ac184` 改前**相同**的预算算术（首跳 8s + 落点 2×8s > 14s deadline），故守卫存在，却在最需要自愈的那一跳上无重放可走。
- `gap-ac266-criterion-startup-guard-cannot-afford-a-replay`（done）已把**同一修法**落在**兄弟 spec** `e2e/connected-apps-settings.spec.ts` 上，但那是**文件局部**的：`e2e/access-tokens-settings.spec.ts` 未被覆盖。参考成例（同机制、另一条 AC、已 done 且已入 develop）：兄弟改后 `STARTUP_PROBE_MS=5_000`、`NAVIGATION_PROBE_MS=5_000`、`STARTUP_RELOAD_PROBE_MS=3_000`、`STARTUP_PROBE_DEADLINE_MS=20_000`，最坏情形 `5_000+5_000+5_000+3_000=18_000 ≤ 20_000`；且 `FIRST_LANDING.present` 的两次 `appears` **共享**同一个 deadline、逐跳署名日志（hop N / page.goto / page.reload）。

**修什么（机制级、最小，照 `gap-ac266-criterion-startup-guard-cannot-afford-a-replay` 在兄弟 spec 上的成例，逐字移植）**：把 `e2e/access-tokens-settings.spec.ts` 的 `navigateBounded` 预算改成「首跳即便用满自己的界、其落点探针（含 `FIRST_LANDING` 两次 `appears` 的合计）也用满，仍留得下一次有界重放 + 重放落点探针」；让 `FIRST_LANDING.present` 的两次 `appears` 共享同一个 deadline（而非各用满 budget）；让每一次跳署名地记进日志（首跳 / 第 N 次 `page.reload`）。具体杠杆：`NAVIGATION_PROBE_MS` 8_000→5_000、`STARTUP_PROBE_MS` 8_000→5_000、`STARTUP_PROBE_DEADLINE_MS` 14_000→20_000（`STARTUP_RELOAD_PROBE_MS` 保持 3_000），总墙钟仍须留在本族天花板内（单 spec `playwright.config.ts` 55s 看门狗与本 spec `test.describe.configure({ timeout: 50_000 })`（`:115`）之内；本 spec 当前跑 20–22s，余量充足）。⛔ 不动设置页的 (a)–(g) 断言、⛔ 不改判据命令、⛔ 不加 retries/skip、⛔ 不动 `playwright.config.ts`、⛔ 不动 `goals/**`。

<!-- dedup-ref -->
机制去重读数（本轮实测）：`grep -lE '^goal_ac: *AC-228' tasks/*.md` → 2 命中（`gap-ac228-access-tokens-settings-e2e` :: done；`gap-ac228-criterion-red-is-mid-run-hmr-load-stabilize` :: done），在飞扫描（status ∈ todo/ready/needs-human）**0 命中**。`node …/task-granularity-advice.js --touches e2e/access-tokens-settings.spec.ts --json` → `peers=[]`、`mentions=[]`（无合并候选）。机制「access-tokens-settings.spec.ts 的启动守卫预算算不过来 / attempt 2 是死代码」在任务库无命中；同机制先例 `gap-ac184-criterion-startup-guard-cannot-afford-a-replay`（AC-184）与 `gap-ac266-criterion-startup-guard-cannot-afford-a-replay`（AC-266）是**另两条 AC** 在**另两份 spec** 上的同一修法，本条不是它们的重复。已 done 的 AC-228 任务不是重复，而是「上一次修复没守住」的证据。保留独立：独立判据（AC-228 的 e2e 判据）+ 独立文件（`e2e/access-tokens-settings.spec.ts`）。

## AC

- [ ] AC1 静态算式可检：改后的常数下，以「首跳用满 `NAVIGATION_PROBE_MS` + 首落点探针（`FIRST_LANDING` 两次 `appears` 的合计）用满」为最坏情形，`首跳界 + 首落点探针合计 + 重放一跳 + 重放落点探针 ≤ 改后的 STARTUP_PROBE_DEADLINE_MS` 成立；且没有任何一次 `present()` 调用能超过它拿到的那一档预算。验证：`grep -n "STARTUP_PROBE_DEADLINE_MS\|NAVIGATION_PROBE_MS\|STARTUP_PROBE_MS\|STARTUP_RELOAD_PROBE_MS" e2e/access-tokens-settings.spec.ts` 的逐字输出 + 文件里逐字算式入档。
- [ ] AC2 慢/抖首跳真的自愈（承重）：在启动导航前注入一个**确定性的**慢首跳（只在第一次文档/入口请求上把响应拖过 `NAVIGATION_PROBE_MS`，其后正常服务，或等价的确定性落点不中注入），判据物逐字不改地跑仍 `EXIT=0`，且逐字日志里能读出 **≥2 次导航尝试**（首跳 + 至少一次 `page.reload`）后落点成功。登记注入 diff、逐字日志、`echo $?`、wall；随后还原并证明零残留（`git status --porcelain` 回到注入前）。
- [ ] AC3 take-fake 必须红（承重）：只把守卫**还原成改前预算算术**（`STARTUP_PROBE_DEADLINE_MS=14_000`、`NAVIGATION_PROBE_MS=8_000`、`STARTUP_PROBE_MS=8_000`、`present` 各用满 budget）时，**同一**注入下守卫以非零退出、日志只有 **1 跳**（无重放）、红落在守卫自己的署名错误（`:167` 一族）。登记变异 diff、逐字失败行、`echo $?`；`git checkout -- e2e/access-tokens-settings.spec.ts` 还原后判据回到 `EXIT=0`。
- [ ] AC4 判定面一字未改：`git diff develop -- e2e/access-tokens-settings.spec.ts | grep -c "^-.*expect("` 为 **0**；`git diff develop -- playwright.config.ts` 为空；判据命令逐字不变；(a)–(g) 的产品读数断言（`ccp_[0-9a-f]{64}`、刷新后明文命中 0、`option values = ["7","30","90"]`、token-info live 200 / revoked 401、`New API Key` 与 `api-docs.html` 不在）原样。验证：上述各命令的逐字输出。
- [ ] AC5 负载下连续绿：判据物连续 ≥5 次全部 `exit 0`、整跑墙钟留在本族天花板内（单 spec < 55s / < 本 spec 的 `timeout: 50_000`）；其中至少一次与 ≥4 份兄弟 e2e spec 并发。如实登记宿主 load；并发那次若兄弟 spec 自己红，须点名归因、不计入本条。验证：逐次 `echo $?` + wall。
- [ ] AC6 静态门：`npm run typecheck` 退出 0；`npx oxlint e2e/access-tokens-settings.spec.ts` 的新增诊断数为 0（与 develop 版本同跑对照）。验证：命令与退出码。

## DoD

- 判据物（逐字不改）在改后的树上**真的跑过**：静默条件 ≥5 连绿、且至少一次与 ≥4 份兄弟 e2e spec 并发时也不死于启动形态；逐次 wall、exit code 与 (a)–(g) 产品读数逐字入档 —— 不是复述 `expect` 的文字，不是读台账尾巴。
- 守卫的「重放」不是声称而是**被观测到**：确定性慢/抖首跳注入下运行日志逐字出现 ≥2 次导航尝试（首跳 + `page.reload`）后落点成功；把预算还原成改前算术的同一注入则只有 1 跳并红。改前/改后两组读数 + take-fake 一并入档，任何人在同一 checkout 上可复现。
- 设置页的承重面一个字节未动：diff 里 `e2e/access-tokens-settings.spec.ts` 无 `expect(` 删除、无产品读数断言改动；(a)–(g) 与一次性明文 / 吊销 / 旧入口读数原样；`playwright.config.ts` 与判据命令零改动。
- 交付物落在 `e2e/access-tokens-settings.spec.ts` 与 `tasks/gap-ac228-criterion-startup-guard-cannot-afford-a-replay.md`；⛔ 不以 jsdom/组件层绿替代浏览器层绿；⛔ 不加 retries、不 skip、不改 timeout 来掩盖启动红；⛔ 不改 `goals/**`。
- 若直跑为稳定红（判据在净检出上也红），本条必须停手上报：置 `needs-human` 并写明「判据在净检出上也是红的，守卫预算归因不成立，应按缺陷任务重立」—— 不得把环境红写成产品绿，也不得据此改断言。
- 完成记录写明判法：既有设置页实现有效（本轮 HEAD 树 `bfd79a71` 上判据 3/3 退出 0、(a)–(g) 逐字齐）；台账末拍 fail 是浏览器级瞬时网络抖动（`net::ERR_NETWORK_CHANGED`，watchdog `fired:false`、node 侧预热成功、浏览器子资源整批失败）被守卫的预算算术放大成硬红；本仓修的是**响应方式**（无界首跳等待 → 有界重放可达），故这条判据的稳定性依赖守卫而非触发源消失。

## Touches

- e2e/access-tokens-settings.spec.ts（改 navigateBounded 的预算算术、FIRST_LANDING.present 的共享预算与逐跳署名日志；设置页 (a)–(g) 断言零改动）
- tasks/gap-ac228-criterion-startup-guard-cannot-afford-a-replay.md（自触）
- goals/AC-228-真实浏览器里设置页能创建个人访问令牌-明文只显示一次-刷新后只剩前缀-吊销后消失-旧的-api-key-创建入口不再存在.md（只读：criterion/expect 的逐字来源）

## Evidence

### 立案读数（filing baseline，逐字保留）

**本轮直跑（2026-10-10，静默态，`0fb38c653453602dadc835a1af36b0df11accf0e` / tree `bfd79a71d5fdab9e4021fe58f322ae6a5448dc2b`）**：判据物逐字跑 3 次，`1 passed (21.8s)` / `1 passed (20.6s)` / `1 passed (21.8s)`，`EXIT=0`（宿主 load1 ≈ 13.1 / 14.2 / 13.9）。逐字读数见 Proposal（1）。

**末拍红（台账逐字）**：`2026-10-10T03:40:16.800Z actor=goal-cli item_id=AC-228 gate=goal verdict=fail payload.treeSha=bfd79a71d5fdab9e4021fe58f322ae6a5448dc2b payload.reason="acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-Rf36Aj/vite-cache/deps/react-scan.js?v=5731b542 as it exceeds the max of 500KB."`；紧前 20 拍（`01:27:05.469Z`→`03:35:29.710Z`）均 `verdict=pass`、`acceptance passed (exit 0)`。

**失败 run 工件（逐字）**：数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-Rf36Aj/`；`watchdog-state.json` = `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}`；`test-results/access-tokens-settings-per-305e9-evocation-really-rejects-it/error-context.md` 整段见 Proposal（3）。

**旁证**：失败 `reason` 尾部恒带 `[BABEL] Note: … react-scan.js … exceeds the max of 500KB`；本轮三次静默绿跑也照带同一行 ⇒ 该 BABEL 行是每次运行的常数，**不是**本红的判别信号，不得据它归因。

### 残留未钉死假设（如实登记）

本条证「判据在净检出上为真（3/3 绿，且与 fail 同树）」+「守卫的 attempt 2 在当前常数下不可达」；触发源（宿主 netlink / docker-veth 网络抖动）在仓外、不可控 —— 修法改的是**响应方式**（让重放可达），故稳定性依赖守卫，不可能靠触发源消失保证。
