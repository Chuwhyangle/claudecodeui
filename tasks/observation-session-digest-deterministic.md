---
id: observation-session-digest-deterministic
title: 观察墙 T2：会话磁贴生产者——每轮结束确定性摘要（结论摘录/改动/命令/测试/是否在问你/差量）
status: ready
labels:
  - cockpit
  - observation
parent: null
children: []
extra: {}
depends_on:
  - observation-object-model-seen-cursor-and-delta
---
## Proposal

决策出处：2026-10-24 与用户确定的「观察墙」方案（驾驶舱首先是观察面）。依据：14 天负载分析（2159 条人类输入、相邻输入一半落在不同会话、切换中位间隔 2.4 分钟；只看不打字的切换未被记录，真实观察负载更高）；用户确认观察会话输出 / quay 状态 / 架构以及为此做的切换是最大负载。硬约束（quay references）：读数三态（取不到 = 未评估 + 原因，不得显示为绿）、每盏绿灯带活性时间戳、语义判断标注「仅建议」、驾驶舱本身比被治理对象小一个量级。

方案：挂在会话「轮次结束」上（`chat-run-registry` / provider 运行时已有的完成点），对观察列表内及处于等待/出错的会话生成确定性摘要，写入观察层（T1）。不调用任何模型。
- 状态：来自 activity 协议——运行中 / 等你（有待批权限请求，或本轮末段以问句/选项结尾） / 空闲 / 出错。
- 结论：最后一条助手消息的末段（截断到 ~280 字，标注「原文摘录」）。
- 动作：本轮工具调用统计——改动文件列表（Edit/Write/NotebookEdit 的路径去重）、执行的命令（Bash 描述或命令首段）、测试结果（识别 vitest/node --test/playwright 的通过/失败计数输出；识别不到为「未评估」）。
- 问你：末段问句/编号选项的提取（启发式只决定强调与否，不触发任何动作）；待批权限请求数。
- 差量条目：「新增 N 轮」「改动 M 个文件」「测试 由绿转红」。
- 无 transcript 或解析失败 ⇒ status unevaluated + reason。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/observation/tests/session-digest.test.ts` exit 0——固定 transcript 夹具：改动文件去重正确；vitest/node --test/playwright 三种输出各自解析出通过/失败计数，无法识别的输出给出「未评估」；以问句结尾与以编号选项结尾的末段判为「问你」，以陈述结尾的不判；结论摘录截断且标注 tier=deterministic。
- [x] AC2: 同一测试文件——轮次结束事件触发恰好一次写入且 revision+1；不在观察列表且不处于等待/出错的会话不写入；transcript 缺失时写入 unevaluated + reason。
- [x] AC3: `npm run typecheck` 通过。

## DoD

- 对 5 个真实会话（含一个以提问结尾、一个跑测试、一个出错）生成摘要，人工核对每条的「问你」判定与测试计数，报告误判数。
- 隔离实例验证必须关闭常驻会话恢复（`SERVER_SETTINGS_PATH` 指向含 `{"residentRestore":{"enabled":false}}` 的文件，或使用 T7 的隔离实例脚本），否则会对线上同一批会话重复起进程。

## Touches

- server/modules/observation/session-digest.ts (new)
- server/modules/observation/session-digest.producer.ts (new)
- server/modules/observation/tests/session-digest.test.ts (new)
- server/modules/observation/tests/fixtures/session-transcript.jsonl (new)
- server/modules/observation/index.ts
- server/modules/websocket/services/chat-run-registry.service.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/observation-session-digest-deterministic.md

## Blocker

**2026-10-24T09:43:56.514Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=89531 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1792834643520
- run_id：wk-prod-anchor
- session_id：afb6aeed-de44-4404-8bbf-5294bcf04c35
