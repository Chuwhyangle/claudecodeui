---
id: AC-328
title: 会话瞬态的真实浏览器落地证据：网关 502 重载仍已登录、被服务端拒的 token 重载出 session-expired 横幅（正控制）
status: achieved
kind: criterion
goal: GOAL-037
criterion: f=e2e/session-lapse-transient.spec.ts; [ -f "$f" ] || { echo
  "缺落地证据：$f" >&2; exit 1; }; npx playwright test "$f"
expect: 读数：`e2e/session-lapse-transient.spec.ts` 单文件 `npx playwright test` 退出
  0，两条腿逐条绿——(i) 用真实服务端（隔离数据目录 + 一次性用户，同 `e2e/oauth-consent-page.spec.ts` 的
  fixture）真登录取得真 JWT 后，`page.route('**/api/auth/user')` 顶成 502 再重载 ⇒
  仍处已登录态（无登录表单、`localStorage['auth-token']` 仍为该 token）；该读数以「同一自检已读到 ≥3
  次」为先决（`expect.poll(() => userReads).toBeGreaterThanOrEqual(3)`，见该 spec
  `:179`）；解除故障后重载回到已登录外壳、token 未变。(ii) 正控制：token 换成结构合法但签名非本机 `jwt_secret`
  的伪造值后重载 ⇒ 服务端真拒，页面落到登录页并出现 "Your session expired. Please log in
  again."，`localStorage['auth-token']` 清为 null。两条截图落 `artifacts/`（`.gitignore`
  排除、不入 diff）。落地时该记录可视需要设 `timeoutMs`（该 spec 单次实测约 15.8s）。
origin: 人 yale 2026-10-11 裁定：采纳 `tasks/gap-goal-037-e2e-evidence-ac.md` 的提案，为
  GOAL-037 新增这条 goal 级 AC。依据（该任务体已逐字取证）：GOAL-037 的 `## 退出条件` 第 3 条点名
  `e2e/session-lapse-transient.spec.ts`（真实浏览器 + 真实服务端 + 真实 JWT），而本 goal 唯一的在域
  AC-325 的 criterion 只跑单元判据文件
  `src/modules/auth/tests/sessionLapsePolicy.test.tsx`，从不读该 e2e 产物；充分性判官因此报语义
  `insufficient`（非机械短路：该键在 sufficiency cache 中存在且值为 insufficient）。该 e2e spec 已由
  `gap-session-lapse-only-on-server-401` 落地（`7867d962`，11279 bytes，`npx
  playwright test` 退出 0），故本 AC 立即可验证。落地方式：经 goal 写入 ABI（本记录），并由人裁定「退出条件第 4
  条的不变式不单独立 AC」。
activatedAt: 2026-10-11T00:15:57.242Z
statusLog:
  - at: 2026-10-11T00:19:03.503Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
