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

## Blocker

**2026-10-12T12:55:04.863Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/voice-realtime/tests/voice-realtime-upstream-pool.test.ts:   AssertionError [ERR_ASSERTION]: the switch must follow the idle threshold, got idleMs=29
- run_id：wk-prod-anchor
- session_id：a7e0fb45-3049-42c6-88de-c28dab03fd73
