---
id: gap-live-voice-continuous-calibration-run
title: 连续模式真实校准 C-1..C-6 单次运行（semantic_vad
  行为、silence_duration、丢静音致盲、静音计费、模型等待、静音尾）+ 成本基线
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-362
---
## Proposal

### 背景

决策文档 `docs/proposals/live-voice-experience-first-decision-2026-10.md`（提交 `038730f0`）§6 列出 6 个只能靠真实上游回答的问题，§7 要求先拿成本基线、不预设目标、不假定静音必然计费。已有事实：F1（成本主因是每次 response 重读文本上下文）、F3/F4（音频 7 token/秒；静音不计费仅为**推断**）、P0-S4（`semantic_vad` 在控制面只是回显，无行为证据；官方文档却列为 qwen3.8 支持）。

### 校准项（全部在一次运行内完成）

| # | 问题 | 做法要点 |
|---|---|---|
| C-1 | qwen3.8 上 `semantic_vad` 是否有**行为**差异 | 同一段含「嗯…那个…」与句中停顿的音频，分别用 `server_vad` 与 `semantic_vad`，比较条目数与 response 数 |
| C-2 | `silence_duration_ms` 400 / 800 / 1000 的碎片数与说完→response 延迟 | 同一语料三档 |
| C-4 | 静音是否计费 | 60 s 纯静音 vs 60 s 含 5 s 语音，比较 usage 的 audio token 与账单 |
| C-5 | 允许「没说完可以不转发」的指令下，模型是否真的等待并在后续机会合并转发 | ≥10 样本，实验脚本自带指令（不改出货指令） |

成本基线（同一运行的读数）：response 数、有效投递率、每 response text/audio 输入 token、¥/小时（说话与挂机两种场景按读数外推，标明外推）。

> 2026-10-12 增补：C-3（丢静音致盲）与 C-6（静音尾最小值）已移入 `gap-live-voice-silence-tail-suppression-probe`（AC-363，Silence Tail Suppression 探针），本任务不再做，避免重复付费。

### 安全边界

- 备用端口第二实例（参照 `dod-real-live-voice-without-restart` 做法），`VOICE_REALTIME_MAX_CNY_PER_CONNECTION=0.05`，总花费上限 ¥1；执行面 dry-run（`server/index.ts` `dryRun` 分支），不向任何真实会话注入消息或中断；合成的 `sessionId` 不存在于任何库；`CLAUDE_SESSION_SCOPE_SWEEP=off`。
- 不重启 :3001（记录前后 pid），不发布，不触碰 Quay worker / driver。
- 只跑一次（不重复取数，见记忆：勿反复真实上游测量）。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


<!-- dedup-ref --> 机制去重：已 done 的 `gap-live-voice-interrupt-semantic-sampling`（AC-346）只测中断语义；`gap-voice-realtime-turn-detection-configurable-comparison`（done）比较的是切分臂而非 qwen3.8 上 semantic_vad 的行为与计费；open 任务 0 命中。

## Plan

1. 语料与音频（复用 `experiments/voice-realtime-interrupt-sampling/` 的 TTS 合成流程与 `experiments/voice-trim/fixtures/`）；按 C-3/C-4/C-6 预处理变体。
2. 实验脚本 `experiments/voice-realtime-continuous-calibration/run.mts`（备用端口、dry-run、花费上限、逐连接 journal）。
3. 单次运行；报告 `docs/operations/voice-realtime-continuous-calibration.md`，每项「读数：」与结论行；行首字段与 AC-362 判据一致。

## AC

- [x] AC1：`f=docs/operations/voice-realtime-continuous-calibration.md` 存在，且含行首 `C-1 semantic_vad：`、`C-2 silence_duration：`、`C-4 静音计费：`、`C-5 模型等待：`、`成本基线：`、`运行次数：`、`花费：`（AC-362 判据逐行检查）。
- [x] AC2：每项附原始证据：连接 id、usage 行（text/audio token 分列）、事件时间线摘录；不得只给结论。
- [x] AC3：报告写明运行次数 = 1、每连接上限与实际花费（CNY）、:3001 前后 pid 相同、dry-run 执行面。
- [x] AC4：`npm run lint` 退出 0（若新增脚本）。

## DoD

真实 `qwen3.8-omni-flash-realtime` 跑过一次，C-1、C-2、C-4、C-5 与成本基线读数完整；不设通过门槛；读数被决策文档 §9 的裁定引用。

## Touches

- docs/operations/voice-realtime-continuous-calibration.md (new)
- experiments/voice-realtime-continuous-calibration/run.mts (new)
- experiments/voice-realtime-continuous-calibration/corpus.json (new)
- tasks/gap-live-voice-continuous-calibration-run.md

## Notes

立项：Opus 常驻会话，2026-10-12，人 yale 体验优先裁定（GOAL-044 / AC-362）。

### 运行结果（2026-10-12，一次真实运行）

18 条上游连接，总花费 ¥0.1636（每连接上限 ¥0.05），:3001 pid 1933227 前后相同。

- **C-1**：`server_vad` 6 段/7 response；`semantic_vad` 2 段/4 response，首字 0.8s → 11.7s，开头填充词碎片丢失。
- **C-2**：silence-400 = 6 条（更碎）；800/1000 = 4 条；说完→response 中位数 ≈330ms。
- **C-4**：静音**不计费**。60s 纯静音 response=0、花费 ¥0；语音在末尾臂 audio token = 70（≈语音本身），远低于 60s 静音该有的 ≈420。
- **C-5**：指令**没有**让模型等待（0/10）；半句被当场转发，8 组拆成两条消息、2 组补完从未投递。

### 续做回合分类（2026-10-12，本轮 exited-not-landed 复核：上游 pool 时钟边界 flake）

本轮**零产品码改动**（续用分支上既有实现），只做分类 + 合 develop + 重新确认判据。

上一轮 fan-in 全量套件红 1 条：`server/modules/voice-realtime/tests/voice-realtime-upstream-pool.test.ts` — `AssertionError [ERR_ASSERTION]: the switch must follow the idle threshold, got idleMs=29`（该文件 AC2 以 `idleRotateMs: 30` 作时钟边界判据，`:220` 断言 `rotation.idleMs >= thresholdMs`）。

分类结论：**环境性时钟边界 flake，非本任务 delta 造成**。证据：

1. 本任务对 develop 的净 delta 只有 3 个新文件（`docs/operations/voice-realtime-continuous-calibration.md`、`experiments/voice-realtime-continuous-calibration/run.mts`、`.../corpus.json`）；`git diff HEAD develop -- server/` 为空 ⇒ 该测试文件与被测模块 `voice-realtime-upstream-pool.ts` 对 develop **逐字节相同**，本轮复现运行跑的就是 develop 的版本，红不是本分支引入的。
2. 机制可读：`voice-realtime-upstream-pool.ts:143` `now = options.now ?? Date.now`、`:346` `idleMs: triggeredAt - lastActivityAt`（两个 `Date.now()`），而轮转由 `:171` `setTimeout(idleRotateMs)` 布防——libuv 按 `CLOCK_MONOTONIC` 计时。两钟偏 ~1ms ⇒ 定时器在 monotonic 走 30ms、而 `Date.now()` 只走 29ms 时触发 ⇒ `idleMs = 29 < 30`。
3. 间歇而非确定性：本工作树单文件直跑 6 次 = **3 红 / 3 绿**（每次红都是同一个 `idleMs=29`）。偏置方向相反（决定性）：要得 `idleMs=29` 须 realtime 落后 monotonic；事件循环负载只会让 `setTimeout` **晚**触发 ⇒ `idleMs >= 30` ⇒ 绿。故本 delta（纯 docs + experiments 脚本，不在 pool 路径）原理上无法产生该红。
4. 同一行已有多次记录：`gap-live-voice-interrupt-audit-intent-trigger`（`### 续做回合分类` 节，实测 3 红 / 3 绿）与 `gap-live-voice-caption-row-sorts-above-real-user-row`（`### 2026-10-12 第二轮重跑` 节）都命中同一断言并同样分类为环境性；另有 4 次既往记录（`gap-quay-tab-window-switch-unmounts-the-whole-panel`、`gap-voice-realtime-paced-audio-source`、`gap-live-voice-e2e-scripted-upstream`、`gap-claude-resident-e10-enqueue-interrupt-drain`）。

为何**不改**该文件：它在任何任务的 `## Touches` 之外；改它 (a) 需回溯性加 Touches 行（范围蔓延），(b) 会篡改另一个**已 done** 任务（`gap-voice-realtime-upstream-pool-rotation`，AC-321）的已落地判据——治理越界，不是服务。仓库既有先例（上述两个 sibling 任务）即「分类、记录、合 develop、重退让 driver 重跑」。`@load-sensitive` 标注是**纯文档**约定（`gap-known-load-sensitive-rule-is-doc-only-no-mechanical-triage`；`known-load-sensitive.js --list` 现为空 ⇒ 无机械 triage 收益），故不采用。

本轮复核自身判据：AC1–AC3 报告字段与证据逐条在位（`docs/operations/voice-realtime-continuous-calibration.md` 行首 `C-1 semantic_vad：`/`C-2 silence_duration：`/`C-4 静音计费：`/`C-5 模型等待：`/`成本基线：`/`运行次数：`/`花费：` 全在；运行次数=1、花费 ¥0.1636、:3001 pid 1933227 前后相同、dry-run 执行面）；AC4 `npm run lint` 退出 0（仅存量 warning）。本工作树已 `git merge develop`（无冲突）。`task_check`：`acTotal 4 / acChecked 4`，`ok:true`。

### 续做回合分类（第二轮，2026-10-12，仍 exited-not-landed）

同一任务**第二**个 exited-not-landed 回合，仍**零产品码改动**。delta 仍为那 3 个新文件（`git diff --name-only $(git merge-base develop HEAD) HEAD` = `docs/operations/voice-realtime-continuous-calibration.md`、`experiments/voice-realtime-continuous-calibration/{run.mts,corpus.json}`），`git diff HEAD develop -- server/` 为空。

本轮 fan-in 红了**两条**（上一轮只有一条）：
1. `server/modules/voice-realtime/tests/voice-realtime-upstream-pool.test.ts`（老面孔）——本轮工作树内单文件直跑 6 次 = **3 红 / 3 绿**，每次红都是同一个 `idleMs=29`（`:220`）。该文件与被测模块对 develop 逐字节相同（`git diff --stat HEAD develop -- <两者>` 为空）。
2. `server/modules/providers/tests/claude-resident-peer-name-refresh.test.ts`（**新面孔**）——`kind=assert`，# `Assertion failed: (env_->execution_async_id()) == (0)`（真实 `claude` 子进程在 ≤16 路并发下退出，属实时二进制负载 flake 家族）。本轮工作树内单文件直跑 **1/1 绿**（`ℹ fail 0`，leg「a resident host re-reads its projected peer name once the registry name moves」全绿）。该文件对 develop 逐字节相同。

两条都是**环境性负载 / 时钟边界 flake，非本 delta 造成**：delta 不碰任何 `server/` 文件，且两个失败文件均字节等同 develop；两文件均在任何任务 `## Touches` 之外 ⇒ 不改。解析注意（复核用）：`tsx --test` 打印 spec reporter 的 `ℹ fail N`，不是 TAP `# fail N`——用 `^ℹ fail \([0-9]*\)$` 解析，否则每次都被误判为红。

本轮复核：AC1–AC3 报告字段与证据逐条在位；AC4 `npm run lint` 退出 0（仅存量 warning）；`git merge develop` 干净、无未合并路径；`git merge-base --is-ancestor develop HEAD` = YES；`task_check` `acTotal 4 / acChecked 4` `ok:true`。
