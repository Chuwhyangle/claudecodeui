---
id: observation-session-digest-llm-tier
title: 观察墙 T6：会话摘要第二档（LLM）——一句话结论/选项/跑偏提示，限频限量，用量可查
status: todo
labels:
  - cockpit
  - observation
  - llm
parent: null
children: []
extra: {}
depends_on:
  - observation-session-digest-deterministic
---
## Proposal

决策出处：2026-10-24 与用户确定的「观察墙」方案（驾驶舱首先是观察面）。依据：14 天负载分析（2159 条人类输入、相邻输入一半落在不同会话、切换中位间隔 2.4 分钟；只看不打字的切换未被记录，真实观察负载更高）；用户确认观察会话输出 / quay 状态 / 架构以及为此做的切换是最大负载。硬约束（quay references）：读数三态（取不到 = 未评估 + 原因，不得显示为绿）、每盏绿灯带活性时间戳、语义判断标注「仅建议」、驾驶舱本身比被治理对象小一个量级。

用户判断：用便宜模型、控制好频率，成本不是大问题；从确定性提取开始（T2），本任务加第二档。

方案：
1. 复用 reply-suggestions 模块的 LLM 客户端、设置读取与用量账本的结构（不复制配置项，新增独立配置块）。`config/server.settings.example.json` 增加 `observation.sessionDigest` 块：`enabled`、`model`、`maxPerHour`、`minTurnChars`、`apiKeyFile`（密钥用路径字段，不入模板）。
2. 只为**观察列表内**且本轮内容 ≥ `minTurnChars` 的会话、在轮次结束后异步生成：`{conclusion(一句话), options[](若在问你), driftNote?(与会话目标对比的偏离提示)}`，写入观察对象，`provenance.tier='llm'`；跑偏提示标注「语义判断，仅作建议」。
3. 超过每小时上限 ⇒ 跳过并在对象上标注「本轮未生成（限额）」；调用失败 ⇒ 保留确定性摘要并标注原因。用量写入账本（时间、会话、tokens、耗时）。
4. 驾驶舱预览中把选项渲染为按钮（点击 = 把该选项文本作为回复发送给该会话，需确认）。

## AC

- [ ] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/observation/tests/session-digest-llm.test.ts` exit 0——桩 LLM 客户端：观察列表外或低于 minTurnChars 的轮次不调用；超过 maxPerHour 时跳过并标注限额；调用失败时保留确定性摘要并带原因；成功时写入 tier=llm 且 driftNote 带「仅作建议」标记；每次调用写一条用量记录。
- [ ] AC2: `npx vitest run src/modules/cockpit/tests/ObservationWall.test.tsx` exit 0——LLM 选项渲染为按钮，点击后先出现确认预览，确认后发送恰好一次。
- [ ] AC3: `npm run typecheck` 通过。

## DoD

- 在观察列表内 3 个真实会话上运行一天，贴出用量账本汇总（调用次数、tokens、成本估算）与 10 条摘要的人工评价（准确/偏差/编造）。
- - 隔离实例验证必须关闭常驻会话恢复（`SERVER_SETTINGS_PATH` 指向含 `{"residentRestore":{"enabled":false}}` 的文件，或使用 T7 的隔离实例脚本），否则会对线上同一批会话重复起进程。

## Touches

- server/modules/observation/session-digest-llm.ts
- server/modules/observation/session-digest-llm-settings.ts
- server/modules/observation/tests/session-digest-llm.test.ts
- server/modules/observation/index.ts
- server/modules/reply-suggestions/index.ts
- config/server.settings.example.json
- src/modules/cockpit/ObservationPreview.tsx
- src/modules/cockpit/tests/ObservationWall.test.tsx
- tasks/observation-session-digest-llm-tier.md
