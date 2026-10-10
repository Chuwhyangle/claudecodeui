---
id: gap-goal-037-exit-conditions-section
title: GOAL-037 缺 `## 退出条件` 节：提议补写退出条件小节（标题两句映射到在域 AC-325），使充分性判定不再被机械短路
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
  park_reason: 跟进提案：GOAL-037 缺 `## 退出条件` 小节（goal-driver.ts:1132 在任何在域 AC 被考虑之前短路 ⇒
    verdict 恒为 insufficient，语义 judge 从未被咨询；GOAL-037 是 37
    个目标里唯一仍缺该节者）。本任务只提议文本修订、不新增 AC、不改任何 GOAL/AC 状态；须人裁定是否采纳，以及 `## 范围` 第 1
    条「只报可恢复的错误」这一无在域 AC 直接覆盖的软点如何处置。
---
## Proposal

选型 **(b)：修订 GOAL-037 的退出条件文本**——在 `goals/GOAL-037-手机端-cloudcli-会话不再被瞬时故障清除-只有服务端-401-才判定会话失效.md` 正文末尾补写一个 `## 退出条件` 小节。**不新增 AC，不改任何 GOAL/AC 状态。**

### 未被覆盖的部分（逐字引用）

该目标正文**完全没有**退出条件——`grep -c '^## 退出条件' goals/GOAL-037-*.md` 为 **0**，`grep -n '退出条件' goals/GOAL-037-*.md` 全文零命中（连行内句也没有）。退出条件只能落在目标标题上，逐字为：

> 手机端 CloudCLI 会话不再被瞬时故障清除：只有服务端 401 才判定会话失效

标题两个半句逐字为：①「手机端 CloudCLI 会话不再被瞬时故障清除」；②「只有服务端 401 才判定会话失效」。这两半从未被写进任何退出条件文本，故机械层没有可比较的对象。

### 为何现有 AC 集被判 insufficient（机械层的成因，逐行）

`/data/home/yale/.claude/plugins/marketplaces/quay/plugin/scripts/goal-driver.ts`：

- `:1105` 的 `hasExitConditions()` = `exitConditionsText(body).length > 0`；后者（`:1100`）经 `extractSections(body,"退出条件")`，标题**逐字匹配**（`allowHeadingSuffix` 对退出条件刻意不开，见 `:1080` 注释「退出条件**不开**该项：`hasExitConditions` 是机械可证层」）。
- `:1128` 的 `goalSufficiencyVerdict()` 第一条即 `if (!hasExitConditions(String(goal.body ?? ""))) return "insufficient";`——在语义判定入口（`:1134` 返回 `not-evaluated`、随后才咨询 LLM 判官）**之前**短路返回。
- `:1122-1124` 的函数注释逐字点名本形态：「insufficient 结构上可证覆盖不成立：GOAL body 无【非空】`## 退出条件` 文本（退出条件从未写下，覆盖无从谈起）」。

故 GOAL-037 的 verdict 恒为机械 `insufficient`，**语义 judge 从未被咨询**。轮日志逐字为证：`.quay/goal-round.jsonl` 最近一轮 round 75（ts `2026-10-10T16:32:46.244Z`）的 `goal-sufficiency` 事实是 `{"sufficiency":{"goal":"GOAL-037","verdict":"insufficient"}}`，reason `sufficiency=insufficient（在域 AC 1 条）`——reason 里没有任何语义 judge 的产物。`.quay/goal-sufficiency-followup.json` 记 `GOAL-037.since=2026-10-10T16:32:46.244Z`、`filedAt=null`（即本任务为该目标的**首次**跟进立案）。

### 为什么只能选 (b)：新增一条 AC 解不开这个死锁

短路在 `:1132` 发生在**任何**在域 AC 集合被考虑之前——`:1133` 那条「零在域 AC ⇒ insufficient」都还没轮到。故**新增一条 AC 不会改变 `hasExitConditions` 的取值**，verdict 仍是机械 `insufficient`，goal 仍卡在 `active`。这与 `:229-231` 的注释一致：充分性裁决是确定性的，输入变化只可能来自「（a）人改 GOAL 标题/退出条件/范围节，或（b）在域 AC 集合增删改」，而「一个已超过该周期仍未变的 insufficient，**不再有任何机制会自己去改它**；唯一剩下的改变途径正是本条信号要请人做的那件事」。本目标属 (a) 那一类。

### 内容上是否有缺口：基本齐，一处软点如实登记（供人裁定）

- **标题①「手机端 CloudCLI 会话不再被瞬时故障清除」**：AC-325 (ii) 5xx / (iii) 200 非 JSON / (iv) fetch reject 三条各断言「token 仍在 localStorage、user 保留、不出现 session-expired 文案」，正对「瞬时故障不清除会话」。
- **标题②「只有服务端 401 才判定会话失效」**：AC-325 (i) 是 401 的正控制（token 移除、user 归 null、出现 "Your session expired…"），(a) 段的四种响应共同固定「只有 401 lapse」。
- **`## 范围` 承重承诺**：「只在 401 调 `notifySessionLapsed`」→ AC-325 (i)/(ii)(iii)(iv)；「其余失败保留 token 与会话」→ (ii)(iii)(iv)；「允许重试」→ AC-325 (b)（瞬时失败后自检重跑并成功）；「既有契约不破（e2e AC3 绿 + typecheck 0）」→ AC-325 (d)。
- ⚠️ **一处欠账**：`## 范围` 第 1 条「其余失败…**只报可恢复的错误**」——AC-325 (ii)(iii)(iv) 只断言「**不出现** session-expired 文案」与 token/user 保留，**没有一条**断言瞬时失败被以一个可恢复的错误（而非沉默/空转）告知用户。请人裁定：明示「由 AC-325 间接保证、不单列退出条件」，或另立 AC。

GOAL-037 目前只有一条在域 AC（AC-325，status=active，未 achieved），故目标收敛 ⟺ AC-325 achieved。

### 同类先例（同一配方，已四次落地）

`gap-goal-001-exit-conditions-section` / `gap-goal-003-exit-conditions-section` / `gap-goal-007-exit-conditions-section` / `gap-goal-034-exit-conditions-section`（均 done）——均选 (b)「修订退出条件文本」，把缺失的 `## 退出条件` 小节补出/提升出来（GOAL-001/003 由行内句提升；GOAL-034 由标题 + `## 目标` 生成；GOAL-007 是空 body 形态）。落地后下一轮 round log 中该目标的 verdict 由机械 `insufficient` 变为语义 judge 的 `covered`。

### 建议的修订文本

（房屋风格同 GOAL-007 / GOAL-034：小节标题 + 逐条 AC 编号 + 该条的实质判据。）在 `goals/GOAL-037-手机端-cloudcli-会话不再被瞬时故障清除-只有服务端-401-才判定会话失效.md` 正文末尾新增下列小节：

> ## 退出条件
>
> 本目标收敛后，手机端 CloudCLI 的会话失效判定只由服务端明确拒绝触发；标题两个半句逐一落到实处：
>
> - **AC-325 会话失效判定只认服务端 401（正控制）**：替身 fetch 驱动 AuthProvider 启动自检 `GET /api/auth/user`，四种响应下行为固定——(i) 401 + `X-Auth-Error: session-expired` ⇒ token 从 `localStorage` 移除、`useAuth()` 的 user 为 null、出现 "Your session expired. Please log in again."（这是现在就该有的行为，改动后不得回归）；(ii) 500/502/503/504、(iii) 200 但响应体是 HTML（运营商劫持/代理页）、(iv) fetch reject（离线）⇒ 三者一律 token 仍在 `localStorage`、user 保留、不出现 session-expired 文案。瞬时失败后自检重跑并成功 ⇒ 会话完整、无需重新登录。既有契约不破：`e2e/oauth-consent-page.spec.ts` 的 AC3 正控制（存有被服务端拒绝的 token 时出现 session-expired 横幅）仍绿、`npm run typecheck` 退出 0。反例：把 `if (!userResponse.ok)` 恢复成任意非 2xx 都 lapse ⇒ (ii)(iii) 用例红，恢复后回绿。
> - **AC-325 achieved**；或由人裁定放宽 / 取消其中任一条。
>
> **覆盖状态如实登记（供人裁定）**：标题两个半句与 `## 范围` 的承重承诺已由 AC-325 逐条承载，内容无缺口，缺的只是结构（`## 退出条件` 小节从未写下）。唯一软点：`## 范围` 第 1 条「只报可恢复的错误」无在域 AC 直接读——(ii)(iii)(iv) 只读「不出现 session-expired 文案」。需人裁定是「明示不作退出条件」还是「另立 AC」。

<!-- dedup-ref -->**去重结论（仅溯源，非前置）**：`tasks/` 内无任何 GOAL-037 的任务（`grep -rl "GOAL-037" tasks/*.md` 零命中；`task_list search=GOAL-037` 为空），无同机制任务——GOAL-037 也确为 37 个目标里唯一仍缺 `## 退出条件` 者。granularity 工具对本文 Touches 报 `peers[]` / `mentions[]` 均为空。同配方的先例 `gap-goal-001/003/007/034-exit-conditions-section`（见上）非本次重复。

## AC

- [x] **AC1 退出条件小节落地**：`grep -c '^## 退出条件' goals/GOAL-037-*.md` 输出 **1**，且按 `goal-driver.ts` 的**同一条正则** `##[ \t]+(退出条件[ \t]*)\r?\n([\s\S]*?)(?=\r?\n##[ \t]|$)` 取出节体、去空白后字符数 **≥ 40** —— 该行只能由被授权的 goal 写入路径落地（非本 agent）（待外部）
- [x] **AC2 人（yale）已裁定并被记录**：本任务 `## Resolution` 小节写明 (i) 是否采纳本修订（采纳 / 改措辞 / 不采纳并另立 AC），以及 (ii) `## 范围` 第 1 条「只报可恢复的错误」这一无在域 AC 直接覆盖的软点如何处置——**明示不作退出条件**，或**另立 AC 并给出任务 id**；二者缺一即本 AC 不满足 —— 该行只能由人 yale 写入（待外部）
- [ ] **AC3 机械短路不再触发，且语义判官确被咨询**：修订后 `.quay/goal-round.jsonl` 中 GOAL-037 最新 `goal-sufficiency` 的 reason 必须**同时**满足三条——(a) verdict ∈ {`covered`, `insufficient`}（机械层 `goalSufficiencyVerdict()` 只可能返回 `insufficient` / `not-evaluated`，`covered` 只可能来自语义路径）；(b) reason 中**不含** `cause=`（语义判官不可用 / 超时时产出 `not-evaluated（cause=judge-unavailable）…`，同样「不是机械短路形态」，可被一次 spawn 失败冒充达标）；(c) **正面控制**——`sufficiencyCacheKey(goal, inScopeAcs)` 算出的键在 `.quay/goal-sufficiency-cache.json` 的 `entries` 中存在（只有真跑过判官才会写缓存；立案时该缓存 `entries` 为空）—— 该行须在修订合入并跑过一轮 driver 之后才读得到（待外部）

## DoD

人工授权后，由**被授权的 goal 写入路径**（而非本 agent）真实修改 `goals/GOAL-037-手机端-cloudcli-会话不再被瞬时故障清除-只有服务端-401-才判定会话失效.md`：新增上面那节退出条件文本；并在其后的**真实 round log** 中观察到 GOAL-037 的 sufficiency verdict 不再恒为机械 `insufficient`（语义 judge 被实际咨询并给出结论）。**仅有文本改动而无后续 verdict 观察不算完成。**

承重性由三件事正面证明：(a) 死锁的成因被指名（`goal-driver.ts:1132` 的短路在语义判定入口之前，且 `:1122-1124` 注释点名该形态），据此说明为何新增 AC 解不开、必须改文本；(b) 落地后 `hasExitConditions` 由 false 变 true，verdict 越过短路落到 `not-evaluated` / 语义判定——AC3 要求在**真实轮日志**上读到这一变化，而不是在提交信息里声称；(c) 唯一的软点（「只报可恢复的错误」）被写进小节并在人面前显式登记（AC2），不被一份「退出条件 = AC-325 全列」的文本藏回去。

另需如实登记：本任务**不**让 AC-325 转绿（其 checker 与实现由 AC-325 自身的派工任务承担——AC-325 目前在轮日志上为 `fail`，reason `缺判据文件：src/modules/auth/tests/sessionLapsePolicy.test.tsx`）；本任务也不裁决软点该不该另立 AC——**只要求裁定被写下**。

本任务由跟进 agent 只提议：不改 `goals/*.md`，不改任何 GOAL/AC 状态，不把任何 AC 标 achieved / active / draft / retired。

## Touches

- goals/GOAL-037-手机端-cloudcli-会话不再被瞬时故障清除-只有服务端-401-才判定会话失效.md
- tasks/gap-goal-037-exit-conditions-section.md

## Resolution

**人 yale 2026-10-11 对本任务 AC2 两问的裁定**：

- (i) **采纳** GOAL-037 的 `## 退出条件` 修订。
- (ii) `## 范围` 第 1 条「其余失败…只报可恢复的错误」——**明示不作退出条件**（由 AC-325 间接保证），不另立 AC。

**落地读数（2026-10-11，manager 侧核实）**：

- **AC1 在本次裁定之前就已由授权写入路径满足**：`goals/GOAL-037-*.md` 于 `2026-10-11 00:58:46 +0800` 经 goal ABI 批量写入新增了 `## 退出条件` 小节（6 条，逐条 `覆盖：AC-325`；commit `f1bbe4b6 goals: GOAL-037 batch by cli:3669255`）。本次复核实测两个机械条件：`grep -c '^## 退出条件'` = **1**；按 `goal-driver.ts` 的同一条正则取节体、去空白后 **811** 字符（≥ 40）。
- **那份已存在的正文与本任务 Proposal 的「建议的修订文本」实质等价**（401-only 判定 / 瞬态保留 token 且有界重试 / 四种响应形态的判据文件 / 既有契约不破 / 反例成立），并多了一条更强的 `quay goal gate AC-325` 退出项；差异只在文体与"覆盖状态登记"段落的落点。⇒ 本次**不覆盖**它（避免破坏他人经 ABI 的写入），只做下述追加。
- **本次唯一追加**：`## 退出条件` 小节末尾加一行软点登记（commit `571a5f5c`，该提交对目标的 diff **仅此一行**）——明示该软点由 AC-325 间接保证、不单独作为退出条件。
- **AC3 仍未勾（如实）**：`.quay/goal-round.jsonl` 里 GOAL-037 最新 `goal-sufficiency` 为 `insufficient`（`2026-10-10T17:22:27Z`），其间 `17:14:26Z` 出现过一次 `not-evaluated` + `cause=judge-unavailable` ⇒ "判官确被咨询"的缓存键证据尚未取到，故不代勾。参考：`AC-325` 已于 `2a16cc4d` 由 active→achieved。
