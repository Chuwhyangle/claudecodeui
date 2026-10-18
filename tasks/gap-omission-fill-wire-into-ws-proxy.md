---
id: gap-omission-fill-wire-into-ws-proxy
title: ws-proxy 接入遗漏补发：取代 settle producer 的丢话兜底触发，补发写日志，并关闭 interrupt_response
status: ready
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

- [x] `bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-omission-fill-wiring.test.ts` 退出码 0（即 AC-401）。5/5 pass，读数见 Notes。
- [x] 既有 `server/modules/voice-realtime/tests/voice-realtime-ws-proxy*.test.ts` 中与 settle、MODEL_TEXT_REPLY、忙等待相关的用例退出码 0（逐个文件单跑，不得做无界多文件 fan-out）；与 settle 触发语义直接冲突的旧断言按新契约改写，并在 Notes 逐条列出改了哪条、为什么。`voice-realtime-ws-proxy.protocol-simulation.test.ts` 24/24、`voice-realtime-ws-proxy.real-transport.test.ts` 13/13。
- [x] `npx tsc --noEmit -p server/tsconfig.json` 退出码 0。

## DoD

用脚本化 bridge 与假时钟，在测试里读到：被模型覆盖的转写在 2500 ms 后不再有识别原文投递；始终未被覆盖的 ≥7 字转写在 `T_i` 恰好投递一次，且日志里有对应 `omission_fill` 记录；`session.update` 的 `turn_detection` 带 `interrupt_response:false`。读数取自测试输出。上线（build/restart :3001）由人工做，不在本任务内。

## Touches

- server/index.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/voice-realtime-log.ts
- server/modules/voice-realtime/tests/voice-realtime-omission-fill-wiring.test.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
- server/modules/voice-realtime/tests/voice-realtime-turn-detection.test.ts
- server/modules/voice-realtime/tests/voice-realtime-manual-vad-session-update.test.ts
- server/modules/voice-realtime/tests/voice-realtime-diagnose.test.ts
- server/modules/voice-realtime/tests/voice-realtime-log.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-omission-fill-wire-into-ws-proxy.md

## Notes

ws-proxy 是 GOAL-041/043/044/045 共同的热点文件，本任务与它们修改同一区域时按串行处理；改动前先 `git log` 看 settle 与水位线附近最近的提交。

### 实现要点

- **参数唯一正本**：每连接从 `experiments/voice-relay-qb/omission-fill-params.json` 的 `chosen` 读取并校验（缺失/畸形即记录 `omission_fill disabled (...)` 并关闭生产者，不猜默认值）；参数行 `omission_fill params {json}` 在连接早期写入日志，后续每条候选决策写 `omission_fill {json}`。seam `omissionFillParams` 仅用于测试缩窗（partial 合并到 locked 值上）或 `null` 关闭（与规则无关的用例不被打扰）。
- **求值**：登记三类输入（final 转写、executed model message、`speech_started`）后重算 `planOmissionFills`，只在 `dueAt` 到期时补发；已决策的 index 只决一次。同一 `dueAt` 的多条按 index 合并为一条消息，经 `proceedRelay`（忙等待/合并/字节上限/水位线）投递；不同 `dueAt` 的到期组串行投递（发送路径单飞）。
- **execed 的判定**：`session_send`/`session_interrupt` 在 executor 入口登记为 M（被 `turn_detected` 截断的调用根本到不了 executor，符合纯函数模块的输入契约）。`MODEL_TEXT_REPLY` 的逐字净投递与补发自身都走 `relaySessionSend`/`proceedRelay`，不登记为 M。
- **与旧语义的冲突处理（SPEC 接入方式第 3 条）**：
  - `transcribedSinceWatermark` 的"已听到"记账保留，但它不再被 settle 定时器消费；`MODEL_TEXT_REPLY` 净投递某条 final 时，同时以 `reason:"text-reply"` 关闭 planner 的对应候选，避免规则在 `T_i` 再投一次。
  - 一次实际执行的 `session_interrupt` 关闭它已处置的候选（`reason:"stop"`，X-5「stop 后不得再有投递」）。旧版靠 settle 的 span 消费实现；新规则下没有 span 消费，因此在 stop 成功路径显式关闭。
  - `claimOutstandingCommits` / `committedCoveredByResponse` 只保留给 `MODEL_TEXT_REPLY` 净使用；planner 仍看到全部 final（`registerOmissionFinal` 在该分支之前执行）。
  - 删除了 `VOICE_SPAN_SETTLE_MS`、`armSettleWindow`、`settleHeardSpan`、`heardSpanText`、`settleTimer`、`settleMs` seam，以及 barrel 的 `VOICE_SPAN_SETTLE_MS` 导出；`server/index.ts` 的对应说明改成 GOAL-046。

### 旧断言改写（AC2 要求逐条列出）

1. `voice-realtime-ws-proxy.protocol-simulation.test.ts`
   - `AC2 replay 57279cc1`：去掉 `settleMs: 60_000`，改为 rule v2 的 covered 读数（同一句由模型消息覆盖，补发不再投递），并新增 `omission_fill reason=covered` 的日志断言。原因：settle 的"任意响应即消费 span"被 rule v2 的覆盖率判定取代。
   - `AC2 replay 764f0c7a`：`settleMs: 40` → `omissionFillParams: { hMs: 240, gMs: 50, silenceMs: 57 }`；期望的 5 条投递顺序不变（3 条未被覆盖的 final 在各自 `T_i` 补发），因为这段 journal 恰好是"被覆盖的两句 + 未覆盖的三句"。原因：触发方式从 settle 截止时间改为 planner 的 `T_i`。
   - `AC2 replay 3d2d3b2c`：`settleMs: 40` → 同一组缩窗参数，并断言 `reason=covered`。原因：旧测试断言"响应整体即交付"；rule v2 下这条仍成立，但依据是覆盖率 ≥ 0.25（实测该修复句覆盖了误听句），必须把依据钉在 planner 上。
   - `settle boundary waits for the upstream turn…`（AC-361）：改写为 rule v2 的 `speech_started inside S` 用例——final 后 6 ms 用户再次开口，S=60 ms 时不得在 t+S 投递，`T_i=t+H=240 ms` 时才投递一次。原因：新规则没有 settle 定时器，`speech_started` 只通过 planner 的沉默分支改变 `T_i`。
   - `settle boundary closes after the upstream turn ends…`：删除，替换为 `a stop closes the candidates it disposed of`——stop 之后不再有补发，对应 X-5/AC-361 的"stop 后不得投递"，在新规则下由 stop 路径显式关闭候选实现。
   - `a model response inside the window is the delivery…`：删除；其断言已由 57279cc1/3d2d3b2c 两个 covered 用例覆盖（同一语义，且新用例还钉住了日志原因）。
   - 该文件的 `wireConnection` 默认把 `omissionFillParams` 设为 `null`（关闭生产者），避免与本任务无关的用例被 3 s 后的补发干扰；只有上述规则用例传入缩窗参数。
2. `voice-realtime-scripted-scenarios.test.ts`（leg B）
   - `settleMs: 40 / 60_000` 全部替换为 `omissionFillParams`（短窗或长窗）；`ContinuousOptions` 的字段与注释同步改写。
   - `leg B`（两个 silent turn）：期望仍是 `[PHANTOM_A, PHANTOM_B]`，但触发点改为各自的 `T_i`；用例名与注释改为 omission-fill 规则。
   - `leg B shape preserved`（模型响应覆盖）：期望 `[PHANTOM_A_REWRITTEN]` 不变；依据从 settle 的"响应即消费"改为 rule v2 的覆盖率（实测该改写句覆盖原句）。
   - `late` 臂（MODEL_TEXT_REPLY 净）：期望仍为两条各一次；新增的实现保证净投递会关闭 planner 候选，避免 `T_i` 再补一次。
3. wire-shape 钉子（`interrupt_response:false` 进入每个 `session.update`）
   - `voice-realtime-turn-detection.test.ts`：`DEFAULT_WIRE`/`DEFAULT_ON_WIRE` 与显式 deepEqual 期望加入该字段（byte-identical 断言按新 wire 字节更新）。
   - `voice-realtime-manual-vad-session-update.test.ts`：连续模式的 `turn_detection` deepEqual 期望改为 `RESOLVED_TURN_DETECTION_ON_WIRE`（新增常量）；AC1 false form 仍能证明"去掉 switch spread 后默认检测器回到线上"（composer 是对组合结果加字段，不遮蔽该变异）。
   - `voice-realtime-diagnose.test.ts`：两处帧断言加入该字段。
   - `voice-realtime-log.test.ts`：新增 `omission_fill params` 与两条候选记录的分类断言。

### 读数（测试输出）

- 新 wiring 测试 5/5：
  - covered final 在 2500 ms（假时钟）后仍只有模型那一条投递，日志 `{"i":0,"reason":"covered"}`；参数行读到 `hMs=12000, silenceMs=3000, scoreT=0.25, wMin=7, numeralMode=runs2`。
  - 未覆盖的 7 字 final：2999 ms 无投递，3000 ms 恰好一条；日志 `{"i":0,"dueAt":1760000003000,"coverage":0,"reason":"fill"}`；再推进 5000 ms 仍只有一条。
  - 短句 `我想想`：`reason=weight`，无投递。
  - 同一时刻到期的两句：一条消息，顺序为先说的在前。
  - `session.update`（首次与后续）与 `session.turn_detection` 的 `turn_detection` 均带 `interrupt_response:false`；segmented 的 `null` 保持 `null`。
- 全 `server/modules/voice-realtime/tests/voice-realtime-*.test.ts`（clamped `--test-concurrency=4`）：705/705 pass。
- `npx tsc --noEmit -p server/tsconfig.json`：退出码 0。

### 套件计数钉子（2026-10-18 重测）

- 本任务新增 `server/modules/voice-realtime/tests/voice-realtime-omission-fill-wiring.test.ts`，`scripts/test.sh` 收集的 server 测试文件数 364 → 365；`server/shared/tests/quay-test-script.test.ts` 的 AC2/AC3 读数相应改为 `unknown=362` / `unknown=364`。merge develop 后实测 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` = 365，AC2/AC3 单跑均绿。

## Blocker

**2026-10-18T09:39:38.611Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=75004 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1792316053008
- run_id：wk-prod-anchor
- session_id：ae76c5c9-ba04-45e5-8a49-993094d3e5d5
