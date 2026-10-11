---
id: AC-330
title: 缓存的旧 X-Refreshed-Token 不得降级会话：/api/* 一律不可缓存，且客户端只接受更新的续签 token
status: active
kind: criterion
goal: GOAL-037
criterion: f=src/modules/auth/tests/staleRefreshedTokenCannotDowngradeSession.test.tsx;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx vitest run "$f" && npx
  tsx --tsconfig server/tsconfig.json --test
  server/modules/static-assets/tests/static-assets.test.ts
expect: |-
  读数：(a) 现状（2026-10-11 本机复现：真实服务端 + 真实 Chromium + 真 JWT）：`curl -D-` 显示 `/api/auth/status|user` 只有 `ETag`、**无** `Cache-Control`、**无** `Vary`；`fetch(path,{cache:'only-if-cached',mode:'same-origin',headers:{Authorization:...}})` 对 `/api/projects` 返回 **200**（缓存命中），且以 `observer-…` subject 认证取回的是**另一会话（username=yale）**的项目列表；在一次页面 boot 中捕获到**两次** `localStorage.setItem('auth-token', …)`，写进去的都是**2 天前**那枚 yale token（`iat=1791509357`，`exp=1792114157`），调用栈指向 `authenticatedFetch` 的 `X-Refreshed-Token` 分支（`src/shared/api.ts:66-69` 的无条件 `storeAuthToken`）。⇒ 每次刷新都把旧 token 装回本地，直到缓存条目里那枚 token 过期 ⇒ **每次刷新都被登出**；服务端侧 `reason=session-expired` 计数为 0（过期 token 在客户端就被删掉、从未发出），这正是本次现场（`401 reason=invalid-token` 反复 + `login->200`）的成因。
  (b) 服务端姿态：`/api/*` 响应带 `Cache-Control: no-store`（并相应处理 `Vary`），由**已存在**的 `server/modules/static-assets/tests/static-assets.test.ts` 就地增断言固定（不新增 server 测试文件、不动计数 pin）；重跑复现脚本 ⇒ `only-if-cached` 对 `/api/projects` 不再命中。
  (c) 客户端单调性：`authenticatedFetch` 只在响应头里的续签 token **比本地这枚更新**（比较 `iat`）且形状合法时才写入；更旧/同刻/不可解析的一律丢弃并留一条可观测读数。判据文件用替身 fetch 构造「旧 token 的响应头」断言本地 token 逐字不变。
  (d) 正控制（不得削弱正常续签）：服务端发来**更新**的一枚 ⇒ 客户端必须写入到 `localStorage` 并派发 `AUTH_TOKEN_REFRESHED_EVENT`（既有行为不变）。
  (e) 反例：去掉服务端 no-store ⇒ (b) 红；去掉客户端 `iat` 单调性 ⇒ (c) 红；把单调性写成「永不接受续签」⇒ (d) 红。恢复后各自回绿。
  (f) 范围：不改 TTL、`jwt_secret`、`authenticateToken` 判定语义；不引入新依赖；`/api/*` 的流式（SSE/TTS）响应不得因此被缓冲（no-store 与 `compression` 的挂载顺序按 `server/modules/static-assets/static-assets.module.ts` 头注释的既有约束处理）。
origin: 人 yale 2026-10-11：「我现在的问题是每次刷新页面都要重新登录。」本会话据此在真实服务端 + 真实 Chromium
  上复现并定位：客户端每次 boot 都从**浏览器 HTTP 缓存**里取回一枚 2 天前的
  `X-Refreshed-Token`（`authenticatedFetch` 无条件写回 localStorage），把刚登录得到的新 token
  覆盖成旧的；等缓存里那枚 token 过期，每次刷新就必然重登。同时实测到同一缓存还会把另一会话的 `/api/projects` 响应体喂给当前会话（无
  `Vary`/无 `Cache-Control`），故一并立案。
activatedAt: 2026-10-11T01:14:04.541Z
statusLog:
  - at: 2026-10-11T01:14:04.541Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-11T01:14:04.541Z
---
