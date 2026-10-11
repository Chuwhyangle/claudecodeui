---
id: gap-cached-refreshed-token-cannot-downgrade-the-session
title: 每次刷新必登出的根因：/api/* 可被浏览器缓存且客户端无条件接受旧 X-Refreshed-Token（已本机复现：一次 boot 两次把 2
  天前的 token 写回 localStorage）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-330
---
## Proposal

现状（2026-10-11 本机复现，真实服务端 + 真实 Chromium + 真 JWT，非推断）：**每次刷新页面都必然被登出**，成因是浏览器 HTTP 缓存把一枚**旧的** `X-Refreshed-Token` 反复喂回客户端，客户端无条件把它写回 localStorage，从而把刚登录得到的新 token 覆盖成旧的。

三段读数（都可复跑）：
1. `/api/*` 响应只有 `ETag`，**没有** `Cache-Control`、**没有** `Vary` ⇒ 带凭证的响应会被浏览器存下来，且缓存键不含身份。
2. `fetch('/api/projects', { cache: 'only-if-cached', mode: 'same-origin', headers: { Authorization: 'Bearer <observer token>' } })` ⇒ **200**（缓存命中），且取回的是**另一会话（`username=yale`）**的项目列表 —— 同一缓存会对不同会话回放别人的响应体。
3. 给 localStorage 种入一枚新 token 后 reload，一次 boot 里捕获到**两次** `localStorage.setItem('auth-token', …)`，写进去的都是**2 天前**那枚 yale token（`iat=1791509357`、`exp=1792114157`），调用栈落在 `authenticatedFetch` 的续签分支（`src/shared/api.ts:66-69`）：

```js
fetch(e,{...t,headers:{...r,...t.headers}}).then(a=>{
  const s=a.headers.get("X-Refreshed-Token");
  return s && I2(s),                    // ← storeAuthToken(s)：无条件、不比较新旧
  a.headers.get("X-Auth-Error") && hg(), a})
```

于是：缓存里那枚 token 过期之前，你每次刷新都被"续签"回同一枚旧 token（看似正常）；**那枚 token 一过 `exp`，客户端本地判过期就删掉它、发出不带凭证的请求**，服务端回 `401 reason=invalid-token`，登录页出现，你重新登录 —— 而**下一次刷新又从缓存取回同一枚已过期的 token**，循环成立。这解释了本次现场的全部特征：反复 `401 reason=invalid-token` + `login->200`、`reason=session-expired` 计数为 0（过期 token 从未被发出）、桌面上不炸（长驻标签页不 reload，缓存条目没被回放）、「清站点数据」能暂时缓解（缓存条目被清掉）。

修法（两层，缺一层仍可复发）：
- **服务端（治因）**：`/api/*` 一律不可缓存 —— 在 `server/index.ts:744` 的 `/api` 挂载处加一个中间件，给所有 API 响应设 `Cache-Control: no-store`（并相应处理 `Vary`，使带凭证的响应不可能被跨会话回放）。注意与该仓既有约束一致：`compression` 只挂在静态资源侧、`/api/*` 的流式（SSE、TTS 音频）不得被缓冲（见 `server/modules/static-assets/static-assets.module.ts` 的头注释）。
- **客户端（防复发）**：`authenticatedFetch` 收到 `X-Refreshed-Token` 时**只在它比本地这枚更新**（比较 `iat`）且形状合法时才 `storeAuthToken`；更旧/同刻/不可解析的一律丢弃，并留一条可观测读数（与 AC-329 的 breadcrumb 同一处，别另造一套）。正常续签（服务端发来更新的一枚）必须照旧写入并派发 `AUTH_TOKEN_REFRESHED_EVENT`——这是正控制，不许被"永不接受"式实现削掉。

非目标：不改 TTL／`jwt_secret`／`authenticateToken` 判定语义；不新增端点；不改静态资源（HTML/哈希资源）既有的缓存策略；不动 `dist` 里已缓存的旧资源（`immutable` 是对的）；不处理 AC-329 那一支（本地时钟删除权）。

<!-- dedup-ref -->
去重（按机制）：`gap-client-clock-cannot-expire-the-session`（ready）管的是「客户端用本地时钟判定会话失效」这一支；本任务管的是「缓存的旧续签 token 把会话降级」——两条独立机制、独立验收（任一条单独修好都不能止住本症状）。二者 Touches 有重叠（`src/shared/api.ts`、`src/shared/authToken.ts`），会被调度器串行化；实现时请把「iat 单调性」与「lapse reason」两处改动放在同一文件的不同函数里，别互相覆盖。`gap-voice-realtime-uplink-audio-capture` 亦触及 `server/index.ts`，同样串行。AC-325/AC-328/AC-329 都不读本支。merge 候选检查 `task-granularity-advice.js --touches server/index.ts --touches src/shared/api.ts --touches src/shared/authToken.ts` 返回的 peers 即上面两条（separate 决定：机制不同、验收独立，且对方已 ready）。

## AC

- [ ] AC1 红态基线逐字记录（改动前）：写下三项读数——(i) `curl -sS -D- -o /dev/null http://127.0.0.1:3001/api/projects` 的响应头里没有 `Cache-Control`；(ii) 真实 Chromium 里 `fetch('/api/projects', {cache:'only-if-cached', …})` 返回 200（缓存命中）；(iii) 「种入新 token → reload」后 `localStorage['auth-token']` 被换成 `iat` 更早的一枚（把两枚 token 解码出的 `iat` 逐字写上，不写 token 本体）。命令、退出码、逐字读数入 Notes。
- [ ] AC2 服务端不可缓存：`/api/*` 的响应带 `Cache-Control: no-store`（`Vary` 处理按实现选定并写明理由），由**已存在**的 `server/modules/static-assets/tests/static-assets.test.ts` 就地增断言固定（不新增 server 测试文件、不动 `quay-test-script.test.ts` 的计数 pin）；`npx tsx --tsconfig server/tsconfig.json --test server/modules/static-assets/tests/static-assets.test.ts` 单文件退出 0。
- [ ] AC3 缓存不再回放：重跑 AC1 的 (ii) ⇒ `only-if-cached` 不再命中（非 200 或抛错，逐字记录）；且流式端点仍不被缓冲（拿一个 SSE/TTS 端点做一次真实读取，证明响应仍是流式的、未被 `compression` 缓冲）。
- [ ] AC4 客户端单调性：新判据 `src/modules/auth/tests/staleRefreshedTokenCannotDowngradeSession.test.tsx` 用替身 fetch 构造四种续签头——更旧（`iat` 小于本地）、同刻、不可解析（非 JWT）、更新——断言只有第四种改变 `localStorage['auth-token']`，前三种逐字不变；`npx vitest run` 该文件退出 0，写下 passed/总数。
- [ ] AC5 正控制（不得削弱正常续签）：更新的一枚必须被写入到 `localStorage` **且**派发 `AUTH_TOKEN_REFRESHED_EVENT`（既有行为不变），由判据断言。
- [ ] AC6 取假形态（先 commit 实现再变异；逐条记录变异 diff、逐字红行与恢复命令）：(i) 去掉服务端 `no-store` ⇒ AC2/AC3 红；(ii) 去掉客户端 `iat` 单调性 ⇒ AC4 红；(iii) 把单调性写成「永不接受续签」⇒ AC5 红。各自恢复后回绿。
- [ ] AC7 落地证据（真实浏览器 + 真实服务端 + 真 JWT）：`npx playwright test e2e/stale-refreshed-token-replay.spec.ts` 单文件退出 0，两条腿——(i) 用 `page.route` 给一次已认证请求回放一个**旧的** `X-Refreshed-Token` 头 ⇒ 本地 token 逐字不变、页面仍已登录；(ii) 回放一个**更新的** `X-Refreshed-Token` ⇒ 本地 token 更新且事件派发（正控制）。两张截图路径写入 Notes。
- [ ] AC8 范围纪律：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`git diff develop -- src/modules/static-assets/static-assets.module.ts` 为空（静态资源策略不动）；`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐，列出实际改动文件清单（不得有未申报文件）。
- [ ] AC9 `quay goal gate AC-330` 退出 0。

## DoD

- 用本任务 AC1 的复现脚本在**真实浏览器 + 真实服务端**上再跑一遍：修复前「种入新 token → reload ⇒ 被换成更旧的一枚、且缓存可回放别人的项目列表」，修复后「storage 保持、`only-if-cached` 不命中」——即把用户报的「每次刷新都要重登」的成因在真实对象上复现并翻绿，而不是只写单测。
- 证明这条链路真的断了两处：服务端头（AC2/AC3 的真实读数）+ 客户端单调性（AC4/AC5/AC7），缺任一层都要在 Notes 写明为什么仍然安全（若真删掉一层，须解释并保留可观测读数）。
- 反例先红后恢复逐字记录在 Notes（先 commit 再变异，避免 `git checkout` 还原时删掉未提交实现）。
- 遵守 `$frontend-module-standards`（src/ 两个文件）与 `$backend-module-standards`（server/ 两个文件）与 AGENTS.md；无新依赖；测试单文件/有界运行。

## Touches

- src/shared/api.ts（`X-Refreshed-Token` 只在比本地更新且形状合法时写入；丢弃旧/同刻/不可解析并留可观测读数）
- src/shared/authToken.ts（提供读 `iat` 的纯函数供单调性比较；`storeAuthToken` 的对外语义不变）
- server/index.ts（在 `/api` 挂载处加 `Cache-Control: no-store` 中间件；不改流式与 compression 的既有顺序约束）
- server/modules/static-assets/tests/static-assets.test.ts（就地增断言：`/api/*` 响应不可缓存）
- src/modules/auth/tests/staleRefreshedTokenCannotDowngradeSession.test.tsx (new)（本判据文件：四种续签头 + 正控制）
- e2e/stale-refreshed-token-replay.spec.ts (new)（真实浏览器 + 真实服务端：旧头回放不得降级、新头必须生效）
- tasks/gap-cached-refreshed-token-cannot-downgrade-the-session.md
