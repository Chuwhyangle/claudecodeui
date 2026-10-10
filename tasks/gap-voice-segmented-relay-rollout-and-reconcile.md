---
id: gap-voice-segmented-relay-rollout-and-reconcile
title: P4 默认开启与对账：服务端默认声明 segmented-v1（VOICE_REALTIME_MODE=continuous
  回退），成本回放测试线，真实 Qwen Realtime 运行逐项对账，账单项标 pending-external
status: done
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

**现状（2026-10-10，P1c/P2/P3 已落地后读源码）**：浏览器侧 `voiceRealtimeProtocol.ts` 在 socket 打开后发 `hello{protocol:'segmented-v1'}`，只有收到带同一 token 的 `ready` 或 `state` 帧才切到分段上行；服务端 `voice-realtime-ws-proxy.service.ts` 能接收 `segment_start/audio(seq)/segment_end/context`，上游池也由 `server/index.ts` 的 `resolveIdleRotateMs()` 接线，**但服务端从不对 hello 作答、从不声明 `protocol`**——所以线上真实浏览器恒走连续帧，分段中继只在测试里生效。这正是「不能仅在测试里启用」要堵的缺口。

<!-- dedup-ref -->相关但机制不同：已落地的 P1b/P1c/P2/P3 各自提供协议、接线、上下文包、上游池，本任务不重做它们，只补「默认声明、回退开关、对账」；`estimateRealtimeCostCny` 与日志里的 `cost~CNY` 已存在，不改公式（除非对账显示偏差超过阈值）。用户决策（2026-10-10）：分段中继默认开启并保留回退开关；异常线只作用于自动测试；账单不可得时不得虚构对账成功。

### 方案

1. **默认开启**：服务端处理 `hello` 时，在 `VOICE_REALTIME_MODE` 未设置或为 `segmented` 时回 `{type:'ready', protocol:'segmented-v1'}`；为 `continuous` 时不回（浏览器因此维持连续帧，行为与改动前逐帧一致）。模式解析放在一个纯函数里，`server/index.ts` 的 `buildVoiceRealtimeSeams` 在真实组装处调用它，测试从这个调用点读默认，不在测试里自行传入。非法取值按默认处理并记一条日志。
2. **回退**：只改服务端环境变量（systemd drop-in），无需改浏览器；回退路径有同等测试覆盖。
3. **成本回放测试线**（仅自动测试）：`voice-realtime-cost-replay.test.ts` 回放 60 句、2,000 字符包，每句估算 ≤ ¥0.006、69 句/小时折算 ≤ ¥0.45；阈值写成随包大小缩放的函数。
4. **对账脚本** `scripts/voice-realtime-reconcile.mjs`：`--check <md>` 读 `docs/operations/voice-realtime-reconcile.md` 的表格，核对「逐段日志合计 = 逐响应 `usage` 之和」「估算 = 单价×token」「落在 SPEC 预期区间内」；账单列为 `pending-external` 时只输出替代证据并明确标注，**不得**把空账单当成对账成功；`--self-test` 覆盖偏差超阈值、账单缺失两种形态。
5. **一次真实 Qwen Realtime 运行（预算 ≤ ¥0.03，每个探针内置累计估算守卫）**：用 `scripts/voice-realtime-diagnose.mjs --live --segments` 送入现有 4 条中文语料（zh-d01…），记录分段数、上行音频秒数、逐响应 token 三类（文本输入/音频输入/文本输出）、日志成本估算，写入对账记录；运行结束后核对无残留上游连接（诊断报告 `closed`、进程内连接计数为 0）。
6. 在 SPEC 的成本一节回填实测并更正 P4 一行（默认由 continuous 改为 segmented）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-segmented-default.test.ts` 退出码 0：未设环境变量时，经真实 `buildVoiceRealtimeSeams` 组装的连接对 `hello` 回 `ready{protocol:'segmented-v1'}`；`VOICE_REALTIME_MODE=continuous` 不回；非法值按默认
- [x] 默认路径端到端：假上游下，浏览器侧的真实协议模块（非测试自造帧）在默认配置下走分段上行，上行音频 ≤ 原片长的 25%；`continuous` 回退下与改动前逐帧一致（既有 `voice-realtime-ws-proxy.protocol-simulation.test.ts` 与 `…replay.test.ts` 不改动仍通过）
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-cost-replay.test.ts` 退出码 0（每句 ≤ ¥0.006，69 句/小时 ≤ ¥0.45，阈值随包大小缩放）
- [x] `node scripts/voice-realtime-reconcile.mjs --self-test` 退出码 0，且 `node scripts/voice-realtime-reconcile.mjs --check docs/operations/voice-realtime-reconcile.md` 退出码 0：记录含分段数、上行音频秒数、三类 token、日志估算与 `response.done.usage` 之和一致，账单列为 `pending-external` 且被脚本如实报告而不是当作通过
- [x] grep 判据：生产代码（`server/` 非 tests、`src/` 非 tests）中没有连接时长上限常量或其环境变量默认值
- [x] 取假形态必须变红：默认改回不声明 ⇒ 默认用例红；对账脚本把空账单当成功 ⇒ `--self-test` 红；估算公式与 usage 不一致 ⇒ `--check` 红
- [x] 新增服务端测试文件后 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0（同步钉子与基线）
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0
- [ ] 阿里云账单行与本地估算逐位核对（偏差 ≤ 1%）：该行只能由人 yale 提供账单数据后产生（待外部）

## DoD

真实落地标准：①服务端以**默认环境**（不设 `VOICE_REALTIME_MODE`）启动，一次真实 Qwen Realtime 运行经 HTTP 诊断或浏览器走通分段路径，报告含分段数、`audioSecondsUpstream`、三类 token、`answered=true`，且运行结束无残留连接；②对账记录里真实贴出这些读数与 `--check` 的原始输出，账单列如实为 `pending-external`，不得写成已对账；③不重启运行中的服务属于本任务范围外——部署与重启由会话在合并后按「重启前先声明、重启为最后一步」执行并留证据。

## Touches

- server/index.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-mode.ts (new)
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/tests/voice-realtime-segmented-default.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-cost-replay.test.ts (new)
- scripts/voice-realtime-reconcile.mjs (new)
- scripts/voice-realtime-reconcile.test.mjs (new)
- docs/operations/voice-realtime-reconcile.md (new)
- docs/proposals/voice-realtime-segmented-relay-SPEC.md
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-segmented-relay-rollout-and-reconcile.md