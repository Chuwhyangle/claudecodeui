---
id: AC-402
title: 遗漏补发的生产参数由 server/ 拥有并随构建发布，运行时不读 experiments/；回放工具反向读取它
status: active
kind: criterion
goal: GOAL-046
criterion: bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json
  --test
  server/modules/voice-realtime/tests/voice-realtime-omission-fill-params-source.test.ts
expect: 退出码 0，测试文件存在。断言：(a) 在工作目录切到一个不含 experiments/ 的临时目录、且
  experiments/voice-relay-qb/omission-fill-params.json 不可读的条件下启动一条 ws-proxy
  连接，连接日志的 `omission_fill params` 行带出与
  server/modules/voice-realtime/omission-fill-params.json 的 chosen
  块逐项相同的取值，补发生产者保持开启（不得因找不到文件而关闭）；(b) voice-realtime-settings 的可选键
  `omissionFill` 覆盖内置默认值：合法的局部覆盖对下一条连接生效且已建立的连接不变；形状非法（类型不对、数字处理方式不在允许集、H 或 G
  越界）时该连接回退到内置默认值，原因进入 settings 的 problems 并写入连接日志；(c) 一致性：`python3 -I
  experiments/voice-relay-qb/replay_rule.py --print-chosen` 打印的 chosen 与服务端 JSON
  的 chosen 逐项相同，且 `replay_rule.py --check` 与 `--check-labels` 仍退出
  0（回放读取的是服务端那份）；(d) 构建产物中该 JSON 随 tsc 一并发出（以 tsc 的 `resolveJsonModule` 输出到
  dist-server.next 为准，测试不得靠 experiments/ 兜底）。取假形态：删去服务端 JSON、或让 ws-proxy 回到按应用根读
  experiments/，(a) 必须变红；改动服务端 JSON 的任一 chosen 值而不改 Python 默认，(c) 必须变红。⚠️
  当前必红：服务端 JSON、settings 键、--print-chosen 与测试文件均不存在。
origin: 人 yale 2026-10-18 同意：生产在运行时依赖 experiments/ 目录显然不合适。现状：ws-proxy 的
  readOmissionFillParams 每次连接按 findApplicationRoot 读
  experiments/voice-relay-qb/omission-fill-params.json，文件缺失时生产者静默关闭；若改用
  dist-server 部署，该文件不随构建发布。方案：参数所有权移到 server/（随 tsc 发出），回放工具反向读取；热改沿用既有
  voice-realtime-settings 的按连接读取机制。
activatedAt: 2026-10-18T10:13:46.585Z
---
