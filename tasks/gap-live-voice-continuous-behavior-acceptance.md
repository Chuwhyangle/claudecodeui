---
id: gap-live-voice-continuous-behavior-acceptance
title: Continuous 行为验收 B-1..B-9 本地确定性（持续补充/细化/改方向/主动中断/保留必要
  run/不重复交付/真实进度/无需动作/长句），只改测试
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-371
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


### 本任务（只改测试，现在可派发）

在 `server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts` 中加入 B-1..B-9（**不新增 `*.test.ts`**，以免碰到在飞 STS 任务持有的 `quay-test-script.test.ts` 计数钉子与 `suite-duration-baseline.tsv`）。

部件：
- 真实 bridge + 真实 ws-proxy，走 continuous 路径（不发 `hello`/分段帧，20 ms PCM 持续上传，含静音）；
- scripted 上游：复用 AC-359 状态机与 AC-361 的 server_vad 声学仿真（按收到的 PCM 判静音，自动 commit 并自动 response）。模型决策按脚本逐条目给定：send / interrupt（带或不带修正）/ status / 不调用 / 文本回复。
- **CLI 宿主模型**：新建非测试模块 `server/modules/voice-realtime/tests/voice-realtime-scripted-cli-host.ts`，把 `voice-realtime-queue-depth-truth.test.ts` 与 `voice-realtime-interrupt-fence.test.ts` 中两份临时宿主的语义统一起来，并按 E9/E10 实测补齐：
  - 回合边界把 N 条排队消息聚合进同一次请求；
  - 中断后队列保留；
  - 中断后 ≥50 ms 推入的消息落到再下一轮（stale-first 窗口）；
  - 按 uuid 撤回（含非最新条目）；
  - `command_lifecycle` 的 queued / started / completed / cancelled。
- 已知缺陷辅助：复用 `server/modules/voice-realtime/tests/voice-realtime-known-defect.ts`（AC-365）。

用例（模型决策由脚本给定，**只验证管线在该决策下的行为**，不声称模型判断质量）：

| 用例 | 场景 | 断言 |
|---|---|---|
| B1 持续补充 | run 进行中补充细节 | send ⇒ 排队 ⇒ 下一回合聚合；无中断；每句投递恰一次 |
| B2 细化 | 补充约束 | 「追加」与「改方向」两种脚本决策各走一遍，结果与决策一致 |
| B3 改方向 | — | 中断带修正：修正先进入 CLI 队列，再 abort；下一回合以修正为准；stale-first = 0 |
| B4 主动中断 | 只取消 | 无修正；排队消息不被清空，且如实显示仍排队数 |
| B5 保留仍必要的 run | 与当前 run 无冲突的补充 | 无中断；run 正常完成；同一句的重复中断被栅栏挡住（covered） |
| B6 不重复交付 | 上游把一句话切成两个 VAD 条目、同一 call 重放 | 每条话语至多投递一次；按 `(responseId, callId)` 去重 |
| B7 真实进度 | 执行中 | 浏览器状态帧与模型可见读数同源，且包含当前 run 覆盖的投递、排队未开始、CLI 最近活动、新鲜度 |
| B8 无需动作 | 模型回 "OK" 或不调用；空条目上编造 `session_send` | 前者不下发错误帧、显示为已听到未转发；后者不投递 |
| B9 长句 | 连续 45 s 口述含 1–3 s 停顿 | 无强切、无单帧大 append（每帧 ≤ 100 ms 音频）、每个上游条目可追溯到投递或「未转发」 |

**当前预期**：B7（缺 RunDigest）与 B8（无需动作被当错误、空条目投递）大概率不达标。用 `expectKnownDefect` 包裹：
- 签名必须包含**当前实际值**（例如「状态帧字段集合 = […]，缺 lastActivity」）；
- `fixTask: 'gap-live-voice-run-digest-evaluation-signal'`；
- 每条已知缺陷腿配一个取假用例，证明签名不会吞掉别的失败（参照 T370 的做法）。

其余用例若在当前代码上通过，就直接断言。若发现别的意外缺陷，同样用签名记录，并在 `## Notes` 写明归因（我方 / 协议 / 未知）。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


- ⛔ 只改测试文件；不新增 `*.test.ts`；不改 `server/modules/voice-realtime` 下的非测试文件与 `src/`。

<!-- dedup-ref --> 机制去重（2026-10-13）：AC-361（done）测的是 X-1..X-7 体验指标，不含 CLI 宿主语义与持续评估行为；AC-345（done）只覆盖打断类浏览器场景；open 任务对「RunDigest / 持续评估 / 无需动作」0 命中。

## Plan

1. 统一 CLI 宿主模型并自测（聚合、保留队列、stale-first、撤回、lifecycle）；2. continuous 场景编排工具（PCM 时间线、脚本化模型决策）；3. B1..B9；4. 已知缺陷签名、取假用例与三次稳定性读数；5. typecheck / lint。

## AC

- [ ] AC1：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts` 退出 0，含 `test('B1 ` … `test('B9 ` 九个用例。
- [ ] AC2：CLI 宿主模型的五项语义各有自测，且有一个取假用例（例如回合边界不聚合 ⇒ B1 红）。
- [ ] AC3：已知缺陷腿的签名包含实际值、`fixTask` 正确、各有取假用例；`## Notes` 逐条列出签名与归因。
- [ ] AC4：三次运行读数一致；零外联；产品代码 diff 为空。
- [ ] AC5：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

本地确定性测出 continuous 路径在 B-1..B-9 上的真实状态：哪些达标、哪些缺失，缺失项有精确签名和修复归属；不改产品代码。

## Touches

- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts（B1–B9）
- server/modules/voice-realtime/tests/voice-realtime-scripted-cli-host.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts（仅当需补模型决策脚本接口）
- tasks/gap-live-voice-continuous-behavior-acceptance.md

## Notes

立项：Opus 常驻会话，2026-10-13，人 yale 裁定（GOAL-044 / AC-371）。
