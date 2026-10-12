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

- [x] AC1（取假形态排最前）：在服务端临时注入一次到外部主机（如 `example.com:443`）的连接 ⇒ 回放正向腿红并打印目标主机（逐字行记入 Notes），随后撤回注入。
- [x] AC2：守卫自测：非回环 connect/DNS 被记录并拒绝，回环连接放行（测试命令与结果写入 Notes）。
- [x] AC3：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1` 退出 0；外连 0 的断言在其中。
- [x] AC4：回归——`e2e/voice-realtime-live-session-send.spec.ts`、`e2e/voice-realtime-scripted-scenarios.spec.ts` 单跑结果与改前一致（守卫不误伤）；`npm run typecheck`、`npm run lint` 退出 0。

## DoD

一次完整回放的 egress.jsonl（应为空）与浏览器非本地请求计数写入 Notes；零云调用。

## Touches

- e2e/support/egress-guard.mjs (new)
- playwright.config.ts
- e2e/voice-realtime-segmented-replay-20261012.spec.ts
- tasks/gap-live-voice-replay-local-egress-guard.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-360，建议 (6)）。实现前先确认 `e2e/support/` 是否已存在、以及 playwright testMatch 不会收集 `.mjs` 守卫文件；如需换位置，同步本 Touches。

### 落地（2026-10-12，worktree `gap-live-voice-replay-local-egress-guard`）

`e2e/support/` 原不存在（新建）；`playwright.config.ts` 的 `testDir: './e2e'` + 默认 `testMatch` 只收 `*.spec.ts`，`egress-guard.mjs` 不会被当作 spec 收集（`--list` 实测 15 tests，与改前 14 条 + 新正向腿一致）。

- **`e2e/support/egress-guard.mjs`（新）**：`--import` 预加载。钩住 `net.connect` / `net.createConnection` / `net.Socket.prototype.connect` / `tls.connect`，以及 `dns.*` 与 `dns.promises.*` 的解析族。非回环目标 → 追加一行 JSON `{at, via, target, frame}`（`frame` = 除本模块外的首个调用栈帧）到 `QUAY_E2E_EGRESS_GUARD_LOG`，并以 `ECONNREFUSED` 拒绝（socket 下一个 tick destroy）。undici 的 TCP/TLS 连接器走同一批 `net`/`tls` 入口，无需单独的 undici 钩子。安装时 **创建**（不截断）日志文件——文件「存在且为空」是「守卫在跑且无外连」，文件缺失则是「守卫没加载」，避免把空读当成真空绿。守卫仅在 `QUAY_E2E_EGRESS_GUARD_LOG` 非空时生效（守卫自身也不 import `node:http`，确保 http agent 绑定到已打补丁的 `net`）。
- **`playwright.config.ts`**：新增 `voiceRealtimeEgressLog = <dataDir>/egress.jsonl` 与 `egressGuardModule`；voice realtime 选择下发布 `process.env.QUAY_E2E_VOICE_REALTIME_EGRESS_LOG`（给 spec 进程），并在该选择的 webServer env 里加 `QUAY_E2E_EGRESS_GUARD_LOG: <同上>` 与追加式 `NODE_OPTIONS: ... --import file:///<repo>/e2e/support/egress-guard.mjs`（追加而非替换，保留 runner 自带预加载）。其他选择的服务端逐字节不变。
- **回放 spec**：新增 `CHROME_HOSTS` 白名单（`fonts.googleapis.com` / `fonts.gstatic.com` / `api.github.com`，与兄弟 spec 同形）与 `isLoopbackUrl`；在 `browser.newContext(...)` 之后立刻 `context.route('**')`——回环放行，非回环 abort 并记进 `recording.browserEgress`。新增正向腿（现第 686 行）断言：spec 进程拿到的 `QUAY_E2E_VOICE_REALTIME_EGRESS_LOG` 非空；`egress.jsonl` **存在**（守卫确实加载过）；其内容 `=== []`；`browserEgress.length > 0`（非真空）；白名单外的 host 集合 `=== []`；两分支 `authorizationHeaderSeen === false`；config 源里该选择含 `DASHSCOPE_API_KEY: ''` 与 `DEBUG_AGENT: '1'`，且本 spec 在 `DEBUG_AGENT_SPEC_FILES` 列表内；行为读数——debug-agent 场景引擎的 seed 文案确在屏上（真 `claude` 不会这么答）。并 `console.log` 一行浏览器非本地请求计数（DoD 要的是数，不是「> 0」的推断）。

### 取证（每条 AC 的读数）

**AC1（取假形态，排最前）** — 在 `server/index.ts` 顶层（`const server = http.createServer(app);` 之后）临时注入
`http.get({ host: 'example.com', port: 443, path: '/ac1-local-egress-probe' }, r => r.resume()).on('error', () => {})`，跑
`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1`（日志 `egress-guard-evidence/ac1-voice-realtime-segmented-replay-20261012.log`）：**exit 1，1 failed / 14 passed**，唯一红的就是正向腿（:686），其失败消息逐字为

```
Error: the server dialled out of the loopback:
{"at":"2026-10-12T11:23:56.862Z","via":"net.createConnection","target":"example.com:443","frame":"at Agent.createConnection (node:_http_agent:311:16)"}
```

注入随后**已撤回**：`git diff -- server/index.ts` 为空，`git grep "ac1-local-egress-probe"` 无命中，工作树只剩 spec/config/新增守卫三处改动。

**AC2（守卫自测）** — `node e2e/support/egress-guard.mjs`（Node v24.21.0），**exit 0**：

```
ok - loopback connect is allowed
ok - external net.connect is refused with ECONNREFUSED :: EGRESS BLOCKED: the server tried to reach example.com:443
ok - external dns.lookup is refused :: EGRESS BLOCKED: the server tried to reach example.com
ok - exactly the two external attempts were recorded :: lines=2
ok - each recorded target names example.com :: net.connect:example.com:443 | dns.lookup:example.com
ok - each record carries the first calling frame :: at new Promise (<anonymous>)

self-test: 6/6 passed
```

**AC3（回放绿）** — `DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1`：**15 passed (1.3m)，exit 0**（日志 `egress-guard-evidence/ac3-*.log` 与 `ac3b-*.log`，两次都绿；外连 0 的断言即 :686 那条）。

**AC4（回归）** —
- `e2e/voice-realtime-live-session-send.spec.ts`：**4 passed (21.0s)，exit 0**（改前基线 4 passed / 20.6s）。
- `e2e/voice-realtime-scripted-scenarios.spec.ts`：**11 passed (1.5m)，exit 0**（改前基线 11 passed / 1.5m）。
- `npm run typecheck`：**exit 0**（tsc 过 tsconfig.json + server/tsconfig.json + scripts/tsconfig.json）。
- `npm run lint`：**exit 0**（oxlint，仅既有 warning）。

守卫不误伤：上述两个 spec 都不在 voice realtime 选择里，其服务端没有 `QUAY_E2E_EGRESS_GUARD_LOG`，守卫全程未安装。

**DoD** —
- 一次完整回放的 `egress.jsonl`：**存在且为 0 字节**（ac3 run `<dataDir>/quay-e2e-IWQ7Av/egress.jsonl`、ac3b run `quay-e2e-127goG/egress.jsonl` 均 0 字节）——守卫在跑、服务端一次外连都没有。
- 浏览器非本地请求计数：**20**，host 集合 `{api.github.com, fonts.googleapis.com}`，全部在 `CHROME_HOSTS` 白名单内，**白名单外 0**。该行由正向腿打印：`[egress] browser non-local requests: 20 (api.github.com, fonts.googleapis.com)`。
- 零云调用：服务端 0 外连、浏览器非本地请求全部 abort 且白名单外为 0、上游拨号无 authorization 头、`DASHSCOPE_API_KEY` 为空、provider 为 debug-agent 场景引擎（seed 文案在屏）。

证据目录（仓外）：`/data/home/yale/work/egress-guard-evidence/`。
