---
id: gap-ac279-criterion-boot-needs-bounded-navigation-replay
title: AC-279 判据的首个导航是裸 page.goto：宿主 net::ERR_NETWORK_CHANGED 在登录页 mount 前打断 76
  个请求 ⇒ 文档白屏、fill 等到 55s 看门狗被杀（同树 3 pass 后 1 fail；本轮直跑 exit
  0）——把首个导航换成有界重放并加确定性控制臂
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-279
---
## Proposal

来源：本轮 gap-filing 的**直接测量**——判据物、同树台账、失败跑自己的工件（watchdog-state.json + error-context.md + trace），以及本轮在净检出上的一次直跑；不是复述台账尾巴。

判据物（`goals/AC-279-停在-conversations-视图时-新建或改名为命中规则的会话不会冒出来.md`，未改）：`npm run test:e2e -- e2e/session-filter-conversations-live.spec.ts`。

AC-279 记 `status: achieved`，其 GOAL-002 已 `achieved`、已离开 reverify 范围、未声明 `long-term: true`。台账最近一拍是 fail：`.quay/gate-events.jsonl` 的 `b091fa8e-f127-4c0a-bdd7-d57a5258df20`，`2026-10-21T10:22:32.517Z`，`treeSha=6de9f11e5990f9ed86f1eb522a7f627341759b11`（= 当前 HEAD 的树）。

### 1. 产品面的保证仍为真：本轮直跑 exit 0

`npm run test:e2e -- e2e/session-filter-conversations-live.spec.ts`（2026-10-21 18:27 +0800，load1 ≈ 13）→ `1 passed (14.9s)`，`/usr/bin/time` 墙钟 **15.72s**。⇒ 这次红不是过滤逻辑退化。

### 2. 同一棵树上 3 次 pass 之后 1 次 fail

AC-279 的 `gate=goal` 尾巴：`10:04:27.206Z` pass、`10:10:00.061Z` pass、`10:15:57.286Z` pass、`10:22:32.517Z` **fail**。

### 3. 失败跑自己的工件：登录页在 mount 前被宿主网络变更打断，文档白屏到 55s 看门狗

失败跑的数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-AwB5GY/`（仍在盘上）：

- `watchdog-state.json`：`{"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55005ms","stage":"browser-launch-or-cases","stall":"observed past boot at 3200ms, so this run was inside browser launch or a case; both webServers answered the 2000ms probe at the crossing"}`。
- `test-results/session-filter-conversatio-eb724-d-one-that-does-not-arrives/error-context.md`：`Error: locator.fill: Target page, context or browser has been closed`，call log 停在 `waiting for locator('#username')` ⇒ 事件发生在 `beforeAll` 的登录表单，不是过滤断言。
- 同目录 `trace.zip` 解出后，`1-trace.network` / `3-trace.network` 共 **76** 条 `net::ERR_NETWORK_CHANGED`。

⇒ 浏览器网络栈只断了一瞬，但被打断的是首份文档的模块图；ES module 不重试，app 永不上屏，`#username` 永不出现，而 `test.describe.configure({ timeout: 120_000 })` 让 `fill` 一直等着，直到文件看门狗在 55 000ms 把整跑杀掉。

### 4. 机制：本 spec 只有一次裸 `page.goto`，没有第二份文档可走

- `e2e/session-filter-conversations-live.spec.ts:232` 是 `await page.goto('/');`，`:233` 起直接 `page.locator('#username').fill(...)`。整个 `beforeAll` 只有这一次导航。
- 文件自带的 `warmClientStartup`（`:130`，本地副本）只证明**优化器已静默**，它挡不住宿主级网络变更通知（AC-408 任务 §3 已用同一条读数说明这一点）。
- 同族已落地的解法就在仓里：`7b5033c83`（AC-408 / `gap-ac408-mount-guard-needs-bounded-navigation-replay`，done）给 `e2e/support/client-startup-warmup.ts:392` 加了 `navigateClientBounded` —— 首跳 `page.goto` + 落点探针，未中即 `page.reload` 重放，直到 `STARTUP_GUARD_DEADLINE_MS = 20_000`；每跳署名打 `[e2e] client startup: <selector> landed after <ms>ms (attempt N)`；耗尽时抛带每跳摘要的全量证据（页面文本、pageerror、console error、requestfailed）。
- AC-279 的 spec 是少数还没有这条回应腿的判据。

### 5. 为什么先前的修复没守住（如实区分）

- `gap-session-filter-conversations-live-path`（done，`goal_ac: AC-279`）交付的是**行为与判据**：`useSidebarController` 的 `session_upserted` 按项目规则插入/移除，spec 的五条读数（正对照、命中不出现、后命名、改名移除、实时=重载）都在。它按设计工作——今天 10:04–10:15 的三个绿跑就是证据。
- 它没有、也不在范围内处理**文档 boot**：spec 的首个导航仍是裸 `page.goto`。所以这次不是旧修复失效，而是同一族宿主网络变更第一次点名到 AC-279 的启动路径：**判据可归因 ≠ 判据可自愈**。

### 要做的

1. **把首个导航换成共享守卫**：`e2e/session-filter-conversations-live.spec.ts` 删除本地 `warmClientStartup` / `CLIENT_WARM_DEADLINE_MS` / `OPTIMIZED_DEP_IN_TEXT` 副本，改用 `e2e/support/client-startup-warmup.ts` 的 `warmClientStartup(clientUrl, dataDir)`，把它的 `ClientWarmupReading` 与页面级监听（`pageerror` / `console` / `requestfailed`）组成 `ClientStartupEvidence`（按引用传递，守卫按跳快照）。
   - `:232` 的 `await page.goto('/')` 改成 `await navigateClientBounded(page, '/', '#username', evidence)`。
   - 落点必须是登录表单本身（`#username`），不得退化成「shell 出现即可」。
2. **确定性控制臂**：在本 spec 的 `page.context().route('**', …)` 里加一个默认惰性的注入缝 `SESSION_FILTER_LIVE_ABORT_BOOTS=<n>`：前 n 次 `**/src/main.tsx` 请求 abort，之后放行。形状照 `e2e/voice-output-e2e-harness.spec.ts:792` 的 `VOICE_E2E_ABORT_BOOTS`。⚠️ 本 spec 用 `browser.newPage()`（`:229`），route 挂在 `page.context()` 上。
   - `SESSION_FILTER_LIVE_ABORT_BOOTS=1` ⇒ 仍 exit 0，输出含 `(attempt 2)`；
   - `SESSION_FILTER_LIVE_ABORT_BOOTS=9` ⇒ exit ≠ 0，错误由守卫按名字抛出（含 `#username` 与每跳摘要），输出**不含** `[e2e] watchdog:`。
3. **预算算得过来**：守卫 deadline 20s，耗尽路径实测应在 ~30s 内由守卫自己收尾，早于 55s 文件看门狗与 60s 闸 kill。⛔ 不抬 `SINGLE_SPEC_CEILING_MS`、不加 `SPEC_BUDGET_MS` 条目、不改判据命令或 AC 记录的 `timeoutMs`；若实测算不过来，报告算术而不是抬线。
4. **重跑 AC 自己的假形态**（AC `expect` 要求，做完还原）：去掉新会话插入分支的过滤判断 ⇒ spec 红；还原；去掉改名分支里的移除 ⇒ spec 红；还原。
5. **注释说真话**：spec 头注释写清 `warmClientStartup` 只证明优化器静默，宿主网络变更由有界重放回应；把两条控制臂命令写进去。

### 不要做的

- ⛔ 不改判据命令、不删/跳过/加 tag 任何用例、不加 Playwright `retries`、不放宽任何断言。
- ⛔ 不改产品代码（`src/`、`server/`）或 `playwright.config.ts`（AC5 的消融是临时且必须还原的测量，不是交付）。
- ⛔ 不在 spec 里再写第三份本地守卫；用共享的 `navigateClientBounded`。
- ⛔ 不把「重放耗尽」当通过。
- ⛔ 不声称修掉触发源（宿主 netlink / docker-veth churn 在仓库之外）；本条修的是响应。

<!-- dedup-ref --> 机制去重：`tasks/*.md` 中 `goal_ac: AC-279` 且在飞（todo/ready/needs-human）的任务为 **0**（`gap-session-filter-conversations-live-path`、`fleet-draft-ac-279-803ffe1d` 均 done）；`task-granularity-advice.js` 对 `e2e/support/client-startup-warmup.ts` 报 `peers: []`、`mentions: []`。相关但不同（均 done）：`gap-ac408-mount-guard-needs-bounded-navigation-replay`（同一守卫，落在别的 spec）、`gap-ac266-criterion-ledger-red-is-chromium-network-flap`、`gap-ac228-criterion-startup-guard-cannot-afford-a-replay`。

## AC

- [x] **AC1 守卫已接线，spec 内无裸导航**：`grep -qF 'navigateClientBounded' e2e/session-filter-conversations-live.spec.ts`、`test "$(grep -c 'await page.goto(' e2e/session-filter-conversations-live.spec.ts)" = 0`、`grep -qF "from './support/client-startup-warmup'" e2e/session-filter-conversations-live.spec.ts` 三条合取 exit 0。取假形态：当前树（`:232` 裸 `page.goto`、无共享 import）第一条即红。
- [x] **AC2 判据命令 3/3 绿且首跳即落地**：连跑三次 `npm run test:e2e -- e2e/session-filter-conversations-live.spec.ts`，每次 exit 0、输出含 `1 passed` 与 `[e2e] client startup: #username landed after … (attempt 1)`；用 `date +%s%3N` 记墙钟并贴出（静息应 ≈15–20s，< 55 000）。取假形态：守卫接线但落点退化成 shell 时，`(attempt 1)` 不会在 `#username` 上出现。
- [x] **AC3 重放臂：一次被打断的启动能自愈**：`SESSION_FILTER_LIVE_ABORT_BOOTS=1 npm run test:e2e -- e2e/session-filter-conversations-live.spec.ts` exit 0，输出含 `1 passed` 与 `(attempt 2)`，且无 `[e2e] watchdog:`。取假形态：保留注入缝但把首个导航改回裸 `page.goto('/')` + `waitFor('#username')`，同一命令 exit ≠ 0（55s 看门狗或超时）、无 `(attempt 2)`，必红。
- [x] **AC4 响亮失败臂：重放耗尽按名字红，且不被 55s 看门狗/60s 闸掐断**：`SESSION_FILTER_LIVE_ABORT_BOOTS=9 npm run test:e2e -- e2e/session-filter-conversations-live.spec.ts`（`date +%s%3N` 记墙钟）exit ≠ 0；stderr 含守卫的具名错误（`the client never mounted "#username"` 与每跳摘要，含 `net::` 证据）；输出**不含** `[e2e] watchdog:`；墙钟 < 60 000ms。取假形态：守卫把耗尽误判成功时本条见 exit 0，必红。
- [x] **AC5 AC-279 自己的假形态仍可区分**（逐条做完还原，贴红掉的断言）：(a) 临时去掉 `useSidebarController` 插入分支里的过滤判断 ⇒ 本 spec exit ≠ 0；(b) 还原后临时去掉改名分支里的移除 ⇒ 本 spec exit ≠ 0；(c) 还原后 `git diff -- src/` 为空。取假形态：若两条都不红，说明正对照/断言面已真空，必红。
- [x] **AC6 预算算术可读且未抬线**：贴出 AC2 的静息墙钟与 AC4 的耗尽墙钟，证明守卫 deadline（`STARTUP_GUARD_DEADLINE_MS = 20_000`）落在「静息 + 20s < 55 000 文件看门狗 < 60 000 闸 kill」之内；`git diff develop..HEAD -- playwright.config.ts goals/` 为空。
- [x] **AC7 静态不回归**：`npm run typecheck` exit 0；`npm run lint` exit 0。（如实登记：`typecheck` 的 include 与 `lint` 都不含 `e2e/`，spec 的编译正确性由 AC2–AC4 的实跑转译保证。）

## DoD

- **真实对象被真正操作过**：在本仓库真实的 app server + 真实 Chromium 上把判据命令跑完 3 次（AC2），并现场跑两条控制臂（AC3/AC4）；贴原始 stdout/stderr、墙钟读数与 `(attempt N)` 行——不是「spec 文件存在」。
- **闸真的翻绿**：落地后 `quay goal gate AC-279` → `verdict: pass`，新记录进 `.quay/gate-events.jsonl`（贴 event id 与 treeSha）；driver 下一轮独立复核也应绿。
- **不真空**：AC3 的假形态（裸 goto + 注入缝）与 AC5 的两条过滤消融都必须红，且红在具名断言上。
- **不改判据面**：diff 只含 Touches 的文件；五条既有读数（正对照/命中不出现/后命名/改名移除/实时=重载）逐字未改；无 `retries`/`skip`/`test.fixme`。
- **诚实边界**：触发源（宿主 `net::ERR_NETWORK_CHANGED`）在仓库之外，本条不声称修掉它；spec 尾部那一次整页 `page.reload()` 不在本次守卫范围内，若它被同一族打断，AC2 的红会点名 `projectRow()` 的 30s 超时——如实记录，不掩盖。

## Touches

- e2e/session-filter-conversations-live.spec.ts
- e2e/support/client-startup-warmup.ts（仅当共享守卫需要为本 spec 增补导出/参数；⛔ 不改 AC-408 守护的行为）
- tasks/gap-ac279-criterion-boot-needs-bounded-navigation-replay.md
