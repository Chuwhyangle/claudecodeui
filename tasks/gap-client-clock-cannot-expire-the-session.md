---
id: gap-client-clock-cannot-expire-the-session
title: 客户端不得用本地时钟判定会话失效：token 只由服务端 401 裁定丢弃（并上报「为何丢弃」+ skew），手机时钟快即被登出的根因
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-329
---
## Proposal

现状（2026-10-11，用刚落地的 `[AuthReq]` 请求日志抓到现场）：安卓手机在一次页面启动里连发三条 `GET /api/auth/user -> 401 reason=invalid-token`，而同一窗口内 `Token verification failed`＝0、`Auth rejected: reason=user-not-found`＝0、reason 也不是 `session-expired`——三条 401 全部来自「请求没带凭据」那一支。客户端只在内存 token 非空时才请求该端点，而请求头取的是 localStorage ⇒ 那一刻 localStorage 的 token 已被客户端自己删掉：`getStoredAuthToken()`（`src/shared/authToken.ts:81-88`）在 `isAuthTokenExpired` 为真时先调 `expireAuthSession()` 再返回 null，而 `TOKEN_EXPIRY_SKEW_MS` 只有 60s ⇒ **只要页面时钟比服务端快，客户端就会把服务端仍然接受的 token 判死、删掉并登出**。`src/shared/context/WebSocketContext.tsx:63-66` 是第二处同样的删除点（WS 构造时本地判过期 → `expireAuthSession()` → 返回 null 不连接）。这正是「手机多次被迫重新登录、且每次都是先弹 session-expired 横幅、再出现一条裸 401」的自洽解释。已落地的 AC-325 只覆盖「服务端给了非 401」，不覆盖这一支。

修法（把裁量权交回服务端）：
- `getStoredAuthToken()` 不再因本地 `exp` 删除 token，只返回存储值（没存才返回 null）；WS 构造不再本地判过期登出，照常带 token 去连。真过期时服务端会在 REST 上回 401 `session-expired`，`authenticatedFetch` 的 `X-Auth-Error` 路径照旧登出——WS 那侧不得成为登出触发器（若连接失败，靠既有的 3s 重连与会话清空后的停连收敛，不得自旋）。
- 真过期行为保持逐字不变（正控制）：仍是「token 被移除 + `user` 置空 + session-expired 横幅」，只是改由服务端 401 触发，而不再由本地时钟触发。
- 客户端观测（本次最贵的一课：08:40 的那次现场只能靠旁证反推）：每次「会话被判失效 / 不再持有可用 token」写一条 breadcrumb——`reason` ∈ {`server-401`|`server-expired`|`storage-empty`|`local-clock`}、该 token 的 `exp`、客户端 `now`——到 `localStorage` 与 console，并随**下一次 `POST /api/auth/login`** 的请求体上报（login 只读 username/password，认证判定不变）；服务端在既有 `[AuthReq]` 行增补 `lapse=`/`exp=`/`clientNow=`/`skew=`。`local-clock` 这一支在修复后**不应再出现**，作为回归探测器。绝不落任何凭据。
- 可选（要么实现、要么在 Notes 写明明示不做及理由）：用响应的 `Date` 头修正本地的排程偏移（`getAuthTokenRefreshDelay` 用本地时钟排 refresh 只影响提前/推后，不决定生死，故非必需）。

非目标：不改 TTL、`jwt_secret`、`authenticateToken` 的判定语义与响应形状；不新增 HTTP 端点；不动既有两个判据文件的任何断言（`src/modules/auth/tests/sessionLapsePolicy.test.tsx` 与 `e2e/session-lapse-transient.spec.ts` 逐字不改仍须绿——两者的 token 都是活 `exp`，不依赖本地删除）；不处理「浏览器清空站点数据 / 换了 origin」那一支。

> **现场更正（人 yale，2026-10-11）**：手机时钟为 NTP 正常（UTC+8）⇒ 本次现场**不是**时钟偏移造成的误判。本任务的动机因此收窄为两条仍然成立的事实：(1) 客户端对自己的本地判定握有**终审权**（先删 token 再发请求），使服务端只看到一条裸 `invalid-token` 401，真相不可见；(2) 「真过期」与「被同源另一页面实例 / 存储丢失移除」这两条成因目前**无法区分**——breadcrumb + `skew=` 上报正是为它们而加。时钟偏移作为一条**潜在**（本次未发生）的误判路径仍随本修复一并消失，判据的 (a)(i)/(a)(ii) 因此用前移时钟构造最坏情形。

<!-- dedup-ref -->
去重（按机制）：`gap-session-lapse-only-on-server-401`（done）收敛的是**服务端非 401 的答复**，且明文把 `src/shared/authToken.ts` 排除在它的 Touches 之外；本任务是**本地时钟的预删权**，同一 goal 下的另一支，保持独立（separate）。AC-328（achieved）读 e2e 落地证据、AC-325（achieved）读单元判据，均不读本支。merge 候选检查 `task-granularity-advice.js --touches src/shared/authToken.ts --touches src/shared/context/WebSocketContext.tsx --touches src/modules/auth/context/AuthContext.tsx` 返回 `peers: []`。

## AC

- [ ] AC1 红态基线逐字记录（先写判据、改动前运行）：`npx vitest run src/modules/auth/tests/clientClockCannotExpireSession.test.tsx` 退出码 1，且红行落在「本地时钟不再有删除权」那两条上——(i) 存有一枚按页面时钟已过 `exp` 的 token 时 `localStorage['auth-token']` 被删成 null（现值）、(ii) 同一情形下 WS 构造返回 null。把命令、退出码与两条逐字红行写入 Notes。
- [ ] AC2 本地时钟不再有删除权：判据在**前移的页面时钟**下断言 `getStoredAuthToken()` 返回该 token、`localStorage` 仍持有它、且**未派发** `AUTH_SESSION_EXPIRED_EVENT`；WS 构造出的 URL 仍带该 token；该请求确实带上了凭据（不是先被客户端丢掉）。`npx vitest run` 该文件退出 0，写下 passed/总数。
- [ ] AC3 正控制（真过期仍必须登出）：判据断言服务端以 401 + `X-Auth-Error: session-expired` 回答时，token 被移除、`useAuth().user` 为 null、出现 "Your session expired. Please log in again."，且此路径**确实**派发了 `AUTH_SESSION_EXPIRED_EVENT`。
- [ ] AC4 丢弃原因可观测：判据断言 breadthcrumb 的四个字段（reason/exp/now/at）在四种触发下各自正确；`local-clock` 在修复后的判定路径里不再产生；对 breadcrumb 全文与上报内容做「无凭据」断言——把本次用到的 token 全文、其签名段、以及测试用的密码字面量逐一 `grep -F`，全部零命中。
- [ ] AC5 服务端读数：`server/modules/auth/auth-request-log.service.ts` 的 `[AuthReq]` 行在 login 请求携带上报时打出 `lapse=`/`exp=`/`clientNow=`/`skew=`（`skew` = 客户端 now − 服务端 now）；就地扩展 `server/modules/auth/tests/auth-request-log.test.ts`（**不新增 server 测试文件**，以免动计数 pin），单文件 `npx tsx --tsconfig server/tsconfig.json --test server/modules/auth/tests/auth-request-log.test.ts` 退出 0。
- [ ] AC6 取假形态（**先 commit 实现再变异**，逐条记录变异 diff、逐字红行与恢复命令）：把 `getStoredAuthToken()` 的本地删除分支恢复（以及在第二次变异里恢复 WS 的本地登出）⇒ AC2 的 (i)/(ii) 分别红；恢复后重跑回绿。
- [ ] AC7 既有判据不被削弱：`git diff develop -- src/modules/auth/tests/sessionLapsePolicy.test.tsx e2e/session-lapse-transient.spec.ts e2e/oauth-consent-page.spec.ts` 为空，且三者单文件运行仍绿（各自写下命令与 passed/总数）；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）。
- [ ] AC8 落地证据（真实浏览器 + 真实服务端 + 真 JWT + **前移的页面时钟**）：`npx playwright test e2e/client-clock-skew-session.spec.ts` 单文件退出 0，两条腿——(i) 页面时钟前移 ≥8 天后重载 ⇒ 仍处已登录态、WS 真连上、`localStorage['auth-token']` 未变（此腿在改动前必红：落到登录页）；(ii) 正控制：token 换成服务端真会拒的伪造值 ⇒ 登录页 + session-expired 横幅。两张截图路径写入 Notes。
- [ ] AC9 诊断通道端到端跑通：同一次带时钟偏移的运行之后，`server.log` 中能逐字读到该 `[AuthReq] POST /api/auth/login` 行的 `skew=` 非零读数（把该行逐字贴进 Notes）——即「下次不必再靠旁证推断」的落地读数。
- [ ] AC10 `quay goal gate AC-329` 退出 0；`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐，列出实际改动文件清单（不得有未申报文件）。

## DoD

- 真实浏览器 + 真实服务端 + 真 JWT，页面时钟前移 ≥8 天：改动前落到登录页（并有 session-expired 横幅），改动后仍停在已登录态并连上 WS——即把 2026-10-11 现场那台手机的形态在真实对象上复现并翻绿。
- 诊断通道是**真跑过**的：带偏移的登录之后能在 `server.log` 里读到 `skew=` 非零，`lapse=` 取值正确；`local-clock` 支不再出现（回归探测器）。
- breadcrumb 与上报**无凭据**，且该不变式写在判据里（不是手工跑一次）。
- 取假形态先红后恢复的逐字记录在 Notes（先 commit 再变异，避免用 `git checkout` 还原时把未提交的实现删掉）。
- 遵守 `$frontend-module-standards`（src/ 四个文件）与 `$backend-module-standards`（server/ 两个文件）与 AGENTS.md；无新依赖；测试单文件/有界运行。

## Touches

- src/shared/authToken.ts（`getStoredAuthToken()` 去掉本地时钟删除权；`expireAuthSession` 带上 reason 并写 breadcrumb）
- src/shared/context/WebSocketContext.tsx（WS 构造不再本地判过期登出；不成为登出触发器）
- src/modules/auth/context/AuthContext.tsx（lapse 只由服务端拒绝触发；横幅语义不变；把 reason 交给 breadcrumb）
- src/shared/api.ts（`X-Auth-Error` 路径给 `expireAuthSession` 带上 `server-401`/`server-expired` 的 reason）
- server/modules/auth/auth.routes.ts（login 请求体接受并透出 lapse 上报；认证判定只读 username/password，不变）
- server/modules/auth/auth-request-log.service.ts（`[AuthReq]` 行增补 `lapse=`/`exp=`/`clientNow=`/`skew=`，仍不落任何凭据）
- src/modules/auth/tests/clientClockCannotExpireSession.test.tsx (new)（本判据文件；前移时钟下的四条断言 + 无凭据断言）
- e2e/client-clock-skew-session.spec.ts (new)（真实浏览器 + 真实服务端 + 前移时钟的落地证据与正控制）
- server/modules/auth/tests/auth-request-log.test.ts（就地扩展断言新字段；不新增 server 测试文件）
- tasks/gap-client-clock-cannot-expire-the-session.md
