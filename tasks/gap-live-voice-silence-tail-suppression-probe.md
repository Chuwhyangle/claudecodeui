---
id: gap-live-voice-silence-tail-suppression-probe
title: Silence Tail Suppression 真实探针
  V-1..V-8（时间基、停传空闲、尾音/前滚、恢复前状态、误判、模式、等价性、节省），实验原型不改产品代码，给出 T/P 推荐依据
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-363
---
## Proposal

### 背景

人 yale 2026-10-12 提出体验优先候选策略 **Silence Tail Suppression（STS）**，定义见 `docs/proposals/live-voice-experience-first-decision-2026-10.md` §10（提交 `18616927`）：
- continuous 模式下，断句与 response 仍由上游 `server_vad` 决定；
- 本地只检测静音：语音结束后继续上传**真实底噪** `T` 秒，之后暂停上传；
- 恢复讲话时先补发前滚 `P`，再逐帧上传；
- 不 commit、不 `response.create`、不关 WS。

**`T` 不是已验证的安全阈值**。本任务是 STS 的真实上游探针：在**实验脚本内的 STS 原型**上回答 V-1..V-8，**不改产品代码**。

### 验证项（每项都要原始读数）

| # | 问题 | 做法要点 |
|---|---|---|
| V-1 | 上游 VAD 按音频时间轴还是墙钟检测静音 | 语音后只送 `silence_duration_ms − 100 ms` 真实静音，然后停传 5 s，看是否 / 何时 `speech_stopped`；再用 `+100 ms` 对照；对 400 与 800 两档 `silence_duration_ms` 各做一次 |
| V-2 | 停传期间的空闲行为 | 停传 1 / 5 / 15 / 30 min 后恢复讲话：连接存活、错误事件、首句延迟；qwen3.8 上 `idle_timeout_ms` 是否被接受并生效（文档称仅 qwen3.5） |
| V-3 | 尾音截断与前滚 | 弱尾音、快速起音语料；`P ∈ {300, 500, 800} ms`；对照转写首尾字 |
| V-4 | 恢复前的上游状态 | tail 后缓冲是否已 commit；恢复时有无空 commit 错误、额外条目或 response |
| V-5 | 误判 | 底噪、键盘声、低音量语音在原型检测器下的误判静音率与误判语音率 |
| V-6 | 模式关系 | 说明原型只在 continuous 生效；记录 `server-vad` 提交回退模式下同一语料的对照（可选，预算允许时） |
| V-7 | 输出时机与成本等价 | 同一语料两臂（STS 原型 / 基线 continuous）：条目数、`speech_stopped` 时刻差、response 数、工具调用、usage（text / audio 分列） |
| V-8 | 上传节省 | 两臂上传秒数 / 会话秒数 |

产出：`docs/operations/voice-realtime-silence-tail-suppression-probe.md`，行首字段与 AC-363 判据一致（`V-1 时间基：` … `V-8 上传节省：`、`T 推荐：`、`P 推荐：`、`运行次数：`、`花费：`）。**推荐值必须引用读数**；读数不足时写「不足以推荐」，不得给经验值。

### 安全边界

- 备用端口第二实例或直接用实验脚本连上游（参照 `docs/operations/voice-realtime-interrupt-sampling.md` 的做法）；每连接 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION=0.05`，总花费上限 ¥1.5（V-2 的长停传主要是墙钟时间，不是 token）。
- 执行面 dry-run；合成 `sessionId`；`CLAUDE_SESSION_SCOPE_SWEEP=off`；不重启 :3001（记录前后 pid）；不发布；不触碰 Quay worker / driver。
- 只跑一次（V-2 的四档停传时长可在同一运行内并行于不同连接）。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


<!-- dedup-ref --> 机制去重：原 AC-362 的 C-3（丢静音致盲）与 C-6（静音尾最小值）已移入本任务（AC-362 判据已删除这两行）；open 任务对「停传 / 前滚 / 时间基」0 命中。

## Plan

1. 实验脚本 `experiments/voice-realtime-silence-tail-suppression/probe.mts`：STS 原型（偏向语音的检测器、真实底噪 tail、前滚环形缓冲）、两臂对照、逐连接 journal。
2. 语料 `experiments/voice-realtime-silence-tail-suppression/corpus.json`（复用 TTS 合成流程与 `experiments/voice-trim/fixtures/`；含弱尾音、快速起音、低音量、噪声）。
3. 单次运行；报告。

## AC

- [ ] AC1：报告存在，含 AC-363 判据要求的全部行首字段（判据逐行检查）。
- [ ] AC2：V-1 有 `−100 ms` / `+100 ms` × 两档 `silence_duration_ms` 的事件时间线原文摘录与结论。
- [ ] AC3：V-7 给出两臂逐项对照表（条目数、`speech_stopped` 时刻差、response 数、工具调用、usage text/audio 分列）。
- [ ] AC4：报告写明运行次数 = 1、每连接上限与实际花费（CNY）、:3001 前后 pid 相同、dry-run 执行面；`T` / `P` 推荐值逐条引用读数或写「不足以推荐」。
- [ ] AC5：`npm run lint` 退出 0（若新增脚本受 lint 覆盖）。

## DoD

真实 `qwen3.8-omni-flash-realtime` 跑过一次，V-1..V-8 读数完整；产品代码 diff 为空；读数被决策文档 §10.6 的裁定与 AC-364 的默认值引用。

## Touches

- docs/operations/voice-realtime-silence-tail-suppression-probe.md (new)
- experiments/voice-realtime-silence-tail-suppression/probe.mts (new)
- experiments/voice-realtime-silence-tail-suppression/corpus.json (new)
- tasks/gap-live-voice-silence-tail-suppression-probe.md

## Notes

立项：Opus 常驻会话，2026-10-12，人 yale 提出 STS（GOAL-044 / AC-363）。
