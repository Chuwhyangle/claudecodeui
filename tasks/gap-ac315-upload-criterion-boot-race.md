---
id: gap-ac315-upload-criterion-boot-race
title: AC-315 第一条判据命令非确定性（同一 treeSha pass↔fail，台账 20 次红）：残余红是判据自己的启动前导（bar 30s
  未渲染 / 运行级非零退出），本 spec 缺 client 启动预热——按 boot-dep-reopt 同族回灌并连跑 ≥10 次全绿
status: todo
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

- [ ] AC1 归类残余红（先证后修）：在判据当前树上把第一条命令连跑 ≥8 次，逐次入档 exit code；对每个失败 run 取 `<dataDir>/test-results/*/error-context.md` 与 `<dataDir>/watchdog-state.json`，按「数值断言 red / 前导 timeout red / 运行级非零且无失败用例」分类，在 ## Evidence 里逐红点红；并附「判据输入未变」证据 `git diff --name-only a02e9c7c4f HEAD -- e2e/voice-realtime-upload-fixture.spec.ts src/modules/chat/voice-realtime/ playwright.config.ts` 为空。
- [ ] AC2 回灌启动前导并钉死：在 `e2e/voice-realtime-upload-fixture.spec.ts` 的 `beforeAll` 首次 `page.goto('/')` 之前加有界的 client 启动预热（同族实现 `e2e/session-filter.spec.ts:127` 的 `warmClientStartup`，或已收紧的「优化器静默」版；返回条件有界，耗尽时按名字报错而非无限等待）；改后第一条命令连跑 ≥10 次全部 exit 0（每次 `2 passed`），打印 `TOTAL_FAILS=0 / N` 汇总。
- [ ] AC3 取假形态真红（不弱化）：逐条现场复现并留输出——(a) 把 `fileAudioSource` 换成不产帧的空实现 ⇒ 注入指令永不落进 transcript 且帧增量 ≤1，红；(b) 去掉 `voice-realtime-ws-proxy.service.ts` 的单槽并发保护 ⇒ 第二条命令的并发竞态用例红（`waitFor` 2000ms 超时）；(c) 去掉 `function_call_output` 发送 ⇒ 第二条命令的回填断言红。三条假形态跑完必须完全还原（`git status --porcelain` 只剩本任务声明内的改动）。
- [ ] AC4 第二条命令仍绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` exit 0、`fail 0`；proxy 单槽保护（`voice-realtime-ws-proxy.service.ts` 的 `if (pending) throw`）与 `function_call_output` 回填（`voice-realtime-bridge.service.ts`）均未被删。
- [ ] AC5 不变量未弱化 + 无麦克风：`e2e/voice-realtime-upload-fixture.spec.ts` 里 `mediaCallCount(page)` 的 `toBe(0)` 断言在两腿仍在；`assertNoAudioSourceStandIn` 仍断言原生 `AudioContext`/`decodeAudioData` 且计数 stub 已装；上传路径仍真实分帧（帧增量 `toBeGreaterThan(1)`）；`npx tsc --noEmit -p tsconfig.json` 与 lint exit 0。

## DoD

① 本 worktree 内：第一条判据命令连跑 ≥10 次全绿并贴汇总；至少一次在**同一 treeSha** 上把旧的启动前导红形态现场复现为红（例如临时撤掉预热 → 首载撞 full-reload → bar 30s 未现 ⇒ `element(s) not found`），证明修复点承重，之后还原并连续绿。

② 真实 fan-in 台账：本任务分支经 fan-in 合并进 develop 后，goal driver 在 develop 上重评 AC-315 → `.quay/gate-events.jsonl` 出现 AC-315 `verdict: pass`，**且随后连续多轮不再翻转**（同一 `item_id` 连续 pass，而非单点 pass 前后夹 fail）。若本会话内 fan-in 未落地（`.git/fan-in.lock` 排队等），**如实声明只做到 ff-ready + scoped 稳定绿，不得假称已在 develop 上成立**。

③ 不弱化：AC3 三条取假形态必须真的能红，判据文件路径与两条命令逐字未变；不恢复旧 testid（`voice-realtime-control`/`-intent`/`-send`/`-cancel`/`-start`/`-stop`）。

## Touches

- e2e/voice-realtime-upload-fixture.spec.ts (primary: 首次导航前的有界 client 启动预热)
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts (仅当 AC1 归类出残余的 hook 级行为竞态，否则不动)
- playwright.config.ts (仅当预热需落在共享的 webServer/globalSetup 就绪探针)
- tasks/gap-ac315-upload-criterion-boot-race.md
