---
id: GOAL-037
title: 手机端 CloudCLI 会话不再被瞬时故障清除：只有服务端 401 才判定会话失效
status: active
kind: goal
origin: 人 yale 2026-10-10 夜间指令：「过去 24 小时，我多次发现我的手机浏览器 CloudCLI
  身份认证突然失效了必须重新登录。请检查。」并要求按本仓惯例先落 GOAL/AC + 任务（选定「先立 quay 任务」），由 driver 调度
  worker 实现，不在常驻会话里直接改码。
activatedAt: 2026-10-10T16:27:43.039Z
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