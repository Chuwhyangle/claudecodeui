---
id: gap-omission-fill-pure-module-and-parity
title: 遗漏补发规则 v2 的服务端纯函数 planOmissionFills，及与 Python 参考实现的逐例一致性夹具
status: todo
labels:
  - gap
  - voice
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-omission-fill-sweep-and-lock-params
goal_ac: AC-400
---
## Proposal

GOAL-046 第二个任务。依赖任务 `gap-omission-fill-sweep-and-lock-params`（参数与规则细节在它之后才锁定）。后端改动，遵循 `.agents/skills/backend-module-standards/SKILL.md`。

在 `server/modules/voice-realtime/` 新增纯函数模块（无 I/O、无定时器、无日志）：

```
planOmissionFills(finals, executed, params) → { fills: [{ index, dueAt, coverage }], skipped: [{ index, reason }] }
```

其中 `finals = [{t, text}]`，`executed = [{t, text}]`（仅已执行消息，被取消 response 里的调用由调用方过滤），`params` 取自任务 1 锁定的参数文件（H、G、SCORE_T、权重门槛、数字处理方式）。规则按 SPEC「规则 v2」逐条实现，包含：NFKC 与 casefold、数字删除、拉丁/西里尔/希腊去组合附加符、汉字假名字二元组、其他文字词内字符三元组、权重、主导文字类型、文字不符的幻觉判断、跨文字类型不可比、`T_i` 与覆盖度。`skipped.reason` 要覆盖每条被放过的原因（权重不足、文字不符、已覆盖、跨文字不可比），供任务 3 写日志。

一致性夹具：在 `experiments/voice-relay-qb/replay_rule.py` 加 `--emit-fixture`，从冻结清单里的连接生成 `experiments/voice-relay-qb/fixtures/omission-fill-cases.json`（≥ 40 个用例：转写序列、已执行消息序列、参数、期望补发下标；包含中文、中英混说、以及合成的纯英文与"另一种文字"用例）。TS 测试逐例比较补发下标，必须完全一致；任何一边改规则而另一边没跟上就红。

## AC

- [ ] `bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-omission-fill.test.ts` 退出码 0（即 AC-400）。
- [ ] `npx tsc --noEmit -p server/tsconfig.json` 退出码 0。

## DoD

测试文件包含表驱动用例与一致性用例两组，一致性用例数 ≥ 40，取假形态各一次得到的红色读数（覆盖度比较改成 `>`；让取消的 response 里的调用也算已执行）已在任务备注里贴出；模块只经 voice-realtime 的 barrel 导出，没有被深导入。

## Touches

- server/modules/voice-realtime/voice-realtime-omission-fill.ts
- server/modules/voice-realtime/tests/voice-realtime-omission-fill.test.ts
- server/modules/voice-realtime/index.ts
- experiments/voice-relay-qb/replay_rule.py
- experiments/voice-relay-qb/fixtures/omission-fill-cases.json
- tasks/gap-omission-fill-pure-module-and-parity.md

## Notes

Python 实现是参考；数字处理、文字不符、跨文字不可比这几处最容易两边不一致，夹具里要各有专门用例。
