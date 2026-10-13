---
id: gap-loop-rerun-command-undeclared-so-every-flake-parks-needs-human
title: fan-in 的失败文件重跑通道未声明（loop.rerun_command 缺失）⇒ driver 无法把并发抽签判为既存红，每次抽签都停派
  needs-human 并归因到 headline 里那句无关日志
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

### 现象（2026-10-13 实测）

`gap-voice-uplink-vad-real-prefix-a-and-exit-commit` 的 fan-in suite 在 534 个文件里红 **1** 条（`e2e/session-lifecycle-scenario.spec.ts`），driver 的判词是：

> `suite red was attributed to 1 failing file(s) … but could not be cleared as pre-existing red in 2 consecutive rounds (bounded to at most one retry) — baseline comparison not evaluated: no baseline rerun command: no-rerun-command-declared — stopping instead of spending another worker session`

即：driver **有**「重跑失败文件、绿了就当既存红」的机制，但本项目**没有声明那条命令**，于是它只能停派。

### 归因复核（本轮实测，不是照抄 headline）

- 该文件**不在**那条任务的 Touches 里（它只碰 `experiments/` 与一个 docs 文件）。
- 主检出单跑同一 spec：`npx playwright test e2e/session-lifecycle-scenario.spec.ts` → **3 passed / 10.8s**。⇒ 不是确定性红。
- 真实失败行：`page.evaluate: TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:8735/src/shared/scenarios/sessionLifecycle.timeline.ts` —— 浏览器臂在**并发负载下动态 import 抽签**。
- 而 headline 打印的 `[WebServer] … No .env file found or error reading it: ENOENT` 只是 webServer 的**第一行日志**，被折进了 `not ok -` 那行 ⇒ 归因被这句话带偏（本条要消掉的正是这种「抽签无法归因」）。

### 缺口与做法

driver 的重跑通道契约（读 `worker-driver.js` 的 `resolveRerunCommand` / `applyFileTemplate`）：

- 命令来自 `.quay/config.yml` 的 `loop.rerun_command`，**argv 数组**（非空字符串），两个模板：`{worktree}` 与 `{files}`；`{files}` **逐个**拼进 argv；超时 `RERUN_TIMEOUT_MS = 300000`。
- 未声明 ⇒ `not-evaluated: no-rerun-command-declared`；声明了但类型不对 ⇒ `declaration-unreadable`（不静默）。绿 ⇒ `rerun-green`（判既存红，继续走）；红 ⇒ `rerun-red`（判真红）。

本项目现在没有这个键（全店任务里也没有人提过）。**难点**：`scripts/test.sh` 的 e2e 车道**只在全量收集路径上启动**（`E2E_LANE` 要求 `FILES` 为空），所以把 `e2e/*.spec.ts` 当位置参数喂给 test.sh **不会**走 e2e 车道，会落到 server 车道用错 runner，把抽签误判成「真红」（保守但归因错误）。故声明不能是朴素的 `bash scripts/test.sh {files}`。

**做法**：新增一个只做分派的包装脚本（argv = 失败文件列表）：`e2e/*.spec.ts` → 该 spec 的 playwright 命令；其余 → `bash scripts/test.sh --root <worktree> <file>`；退出码沿用（全绿 = 0，任一红 = 非 0）。然后把 `loop.rerun_command` 声明为指向该脚本的 argv。⛔ 包装脚本只分派，不做任何「重试到绿」；⛔ 不改 `scripts/test.sh` 的语义。

## Plan

1. 读 driver 的三条读数口径（`no-rerun-command-declared` / `declaration-unreadable` / `rerun-green|rerun-red`），确定可机械读出它们的方式并记录下来。
2. 写分派脚本：按文件前缀选 runner，透传 exit code，打印每个文件用了哪个 runner。
3. 在 `.quay/config.yml` 的 `loop` 段声明 `rerun_command`（argv 数组，用 `{worktree}` 与 `{files}`）。
4. 三组读数：e2e spec 单跑（得 3 passed）、server 文件单跑（得 pass）、混合列表两者都跑；再取假形态（删键 / 写错类型）与「确定性红不得被洗绿」的对照。
5. 不改 `scripts/test.sh`、不改生产默认值、不重启 :3001。

## AC

- [ ] AC1 `.quay/config.yml` 的 `loop.rerun_command` 是非空字符串 argv 数组，且用第 1 步确定的方式读出 `{kind:'run'}`（不再是 `no-rerun-command-declared`）；`## Evidence` 给出该读数与读取命令。
- [ ] AC2 取假形态：把 `loop.rerun_command` 删掉（以及写成**字符串**的第二种假形态）⇒ 同一读取分别变成 `not-evaluated: no-rerun-command-declared` 与 `declaration-unreadable`；两次读数都写进 `## Evidence`。
- [ ] AC3 分派正确：包装脚本对 `e2e/session-lifecycle-scenario.spec.ts` 用 playwright 跑（`## Evidence` 给读数，应为 3 passed），对 `server/**/*.test.ts` 用 `scripts/test.sh` 跑（给 pass 读数），混合列表两者都跑到；⛔ 不得把 `e2e/*.spec.ts` 交给 test.sh 的位置参数路径（给出反例读数：若那样喂，会以 wrong-runner 红）。
- [ ] AC4 ⛔ 不把真红洗绿：用一个**确定性**失败输入跑包装脚本 ⇒ 退出码非 0（给读数）；`## Evidence` 说明脚本内不存在任何重试/吞错分支（贴脚本全文或关键段）。
- [ ] AC5 超时与并发纪律：单次重跑墙钟 ≤ 300000ms（driver 的 `RERUN_TIMEOUT_MS`），且重跑不与其它 suite 并发（给出一次实际重跑的墙钟读数）。
- [ ] AC6 只改声明的文件：`git diff --name-only <fan-in 基线>..HEAD` 只含 Touches 所列文件与本任务文件。
- [ ] AC7 不改 `scripts/test.sh` 的语义、不改任何生产默认值（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、不重启 :3001（前后 pid 相同，写出读数）。

## DoD

真实落地 = 遇到并发抽签时 driver 能自己判出「`rerun-green` ⇒ 既存红」并把任务继续走完，而不是停派 `needs-human`。读数不是「配置里多了一个键」：给出一次**真实**重跑事件（`.quay/` 下的重跑日志 + trace/journal 里的 `rerun` 事件，`state=rerun-green`，以及一次 `rerun-red` 的对照），并说明 `rerun-green` 这一次之后任务确实没有停派。

## Touches

- .quay/config.yml
- scripts/quay-rerun-failed.sh (new)
- tasks/gap-loop-rerun-command-undeclared-so-every-flake-parks-needs-human.md

## Notes

**与 `gap-fan-in-suite-load-flake-one-per-run` 的分工**：那条治「为什么并发下每轮恰好红 1 条」（根因在并发调度/产品竞态，改 `scripts/test.sh` 等）；本条治「红之后能不能被正确归因」（只加一条声明与一个分派脚本，不改 test.sh 语义）。⛔ 不要在本条里顺手改 test.sh 的并发行为。

**为什么不直接写 `bash scripts/test.sh {files}`**：见 Proposal 的 e2e 车道段 —— 那条捷径会把 e2e 抽签误判成真红，属于「错误归因换错误归因」。包装脚本的存在理由就是这一个分派。

**风险与边界**：`rerun_command` 一旦声明，driver 会在每次 suite 红时自动跑它，并把 `rerun-green` 当作既存红继续走。因此 AC4（真红不得洗绿）是这条声明的安全边界：脚本必须透传非 0。
