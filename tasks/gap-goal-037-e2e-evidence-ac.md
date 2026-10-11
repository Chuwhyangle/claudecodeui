---
id: gap-goal-037-e2e-evidence-ac
title: GOAL-037 退出条件 3 无在域 AC
  读取：提议新增一条「真实浏览器落地证据」AC（e2e/session-lapse-transient.spec.ts），使充分性判官不再
  insufficient
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
  park_reason: "跟进提案：GOAL-037 的在域 AC 集只有 AC-325（criterion 只跑单元判据
    sessionLapsePolicy.test.tsx），而退出条件第 3 条逐字点名的真实浏览器证据
    e2e/session-lapse-transient.spec.ts 无任何在域 AC 读取 ⇒ 语义充分性判官恒
    insufficient（cache 键 8554b82f 有值即判官真跑过）。本任务提议新增一条 goal 级 AC 覆盖它（该产物已由实现任务
    gap-session-lapse-only-on-server-401 的 AC7 真实落地）；只提议、不新增 AC 状态、不改
    goals/*.md。须人裁定是否采纳，并一并处置前提已被证伪的 gap-goal-037-exit-conditions-section（它要补的
    ## 退出条件 小节已落地）。"
---
## Proposal

选型 **(a)：为 GOAL-037 新增一条 AC** —— 覆盖其退出条件里当前**没有任何在域 AC 读取**的那一条。⛔ 本任务不改任何 GOAL/AC 状态、不写 goal store：criterion 文本只是提案，须由人裁定后被授权的 goal 写入路径落地。

### 未被覆盖的退出条件（逐字引用）

`goals/GOAL-037-手机端-cloudcli-会话不再被瞬时故障清除-只有服务端-401-才判定会话失效.md` 的 `## 退出条件` 第 3 条逐字为：

> 3. 真实浏览器 + 真实服务端 + 真实 JWT 的落地证据（`e2e/session-lapse-transient.spec.ts`）：把 `/api/auth/user` 顶成 502 后重载仍处已登录态；换成服务端真会拒的 token 后重载出现 session-expired 横幅。覆盖：AC-325。

### 为什么现有 AC 集覆盖不了它

本 goal 的在域 AC 只有 **AC-325** 一条。AC-325 的 `criterion` 逐字为

```
f=src/modules/auth/tests/sessionLapsePolicy.test.tsx; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx vitest run "$f"
```

—— 它**只执行单元判据文件** `sessionLapsePolicy.test.tsx`，其 `expect` 的 (a)(b)(c)(d)(e) 五段也**逐字只描述这一个文件名**（替身 fetch 驱动 AuthProvider 的启动自检）。

退出条件第 3 条点名的是**另一份、更重的产物**：`e2e/session-lapse-transient.spec.ts` —— 真实 Chromium + 真实服务端（隔离数据目录、一次性用户）+ 真实 JWT；用 `page.route` 把 `/api/auth/user` 顶成 502 后重载，以及把 token 换成服务端真会拒的伪造值后重载出横幅。**没有任何在域 AC 会读出这个文件**：AC-325 的 criterion 不会运行它，expect 也不提它。这正是本轮充分性判官 `insufficient` 所指（本轮 verdict 是**语义**判定，不是机械短路；证明见下）。

### 为什么本提案的 AC 覆盖它

新候选 AC 的 criterion **直接指向那份 e2e 文件**（`npx playwright test <file>`，单文件、真实浏览器），expect 固定两条腿。它读的正是退出条件第 3 条逐字点名的产物，把该条从「无 AC 读取」变成「有 AC 读取」。

### 候选 NEW AC（供人裁定后落地）

- **title**：会话瞬态的真实浏览器落地证据：网关 502 重载仍已登录、被服务端拒的 token 重载出 session-expired 横幅（正控制）

- **criterion**：

```
f=e2e/session-lapse-transient.spec.ts; [ -f "$f" ] || { echo "缺落地证据：$f" >&2; exit 1; }; npx playwright test "$f"
```

- **expect**：读数：`e2e/session-lapse-transient.spec.ts` 单文件 `npx playwright test` 退出 0，两条腿逐条绿——(i) 用真实服务端（隔离数据目录 + 一次性用户，同 `e2e/oauth-consent-page.spec.ts` 的 fixture）真登录取得真 JWT 后，`page.route('**/api/auth/user')` 顶成 502 再重载 ⇒ 仍处已登录态（无登录表单、`localStorage['auth-token']` 仍为该 token）；该读数以「同一自检已读到 ≥3 次」为先决（`expect.poll(() => userReads).toBeGreaterThanOrEqual(3)`，见该 spec `:179`）；解除故障后重载回到已登录外壳、token 未变。(ii) 正控制：token 换成结构合法但签名非本机 `jwt_secret` 的伪造值后重载 ⇒ 服务端真拒，页面落到登录页并出现 "Your session expired. Please log in again."，`localStorage['auth-token']` 清为 null。两条截图落 `artifacts/`（`.gitignore` 排除、不入 diff）。落地时该记录可视需要设 `timeoutMs`（该 spec 单次实测约 15.8s，`test.describe.configure({timeout: 45_000})`；默认 60s 判据超时偏紧）。

### 去重 / 关联（按机制，非症状）

<!-- dedup-ref --> `gap-session-lapse-only-on-server-401`（**done**）是本 goal 的实现任务：它把这条 e2e 作为自己的 AC7 落了地（`e2e/session-lapse-transient.spec.ts` 现 11279 bytes、`npx playwright test` 退出 0）。但**任务层的 AC ≠ goal store 的 AC** —— goal 的在域 AC 集仍只有 AC-325，判官看不到这条证据，故本提案把它提升为一条 goal 级 AC。`gap-goal-037-exit-conditions-section`（**needs-human，前提已被证伪**）提议改**退出条件文本**（补写 `## 退出条件` 小节），但它要补的小节**已经落地**（goal 文件现有 `## 退出条件` 六条 + 一行「软点登记（人 yale 2026-10-11 裁定）」），且它明说「不新增 AC」。故本任务与它是**不同 remedy**（新增 AC ≠ 改文本），不是它的重复；该过期任务建议由人一并 close。机械去重 `task-granularity-advice.js --touches <goal files> --json` 返回 `peers: []`（none found）。

### 判官确实被咨询：本轮是语义 insufficient，不是机械短路

`goal-driver.ts` 的机械层 `goalSufficiencyVerdict()` 只在「body 无【非空】`## 退出条件`」或「零在域 AC」时返回 `insufficient`，否则返回 `not-evaluated`（**从不机械产 insufficient**；`covered`/`insufficient` 由语义判官产出）。读数：`.quay/goal-sufficiency-followup.json` 记 `GOAL-037.since=2026-10-10T17:22:27.365Z`；`.quay/goal-sufficiency-cache.json` 含键 `8554b82fe361c4c26ca239d307cec12d8bf58a24d40303e57b5398593c090d49`（= `sufficiencyCacheKey(goal, inScopeAcs)`），值 `{"verdict":"insufficient","ts":"2026-10-10T17:19:32.809Z"}`，且该键**只在判官真跑过时**被写入。goal body 的 `## 退出条件` 小节自 2026-10-10T16:58:46Z 起就在（mtime 与 goal `updatedAt` 同）。故本轮 `insufficient` 只能来自语义判官 ⇒ 缺口是**真实的覆盖缺口**。

## AC

- [x] **AC1 新 AC 落地**：`goals/` 下新增一条属于 GOAL-037 的 criterion，其 `criterion` 逐字为上面那段 shell，`title`/`expect` 与本提案一致；且 `goals/GOAL-037-*.md` 退出条件第 3 条的映射由「覆盖：AC-325」更新为新 AC 的 id —— 该行只能由被授权的 goal 写入路径落地（非本 agent）（待外部）
- [x] **AC2 人（yale）已裁定并被记录**：本任务 `## Resolution` 写明 (i) 是否采纳本新增 AC（采纳 / 改 criterion / 不采纳并说明理由），以及 (ii) 退出条件第 4 条「`git diff develop -- src/shared/api.ts src/shared/authToken.ts e2e/oauth-consent-page.spec.ts` 为空」这一 AC-325 只部分承载的不变式是否也需一条 AC —— 二者缺一即本 AC 不满足 —— 该行只能由人 yale 写入（待外部）
- [ ] **AC3 判官改判**：新 AC 合入并跑过 ≥1 轮 driver 后，`.quay/goal-round.jsonl` 中 GOAL-037 最新 `goal-sufficiency` 的 verdict 为 `covered`（正面控制：`covered` 只可能来自语义路径——机械层只产 `insufficient`/`not-evaluated`；且 `.quay/goal-sufficiency-cache.json` 的 `entries` 中出现新 `sufficiencyCacheKey` 对应的键）—— 该行须在落地后读到（待外部）

## DoD

由被授权的 goal 写入路径（而非本 agent）真实新增该 criterion 记录、并把退出条件第 3 条的映射更新为新 AC id；随后在**真实 round log** 上观察到 GOAL-037 的 sufficiency verdict 由 `insufficient` 变为 `covered`。**仅有文本改动而无后续 verdict 观察不算完成。**

承重性由三件事正面证明：(a) 缺口被逐字指名（退出条件第 3 条点名的 `e2e/session-lapse-transient.spec.ts` 无任何在域 AC 读取，AC-325 只读单元文件）；(b) 缺口是语义层而非机械层——用 cache 键 + goal body mtime 证明判官真跑过（`insufficient` 出自判官，非短路）；(c) 为什么是新增 AC 而非改文本：e2e 是本 goal **已真实交付**的产物（实现任务 `gap-session-lapse-only-on-server-401` 的 AC7 已落地，文件在、`npx playwright test` 退出 0），把证据提升为 goal 级 AC 才是收口，而非把退出条件改窄。

本任务**不**让 AC-325 变绿（它已 `achieved`），也不裁决退出条件第 4/5/6 条该不该各立 AC（**只要求该裁定被写下**，AC2）。遵守 AGENTS.md；判据为单文件 e2e，不做无界扇出。

## Touches

- goals/AC-326-会话瞬态的真实浏览器落地证据-网关-502-重载仍已登录-被服务端拒的-token-重载出-横幅-正控制.md (new)（新 criterion 记录；只能由被授权的 goal 写入路径落地）
- goals/GOAL-037-手机端-cloudcli-会话不再被瞬时故障清除-只有服务端-401-才判定会话失效.md（退出条件第 3 条映射更新为新 AC id）
- tasks/gap-goal-037-e2e-evidence-ac.md

## Resolution

**人 yale 2026-10-11 对本任务 AC2 两问的裁定**：

- (i) **采纳**新增这条 goal 级 AC（criterion 指 `npx playwright test e2e/session-lapse-transient.spec.ts`）。
- (ii) 退出条件第 4 条那条 `git diff develop -- src/shared/api.ts src/shared/authToken.ts e2e/oauth-consent-page.spec.ts` 为空的不变式——**明示不作单独 AC**（由 AC-325 间接承载，既有的 oauth AC3 正控制已部分固定它）。

**落地（经 goal 写入 ABI，2026-10-11）**：

- 新 AC 已创建为 **AC-328**（`goal=GOAL-037`、`status=active`），`title` / `criterion` / `expect` 逐字取自本任务 Proposal 的「候选 NEW AC」段。
- GOAL-037 的 `## 退出条件` 第 3 条映射已由 `覆盖：AC-325` 改为 `覆盖：AC-328`；逐条复核：1/2/4/5 = AC-325、**3 = AC-328**、6 无映射。
- **正控制读数**：`quay goal gate AC-328` → **pass（exit 0）**，GateEvent ts `2026-10-11T00:19:16Z`。

**如实披露两件事（都不影响上面的结论）**：

1. **该 e2e 判据在冷跑时可能先红一次**：我第一次跑 `goal gate AC-328` 得 **exit 1**（红），单独跑 spec 也红在自己的**建号流程**（`getByPlaceholder('John Doe')` 超时，spec `:118`，两轮不同 `quay-e2e-tmp` 根）；**同树复跑即绿**（2 passed / 18.4s，正控制日志 `Token verification failed: invalid signature` ×4）⇒ 判定为**首跑 / 依赖优化器热身毛刺**（本仓既有形态），不是 spec 的确定性缺陷。⇒ "立即可满足"成立，但**带条件**：冷跑会红，AC-328 的判据因此对首次运行敏感。
2. **一处我自己的操作失误（已修正）**：改第 3 条映射时我用了 Python 的 `str.replace`（**默认替换全部**，与 JS 只换首个不同），误把第 1–5 条**全部**改成 AC-328；随后按行修正并逐条复核为 1/2/4/5 = AC-325、3 = AC-328。结论未受影响，但过程如实登记。

**AC3 仍未勾**：它要的是下一轮 driver 的 `goal-sufficiency` verdict 变为 `covered` + 新 `sufficiencyCacheKey` 出现在缓存里——须在 AC-328 合入并跑过 ≥1 轮后才读得到。
