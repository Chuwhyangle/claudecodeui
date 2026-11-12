---
id: gap-ac323-webserver-timeout-not-scaled-with-run-budget
title: AC-323 判据命令 1 连续两次死在 webServer 固定 35s 墙：WEB_SERVER_TIMEOUT_MS 不随已声明 run
  budget 放大（boot ceiling 已放大到 120s）⇒ 改为同预算派生、默认仍 35s；AC 记录 timeoutMs 抬到 run
  ceiling 535s 之上
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-323
---
## Proposal

**来源**：本轮 gap-filing 的直接测量（不是台账尾巴）。AC-323（`status: achieved`；其 GOAL-035 已 achieved、不再活跃、未声明 `long-term: true`）在 `HEAD^{tree} = 9595c8d5f839ff94821c8bb21f23859d5c45d5e5` 上被两次 gate 评估判红，两次都死在判据第一条命令的**引导段**、任何 spec 用例之前：

- `2026-11-12T10:13:54.356Z`（`goal-sweep`）与 `2026-11-12T10:17:52.010Z`（`goal-cli`），`payload.treeSha` 均为 `9595c8d5f839ff94821c8bb21f23859d5c45d5e5`，reason 都以逐字行结尾：
  `Error: Timed out waiting 35000ms from config.webServer.`
- 两次运行自己的数据目录（`~/.cache/quay-e2e-tmp/quay-e2e-VV780H`、`~/.cache/quay-e2e-tmp/quay-e2e-wBZlJl`）读数：
  - `watchdog-state.json` 逐字分别为 `"detail": "boot 120000ms from config-eval end (config-eval-ms=23358), re-armed to 535000ms once past boot"` 与 `config-eval-ms=149627`，两次 `"fired": false`；
  - `server.stderr.log` 只有一行 `No .env file found or error reading it: ENOENT: … ·.env`，没有崩溃栈、没有编译错误；
  - `test-results/` 只有 `.last-run.json` ⇒ 没有一条 spec 断言执行过。

判据（逐字，不改）：

```
npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts && npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime && npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "
```

**为什么不是产品回归**：同一判据的上一棵绿树 `7c8fa9888aaf2cb7b9049a64b0ed87255ac622ae` 在 2026-11-09T19:57:59Z–21:25:52Z 连续 14 次 pass；两树之间 `git diff --stat 7c8fa988 9595c8d5` 只有 shared/asr 包拆分与 voice importer（无 e2e config、无 server bootstrap 变更），且失败 run 的 server stderr 无崩溃行。

**机制**：`WEB_SERVER_TIMEOUT_MS = 35_000`（`playwright.config.ts:1119`）是两条 `webServer` entry 共用的**固定** internal deadline，Playwright 在 spawn 之后按它等待 URL 应答。2026-10-29 的 done 任务 `gap-ac323-boot-ceiling-counts-config-evaluation` 把 watchdog 的 boot window 改到 config 求值末尾起算，之后 `bootCeilingFor(RUN_CEILING_MS)` 会随已声明 budget 从 40s 放大到 120s；但 Playwright 自己那条 35s 没有跟着放大，于是链上**最早**的墙仍是 35s。AC-323 命令 1 的选择集 `RUN_CEILING_MS = 535_000`（240s + 240s + 55s），`BOOT_CEILING_MS = 120_000`，webServer wait 仍是 `35_000`。done 任务 `gap-ac174-criterion-run-budget-and-boot-ceiling-below-load-slowdown` 的 Evidence 已逐字记录过同一行（2026-11-06 load1 212.57），并按当时的「明确不动」保留常量、归因为宿主负载；它不是判据语义问题，但每一轮都会把「量具在 boot 处先开火」记成判据红。本轮 `config-eval-ms=149627` 说明宿主/并发负载足以让 config 求值付出约 2.5 分钟，boot 之后仍然 >35s。

**修法方向**（执行者可据实测调整，但须满足 AC）：

1. `scripts/e2e-run-ceilings.mjs` 新增 `webServerTimeoutFor(runCeilingMs)`，定义为 `bootCeilingFor(runCeilingMs) - BOOT_CEILING_RUN_MARGIN_MS`：默认 55s 选择仍逐字 `35_000`；240s / 535s / 1_200_000 选择为 `115_000`；始终严格低于 boot ceiling 并保持既有 5s 间隔，使「boot 仍不应答」的失败仍由 Playwright 自己的行命名。
2. `playwright.config.ts` 两条 entry 的 `timeout: WEB_SERVER_TIMEOUT_MS` 改用 `webServerTimeoutFor(RUN_CEILING_MS)` 派生的常量（`const WEB_SERVER_TIMEOUT_MS = webServerTimeoutFor(RUN_CEILING_MS)`），并更新 `:1095-1119` 的注释算术链（默认 35s 不变，放大选择 115s）。
3. 控制臂（确定性，不靠宿主负载）：临时给 server 的 `webServer` command 前加 `sleep 40 &&`，在 `e2e/mobile-workspace-composer-layout.spec.ts -g "@320 idle"`（240s budget ⇒ 新值 115s）上两拍对照——旧 35s 常量 ⇒ exit 1、逐字 `Error: Timed out waiting 35000ms from config.webServer.`；新派生值 ⇒ exit 0、`[e2e] boot: both webServers answered at …` 且读数 >40000ms。两拍都还原，`git status --porcelain` 为空。
4. 同一算术链上的第二个倒挂：命令 1 的 `RUN_CEILING_MS = 535_000` > AC 记录的 `timeoutMs: 480000`，即闸的 SIGKILL 会早于 run watchdog 写出 crossing 行（两份注释都明说不允许）。把 AC-323 记录的 `timeoutMs` 抬到 600_000（> 535_000 + driver 15s grace；`goal_write` 不暴露该字段，按 AC-109/AC-323 先例手改 `goals/AC-323-…md` 的这一行）。

<!-- dedup-ref --> 去重与粒度：`grep -l '^goal_ac: *AC-323' tasks/*.md` 命中 19 份，全部 `status: done`（含 `gap-ac323-boot-ceiling-counts-config-evaluation`、`gap-ac323-warmup-fetch-retry-and-voice-port-collision-stabilize` 等）；在飞扫描（todo/ready/needs-human 且 `goal_ac: AC-323`）0 命中；对 `WEB_SERVER_TIMEOUT_MS` / `config.webServer` 的非 done 任务 grep 也 0 命中。`task-granularity-advice --root <主检出> --touches playwright.config.ts --touches scripts/e2e-run-ceilings.mjs …` 报 `peers: []`、`mentions: []` ⇒ 无合并候选，separate。19 份 done 正是「上一轮修复没挺住」的证据：它们分别修了 boot ceiling 的计时原点、暖机连接级重试、假上游端口分配、启动守卫等，没有一条让 Playwright 自己的 webServer wait 随已声明 budget 放大。

## AC

- [ ] AC1（修复前，红先按确定性控制臂复现）临时给 server 的 `webServer` command 前加 `sleep 40 &&`（仅这一处临时改动），在 shipped `WEB_SERVER_TIMEOUT_MS = 35_000` 未改的前提下跑 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g "@320 idle"` ⇒ exit 1，输出逐字含 `Error: Timed out waiting 35000ms from config.webServer.`；贴 `<dataDir>`、wall clock 与两次重复的原文。该临时注入必须还原。
- [ ] AC2（修复后，同一诱导失败转绿）保留同一个 `sleep 40 &&` 注入、换成修复后的派生值（该 selection 的 `WEB_SERVER_TIMEOUT_MS = 115_000`）⇒ 同一命令 exit 0，贴 `1 passed`、wall clock（应 ≳70s）与 `[e2e] boot: both webServers answered at <n>ms`（n>40000）。还原注入后 `git status --porcelain` 为空。
- [ ] AC3（缩放函数与配置接线，单元可读）`node --test scripts/e2e-run-ceilings.test.mjs` exit 0；测试钉住 `webServerTimeoutFor(SINGLE_SPEC_CEILING_MS) === 35_000`、`webServerTimeoutFor(240_000) === 115_000`、`webServerTimeoutFor(1_200_000) === 115_000`，且对 `55_000 / 240_000 / 535_000 / 1_200_000` 每个值都有 `webServerTimeoutFor(x) === bootCeilingFor(x) - BOOT_CEILING_RUN_MARGIN_MS` 与 `webServerTimeoutFor(x) < bootCeilingFor(x)`、`>= 35_000`。读回 `playwright.config.ts`：`const WEB_SERVER_TIMEOUT_MS = webServerTimeoutFor(RUN_CEILING_MS);` 命中 1 行，且两条 entry 都是 `timeout: WEB_SERVER_TIMEOUT_MS`；贴 grep 原文。
- [ ] AC4（判据整链，含并发负载）判据三条命令逐字不改，在一个最终树上连续 ≥3 次整链 exit 0。每轮登记 `git rev-parse HEAD^{tree}`、exit code、三条命令各自的 pass 计数与 wall clock；至少一轮与一条 sibling e2e（例如 `e2e/voice-realtime-turn-unanswered.spec.ts`）在时间窗口上重叠，贴 sibling 的 pass 计数。三轮回读的 `config-eval-ms` 与 boot 完成时刻一并入档。若净检出上仍稳定红（即判据在产品面为假），停手上报 `needs-human`，不得把环境红写成产品绿。
- [ ] AC5（闸 deadline 不早于 run ceiling）`goals/AC-323-composer-…md` 的 `timeoutMs` 从 `480000` 改为 `600000`（或 ≥550000 的等价实测值 > 命令 1 的 `RUN_CEILING_MS = 535_000` + 15s driver grace）；`git diff develop -- 'goals/*.md'` 的增删行只有 `-timeoutMs: 480000` / `+timeoutMs: 600000`，`criterion` / `expect` / 其它字段逐字节不变；`quay goal get AC-323 --json` 的 `timeoutMs` 等于声明值。贴两处原文。
- [ ] AC6（判定面未弱化 + 隔离）`git diff develop --name-only` 全部落在 `## Touches`；`git diff develop -- 'e2e/*.spec.ts' | grep -c '^-.*expect('` = 0；diff 内无新增 `retries` / `test.skip` / `page.route(` / `reuseExistingServer: true`；`npm run typecheck` exit 0。

## DoD

- 真实落地：在宿主有并发 e2e 的条件下（正是两次红的条件），判据三条命令连续 ≥3 次整链 exit 0；AC1/AC2 的两拍控制（旧 35s 红 / 新派生值绿）在同一宿主负载窗口内成对取得，`config-eval-ms`、boot 完成时刻、每轮 wall 逐字入档。
- 完成记录须逐字保留本轮两次红的 gate event id/timestamp、treeSha `9595c8d5f839ff94821c8bb21f23859d5c45d5e5`、两处 `watchdog-state.json` 与 `server.stderr.log`，并写明为什么早前的修复没挺住：它们分别修了 boot ceiling 的计时原点、暖机连接级重试、假上游端口分配等，没有一条让 Playwright 自己的 webServer wait 随已声明 budget 放大；`gap-ac174-criterion-run-budget-and-boot-ceiling-below-load-slowdown` 明确把该常量留在原位并把同签名红归因为宿主负载。
- 合并到 develop 之后，在 develop 树上真实跑 `quay goal gate AC-323`（非 dry-run）并贴 `verdict: "pass"` 的 GateEvent 原文，AC-323 台账尾随之翻 pass。（待外部）
- 未验证项如实写明（例如宿主 load 的真实上界、config 求值 149.6s 是否为观测到的最大值），不得把未观察到的红写成已观察。

## Touches

- playwright.config.ts（`WEB_SERVER_TIMEOUT_MS` 改成随 `RUN_CEILING_MS` 派生；两条 entry 接线；更新算术链注释）
- scripts/e2e-run-ceilings.mjs（新增 `webServerTimeoutFor`，保持默认 35s 与 5s 间隔不变式）
- scripts/e2e-run-ceilings.test.mjs（默认/240s/535s/1_200_000 的派生值与不变式）
- goals/AC-323-composer-内双语音入口-容器内-live-voice-紧凑栏-波形-时长-字幕-模型-mute-end-桌面与.md（只改 `timeoutMs` 一行）
- tasks/gap-ac323-webserver-timeout-not-scaled-with-run-budget.md（自触）