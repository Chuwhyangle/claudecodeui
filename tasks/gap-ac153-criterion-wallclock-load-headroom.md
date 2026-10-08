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

判据物（逐字取自 `goals/AC-153-真实浏览器里各类失败显示各自的文案-提示持续显示到关闭-草稿保留-技术详情折叠.md` 的 `criterion:`）：`npx playwright test e2e/voice-error-messages.spec.ts`。

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

- [ ] AC1 红态真因机械入档：两份 error-context 的 `# Error details` 逐字为 `the criterion exceeded its 45000ms budget` + `Expected: < 45000` + `Received: 56103 / 53956`；两个 `watchdog-state.json` 逐字入档（HMsj94 `fired:true` ceiling 55000；YA7zgA `fired:false`）；断言落点记为 `e2e/voice-error-messages.spec.ts:699`；并写明 AC-153 的 `expect:` 未点任何墙钟。
- [ ] AC2 安静臂基线：净 worktree 上出货命令逐字跑 ≥3 次，全部 exit 0；入档每次 `criterion-wall-ms`、分段 stage 时间戳、worktree 路径 / HEAD / `HEAD^{tree}`。
- [ ] AC3 守则重标且未越过门：新上限严格大于实测安静地板、且 `< 55000`（`SINGLE_SPEC_CEILING_MS`）且 `< 60000`（判据门）；`grep` 证明旧 `45_000` 那处已按新值改写，且 `expect(watchdogLine).toBe(false)` 与 `expect(watchdog.armed).toBe(true)` 仍在。打印新旧上限、实测地板、余量。
- [ ] AC4 首载固定开销削减：打印改动前后「首次 goto + 表单渲染」段的毫秒读数与削减额；证明 onboarding 走查、设置页选 provider、四条腿读数**一条未减**（逐腿 `equals` / `is-chinese` / `notice-shown` / `draft-kept` 仍全真）。
- [ ] AC5 负载臂实测：≥20 路并发下出货命令重跑 ≥2 次，入档 `load1`、每次 `criterion-wall-ms`、`watchdog-line`；负载臂与安静臂有可见差距。若在复现红的负载下仍撞 55s 看门狗：置 `needs-human` 并逐字入档，⛔ 不把安静通过写成「已修」。
- [ ] AC6 读数与判据未弱化：`goals/AC-153-…md` 与判据命令逐字未改（`git diff <base>..HEAD -- goals/` 为空）；三条取假形态仍各自红（重跑组件层 `npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` exit 0）；`npx playwright test e2e/voice-dashscope-written.spec.ts` exit 0。
- [ ] AC7 如实登记：完成记录写明两条红是**预算红**（失败跑四条腿读数正确）而非判据为假，写清新旧上限、削减额、负载臂读数，以及未做的项（未改产品面、未改 `criterion:` / `expect:`、未动 `SINGLE_SPEC_CEILING_MS` / 60 秒门、未重复 vite donor 杠杆）。

## DoD

真实落地判据：不是把上限改大，而是**在复现红的负载条件下**（≥20 路并发兄弟 e2e 车道、`load1` 远高于核数），出货命令 `npx playwright test e2e/voice-error-messages.spec.ts` 逐字不变、退出 0、自印 `watchdog-line=false` 且其墙钟通过重标后的守则——由执行读数证明，不由段落文字声明。承重性由三件读数证明：

(a) **红是预算红，不是判据为假**：两份 error-context 的 `# Error details` 里只有预算断言（四条腿无红），且安静直跑 `legs=4 passed=4`。

(b) **守则重标不是「放宽 AC」**：`goals/AC-153-…md` 的 `criterion:` / `expect:` 逐字未改（`git diff` 为空），新上限仍 < `SINGLE_SPEC_CEILING_MS` 与 60 秒门，看门狗两条读数（`fired=false` / `armed=true`）仍在。

(c) **削减是真削减**：首次 goto + 表单渲染段的毫秒读数在改动后可见下降，且四条腿的全部读数与三条取假形态一条未弱化。

**已知不等价点**：本机 28+ 路并发下的整轮膨胀以 runner boot 为主（`gap-e2e-runner-boot-inflation-under-fan-in-concurrency` 与 `gap-ac194-criterion-wallclock-load-scaled-fixed-cost` 的读数），spec 侧只能削首载与用例体的固定开销；若在复现红的负载下仍撞看门狗，本条置 `needs-human` 而**不得**放宽守则到 60 秒门之外、不得删除任何读数。

## Touches

- e2e/voice-error-messages.spec.ts
- playwright.config.ts
- tasks/gap-ac153-criterion-wallclock-load-headroom.md
