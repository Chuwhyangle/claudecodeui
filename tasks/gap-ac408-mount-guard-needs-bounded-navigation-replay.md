---
id: gap-ac408-mount-guard-needs-bounded-navigation-replay
title: AC-408 挂载守卫没有有界重放：宿主 net::ERR_NETWORK_CHANGED 在 mount 阶段一瞬间打断 58 个同源模块请求
  ⇒ 模块图永不执行、pane 白屏、整条判据红（同树 4 pass 后 1 fail；本轮直跑 exit 0）——给首个导航加有界重放，并让预算真的算得过来
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-408
---
## Proposal

来源：本轮 gap-filing 的**直接测量**——判据物、同树台账、失败跑自己的工件（partial dump + trace + playwright.log）、以及本轮在净检出上的一次直跑；不是复述台账尾巴。

判据物（逐字取自 `goals/AC-408-端到端典型场景-announce-总结文本经-tts-合成-浏览器播放-narrator-done-推进.md`，不改）：

```
node experiments/voice-e2e-harness/run.mjs --sample 402fad85
```

AC-408 记 `status: achieved`；其 GOAL-047 已 `achieved`、已离开 reverify 范围、未声明 `long-term: true`。台账最近一拍是 fail：`.quay/gate-events.jsonl` 的 `id=0039c558-bef1-4b9a-a542-d707e78bff8d`，`2026-10-21T09:58:15.798Z`，`item_id=AC-408`，`verdict=fail`，`treeSha=d6da32dc06367c84707382c26a21e1badf25bf41`。

### 1. 本轮直接测量：判据在本检出上 exit 0，四条保证的读数都齐

`node experiments/voice-e2e-harness/run.mjs --sample 402fad85`（2026-10-21 17:59:50→18:00:25 +0800；HEAD `28909e94`）：

- `EXIT=0`；Playwright 汇总 `9 passed (32.2s)`，没有 `did not run`；
- `[voice-e2e] RESULT: PASS (exit 0)`；
- `[voice-e2e] narrator speaks=["好的","本轮任务已结束，全部检查通过。","收到","明白","在办"]`；
- `[voice-e2e] voice-output tts-requests=1 audio-bytes=80044 played=true duration=2.5s`；
- `[voice-e2e] zero-egress blocked=false dials=1 authorization=false`。

⇒ AC-408 的 (a)–(d) 在当前树上为真，本轮台账红不是产品面退化。判据命令与 harness 对红那一拍逐字相同：`git diff 704c0b976 HEAD -- e2e/voice-output-e2e-harness.spec.ts e2e/support/client-startup-warmup.ts experiments/voice-e2e-harness/run.mjs` 为空（最后一次改这些文件的是 `704c0b976`）。

### 2. 同一棵树上 4 次 pass 之后 1 次 fail —— 是瞬时，不是回归

`.quay/gate-events.jsonl` 里 AC-408 的 `gate=goal` 尾巴（`payload.treeSha` 全部 `d6da32dc…`）：

- `09:30:23.421Z` pass；`09:37:12.861Z` pass；`09:43:54.236Z` pass；`09:50:35.891Z` pass；
- `09:58:15.798Z` **fail**。

### 3. 失败跑自己的工件：mount 阶段，58 个同源模块请求在同一瞬间被 `net::ERR_NETWORK_CHANGED` 打断

失败跑的产物 `/tmp/voice-e2e-plan-SXdPcF/`（`run.json` + `playwright.log`，仍在盘上）：

- `run.json` 的 `failure.phase` = **`"mounted"`**；`failure.message` 逐字开头 `the client never mounted ".chat-messages-pane" inside the 12000ms startup budget.`；`document.body.innerText:` 为空；`pageerror: none`。
- `requestfailed (59)` = 58 条 `http://127.0.0.1:5017/src/**` 与 `/@fs/…/vite-cache/deps/**` 的 `net::ERR_NETWORK_CHANGED` + 1 条 `https://fonts.googleapis.com/css2…` 的 `net::ERR_FAILED`（后者是 spec 自己的 `context.route('**')` 对非 loopback 的刻意 abort，既有行为，非缺陷）。
- trace（`test-results/…/trace.zip` 的 `3-trace.network`，527 条 resource-snapshot）：468 条请求在 `09:58:02.506Z–02.554Z` 全部成功；58 条在 `02.892Z–02.910Z` 这一瞬失败；`02.911Z` 之后的请求又全部 `200`。⇒ 浏览器网络栈只断了一瞬，但被打断的 58 个模块都是聊天区模块图的一部分，ES module 不重试，React 永不上屏。
- `optimizer warm-up: quiet=true after 2938ms; dependency http://127.0.0.1:5017/@fs/…/vite-cache/deps/react_jsx-dev-runtime.js?v=022bc63b HTTP 200; browserHash=9c2fd457` ⇒ `warmClientStartup` 是成功的。它只能把依赖优化器锁在测量窗之外，挡不住宿主级的网络变更通知。

这是本仓已登记过的一族：触发源在仓库之外（宿主 netlink / docker-veth churn），响应必须是有界重放（`e2e/mcp-settings.spec.ts:28`、`e2e/resident-ui-layout.spec.ts:303`；台账归因任务 `gap-ac266-criterion-ledger-red-is-chromium-network-flap`）。AC-408 的 spec 是少数还没有这条回应腿的语音判据。

### 4. 机制：AC-408 的挂载守卫是单发的，没有第二份文档可走

- `e2e/voice-output-e2e-harness.spec.ts:922` 只有一次 `await page.goto(\`/session/${sessionId}\`)`（Playwright 默认导航超时）；`:923` 紧接一次 `awaitClientMounted(page, PANE, 12_000, …)`。
- `e2e/support/client-startup-warmup.ts:241` 的 `awaitClientMounted` 等一次、失败即抛（证据很全，但没有重放）：spec 的整个交互都在同一个 `beforeAll` 里，第一份文档的模块图被打断后没有任何第二次导航。
- 同族已落地的解法就是把「一次导航 + 一次探针」换成「有界重放」：`e2e/session-filter.spec.ts:260`、`e2e/mcp-settings.spec.ts:499` 的 `navigateBounded`，以及 `e2e/support/pane-reload.ts`。本条是把同一对杠杆回灌到 AC-408 的启动路径，不新造第二套机制。
- **预算必须算得过来**。quay 0.20.0 的 acceptance 默认闸是 `DEFAULT_ACCEPTANCE_TIMEOUT_MS = 60_000`（`scripts/dist/driver-runtime.js`）；本轮绿跑 `plan.json 17:59:50.644 → run.json 18:00:23.430` ≈ 33s，整条 `run.mjs` ≈ 35–40s。因此守卫的**总 deadline 必须 ≤ ~18–20s**，让「一次都没落地」的红跑在 60s 之前由守卫自己按名字收尾（否则会变成 AC-327 那种 `not-evaluated (timeout)`，什么原因都读不到）。⚠️ 不要照抄 `session-filter` / `access-tokens-settings` 的 `8_000+8_000 > 14_000` 算术：`gap-ac228-criterion-startup-guard-cannot-afford-a-replay` 已证明那样写时 `page.reload` 是死代码。

### 5. 为什么先前的修复没守住（如实区分）

- `gap-ac408-beforeall-abort-artifact-and-harness-attribution`（done，`704c0b976`）交付的是**可归因**：`currentPhase` + partial dump + 失败摘要进 stderr。它**按设计工作**了——这次红跑留下了 `failure.phase="mounted"` 和 59 条 requestfailed，定位一步到位；但它的范围明确只做归因，不承诺自愈（其 DoD 还写着「08:33 的瞬时根因仍未定位」）。
- `gap-ac408-harness-pin-early-announce-id-family`（done，`35c9ba549`）修的是 announce id 族；`voice-output-tts-downlink-wiring`（done）接通的是 TTS 下行。这两条对应的读数本轮依然全绿（`narrator speaks` 5 条、`tts-requests=1 audio-bytes=80044`）。
- ⇒ 这次不是哪条旧修复失效，而是这族缺陷第一次点名到 AC-408 的 spec 上：**红跑可归因 ≠ 红跑可自愈**。

### 要做的

1. **在 `e2e/support/client-startup-warmup.ts` 增加有界导航守卫**（导出；常数名固定，便于机械判据）：
   - 常数（导出）：`NAVIGATION_PROBE_MS`（首跳 `page.goto` 上界）、`FIRST_LANDING_MS`（首跳落点探针）、`REPLAY_NAVIGATION_MS`（`page.reload` 上界）、`REPLAY_LANDING_MS`（重放落点探针）、`STARTUP_GUARD_DEADLINE_MS`（总预算）。
   - 循环：attempt 1 `page.goto(url, { waitUntil: 'domcontentloaded', timeout: min(NAVIGATION_PROBE_MS, budget) })`；落点 `page.locator(selector).waitFor({ state: 'visible', timeout: min(FIRST_LANDING_MS, budget) })`；未中且预算未尽 ⇒ `page.reload({ timeout: min(REPLAY_NAVIGATION_MS, budget) })` + `min(REPLAY_LANDING_MS, budget)` 探针；重复到 deadline。
   - 每一跳都署名打日志：`[e2e] client startup: <selector> landed after <ms>ms (attempt N)`；重放必须在日志里**可读**，不能只靠源码推断。
   - 预算耗尽时抛**现有证据全量**的错误（页面文本、pageerror、console error、requestfailed、`warmupLine`），并附每跳摘要；`awaitClientMounted` 可保留为单发原语，但错误格式化要共享一份，避免两套措辞漂移。
   - spec 的 page 级监听数组在重放时会累积第一跳的失败；守卫必须**按跳快照**证据并把 attempt 编号带进最终消息，不能把第一跳的 58 条混成重放跳的读数。
2. **把 spec 的首个导航换成守卫**：`e2e/voice-output-e2e-harness.spec.ts:922-923` 的裸 `page.goto` + 单发 `awaitClientMounted` 改成守卫调用（`PANE` 与首次落点预算的语义保留，总预算由新常数给出）。整个 spec 里除此之外没有第二处导航（`grep -n "page.goto\|page.reload"` 只有 `:922`），所以改完就是「所有导航都过守卫」。
3. **确定性控制臂（可复现的假形态）**：在 spec 已有的 `context.route('**')` 处理器里加一个**默认惰性**的注入缝：环境变量 `VOICE_E2E_ABORT_BOOTS=<n>` 存在时，前 n 次文档启动 abort 掉 app 入口（`**/src/main.tsx`），此后放行。`run.mjs` 的 `spawnSync` 用 `env: { ...process.env, … }`，该变量会自动透传，不需要改 `run.mjs`。用它把「宿主网络变更打断模块图」变成可复现的两条臂：
   - `VOICE_E2E_ABORT_BOOTS=1` ⇒ 仍 exit 0，日志含 `(attempt 2)`，九条断言全绿；
   - `VOICE_E2E_ABORT_BOOTS=9` ⇒ exit 1，stderr 含 `[voice-e2e] beforeAll aborted at phase=mounted:`，partial dump 的 `failure.phase === "mounted"`，且消息里带 abort 证据——**不许**因为重放过就把「没落地」当通过。
4. **文档说真话**：更新 `client-startup-warmup.ts` 头注释与 spec 的启动注释：说明 `warmClientStartup` 只证明优化器静默，宿主级网络变更仍可能打断在途模块；响应是有界重放，不是重试掩盖；并把两条控制臂的命令写进去。

### 不要做的

- ⛔ 不改判据命令、不删/跳过/加 tag 任何用例、不加 Playwright `retries`、不放宽任何一条断言。
- ⛔ 不改产品代码（`server/`、`src/`）、`playwright.config.ts`、TTS/relay 的断言面。
- ⛔ 不把「挂载失败」当通过；deadline 耗尽必须红，并且带证据。
- ⛔ 不照抄 `8_000 + 8_000 > 14_000` 的死重放算术；总预算必须 ≥ 首跳 + 首落点 + 重放跳 + 重放落点。
- ⛔ 不在 `experiments/` 下再造第二套 server/browser 启动（spec 头注释已说明为什么必须在 `e2e/`）。
- ⛔ 不掩盖触发源：本条修的是**响应**；宿主网络变更本身仍在仓库之外。

<!-- dedup-ref --> 相关但不同（均 `done`，非重复）：`gap-ac408-beforeall-abort-artifact-and-harness-attribution`（可归因）、`gap-ac408-harness-pin-early-announce-id-family`（announce id 族）、`voice-output-tts-downlink-wiring`（首次接通下行）、`gap-ac266-criterion-ledger-red-is-chromium-network-flap` 与 `gap-ac228-criterion-startup-guard-cannot-afford-a-replay`（同一响应机制，落在别的 spec）。机制去重已查：`tasks/*.md` 中 `goal_ac: AC-408` 且在飞（todo/ready/needs-human）的任务为 0；`task-granularity-advice.js` 对 `e2e/support/client-startup-warmup.ts` 报 `peers: []`、`mentions: []`，本任务 separate。

## AC

- [x] **AC1 守卫已接线，且 spec 的导航全部过守卫**：`grep -qF 'navigateClientBounded' e2e/support/client-startup-warmup.ts`、`grep -qF 'navigateClientBounded' e2e/voice-output-e2e-harness.spec.ts`、且 `test "$(grep -c 'await page.goto(' e2e/voice-output-e2e-harness.spec.ts)" = 0`，总退出码 0。取假形态：当前树（`:922` 裸 `page.goto` + `:923` 单发 `awaitClientMounted`、无 `navigateClientBounded`）第一条 grep 即红。
- [x] **AC2 预算算式可读且可行**：`node -e` 从 `e2e/support/client-startup-warmup.ts` 读五个常数并断言 `NAVIGATION_PROBE_MS + FIRST_LANDING_MS + REPLAY_NAVIGATION_MS + REPLAY_LANDING_MS <= STARTUP_GUARD_DEADLINE_MS` 且 `STARTUP_GUARD_DEADLINE_MS <= 20000`，退出码 0，并打印 `guard: <sum> <= <deadline>`。取假形态：常数缺失时抛 `missing <NAME>`（当前树）；写成兄弟 spec 的 `8_000+8_000+8_000+3_000` 对 `14_000` 时第一条断言必红。
- [x] **AC3 判据命令 3/3 绿且首跳即落地**：连跑三次 `node experiments/voice-e2e-harness/run.mjs --sample 402fad85 --dump /tmp/ac408-ac3-$i.json`（`i=1,2,3`），每次 exit 0；每次输出含 `9 passed`、`[voice-e2e] RESULT: PASS (exit 0)`、`(attempt 1)`；不得出现 `did not run`。贴三次起止时刻与 `narrator speaks` 读数。
- [x] **AC4 重放臂：一次被打断的启动能自愈**：`VOICE_E2E_ABORT_BOOTS=1 node experiments/voice-e2e-harness/run.mjs --sample 402fad85 --dump /tmp/ac408-ac4.json` exit 0；输出含 `9 passed`、`(attempt 2)`；dump 里 `detector.speechStopped === 4`、`narrator.speaks` 5 条、`narrator.tts` 每条 `errorCode === null` 且 `seqs` 从 0 连续。取假形态：把首个导航改回裸 `page.goto` + 单发 `awaitClientMounted`（保留注入缝）时同一命令 exit 1、stderr 含 `beforeAll aborted at phase=mounted`、无 `attempt 2`，必红。
- [x] **AC5 响亮失败臂：重放耗尽仍按名字红，且不被 60s 闸掐断**：`VOICE_E2E_ABORT_BOOTS=9 node experiments/voice-e2e-harness/run.mjs --sample 402fad85 --dump /tmp/ac408-ac5.json`（用 `date +%s%3N` 记墙钟）exit ≠ 0；stderr 含 `[voice-e2e] beforeAll aborted at phase=mounted:`；`/tmp/ac408-ac5.json` 存在且 `failure.phase === "mounted"`、`failure.message` 至少含一条 `net::` 文本与重放跳数；输出不得含 `RESULT: PASS`；墙钟 < 60000ms。取假形态：守卫把重放耗尽误判为成功后，本条会看到 exit 0 或 `RESULT: PASS`，必红。
- [x] **AC6 静态不回归**：`npm run typecheck` exit 0；`npm run lint` exit 0。（如实登记：本仓 `typecheck` 的 include 不含 `e2e/`、`lint` 不扫 `e2e/`，spec 的编译正确性由 AC3–AC5 的实跑转译保证。）

## DoD

- **真实对象被真正操作过**：在本仓库真实的 app server + 真实浏览器（scripted relay / scripted TTS stand-in）上把判据命令跑完 3 次（AC3），并现场跑两条控制臂（AC4/AC5）；贴出原始 stdout/stderr、`/tmp/ac408-*.json` 的关键字段与 `date` 读数——不是「测试存在」。
- **重放可读、不靠推断**：AC4 的 `(attempt 2)` 出现在这一跑自己的输出里；AC3 的 `(attempt 1)` 证明绿路没有被重放拖慢或绕过。
- **不真空**：AC4 的假形态（裸 `page.goto` + 单发探针）与 AC5 的假形态（耗尽当成功）都必须变红；AC5 同时证明「挂载失败」不会被重放洗成通过。
- **预算可信**：贴出 AC5 的墙钟读数，证明红跑在 `DEFAULT_ACCEPTANCE_TIMEOUT_MS=60000` 之前由守卫收尾；贴出 AC3 的绿跑墙钟，证明重放没有把正常路径显著拖慢（每次只付首跳时间）。
- **不改判据面**：`git diff --stat develop HEAD` 只含 Touches 的文件；9 条断言逐字未改；没有 `retries`/`skip`/`test.fixme`。
- **诚实边界**：触发源（宿主 `net::ERR_NETWORK_CHANGED`）在仓库之外，本条不声称修掉它；若 AC3 的 3 次里出现红，按新日志点名 attempt 并记录，不得用重放掩盖。

## Touches

- e2e/support/client-startup-warmup.ts
- e2e/voice-output-e2e-harness.spec.ts
- tasks/gap-ac408-mount-guard-needs-bounded-navigation-replay.md
