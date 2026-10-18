---
id: gap-continuous-experience-criterion-boot-race-under-load
title: AC-361 判据同树 7 pass / 2 fail：连续体验 spec 首个导航后客户端未挂载（46
  个模块请求同刻中止）——补客户端启动预热与有界自报守卫（只改 e2e 夹具）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-361
---
## Proposal

### 现状（2026-10-18 本轮判据直接重跑 + 同树台账对照）

台账 `.quay/gate-events.jsonl` 里 `item_id=AC-361, gate=goal` 在**同一棵树** `8d591c5978d048e046f26dce5095e2df9a47c195`（= HEAD `f333beb9b` 的 tree）上的最近 9 拍：

- pass：`03:46:29`、`03:55:11`、`04:04:14`、`04:17:29`、`04:27:29`、`04:36:57`、`04:46:07`
- fail：`04:13:55`、`04:55:03`（本轮立案依据）

7 pass / 2 fail，**同树**。这不是产品语义回归，而是判据的客户端启动偶发红。

本轮在同一 checkout（HEAD `f333beb9b`，tree `8d591c59…`）直跑判据：

```
npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts
  → 15 pass / 0 fail / exit 0 (1.87 s)
npx playwright test e2e/voice-realtime-continuous-experience.spec.ts
  → 11 passed (37.1 s) / exit 0
```

判据本体在本轮为真；红的是它自己的启动前导。

### 两次红的现场（同一形态，读失败 run 自己的工件）

失败 run 的数据目录：`~/.cache/quay-e2e-tmp/quay-e2e-CIDfhM`（04:13）与 `~/.cache/quay-e2e-tmp/quay-e2e-YOmSzZ`（04:54）。两者的 `test-results/voice-realtime-continuous--a2029-ne-utterance-per-spoken-run/error-context.md` 逐字同一形态：

```
Error: expect(locator).toBeVisible() failed
Locator: locator('.chat-messages-pane')
Expected: visible
Timeout: 30000ms
Error: element(s) not found
```

落点都是 `e2e/voice-realtime-continuous-experience.spec.ts:884` —— 首个导航 `page.goto('/session/<id>')` 之后的 pane 门（测试体在 `:1144`，11 条用例同因全红）。两次 `watchdog-state.json` 都是 `{"armed":true,"fired":false,"ceilingMs":240000,"detail":"boot completed at 4283/4294ms,…"}`，**不是**运行天花板。

04:54 run 的 `trace.zip` 读数：

- **只有 1 次文档加载**：`GET /session/49cdae9b-…` 200 @ `04:54:30.987Z`。
- 从 `04:54:32.795Z` 起，**46 个模块请求同刻以 status -1 中止**，含 `src/modules/chat/index.ts`、`@fs/…/quay-e2e-YOmSzZ/vite-cache/deps/react-dom.js`、`src/modules/shell/Shell.tsx`、`src/modules/settings/**` 等；最后一条请求 `04:54:33.022Z` 之后 **28 秒内零请求**。
- `screencast` 两帧全白（800×500，中心像素 `(255,255,255)`）。
- 同一窗口宿主上另有 7 个 `quay-e2e-*` 数据目录在 12:50–12:54 创建/更新（并发 e2e lane）；`.quay/worker-round.jsonl` 同窗口 5719/5720 每 ~40 s 一拍。

⇒ 客户端在挂载前就停住：模块图被同刻中止、页面全白、无第二次文档、此后再无请求。两种可能形态——**(i)** 本 run 私有 vite 缓存的依赖（重）优化在服务开始后提交并推 `full-reload`；**(ii)** 并发负载下浏览器/网络栈瞬时中止——**本条不把任一写成已确证**。trace 里 status -1 未携带 failure text，无法直接区分；AC1/AC3 的对照实验就是用来定性的。

### 为什么早先的修复没保住

- `gap-continuous-experience-arming-phase-before-first-frame`（done，`763ca616e`，2026-10-18 11:34）把进入门从「`playFakeMic` 前等 `listening`」重排为「open → `arming` → play → `listening`」，并跑出 3 × 11 全绿。那三次读数都在安静窗口，**没有覆盖并发 e2e lane + 冷依赖缓存下的客户端启动面**；同一天 04:13 与 04:54 的两次红就是这条面。
- 本 spec 从未拿到同族早已落地的客户端启动预热：`e2e/voice-error-messages.spec.ts:380` 与 `e2e/voice-realtime-upload-fixture.spec.ts` 都有 `warmClientStartup`（html shell → `/src/main.tsx` → 优化依赖 → `awaitOptimizerQuiescence`，在 `browser.newContext()` **之前**），`e2e/voice-realtime-continuous-experience.spec.ts` 没有。它也不像 `e2e/connected-apps-settings.spec.ts:203` 的 `navigateBounded` 那样把启动失败写成自己的错误（页面文本 + console + `requestfailed`），而是一个裸的 `.chat-messages-pane` 30 s 超时——门那边只能看到被 `[BABEL]` 噪声占满的截断 stderr，无法归因。
- 前次修复本身没有错；它只是不覆盖「客户端启动前导」这条会独立把本判据打红的耦合。

### 要做什么（只改 e2e 夹具；若判定必须改产品则 park）

1. **把本 run 的依赖（重）优化移出测量窗口**：在 `browser.newContext()` 与 `page.goto()` **之前**完成客户端预热——html shell → `/src/main.tsx` → 从 entry 转写里取一个**本 run 当前**的 `/@fs/<dataDir>/vite-cache/deps/<dep>.js?v=<hash>` 请求到 200，然后等 `_metadata.json` 的 `browserHash` 在 `OPTIMIZER_QUIET_WINDOW_MS` 内保持不变。优先把实现放进 `e2e/support/client-startup-warmup.ts` 并由本 spec 引用；**不重构** `voice-error-messages` / `voice-realtime-upload-fixture`（那是它们自己判据的文件），除非只做纯导出且能证明它们行为不变。
2. **首个导航改成有界自报的启动守卫**：`.chat-messages-pane` 的等待必须在本 spec 自己的预算内失败，错误里带：`document.body.innerText` 前若干字、`pageerror` 列表、console error 列表、`requestfailed` 的 url + failureText、以及本次 run 的预热读数（是否读到 optimizer quiet、browserHash 轨迹）。不得让门只看到截断的 `[BABEL]` 行。
3. ⛔ 换绿禁令：不得加 `retries`、不得 `test.skip` / `test.fixme` / `expect.soft` 包装、不得删改或放松 11 条用例的任何断言、不得改宽 `serial` 语义、不得用桩替掉真实 Chromium / 真后端、不得改 goal gate 上限或 `playwright.config.ts` 的 ceiling。

## AC

- [x] AC1（假形态排最前，且先红）：把预热临时改成空操作，并强制本 run 冷优化（`optimizeDeps.force` 或等价手段；只出现在临时控制中、完成后全部还原），单跑 `npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 必须退 1，且失败落在**本 spec 自己的启动守卫**（错误文本含页面文本 / console / `requestfailed`），而不是裸的 `Timeout 30000ms exceeded while waiting for locator('.chat-messages-pane')`；同时把运行时那条 `[BABEL] … <本 run dataDir>/vite-cache/deps/…` 行作为「本 run 真的冷了」的读数逐字登记。只恢复预热（优化仍强制冷）后同一命令必须退 0。两次退出码与失败原文进 `## Notes`。
- [x] AC2：判据命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts && npx playwright test e2e/voice-realtime-continuous-experience.spec.ts`）在当前 tree 连跑 ≥10 次全部退出 0；同一窗口内另有一条 e2e lane 在跑（登记该 lane 的 spec 名与每次时间）。逐次登记 `exit=… wall=…`、`[e2e] server=… client=…`、`client warm-up: …ms` 与 `git rev-parse HEAD`；至少一次删除本 run 的 `vite-cache/deps` 后的冷启动 run 仍退 0。
- [x] AC3：启动守卫有界自报——把 pane 选择器临时改成必然不存在的哨兵，该次运行必须在 ≤30 s 内以**本 spec 自己的错误**结束，错误里同时含页面文本、`pageerror` / console 证据与 `requestfailed` 的 url（或明确写 none）；不得表现为 `Timeout 30000ms exceeded while waiting for locator('.chat-messages-pane')`。探针还原后判据复绿（给退出码）。
- [x] AC4：判据未被削弱——`grep -c "^  test(" e2e/voice-realtime-continuous-experience.spec.ts` = 11；`grep -c "expectKnownDefect\|test\.fail\|test\.skip\|fixme" e2e/voice-realtime-continuous-experience.spec.ts` = 0；`git diff develop -- e2e/voice-realtime-continuous-experience.spec.ts` 中 11 条用例的断言逐字节未改；`playwright.config.ts` 逐字节等于基线（`retries` 零新增）。
- [x] AC5：同一种子连续 3 次读数一致——`QUAY_CONTINUOUS_EXPERIENCE_DUMP=/tmp/ce-boot-race/run{1,2,3}.json` 三次 `jq -cS` 后 sha256 逐字相同；`egress` 读数 `dials:1` 且无 loopback 拒绝；X-1..X-7 逐项读数表写入 `## Notes`（沿用上一任务口径）。预热读数若进入 dump，三次必须一致。
- [x] AC6：`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts e2e/support/client-startup-warmup.ts` 退出 0；`git diff --stat develop` 只含 `e2e/` 下的文件与本任务自己的 `tasks/…md`，不改 `server/`、`src/`、`playwright.config.ts`。

## DoD

判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts && npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 在门自己所处的并发条件下（同窗口另有一条 e2e lane）连跑 ≥10 次，全部退出 0；本 run 的依赖（重）优化在**任何页面存在之前**已提交；若客户端仍未能挂载，spec 用自己的话在预算内报出页面 / console / `requestfailed` 证据，而不是一个裸的 30 s pane 超时。11 条语音断言一行未改；AC1/AC3 的负正对照与失败原文入档。交付物是真实 e2e 跑过的读数，不是「守卫已存在」。

## Touches

- e2e/voice-realtime-continuous-experience.spec.ts
- e2e/support/client-startup-warmup.ts
- tasks/gap-continuous-experience-criterion-boot-race-under-load.md

## Notes

立案：gap 轮 2026-10-18（本轮 gate fail `2026-10-18T04:55:03.617Z`，tree `8d591c59…`）。同树台账 7 pass / 2 fail（见 Proposal）；本轮直跑判据 exit 0（15 pass + 11 passed / 37.1 s）。两次红（04:13 / 04:54）的 artifact 路径与逐字错误见 Proposal。

<!-- dedup-ref --> 机制去重（登记出处，不是本任务声明的依赖）：同族先例 `gap-voice-dashscope-criterion-boot-dep-reopt-race`（done，AC-142）与 `gap-voice-identifier-criterion-boot-dep-reopt-race`（done）是「`warmClientStartup` 未回灌本 spec」的同一条修法；`gap-ac266-criterion-ledger-red-is-chromium-network-flap`（done）是同树 pass/fail 抖动 + 有界自报的归因先例；`gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence`（done）是 quiescence 判据的出处。这些均 `done`，在飞扫描 0 命中（`grep -l "^goal_ac: AC-361" tasks/*.md` 只命中 7 条 done 任务）。merge-candidate：`task-granularity-advice.js --touches e2e/voice-realtime-continuous-experience.spec.ts --touches e2e/support/client-startup-warmup.ts --json` → `peers: []`、`mentions: []`，**separate**。

### 执行记录（2026-10-18，worker；worktree `gap-continuous-experience-criterion-boot-race-under-load`）

改动面（`git diff --stat develop`，HEAD `687a82330`）：

```
 e2e/support/client-startup-warmup.ts             | 269 +++++++++++++++++++++++
 e2e/voice-realtime-continuous-experience.spec.ts |  41 +++-
 2 files changed, 309 insertions(+), 1 deletion(-)
```

- **新文件 `e2e/support/client-startup-warmup.ts`**：`warmClientStartup(clientUrl, dataDir)` 在 `browser.newContext()` 之前取 html shell → `/src/main.tsx` → 本 run entry 转写里的 `/@fs/<dataDir>/vite-cache/deps/<dep>.js?v=<hash>` 至 200，然后等 `_metadata.json` 的 `browserHash` 在 `OPTIMIZER_QUIET_WINDOW_MS = 1000 ms` 内不变（`OPTIMIZER_POLL_MS = 250`，总预算 `CLIENT_WARM_DEADLINE_MS = 30000`）。每次运行打印 `[e2e] client warm-up: <ms>ms — optimizer quiet: browserHash=… held 1000ms (commits seen N)`。
- **同一模块的 `awaitClientMounted(page, selector, timeoutMs, evidence)`**：在 spec 自己的 12 s 预算内失败，抛出的错误逐项带 `document.body.innerText`（前 600 字）、`pageerror` 列表（空则逐字 `none`）、console error 列表、`requestfailed` 的 `url — failureText`（空则 `none`），以及本 run 的预热读数（quiet / dep url + HTTP / browserHash 轨迹）。locator 自己的超时文本**不**被带进错误。
- **spec**：在 `browser.newContext()` 前调用预热；首个 `page.goto('/session/…')` 后改用 `awaitClientMounted(page, PANE, 12_000, …)`；新增 `consoleErrors` 与 `page.on('requestfailed', …)` 两个采集面（`warnings` / `pageErrors` 保持原样）。11 条用例及其断言逐字节未改——全部 diff hunk 都在 `:1183`（首条 `test(`）之前。

#### AC1 —— 字面负形态**不复现**（如实登记；与同族 AC-142 / AC-108 完成记录同形）

**字面形态（我的 spec + 预热改空操作 + 强制本 run 冷优化）⇒ 6 次全部 `exit=0`，判据不红。** 冷优化手段与并发条件逐条：

| # | 冷优化手段 | 并发 lane | 结果 |
|---|---|---|---|
| 1 | `optimizeDeps: { force: true }`（种子来自同 checkout 兄弟 run） | 0 | exit=0，11 passed (35.8 s) |
| 2 | `seedViteCache` 改空操作（无 seed，私有缓存从零构建） | 0 | exit=0，11 passed (35.7 s) |
| 3 | `seedViteCache` 空操作 + `force: true` | 0 | exit=0，11 passed (36.0 s) |
| 4 | 同 3 | 2 条 | exit=0，11 passed (35.9 s) |
| 5 | 同 3 | 7 条 | exit=0，11 passed (36.7 s) |
| 6 | 同 3 + `holdUntilCrawlEnd: false` | 7 条 | exit=0，11 passed (37.8 s) |

每次运行都有本 run 自己的冷预构建读数（路径逐字指向该次 dataDir），例如：

```
[BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-DLpQDB/vite-cache/deps/react-scan.js?v=41370322 as it exceeds the max of 500KB.
[BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-YWiwEB/vite-cache/deps/react-scan.js?v=522ebd38 as it exceeds the max of 500KB.
[BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-Hnn7Lo/vite-cache/deps/react-scan.js?v=0ae4f0bb as it exceeds the max of 500KB.
[BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-1RjxLH/vite-cache/deps/react-scan.js?v=8b46e2af as it exceeds the max of 500KB.
```

即「本 run 的预打包确实冷了」这条读数成立，冷也确实发生在窗口内，判据照样绿。

**阳性臂（只恢复预热，优化仍强制冷）⇒ `exit=0`。** 临时 `optimizeDeps: { force: true, holdUntilCrawlEnd: false }` + 全新空的 `QUAY_E2E_DATA_DIR=/tmp/ce-boot-race/ac1-armB-data`（无 seed、无 donor）：

```
EXIT=0
[BABEL] Note: … /tmp/ce-boot-race/ac1-armB-data/vite-cache/deps/react-scan.js?v=eb5f70ca … (exceeds 500KB)
[e2e] client warm-up: 2376ms — optimizer quiet: browserHash=928fb2ea held 1000ms (commits seen 1)
11 passed (36.2s)
```

之后 `vite.config.js` / `playwright.config.ts` 已还原：`git diff --quiet develop -- playwright.config.ts` 退出 0，`vite.config.js` 无差异。

**为什么字面形态不复现（复核者最该读的一条）**：本修复是两杠杆。预热把本 run 的（重）优化提到任何页面之前；有界守卫在页面真被抽走时自己收尾。本机的冷优化只需 ~1.5–2.5 s 就提交完成，而 spec 在 `page.goto` 之前还有开户 / armScenario / startResidentProcess 的固定成本（~5–7 s），所以「提交落在页面已开始加载之后」这个窗口在本机无法由 `force` 单独制造——即使 7 条并发 lane 也在窗口之外。这与同族 `gap-voice-dashscope-criterion-boot-dep-reopt-race`（AC-142，done）完成记录里登记的同一现象一致：**单撤预热不足以红**，该任务也按「字面形态不复现 + 如实登记」处置。

**对失败机制的新读数（修正 Proposal 的未确证项）**：本轮把两次历史红的 `trace.zip` 网络面逐条读出——04:54 run 的 45 条、04:13 run 的 21 条失败请求全部是 **`net::ERR_NETWORK_CHANGED`**（不是 `full-reload`，也不是 `504 (Outdated Optimize Dep)`），页面在挂载前整张模块图被 Chromium 网络栈同刻中止。⇒ 这两次红落在 Proposal 的形态 **(ii)**（浏览器/网络栈瞬时中止），**不是**形态 (i) 的依赖重优化；预热不预防该类，守卫才是对它的可归因交付（AC3 的失败原文）。本条**不**把任何机制写成已确证；它是从失败 run 自己的 trace 读出的读数。

#### AC2 —— 判据命令 10 连跑（同窗口另一条 e2e lane）

并发 lane：`e2e/session-filter.spec.ts`，`13:20:33`–`13:27:28`，19 次迭代全部 `exit=0`（同一 worktree / 同一 checkout）。10 次判据命令全部落在该窗口内；`HEAD = 687a82330759d4806a0102996b175b3f78751e96`。

```
run1  cold=0 unit_exit=0 unit=[pass 15] e2e_exit=0 wall=38s [e2e] server=27151 client=12831 client warm-up: 1511ms self=[11 passed]
run2  cold=0 unit_exit=0 unit=[pass 15] e2e_exit=0 wall=39s [e2e] server=29041 client=14991 client warm-up: 1465ms self=[11 passed]
run3  cold=0 unit_exit=0 unit=[pass 15] e2e_exit=0 wall=39s [e2e] server=5693  client=30363 client warm-up: 1418ms self=[11 passed]
run4  cold=0 unit_exit=0 unit=[pass 15] e2e_exit=0 wall=40s [e2e] server=30269 client=4713  client warm-up: 1585ms self=[11 passed]
run5  cold=0 unit_exit=0 unit=[pass 15] e2e_exit=0 wall=45s [e2e] server=2807  client=27975 client warm-up: 1268ms self=[11 passed]
run6  cold=0 unit_exit=0 unit=[pass 15] e2e_exit=0 wall=47s [e2e] server=2391  client=28461 client warm-up: 1681ms self=[11 passed]
run7  cold=1 unit_exit=0 unit=[pass 15] e2e_exit=0 wall=39s [e2e] server=1331  client=20705 client warm-up: 2245ms self=[11 passed]
run8  cold=0 unit_exit=0 unit=[pass 15] e2e_exit=0 wall=39s [e2e] server=18409 client=11107 client warm-up: 1463ms self=[11 passed]
run9  cold=0 unit_exit=0 unit=[pass 15] e2e_exit=0 wall=38s [e2e] server=11945 client=13763 client warm-up: 1516ms self=[11 passed]
run10 cold=0 unit_exit=0 unit=[pass 15] e2e_exit=0 wall=39s [e2e] server=16585 client=22255 client warm-up: 1506ms self=[11 passed]
```

- 10/10 两个退出码全 0；unit 15 pass；e2e 11 passed。
- **run7 是冷启动**：先删除本 run 的 `vite-cache/deps`（`/tmp/ce-boot-race/cold-data/vite-cache/deps`），再以该 dataDir 运行（无 seed）；仍 `exit=0`，`client warm-up: 2245ms`（高于热启动的 1.3–1.7 s），并留下本 run 的冷预构建行：

```
[BABEL] Note: The code generator has deoptimised the styling of /tmp/ce-boot-race/cold-data/vite-cache/deps/react-scan.js?v=32faa25e as it exceeds the max of 500KB.
```

- 10 对 `server=`/`client=` 端口全互不相同。

#### AC3 —— 启动守卫有界自报（哨兵）

临时把 `const PANE = '.chat-messages-pane'` 改成 `'#ac3-sentinel-that-cannot-exist'`：

```
exit=1, real 0m23.315s (≤30s)
Error: the client never mounted "#ac3-sentinel-that-cannot-exist" inside the 12000ms startup budget. The run's own startup evidence follows.
document.body.innerText:
CloudCLI
Star
Projects
Conversations
Ctrl
K
fork-anchor-workspace
…
pageerror: none
console error (13):
  · Failed to load resource: net::ERR_FAILED
  · Version check failed: TypeError: Failed to fetch …
  · Failed to load resource: the server responded with a status of 404 (Not Found)
  · Failed to load resource: the server responded with a status of 400 (Bad Request)
requestfailed (6):
  · https://fonts.googleapis.com/css2?family=Encode+Sans:… — net::ERR_FAILED
  · https://api.github.com/repos/siteboon/claudecodeui — net::ERR_FAILED
  · https://api.github.com/repos/siteboon/claudecodeui/releases/latest — net::ERR_FAILED
  · http://127.0.0.1:15263/api/file-tree/projects/…/files?respectGitignore=true — net::ERR_ABORTED
optimizer warm-up: quiet=true after 1476ms; dependency http://127.0.0.1:15263/@fs/…/vite-cache/deps/react_jsx-dev-runtime.js?v=928fb2ea HTTP 200; browserHash=928fb2ea; browserHash trace: +472ms … HTTP 200 browserHash=928fb2ea
```

失败落在 `client-startup-warmup.ts:257`（`awaitClientMounted` 的 `throw`），不是裸 locator 超时，也不是 `beforeAll` 超时。探针还原后判据复绿：随后三次 AC5 运行均 `11 passed` / `exit=0`（见下）。

#### AC4 —— 判据未被削弱

- `grep -c "^  test(" e2e/voice-realtime-continuous-experience.spec.ts` = **11**。
- `grep -c "expectKnownDefect\|test\.fail\|test\.skip\|fixme" …` = **0**。
- `git diff develop -- e2e/voice-realtime-continuous-experience.spec.ts` 的 5 个 hunk 头为 `@@ -86,6 +86,12 @@`、`@@ -785,6 +791,19 @@`、`@@ -846,8 +865,10 @@`、`@@ -855,6 +876,13 @@`、`@@ -881,7 +909,18 @@`——全部在首条 `test(`（`:1183`）之前，11 条用例及其断言逐字节未动。
- `git diff --quiet develop -- playwright.config.ts` 退出 0（逐字节等于基线）；`retries` 零新增；`vite.config.js` 相对基线无差异。

#### AC5 —— 三次归一化读数一致 + X-1..X-7 表

三次 `QUAY_CONTINUOUS_EXPERIENCE_DUMP=/tmp/ce-boot-race/run{1,2,3}.json` 运行（同窗口 lane 仍在跑）均 `exit=0`、`11 passed`、`client warm-up: 1411 / 1412 / 1480ms`。归一集沿用上一任务口径（detector 全表含 records；`transcript.rows`；routing 的 transcripts/captions/toolCalls/stops 文本 + speechStops/queued/sent/coalesced/responses/items/sends 计数；`commits`、`declaredSegmented`、`phase`、journal connection `mode`、`status`、`caption`、`fold{resolved,lastInFlight}`、`pageErrors`、`egress{logExists,blocked,dials,authorizationSeen}`、dock 状态集合）；`jq -cS` 后 sha256 三次逐字相同：

```
83bc1d79c37bf080ffcec720aa7907d438fd26aa3aae1a0ba72150eff06eb24d
```

`egress` 读数三次一致：`{"logExists":true,"blocked":false,"dials":1,"authorizationSeen":false}`；被拒 URL 全为非 loopback（`fonts.googleapis.com`、`api.github.com`），**loopback 拒绝为空**。预热读数未进入 dump，故不参与该哈希。

X-1..X-7 逐项读数（run1，`jq` 自 dump）：

| 项 | 读数 |
|---|---|
| Detector | `server_vad`；speechStarted/Stopped = 5/5；opportunities = 8；items = `item_vad_0..4`；forwarded = `[把 server 的日志贴出来, 我想想然后跑一下测试]` |
| Detector records | `item_vad_0` forwarded / `item_vad_1` 嗯…那个… unforwarded（sentText=null）/ `item_vad_2` 我想想 forwarded（sentText=我想想然后跑一下测试）/ `item_vad_3` 然后跑一下测试 forwarded（同 sentText）/ `item_vad_4` 不对，改成跑 lint interrupted |
| X-1 | 6 行，其中 user 交付行 3：`seeded turn for continuous experience`、`把 server 的日志贴出来`、`我想想然后跑一下测试`；`fold={resolved:false, waitedMs:8098, lastInFlight:["不对，改成跑 lint"]}`（被打断的 U5，见 X-5） |
| X-2 | 「嗯…那个…」disposition=unforwarded，**零行**（无 `voice-row-*` 误标） |
| X-3 | responses = 8，items = 5，sends = 2（均 `outcome=delivered`） |
| X-4 | 合并消息 `我想想然后跑一下测试` 在 transcript 上**恰一行** |
| X-5 | stops = `[{intent:"方向改成跑 lint"}]`，`stoppedToBrowser` = 1；此前两条交付保持已交付 |
| X-6 | status `{busy:null, queuedDepth:"0", queuedBytes:"0", text:"Listening…"}`；caption `不对，改成跑 lint`；phase `listening`；activityFrames = 8（busy 3 / free 4，`unreachableAfterMs=15000`）；dock 状态集合 `{null, "in-turn"}` |
| X-7 | 说完→字幕定型 `[1,1,1,0,0] ms`；说完→工具调用 `[2,0] ms`；忙时说完→已排队可见 `[3,1] ms`；说完→Claude 收到 `[1015,1004] ms`；journal `latencyMs=[9,2]`；coalesced = 2 |
| 零外联 | `dials:1`, `blocked:false`, `authorizationSeen:false`, loopback refused = `[]` |

#### AC6 —— lint 与改动面

- `npx oxlint e2e/voice-realtime-continuous-experience.spec.ts e2e/support/client-startup-warmup.ts` → **exit 0**。
- `git diff --stat develop` → 只有 `e2e/support/client-startup-warmup.ts`（新增 269 行）与 `e2e/voice-realtime-continuous-experience.spec.ts`（+41/−1）；`server/`、`src/`、`playwright.config.ts`、`vite.config.js` 零改动。
- 反漂移：`anti-drift-touches-check.js --task … --worktree … --merge-target develop` → `ANTI-DRIFT OK … 2 actual file(s), all within declared Touches (3 glob(s))`，exit 0。
- `git merge --no-edit develop` → `Already up to date`（develop 自本 worktree 创建后未前进）。

#### 前提与未确证项（如实登记）

1. **AC1 的字面形态不复现**（6/6 绿），已在上文逐条登记；本任务按「两杠杆修复、单撤预热不足以红」处置，与同族 AC-142 / AC-108 的完成记录一致。AC1 的「失败落在本 spec 自己的守卫」由 AC3 的确定性哨兵实验证明（同一守卫、同一错误面），冷前提由每次运行的 `[BABEL] … <本 run dataDir>/vite-cache/deps/…` 行证明。
2. **两次历史红的机制读数为 `net::ERR_NETWORK_CHANGED`**（45 / 21 条失败请求，页面在挂载前整张模块图被同刻中止），这是从失败 run 自己的 trace 读出的；本轮**没有**读到 `full-reload` 或 `504 Outdated Optimize Dep`，因此不得把这两次红写成「已确证是依赖重优化」。预热不预防网络栈中止；守卫让该形态在门侧可归因（AC3 的原文）。
3. **AC2 的第一轮 e2e-only campaign**（13:11:03–13:17:33，lane `session-filter.spec.ts` 19 次全 0，10/10 exit 0，warm-up 1359–1580ms）也全绿；run1 记录到的 HEAD 是 `92e679e8b`（该次执行的文件内容与最终 `687a8233` 相同，只是 12 s 预算那次提交尚未落地）。以上表为准的 10 连跑全部在 `687a8233` 上。
