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

- [x] AC1 红态基线逐字记录：先创建 `src/modules/auth/tests/sessionLapsePolicy.test.tsx` 并运行 `npx vitest run src/modules/auth/tests/sessionLapsePolicy.test.tsx`，把 500/502 与「200 + HTML」两条的逐字红行、命令与退出码写入 Notes（证明现行为就是「非 401 也清会话」），然后再动实现。
- [x] AC2 401 正控制不得回归：判据断言 401 + `X-Auth-Error: session-expired` 时 `localStorage['auth-token']` 被移除、`useAuth().user` 为 null、登录页出现 "Your session expired. Please log in again."；`npx vitest run src/modules/auth/tests/sessionLapsePolicy.test.tsx` 退出 0，写下 passed/总数。
- [x] AC3 非 401 不再清会话：判据对三种形态各一条用例——(a) 500/502/503/504、(b) 200 但响应体为 HTML、(c) fetch reject（离线）——各断言 `localStorage['auth-token']` 仍在、`useAuth().user` 仍为原用户、页面不出现 session-expired 文案（改动前 (a)(b) 必红）。
- [x] AC4 可恢复：判据断言瞬时失败后、服务器恢复 200 的下一次自检回到已登录态（无需重新输入凭据），且期间该 token 从未被从 `localStorage` 移除（断言最终值 + 至少一次中途读数）。
- [x] AC5 取假形态（先提交实现再变异；逐条记录变异 diff、逐字红行与恢复命令，恢复后重跑回绿）：把判定改回 `if (!userResponse.ok) { notifySessionLapsed(); return; }` ⇒ AC3 的 (a)(b) 用例红。
- [x] AC6 范围纪律：`git diff develop -- src/shared/api.ts src/shared/authToken.ts e2e/oauth-consent-page.spec.ts` 为空；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）。
- [x] AC7 落地证据（真实浏览器 + 真实服务端 + 真实 JWT）：`npx playwright test e2e/session-lapse-transient.spec.ts` 单文件运行退出 0，含两条：用真实服务端（隔离数据目录、一次性用户）真登录拿到 JWT 后，把 `/api/auth/user` 用 `page.route` 顶成 502 再重载 ⇒ 仍处已登录态（无登录表单、`localStorage` 仍有 token）；把 token 换成真实服务端会拒的伪造值再重载 ⇒ 登录页出现 session-expired 横幅。两张截图路径写入 Notes。
- [x] AC8 判据自证与 goal 判据：`quay goal gate AC-325` 退出 0，并写下 `npx vitest run src/modules/auth/tests/sessionLapsePolicy.test.tsx` 的用例数（≥4：四种响应形态 + 401 正控制）。
- [x] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐，列出实际改动文件清单（不得有未申报文件）。

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

## Notes

### 实现（commit f30cf7e5，`src/modules/auth/context/AuthContext.tsx`）

「会话失效」的判据由「响应不 ok」收敛为**服务端明确拒绝**：`userResponse.status === 401`（Proposal 给出的三种等价形态取实现最简者）。其余一切失败——网关 5xx、2xx 但响应体不是 `{ user }`（反代/门户 HTML）、fetch reject——一律**保留 token 与会话**，只把自检记为暂时不可用，并**有界退避重试同一自检**（基数 `AUTH_STATUS_RETRY_BASE_MS=500`、每次 ×2、上限 `AUTH_STATUS_RETRY_MAX_MS=30_000`）。`authStatusRunRef` 让被取代的 run 或被卸载的 provider 停止重试；`userRef` 决定失败后是否放行 `isLoading`——已有用户在屏（长驻标签页）就继续运行，尚无用户（冷启动）就维持判定闸门，而不是给出一个 stored token 并不支持的登录表单。

401 分支行为与改动前逐字一致：`notifySessionLapsed()` → `clearSession()`（移除 `auth-token`、`user` 置空）→ `hadSessionRef` 为真时报 `errors.sessionExpired`。该文案是 latch（`sessionExpiredNotifiedRef`），不被重跑清掉——清会话本身会触发重跑（effect 依赖 `checkAuthStatus`，其依赖 `token`），`!token` 分支因此**不**清 error；只有显式 login/register 才 retire latch。

### AC1 红态基线（先红后改）

命令：`npx vitest run src/modules/auth/tests/sessionLapsePolicy.test.tsx`（改动前，只创建判据文件）。退出码 **1**。

    Test Files  1 failed (1)
         Tests  7 failed | 1 passed (8)
      Duration  12.28s (transform 2.40s, setup 60ms, collect 3.68s, tests 8.12s, environment 209ms, prepare 74ms)

500/502/503/504 四条同形，逐字红行落在 `src/modules/auth/tests/sessionLapsePolicy.test.tsx:211`：

    FAIL  src/modules/auth/tests/sessionLapsePolicy.test.tsx > a 502 keeps the signed-in user and the stored token
    AssertionError: Expected values to be strictly equal:
    + actual - expected

    + null
    - 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3OTE2NTA2MjIsImV4cCI6MTc5MTY1MTIyMiwic3ViIjoicHJvYmUtNSJ9.signature'

    ❯ src/modules/auth/tests/sessionLapsePolicy.test.tsx:211:12
        211|     assert.equal(localStorage.getItem('auth-token'), rotated);

（即：改动前，一个 502 就把 `localStorage['auth-token']` 删成 null。）

「200 + HTML」逐字红行落在同文件 `:227`：

    FAIL  src/modules/auth/tests/sessionLapsePolicy.test.tsx > a 2xx whose body is HTML keeps the signed-in user and the stored token
    AssertionError: Expected values to be strictly equal:

    'true' !== 'false'

    Expected: "false"
    Received: "true"

    ❯ src/modules/auth/tests/sessionLapsePolicy.test.tsx:227:10
        227|   assert.equal(probeText('probe-loading'), 'false');

另两条也红（同因）：`a dropped connection ...` 与 `a transient failure ...` 都停在 `ok(userCalls >= N)` 的 timeout（改动前失败即清 token，自检不再重试，所以既不重发也不恢复）。唯一绿的是 401 正控制。

### AC2 401 正控制不得回归

同文件、改动后重跑退出码 **0**：

    Test Files  1 passed (1)
         Tests  8 passed (8)

`a 401 still lapses the session, drops the token and shows the banner` ✓ 48ms：响应 401 + `X-Auth-Error: session-expired` ⇒ `localStorage['auth-token']` 为 null、`useAuth().user` 为 null、页面出现 "Your session expired. Please log in again."（真实翻译资源，非 stub `t`）。

### AC3 非 401 不再清会话 + 判据选择

(a) 500 / 502 / 503 / 504 各一条、(b) 200 但响应体为 HTML 一条、(c) fetch reject（离线）一条；每条断言 `localStorage['auth-token']` 仍为旋转后的 token、`useAuth().user` 仍为 alice、`probe-loading` 为 false、页面不出现 session-expired 文案。三条都以「同一自检至少重读 3 次」为先决读数（`waitFor(() => assert.ok(userCalls >= 3))`）：只清会话的实现**不会**发出第 2 次请求，因此这个先决读数是「保留了 token 且重试了同一读」的直接证据。

判据取 `userResponse.status === 401`——Proposal 列出的三种等价形态里实现最简者（`X-Auth-Error` 头与响应体 `code` 都要多一次解析，而 `authenticatedFetch` 已经在任何 `X-Auth-Error` 上触发 `expireAuthSession()`，这里只须认状态码）。

关于「2xx + HTML」的成因：`server/modules/static-assets/static-assets.module.ts:70` 的 `router.get('*')` 对**未挂载**的 extension-less `/api/*` 回 200 + `dist/index.html`；`/api/auth/user` 本身是已挂载路由，所以这条路径只在真被反代/门户劫持时出现，属 AC3(b) 覆盖的形态，未另立实现分支。

### AC4 可恢复

`a transient failure retries the same self-check and returns to the signed-in state` ✓ 1508ms：瞬时失败期间 `tokenSeenByAttempt[1] === token`（**中途读数**：第 2 次请求发出时 token 仍在），随后服务恢复 `userMode='success'` ⇒ `waitForUser('alice')` 回到已登录态，`localStorage['auth-token']` 仍为该 token、`probe-loading` 转 false。重试期间（尚无用户）`probe-loading` 保持 true——即维持判定闸门，不弹登录表单。三次尝试发生在 t≈0 / 0.5s / 1.5s（基数 500ms、×2）。

### AC5 取假形态（先提交实现再变异）

变异 diff（`/tmp/ac5-mutation.diff`，2072 bytes；把两处判定还原成改动前的形态）：

    -        if (userResponse.status === 401) {
    -          // ... (401 语义注释)
    +        if (!userResponse.ok) {
    +          // MUTATION (AC5): the pre-fix criterion, restored on purpose.
               notifySessionLapsed();
               finish();
               return;
             }
         
             const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
    -        if (userResponse.ok && userPayload?.user) {
    -          setUser(userPayload.user);
    -          await checkOnboardingStatus();
    +        if (!userPayload?.user) {
    +          // MUTATION (AC5): the pre-fix second exit, restored on purpose.
    +          notifySessionLapsed();
               finish();
               return;
             }
         
    -        // Everything else — a gateway 502/503/504 ...
    -        setError(t(AUTH_ERROR_MESSAGES.authStatusCheckFailed));
    +        setUser(userPayload.user);
    +        await checkOnboardingStatus();
    +        finish();
    +        return;

变异后重跑同一命令，退出码 **1**：

    Test Files  1 failed (1)
         Tests  6 failed | 2 passed (8)
      Duration  28.33s (transform 1.96s, setup 65ms, collect 3.20s, tests 24.68s, ...)

红的正是 AC3 的 (a)(b) 加可恢复那条；`✓ a 401 ... 48ms` 与 `✓ a dropped connection ... 559ms` 仍绿——后者绿得有道理：fetch reject 走 catch，从不进入状态码分支，故不在本任务收紧的判定点上。逐字红行：

    FAIL  ... > a 500 keeps the signed-in user and the stored token
    FAIL  ... > a 502 keeps the signed-in user and the stored token
    FAIL  ... > a 503 keeps the signed-in user and the stored token
    FAIL  ... > a 504 keeps the signed-in user and the stored token
    AssertionError: The expression evaluated to a falsy value:

      ok(userCalls >= 3)

（同一次报告里的 DOM dump 显示 `data-error="Your session expired. Please log in again."`、`probe-token` 为 `none`——即变异版把会话清掉并向用户弹了横幅，正是本缺陷的症状。）

恢复：`git checkout -- src/modules/auth/context/AuthContext.tsx`（恢复后 `git status --porcelain` 为空，`grep -n "userResponse.status === 401"` 回到 `:328`），重跑 ⇒ `Tests  8 passed (8)`，退出码 0。

### AC6 范围纪律

- `git diff develop -- src/shared/api.ts src/shared/authToken.ts e2e/oauth-consent-page.spec.ts | wc -l` ⇒ **0**（空）。
- `npm run typecheck` 退出 **0**（三段：`tsconfig.json`、`server/tsconfig.json`、`scripts/tsconfig.json`，输出仅 154 bytes 的 npm 头部）。
- `npm run lint` 退出 **0**，日志内 `: error ` 计数 **0**、`: warning ` 计数 **239**（`AuthContext.tsx` 仍是它改动前就有的 2 条 warning——113 `only-export-components`、380 `set-state-in-effect`；两个新增文件各 0 条）。

### AC7 落地证据（真实浏览器 + 真实服务端 + 真实 JWT）

`e2e/session-lapse-transient.spec.ts`（新，217 行）。命令：`npx playwright test e2e/session-lapse-transient.spec.ts`（单文件），退出码 **0**：

    ✓  2 e2e/session-lapse-transient.spec.ts:165:1 › a gateway 502 on the user read does not sign the user out
    ✓  2 e2e/session-lapse-transient.spec.ts:201:1 › a credential the server rejects falls through to the login page with the banner

      2 passed (15.8s)        # 另一次运行 16.9s

`beforeAll` 在本次运行的隔离数据目录里经 Setup 表单创建一次性账号、走完 onboarding，随后清掉会话并**经登录表单真登录**（`POST /api/auth/login`）取得 JWT；两条腿复用的就是这枚真 token（不是本 spec 现造的）。

- 腿 1（502）：`page.route('**/api/auth/user')` 顶成 502 后重载 ⇒ `#username` 计数 0（无登录表单）、`localStorage['auth-token']` 仍为该 token。读数以「同一自检已读到 ≥3 次」为先决（`await expect.poll(() => userReads).toBeGreaterThanOrEqual(3)`）——StrictMode 双调用只给 2 次，第 3 次只可能来自真正保留 token 后的重试。随后解除故障并重载 ⇒ 回到已登录外壳（Settings 按钮可见），token 未变。
- 腿 2（正控制）：token 换成结构合法但签名非本机 `jwt_secret` 的伪造值后重载 ⇒ 服务端 stdout 逐字打出 `[WebServer] Token verification failed: invalid signature`（该次运行 4 条），页面落到登录页并出现 "Your session expired. Please log in again."，`localStorage['auth-token']` 被清为 null。

截图（`artifacts/` 被 `.gitignore` 排除，不入 diff；均已肉眼确认内容）：

- `artifacts/session-lapse-transient-recovered-signed-in.png`（64880 bytes）——解除 502 后重载仍停在已登录外壳。
- `artifacts/session-lapse-transient-forged-token-banner.png`（85065 bytes）——被服务端拒绝后登录页上的 session-expired 横幅。

取假形态（e2e 层，第二层证据的自我否证）：把 `AuthContext.tsx` 换回 develop 版（`if (!userResponse.ok)`）后单文件重跑，退出码 **1**，腿 1 红在：

    Expected: >= 3
    Received:    2
      at .../e2e/session-lapse-transient.spec.ts:179:59
      1 failed

（登录表单与 token 断言在其后，serial 模式下腿 2 未运行。）恢复 `git checkout HEAD -- src/modules/auth/context/AuthContext.tsx` 后重跑回绿。

### AC8 判据自证与 goal 判据

`quay goal gate AC-325` 退出 **0**，`"verdict": "pass"`，`"reason": "acceptance passed (exit 0)"`，`evaluationRoot` = 本 worktree，`treeSha` = `993eb8590045182bf754a3756faacb66cf92c96b`。

判据用例数：`npx vitest run src/modules/auth/tests/sessionLapsePolicy.test.tsx` ⇒ `Tests 8 passed (8)`（**8 ≥ 4**：四种响应形态 + 401 正控制 + 离线 + 可恢复）。

### AC9 范围

`git diff --stat develop...HEAD`：

    e2e/session-lapse-transient.spec.ts                | 217 ++++++++++++++++
    src/modules/auth/context/AuthContext.tsx           | 154 +++++++++---
    src/modules/auth/tests/sessionLapsePolicy.test.tsx | 277 +++++++++++++++++++++
    3 files changed, 612 insertions(+), 36 deletions(-)

`git diff --name-status develop...HEAD` ⇒ `A e2e/session-lapse-transient.spec.ts`、`M src/modules/auth/context/AuthContext.tsx`、`A src/modules/auth/tests/sessionLapsePolicy.test.tsx`，与 `## Touches` 前三条逐条一致，**无未申报文件**；`## Touches` 第四项 `tasks/gap-session-lapse-only-on-server-401.md` 由 `task_write` 自己提交在任务存储分支，不在本分支 diff 里。

### 其它

- DoD 的「不是登录页」在冷启动 + 持续 502 下表现为主判定闸门（`AuthLoadingScreen`）而不是登录表单：pages 里没有任何持久化的用户身份可供渲染外壳，所以本 spec 的「已登录」截图是在**解除故障之后**的真恢复态拍的——即 DoD 第三句「解除故障后重载仍已登录」。
- 无新依赖；测试均按 AGENTS.md 的单文件/有界方式运行（未做无界扇出、未在会话内跑全量）。
