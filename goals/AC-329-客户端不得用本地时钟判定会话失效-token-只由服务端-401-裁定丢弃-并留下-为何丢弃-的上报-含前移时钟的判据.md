---
id: AC-329
title: 客户端不得用本地时钟判定会话失效：token 只由服务端 401 裁定丢弃，并留下「为何丢弃」的上报（含前移时钟的判据）
status: achieved
kind: criterion
goal: GOAL-037
criterion: f=src/modules/auth/tests/clientClockCannotExpireSession.test.tsx; [
  -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx vitest run "$f"
expect: "读数：(a) 新判据
  `src/modules/auth/tests/clientClockCannotExpireSession.test.tsx`
  在**被前移的页面时钟**下驱动客户端，断言「本地时钟不再有删除权」：(i) 存有一枚 exp 已过（按页面时钟）的 token
  时，`localStorage['auth-token']` **仍在该 token**（`src/shared/authToken.ts:83-84`
  现在会在这里删掉它 ⇒ 现在必红），且**没有**派发 `AUTH_SESSION_EXPIRED_EVENT`；(ii) 同一情形下 WS 构造出的
  URL **仍带该 token**（`src/shared/context/WebSocketContext.tsx:64-65` 现在会删掉并返回
  null ⇒ 现在必红）；(iii) 该请求**带上了凭证**（服务端会看到它，而不是先被客户端丢掉）。(b) 正控制（真过期仍必须登出）：服务端以 401
  + `X-Auth-Error: session-expired` 回答 ⇒ token 被移除、`useAuth().user` 为 null、出现
  \"Your session expired. Please log in again.\"，且此路径**确实**派发了
  `AUTH_SESSION_EXPIRED_EVENT`。(c) 丢弃原因可观测：客户端在每次「会话被判失效 / 不再持有可用 token」时写一条
  breadcrumb（`reason` ∈
  {`server-401`|`server-expired`|`storage-empty`|`local-clock`}、该 token 的
  `exp`、客户端 `now`）到 `localStorage` 与 console；`local-clock`
  这一支在修复后**不可再出现**（作为回归探测器）；breadcrumb 与上报中**不含任何凭证**（token 全文/签名/密码逐一 `grep -F`
  零命中）。(d) 上报随下一次 `POST /api/auth/login` 的请求体送达（服务端 login 只读
  username/password，不因此改变判定），`[AuthReq]` 行增补该
  `lapse=`/`exp=`/`clientNow=`/`skew=` 读数——2026-10-11 现场无此读数，正是本次只能靠旁证推断的原因。(e)
  现状（2026-10-11 复核）：`src/shared/authToken.ts:81-88` 的 `getStoredAuthToken()` 在
  `isAuthTokenExpired` 为真时调用 `expireAuthSession()` 并返回
  null（`TOKEN_EXPIRY_SKEW_MS` 仅
  60s，页面时钟快于服务端即误判），`src/shared/context/WebSocketContext.tsx:63-66`
  同样在本地判过期时登出。(f) 反例：把任一本地删除点恢复（或调回 `getStoredAuthToken` 的删除分支）⇒ (a)(i)/(a)(ii)
  红，恢复后回绿。"
origin: 人 yale 2026-10-11 指示（在"检查进展"回合后选定）：为「客户端不得用本地时钟预删 token（只由服务端 401
  裁定失效），并补上 token 为何被丢弃的客户端观测」立 follow-up 任务。依据是本会话用新落地的 `[AuthReq]`
  请求日志抓到的现场：安卓手机 02:17 后仅有的 auth 流量里出现 `GET /api/auth/user -> 401
  reason=invalid-token`×3（零 `Token verification failed`、零
  `reason=user-not-found`、非 `session-expired` ⇒ 请求根本没带凭证），即客户端在服务端作答前已用本地时钟把
  token 丢掉。已落地的 AC-325 只覆盖"服务端给了非 401"，不覆盖这一支，故另立判据。
activatedAt: 2026-10-11T00:43:27.670Z
statusLog:
  - at: 2026-10-11T00:43:27.670Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-11T01:30:20.169Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-11T00:43:27.670Z
---
