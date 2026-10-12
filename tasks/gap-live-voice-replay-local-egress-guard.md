---
id: gap-live-voice-replay-local-egress-guard
title: Live Voice 回放本地封闭性守卫：voice realtime 选择下服务端非回环外连/DNS
  记录并拒绝、浏览器非本地请求拦截计数，回放断言外连 0、无 key、无 claude 二进制
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-replay-known-defect-signatures
  - gap-ac352-criterion-harden-against-repo-dotenv
goal_ac: AC-360
---
## Proposal

### 问题

回放现在靠配置保证本地：`playwright.config.ts` 为 voice realtime 选择设 `VOICE_REALTIME_ENDPOINT=ws://127.0.0.1:<port>`、`DASHSCOPE_API_KEY: ''`，debug-agent 代 Claude，本地 `/api/auth/register|login`。但 webServer 环境是 `...process.env` 整份展开（本 shell 带 `DASHSCOPE_API_KEY`、`VOICE_REALTIME_CAPTURE` 等），任何新代码路径（上下文包、换会话预热、遥测、字体/CDN、模型网关）若向外连接，回放不会察觉；「零云调用」目前只由「上游拨号无 authorization 头」一条间接读数支撑。

### 要做的事

- `e2e/support/egress-guard.mjs`（Node `--import` 预加载）：钩住 `net.connect`/`tls.connect`/`dns.lookup`（及 undici 的底层连接），目标不是 127.0.0.1 / ::1 / localhost 时追加一行到 `<本次一次性数据目录>/egress.jsonl`（时间、目标、调用栈首帧）并拒绝（destroy / ECONNREFUSED）。
- `playwright.config.ts`：仅在 voice realtime 选择下给 webServer 加该预加载（NODE_OPTIONS 或命令行）；其他 spec 不受影响。
- 回放 spec：浏览器上下文 `route('**')` 对非本地请求 abort 并计数；正向腿断言服务端 egress.jsonl 为空、浏览器非本地请求为 0、上游拨号无 authorization、服务端 env 的 DASHSCOPE_API_KEY 为空、provider 为 debug-agent（未启动 claude 二进制）。

### SCOPE BOUNDARY

- ⛔ 不改产品代码；⛔ 守卫只用于测试运行。
- 依赖 `gap-live-voice-replay-known-defect-signatures`（串行改回放 spec）。

## Plan

1. 预加载守卫 + 单元自测；2. config 接线；3. 回放正向腿；4. 取假形态；typecheck/lint。

## AC

- [ ] AC1（取假形态排最前）：在服务端临时注入一次到外部主机（如 `example.com:443`）的连接 ⇒ 回放正向腿红并打印目标主机（逐字行记入 Notes），随后撤回注入。
- [ ] AC2：守卫自测：非回环 connect/DNS 被记录并拒绝，回环连接放行（测试命令与结果写入 Notes）。
- [ ] AC3：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1` 退出 0；外连 0 的断言在其中。
- [ ] AC4：回归——`e2e/voice-realtime-live-session-send.spec.ts`、`e2e/voice-realtime-scripted-scenarios.spec.ts` 单跑结果与改前一致（守卫不误伤）；`npm run typecheck`、`npm run lint` 退出 0。

## DoD

一次完整回放的 egress.jsonl（应为空）与浏览器非本地请求计数写入 Notes；零云调用。

## Touches

- e2e/support/egress-guard.mjs (new)
- playwright.config.ts
- e2e/voice-realtime-segmented-replay-20261012.spec.ts
- tasks/gap-live-voice-replay-local-egress-guard.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-360，建议 (6)）。实现前先确认 `e2e/support/` 是否已存在、以及 playwright testMatch 不会收集 `.mjs` 守卫文件；如需换位置，同步本 Touches。
