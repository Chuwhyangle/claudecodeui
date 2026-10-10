---
id: gap-auth-surface-request-log
title: /api/auth/* 可观测性：补每请求一行（含拒绝原因与来源）且 user-not-found 不再静默——本次事故无法事后判定的根因
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状（2026-10-11 复核）：`/api/auth/*` **没有任何请求日志**。`server/modules/auth/auth.middleware.ts` 的四条拒绝出口里，no-token（`:51-57`）、expired（`:85-91`）、bad-signature（`:93-102`）各有一条 warn 或明确响应，而 **user-not-found（`:63-70`）既不打日志也不留在日志里的任何痕迹**——它只回 401 + `X-Auth-Error: invalid-token`。于是 2026-10-10 夜间那次「手机端反复被迫重新登录」只能靠 `docker logs <cloudflared>` 里失败请求的 `dest=` URL（含 `/ws?token=<JWT>`）反推，而**无法回答「服务端到底拒没拒、以什么理由拒」**——本次排查是靠「隧道日志里的真 JWT 用当前 `jwt_secret` 验签通过」+「全日志零 `Token verification failed`」两条旁证才排除服务端的。

对照面已有正本：OAuth/MCP 面有 `server/modules/oauth/oauth-request-log.service.ts`（`[OAuthReq] <method> <path-without-query> -> <status> … ip= ua=`，由 `server/index.ts:1047-1054` 按路径数组挂载，且明确「never reads or prints」密码/code/refresh/access token）。本任务把同一形状复用到 auth 面，不新造词汇表。

修法：新增 `server/modules/auth/auth-request-log.service.ts` 的 `createAuthRequestLogger()`（一段 `res.on('finish')`，输出 method、去掉 query 的 path、status、`X-Auth-Error` 值或响应体 `code`、`cf-connecting-ip`/`remoteAddress`、ua，**绝不落 Authorization/query token/密码/请求体**），并在 `server/index.ts` 以 `'/api/auth'` 前缀挂载；同时给 `auth.middleware.ts:63-70` 的 user-not-found 分支补一条 warn（拒绝原因 + path + ip + ua，不带 token）。auth 面请求稀疏，每请求一行不构成量级问题。

非目标：不改任何认证判定语义、TTL、密钥来源与响应形状（只加观测）；不给整个 `/api/*` 加访问日志（只 auth 面）；不做日志轮转或采样；不打印任何凭证材料。

<!-- dedup-ref -->
去重（按机制）：`gap-oauth-consent-spa-backend-contract`（done）交付的是 **OAuth/MCP 面**的请求日志，本任务补的是 **auth 面**这一块缺口，两面路径与拒绝原因不同，保持独立。`gap-session-lapse-only-on-server-401`（todo）修的是**客户端失效判据**（行为），本任务修的是**可观测性**（证据），机制不同、可并行。merge 候选检查 `task-granularity-advice.js --touches server/index.ts --touches server/modules/auth/auth.middleware.ts …` 返回 `peers: []`。

## AC

- [x] AC1 红态基线逐字记录（改动前）：起一个真实服务端隔离实例（隔离 `DATABASE_PATH` + 一次性用户），用「合法签名但 userId 不存在」的 token 请求 `GET /api/auth/user`，在 `server.log` 上 `grep` 该请求 ⇒ **零行**（现状：user-not-found 静默）。写下命令、退出码与逐字读数。
- [x] AC2 每请求一行：同一隔离实例上跑五种形态——(a) 无 token、(b) 有效 token（200）、(c) 过期 token、(d) 伪造签名 token、(e) user-not-found token——每种在日志中各产出一行，含 method、去掉 query 的 path、status、拒绝原因（`X-Auth-Error` 或 body `code`）、ip、ua。
- [x] AC3 无秘密不变式：对 AC2 产出的全部日志行断言**不含**任何凭证材料——把该次请求实际用过的每个 token 全文、`Bearer ` 之后的串、以及密码字面量逐一送入 `grep -F`，全部零命中；并把该断言写进判据文件（不只是手工跑一次）。
- [x] AC4 user-not-found 不再静默：`auth.middleware.ts:63-70` 分支产出至少一条 warn（含 reason 与 path），由判据断言。
- [x] AC5 新判据落 `server/modules/auth/tests/auth-request-log.test.ts`（新文件），用注入的 log sink 断言行的形状与 AC3 的无秘密不变式；**新增 server 测试文件必须同步 bump `server/shared/tests/quay-test-script.test.ts` 的两处计数 pin**（2026-10-11 读数：`:154` `known=3 unknown=278`、`:203` `known=1 unknown=280`；执行时以该文件当时的实际读数为准），否则 suite 以 UNATTRIBUTABLE 红。
- [x] AC6 取假形态（先提交实现再变异，逐条记录变异 diff、逐字红行与恢复命令）：把 logger 的挂载前缀从 `'/api/auth'` 改成不匹配的值（或删掉挂载）⇒ AC2 的五条断言红；恢复后回绿。
- [x] AC7 既有判据不改仍绿：`server/modules/auth/tests/auth.service.test.ts` 与任何引用 `auth.middleware` 的既有判据逐字不改、单文件运行退出 0；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）。
- [x] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐，列出实际改动文件清单（不得有未申报文件）。

## DoD

- 真实服务端（隔离数据目录、一次性用户，不是替身）上跑一次真实请求序列（含真实 401/403 与 200），把产出的日志行**逐字**贴进 Notes，并做一次「只看日志就能回答」的走查：给定一条 user-not-found 拒绝，从日志行读出它命中的 path、status、来源 ip 与 ua，不需要改代码或加临时打印。
- 无秘密是可复核的：AC3 的 grep 断言在判据文件里，且是**请求真实凭据材料**（不是断言「不存在某个我编的串」）。
- 计数 pin（AC5）已同步，`npm run test:server` 中 `quay-test-script.test.ts` 单文件运行退出 0。
- 遵守 `$backend-module-standards` 与 AGENTS.md；无新依赖；测试单文件/有界运行（`docs/operations/process-isolation-and-memory-caps.md`）。

## Touches

- server/modules/auth/auth-request-log.service.ts (new)（形状照 server/modules/oauth/oauth-request-log.service.ts；只读 method/path/status/reason/ip/ua）
- server/modules/auth/auth.middleware.ts（auth.middleware.ts:63-70 的 user-not-found 分支补一条 warn；认证判定语义逐字不变）
- server/modules/auth/index.ts（导出 createAuthRequestLogger，供 server/index.ts 经 barrel 取用；只加一行 re-export，认证语义不变）
- server/modules/auth/tests/auth-request-log.test.ts (new)（新判据；同时是新增 server 测试文件的来源，务必同步计数 pin）
- server/shared/tests/quay-test-script.test.ts（bump :154 与 :203 两处 known/unknown 计数）
- server/index.ts（在 '/api/auth' 前缀挂载 logger）
- tasks/gap-auth-surface-request-log.md

## Notes

### AC1 红态基线（改动前，真实隔离实例）
起真实服务端：`DATABASE_PATH=<tmp>/auth.db JWT_SECRET=red-baseline-secret SERVER_PORT=4599 HOST=127.0.0.1 CLAUDE_SESSION_SCOPE_SWEEP=off tsx --tsconfig server/tsconfig.json server/index.ts > server.log 2>&1 &`；等 `CloudCLI Server - Ready`；用「合法签名、userId=999999」的 token 请求 `GET /api/auth/user`；再 `grep -c "/api/auth/user" server.log`。
逐字读数（未改动的 develop 代码）：
```
响应体: {"error":"Invalid token. User not found.","code":"AUTH_TOKEN_INVALID"}
http=401
响应头: X-Auth-Error: invalid-token
grep -c "/api/auth/user" server.log  ->  0        (退出码 1)
grep -n "/api/auth/user" server.log  ->  (ZERO LINES)
```
即：改动前 user-not-found 完全静默，日志无法回答「服务端拒没拒」。改动后同一请求在日志里有一行（见 AC2）。

### AC2 + DoD 真实服务端请求序列（隔离 `DATABASE_PATH` + 一次性用户 probe）
五种形态加注册 200/403 与 SSE `?token=` 形态，逐字 `[AuthReq]` 行：
```
[AuthReq] POST /api/auth/register -> 200 reason=- 211ms ip=203.0.113.7 ua="real-probe/1.0"
[AuthReq] POST /api/auth/register -> 403 reason=AUTH_USER_ALREADY_CONFIGURED 1ms ip=203.0.113.7 ua="real-probe/1.0"
[AuthReq] GET /api/auth/user -> 401 reason=invalid-token 1ms ip=203.0.113.7 ua="real-probe/1.0"
[AuthReq] GET /api/auth/user -> 200 reason=- 1ms ip=203.0.113.7 ua="real-probe/1.0"
[AuthReq] GET /api/auth/user -> 401 reason=session-expired 1ms ip=203.0.113.7 ua="real-probe/1.0"
[AuthReq] GET /api/auth/user -> 401 reason=invalid-token 0ms ip=203.0.113.7 ua="real-probe/1.0"
[AuthReq] GET /api/auth/user -> 401 reason=invalid-token 0ms ip=203.0.113.7 ua="real-probe/1.0"
[AuthReq] GET /api/auth/user -> 401 reason=invalid-token 1ms ip=203.0.113.7 ua="real-probe/1.0"
```
第 3–8 行依次：无 token(401)、有效 token(200)、过期(401)、伪造签名(401)、user-not-found(401)、同一 GHOST token 走 `?token=` query(401)。query 被去掉，故第 8 行 path 仍是 `/api/auth/user`；403 走的是 server 的 AppError 信封 `error.code`（无 `X-Auth-Error`），reason 仍被读出。

同一次运行的 AC4 warn（逐字）：
```
Auth rejected: reason=user-not-found path=/api/auth/user ip=203.0.113.7 ua="real-probe/1.0"
```

「只看日志就能回答」走查：对 GHOST token 的拒绝，`[AuthReq]` 行直接给出 path=`/api/auth/user`、status=`401`、reason=`invalid-token`、ip=`203.0.113.7`、ua=`real-probe/1.0`；更精确的 `reason=user-not-found` 由同 path/ip/ua 的 warn 行给出——无需改代码或加临时打印。

### AC3 无秘密（真实服务端 + 判据）
真实服务端上对本次实际用过的 4 个 token 全文与登录体密码字面量 `grep -aF -c`，全部零命中：
```
hits=0  VALID     token 全文
hits=0  EXPIRED   token 全文
hits=0  FORGED    token 全文
hits=0  GHOST     token 全文（含 ?token=<GHOST> 那次请求）
hits=0  密码字面量 real-probe-password-123（register body 与 login body）
```
判据文件内的断言（`server/modules/auth/tests/auth-request-log.test.ts` 的 AC3 用例）对四个**真实签名** token 的全文、payload 段、signature 段、`header.payload` 前缀逐一 `assert.ok(!everything.includes(...))`，并对登录体密码断言，且断言任何行不含 `token=`（query 被丢弃）。

### AC5 计数 pin
新增 `server/modules/auth/tests/auth-request-log.test.ts` 后收集到 **282** 个 server 测试文件（原 281，+1）。`server/shared/tests/quay-test-script.test.ts` 两处 pin 改为 `known=3 unknown=279`（`:154`）、`known=1 unknown=281`（`:203`）。该文件单文件运行 **11 pass / 0 fail / exit 0**（含 AC2/AC3/AC7 三处 pin 断言）。

### AC6 取假形态（先提交实现 f52a198e，再变异）
变异 diff（判据内 logger 的挂载前缀改成不匹配值）：
```
-  app.use('/api/auth', createAuthRequestLogger({ log: (line) => lines.push(line) }));
+  app.use('/api/auth-MISMATCH', createAuthRequestLogger({ log: (line) => lines.push(line) }));
```
逐字红行（AC2 五条断言中的首条 `assert.equal(lines.length, 5)`）：
```
✖ AC2: the five auth outcomes each leave one line with path, status, reason, ip and ua
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  0 !== 5
      at server/modules/auth/tests/auth-request-log.test.ts:167:12
```
同轮红：AC2 回退用例（`0 !== 2`）、AC3 的 `lines.length` 断言、前缀 404 用例；AC4 仍绿（其机制是中间件的 `console.warn`，与 logger 挂载无关——正是两半相互独立的证据）。恢复命令：`git checkout -- server/modules/auth/tests/auth-request-log.test.ts`；恢复后 **5 pass / 0 fail / exit 0**。

### AC7 既有判据与静态检查
- `server/modules/auth/tests/auth.service.test.ts`（逐字未改）单文件并入运行：3 pass / exit 0。
- 引用 `authenticateToken` 的既有判据 `server/modules/voice/tests/voice-config.routes.test.ts`（逐字未改）：6 pass / exit 0。
- `npm run typecheck` → **exit 0**。
- `npm run lint` → **exit 0**，`: error ` 计数 = **0**（输出只有既有 warning）。

### AC8 实际改动文件（`git diff --stat develop...HEAD`）
```
 server/index.ts                                    |   6 +
 server/modules/auth/auth-request-log.service.ts    |  76 ++++++
 server/modules/auth/auth.middleware.ts             |   8 +
 server/modules/auth/index.ts                       |   5 +
 server/modules/auth/tests/auth-request-log.test.ts | 262 +++++++++++++++++++++
 server/shared/tests/quay-test-script.test.ts       |   4 +-
 6 files changed, 359 insertions(+), 2 deletions(-)
```
逐条对齐 `## Touches`（含补报的 `server/modules/auth/index.ts` barrel re-export）：无未申报文件。
