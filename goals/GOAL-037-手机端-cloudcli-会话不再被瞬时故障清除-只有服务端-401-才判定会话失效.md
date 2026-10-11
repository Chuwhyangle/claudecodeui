---
id: GOAL-037
title: 手机端 CloudCLI 会话不再被瞬时故障清除：只有服务端 401 才判定会话失效
status: achieved
kind: goal
origin: 人 yale 2026-10-10 夜间指令：「过去 24 小时，我多次发现我的手机浏览器 CloudCLI
  身份认证突然失效了必须重新登录。请检查。」并要求按本仓惯例先落 GOAL/AC + 任务（选定「先立 quay 任务」），由 driver 调度
  worker 实现，不在常驻会话里直接改码。
activatedAt: 2026-10-10T16:27:43.039Z
statusLog:
  - at: 2026-10-11T00:20:30.939Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

2026-10-10 夜间诊断（常驻会话，只读）确认：**服务端从未拒绝过该手机的凭证**，被迫重新登录是客户端自己删掉了本地 token。

已排除项与证据：
- **密钥轮换**：cloudflared 隧道日志里取到 4 个真实客户端 JWT（iat 分别 2026-10-06 14:12Z / 10-07 02:06Z / 10-08 12:05Z / 10-10 02:12Z），用当前 `~/.cloudcli/auth.db` 的 `app_config.jwt_secret`（`server/modules/database/repositories/app-config.ts:45`）**全部验签通过**。
- **服务端拒绝**：近 30h `server.log` 中 `Token verification failed` = 0、`WebSocket token verification failed` = 0；2378 次 WS 握手 2373 次成功，5 次失败全是不带 token 的 `/ws`（探针流量）。`server/modules/auth/auth.middleware.ts:63-70` 的 user-not-found 分支确实无日志，但它要求 users 行消失——那样连登录都进不去，与「重新登录即可恢复」不符。
- **令牌到期**：TTL 固定 `7d`（`server/modules/auth/auth.middleware.ts:113`，部署包 `dist-server` 一致），且过半衰期自动续签（同文件 `:72-80` 的 `X-Refreshed-Token` 与 `POST /api/auth/refresh`）。
- **当次事件的服务端/隧道抖动**：23:47 那次登录前后（21:00:06 之后）服务无重启、隧道零 origin 失败。
- **Service Worker**：`public/sw.js` 对 `/api/`、`/ws` 直接放行、导航请求不缓存。

缺陷在客户端（部署包 `dist/assets/index-C8Ao2Yg1.js` 与源码一致）：`src/modules/auth/context/AuthContext.tsx:271-284` 把 `GET /api/auth/user` 的**任何**非 2xx（含网关 502/503/504）以及「2xx 但响应体不是预期 JSON」（运营商劫持页/代理 HTML）都当作会话失效，经 `notifySessionLapsed()` → `clearSession()` 删掉 `localStorage['auth-token']` 并弹登录页。只有 401 才代表会话失效。

放大它的环境事实：24h 内服务被主动重启 10 次（另 1 次 V8 堆崩溃，2026-10-09 21:36 systemd 自动重启），每次重启都有约 10s 窗口隧道对 `/api/*` 回 5xx（cloudflared 30h 记录 94 次 origin 失败）；手机浏览器「恢复即整页重载」使其启动自检触发频率远高于桌面常驻标签页，另有手机网络特有的劫持页/门户页形态。

## 范围

- 会话失效判定收敛为「服务端明确拒绝」：`GET /api/auth/user` 仅在 401（或等价的 `X-Auth-Error` / `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` 信号）时调用 `notifySessionLapsed()`；其余失败（5xx、网络错误、非 JSON 响应体）保留 token 与会话，只报可恢复的错误，并允许重试。
- 新增前端判据 `src/modules/auth/tests/sessionLapsePolicy.test.tsx`，固定四种响应下的行为，其中 401 一条是正控制（现状行为不得回归）。
- 保持既有契约不破：`e2e/oauth-consent-page.spec.ts` 的 AC3 正控制（确有被拒 token 时出现 "Your session expired. Please log in again."）仍绿。

## 非目标

- 不改服务端令牌 TTL、密钥来源、`authenticateToken` 语义。
- 不新增 `/api/auth/*` 的服务端请求日志或拒绝原因日志（本次诊断困难正因这条缺口，但它属于可观测性、机制不同，若要做请单独立项）。
- 不改 OAuth 授权页的措辞/分组（归 `gap-oauth-consent-flow-ux-hardening`，已 done）。
- 不处理「浏览器站点数据被清空」这一类纯客户端存储丢失（无法从服务端验证，另行人工排查）。

## 退出条件

1. `src/modules/auth/context/AuthContext.tsx` 的启动自检只在服务端明确拒绝（401 / `X-Auth-Error` / `AUTH_TOKEN_*`）时判定会话失效；5xx、网络失败、与「2xx 但响应体不是预期 JSON」一律保留 `localStorage['auth-token']` 与会话，并有界重试。覆盖：AC-325。
2. 新判据 `src/modules/auth/tests/sessionLapsePolicy.test.tsx` 的四种响应形态（401 正控制、5xx、200+HTML、fetch reject）逐条绿，`npx vitest run` 该文件退出 0。覆盖：AC-325。
3. 真实浏览器 + 真实服务端 + 真实 JWT 的落地证据（`e2e/session-lapse-transient.spec.ts`）：把 `/api/auth/user` 顶成 502 后重载仍处已登录态；换成服务端真会拒的 token 后重载出现 session-expired 横幅。覆盖：AC-328。
4. 既有判据一字不改：`e2e/oauth-consent-page.spec.ts` 的 AC3 正控制（存有被服务端拒绝的 token 时出现 session-expired 横幅）仍绿；`src/shared/api.ts` 的 `X-Auth-Error` → 登出路径语义不变（AC-329 只给它带上 reason 字段）。覆盖：AC-325。
5. 反例成立：把判定改回「任意非 2xx 即 lapse」⇒ 5xx 与 200+HTML 两条用例红，恢复后回绿。覆盖：AC-325。
6. `npm run typecheck` 退出 0；该任务 fan-in 到 develop 之后 `quay goal gate AC-325` 退出 0。
7. 客户端不再用本地时钟判定会话失效：`getStoredAuthToken()` 与 WS 构造不再因本地 `exp` 删除 token 或登出（现状 `src/shared/authToken.ts:81-88`、`src/shared/context/WebSocketContext.tsx:63-66`），token 只在服务端 401 时经 `expireAuthSession()` 移除；真过期仍登出并出现 session-expired 横幅（正控制）；客户端把「为何丢弃」（含修复后不应再出现的 `local-clock` 支）写成 breadcrumb 并随下一次 `POST /api/auth/login` 上报，`[AuthReq]` 行打出 `lapse=`/`exp=`/`clientNow=`/`skew=`。覆盖：AC-329。

> **软点登记（人 yale 2026-10-11 裁定）**：`## 范围` 第 1 条「其余失败…只报可恢复的错误」由 AC-325 **间接保证**（其 (ii)(iii)(iv) 三条已固定 token/user 保留且不出现 session-expired 文案），**明示不单独作为退出条件**——不新增 AC 来抬这条 UI 提示细节。

## 已知限制

- 本 goal 只收**客户端失效判据**这一支。手机端「浏览器清空站点数据 / 换了 origin」无法从服务端验证：2026-10-11 的现场确认已把它排除（出横幅时本地仍有 token，且主题/语言/草稿未复位），但若日后以另一种形态再现，仍需人工从手机侧排查。
- `/api/auth/*` 没有请求日志这一可观测性缺口不属本 goal，另立 `gap-auth-surface-request-log`。
- 生产 `~/.cloudcli/auth.db` 上的 observer 探针残留不属本 goal，另立 `gap-observer-token-residue-on-live-auth-db`。
