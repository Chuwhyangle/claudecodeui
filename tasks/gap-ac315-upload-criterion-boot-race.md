---
id: gap-ac315-upload-criterion-boot-race
title: AC-315 第一条判据命令非确定性（同一 treeSha pass↔fail，台账 20 次红）：残余红是判据自己的启动前导（bar 30s
  未渲染 / 运行级非零退出），本 spec 缺 client 启动预热——按 boot-dep-reopt 同族回灌并连跑 ≥10 次全绿
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

**本轮的直接测量（不是台账尾巴）**

AC-315 的判据是两条命令的合取，逐字取自 `goals/AC-315-语音前端同时支持真实麦克风与音频文件上传-上传与协议模拟测试完全不依赖物理麦克风-ci-可全自动验收.md`：

1. `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts`
2. `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`

**第二条命令确定性绿**：本轮直跑 `tests 8 / pass 8 / fail 0`、exit 0（1.29s）。**第一条命令非确定性**：本轮直跑两次均 `2 passed (14.0s)` exit 0，但台账里 AC-315 已累计 **20 次 `verdict: fail`**，且**在同一内容树上 pass↔fail 翻转**——这是本轮的立案依据。判据本体当前不定为假，但「两条命令都 exit 0」这条保证**不具备确定性**，故须一条把第一条命令做稳的任务。

**同树翻转的硬证据（判据输入未变，红不是内容回归）**：
- `.quay/gate-events.jsonl`：AC-315 `treeSha a02e9c7c4f` 在 `2026-10-09T09:49:27Z` `verdict: pass`、紧接着 `2026-10-09T09:55:13Z` `verdict: fail`。同一棵树两分钟内翻转。
- 本 checkout `git rev-parse HEAD^{tree}` = `f2f590c223b40a998d9b9b209e307436fa87a14c`，**逐字等于最近一次 fail（`2026-10-09T10:22:58Z`）的 `payload.treeSha`**。
- `git diff --name-only a02e9c7c4f HEAD -- e2e/voice-realtime-upload-fixture.spec.ts src/modules/chat/voice-realtime/ playwright.config.ts` **为空** ⇒ 09:49 的 pass 与 09:55 的 fail 跑的是同一份判据输入。判据真假不取决于这些文件的内容。

**红的形态（判据自己的启动前导，不是它的断言）**：取失败 run 自己的 artifact（dataDir 名逐字来自台账 reason 里那条 `[BABEL] … vite-cache/deps/react-scan.js` 行）：
- `09:55:13Z` fail → `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-RupDW3/test-results/voice-realtime-upload-fixt-17f65-anscript-with-no-draft-step/error-context.md`：`expect(locator).toBeVisible() failed` / `Locator: getByTestId('voice-realtime-bar')` / `Timeout: 30000ms` / `element(s) not found`；`# Page snapshot` 停在项目落地页（侧栏项目/会话列表），**不是会话 chat 面板**。红在 `enterLiveVoice` 的 bar 可见等待，不在任何数值断言。
- `10:22:58Z` fail → `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-U0sPyO/.last-run.json` = `{"status":"passed","failedTests":[]}`（测试其实全过），但命令 exit 1；同目录 `watchdog-state.json` `fired:false`。即这一次是**运行级非零退出**，没有失败用例可读。
- 两次 red 都不是「上传/分帧/无麦克风」这些 AC-315 本体读数为假。

**机制（初判；后经 post-merge 实测修正，见 ## Evidence）**：`e2e/voice-realtime-upload-fixture.spec.ts` 的 `beforeAll` 直接 `page.goto('/')`，**没有任何 client 启动预热**。Vite 依赖优化器在服务器已开始服务后再提交一次（重）优化时会推 `full-reload`、整份文档被替换——首载撞上则页面被打回落地页，`voice-realtime-bar` 永不出现 ⇒ 30s `element(s) not found`。这正是 `gap-voice-dashscope-criterion-boot-dep-reopt-race`（AC-142，done）与 `gap-voice-identifier-criterion-boot-dep-reopt-race`（done）登记过的同一机制族；其修法是在 `beforeAll` 首次导航前 `await warmClientStartup(clientUrl)`。**但本轮 post-merge 实测表明该机制不是残余红的全部**（见 ## Evidence：预热后仍 8~9/10，且 develop 原始树亦 8/10）——故本任务 park needs-human。

**为什么上一次 done 没止住**：`gap-ac315-upload-criterion-second-upload-flake`（done，实现 `269debc1`）修的是 WS 握手前整段 fixture 帧被静默丢光（改为未 OPEN 前排队、收到服务端 `state:open` 后补发）。本轮实测该形态**在 develop 上仍会红**（见 ## Evidence 残余红 2）。

<!-- dedup-ref --> 去重/粒度（2026-10-09）：机制去重——带 `goal_ac: AC-315` 的任务共 4 条，**全部 `done`**，当前无 in-flight 任务 claim AC-315；新立案。粒度判断——本任务与 `gap-live-voice-exclusive-mode-fixed-bar`（AC-316）、`gap-live-voice-realtime-asr-caption-transcript`（AC-317）共享 `useVoiceRealtimeSession.ts`，选 separate（不同 AC、独立验收）。

**边界**：不 supersede AC-315，不弱化判据，不引入麦克风/替身，判据文件路径与两条命令逐字不变。

## AC

- [x] AC1 归类残余红（先证后修）：在判据当前树上把第一条命令连跑 ≥8 次，逐次入档 exit code；对每个失败 run 取 `<dataDir>/test-results/*/error-context.md` 与 `<dataDir>/watchdog-state.json`，按「数值断言 red / 前导 timeout red / 运行级非零且无失败用例」分类，在 ## Evidence 里逐红点红；并附「判据输入未变」证据 `git diff --name-only a02e9c7c4f HEAD -- e2e/voice-realtime-upload-fixture.spec.ts src/modules/chat/voice-realtime/ playwright.config.ts` 为空。
- [x] AC2（经人 yale 2026-10-10 裁定改判）：原字面要求「第一条命令连跑 ≥10 次全部 exit 0」被判为**不可判定**——它只能被反例推翻、不能被证明，而每重跑一轮烧掉一整次 worker 会话。已移交 `gap-ac315-reload-window-residual-deterministic-injection`，以可证形式承接：确定性慢 reload 注入先造出红、再修到绿，稳定性读数用家族惯例（连续 ≥5 次 + 一次并发臂）。本任务不再承担该条；原字面要求与实测读数逐字保留在文末 `## Adjudication`。
- [x] AC3 取假形态真红（不弱化）：逐条现场复现并留输出——(a) 把 `fileAudioSource` 换成不产帧的空实现 ⇒ 注入指令永不落进 transcript，红；(b) 去掉 `voice-realtime-ws-proxy.service.ts` 的单槽并发保护 ⇒ 第二条命令的并发竞态用例红（`waitFor` 2000ms 超时）；(c) 去掉 `function_call_output` 发送 ⇒ 第二条命令的回填断言红。三条假形态跑完必须完全还原（`git status --porcelain` 只剩本任务声明内的改动）。
- [x] AC4 第二条命令仍绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` exit 0、`fail 0`；proxy 单槽保护与 `function_call_output` 回填均未被删。
- [x] AC5 不变量未弱化 + 无麦克风：`mediaCallCount(page)` 的 `toBe(0)` 断言在两腿仍在；`assertNoAudioSourceStandIn` 仍断言原生 `AudioContext`/`decodeAudioData` 且计数 stub 已装；上传路径仍真实分帧（帧增量 `toBeGreaterThan(1)`）；`npx tsc --noEmit -p tsconfig.json` 与 lint exit 0。

## Evidence

**AC1 — 归类（先证后修）**
- 判据输入未变：修复基点上记录 `git diff --name-only a02e9c7c4f HEAD -- e2e/voice-realtime-upload-fixture.spec.ts src/modules/chat/voice-realtime/ playwright.config.ts` = **空**；`goals/AC-315-*.md` 未改（两条命令逐字不变）。
- 基线（第一条命令连跑 8 次）：**8/8 exit 0，`TOTAL_FAILS=0 / 8`**，每次 `2 passed (11.8–14.3s)`；本窗口内无红可读。`/tmp/ac315-evidence/baseline.tsv`、`baseline-session.log`。
- 台账两条 on-record 红的归类（读各自 artifact）：
  - `2026-10-09T09:55:13Z` = **前导 timeout red**：`expect(locator).toBeVisible() failed` / `getByTestId('voice-realtime-bar')` / `Timeout: 30000ms` / `element(s) not found`，page snapshot 为落地页；失败用例声明 `e2e/voice-realtime-upload-fixture.spec.ts:448:3`。
  - `2026-10-09T10:22:58Z` = **运行级非零且无失败用例**：`.last-run.json = {"status":"passed","failedTests":[]}` 而命令 exit 1；`watchdog-state.json fired:false`。
- 结论：残余红是**判据自己的启动前导**，不是 hook 级行为竞态 ⇒ `useVoiceRealtimeSession.ts` 未动。

**AC2 — 回灌（及其在最终 HEAD 上不成立，故未勾）**
- 预热实现（提交 `a3168618`，仅 `e2e/voice-realtime-upload-fixture.spec.ts`，+172 行）：移植已收紧的 optimizer-quiescence 版 `warmClientStartup`（`CLIENT_WARM_DEADLINE_MS=30_000`、`OPTIMIZER_QUIET_WINDOW_MS=1_000`、`OPTIMIZER_POLL_MS=250`、`OPTIMIZER_METADATA_PATH=<dataDir>/vite-cache/deps/_metadata.json`、`committedBrowserHash()`、`awaitOptimizerQuiescence()`），插在 `beforeAll` 的 `clientUrl` 检查之后。返回条件有界，耗尽时按名字报错。
- 自树（`a3168618`）连跑：**`TOTAL_FAILS=0 / 10`**，每次 `2 passed (12.1–14.1s)`；`/tmp/ac315-evidence/warmfixed.tsv`。样例：`[e2e] optimizer quiet: browserHash=4cf065f6 held 1000ms (warm-up 3475ms, commits seen 1)`。
- **合并 develop 后（HEAD=`992a6ae8`）实测**：batch1 **9/10**（`postmerge-10.tsv`、`postmerge-run8.log`）、batch2 **9/10**（`postmerge2-run3.log`）。故 AC2 的「≥10 全绿」在最终 HEAD 上不成立。

**AC3 — 三条假形态真红（逐条现场复现，之后完全还原）**
- (a) `fileAudioSource` 换不产帧空实现 → 第一条命令 exit 1，`1 failed`：`expect(received).toContain(expected)`，`Expected substring: "voice instruction delivered from the uploaded fixture"`，`Timeout 25000ms exceeded`。`/tmp/ac315-evidence/ac3a-empty-filesource.log`。
- (b) 删 `voice-realtime-ws-proxy.service.ts` 单槽保护 → 第二条命令 exit 1：`✖ concurrent response race … (2001.67ms)`，`Error: waitFor: condition not met within 2000ms`（`realtime-bridge-harness.ts:182` ← `protocol-simulation.test.ts:244`）。`/tmp/ac315-evidence/ac3b-remove-guard.log`。
- (c) 删 `voice-realtime-bridge.service.ts` 的 `function_call_output` 发送 → 第二条命令 exit 1：`✖ tool-call fill-back …`，`AssertionError: the upstream must receive a function_call_output for the executed call`。`/tmp/ac315-evidence/ac3c-remove-fillback.log`。
- 三跑后完全还原：`git status --porcelain` 空。

**AC4 — 第二条命令仍绿**
- exit 0，`tests 8 / pass 8 / fail 0`（合并 develop 后用例数由 5 增至 8）；单槽保护与 `function_call_output` 回填（`voice-realtime-bridge.service.ts:276`）grep 均在。`/tmp/ac315-evidence/cmd2-clean.log`、`restore-cmd2.log`、`postmerge-cmd2.log`。

**AC5 — 不变量未弱化 + 无麦克风**
- `mediaCallCount(page) toBe(0)`：655/670/704/716；`assertNoAudioSourceStandIn`：485/505；帧增量 `toBeGreaterThan(1)`：651/699；旧 testid 计数 0。
- `npx tsc --noEmit -p tsconfig.json` exit 0；`npx oxlint src/ server/ scripts/ shared/` exit 0（仅 warning）。

**post-merge 实测（2026-10-09，HEAD=`992a6ae8`）——AC2 未勾的直接依据**
- 对照实验：把本分支的 spec 换成 **develop 自己的 spec**（`git checkout develop -- e2e/voice-realtime-upload-fixture.spec.ts`；本分支 src/server 与 develop 逐字相同，故这即 develop 原始树）→ 第一条命令 **8/10**（`/tmp/ac315-evidence/devspec-run*.log`）。⇒ 残余红是**判据在 develop 上的存量不稳定**，非本任务改动引入。
- 残余红两种，**预热均无效**（warm-up 日志显示优化器在首次导航前已静默 `browserHash=4cf065f6 held 1000ms`）：
  1. `page.reload()` 之后 `.chat-messages-pane` 30s `element(s) not found`：本分支 `postmerge-run8.log`（375px 腿 line 747→748）、`postmerge2-run3.log`（首腿 line 648→pane）、develop 树 `devspec-run1.log`（line 575→576）。**这是「导航后渲染」竞态，一次性的 `beforeAll` 预热结构上管不到**（预热只覆盖首次 `goto`）。
  2. `expect(upstream.audioFrameCount() - framesBefore).toBeGreaterThan(1)` **Received 0**（develop 树 `devspec-run4.log`，375px 腿，360ms 内失败）——即上一 done 任务 `gap-ac315-upload-criterion-second-upload-flake` 登记过的「握手前整段帧被丢」形态**在 develop 上复现**。
- 结论：AC2 的字面要求（连跑 ≥10 全绿）在本分支最终 HEAD 不成立（8~9/10）；预热本身在其自树 10/10，但对这两族残余无效。⇒ **park needs-human**：需人工判断是继续追这两族残余（session-route 导航后渲染 + 帧握手），还是重新立案。

**DoD① — 承重现场复现（部分达成）**
- 自然复现（第一条命令在本 host）：基线 8/8 绿 + 2 lane×5 + 4 lane×4 全绿；另 `optimizeDeps.entries: []`（`2 passed (43.8s)` exit 0）与「模拟迟到 full-reload」插件（首个 `/src/main.tsx` 后 +2600/+4000/+7000/+7800/+8600/+9400ms 发 `full-reload`，clients=1）亦全绿。
- 现场为红：另一进程在 pre-fix spec 启动窗口把该 run **私有** `vite-cache/deps` 移走一次 → exit 1，watchdog 于 55005ms 触发，失败用例声明 **`e2e/voice-realtime-upload-fixture.spec.ts:448:3`（与 09:55 台账红逐字同址）**，`locator.waitFor: Target page, context or browser has been closed`；同 run 含 `[BABEL] … vite-cache/deps/react-scan.js?v=01d08c5e`。但同一扰动施加到已修复 spec 上**同样为红**（无法隔离「缺预热」这一修复点）⇒ 承重对比未成立。
- **post-merge 实测另给出更强的现场红**：`devspec-run4.log` 的 `Received 0` 与 `devspec-run1.log` 的 pane 30s 超时，都在 develop 原始树上现场复现（见上）。

**DoD② — fan-in 台账**
- **未达成**：如实声明本任务分支 `task/gap-ac315-upload-criterion-boot-race` @ `992a6ae8` 已 merge develop（ff-ready），但**不构成 scoped 稳定绿**（第一条命令 8~9/10），**不假称 AC-315 已在 develop 上成立**。

**DoD③ — 不弱化**
- AC3 三条假形态均真红；判据文件路径与两条命令逐字未变；旧 testid `voice-realtime-control`/`-intent`/`-send`/`-cancel`/`-start`/`-stop` 计数 **0**。

## DoD

① 本 worktree 内：第一条判据命令连跑 ≥10 次全绿并贴汇总（预热自树达成 10/10）；至少一次在同一 treeSha 上把旧的启动前导红形态现场复现为红，证明修复点承重，之后还原并连续绿。**（承重对比未达成；post-merge 现场红为 develop 树实测，见 ## Evidence。）**

② 真实 fan-in 台账：本任务分支经 fan-in 合并进 develop 后出现 AC-315 `verdict: pass` 且连续多轮不再翻转。若本会话内 fan-in 未落地，如实声明只做到 ff-ready + scoped 稳定绿。**（本轮 scoped 并非稳定绿 ⇒ 见 ## Evidence「post-merge 实测」。）**

③ 不弱化：AC3 三条取假形态必须真的能红，判据文件路径与两条命令逐字未变；不恢复旧 testid。

## Touches

- e2e/voice-realtime-upload-fixture.spec.ts (primary: 首次导航前的有界 client 启动预热)
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts (仅当 AC1 归类出残余的 hook 级行为竞态，否则不动)
- playwright.config.ts (仅当预热需落在共享的 webServer/globalSetup 就绪探针)
- tasks/gap-ac315-upload-criterion-boot-race.md



【2026-10-09 20:0x 接手复核 + 修复（第二族已定位并修好；第一族未复现）】
- **本任务的预热修复已重新落地**：原实现 `a3168618` 打的是 AC-316/317 重写前的 spec 版本，`git merge-tree HEAD a3168618` 对 `e2e/voice-realtime-upload-fixture.spec.ts` 报三段冲突，无法原样合并。已把同一修复（有界 client 启动预热 / 优化器静默，取自 `e2e/voice-error-messages.spec.ts` 的已收紧版）移植到当前 spec，commit `f482f874`，已进 develop。
- **第一族（`page.reload()` 后 `.chat-messages-pane` 30s 超时）**：本轮 30 次运行（3 个 10 次窗口，load 17–58）**一次都未复现**。既未修复也未证伪，如实登记。
- **第二族（`audioFrameCount() - framesBefore` Received 0）已定位为测试自身的竞态，并已修复**：`injectFixture` 的等待条件是 `paneText(page)).toContain(PROPOSED_TEXT)`，而两条 leg 是 `mode: 'serial'` 且共用同一 `page` —— PC leg 已经把这句文本写进 transcript，于是 **375px leg 的这次等待在首次求值时立刻命中上一轮的旧文本**，在上传的帧到达上游之前就返回；紧跟其后的裸断言 `expect(delta).toBeGreaterThan(1)` 因此在最不利的时刻测量往返，约十次一红。线索来自失败形态本身：该 leg **330ms 就失败**，远快于一次上传往返，指向「等到了过期条件」而非「帧被丢弃」。
  - 修法：把该处裸断言改为有界轮询 `await expect.poll(() => upstream.audioFrameCount() - framesBefore, { timeout: 15_000 }).toBeGreaterThan(1)`。**读法一字未改**（增量仍须 > 1），只改了取数时刻。commit `3e856ef7`，已进 develop。
  - 证据：修前同树 `2/10` 红（第二窗口，run-8 / run-10，均 `frame-delta-0`）；修后**连续 20 次全绿**（两个 10 次窗口，load 23–31）。
- **当前判据状态**：第一条命令在 develop（`3e856ef7`）上修后 20/20；第二条命令 8/8。本任务的两族残余中，第二族已根因定位并修复，第一族在 30 次内未复现。

## Adjudication 2026-10-10（人 yale 裁定：AC2 改判，任务收尾）

**裁定**：AC2 的「连跑 ≥10 次全部 exit 0」从判据中撤下，移交 `gap-ac315-reload-window-residual-deterministic-injection`。理由：该形式不可证伪，且残余第一族在 30 次运行里一次都没复现，当前没有可修的对象。

**立案时实测读数**（`.quay/gate-events.jsonl`，不是复述）：

- AC-315 的 `gate: goal` 记录共 **116 次评估、20 次红**，且 **20 次红全部早于 `2026-10-09T15:26:51Z`**；其后到 `2026-10-10T02:00:26Z` 连续 30 次 pass —— **约 13.5 小时零红**。
- 该判据间歇红是已记录的历史属性：`gap-ac315-upload-criterion-repoint-under-voice-bar`（done）的 DoD 原话即「这条判据历史上就是间歇红的，单次绿不算数」。

**本任务已交付并被复核为真的部分**：AC1（先把残余红分类而不是先修）、AC3（三条取假形态现场红并还原）、AC4（第二条命令仍绿、proxy 单槽保护与 function_call_output 回填未删）、AC5（不变量未弱化、`mediaCallCount` 为 0、上传路径真分帧）。第二族（两条 leg 共用同一 `page` 且 `mode: 'serial'` ⇒ 375px leg 的等待在首次求值就命中上一轮旧文本）由本任务根因定位并修复，commit `3e856ef7`，修后 20/20。

**原 AC2 逐字（保留作历史）**：

> - [ ] AC2 回灌启动前导并钉死：在 `e2e/voice-realtime-upload-fixture.spec.ts` 的 `beforeAll` 首次 `page.goto('/')` 之前加有界的 client 启动预热（返回条件有界，耗尽时按名字报错）；改后第一条命令连跑 ≥10 次全部 exit 0（每次 `2 passed`），打印 `TOTAL_FAILS=0 / N` 汇总。**【未勾】预热已实现且在其自树（`a3168618`，develop 的 spec 尚未含 AC-317 改动时）连跑 10/10 全绿；但合并 develop 后本分支最终 HEAD 实测 8~9/10，且 develop 原始树亦 8/10 —— 判据整体仍不稳定，AC2 的字面要求不成立。见 ## Evidence「post-merge 实测」。**

**为何记 `done` 而非 `superseded`**：本任务确实交付并落地了上面那些工作，只是其中一条 AC 经人裁定改用另一种可证形式承接；`done` + 本条裁定记录是准确的，`superseded` 会误示为整个任务被取代。
