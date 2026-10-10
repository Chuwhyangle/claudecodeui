---
id: gap-session-lapse-only-on-server-401
title: 会话失效判定收敛为只认服务端 401：网关 5xx 与非 JSON 2xx 不再清掉本地会话（手机端被迫重新登录）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-325
---
## Proposal

现状（2026-10-10 复核，行号逐字）：`src/modules/auth/context/AuthContext.tsx:270-284` 的启动自检里

```ts
const userResponse = await api.auth.user();
if (!userResponse.ok) { notifySessionLapsed(); return; }
const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
if (!userPayload?.user) { notifySessionLapsed(); return; }
```

两条出口都调用 `notifySessionLapsed()` → `clearSession()`（同文件 `:139-148`）→ `localStorage.removeItem('auth-token')`（同文件 `:94-96`）。于是 `GET /api/auth/user` 的**任何**非 2xx（含网关 502/503/504）以及「2xx 但响应体不是预期 JSON」（运营商劫持页/反代 HTML）都会把一个**仍然有效**的 7d 会话删掉并弹登录页。会话本体的正常性与本缺陷无关的部分：客户端临期判定 `src/shared/authToken.ts:59-62` 只在 `exp` 真过期时触发，`authenticatedFetch` 的 `X-Auth-Error` 分支 `src/shared/api.ts:67-69` 只由服务端在真的拒绝时被设置——两处都不是本次改动对象。

诊断证据（2026-10-10 夜间，常驻会话只读排查，服务端无责）：cloudflared 隧道日志里 4 个真实客户端 JWT（iat 2026-10-06 14:12Z / 10-07 02:06Z / 10-08 12:05Z / 10-10 02:12Z）用当前 `~/.cloudcli/auth.db` 的 `app_config.jwt_secret`（`server/modules/database/repositories/app-config.ts:45`）全部验签通过；近 30h `server.log` 里 `Token verification failed` 与 `WebSocket token verification failed` 计数均为 0，2378 次 WS 握手 2373 次成功、5 次失败全是不带 token 的 `/ws` 探针流量；TTL 固定 `7d`（`server/modules/auth/auth.middleware.ts:113`）且过半衰期自动续签（同文件 `:72-80`）。同期环境噪声充足：24h 内服务被主动重启 10 次（另 1 次 V8 堆崩溃后 systemd 自动重启），每次重启都有约 10s 窗口隧道对 `/api/*` 回 5xx（cloudflared 在 30h 内记到 94 次 origin 失败）；手机浏览器「恢复即整页重载」使启动自检的触发频率远高于桌面常驻标签页。

修法（只收紧一个判定点，不引入新抽象）：把「会话失效」的判据从「响应不 ok」改为「服务端明确拒绝」——`userResponse.status === 401`（或等价的 `X-Auth-Error` 响应头存在 / 响应体 `code` 属于 `AUTH_TOKEN_INVALID`|`AUTH_TOKEN_EXPIRED`，三者任一即可，取实现最简者，并在 Notes 写明选了哪个判据）。其余一切情况（5xx、无状态码可言的网络失败、2xx 但响应体不是 `{user}`）一律**保留 token 与会话**，只把自检记为「暂时不可用」并允许重试：挂载时失败后应有界退避重试同一自检，服务器恢复即回到已登录态，而不是要人重新输入凭据。401 分支的行为必须与今天逐字一致（移除 token、`user` 置空、报 `errors.sessionExpired` 文案，且该文案的 latch 语义不因重跑被清掉）。

落地证据的启动方式照既有做法（真实服务端 + 隔离数据目录 + 一次性用户，见 `e2e/oauth-consent-page.spec.ts` 的 fixture 与 `e2e/mobile-composer-send-key.spec.ts` 的 `auth-token` 用法），不要新造一套。

非目标：不改服务端 `authenticateToken` 的语义、TTL 与密钥来源；不改 `src/shared/api.ts` 与 `src/shared/authToken.ts`（判定点只此一处）；不改 OAuth 授权页的措辞与分组（属 `gap-oauth-consent-flow-ux-hardening`，已 done）；不新增 `/api/auth/*` 的服务端请求/拒绝日志（可观测性缺口机制不同，另行立项）；不处理「浏览器站点数据被整体清空」这类纯客户端存储丢失。

<!-- dedup-ref -->
去重（按机制，非症状）：`gap-oauth-consent-flow-ux-hardening`（done）引入了 `notifySessionLapsed` 与「有会话才报」的 latch，但它改的是**登录页文案与引导闸门**，对「什么算会话失效」的判据一字未动；`gap-ac261-consent-password-ratelimit-restore`（done）是授权页密码限流。同一文件、另一个机制，保持独立（separate）。merge 候选检查 `task-granularity-advice.js --touches src/modules/auth/context/AuthContext.tsx --touches src/shared/api.ts` 返回 `peers: []`，无同文件的在跑任务。

## AC

- [ ] AC1 红态基线逐字记录：先创建 `src/modules/auth/tests/sessionLapsePolicy.test.tsx` 并运行 `npx vitest run src/modules/auth/tests/sessionLapsePolicy.test.tsx`，把 500/502 与「200 + HTML」两条的逐字红行、命令与退出码写入 Notes（证明现行为就是「非 401 也清会话」），然后再动实现。
- [ ] AC2 401 正控制不得回归：判据断言 401 + `X-Auth-Error: session-expired` 时 `localStorage['auth-token']` 被移除、`useAuth().user` 为 null、登录页出现 "Your session expired. Please log in again."；`npx vitest run src/modules/auth/tests/sessionLapsePolicy.test.tsx` 退出 0，写下 passed/总数。
- [ ] AC3 非 401 不再清会话：判据对三种形态各一条用例——(a) 500/502/503/504、(b) 200 但响应体为 HTML、(c) fetch reject（离线）——各断言 `localStorage['auth-token']` 仍在、`useAuth().user` 仍为原用户、页面不出现 session-expired 文案（改动前 (a)(b) 必红）。
- [ ] AC4 可恢复：判据断言瞬时失败后、服务器恢复 200 的下一次自检回到已登录态（无需重新输入凭据），且期间该 token 从未被从 `localStorage` 移除（断言最终值 + 至少一次中途读数）。
- [ ] AC5 取假形态（先提交实现再变异；逐条记录变异 diff、逐字红行与恢复命令，恢复后重跑回绿）：把判定改回 `if (!userResponse.ok) { notifySessionLapsed(); return; }` ⇒ AC3 的 (a)(b) 用例红。
- [ ] AC6 范围纪律：`git diff develop -- src/shared/api.ts src/shared/authToken.ts e2e/oauth-consent-page.spec.ts` 为空；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）。
- [ ] AC7 落地证据（真实浏览器 + 真实服务端 + 真实 JWT）：`npx playwright test e2e/session-lapse-transient.spec.ts` 单文件运行退出 0，含两条：用真实服务端（隔离数据目录、一次性用户）真登录拿到 JWT 后，把 `/api/auth/user` 用 `page.route` 顶成 502 再重载 ⇒ 仍处已登录态（无登录表单、`localStorage` 仍有 token）；把 token 换成真实服务端会拒的伪造值再重载 ⇒ 登录页出现 session-expired 横幅。两张截图路径写入 Notes。
- [ ] AC8 判据自证与 goal 判据：`quay goal gate AC-325` 退出 0，并写下 `npx vitest run src/modules/auth/tests/sessionLapsePolicy.test.tsx` 的用例数（≥4：四种响应形态 + 401 正控制）。
- [ ] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐，列出实际改动文件清单（不得有未申报文件）。

## DoD

- 真实浏览器（Playwright Chromium）+ 真实服务端（隔离数据目录与一次性用户，不是替身）：真登录 → 真 JWT 落 `localStorage`；把 `/api/auth/user` 顶成 502 后重载，**仍停在已登录界面**（不是登录页）；把 token 换成服务端真会拒的值后重载，登录页与 session-expired 横幅都出现；解除故障后重载仍已登录。两张截图（已登录 / 被拒后的横幅）落在 `artifacts/`。
- 「401 以外的一切失败都不删 `localStorage`」有两层证据：替身层的判据文件 + 真实层的 e2e，不是只测替身。
- 取假形态（AC5）先红后恢复的逐字记录在 Notes。
- 遵守 `$frontend-module-standards` 与 AGENTS.md；无新依赖；测试按 `docs/operations/process-isolation-and-memory-caps.md` 单文件/有界运行，不做无界扇出。

## Touches

- src/modules/auth/context/AuthContext.tsx（会话失效判定收敛为仅服务端 401；非 401 保留 token 与会话并允许重试）
- src/modules/auth/tests/sessionLapsePolicy.test.tsx (new)（新判据：四种响应形态 + 401 正控制）
- e2e/session-lapse-transient.spec.ts (new)（真实浏览器 + 真实服务端 + 真实 JWT 的落地证据）
- tasks/gap-session-lapse-only-on-server-401.md

## 现场确认（人 yale，2026-10-11）

- 现场**出现了**红色的 "Your session expired. Please log in again." 横幅 ⇒ `hadSessionRef` 为真，即那一页启动时 localStorage 里**确实还有** token ⇒ 排除「浏览器清了站点数据」与「换了 origin」（换 origin 会没有 token，登录页只会给中性文案）。
- 同一时刻**主题/语言/草稿都没有复位** ⇒ 站点数据未被清空 ⇒ 是 App 自己删的 `auth-token`（`expireAuthSession`/`clearSession` 只删这一项；prefs 会在下次登录时从服务端重新 hydrate，所以肉眼看不到复位）。
- 结论：唯一存活的机制是 `checkAuthStatus` 的两条 lapse 出口（`src/modules/auth/context/AuthContext.tsx:271-284`）——token 在、服务端不拒（Proposal 已证），而那一次 `GET /api/auth/user` 收到了**非 2xx** 或 **2xx 但响应体非 JSON**。现场无法区分是哪一种（网关 5xx / 运营商或门户代理回 200+HTML），**AC3 的 (a)(b) 两条把两者都覆盖**。
- 时间线旁证：`users.last_login` 在 2026-10-10 15:47:03Z 与 15:51:39Z 各更新一次（本地 23:47、23:51，相隔 4 分钟）；期间服务端未重启（最后一次 21:00:06），隧道该时段只有一条客户端主动 abort（15:51:22Z `/api/session-hosts`）、无 origin 失败——与「客户端删 token」一致，与「服务端拒绝 / 服务宕机」不一致。
- 「200 + HTML」在本仓有自己的成因路径：`server/modules/static-assets/static-assets.module.ts:70` 的 `router.get('*')` 对任何未挂载的 extension-less `/api/*` 路径回 200 + `dist/index.html`（实测见 memory `unmounted-api-route-returns-200-spa-not-404`）。实施时若发现存在 `/api/auth` 未挂载的窗口，按 AC3(b) 处理并在 Notes 写明。
