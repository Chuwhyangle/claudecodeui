---
id: gap-continuous-experience-criterion-boot-race-under-load
title: AC-361 判据同树 7 pass / 2 fail：连续体验 spec 首个导航后客户端未挂载（46
  个模块请求同刻中止）——补客户端启动预热与有界自报守卫（只改 e2e 夹具）
status: ready
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

- [ ] AC1（假形态排最前，且先红）：把预热临时改成空操作，并强制本 run 冷优化（`optimizeDeps.force` 或等价手段；只出现在临时控制中、完成后全部还原），单跑 `npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 必须退 1，且失败落在**本 spec 自己的启动守卫**（错误文本含页面文本 / console / `requestfailed`），而不是裸的 `Timeout 30000ms exceeded while waiting for locator('.chat-messages-pane')`；同时把运行时那条 `[BABEL] … <本 run dataDir>/vite-cache/deps/…` 行作为「本 run 真的冷了」的读数逐字登记。只恢复预热（优化仍强制冷）后同一命令必须退 0。两次退出码与失败原文进 `## Notes`。
- [ ] AC2：判据命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts && npx playwright test e2e/voice-realtime-continuous-experience.spec.ts`）在当前 tree 连跑 ≥10 次全部退出 0；同一窗口内另有一条 e2e lane 在跑（登记该 lane 的 spec 名与每次时间）。逐次登记 `exit=… wall=…`、`[e2e] server=… client=…`、`client warm-up: …ms` 与 `git rev-parse HEAD`；至少一次删除本 run 的 `vite-cache/deps` 后的冷启动 run 仍退 0。
- [ ] AC3：启动守卫有界自报——把 pane 选择器临时改成必然不存在的哨兵，该次运行必须在 ≤30 s 内以**本 spec 自己的错误**结束，错误里同时含页面文本、`pageerror` / console 证据与 `requestfailed` 的 url（或明确写 none）；不得表现为 `Timeout 30000ms exceeded while waiting for locator('.chat-messages-pane')`。探针还原后判据复绿（给退出码）。
- [ ] AC4：判据未被削弱——`grep -c "^  test(" e2e/voice-realtime-continuous-experience.spec.ts` = 11；`grep -c "expectKnownDefect\|test\.fail\|test\.skip\|fixme" e2e/voice-realtime-continuous-experience.spec.ts` = 0；`git diff develop -- e2e/voice-realtime-continuous-experience.spec.ts` 中 11 条用例的断言逐字节未改；`playwright.config.ts` 逐字节等于基线（`retries` 零新增）。
- [ ] AC5：同一种子连续 3 次读数一致——`QUAY_CONTINUOUS_EXPERIENCE_DUMP=/tmp/ce-boot-race/run{1,2,3}.json` 三次 `jq -cS` 后 sha256 逐字相同；`egress` 读数 `dials:1` 且无 loopback 拒绝；X-1..X-7 逐项读数表写入 `## Notes`（沿用上一任务口径）。预热读数若进入 dump，三次必须一致。
- [ ] AC6：`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts e2e/support/client-startup-warmup.ts` 退出 0；`git diff --stat develop` 只含 `e2e/` 下的文件与本任务自己的 `tasks/…md`，不改 `server/`、`src/`、`playwright.config.ts`。

## DoD

判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts && npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 在门自己所处的并发条件下（同窗口另有一条 e2e lane）连跑 ≥10 次，全部退出 0；本 run 的依赖（重）优化在**任何页面存在之前**已提交；若客户端仍未能挂载，spec 用自己的话在预算内报出页面 / console / `requestfailed` 证据，而不是一个裸的 30 s pane 超时。11 条语音断言一行未改；AC1/AC3 的负正对照与失败原文入档。交付物是真实 e2e 跑过的读数，不是「守卫已存在」。

## Touches

- e2e/voice-realtime-continuous-experience.spec.ts
- e2e/support/client-startup-warmup.ts
- tasks/gap-continuous-experience-criterion-boot-race-under-load.md

## Notes

立案：gap 轮 2026-10-18（本轮 gate fail `2026-10-18T04:55:03.617Z`，tree `8d591c59…`）。同树台账 7 pass / 2 fail（见 Proposal）；本轮直跑判据 exit 0（15 pass + 11 passed / 37.1 s）。两次红（04:13 / 04:54）的 artifact 路径与逐字错误见 Proposal。

<!-- dedup-ref --> 机制去重（登记出处，不是本任务声明的依赖）：同族先例 `gap-voice-dashscope-criterion-boot-dep-reopt-race`（done，AC-142）与 `gap-voice-identifier-criterion-boot-dep-reopt-race`（done）是「`warmClientStartup` 未回灌本 spec」的同一条修法；`gap-ac266-criterion-ledger-red-is-chromium-network-flap`（done）是同树 pass/fail 抖动 + 有界自报的归因先例；`gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence`（done）是 quiescence 判据的出处。这些均 `done`，在飞扫描 0 命中（`grep -l "^goal_ac: AC-361" tasks/*.md` 只命中 7 条 done 任务）。merge-candidate：`task-granularity-advice.js --touches e2e/voice-realtime-continuous-experience.spec.ts --touches e2e/support/client-startup-warmup.ts --json` → `peers: []`、`mentions: []`，**separate**。