---
id: gap-ac315-reload-window-residual-deterministic-injection
title: AC-315 残余（page.reload 后判定窗超时）30 次未复现：先用确定性慢 reload
  注入把红造出来再修到绿；稳定性读数改用家族惯例（连续 ≥5 次 + 一次并发臂），不再用不可证的「连跑 10 次全绿」
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-315
---
## Proposal

来源：`gap-ac315-upload-criterion-boot-race`（needs-human → 人 yale 2026-10-10 裁定）把该任务 AC2 的「第一条命令连跑 ≥10 次全部 exit 0」判为**不可判定**的目标，改判成本条：先造出确定的红，再修到绿，稳定性读数用本族惯例。

### 为什么改判（不是放弃，是换成可证形式）

- 「连跑 N 次全绿」只能被反例推翻、不能被证明；每重跑一轮烧掉一整次 worker 会话。该任务已因此烧掉两轮。
- 现在**没有可修的对象**：残余的第一族（`page.reload()` 后 `.chat-messages-pane` 30s 判定窗超时）在 30 次运行里**一次都没复现**；第二族（两条 leg 共用同一 `page` + `mode: 'serial'`，375px leg 的等待在首次求值就命中上一轮的旧文本）已根因定位并修好 —— commit `3e856ef7`，修后 20/20。
- 同族先例走的是另一条路：AC-184 → `gap-ac266-criterion-startup-guard-cannot-afford-a-replay`（已 done）把「希望它别红」换成「**先注入确定性慢首载把红造出来**，再修到绿」。那是可证的。

### 现状读数（立案时实测，不是复述）

- `.quay/gate-events.jsonl` 中 AC-315 的 `gate: goal` 记录共 **116 次评估、20 次红**，且 **20 次红全部早于 `2026-10-09T15:26:51Z`**；其后到 `2026-10-10T02:00:26Z` 连续 30 次 pass —— **约 13.5 小时零红**。
- 该判据间歇红是**已记录的历史属性**：两个前序任务追过它（`gap-ac315-upload-criterion-repoint-under-voice-bar` :: done、`gap-ac315-upload-criterion-second-upload-flake`），前者的 DoD 原话是「这条判据历史上就是间歇红的，单次绿不算数」。
- AC-315 现 `achieved`，criterion 逐字为 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts && npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`。

### 修什么

1. 把残余变成**可复现**：注入一个确定性慢 reload —— 只在「注入开启」且只在 `beforeAll` 首次 `page.goto('/')` 之后的那次 `page.reload()` 触发的文档/入口请求上，把响应拖过判定窗（其后正常服务）。先证明判据**红**，再修。
2. 修到绿：让 reload 路径的判定窗有界且留得下重放（照 AC-184 在 `e2e/activity-dock-truthful.spec.ts` 上的成例：预算算术要算得过来，重放签名地记进日志），而不是加 sleep / 放宽断言。
3. 稳定性读数改用家族惯例（见 AC3）。⛔ 不动判据命令、⛔ 不动 `playwright.config.ts`、⛔ 不加 retries/skip、⛔ 不改既有实质断言、⛔ 不动 `goals/**`。

## AC

- [ ] AC1 确定性注入可红（承重）：注入上述慢 reload 后，判据物逐字不改地跑必须**非零退出**，且红落在被点名的那个窗/守卫上（不是「文件不存在」式的空洞红）。登记注入 diff、逐字失败行、`echo $?`。
- [ ] AC2 同一注入下修到绿（承重）：改后同一注入 `exit 0`，且逐字日志里能读出 reload 路径的**有界重放**确实被执行（署名日志：首跳 / 第 N 次 reload），随后还原注入并证明零残留（`git status --porcelain` 回到注入前）。
- [ ] AC3 稳定性读数（家族惯例，非 10 次）：无注入条件下判据连续 **≥5 次** `exit 0`；其中**至少一次与 ≥4 份兄弟 e2e spec 并发**。如实登记：并发那次若兄弟 spec 自己红，须点名归因、不计入本条。⛔ 不再以「连跑 10 次全绿」为判据（经裁定为不可证伪）。
- [ ] AC4 判定面一字未改：`git diff develop -- e2e/voice-realtime-upload-fixture.spec.ts | grep -c "^-.*expect("` 为 **0**；`git diff develop -- playwright.config.ts` 为空；判据命令逐字不变；既有实质断言（`audioFrameCount` 增量、`mediaCallCount` 为 0、`page.reload()` 后仍可见等）原样。
- [ ] AC5 静态门：`npm run typecheck` 退出 0；`npx oxlint e2e/voice-realtime-upload-fixture.spec.ts` 的新增诊断数为 0（与 develop 版本同跑对照）。

## DoD

真实落地判据：残余不再是「不可复现的偶发」，而是被**观测到**的机制 —— 确定性慢 reload 注入下判据先红、修后绿，两组读数（注入前后、修复前后）与注入 diff 一并入档，任何人在同一 checkout 上可复现；还原后 `git status --porcelain` 干净。稳定性以连续 ≥5 次（含一次与 ≥4 份兄弟 spec 并发）为读数，如实登记每次的 exit code 与 wall。

若注入下**无法**把红造出来（即慢 reload 不是该窗的触发条件），必须停手上报：置 `needs-human` 并写明「残余不可归因于 reload 路径，原判据的不稳定另有来源」——不得把造不出红写成修好了，也不得据此改断言。

交付物只落在 `e2e/voice-realtime-upload-fixture.spec.ts` 与本任务文件；⛔ 不以 jsdom/组件层绿替代浏览器层绿；⛔ 不改 `goals/**`。

## Touches

- e2e/voice-realtime-upload-fixture.spec.ts
- tasks/gap-ac315-reload-window-residual-deterministic-injection.md (self)

## Notes

- 前身：`gap-ac315-upload-criterion-boot-race`（AC1/AC3/AC4/AC5 已交付并 ticked；AC2 经人裁定移交本条）。AC-315 本体保持 `achieved`，未被 supersede。
- 判据物是**出货中的 spec 本体**，不是本地临时改动：`git cat-file -e develop:e2e/voice-realtime-upload-fixture.spec.ts` 必须存在。
