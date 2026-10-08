---
id: gap-ac153-criterion-wallclock-load-headroom
title: "AC-153 判据在扇入负载下越过 spec 自己的 45000ms 整轮墙钟预算而红（两份 error-context 都是 spec:699
  的预算断言，Received 53956 / 56103ms，后者被 55s 看门狗 SIGKILL）——AC-153 的 expect:
  未点任何墙钟，该预算属任务自加守则：按负载余量重标并削减首载固定开销，负载臂实测达标"
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-153
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是复述台账尾巴）。AC-153 记录 `status: achieved`，其 GOAL-011 已 `achieved`、不再活，且未声明 `long-term: true`，故台账 `gate=goal` 尾部按 CURRENTLY FALSE 交办。

判据物（逐字取自 `goals/AC-153-真实浏览器里各类失败显示各自的文案-提示持续显示到关闭-草稿保留-技术细节折叠.md` 的 `criterion:`）：`npx playwright test e2e/voice-error-messages.spec.ts`。

### 本轮直接现测：安静宿主上判据是绿的，红是负载下的整轮墙钟预算断言

本轮开工 `HEAD=510fbfe1`（branch `author`），出货命令逐字直跑一次 `exit 0`：spec 自印 `legs=4 passed=4 criterion-wall-ms=37378 watchdog-line=false`（`1 passed (37.1s)`；宿主 `load1≈161`）。四条腿文案、4 秒持续、草稿逐字、折叠技术详情、无拼接句全部 passed —— **产品面读数为真**。

台账 `.quay/gate-events.jsonl` 里 AC-153 `gate=goal` 最近两次读数（`2026-10-08T16:29:44Z` goal-sweep、`16:30:51Z` goal-cli，同 tree `8fd543ac` = HEAD 的 tree）都 `verdict: fail`，其 `payload.reason` 只有 webServer 引导输出（`[BABEL] … react-scan.js` / `vite ws proxy error: read ECONNRESET` / `DEP0190`）——只看该字段会误判成「启动即哑、无测试输出」。读两份 e2e artifact 才是真读数：

```
quay-e2e-HMsj94 (16:29:44Z, goal-sweep): Error: Channel closed
                                          Error: the criterion exceeded its 45000ms budget
                                          Expected: < 45000 / Received: 56103
                                          watchdog-state.json: {"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55000ms"}
quay-e2e-YA7zgA (16:30:51Z, goal-cli):   Error: the criterion exceeded its 45000ms budget
                                          Expected: < 45000 / Received: 53956
                                          watchdog-state.json: {"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}
```

error-context 逐字路径：
- `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-HMsj94/test-results/voice-error-messages-AC-15-542d2-ence-and-the-notice-behaves/error-context.md`
- `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-YA7zgA/test-results/voice-error-messages-AC-15-542d2-ence-and-the-notice-behaves/error-context.md`

断言落点：`e2e/voice-error-messages.spec.ts:699` 的 `expect(criterionWallMs, 'the criterion exceeded its 45000ms budget').toBeLessThan(45_000)`，其中 `criterionWallMs = Date.now() - Number(process.env.QUAY_E2E_RUN_STARTED_AT)`——**从整轮 `npx playwright test` 起算，含 config 求值、seeding、两个 webServer 引导、浏览器启动与用例体**（`playwright.config.ts:33-46` 的书面设计：注释明写「a spec that timed its own body would report a number whose shortfall against the ceiling is the part it could not observe」）。

两次红的 error-context 里**只有预算断言这一条**（HMsj94 另有一句 `Channel closed`，是 55s 看门狗 SIGKILL 收尾时关掉 CDP 通道的表象）⇒ **失败跑里的四条腿读了正确的值，红的是预算，不是判据为假**。

### 机制：AC-153 的 `expect:` 未点任何墙钟 ⇒ 45000 是任务自加守则，可按负载余量重标

AC-153 的 `expect:` 逐字只要求：四条腿各自的中文文案、4 秒后仍可见、点关闭消失、下次录音清除、草稿逐字保留、折叠技术详情展开前后两读数、无拼接句、空 200 与 422 同句、三条取假形态必须红——**没有一个字点到墙钟**。45000ms 上限来自交付任务 `gap-voice-error-notice-browser-e2e` 的 AC1（`criterion-wall-ms=<n> 且 < 45000`），是**任务自加的守则**，不是 AC 的保证。按 `task-internal-budget-flush-against-floor-is-a-load-flake` 的判法：先读 AC 的 `expect:` 是否点名该界，未点名即任务自加守则、可重标（这不是「放宽 AC」）。

安静宿主上的分段（本轮直跑，`load1≈161`，spec 自印 stage 时间戳）：

```
 0      → ~4.0s   config 求值 + seeding + 两个 webServer 引导（Running 1 test）
 ~4.0s  → +7.1s   浏览器启动 + warmClientStartup（2891ms）+ goto 前导
 +7.1s  → +17.7s  首次 goto + 账户表单渲染 ≈ 10.7s      ← 最大的可削固定开销
 +17.7s → +18.6s  onboarding 向导提交
 +18.6s → +22.5s  打开会话 + composer + 设置页/语音页签/写配置
 +22.5s → +24.2s  腿 1 录制
 +24.2s → +29.5s  4 秒以上持续读数（AC 正文强制，5.3s）
 +29.5s → +36.5s  腿 2/3/4
 结束 criterion-wall-ms=37378
```

⇒ 固定启动（config+seeding+webServer+浏览器启动+首载）≈ 18.8s，用例体 ≈ 18.6s。安静宿主上距 45000 只剩 **7.6s**（17%）余量；宿主负载抬到 `load1≈218`（两次红发生时的读数，见 `.quay/goal-round.jsonl` 的 frozenRecheck）时整轮越过 45000、并在一次里撞上 55s 看门狗。

### 与既有任务的关系（机制去重）

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rln "^goal_ac: *AC-153" tasks/*.md` 命中三条，`status` 全为 `done`：`gap-voice-error-notice-browser-e2e`（交付 AC-153 的产品面，即上面 45000 守则的来源）、`gap-ac153-ledger-red-is-host-quota`（上一轮台账红实为宿主 EDQUOT 在判据启动前冒名，不是判据假）、`gap-e2e-data-dir-has-no-reclaimer`（e2e 数据目录回收）。**在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-153`）⇒ 0 命中**，故本条不是重复；那三条 done 里没有一条碰过「负载下的整轮墙钟守则」。

`gap-ac194-criterion-wallclock-load-scaled-fixed-cost`（done）与 `gap-ac199-criterion-wallclock-load-scaled-fixed-cost`（done）是**同族不同判据**：它们把整轮墙钟红判为「任务自加守则 vs 负载」。AC-194 那条的结论是其红的 >2/3 花在 runner boot（config 求值 + webServer 引导 + 浏览器启动），spec 侧无可削项，且其 DoD 的「回退即再越线」分辨力在 28+ 路并发下不可达。**本条与之的关键差别有二**，本轮均已实测：(1) AC-153 的安静余量更小（7.6s，AC-194 约 22s）；(2) AC-153 的膨胀**不全在 boot**——安静分段里 boot+浏览器启动+首载 ≈ 18.8s，其中**首载一段 ≈ 10.7s** 是冷 Vite 优化器/整文档替换那条已知可治的路径（与 `gap-voice-dashscope-criterion-boot-dep-reopt-race` 同族），用例体另有 ≈ 18.6s。故本条既有可重标的守则，也有可削的固定开销。

`gap-e2e-runner-boot-inflation-under-fan-in-concurrency`（done，提交 `24f7bd83`，HEAD 的祖先）已落地「vite 预打包按 provenance 选 donor + 原子提交 + `node_modules/.bin/{tsx,vite}`」这个 boot 杠杆；本条**消费**它，不重复（不再改 `seedViteCache` 的 donor 选择）。

`gap-ac188-case-budget-red-is-postturn-renavigation-tail`（`ready`）在 prose 里**提到** `playwright.config.ts` 但未在 `## Touches` 声明它（`task-granularity-advice.js` 的 `mentions` 而非 `peers`）——它治的是 `e2e/activity-dock-truthful.spec.ts` 的用例体尾部导航，机制不同、文件不同，**kept separate**。

### 要交付的事

1. **重标任务自加的 45000 守则**：在测得的用例体/整轮地板上给出有头部余量的新上限，且**仍 < `SINGLE_SPEC_CEILING_MS`（55000）与 60 秒判据门**。须同时保留 `expect(watchdogLine).toBe(false)` 与 `expect(watchdog.armed).toBe(true)` 两条（它们是「本次运行没有被看门狗杀掉」的正/负读数）。
2. **削减负载敏感的首载固定开销**：目标是那段 ≈10.7s 的首次 goto + 表单渲染（冷 Vite 优化器提交/整文档替换）。允许的杠杆 = `warmClientStartup` 的时点/对象（当前预热的是通用 client URL，首载仍可能撞上优化器提交）、有界 probe 的形态、以及把「预热成功」作为首载不重优化的前提。**不得**删掉 onboarding 走查、不得把「选择 provider」从设置页搬走、不得改任何一条腿的读数。
3. **用例体固定等待按可复现读数取舍**：只削「判据能稳定复现」的固定等待（如腿间导航的重复固定等待）。⛔ 那条 4 秒以上的持续读数是 AC 正文强制（「文案在 4 秒之后仍然可见」），**不许削**。
4. **负载臂实测**：用能复现膨胀的并发构造（≥20 路兄弟 `npx playwright test`，参照 `gap-ac194-criterion-wallclock-load-scaled-fixed-cost` 与 `gap-e2e-runner-boot-inflation-under-fan-in-concurrency` 的构造）重跑 ≥2 次，记录 `load1` 与每次 `criterion-wall-ms`；若在复现红的负载下整轮仍撞 55s 看门狗（`watchdog-line=true`），**停手置 `needs-human`**，附逐字读数与已排除项——不得把安静通过写成「已修」（AC-194 的先例）。

**非目标**：不改 AC-153 的产品面（四条腿的文案、持续显示、草稿保留、折叠技术详情、无拼接句）；不改 `goals/AC-153-…md` 的 `criterion:` / `expect:`；不碰 AC-149/150/151/152 的交付面；不改 `src/**` 的语音实现；不动 `SINGLE_SPEC_CEILING_MS` / 60 秒门；不重复 `gap-e2e-runner-boot-inflation-under-fan-in-concurrency` 的 vite donor 杠杆。

## Plan

1. 建本条隔离 worktree（起点 = 开工时 `develop`），打印路径、`git rev-parse HEAD`、`git rev-parse HEAD^{tree}`，确认 `git status --porcelain` 空。
2. 机械复录红态证据：cat 两份 `error-context.md` 的 `# Error details` 段与两个 `watchdog-state.json`，逐字入档；写明断言落点 `e2e/voice-error-messages.spec.ts:699`，并写明 AC-153 的 `expect:` 未点任何墙钟。
3. 安静臂基线：出货命令逐字跑 ≥3 次，记录 exit、自印 `criterion-wall-ms`、分段 stage 时间戳；用带时间戳的跑法量出四段固定开销（config+seeding+webServer / 浏览器启动+预热 / 首次 goto+表单 / 用例体）作为改动前对照。
4. 实施改动：按上面两道杠杆改 `e2e/voice-error-messages.spec.ts`（必要时 `playwright.config.ts` 的预热段）。⛔ 一处一次、锚定编辑；保持每条腿的读数与三条取假形态不动。
5. 安静臂复测 ≥3 次，全部 exit 0 且新守则通过；再跑同族 `npx playwright test e2e/voice-dashscope-written.spec.ts` 确认 AC-142 同族不回归。
6. 负载臂：≥20 路并发构造重跑 ≥2 次，记录 `load1` / `criterion-wall-ms` / `watchdog-line`；负载臂与安静臂要有可见差距（否则负载没造出来）。
7. 若负载臂仍撞看门狗或仍越过新守则：停手、置 `needs-human`，附逐字读数与已排除项；⛔ 不放宽守则到 60 秒门之外、不删读数。
8. 写完成记录，置终态（AC-153 是机械判据；若第 7 步触发则 `needs-human`）。

## AC

- [x] AC1 红态真因机械入档：两份 error-context 的 `# Error details` 逐字为 `the criterion exceeded its 45000ms budget` + `Expected: < 45000` + `Received: 56103 / 53956`；两个 `watchdog-state.json` 逐字入档（HMsj94 `fired:true` ceiling 55000；YA7zgA `fired:false`）；断言落点记为 `e2e/voice-error-messages.spec.ts:699`；并写明 AC-153 的 `expect:` 未点任何墙钟。
  - 判定：**达标**。本轮逐字重读两份 artifact 与两个 `watchdog-state.json`（见 `### 红态复录（AC1）`），读数与立案逐字一致；`goals/AC-153-…md` 的 `criterion:` / `expect:` 通篇无墙钟（`grep` 见同节）。断言落点在立案时是 `:699`；本条把该行改写成 `:718-719`（`CRITERION_BUDGET_MS`），平面行号因此前移——**落点已随改动入档**。
- [ ] AC2 安静臂基线：净 worktree 上出货命令逐字跑 ≥3 次，全部 exit 0；入档每次 `criterion-wall-ms`、分段 stage 时间戳、worktree 路径 / HEAD / `HEAD^{tree}`。
  - 判定：**未达标（`全部 exit 0` 这一合取为假）**。净 worktree（HEAD `c64e9e7f` / tree `0f4de9ff1b6e52e694da8abdac77eb6f3f62552d`）上出货命令逐字跑 3 次：`criterion-wall-ms` = **30161 / 37182 / 46282**，其中 **第 3 次 `exit 1`**（`legs=4 passed=4`，红只落在守则 `Expected: < 45000 / Received: 46282`，`load1≈84`）。⇒ **判据在安静宿主上就是间歇性红**，不是「安静全绿、仅负载红」。这正是本条要修的读数（见 `### 安静臂（AC2）` 与 `### 与 Proposal 现状的差异`）。改动后的安静臂 3/3 `exit 0`（28364 / 32270 / 31100），但那已不是「净 worktree 基线」。
- [x] AC3 守则重标且未越过门：新上限严格大于实测安静地板、且 `< 55000`（`SINGLE_SPEC_CEILING_MS`）且 `< 60000`（判据门）；`grep` 证明旧 `45_000` 那处已按新值改写，且 `expect(watchdogLine).toBe(false)` 与 `expect(watchdog.armed).toBe(true)` 仍在。打印新旧上限、实测地板、余量。
  - 判定：**达标**。新上限 `CRITERION_BUDGET_MS = 50_000`（`e2e/voice-error-messages.spec.ts:328`），旧 `45_000` 三处使用点全部改写（`:613` / `:718-719` / `:740`），`grep -n '45_000\|45000'` 只剩 `:317`（一句说明被替换值的散文）。实测安静地板（改动后 3 次最大）= **32270**；余量 = 50000 − 32270 = **17730ms**；`50000 < 55000` 且 `50000 < 60000`。两条看门狗读数逐字仍在 `:720` / `:721`。
- [ ] AC4 首载固定开销削减：打印改动前后「首次 goto + 表单渲染」段的毫秒读数与削减额；证明 onboarding 走查、设置页选 provider、四条腿读数**一条未减**（逐腿 `equals` / `is-chinese` / `notice-shown` / `draft-kept` 仍全真）。
  - 判定：**未达标（无交付物）**。**没有削减被出货**。原因：该段的可复现性不足——3 次净 worktree 基线里只有 1 次落在冷路径（分段 2075 / 4055 / **15125**ms），改动后 3 次全部落在暖路径（2599 / 3339 / 3304ms），**「改动前后」的一对读数根本无法在同一路径上配对**，任何「削减额」都会是单样本宣称。三条杠杆实测后排除（见 `### 已排除项`）。四条腿读数一条未弱化（改动后每次 `legs=4 passed=4`；折叠/草稿等逐腿断言未动）。
- [x] AC5 负载臂实测：≥20 路并发下出货命令重跑 ≥2 次，入档 `load1`、每次 `criterion-wall-ms`、`watchdog-line`；负载臂与安静臂有可见差距。若在复现红的负载下仍撞 55s 看门狗：置 `needs-human` 并逐字入档，⛔ 不把安静通过写成「已修」。
  - 判定：**达标（按本条自己的逃逸分句）**。两副 ≥20 路负载臂：**LB1**（24 路，peak `load1=109.51`）r1 `exit 0` wall 43876ms `criterion-wall-ms=42908 watchdog-line=false`；r2 `exit 1` wall 55869ms，**看门狗逐字**：`[e2e] watchdog: this run crossed its own 55000ms ceiling at 55006ms and is ending here with exit 1 at 55010ms — stuck at stage "browser-launch-or-cases": …`。**LB2**（36 路，peak `load1=473.42`）r1 `exit 1` wall 55146ms `criterion-wall-ms=53978 watchdog-line=false legs=4 passed=4`，红在新守则（`Expected: < 50000 / Received: 53978`）；r2 `exit 1` wall 55765ms，看门狗 SIGKILL（无 afterAll 行）。**看门狗在出货文件上被跨过 ⇒ 本条自己的逃逸触发，置 `needs-human`**。负载臂与安静臂差距可见（安静 ≤32270ms，负载 ≥42908ms）。**未把安静通过写成「已修」。**
- [x] AC6 读数与判据未弱化：`goals/AC-153-…md` 与判据命令逐字未改（`git diff <base>..HEAD -- goals/` 为空）；三条取假形态仍各自红（重跑组件层 `npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` exit 0）；`npx playwright test e2e/voice-dashscope-written.spec.ts` exit 0。
  - 判定：**达标**。`git diff c64e9e7f -- goals/` = **0 字节**；组件层 `npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` → **exit 0**（3 passed，三条取假形态仍在文件内且各自红，未改其判法）；同族 `npx playwright test e2e/voice-dashscope-written.spec.ts` → **exit 0**（`3 passed (23.7s)`，`criterion-wall-ms=23925`）；`npx tsc --noEmit -p tsconfig.json` → **exit 0**。
- [x] AC7 如实登记：完成记录写明两条红是**预算红**（失败跑四条腿读数正确）而非判据为假，写清新旧上限、削减额、负载臂读数，以及未做的项（未改产品面、未改 `criterion:` / `expect:`、未动 `SINGLE_SPEC_CEILING_MS` / 60 秒门、未重复 vite donor 杠杆）。
  - 判定：**达标**。见 `## Evidence` 全节；其中「削减额」一项如实记为**未出货**（AC4），不含任何未做的宣称。

## DoD

真实落地判据：不是把上限改大，而是**在复现红的负载条件下**（≥20 路并发兄弟 e2e 车道、`load1` 远高于核数），出货命令 `npx playwright test e2e/voice-error-messages.spec.ts` 逐字不变、退出 0、自印 `watchdog-line=false` 且其墙钟通过重标后的守则——由执行读数证明，不由段落文字声明。承重性由三件读数证明：

(a) **红是预算红，不是判据为假**：两份 error-context 的 `# Error details` 里只有预算断言（四条腿无红），且安静直跑 `legs=4 passed=4`。

(b) **守则重标不是「放宽 AC」**：`goals/AC-153-…md` 的 `criterion:` / `expect:` 逐字未改（`git diff` 为空），新上限仍 < `SINGLE_SPEC_CEILING_MS` 与 60 秒门，看门狗两条读数（`fired=false` / `armed=true`）仍在。

(c) **削减是真削减**：首次 goto + 表单渲染段的毫秒读数在改动后可见下降，且四条腿的全部读数与三条取假形态一条未弱化。

**已知不等价点**：本机 28+ 路并发下的整轮膨胀以 runner boot 为主（`gap-e2e-runner-boot-inflation-under-fan-in-concurrency` 与 `gap-ac194-criterion-wallclock-load-scaled-fixed-cost` 的读数），spec 侧只能削首载与用例体的固定开销；若在复现红的负载下仍撞看门狗，本条置 `needs-human` 而**不得**放宽守则到 60 秒门之外、不得删除任何读数。

## Touches

- e2e/voice-error-messages.spec.ts
- playwright.config.ts
- src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx
- tasks/gap-ac153-criterion-wallclock-load-headroom.md

## Evidence

worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac153-criterion-wallclock-load-headroom`（branch `task/gap-ac153-criterion-wallclock-load-headroom`）。
基线 HEAD `c64e9e7f`（tree `0f4de9ff1b6e52e694da8abdac77eb6f3f62552d`）；出货提交 `7d38f8e9`（tree `0b9f69c9518c08274e3b148d5393c12d30b2d732`）。
全线读数一律用 `QUAY_MEMORY_MAX=8G … bash scripts/with-memory-cap.sh npx playwright test <spec>` 取得（cgroup 上限 8G，见 `docs/operations/process-isolation-and-memory-caps.md`）。

### 改动（work product，保留在分支；其收益未被证实）

`e2e/voice-error-messages.spec.ts`（提交 `7d38f8e9`）：

- 新增具名常量 `CRITERION_BUDGET_MS = 50_000`（`:328`），带长文注释：明写这是**任务自加守则、不是任何 AC 的**；被替换的 `45_000` 落在本宿主安静包络之下。
- 三处使用点全部改为该常量：`:613`（`test.beforeAll` 的 `test.setTimeout`）、`:718-719`（`expect(criterionWallMs, \`the criterion exceeded its ${CRITERION_BUDGET_MS}ms budget\`).toBeLessThan(CRITERION_BUDGET_MS)`）、`:740`（用例体的 `test.setTimeout`）。
- 两处注释里的 45s 表述随之改写（`:260` / `:609`）。
- **两条看门狗读数逐字未动**：`:720` `expect(watchdogLine, 'this run\'s own watchdog fired: …').toBe(false)`、`:721` `expect(watchdog.armed, 'the watchdog was never armed, so "no watchdog line" is not a reading').toBe(true)`。
- `grep -n '45_000\|45000'` 现只命中 `:317`（一句散文，说明被替换的值）；`45000` 字面量已不在任何可执行位置。

`src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx`（提交 `7d38f8e9`，**必须进 `## Touches`**）：

- `:455` 打印的登记串 `its 45s criterion budget` → `its 50s criterion budget`（同一行的 `~24s` 不动）。这是随守则数字走的文字，不碰任何断言。

### 红态复录（AC1）

本轮逐字重读（与立案一致）：

```
quay-e2e-HMsj94: Error: Channel closed
                 Error: the criterion exceeded its 45000ms budget
                 Expected: < 45000
                 Received:   56103
   watchdog-state.json: {"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55000ms"}
quay-e2e-YA7zgA: Error: the criterion exceeded its 45000ms budget
                 Expected: < 45000
                 Received:   53956
   watchdog-state.json: {"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}
```

`goals/AC-153-…md` 里 `criterion:` 逐字为 `npx playwright test e2e/voice-error-messages.spec.ts`；`expect:` 通篇不点任何墙钟（腿文案 / 4 秒持续 / 关闭 / 下次录音清除 / 草稿逐字 / 折叠两读数 / 无拼接句 / 空 200 与 422 同句 / 三条取假形态）。断言点立案时 `:699`，本改动后为 `:718-719`。

### 安静臂（AC2）

**基线（净 worktree，HEAD `c64e9e7f` / tree `0f4de9ff`）**：出货命令逐字跑 3 次——

| 跑 | exit | criterion-wall-ms | onboarding-navigate | account-form | 首载段 | 备注 |
|---|---|---|---|---|---|---|
| r1 | 0 | 30161 | +8344 | +10419 | 2075ms | `legs=4 passed=4`（无 load1 样本） |
| r2 | 0 | 37182 | +10021 | +14076 | 4055ms | 同上 |
| r3 | **1** | **46282** | +6706 | +21831 | **15125ms** | `legs=4 passed=4`；红只在守则：`Error: the criterion exceeded its 45000ms budget` / `Expected: < 45000` / `Received: 46282`；`load1≈84` |

⇒ r3 走的是冷 Vite 优化器 / 整文档替换那条路径（首载 15.1s），红的是**预算**而非判据（四条腿全过）。**基线的 `全部 exit 0` 合取为假 —— AC2 如实留空。**

**改动后（HEAD `7d38f8e9` / tree `0b9f69c9`）**：3/3 `exit 0`，`criterion-wall-ms` = **28364 / 32270 / 31100**，首载段 = 2599 / 3339 / 3304ms，每次 `legs=4 passed=4 watchdog-line=false`。

### 守则重标（AC3）

| | 值 |
|---|---|
| 旧上限 | `45_000` |
| 新上限 `CRITERION_BUDGET_MS` | `50_000`（`:328`） |
| 实测安静地板（改动后 3 次最大） | `32270` |
| 余量（新上限 − 地板） | `17730ms` |
| `SINGLE_SPEC_CEILING_MS`（`playwright.config.ts`） | `55_000` → 50000 < 55000 ✓ |
| 判据门 | `60_000` → 50000 < 60000 ✓ |
| 看门狗读数 | `:720` `watchdogLine===false` ✓、`:721` `watchdog.armed===true` ✓ |

`grep -n '45_000\|45000' e2e/voice-error-messages.spec.ts` → 仅 `:317`（散文）。

**为什么恰好 50_000、而不是更高**：`SINGLE_SPEC_CEILING_MS=55000` 的看门狗会把越线跑 SIGKILL 成 `Channel closed`（不落任何 stage / 台账），而 < 55000 的守则能让越线**被报告**（带 `criterion-wall-ms` + 腿台账 + stage 时间戳）。50_000 在安静包络（最大 46282）之上、又在 55000 之下留 5s 报告头部 —— 这是任务自加守则在本宿主扇入下唯一能买到的东西。LB2 r1（`criterion-wall-ms=53978`，被**报告**）与 LB2 r2（被看门狗 **SIGKILL**）的对照就是这 5s 的作用。**追求一个能清掉 LB2 r1（53978）的值被否定为「按样本调参」**：没有 < 55000 的值能清掉负载包络的尾部。

### 首载段（AC4，未达标）

安静三条基线里只有 r3 落在冷路径（15125ms），r1/r2 与改动后三次全在暖路径（2075–4055ms）—— **同路径的「改动前 / 改动后」配对读数不存在**，故无「削减额」可报。该段唯一的非 `load` 约束组件是那个有界 probe 的冷路径（暖 2.1–4.1s vs 冷 15.1s，≈7×）。三条杠杆实测后排除（见 `### 已排除项`）。**未出货任何首载改动。**

### 负载臂（AC5，未达标 → `needs-human`）

| 臂 | 并发 | peak load1 | 跑 | exit | wall | criterion-wall-ms | watchdog-line |
|---|---|---|---|---|---|---|---|
| LB1 | 24 | 109.51 | r1 | 0 | 43876ms | 42908 | false |
| LB1 | 24 | 109.51 | r2 | 1 | 55869ms | （看门狗截断） | **true**（逐字见下） |
| LB2 | 36 | 473.42 | r1 | 1 | 55146ms | 53978 | false（红在新守则） |
| LB2 | 36 | 473.42 | r2 | 1 | 55765ms | （看门狗截断） | **true** |

LB1 r2 看门狗逐字：

```
[e2e] watchdog: this run crossed its own 55000ms ceiling at 55006ms and is ending here with exit 1 at 55010ms — stuck at stage "browser-launch-or-cases": both webServers answered, so this run is past boot and inside browser launch or a test case.
```

LB2 r2 看门狗逐字：

```
[e2e] watchdog: this run crossed its own 55000ms ceiling at 55000ms and is ending here with exit 1 at 55004ms — stuck at stage "browser-launch-or-cases": both webServers answered, so this run is past boot and inside browser launch or a test case.
```

LB2 r1 红逐字（新守则本身）：

```
Error: the criterion exceeded its 50000ms budget
Expected: < 50000
Received:   53978
  720 |   expect(watchdogLine, 'this run\'s own watchdog fired: …').toBe(false);
```

阶段时间戳显示膨胀不在单一处：LB2 r2 到 `stage=composer-open at=+44506ms` 才进用例体；LB1 r1 的 `stage=onboarding-navigate at=+14446ms`（安静时 ≈+6.2–8.3s）。

**改动前的负载读数**（同一构造，同一命令）：20 路 → `criterion-wall-ms=35692 exit 0`；36 路 → `52439 exit 1`（只红守则）；36 路 4 轮（AB2，peak load1 441.79）→ r1 55001（看门狗）、r2 11253（`legs=0`，30s 客户端预热预算被负载吃尽、`fetch failed`）、r3 46025 exit 1、r4 55882（看门狗）。⇒ 重标把 r1/r3 那类「安静余量略被吃穿」的跑从 **SIGKILL 变成被报告**，但**没有**把那类跑变成绿：复现红的负载下整轮仍撞 55s 看门狗。**按本条自己的逃逸：置 `needs-human`，不把安静通过写成「已修」。**

### 与 Proposal 现状的差异（复核后修正）

- Proposal 称「本轮直接现测：安静宿主上判据是绿的」（`exit 0`、37378ms、`load1≈161`）。**修正**：判据在安静宿主上是**间歇性红**——净 worktree 3 次里第 3 次 `exit 1`（`criterion-wall-ms=46282`，`load1≈84`，红只在守则）。那个 37378 读数是真的一次采样，但不是「安静即绿」的证据。故本条的机制准确表述是：**红 = （冷 Vite 优化器首载路径 ∨ 负载）撞任务自加守则**，而不仅是「负载」。
- Proposal 的分段表把首载段记为 ≈10.7s（单次安静采样）。**修正**：首载段在三次净基线里是 2075 / 4055 / 15125ms（暖 / 暖 / 冷），单值 10.7s 不可复现。
- Proposal 的机制去重、非目标、与 AC-194/199 的差别三条经复核仍成立。

### 未弱化（AC6）

- `git diff c64e9e7f -- goals/` = **0 字节**（判据命令与 `expect:` 逐字未改）。
- `npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` → **exit 0**（3 passed；三条取假形态仍在文件内）。
- `npx playwright test e2e/voice-dashscope-written.spec.ts` → **exit 0**（`3 passed (23.7s)`，`criterion-wall-ms=23925`）。
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**（两次）。

### 已排除项（不当作解）

1. **模块图预取（`AC153_WARM_GRAPH`）**：安静实测 E1 `criterion-wall-ms=29613`（`goto-load-done took=2669ms at=+9766ms`，`form-first-visible ok=true at=+10221ms waited=3126ms` ⇒ 表单在 `load` 之后 455ms 才出现，没有可挤的余量）；E2 上限 400 → 27675；E3 上限 1500 → 33950。**这不是配对的 A/B**，且在负载下该预取会吃掉共享的 30s `CLIENT_WARM_DEADLINE_MS` 并新增一种失败形态：AB2 r2 逐字 `the client did not answer … inside the 30000ms startup budget (fetch failed)`，`legs=0 passed=0 criterion-wall-ms=11253`。⇒ 排除。
2. **缩短首个有界 probe**：可能在热路径上多触发一次 reload（负载下该 reload 段实测到 6678ms）。⇒ 排除。
3. **改 `warmClientStartup` 的时点/对象**：无可复现的配对读数支撑，且见下面的机制登记。⇒ 排除。

### 交办（交办给人工/后续）

**机制登记（未修，亦不属本条）**：`warmClientStartup` 的返回条件是「**某一个** dep URL 答 200」，这**不证明**优化器已停止提交——冷路径（本宿主安静 3 次里 1 次）正是首载撞上优化器提交/整文档替换，段长 15.1s。这条路径与 `gap-voice-dashscope-criterion-boot-dep-reopt-race` 同族，值得单独立条（判据侧的「预热成功」应改为「优化器静默」而非「一个 URL 200」）。本条**未**动 `warmClientStartup`。

**待人工裁决**：本条的 DoD 承重条件（(a)(b) 成立；(c) 不成立——无削减出货）与 DoD 的负载臂条款（在复现红的负载下整轮仍撞看门狗 ⇒ `needs-human`）都在出货文件上被读数触发。请人工裁决：是否接受「重标注 + 如实登记冷路径」为本次交付，并把 (c) 的「真削减」与「优化器静默」判据另立一条。**不得**由本 worker 自行放宽守则到 60 秒门之外、不得删除任何读数。

### 复现命令

```bash
WT=/data/home/yale/work/claudecodeui-worktrees/gap-ac153-criterion-wallclock-load-headroom
cd "$WT"

# 安静臂（出货命令逐字）
QUAY_MEMORY_MAX=8G QUAY_MEMORY_UNIT=ac153-quiet \
  bash scripts/with-memory-cap.sh npx playwright test e2e/voice-error-messages.spec.ts

# 负载臂（≥20 路兄弟 playwright 车道，再跑判据）
bash /tmp/ac153-load2.sh LB1 24 2 30     # 24 路，peak load1 109.51
bash /tmp/ac153-load2.sh LB2 36 2 45     # 36 路，peak load1 473.42

# 未弱化佐证
npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx
npx playwright test e2e/voice-dashscope-written.spec.ts
git diff c64e9e7f -- goals/          # 应为空
```

`task_check` 读数（终态，AC2/AC4 如实留空）：`ok:false`，`acChecked=5 / acTotal=7` —— 这是本条预期的读数，不是待修项。
