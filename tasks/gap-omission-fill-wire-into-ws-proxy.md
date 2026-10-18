---
id: gap-omission-fill-wire-into-ws-proxy
title: ws-proxy 接入遗漏补发：取代 settle producer 的丢话兜底触发，补发写日志，并关闭 interrupt_response
status: todo
labels:
  - gap
  - voice
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-omission-fill-pure-module-and-parity
goal_ac: AC-401
---
## Proposal

GOAL-046 第三个任务。依赖任务 `gap-omission-fill-pure-module-and-parity`。后端改动，遵循 `.agents/skills/backend-module-standards/SKILL.md`。

人 yale 2026-10-18 裁定：**取代 settle producer 对"丢话兜底"的触发，不叠加**（两套兜底会互相重复）。

做什么：

1. 在 `voice-realtime-ws-proxy.service.ts`（settle 在约 4060–4190 行，`sessionSend` 约 4197–4271 行）里，用 `planOmissionFills` 驱动的计时取代 `VOICE_SPAN_SETTLE_MS` 触发的"到点把整段水位线内识别原文发出"。保留：`MODEL_TEXT_REPLY` 逐字分支、忙等待与合并投递、水位线对"已听到"的记账（若其语义与新规则冲突，按 SPEC「接入方式」第 3 条处理并在备注写明）。
2. 求值时刻：每条转写到达时登记；`T_i` 到期时求值。需要的只有内存里的转写序列与已执行消息序列（已执行＝所在 response 为 completed 的 `session_send`/`session_interrupt`）。
3. 补发走现有投递通路（忙等待、合并），同一时刻到期的多条按时间顺序合成一条。
4. 连接日志新增 `omission_fill` 记录：`{i, dueAt, coverage, reason}`；被放过的候选也记放过原因，便于回放核对。
5. `turn_detection` 增加 `interrupt_response:false`（`voice-realtime-dashscope-transport.ts` 的 `DEFAULT_SESSION_DEFAULTS` 附近）。注意此前的教训：所有完整 `session.update` 都要带它，不能只在首次发。
6. 参数（H、G、阈值）作为可热修改的配置，写入连接日志。

## AC

- [ ] `bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-omission-fill-wiring.test.ts` 退出码 0（即 AC-401）。
- [ ] 既有 `server/modules/voice-realtime/tests/voice-realtime-ws-proxy*.test.ts` 中与 settle、MODEL_TEXT_REPLY、忙等待相关的用例退出码 0（逐个文件单跑，不得做无界多文件 fan-out）；与 settle 触发语义直接冲突的旧断言按新契约改写，并在 Notes 逐条列出改了哪条、为什么。
- [ ] `npx tsc --noEmit -p server/tsconfig.json` 退出码 0。

## DoD

用脚本化 bridge 与假时钟，在测试里读到：被模型覆盖的转写在 2500 ms 后不再有识别原文投递；始终未被覆盖的 ≥7 字转写在 `T_i` 恰好投递一次，且日志里有对应 `omission_fill` 记录；`session.update` 的 `turn_detection` 带 `interrupt_response:false`。读数取自测试输出。上线（build/restart :3001）由人工做，不在本任务内。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/voice-realtime-log.ts
- server/modules/voice-realtime/tests/voice-realtime-omission-fill-wiring.test.ts
- tasks/gap-omission-fill-wire-into-ws-proxy.md

## Notes

ws-proxy 是 GOAL-041/043/044/045 共同的热点文件，本任务与它们修改同一区域时按串行处理；改动前先 `git log` 看 settle 与水位线附近最近的提交。
