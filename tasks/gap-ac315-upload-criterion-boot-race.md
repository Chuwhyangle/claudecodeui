---
id: gap-ac315-upload-criterion-boot-race
title: AC-315 第一条判据命令非确定性（同一 treeSha pass↔fail，台账 20 次红）：残余红是判据自己的启动前导（bar 30s
  未渲染 / 运行级非零退出），本 spec 缺 client 启动预热——按 boot-dep-reopt 同族回灌并连跑 ≥10 次全绿
status: ready
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

**机制（同族已两度落地，本 spec 未回灌）**：`e2e/voice-realtime-upload-fixture.spec.ts` 的 `beforeAll` 直接 `page.goto('/')`，**没有任何 client 启动预热**（`grep -n warmClientStartup e2e/voice-realtime-upload-fixture.spec.ts` 与孪生 spec `e2e/voice-realtime-live-session-send.spec.ts` 均 0 命中）。Vite 依赖优化器在服务器已开始服务后再提交一次（重）优化时，会向已连接客户端推 `full-reload`、整份文档被替换——首载/`beforeAll` 恰落在这次提交上，页面被打回落地页，`voice-realtime-bar` 永不出现 ⇒ 30s `element(s) not found`。这正是 `gap-voice-dashscope-criterion-boot-dep-reopt-race`（AC-142，done）与 `gap-voice-identifier-criterion-boot-dep-reopt-race`（done）登记过的同一机制族；其修法是在 spec 内的 `beforeAll` 首次导航前 `await warmClientStartup(clientUrl)`（同族实现见 `e2e/session-filter.spec.ts:127`）。且该 helper 的返回条件已被 `gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence`（done）收紧为「优化器静默（`_metadata.json` 的 `browserHash` 有界窗口内不变）」，但**只落到了 AC-153 的 spec**——helper 是各 spec 各一份拷贝，本 spec 连旧版都没抄。执行者须先按 AC1 从失败 run 的 artifact 归类确认这是启动前导（而非 hook 内的残余行为竞态），再据此回灌。

**为什么上一次 done 没止住**：`gap-ac315-upload-criterion-second-upload-flake`（done，实现 `269debc1`）修的是**另一条**竞态——WS 握手前整段 fixture 帧被静默丢光（改为未 OPEN 前排队、收到服务端 `state:open` 后补发）。它把 375px 腿的「帧增量 > 1」断言做稳了，但其自己的 DoD② 已如实登记「develop 上 AC-315 仍在 goal 台账里 pass↔fail 翻转」。残余红的形态不是那条帧断言，而是**判据自己的启动前导**（bar 从未渲染 / 运行级非零退出）⇒ 是另一机制，需另修。

<!-- dedup-ref --> 去重/粒度（2026-10-09）：机制去重——带 `goal_ac: AC-315` 的任务共 4 条（`gap-voice-realtime-upload-audio-and-protocol-simulation`、`gap-ac315-voice-upload-orphaned-never-merged`、`gap-ac315-upload-criterion-repoint-under-voice-bar`、`gap-ac315-upload-criterion-second-upload-flake`）**全部 `done`**，当前**无任何 in-flight 任务 claim AC-315**；done 任务按规则不是 duplicate，而是「上一次没守住」的证据，故新立案。同族 `gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence`（done）只收紧 AC-153 spec 的返回条件，本 spec 的**缺失预热**是其 rollout 缺口，属「相关但不同」不重复。粒度判断——`task-granularity-advice.js --touches e2e/voice-realtime-upload-fixture.spec.ts --touches src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts --touches playwright.config.ts` 报 `peers`：`gap-live-voice-exclusive-mode-fixed-bar`（ready，AC-316）与 `gap-live-voice-realtime-asr-caption-transcript`（todo，AC-317）各共享 `useVoiceRealtimeSession.ts`；选 **separate** 而非 merge：三者是不同的 AC、各自独立验收，把本工作折进去只会耦合验收；调度器按 Touches 串行即可。

**边界**：不 supersede AC-315（人 yale 已裁定其保持 achieved、未被 supersede），不弱化判据，不引入麦克风/替身，判据文件路径与两条命令逐字不变。

## AC

- [x] AC1 归类残余红（先证后修）：在判据当前树上把第一条命令连跑 ≥8 次，逐次入档 exit code；对每个失败 run 取 `<dataDir>/test-results/*/error-context.md` 与 `<dataDir>/watchdog-state.json`，按「数值断言 red / 前导 timeout red / 运行级非零且无失败用例」分类，在 ## Evidence 里逐红点红；并附「判据输入未变」证据 `git diff --name-only a02e9c7c4f HEAD -- e2e/voice-realtime-upload-fixture.spec.ts src/modules/chat/voice-realtime/ playwright.config.ts` 为空。
- [x] AC2 回灌启动前导并钉死：在 `e2e/voice-realtime-upload-fixture.spec.ts` 的 `beforeAll` 首次 `page.goto('/')` 之前加有界的 client 启动预热（同族实现 `e2e/session-filter.spec.ts:127` 的 `warmClientStartup`，或已收紧的「优化器静默」版；返回条件有界，耗尽时按名字报错而非无限等待）；改后第一条命令连跑 ≥10 次全部 exit 0（每次 `2 passed`），打印 `TOTAL_FAILS=0 / N` 汇总。
- [x] AC3 取假形态真红（不弱化）：逐条现场复现并留输出——(a) 把 `fileAudioSource` 换成不产帧的空实现 ⇒ 注入指令永不落进 transcript 且帧增量 ≤1，红；(b) 去掉 `voice-realtime-ws-proxy.service.ts` 的单槽并发保护 ⇒ 第二条命令的并发竞态用例红（`waitFor` 2000ms 超时）；(c) 去掉 `function_call_output` 发送 ⇒ 第二条命令的回填断言红。三条假形态跑完必须完全还原（`git status --porcelain` 只剩本任务声明内的改动）。
- [x] AC4 第二条命令仍绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` exit 0、`fail 0`；proxy 单槽保护（`voice-realtime-ws-proxy.service.ts` 的 `if (pending) throw`）与 `function_call_output` 回填（`voice-realtime-bridge.service.ts`）均未被删。
- [x] AC5 不变量未弱化 + 无麦克风：`e2e/voice-realtime-upload-fixture.spec.ts` 里 `mediaCallCount(page)` 的 `toBe(0)` 断言在两腿仍在；`assertNoAudioSourceStandIn` 仍断言原生 `AudioContext`/`decodeAudioData` 且计数 stub 已装；上传路径仍真实分帧（帧增量 `toBeGreaterThan(1)`）；`npx tsc --noEmit -p tsconfig.json` 与 lint exit 0。

## Evidence

**AC1 — 归类（先证后修）**
- 判据输入未变：修复基点上记录 `git diff --name-only a02e9c7c4f HEAD -- e2e/voice-realtime-upload-fixture.spec.ts src/modules/chat/voice-realtime/ playwright.config.ts` = **空**；`goals/AC-315-*.md` 未改（两条命令逐字不变）。
- 基线（第一条命令连跑 8 次）：**8/8 exit 0，`TOTAL_FAILS=0 / 8`**，每次 `2 passed (11.8–14.3s)`；本窗口内无红可读。`/tmp/ac315-evidence/baseline.tsv`、`baseline-session.log`。
- 台账两条 on-record 红的归类（读各自 artifact）：
  - `2026-10-09T09:55:13Z` = **前导 timeout red**：`error-context.md` `expect(locator).toBeVisible() failed` / `Locator: getByTestId('voice-realtime-bar')` / `Timeout: 30000ms` / `element(s) not found`，page snapshot 为落地页；失败用例声明 `e2e/voice-realtime-upload-fixture.spec.ts:448:3`。
  - `2026-10-09T10:22:58Z` = **运行级非零且无失败用例**：`.last-run.json = {"status":"passed","failedTests":[]}` 而命令 exit 1；`watchdog-state.json fired:false`。
  - 二者都不是数值断言 red（`audioFrameCount()>1`、transcript 落字均为真）。
- 结论：残余红是**判据自己的启动前导**，不是 hook 级行为竞态 ⇒ `useVoiceRealtimeSession.ts` 未动。

**AC2 — 回灌 + 连跑 ≥10 全绿**
- 预热实现（唯一改动提交 `a3168618`，仅 `e2e/voice-realtime-upload-fixture.spec.ts`，+172 行）：移植**已收紧**的 optimizer-quiescence 版 `warmClientStartup`（常量 `CLIENT_WARM_DEADLINE_MS=30_000`、`OPTIMIZER_QUIET_WINDOW_MS=1_000`、`OPTIMIZER_POLL_MS=250`、`OPTIMIZER_METADATA_PATH=<dataDir>/vite-cache/deps/_metadata.json`、`committedBrowserHash()`、`awaitOptimizerQuiescence()`），插在 `beforeAll` 的 `clientUrl` 检查之后（`e2e/voice-realtime-upload-fixture.spec.ts:547`）。返回条件有界（30s 预算 + 1s 静默窗），耗尽时按名字报错（`the optimizer never went quiet inside the …ms startup budget`），不无限等待。同族可对照 `e2e/voice-error-messages.spec.ts`、`e2e/mcp-settings.spec.ts`。
- 连跑：**`TOTAL_FAILS=0 / 10`**，每次 `2 passed (12.1–14.1s)`；`/tmp/ac315-evidence/warmfixed.tsv`、`warmfixed-run1.log`、`warmfixed-run10.log`。样例：`[e2e] optimizer quiet: browserHash=4cf065f6 held 1000ms (warm-up 3475ms, commits seen 1)` / `[e2e] client warm-up: 3475ms`。

**AC3 — 三条假形态真红（逐条现场复现，之后完全还原）**
- (a) `src/modules/chat/voice-realtime/audioSource.ts` 的 `fileAudioSource` 换不产帧空实现 → 第一条命令 exit 1，`1 failed`：`expect(received).toContain(expected)`，`Expected substring: "voice instruction delivered from the uploaded fixture"`，`Timeout 25000ms exceeded`（`e2e/voice-realtime-upload-fixture.spec.ts:527`）。`/tmp/ac315-evidence/ac3a-empty-filesource.log`。
- (b) 删 `voice-realtime-ws-proxy.service.ts` 单槽保护（`if (sending) throw new Error('A previous voice instruction is still being sent.')`）→ 第二条命令 exit 1：`✖ concurrent response race … refused, not run concurrently (2001.67ms)`，`Error: waitFor: condition not met within 2000ms`（`server/modules/voice-realtime/tests/realtime-bridge-harness.ts:182` ← `protocol-simulation.test.ts:244`）。`/tmp/ac315-evidence/ac3b-remove-guard.log`。
- (c) 删 `voice-realtime-bridge.service.ts` 的 `function_call_output` 发送 → 第二条命令 exit 1：`✖ tool-call fill-back …`，`AssertionError: the upstream must receive a function_call_output for the executed call`（`protocol-simulation.test.ts:279`）。`/tmp/ac315-evidence/ac3c-remove-fillback.log`。
- 三跑后完全还原：`git status --porcelain` 空。

**AC4 — 第二条命令仍绿**
- `npx tsx --tsconfig server/tsconfig.json --test …protocol-simulation.test.ts` → exit 0，`tests 5 / pass 5 / fail 0`；单槽保护（`voice-realtime-ws-proxy.service.ts` 的 `if (sending) throw`）与 `function_call_output` 回填（`voice-realtime-bridge.service.ts:276`）grep 均在。`/tmp/ac315-evidence/cmd2-clean.log`、`restore-cmd2.log`。

**AC5 — 不变量未弱化 + 无麦克风**
- `mediaCallCount(page) toBe(0)`：655/670/704/716；`assertNoAudioSourceStandIn`：485/505；帧增量 `toBeGreaterThan(1)`：651/699；旧 testid 计数 0。
- `npx tsc --noEmit -p tsconfig.json` exit 0；`npx oxlint src/ server/ scripts/ shared/` exit 0（仅 warning）。`npm run lint` 不覆盖 `e2e/`。

**DoD① — 承重现场复现（部分达成，如实登记）**
- **自然复现：0 红**——第一条命令在本 host 共 34 条自然 run（基线 8 + 2 lane×5=10 + 4 lane×4=16）全绿；另 `vite.config.js` 临时 `optimizeDeps.entries: []`（逼首变换才发现依赖）仍 `2 passed (43.8s)` exit 0；「模拟迟到 full-reload」插件（在首个 `/src/main.tsx` 后 +2600/+4000/+7000/+7800/+8600/+9400ms 发 `server.ws.send({type:'full-reload'})`，clients=1）亦全绿（`/tmp/ac315-evidence/dod1-*.log`）。该红是亚秒级 timing lottery，本会话未掷中；台账 20 次红来自 fan-in 突发。判据多数断言读 **server 侧持久状态**（历史 transcript），文档被替换后可自愈，故对本 host 的注入不敏感。
- **现场为红：1 次成功**——另一进程在 pre-fix spec 启动窗口（`_metadata.json` 出现后）把该 run **私有** `vite-cache/deps` 目录移走一次（即台账 reason 命名的 `vite-cache/deps/*` 失效机制）→ exit 1，watchdog 于 55005ms 触发，失败用例声明 **`e2e/voice-realtime-upload-fixture.spec.ts:448:3`（与 09:55 台账红逐字同址）**，`locator.waitFor: Target page, context or browser has been closed`（项目行按钮从未渲染）；同 run 输出含 `[BABEL] Note: The code generator has deoptimised the styling of …/vite-cache/deps/react-scan.js?v=01d08c5e`（与台账 reason 逐字同形）。dataDir `quay-e2e-E4MCmT`。
- **承重对比：未成立**——同一次 cache 失效施加到**已修复**的 spec 上**同样为红**（`quay-e2e-ziBDed`，watchdog 55s；warm-up 日志已观测到失效：`browserHash=<unreadable: ENOENT …> (commits seen 2)`，仍无法挽救）；入口触发式单次失效（首个 `/src/main.tsx` 后 1200ms 移走 deps）在 pre-fix spec 上甚至未落地（`2 passed (14.6s)` exit 0）。⇒ 该人工扰动比真实竞态**更狠**（打的是「URL 指向已被移走的文件」这一层），不能隔离出「缺预热」这一修复点。
- **结论**：DoD①「现场复现为红」**达成**（同 treeSha、同用例、同声明行、同 `vite-cache/deps` 机制）；其「证明修复点承重」**未达成**（无法构造只打红 pre-fix、只放过 fixed 的扰动）。修复点承重性由机制分析与同族两次 done 先例（AC-142 / AC-identifier）支撑，而非本会话的现场对比。改动后 `git status --porcelain` 空，连续绿（见 AC2）。

**DoD② — fan-in 台账**
- **未达成（本会话内 fan-in 未落地）**：如实声明本任务分支当前仅做到 **ff-ready**（`task/gap-ac315-upload-criterion-boot-race` @ `a3168618`，tree `02e2cdaaa28377c5e2d70bb367b9174b09417079`）**+ scoped 稳定绿**（第一条命令连跑 ≥10 全绿、第二条命令绿、tsc/lint 绿）。**不假称 AC-315 已在 develop 上成立**——develop 上的 goal 台账见证由 fan-in 落地后的 driver 轮次给出。

**DoD③ — 不弱化**
- AC3 三条假形态均**真红**（见上）；判据文件路径与两条命令逐字未变（AC1 证据）；旧 testid `voice-realtime-control`/`-intent`/`-send`/`-cancel`/`-start`/`-stop` 计数 **0**。

## DoD

① 本 worktree 内：第一条判据命令连跑 ≥10 次全绿并贴汇总；至少一次在**同一 treeSha** 上把旧的启动前导红形态现场复现为红（例如临时撤掉预热 → 首载撞 full-reload → bar 30s 未现 ⇒ `element(s) not found`），证明修复点承重，之后还原并连续绿。

② 真实 fan-in 台账：本任务分支经 fan-in 合并进 develop 后，goal driver 在 develop 上重评 AC-315 → `.quay/gate-events.jsonl` 出现 AC-315 `verdict: pass`，**且随后连续多轮不再翻转**（同一 `item_id` 连续 pass，而非单点 pass 前后夹 fail）。若本会话内 fan-in 未落地（`.git/fan-in.lock` 排队等），**如实声明只做到 ff-ready + scoped 稳定绿，不得假称已在 develop 上成立**。

③ 不弱化：AC3 三条取假形态必须真的能红，判据文件路径与两条命令逐字未变；不恢复旧 testid（`voice-realtime-control`/`-intent`/`-send`/`-cancel`/`-start`/`-stop`）。

## Touches

- e2e/voice-realtime-upload-fixture.spec.ts (primary: 首次导航前的有界 client 启动预热)
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts (仅当 AC1 归类出残余的 hook 级行为竞态，否则不动)
- playwright.config.ts (仅当预热需落在共享的 webServer/globalSetup 就绪探针)
- tasks/gap-ac315-upload-criterion-boot-race.md
