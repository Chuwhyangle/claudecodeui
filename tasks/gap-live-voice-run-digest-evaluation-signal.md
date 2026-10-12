---
id: gap-live-voice-run-digest-evaluation-signal
title: 持续评估信号：RunDigest 进状态行与 session_status、决策词汇、无需动作不报错、空条目不投递
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-continuous-behavior-acceptance
  - gap-live-voice-silence-tail-suppression
goal_ac: AC-373
---
## Proposal

### 背景（本组任务共用）

人 yale 2026-10-13 裁定（决策文档 `docs/proposals/live-voice-experience-first-decision-2026-10.md` §11–§12，提交 `31d1b8b2`）：
- Live Voice 体验优先：**禁用浏览器 VAD 分段与中继静音门控（含 STS）**，改为 continuous 传输；
- **保留上游 `server_vad`**（或经校准的 `semantic_vad`）作为评估触发，绝不出现关了 VAD 又无触发；
- 模型随用户意图逐渐完整，**反复评估**在执行的 CLI 工作：继续、修改、取消或无需动作。

两条边界分开：
- 音频采集与传输：持续 20 ms PCM，含静音，不分段、不门控；
- 语义输出：由模型决定投递、中断或无需动作；CLI 在回合边界聚合。

已有读数：
- C-4：静音零计费；
- V-2：停传约 300 s 被上游 1007 关闭；
- C-1：`semantic_vad` 有效；
- C-5：模型不会自己等句子完整。

**缺失的 L4 持续评估信号**（§12.5）：
- 模型只看得到计数状态行和连接时一次性的上下文包，不知道当前 run 覆盖了哪些意图、还有哪些排队未开始、CLI 最近在做什么；
- 「无需动作」会被记为 `MODEL_TEXT_REPLY` 错误；
- 空条目上的编造投递会漏过。


### 本任务（实现）

1. **RunDigest**：由执行面事实（host lifecycle、已投递记录、排队未开始的命令、run 活动存储中的最近工具或助手文字）派生：
   - 当前 run 覆盖的投递条数与末条摘要（≤ N 字）；
   - 排队未开始的条数与末条摘要；
   - CLI 最近活动（工具名或助手文字摘要）；
   - `at` / `ageMs`。
   状态行仍受既有字节上限、限频、去重约束；超出时截断摘要，不扩上限。`session_status` 返回全量，与状态行同源（`statusSeq`）。
2. **决策词汇**写入指令，语义描述、无关键词：
   - 继续：不调用工具，可以回 "OK"；
   - 补充：`session_send`；
   - 改方向：`session_interrupt` 携带修正；
   - 取消：`session_interrupt` 不带修正。
   保持 AC-340 的「无停止词清单」判据为绿。
3. **无需动作不报错**：模型的简短文字回复不再作为 `MODEL_TEXT_REPLY` 错误帧下发，改为可观测的「已听到、未转发」处置。
4. **空条目不投递**：`session_send` 的放行按**其所属条目自身**的空转写判定（不依赖到达时刻的段），空条目上的投递被拒绝并如实显示。
5. 翻转 AC-371 中 `fixTask` 为本任务的已知缺陷腿。
6. **不增加**无用户语音时主动唤起模型的触发。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 读 AC-371 记录的签名与 AC-372 R-3 读数（指令措辞参考）；2. 实现 1–4；3. 翻转 B 腿；4. 跑既有状态行、状态工具、指令、空转写相关判据；5. typecheck / lint。

## AC

- [x] AC1：`grep -n "fixTask: 'gap-live-voice-run-digest-evaluation-signal'" server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts` 无输出，且该文件单文件运行退出 0。
- [x] AC2：`voice-realtime-status-tool.test.ts`、`voice-realtime-status-injection.test.ts`、`voice-realtime-instructions-no-stop-words.test.ts`、`voice-realtime-empty-transcript-guard.test.ts`、`voice-realtime-interrupt-fence.test.ts` 退出 0。
- [x] AC3：状态行字节上限未放宽（读数）；`session_status` 与状态行 `statusSeq` 一致。
- [x] AC4：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

本地确定性 B-1..B-9 全部为直接断言并通过；模型在每次被问到时能看到当前 run 的内容级摘要；无需动作与空条目都被如实处置；不开启任何生产开关。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts（仅当无需动作的判定在此）
- server/modules/voice-realtime/voice-realtime-live-executor.ts（session_status 全量字段）
- server/modules/voice-realtime/voice-realtime-tools.ts（session_status 输出结构）
- server/index.ts（仅当需装配 run 活动读数）
- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts（翻转 B 腿）
- server/modules/voice-realtime/tests/voice-realtime-status-tool.test.ts（字段集合钉子）
- server/modules/voice-realtime/tests/voice-realtime-status-injection.test.ts（状态行形状钉子）
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts（仅当指令文本断言受影响）
- tasks/gap-live-voice-run-digest-evaluation-signal.md

## Notes

立项：Opus 常驻会话，2026-10-13（GOAL-044 / AC-373）。depends_on 含 STS 实现任务：两者共改 ws-proxy。

## Blocker

**2026-10-12T18:56:27.152Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/providers/tests/claude-sessions.test.ts:   AssertionError [ERR_ASSERTION]: open-a.jsonl was opened by a scan that should have skipped it
- run_id：wk-prod-anchor
- session_id：319f7b58-ca0a-42c1-a7f1-92b771e5979f

## Evidence

- 前一退出轮（2026-10-12T18:56Z / 19:03Z）`step=suite` 红：`server/modules/providers/tests/claude-sessions.test.ts` → `AssertionError [ERR_ASSERTION]: open-a.jsonl was opened by a scan that should have skipped it`（用例 `a scan does not open the transcripts its cursor excludes`）。
- 复跑分类（本任务 delta 仅 voice-realtime 5 文件，该测试文件与 develop **逐字节相同**，delta-relatedness = UNRELATED）：单文件直跑 **30/30 exit 0**；本任务 6 个判据文件在 `with-memory-cap.sh`（`QUAY_MEMORY_MAX=6G`、`--test-concurrency=4`）下 **70/70 exit 0**（含 scripted-scenarios AC1、status-tool / status-injection / instructions-no-stop-words / empty-transcript-guard / interrupt-fence AC2；AC3 读数：状态行 `statusSeq=2` 与 `session_status` 一致、字节上限未放宽）。⇒ 负载时序 atime 抖动，非本任务回归；同一文件在 `tasks/gap-voice-segmented-relay-protocol-server-commit.md`（2026-10-10）及 2026-10-06 / 10-09 各记一次同形红，属已知 load-sensitive 家族（`server/**` 测试不在 `known-load-sensitive.ts` 的扫描 glob 内，故 `@load-sensitive` 标注在本仓无机械效果）。
- AC4 复跑：`npm run typecheck` exit 0、`npm run lint` exit 0（仅既有 warning）。
- 已 `git merge --no-edit develop`（无冲突，Already up to date）；工作树干净，交由驱动重跑 fan-in。
