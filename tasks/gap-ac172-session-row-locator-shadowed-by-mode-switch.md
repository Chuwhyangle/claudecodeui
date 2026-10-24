---
id: gap-ac172-session-row-locator-shadowed-by-mode-switch
title: AC-172 判据的会话行定位 a[href="/session/<id>"] 被侧栏模式开关的 Sessions
  链接抢先命中（ff2998e9f 让 sessions 段指向当前路由）⇒ readMark 15s 超时、1 failed / 3 did not
  run；给两处 .first() 定位加 :not([data-mode-switch-link])
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-172
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -l '^goal_ac: *AC-172' tasks/*.md` → **6** 份，全部 **status: done**（`gap-claude-resident-status-bar`、`gap-resident-status-bar-criterion-bounded-boot-guard`、`gap-ac172-criterion-anchor-retired-by-dock-consolidation`、`gap-ac172-criterion-i18n-key-table-retired-counts`、`gap-ac172-criterion-reload-unbounded-net-churn`、`gap-ac172-reload-landing-races-absolute-walk-plateau`）——按规则 done 不是重复，是「上一次的修法没兜住」的证据。在飞任务（todo/ready/needs-human）按 `goal_ac` 与 Touches 双路扫描：**无一**认领 AC-172，也**无一**把 `e2e/resident-status-bar.spec.ts` 列入 `## Touches`（`task-granularity-advice.js --touches e2e/resident-status-bar.spec.ts` → `peers: []`、`mentions: []`）。机制侧最接近的邻居 `gap-ac172-criterion-i18n-key-table-retired-counts`（done，同一 AC、同一 spec）修的是 test 3 的 i18n **键表**；本条修的是 test 1 的**会话行定位**在更晚一次产品提交后变歧义——机制同源（判据的量具跟着产品走）、缺陷面不同、无在飞认领者。⇒ 本条不是重复。

**判据物**：`criterion:` 逐字 `npx playwright test e2e/resident-status-bar.spec.ts`。门限不变：driver-anchor 下 goal gate 的硬 60s；`playwright.config.ts:367` 的 `SINGLE_SPEC_CEILING_MS = 55_000`（spec test 4 的 `elapsed < 55_000` 亦钉此数）。spec 是 `test.describe.configure({ mode: 'serial' })`。

**红态基线（本轮立案前直接重跑判据本身，读它的失败输出，不读台账 `reason` 的截断尾巴）**：`cd /data/home/yale/work/claudecodeui && npx playwright test e2e/resident-status-bar.spec.ts` → **EXIT=1**，`1 failed / 3 did not run`，失败逐字：

```
  ✘  1 e2e/resident-status-bar.spec.ts:785:3 › resident status bar › the popover reports the address the listing publishes, copies it, and closes the process (15.3s)
  -  2 e2e/resident-status-bar.spec.ts:911:3 › resident status bar › the walk drives all four states, and stopping leaves the process
  -  3 e2e/resident-status-bar.spec.ts:1184:3 › resident status bar › every shipped locale carries the keys the bar, the mark and the dividers read
  -  4 e2e/resident-status-bar.spec.ts:1223:3 › resident status bar › the run ends inside the ceiling the goal gate kills at

TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
Call log:
  - waiting for locator('a[href="/session/911ca4b6-ae30-44c8-88e5-63fe2ca7f6d8"]').first().locator('[data-resident-mark]')
  328 | async function readMark(page: Page, sessionId: string) {
  > 330 |   await mark.waitFor({ state: 'attached', timeout: 15_000 });
  331 |   return {
    at readMark (/data/home/yale/work/claudecodeui/e2e/resident-status-bar.spec.ts:330:14)
    at /data/home/yale/work/claudecodeui/e2e/resident-status-bar.spec.ts:796:31
```

serial 模式下 test 1 红即跳过 test 2/3/4。死在 `readMark` 的**第一处调用**（`:796` 的 `const beforeStart = await readMark(page, armA)`）——一个读数都没取到。会话 id 每次运行不同，`911ca4b6…` 只是本轮实例。

**这条红的性质（已用临时探针直接读到 DOM，不是推测）。** 在 `readMark` 超时点 dump 页面（探针已 `git checkout` 还原，工作树干净）：

```
rows: 3
rowHtml[0] = <a href="/session/963ac3e4-…" aria-current="page" aria-label="Sessions" title="Sessions"
               data-mode-switch-link="sessions" class="relative flex items-center justify-center …">
             …lucide-message-square…
rowHtml[1] = 同上（第二份模式开关实例）
rowHtml[2] = 真正的侧栏会话行（Debug Agent logo 的 <a href="/session/963ac3e4-…">）
marks: 2 × <span role="img" aria-label="Resident session, not running"
                data-resident-mark="hollow" data-resident-state="unstarted" …>
```

即：**产品是好的**——侧栏标记确实渲染了两份（`hollow` / `unstarted`），胶囊 `[data-resident-badge]` 也已在 `readMark` 之前被 `toBeVisible` 读到。失效的是判据的**量具**：`readMark` 用 `a[href="/session/<id>"]`.first() 找会话行，而 `ff2998e9f` 新增的侧栏模式开关在 DOM 里**排在会话列表之前**，其 Sessions 段本身就是一个指向当前路由的 `<a href="/session/<当前会话 id>">` —— `.first()` 命中了这个导航链接，它当然没有 `[data-resident-mark]`。

**机制。** `ff2998e9f`（`feat(sidebar): cockpit entry mode switch, attention badge, project deep links`，2026-10-24 15:38:40 +0800）把 `SidebarModeSwitch` 装进 `SidebarHeader` / 折叠栏 / 移动抽屉。`src/modules/sidebar/SidebarModeSwitch.tsx:173-179` 逐字：

```ts
// In sessions mode the sessions segment points at the page already open (a no-op that keeps
// the current view); the cockpit segment remembers where it came from.
const sessionsPath =
  mode === 'cockpit' ? readCockpitReturnPath() : `${location.pathname}${location.search}`;
```

所以在 `/session/<id>` 页面上，sessions 段渲染成 `<a href="/session/<id>" data-mode-switch-link="sessions">`，且 header（row layout）与折叠栏（column layout）各渲染一份——正好两个，与探针的 `rows: 3`（2 个开关 + 1 个真实行）吻合。该提交的 `git show --stat` 只含 `SidebarModeSwitch.tsx` / `SidebarProjectItem.tsx` / `CommandPalette.tsx` 等，**未触及** `e2e/resident-status-bar.spec.ts`（也与本 spec 上一次修订记录的「同一族机制：产品重构越过按旧契约寻址的判据」一致）。

**因果括号（台账时间戳；`criterionHash` 一字未变）**：

- `2026-10-23T23:50:35.424Z` — goal-sweep **pass**（AC-172 最后一次绿；`criterionHash: 2e28f6b79b80cc05`，`treeSha: a491df5e…`）
- `ff2998e9f` 提交于 `2026-10-24 15:38:40 +0800` = `2026-10-24T07:38:40Z`，经 `8f194e96c` 合入 develop
- `2026-10-24T08:13:34.283Z` goal-sweep **fail**（首个红；`criterionHash` 仍 `2e28f6b79b80cc05`，`treeSha: 7d0e1967…` = HEAD `6dc699ee2`）
- `2026-10-24T08:14:31.367Z` goal-cli **fail**（同一树）

判据文本一字未动（hash 自 2026-10-14 起一直是 `2e28f6b79b80cc05`）⇒ 动的是环境，不是判据；最后一次绿落在 `ff2998e9f` 进 develop 之前、首个红落在其后。

**修法（最小充分，只动 spec 的两处定位，不发明新机制）。** `e2e/resident-status-bar.spec.ts` 有两个重复的会话行定位点，都要排除模式开关锚：

1. `:329`（`readMark` 内）：`page.locator(\`a[href="/session/${sessionId}"]\`).first().locator(MARK)` → 加 `:not([data-mode-switch-link])`。
2. `:373`（共享 `sessionRow`，`revealSession` / `sessionRow(...).click()` / `markOf` 都走它）：同样加 `:not([data-mode-switch-link])`。

排除条件用产品自己已经发布的 `data-mode-switch-link` 属性（`SidebarModeSwitch.tsx:134/154`），不新造标记、不往生产代码补死契约。

**探针（本轮直接实测；改动已 `git checkout -- e2e/resident-status-bar.spec.ts` 还原，工作树干净）**：按上面两处改动后跑完整判据 → **PIPE_EXIT=0**，`4 passed (31.5s)`，`elapsed=31173ms`（< 55_000）。逐条：test 1 `5.5s`（`copy.clipboard="peer-resident-status-bar" equalToAddress=true`、`close.request=200 hosts.beforeClose=1 hosts.afterClose=0`、`state=未运行 mark=hollow … closeReason=user`）；test 2 `16.3s`（四态 `运行中 mark=solid+spinner` / `空闲 mark=solid` / `exited(oom) mark=exited`，分隔标签 cron / cross-session 与发送方都对，两条无人轮 `isUserStyle=false`，真实用户轮 `isUserStyle=true`）；test 3 `locales.checked=12 keys.perLocale=27 missing=0`；test 4 `elapsed=31173ms`。⇒ 产品保证全部成立、只需换量具，无需改生产代码。

**⛔ 不变式**：判据命令不改；60s 门限与 `SINGLE_SPEC_CEILING_MS = 55_000` 不动；不加 `retries`、不 skip、不 stub；不删 / 不放宽任何承重断言（四态比对、地址复制、关闭、停止只中止一轮、无人轮分隔标签 / 发送方 / 非用户样式、两条假形态）；不改 `goal_ac` 归属；**不**改其它 spec 的同款定位（`e2e/resident-running-view.spec.ts:440`、`e2e/activity-dock-truthful.spec.ts:191`、`e2e/resident-ui-layout.spec.ts:1212`、`e2e/resident-busy-send.spec.ts:329` 各自认领别的 AC，越界修会把本任务的判据面搞混）。

## AC

- [ ] AC1 判据翻绿：`npx playwright test e2e/resident-status-bar.spec.ts` 退出 **0**，4 个用例全过（stdout `4 passed`），且 test 4 打印的 `elapsed=NNNNms` < 55_000。验证：`echo $?` + `4 passed` + `elapsed=` 三行逐字登记（红态基线见 Proposal：EXIT=1 / `1 failed` / `3 did not run` / `:330` 15s 超时）。
- [ ] AC2 两处会话行定位都排除模式开关锚：`grep -n 'a\[href="/session/\${sessionId}"\]' e2e/resident-status-bar.spec.ts` 的**每一行**都含 `:not([data-mode-switch-link])`，且总行数 ≥ 2（`:329` 与 `:373`）。验证：`grep -n 'a\[href="/session/\${sessionId}"\]' e2e/resident-status-bar.spec.ts | grep -vc ':not(\[data-mode-switch-link\])'` 输出为 **0**，同一条 `grep -n` 的完整输出逐字登记。
- [ ] AC3 承重断言未被削弱：`git diff develop -- e2e/resident-status-bar.spec.ts | grep -cE '^[-+].*(test\(|expect\(|test\.skip|retries|waitForTimeout)'` = **0**（diff 只允许出现两处定位行的改动）；`npx playwright test e2e/resident-status-bar.spec.ts --list` 退出 0 且仍列出 **4** 个用例、标题逐字未变。验证：两条命令逐字输出 + `--list` 的四个标题。
- [ ] AC4 承重假形态仍然红（本轮实测，逐字保留）：(i) 把侧栏标记 / 胶囊的状态源改成**本地镜像**（场景切换状态后不再跟随 `GET /api/session-hosts`）⇒ 判据退出**非 0**，红落在四态那条 `toHaveAttribute('data-resident-state', …)` 上；(ii) 把无人轮渲染成用户消息样式 ⇒ 判据退出**非 0**，红落在 `isUserStyle` 那条（`a turn nobody typed must not wear the user's own bubble style`）。两条都登记变异 diff、失败断言逐字、退出码；恢复后判据回 0。验证：两次变异跑与两次还原跑的 `echo $?`。
- [ ] AC5 边界：`git diff develop -- package.json playwright.config.ts` 为空；spec diff 不新增 `test.skip` / `retries` / `waitForTimeout`；`npm run typecheck` 退出 0；`git status --short` 在完成记录写入时只剩本任务文件与 spec。验证：四条命令逐字输出。
- [ ] AC6 记录如实：`goals/AC-172-真实浏览器里常驻会话的状态标记-状态条与关闭按钮反映宿主状态-无人轮带触发类型标签.md` 的 body **经 `goal_write`**（body 从 `goal_get` 读全量后再拼接，不从 worktree 直读）新增日期化修订记录 `## 修订记录（2026-10-24）`，逐字点名 `ff2998e9f`（SidebarModeSwitch 的 sessions 段指向当前路由、在 DOM 中先于会话列表）与两处定位的 `:not([data-mode-switch-link])` 修法；**不编辑 frontmatter**（`criterion` / `status: achieved` / `goal: GOAL-013` 逐字不动）。验证：`goal_get AC-172` 的 body 含该标题与该 commit hash，且 `criterion` 逐字为 `npx playwright test e2e/resident-status-bar.spec.ts`、`status: achieved`、`goal: GOAL-013`。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑 `npx playwright test e2e/resident-status-bar.spec.ts` 翻绿并把 pass 写进 `.quay/gate-events.jsonl`（AC-172 的台账尾部不再是 CURRENTLY FALSE）。AC1 的 `4 passed` 与 `elapsed=`、AC4 两条假形态的变异 diff / 失败逐字 / 退出码与还原读数一并写进完成记录。

完成记录必须如实写明：**不是**产品修复——AC-172 的产品保证（侧栏四态标记与 `GET /api/session-hosts` 逐态比对、胶囊面板的地址 / pid / 复制 / 起停关闭、停止只中止一轮、无人轮分隔标签 / 发送方 / 非用户样式）本轮探针实测全部成立（test 1 / 2 / 3 全过），探针 dump 里两份 `[data-resident-mark]` 就是它们仍在的证据；失效的是 test 1 的**量具**：`readMark` 的 `.first()` 被 `ff2998e9f` 新增的侧栏模式开关的 `/session/<当前 id>` 链接抢先命中，而该提交未回灌本 spec。⛔ 不许用改判据命令 / skip / retries / 删承重断言换绿；不许为凑绿往生产代码补标记；不许顺手改别的 spec。

L_D：该轴仍暗，理由：本任务只把一条 AC 判据的会话行定位跟着一次产品导航改动收尾，不产出新的领域判据，无可读的两轴读数。

## Touches

- e2e/resident-status-bar.spec.ts
- goals/AC-172-真实浏览器里常驻会话的状态标记-状态条与关闭按钮反映宿主状态-无人轮带触发类型标签.md
- tasks/gap-ac172-session-row-locator-shadowed-by-mode-switch.md