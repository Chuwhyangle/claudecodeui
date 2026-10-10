---
id: gap-voice-segmented-relay-rollout-and-reconcile
title: P4 发布与对账：分段中继默认开启，真实账单行与日志估算对账，成本落在 SPEC 模型的区间内，异常线仅用于自动测试
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-segmented-relay-client-wiring
  - gap-voice-realtime-context-pack-and-hot-settings
  - gap-voice-realtime-upstream-pool-rotation
  - gap-voice-segmented-relay-p0b-endpoint-history-cache
goal_ac: AC-322
---
## Proposal

<!-- dedup-ref --> 去重检查（2026-10-10）：计费估算 `estimateRealtimeCostCny` 与日志里的 `cost~CNY` 已存在，但没有与真实账单行对账的脚本与记录；本条补对账与默认开关，不改估算公式（除非对账显示偏差超过阈值）。SPEC 用户决策：异常线只作用于自动测试，不限制实际使用的时长，具体值可调。

来源：SPEC「成本模型」「观察与调参」「发布」。

### 方案

1. 把分段中继设为默认路径，保留一个设置开关可退回连续协议（退回路径有测试）。
2. 对账脚本 `scripts/voice-realtime-reconcile.mjs`：读取服务日志中一次连接的 `usage` 与 `cost~CNY` 行，与用户提供的账单行（tokens、金额）比较，输出偏差百分比；偏差超过阈值时返回非零退出码。
3. 自动测试专用的异常线（每段/每分钟的估算花费上限）放在测试配置里，不进入生产代码路径；生产路径不设单次连接时长上限。
4. 在 SPEC 的成本模型一节回填一次实测：每句费用、一小时估算，与 SPEC 里的 ¥0.33/h 比较。

## AC

- [ ] `node scripts/voice-realtime-reconcile.mjs --self-test` 退出码 0（内置样例对账通过，偏差超阈值时退出码非 0 也由自测覆盖）
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-segmented-default.test.ts` 退出码 0：默认走分段协议；设置开关关闭后行为与改动前连续协议一致
- [ ] grep 判据：生产代码（`server/` 非 tests、`src/` 非 tests）中没有「连接时长上限」常量或环境变量默认值
- [ ] 真实账单对账：用户提供至少一条分段中继下的账单行，对账输出偏差 ≤ 15%（该行只能由用户提供账单数据后产生（待外部））
- [ ] 新增服务端测试文件后 `quay-test-script.test.ts` 退出码 0（同步钉子与基线）
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：服务按默认配置运行，一次真实对话（至少 4 句话、跨度 ≥ 3 分钟）全部送达绑定会话，日志估算与账单行对账；SPEC 成本一节已回填实测。重启服务属于最后一步，须先向用户说明会暂停本会话。

## Touches

- server/index.ts
- server/modules/voice-realtime/voice-realtime-settings.ts
- scripts/voice-realtime-reconcile.mjs (new)
- server/modules/voice-realtime/tests/voice-realtime-segmented-default.test.ts (new)
- docs/proposals/voice-realtime-segmented-relay-SPEC.md
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-segmented-relay-rollout-and-reconcile.md