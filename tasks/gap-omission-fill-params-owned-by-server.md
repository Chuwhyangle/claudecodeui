---
id: gap-omission-fill-params-owned-by-server
title: 遗漏补发的生产参数改由 server/ 拥有（随构建发布），热改走 voice-realtime-settings，回放工具反向读取
status: ready
labels:
  - gap
  - voice
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-402
---
## Proposal

GOAL-046 的收口任务。后端改动，遵循 `.agents/skills/backend-module-standards/SKILL.md`。

问题：`voice-realtime-ws-proxy.service.ts` 的 `readOmissionFillParams` 每次连接按 `findApplicationRoot` 读 `experiments/voice-relay-qb/omission-fill-params.json`。生产运行时依赖 `experiments/` 目录：文件缺失时生产者静默关闭；改用 `dist-server` 部署时该文件不随构建发布。人 yale 2026-10-18 裁定这不合适。

做法：

1. 新建 `server/modules/voice-realtime/omission-fill-params.json`，只放 `chosen` 块（h_ms、g_ms、score_t、w_min、w_hallu、dom_n、lookback_ms、len_min、numeral_mode、silence_ms），值取自现 `experiments/voice-relay-qb/omission-fill-params.json` 的 `chosen`。服务端用 `import ... with { type: 'json' }` 读取（`server/tsconfig.json` 已开 `resolveJsonModule`，tsc 会随构建发出），**不再按应用根读 experiments/，删除 `readOmissionFillParams` 的文件读取路径**。
2. `voice-realtime-settings.ts` 增加可选键 `omissionFill`（局部覆盖内置默认值）：每连接读一次，已建立连接不变；形状非法（类型不对、`numeral_mode` 不在允许集、H/G 越界）时该连接回退到内置默认值，原因进入 `problems` 并写入连接日志。校验沿用该文件「I/O 失败用默认、形状错误拒绝」的既有规则。
3. `experiments/voice-relay-qb/omission-fill-params.json` 只保留回放门自己的内容：冻结连接清单、阈值、选参理由、基线读数；移除其中的 `chosen`（或改为只读引用）。`replay_rule.py` 从服务端 JSON 读取 `chosen`，新增 `--print-chosen` 打印它；`--check` 与 `--check-labels` 行为与读数不变（47 连接/583 条，丢失 ≥7 字 1.89%）。
4. SPEC「接入方式」第 4 条与「待验证」表更新：参数所有者是 `server/`，热改走 settings。

## AC

- [x] `bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-omission-fill-params-source.test.ts` 退出码 0（即 AC-402）。
- [x] `python3 -I experiments/voice-relay-qb/replay_rule.py --check` 退出码 0。
- [x] `python3 -I experiments/voice-relay-qb/replay_rule.py --check-labels` 退出码 0。
- [x] `bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-omission-fill-wiring.test.ts` 退出码 0（AC-401 的既有用例不回退）。
- [x] `npx tsc --noEmit -p server/tsconfig.json` 退出码 0。

## DoD

在工作目录为临时目录、`experiments/` 不可读的条件下，一条 ws-proxy 连接的日志里 `omission_fill params` 行带出服务端 JSON 的取值且生产者开启；`omissionFill` 的合法覆盖对下一条连接生效、非法覆盖回退默认并留下原因；`replay_rule.py --check` 读到的 `chosen` 来自服务端那份。读数取自测试输出。上线（build/restart :3001）由人工做，不在本任务内。

## Touches

- server/modules/voice-realtime/omission-fill-params.json
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-settings.ts
- server/modules/voice-realtime/voice-realtime-omission-fill.ts
- server/modules/voice-realtime/tests/voice-realtime-omission-fill-params-source.test.ts
- server/modules/voice-realtime/tests/voice-realtime-omission-fill-wiring.test.ts
- server/modules/voice-realtime/tests/voice-realtime-omission-fill.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- experiments/voice-relay-qb/omission-fill-params.json
- experiments/voice-relay-qb/replay_rule.py
- docs/proposals/voice-realtime-omission-fill-SPEC.md
- tasks/gap-omission-fill-params-owned-by-server.md

## Notes

接线测试里原先用 `seams.omissionFillParams` 覆盖参数的用例保持有效；本任务只新增「文件缺失不再关闭生产者」这一侧的断言。服务端 JSON 与 Python 默认值的一致性由 AC-402 (c) 守护。`voice-realtime-omission-fill.test.ts` 与 `quay-test-script.test.ts` 在 Touches 里是因为 `chosen` 搬走/新增测试文件会分别改动它们（前者改读服务端 JSON，后者移动 known/unknown pin），`scripts/suite-duration-baseline.tsv` 为新测试文件追加一行时长。

读数（2026-10-18，worktree）：AC-402 测试 5/5 通过（duration 2340 ms；假形态已验证：删服务端 JSON ⇒ 红，改 chosen 不改 Python 默认 ⇒ `--print-chosen` 退出 2）；`--check` 47 连接/583 条、LOST≥7 1.89%、raw 14.07%、dup 2.23%、p50 5.20s；`--check-labels` 33 命中 / O=20 D=2 / 90.9%；接线测试 5/5；`tsc --noEmit` 0；`quay-test-script.test.ts` 14/14（pin 366-3=363、366-1=365，AC7 地板绿）。
