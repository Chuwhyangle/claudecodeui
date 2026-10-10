---
id: gap-voice-realtime-upstream-pool-rotation
title: P3 上游会话池与空闲轮换：热备上游会话，空闲超阈值后切换到新会话，不迁移历史，轮换延迟可测
status: needs-human
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-segmented-relay-p0a-commit-rotation-context
  - gap-voice-segmented-relay-protocol-server-commit
goal_ac: AC-321
---
## Proposal

<!-- dedup-ref --> 去重检查（2026-10-10）：桥目前一个连接对应一个上游会话，断线重连逻辑已有（`UPSTREAM_STALLED` 处理），但没有「空闲时主动换新会话」的机制；本条不重做重连，只在其上加主动轮换。平台上游会话保存音频历史（≤100 轮/600 秒），旧会话越长每次读取越贵，这是轮换的动机。

来源：SPEC「C3 上游池」。

### 方案

1. 桥维护一个主上游会话与至多一个热备；空闲（无段在途、无工具调用在途）超过 `idleRotateMs`（默认 90 s，可由设置调整）后切换到热备，随后在后台补一个新的热备。
2. 切换不迁移历史；上下文由 P2 的上下文包在新会话里重新注入（P2 未合入时，轮换仍可工作，只是没有上下文）。
3. 切换点不丢段：段在途时推迟切换；切换瞬间到达的段进入新会话。
4. 日志：`rotate from=… to=… idleMs=… standbyAgeMs=…`；诊断报告含 `rotations[]` 与每次的切换耗时。
5. 成本：热备只建立连接不送音频，P0a-S2 已量过空连接开销，上限写进设置并在日志里核对。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-upstream-pool.test.ts` 退出码 0
- [x] 空闲超阈值后发生一次轮换，切换耗时（从触发到新会话可接收音频）≤ P0a-S2 记录的基线 ×1.5（基线从 `experiments/voice-realtime-segmented/p0/RESULT.json` 读取，不硬编码）
- [x] 段在途时不轮换；轮换瞬间到达的段在新会话里恰好提交一次，投递恰好一条
- [x] 热备在轮换前一直不收到音频帧（假上游计数为 0）
- [x] 取假形态必须变红：忽略在途段强制轮换 → 在途段用例红；热备提前收帧 → 计数用例红
- [x] 新增服务端测试文件后 `quay-test-script.test.ts` 退出码 0（同步钉子与基线）
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：真实上游上一次确认运行（预算 ≤ ¥0.02）：说一句话 → 等待超过 `idleRotateMs`（测试里把阈值调小）→ 再说一句话，两句都送达绑定会话，日志有一条 `rotate`，报告里记录切换耗时；结果追加到 `experiments/voice-realtime-segmented/p3/RESULT.json`。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-upstream-pool.ts (new)
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/index.ts
- server/index.ts
- server/modules/voice-realtime/voice-realtime-diagnose.service.ts
- server/modules/voice-realtime/tests/voice-realtime-upstream-pool.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-diagnose.test.ts
- experiments/voice-realtime-segmented/p3/RESULT.json (new)
- experiments/voice-realtime-segmented/p3/pool-rotation.mts (new)
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-realtime-upstream-pool-rotation.md

## Needs-Human

**执行 2026-10-10T10:38:23.429Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 1 failing lines and attributed none to a file; pseudo-stage tokens: suite-watchdog); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：7eaaae29-1f6a-48bd-9ed1-afa868ac85d9
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-realtime-upstream-pool-rotation~wk-prod-anchor~1791628664653-baa6b4.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-realtime-upstream-pool-rotation-wk-prod-anchor.log
