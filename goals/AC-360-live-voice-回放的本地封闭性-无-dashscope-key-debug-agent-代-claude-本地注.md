---
id: AC-360
title: Live Voice 回放的本地封闭性：无 DASHSCOPE key、debug-agent 代
  Claude、本地注册/登录；服务端与浏览器的任何非回环外连被记录并拒绝，回放断言外连为 0
status: active
kind: criterion
goal: GOAL-043
criterion: f=e2e/support/egress-guard.mjs; [ -f "$f" ] || { echo "缺判据文件：$f" >&2;
  exit 1; }; f=e2e/voice-realtime-segmented-replay-20261012.spec.ts; [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; DASHSCOPE_API_KEY= npx playwright test
  e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1
expect: 读数——(a) voice realtime 选择下 webServer 以 egress 守卫预加载启动：对非
  127.0.0.1/::1/localhost 的 net/tls 连接与 DNS 解析，记录到本次一次性数据目录的 egress.jsonl
  并拒绝（destroy）；(b) 回放的浏览器上下文对非本地请求 route.abort 并计数；(c) 回放正向腿断言：服务端 egress.jsonl
  为空、浏览器非本地请求 0、上游拨号无 authorization 头、DASHSCOPE_API_KEY 为空、未启动 claude
  二进制（debug-agent provider）；单文件 playwright 退出 0。取假形态（任务 Notes
  记录）——在服务端临时发起一次到外部主机的连接 ⇒ 断言红并打印目标主机。守卫只在 voice realtime 选择下启用，不影响其他 spec。
origin: 人 yale 2026-10-12 授权按建议推进「可控、完全本地、不依赖外部 Realtime/Claude 服务的 Live Voice
  验证能力」（Opus 常驻会话只读审查 gap-live-voice-segmented-replay-20261012 落地产物后的建议
  (3)(4)(5)(6)）。
activatedAt: 2026-10-12T09:08:05.250Z
statusLog:
  - at: 2026-10-12T09:08:05.250Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-12T09:08:05.249Z
timeoutMs: 115000
---
