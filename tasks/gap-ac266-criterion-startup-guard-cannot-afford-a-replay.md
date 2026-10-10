---
id: gap-ac266-criterion-startup-guard-cannot-afford-a-replay
title: AC-266 判据 e2e/connected-apps-settings.spec.ts 的有界启动守卫算不过来：首跳 8s +
  首落点探针（FIRST_LANDING 两次 appears 各用满）8s > 14s deadline ⇒ attempt
  2（page.reload）是死代码，首跳被瞬时浏览器网络抖动（net::ERR_NETWORK_CHANGED）打掉后永不重放，台账反复被同一棵树上的
  pass→fail flake 翻红；按 AC-184 先例把重放塞进预算
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-266
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（判据物 + 台账 + 失败跑自己的工件 + 静默态直跑 + 判据文件的静态算式），不是复述台账尾巴。

判据物（逐字取自 `goals/AC-266-真实浏览器里设置页能管理已连接的应用与-oauth-客户端-吊销授权后该行消失-手工创建客户端时密钥只显示一次.md` 的 `criterion:`，逐字不改）：

```
for f in e2e/connected-apps-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/connected-apps-settings.spec.ts
```

AC 状态：该 goal 文件记 `status: achieved`；其 GOAL-021 已 achieved、已离开 reverify scope、且未声明 `long-term: true`；台账最近一拍为 fail ⇒ 按 CURRENTLY FALSE 立案。

**（1）台账尾巴是同一棵树上的 pass→fail —— flake 签名，不是产品退化。**
`.quay/gate-events.jsonl` 里 AC-266 `gate=goal` 的最近几拍（逐字）：`2026-10-10T01:11:07.133Z` pass `tree=63fc8ce32e1c`，随后 `01:12:48 / 01:14:21 / 01:15:55 / 01:17:23 / 01:19:04 / 01:20:34 / 01:22:55 / 01:24:54 / 01:27:29` 均 pass `tree=63fc8ce32e1c`，`01:29:24.604Z` pass `tree=f17fcaf2300e`，末拍 `2026-10-10T01:32:07.813Z` **fail** `tree=fdaada5db009`，`payload.reason` 逐字前段 `acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-8kMwTT/vite-cache/deps/react-scan.js?v=5731b542 as it exceeds the max of 500KB.`。历史同类 fail：`2026-10-06T18:58:03.915Z`、`2026-10-07T15:46:02.488Z`、`2026-10-07T16:20:18.948Z`、`2026-10-10T01:07:31.550Z` —— 同一段 BABEL stderr 尾，红绿交替。

**（2）红不在设置页的任何断言上 —— 死在 beforeAll 的启动守卫里，且红因是瞬时浏览器网络抖动。**
失败跑自己的数据目录 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-8kMwTT/`：
- `test-results/connected-apps-settings-co-945fc-whose-token-is-then-refused/error-context.md` 逐字：`Error: the account form or the app shell never rendered, so this run's client never came up to a document that stays: the page shows ""; console errors: Failed to load resource: net::ERR_NETWORK_CHANGED | …(×5); failed requests: http://127.0.0.1:16277/src/modules/settings/SettingsSidebar.tsx — net::ERR_NETWORK_CHANGED | …(×5)`。跑点 `Location: e2e/connected-apps-settings.spec.ts:386:3`，抛点在 `:203`（`navigateBounded` 的预算耗尽分支）。
- `watchdog-state.json` 逐字 `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}` ⇒ 55s 运行天花板未触发，运行自己按守卫失败收尾。
- `test.trace` 逐字序列：`[e2e] client warm-up: pre-bundle committed in 2794ms`（node 侧同源 warm-up 成功）→ `Navigate "/"` 完成（7096→9439ms）→ `Wait #username Timeout 8000ms exceeded` → `Wait Settings Timeout 8000ms exceeded` → 红落 `navigateBounded` `:203`。**整个运行只有 1 次导航，没有任何 `page.reload`。**

**（3）机制（本条承重的静态读数）：守卫的预算算不过来，attempt 2（`page.reload`）是死代码；首跳一旦落点不中，永远没有重放。**
`e2e/connected-apps-settings.spec.ts` 常数（`grep -n` 逐字）：`STARTUP_PROBE_MS = 8_000`（:45）、`STARTUP_RELOAD_PROBE_MS = 3_000`（:47）、`NAVIGATION_PROBE_MS = 8_000`（:49）、`STARTUP_PROBE_DEADLINE_MS = 14_000`（:51）。`navigateBounded`（:181）逐字算，两种情形都不重放：
- 首跳 `page.goto` 超时用满 `8_000` ⇒ `budgetMs()=6_000` ⇒ 落点预算 `min(8_000,6_000)=6_000`；而 `FIRST_LANDING.present`（:215）是 `appears(#username,budget) || appears(Settings,budget)` —— 两次各用满 budget ⇒ `present` 最多花 `2×budget=12_000` ⇒ `elapsed = 8_000+12_000 = 20_000 ≥ 14_000` ⇒ 抛在 `:203`，attempt 2 从未开始。
- 首跳即便瞬间返回 ⇒ 落点预算 `min(8_000,14_000)=8_000` ⇒ `present` 最多 `16_000` ⇒ `elapsed ≥ 16_000 ≥ 14_000` ⇒ 同样抛。
⇒ 只要首跳的落点探针不中，循环必然在第一次迭代就抛；分支 `else { await page.reload(...) }`（:191）在这份 spec 上**永远不会执行**。守卫头注释（:175-180）声称「navigate … and on a missed landing replay the navigation … until the deadline」，该意图被 `present` 的 2× 超支与 `14_000` 的 deadline 一起抹掉。

**（4）直接重跑（本轮立案测量）—— 静默条件绿。**
checkout `/data/home/yale/work/claudecodeui`（`HEAD=2191093f`、`HEAD^{tree}=a35f1056`），判据物逐字直跑：`EXIT=0 WALL=15991ms   1 passed (15.2s)`。产品读数逐字齐：`(a) connected-app rows = 2`，行含客户端名 / `Callback host: 127.0.0.1` / `Scopes: cloudcli:read`；`(b) /mcp … 200 before revoke, 401 after; connected-app rows 2 -> 1`，reload 后 revoked=0 / untouched=1；`(c) POST /api/oauth/clients -> 201`，密钥与响应一致，reload 后 content/body/localStorage/sessionStorage 命中皆 0；`(d) … 200 before disabling, 401 after`；无未翻译 i18n 字面量。⇒ 设置页承诺没退化，红的是判据的**启动鲁棒性**。

**（5）为什么先前的登记没兜住（如实区分）。**
- `gap-ac266-connected-apps-settings-browser-ui`（done）：交付了 UI/接口/判据，但其引入的启动守卫沿用了与 `gap-ac184` 改前**相同**的预算算术（首跳 8s + 落点 8s > 14s deadline），故守卫存在，却在最需要自愈的那一跳上无重放可走。
- `gap-ac266-criterion-ledger-red-is-chromium-network-flap`（done，verification-only）：把台账红归因为「宿主/浏览器级瞬时网络抖动，不在判据控制内」，**未改判据**。该归因对「抖动本身」成立，但**漏掉了判据侧可修的那一半**：抖动只持续一瞬（失败跑 `01:31:49` 资源已 200、`01:31:51` 才整批 `ERR_NETWORK_CHANGED`），一次 `page.reload` 极可能自愈 —— 而守卫的预算算术让这次重放不可达，于是可自愈的瞬变被放大成硬红、台账反复翻红。本条补的正是这一半。

**修什么（机制级、最小，照 `gap-ac184-criterion-startup-guard-cannot-afford-a-replay` 在 `e2e/activity-dock-truthful.spec.ts` 上的成例）**：把 `navigateBounded` 的预算改成「首跳即便用满自己的界、其落点探针（含 `FIRST_LANDING` 两次 `appears` 的合计）也用满，仍留得下一次有界重放 + 重放落点探针」，并让每一次跳**署名地**记进日志（首跳 / 第 N 次 `page.reload`）。可选杠杆（由实现者按实测取，可并用）：抬 `STARTUP_PROBE_DEADLINE_MS`；收紧 `NAVIGATION_PROBE_MS`/`STARTUP_PROBE_MS`；让 `FIRST_LANDING.present` 的两次 `appears` 共享同一个 deadline（而非各用满 budget）。总墙钟仍须留在本族天花板内（`playwright.config.ts` 的 per-test `timeout: 60_000` 与单 spec 55s 看门狗之内；本 spec 当前跑 15–17s，余量充足）。⛔ 不动设置页的断言、⛔ 不改判据命令、⛔ 不加 retries/skip、⛔ 不动 `playwright.config.ts`、⛔ 不动 `goals/**`。

**参考成例（同机制、另一条 AC、已 done 且已入 develop）**：`e2e/activity-dock-truthful.spec.ts` 改后 `STARTUP_PROBE_DEADLINE_MS=20_000`、`NAVIGATION_PROBE_MS=5_000`、`STARTUP_PROBE_MS=5_000`、`STARTUP_RELOAD_PROBE_MS=3_000`，最坏情形 `5_000+5_000+5_000+3_000=18_000 ≤ 20_000`。

<!-- dedup-ref --> 机制去重读数（本轮实测）：`grep -l '^goal_ac: *AC-266' tasks/*.md` → 2 命中（`gap-ac266-connected-apps-settings-browser-ui` :: done；`gap-ac266-criterion-ledger-red-is-chromium-network-flap` :: done），在飞扫描（status ∈ todo/ready/needs-human）**0 命中**。`task-granularity-advice --touches e2e/connected-apps-settings.spec.ts …` → `peers=[]`、`mentions=[]`（无合并候选）。机制「connected-apps-settings.spec.ts 的启动守卫预算算不过来 / attempt 2 是死代码」在任务库无命中；同机制先例 `gap-ac184-criterion-startup-guard-cannot-afford-a-replay` 是**另一条 AC**（AC-184）在**另一份 spec** 上的同一修法，本条不是它的重复。保留独立：独立判据（AC-266 的 e2e 判据）+ 独立文件（`connected-apps-settings.spec.ts`）。

## AC

- [x] AC1 静态算式可检：改后的常数下，以「首跳用满 `NAVIGATION_PROBE_MS` + 首落点探针（`FIRST_LANDING` 两次 `appears` 的合计）用满」为最坏情形，`首跳界 + 首落点探针合计 + 重放一跳 + 重放落点探针 ≤ 改后的 STARTUP_PROBE_DEADLINE_MS` 成立；且没有任何一次 `present()` 调用能超过它拿到的那一档预算。验证：`grep -n "STARTUP_PROBE_DEADLINE_MS\|NAVIGATION_PROBE_MS\|STARTUP_PROBE_MS\|STARTUP_RELOAD_PROBE_MS" e2e/connected-apps-settings.spec.ts` 的逐字输出 + 文件里逐字算式入档。
- [x] AC2 慢/抖首跳真的自愈（承重）：在 `beforeAll` 的启动导航前注入一个**确定性的**慢首跳（只在第一次文档/入口请求上把响应拖过 `NAVIGATION_PROBE_MS`，其后正常服务，或等价的确定性落点不中注入），判据物逐字不改地跑仍 `EXIT=0`，且逐字日志里能读出 **≥2 次导航尝试**（首跳 + 至少一次 `page.reload`）后落点成功。登记注入 diff、逐字日志、`echo $?`、wall；随后还原并证明零残留（`git status --porcelain` 回到注入前）。
- [x] AC3 take-fake 必须红（承重）：只把守卫**还原成改前预算算术**（`STARTUP_PROBE_DEADLINE_MS=14_000`、`NAVIGATION_PROBE_MS=8_000`、`STARTUP_PROBE_MS=8_000`、`present` 各用满 budget）时，**同一**注入下守卫以非零退出、日志只有 **1 跳**（无重放）、红落在守卫自己的署名错误（`:203` 一族）。登记变异 diff、逐字失败行、`echo $?`；`git checkout -- e2e/connected-apps-settings.spec.ts` 还原后判据回到 `EXIT=0`。
- [x] AC4 判定面一字未改：`git diff develop -- e2e/connected-apps-settings.spec.ts | grep -c "^-.*expect("` 为 **0**；`git diff develop -- playwright.config.ts` 为空；判据命令逐字不变；(a)–(e) 的产品读数断言、`UNTRANSLATED_KEY` 断言、`expect(...status).toBe(200)/(401)`、secret 命中 0 等原样。验证：上述各命令的逐字输出。
- [x] AC5 负载下连续绿：判据物连续 ≥5 次全部 `exit 0`、整跑墙钟留在本族天花板内（单 spec < 55s / < `playwright.config.ts` 的 `timeout: 60_000`）；其中至少一次与 ≥4 份兄弟 e2e spec 并发。如实登记：并发那次若兄弟 spec 自己红，须点名归因、不计入本条。验证：逐次 `echo $?` + wall。
- [x] AC6 静态门：`npm run typecheck` 退出 0；`npx oxlint e2e/connected-apps-settings.spec.ts` 的新增诊断数为 0（与 develop 版本同跑对照）。验证：命令与退出码。（merge develop 后复跑：`typecheck EXIT=0`、`oxlint EXIT=0`。）

## DoD

- 判据物（逐字不改）在改后的树上**真的跑过**：静默条件 ≥5 连绿，且至少一次与 ≥4 份兄弟 e2e spec 并发时也不死于启动形态；逐次 wall、exit code 与 (a)–(e) 产品读数逐字入档 —— 不是复述 `expect` 的文字，不是读台账尾巴。
- 守卫的「重放」不是声称而是**被观测到**：确定性慢/抖首跳注入下运行日志逐字出现 ≥2 次导航尝试（首跳 + `page.reload`）后落点成功；把预算还原成改前算术的同一注入则只有 1 跳并红。改前/改后两组读数 + take-fake 一并入档，任何人在同一 checkout 上可复现。
- 设置页的承重面一个字节未动：diff 里 `e2e/connected-apps-settings.spec.ts` 无 `expect(` 删除、无产品读数断言改动；(a)–(e) 与未翻译 i18n 断言原样；`playwright.config.ts` 与判据命令零改动。
- 交付物落在 `e2e/connected-apps-settings.spec.ts` 与 `tasks/gap-ac266-criterion-startup-guard-cannot-afford-a-replay.md`；`scripts/voice-realtime-diagnose.mjs` 的 typecheck 红已由 develop 上的兄弟提交 `f3d6858e` 独立修好，退出前 merge develop 取其版本，本条对该文件零 delta（见下 Notes）；⛔ 不以 jsdom/组件层绿替代浏览器层绿；⛔ 不加 retries、不 skip、不改 timeout 来掩盖启动红；⛔ 不改 `goals/**`。
- 若直跑为稳定红（判据在净检出上也红），本条必须停手上报：置 `needs-human` 并写明「判据在净检出上也是红的，守卫预算归因不成立，应按缺陷任务重立」—— 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- tasks/gap-ac266-criterion-startup-guard-cannot-afford-a-replay.md（自触）
- e2e/connected-apps-settings.spec.ts（改 navigateBounded 的预算算术与逐跳署名日志；设置页断言零改动）
- goals/AC-266-真实浏览器里设置页能管理已连接的应用与-oauth-客户端-吊销授权后该行消失-手工创建客户端时密钥只显示一次.md（只读：criterion/expect 的逐字来源）

## Notes

- 本条不改 `goals/**`、不动 `playwright.config.ts`、不改判据命令。
- 旁证：失败 reason 尾部恒带 `[BABEL] Note: … deoptimised the styling of …/vite-cache/deps/react-scan.js … exceeds the max of 500KB`；本轮静默绿跑也照带同一行 ⇒ 该 BABEL 行是每次运行的常数，**不是**本红的判别信号，不得据它归因。
- AC6 的 `npm run typecheck` 在本条 base（`5a42d83f`）上就是红（exit 2，`scripts/voice-realtime-diagnose.mjs` 5 处 TS7006，由直投 develop、绕过 fan-in 的提交引入），阻塞每个任务的 typecheck 静态门。本条第 2 提交 `f699d8fa` 曾补 JSDoc 类型标注吸收之；退出前 `merge develop` 时发现兄弟提交 `f3d6858e`（`fix(scripts): annotate voice-realtime-diagnose so the scripts typechecks`）已把同一处修好且内容等价，故冲突按 develop 版本解决、本条对该文件零 delta（详见 merge 提交 `532151df`）。另一处既有红 `server/shared/tests/quay-test-script.test.ts` 的 pin 计数，由已 ready、已排序的兄弟任务 `gap-voice-realtime-test-files-restore-quay-test-script-pins` 拥有，本条不吸收。
