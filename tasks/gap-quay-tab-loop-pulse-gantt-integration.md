---
id: gap-quay-tab-loop-pulse-gantt-integration
title: Quay tab 嵌入 Loop pulse 5-lane 甘特图（消费 quay 发布的 dashboard-kernel）：被上游
  0.18.0 未发布阻塞，接口与集成方案已定稿
status: needs-human
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

### 去重（立案时实测，按机制）

claudecodeui 任务库检索 `loop pulse` / `gantt` / `dashboard-kernel` / `kernel`，只命中两条 **done** 的设计前置：
- `gap-quay-panel-stage-goals-tests-fanin-cards`（done）——补齐了另外四张卡，**明确搁置** Loop pulse。
- `gap-quay-tab-loop-pulse-gantt-cross-project-interface-design`（done）——消费侧设计记录（接口形状、必须保留的语义、归属判断、后端数据缺口清单）。

没有任何任务认领"真正实现这张卡"，故本条不是重复，是其下游实现。

### 上游状态（2026-10-09 实测，非纸面）

**算法已实现并合入 `develop`，但没有发布。** 逐条取证：

| 事实 | 证据 |
|---|---|
| kernel 源文件存在 | `/data/home/yale/work/quay/packages/quay/src/dashboard-kernel.ts`（7873 B） |
| `exports` 已暴露子路径 | `packages/quay/package.json` 有 `"./dashboard-kernel"`（`types`→`src/*.ts`、`default`→`dist/*.js`）与 `"./dashboard-kernel/vectors"`→`src/dashboard-kernel-vectors.json` |
| 实现已合入 | `git merge-base --is-ancestor 2a894daf4 origin/develop` → 真 |
| **但没有发布** | `git tag --sort=-v:refname \| head -1` → **`v0.17.0`**；github marketplace checkout（`yaleh/quay`）HEAD `09551db`，其 `packages/quay/src/dashboard-kernel.ts` **不存在** |
| **插件产物里也没有** | `plugin/vendor/quay/dist/dashboard-kernel.js` 在 quay 自己的工作树（0.18.0-dev）里**不存在**；`plugin/vendor/quay/package.json` 的 exports **无** kernel 条目 |
| npm 渠道不可用 | `npm view quay` → `0.6.0`（**不相干**的第三方同名包）；`@yalehwang/quay` → 404。quay 的 npm/SEA 渠道已按裁定退役 |
| 无发布任务在飞 | quay 任务库 `--status ready/todo --search release` → 0 条 |

### 消费机制（用户 2026-10-09 裁定）

不复用 vendor、不用 `file:` 依赖（后者会毒化已发布的 `@yalehwang/cloudcli`）。走 quay 自己的正式发布流程：

1. quay 出正式发布到 github（tag + 插件产物重建，含 `vendor/quay/dist/dashboard-kernel.js`）。
2. 安装到 user scope。
3. ClaudeCodeUI（及其它试用 quay 的项目）**启动新会话**，跑 `/quay:init` 完成升级——`.quay/plugin` 符号链接随之指向新插件版本。

消费点：`<projectRoot>/.quay/plugin/vendor/quay/dist/dashboard-kernel.js`（与后端现有解析 quay CLI 的 `.quay/plugin` 同一条路径约定）。

**本任务当前被第 1 步阻塞**：不存在任何含 kernel 的已发布插件版本，所以无法安装、无法 `/quay:init`、无法针对真实产物写可测的集成代码。在发布落地前动工只会产出跑不通的半成品。

### 接口（已定型，发布落地后直接照此接入）

```
import { FIXED_GANTT_LANES, mergeLiveAndHistoryIntervals, packLanes,
         LIVE_INTERVAL_PHASES, LIVE_INTERVAL_FINAL_STATES } from 'quay/dashboard-kernel';

const merged = mergeLiveAndHistoryIntervals(inFlight, historyRecords, windowStartMs, nowMs);
const { lanes, overflow } = packLanes(merged);
```

- `FIXED_GANTT_LANES = 5`；`packLanes` 贪心装箱，**超出 5 车道的区间被剔除并计入 `overflow`**（不丢弃语义由消费方负责渲染 "+N more"）。
- `mergeLiveAndHistoryIntervals`：在飞 + 历史合并、按时间窗口过滤、按 `(taskId, startMs)` 去重。
- `inFlight` 时间戳与所有 `expected*` 为 **epoch ms**；`records` 的 `started_at`/`ended_at` 是 **ISO 字符串**（worker-outcome 载体原格式）——不要混用。
- 内核**不发布**配色：只发布"有哪些状态"，`phase`/`finalState` → 颜色的映射由本仓库自己的 Tailwind 语义色决定。
- 契约测试向量：`quay/dashboard-kernel/vectors`（JSON，需 `with { type: "json" }` 导入属性，缺了会 `ERR_IMPORT_ATTRIBUTE_MISSING`）。

### 必须保留的语义（来自已完成的设计记录，不得简化）

5 车道固定 / overflow 计数 + "+N more" / 历史+在飞合并 / 时间窗口 1h·3h·6h·12h（默认 3h，切换即重新过滤数据源而非纯视觉缩放）/ 按 phase·finalState 着色 / 每块原生 `<title>` 为 `taskId · state · duration · start→end`。

### 后端数据缺口（设计记录已列，此处转为 Touches）

1. `QUAY_READ_ONLY_COMMANDS` 白名单加 `driver live --kind worker --json`（现有白名单只有 `driver status`，无 `live` verb）。
2. `collectSnapshot` 调该命令取在飞区间；现有 `inFlight` 字段来自 `.quay/worker-round.jsonl` 最后一条心跳（另一条更轻的既有实现），本卡需要的是**区间**——复用还是新开字段由实现定。
3. `summarizeFanInAttempts` 补 `started_at`/`ended_at`/`final_state`/`run_id`，且读取方式从 count-10 尾部截断改为**按时间窗口过滤**。
4. `QuaySnapshot` 增区间数组字段（当前无此形状）。
5. **车道计算放后端**（用 kernel），前端只渲染——避免前端 bundle 外部路径，也让五条语义只有一处实现。

<!-- dedup-ref -->
**与既有已完成任务的关系（不是重复）**：`gap-cloudcli-quay-snapshot-inflight-tasks` / `gap-quay-panel-inflight-task-display`（均 done）做的是"当前在飞**一条**读数"及其渲染；本卡做的是**区间甘特**（历史+在飞、多车道、时间窗口），数据形状与语义都不同。

## AC

- [ ] AC1 **前置解除取证**：`git -C /data/home/yale/work/quay tag --sort=-v:refname | head -1` 指向一个含 kernel 的版本；`<projectRoot>/.quay/plugin/vendor/quay/dist/dashboard-kernel.js` 实际存在（`ls -l` 贴出），且 `readlink -f .quay/plugin` 指向该版本目录。**这三条不成立则本任务不具备开工条件**，不得以自建产物或 vendor 副本绕过。
- [ ] AC2 **等价性证明（契约向量回放）**：新增测试从 `quay/dashboard-kernel/vectors`（或 `.quay/plugin` 内同源文件）读向量，对每条断言 `mergeLiveAndHistoryIntervals` 与 `packLanes` 的输出**逐字相等**（`deepEqual`）。这是"我真的在跑 quay 同一套算法、不是长得像的复刻"的唯一证据。
- [ ] AC3 **后端产出区间**：`GET /api/quay/:id/snapshot` 的响应里含车道数据（`lanes` 数组 + `overflow` 计数 + 时间窗口参数），且 `warnings` 不因 kernel 加载失败而静默退化成空数组（加载失败必须是**可区分的**读数，不能与"没有区间"同形）。
- [ ] AC4 **五条语义逐条可判**：(a) 车道数 ≤ 5 且超载计入 `overflow`；(b) 历史与在飞同时出现在同一窗口内的正确车道；(c) 切换 1h/3h/6h/12h 会改变入选区间集合（非纯缩放）；(d) phase/finalState 映射到**互相不同**的颜色类；(e) 每块带 `taskId · state · duration · start→end` 的 `<title>`。
- [ ] AC5 **overflow 不静默丢数据**：`overflow > 0` 时渲染可见的 "+N more"，且该数与后端 `overflow` 逐字一致。
- [ ] AC6 `npm run typecheck` 退出 0；相关窄测试全绿（按仓库既有 runner，不起无界扇出——见 `docs/operations/process-isolation-and-memory-caps.md`）。
- [ ] AC7 `git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

真实对象上跑通，不是只有 fixture 绿：在真实运行的 CloudCLI 上打开一个有真实 worker 活动的 quay 项目的 Quay tab，甘特图渲染出真实区间（与同一时刻 `quay driver live --json --root <project>` 的在飞集合对应），车道/颜色/overflow/tooltip 与 quay 自己的 dashboard "Loop pulse" 卡在同一时间窗口下**语义一致**（允许配色不同——本仓库用自己的 token）。用真实浏览器（非 jsdom）读数。

## Touches

- package.json（若最终确需声明 kernel 来源依赖；否则不动）
- server/modules/quay/quay.service.ts
- server/modules/quay/tests/quay.service.test.ts
- src/modules/quay/LoopPulseGantt.tsx (new)
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/quay/tests/LoopPulseGantt.test.tsx (new)
- src/shared/types.ts
- tasks/gap-quay-tab-loop-pulse-gantt-integration.md (self-touch)

## Notes / 阻塞

**当前阻塞**：上游 kernel 已合入 `develop` 但**未发布**（最新 tag `v0.17.0`，插件产物无 kernel，npm 渠道已退役，无发布任务在飞）。用户裁定的路径要求 quay 先出正式发布 → 安装 user scope → `/quay:init`。**第 1 步未发生，故本任务暂不可开工。** 解除条件见 AC1。

不建议的绕法（已评估并否决）：vendor 源码副本、`file:` 依赖指向本地 checkout（会把机器本地绝对路径写进已发布的 `@yalehwang/cloudcli`，对所有消费者致命）、自建 tarball 提交进仓库。用户已明确选择走正式发布渠道。

## 阻塞复核（worker round · 2026-10-09）

AC1 前置复核：**三条全部不成立 ⇒ 本任务不具备开工条件**，按 worker 协议 park 为 `needs-human`（**本轮未做任何实现**；任务明文禁止 vendor 副本 / `file:` 依赖 / 自建产物等绕法）。

- 条件1 `git -C /data/home/yale/work/quay tag --sort=-v:refname | head -1` → `v0.17.0`：kernel 合入 develop 后**无任何含 kernel 的新 tag**。
- 条件2 `<projectRoot>/.quay/plugin/vendor/quay/dist/dashboard-kernel.js`（`ls -l`）→ **No such file or directory**。
- 条件3 `readlink -f .quay/plugin` → `/data/home/yale/.claude/plugins/cache/quay/quay/0.17.0`，其 `vendor/quay/dist/` 仅 `quay.js`（无 kernel）⇒ 指向的不是含 kernel 版本。
- 旁证：plugin cache 最新为 0.17.0（0.10.0/0.11.0/0.14.0/0.15.0/0.16.0/0.17.0 均无 kernel）；kernel 源码仍仅存在于 quay 工作树 `packages/quay/src/dashboard-kernel.ts`（未发布）。

AC 读数：AC1 不成立 ⇒ **AC2–AC7 全部未勾选**（均依赖已发布 kernel 产物，无可验证的实现）。**解除条件**：quay 出正式发布（含 kernel 的 tag + 插件产物 `vendor/quay/dist/dashboard-kernel.js`）→ 安装 user scope → 新会话跑 `/quay:init` → 之后重跑本卡。
## Update（2026-10-09）：复检否证了"发布即解除"——kernel 根本不在发布产物里

上文把解除条件写成"quay 出 0.18.0 发布"。按用户裁定去核对发布渠道时，**这个假设被否证**：kernel 即便发布也不可达。

- 新增 quay 任务 `gap-dashboard-kernel-not-packaged-in-plugin-artifact`（`/data/home/yale/work/quay`，todo），含逐环节取证与 AC。
- 根因两条：① `plugin/scripts/sync-vendor.sh` 按**文件名逐个** cp（`dist/quay.js`、`quay-native.js`），**不镜像 `dist/` 整目录** ⇒ `dist/dashboard-kernel.js` 永远到不了 `plugin/vendor/quay/dist/`；② 同脚本 §6 把 vendor `package.json` 重写成 `{name, version, private, type}`，**`exports` 被整个丢掉**。
- 实测 `find plugin/vendor/quay -type f` → 只有 `package.json` 与 `dist/quay.js` 两个文件（无 kernel、无向量）。
- 安装渠道确认：`.claude-plugin/marketplace.json` 的 `quay` 插件 source = `github: yaleh/quay` @ `ref: dist-plugin`；`publish-dist-branch.sh` rsync 整棵 `plugin/`。**plugin/ 里没有的，装了也没有。**
- 上一轮 `gap-dashboard-kernel-export-for-cross-project-reuse` 的 AC1 用 **`npm pack` + `/tmp` 独立 consumer** 证明子路径可解析——那条路径走 `packages/quay` 的 `files` 白名单，**绕开了 `plugin/vendor`**，所以没暴露这个缺口。两条打包逻辑不同，被证明过的是不通的那条。
- 已把发现与所需步骤同步给 quay 会话 `Quay Dashboard Kernel 架构决策`（该主题的对应会话）。

**AC1 修正（以此为准）**：解除条件**不是**"存在含 kernel 的 tag"，而是——

1. `<projectRoot>/.quay/plugin/vendor/quay/dist/dashboard-kernel.js` 在**已发布的插件**里实际存在（`ls -l` 贴出）；
2. 契约向量文件在该插件镜像里可达（消费者等价性测试依赖它）；
3. `readlink -f .quay/plugin` 指向的版本目录里上述文件确实存在。

只满足"有新 tag"不构成解除证据；在 `gap-dashboard-kernel-not-packaged-in-plugin-artifact` 落地前，本任务**不具备开工条件**（不得以 vendor 副本、`file:` 依赖或自建 tarball 绕过——用户已明确排除）。

## Update 2（2026-10-09）：交付机制进入 A/B/C 人工裁决，方案 A 会改变本任务的形态

上游会话 `Quay Dashboard Gantt Kernel 架构决策` 独立复核了打包缺口（结论一致，并纠正若干细节，详见 quay 任务 `gap-dashboard-kernel-not-packaged-in-plugin-artifact` 的 Update 段）。要点：

- 从**版本化插件缓存路径** import（`~/.claude/plugins/cache/quay/quay/<version>/vendor/quay/dist/…`）结构上脆弱：版本目录每次升级都变，且位于本项目构建图之外。**这使"按路径 import 插件镜像"方案的吸引力下降。**
- `/quay:init` 结构上不可能提供可导入模块（`plugin/skills/init/SKILL.md:9`："init is a project initializer, NOT an installer"）。
- quay 的 CI 当前是红的（最近 8 次完成的 develop 运行中 6 failure / 2 cancelled），**这是独立于本任务的发布门禁**。

**三种交付机制正在由人工裁决**：

- **A. quay CLI 直接输出 merged+packed lanes 的 JSON**（消费方 shell 出去取，与既有 `quay driver live --json` 同模式）。
- **B. 从插件镜像按路径 import**（受上述脆弱性影响）。
- **C. 恢复 GitHub Release tarball asset**（需人工同意，反转 2026-09-16 的渠道裁定）。

**方案 A 对本任务的影响（预判，等裁决后定稿）**：若选 A，本任务的形态变简单而非变复杂——

1. 后端不再需要"加载 kernel 模块"，而是**新增一个只读 CLI 动词的调用**（放进现有 `QUAY_READ_ONLY_COMMANDS` 白名单，与 `task list`/`goal list`/`driver live` 同一条 `execFile` 通路）——与本任务上文已定的"**车道计算放后端**"决策**一致**，属于缩小改动面。
2. **AC2 的形态要换**：不再有"本地副本 vs 上游算法的等价性回放"（我们根本没有本地副本，直接消费 quay 自己的输出），风险转移到"该 CLI 动词存在且返回文档化形状"。契约向量届时更适合当作**渲染层的 fixture**（车道数/overflow/状态分布的样例数据），而不是等价性证明——具体在裁决后改写 AC2。
3. AC1 的解除条件相应变为"**该 CLI 动词在已发布插件里可用**"（而非"kernel 文件存在"）。

在裁决落地前不动集成代码。若最终选 B，则上文 Update 1 的三条前置仍然适用；若选 A，前置换成"CLI 动词已发布"；若选 C，前置是"tarball 可安装且 `exports` 完整"。

## Progress（2026-10-10）：前端与契约已交付（commit `7fe72e71`），后端仍被上游阻塞

按用户指示：不等 0.18.0 发布，先做所有可独立开发的部分。已完成并提交的部分：

**交付物（commit `7fe72e71`，落在主检出的 `develop` 上，6 files / +708 −1）**

- `src/shared/types.ts`：新增 `QuayGanttInterval` / `QuayGanttLanes`，**逐字段镜像 quay `dashboard-kernel` 的 `LiveGanttInterval` 与 `packLanes` 输出**（`taskId`/`runId`/`startMs`/`endMs`/`phase`/`finalState`/`fanInOutcome`；`{windowHours, nowMs, lanes, overflow}`）。`QuaySnapshot.gantt` 为**可选**——后端尚不产出该读数（需要已发布、能提供打包 lane 的 quay 构建），注释写明 present-and-null 与 absent 同义，且**都不得读成"没有区间"**。
- `src/modules/quay/LoopPulseGantt.tsx`（new）：纯渲染组件。**不重新实现装箱/合并**（那正是消费 kernel 要避免的第二份实现）。
- `src/modules/quay/QuayPanel.tsx`：新增 Loop pulse 卡；`gantt` 缺失时渲染**显式不可用文案**而非空图（空图会读成"什么都没跑"，是另一个语义）。
- `src/modules/quay/tests/LoopPulseGantt.test.tsx`（new，11 例）+ `QuayPanel.test.tsx`（+2 例）。

**五条语义的落点（全部有判据）**：① 固定 5 车道——**无论窗口多空都画 5 条参考线**（车道数是视觉契约，不是"占用了几条"）；② `overflow` 渲染为可见 "+N more"（quay 故意丢弃无空闲车道的区间，所以 `lanes` 单独并不覆盖整个窗口）；③ 历史与实时同图——同一窗口内 `phase` 与 `finalState` 两种 bar 并存，且**每个状态一个独立颜色类**，无 phase/finalState 者落到显式 `unknown` 而非被丢掉；④ 时间窗口——选择器仅在调用方能真正重过滤时渲染（可见却无效的控件比没有控件更糟），`onWindowChange` 已实现并测；⑤ 每根 bar 的原生 `<title>` 为 `taskId · state · duration · start→end`，区间按窗口**钳制**（否则长区间会被画到画布外而完全不可见）。

**测试证据**
- `npx vitest run src/modules/quay/tests/` → **39/39 passed**（4 files）。
- `npm run typecheck` 退出 0；`npx oxlint src/` 退出 0（warning 均为仓库既有）。
- **真实浏览器验收**（`e2e/zz-quay-panel-mobile-grid.spec.ts` 新增第二例，复用该文件既有的 quay fixture 项目与登录/导航机制）：把 lane payload 注入**真实 snapshot 响应**，在 390px 与 1280px 两次读渲染结果——`5` 条 lane、`4` 根 bar、`+2 more`、`data-state="implementing"` 1 根与 `completed` 2 根。几何读数：手机 `svgWidth 358 / panelScrollWidth 390`；桌面 `svgWidth 471.5 / panelScrollWidth 991`；两面 `aspectRatio` 同为 `5.66`（等比缩放，坐标轴文字不拉伸）。**整文件 2/2 passed**（既有那一例未回归，且其网格读数里已出现 `Loop pulse` 块，宽度与同格其它块一致）。
- 顺带修：`seedFixtureProject` 的 `.quay/plugin` 符号链接改为幂等（同一 spec 现在有两个用例，第二个会撞 EEXIST）。

**仍阻塞（本任务未完成的部分）**

后端 `collectSnapshot` 仍需产出 `gantt`，前提是上游能提供打包后的 lane：要么 quay 发布含 kernel 的插件（`gap-dashboard-kernel-not-packaged-in-plugin-artifact` 先落地），要么采纳 CLI 动词方案（A/B/C 待人工裁决）。**在此之前不写后端**——写了也跑不通，且会引入被明确排除的 vendor / `file:` 绕法。

**验收边界（如实说明）**：e2e 里的 lane payload 是**注入**的，不是后端产出的——所以它证明的是"卡片在真实浏览器里对这份契约的渲染与布局正确"，**不**证明"后端已接通"。后端接通后的端到端验收（真实 `quay driver live` 区间 → 真实 lane → 卡片）仍待上游解除。

## Update 3（2026-10-10）：上游缺口已实际解除（实测复核；Update 1 的否证结论现已过期）

按 Update 1 修正后的 AC1 逐条复核，**三条前置现在全部成立**：

- **发布**：quay 仓 `git tag --sort=-v:refname | head -1` → `v0.18.0`（2026-10-10 10:38 +0800）；上游那条打包缺口的任务已是 `done`。
- **发布产物**：dist-plugin 分支的插件镜像里 `vendor/quay/dist/dashboard-kernel.js` 与 `vendor/quay/dist/dashboard-kernel-vectors.json` 都在（`git ls-tree -r --name-only origin/dist-plugin` 实测）。
- **本机已装**：插件缓存 `…/.claude/plugins/cache/quay/quay/0.18.0/vendor/quay/dist/` 里两文件实测存在（dashboard-kernel.js 2060 B、dashboard-kernel-vectors.json 9637 B）——即 Update 1 里「kernel 即便发布也不可达」的结论已被上游修好。

**唯一仍未成立的**：本项目的 `.quay/plugin` 符号链接仍指向 `cache/quay/quay/0.17.0`（该版本无 kernel）⇒ AC1 条件 3 不成立。把该链接指向 0.18.0（或重跑 `/quay:init`）即可满足条件 1–3。

**仍待人工裁定（Update 2 的 A/B/C 未作出）**：A（只读 CLI 动词）/ B（按路径 import 插件镜像）/ C（GitHub Release tarball）。0.18.0 的落地使 **B 由「不可行」变为「当下可行」**，但 Update 2 记录的结构性脆弱性（版本目录每次升级都变、位于本项目构建图之外）不变；若选 A，AC1 的解除条件换成「该 CLI 动词在已发布插件里可用」，AC2 形态随之改写。**裁决落地前不动后端集成代码**（前端与契约已在 `7fe72e71` 交付）。

## Update 4（2026-10-10）：交付机制裁决定为 A（只读 CLI 动词）；AC1/AC2 形态随之改写

人 yale 裁定：采用 **A — quay CLI 直接输出 merged+packed lanes 的 JSON**（消费方 shell 出去取，与既有 `quay driver live --json` 同模式）。B、C 不采用。

**AC1 的解除条件（以此为准，取代 Update 1 / Update 3 里的写法）**——只读 CLI 动词在**已发布并安装**的插件里可用：

1. `quay <verb> --json` 在 `.quay/plugin` 指向的那个版本里存在且 exit 0（⛔ 只认已发布版本的动词，不认本地 checkout、不认版本化绝对路径 import——后者正是机制 B）；
2. 输出形状与本任务 `src/shared/types.ts` 的 `QuayGanttLanes` **逐字段一致**：`{windowHours, nowMs, lanes[], overflow}`，区间字段 `taskId` / `runId` / `startMs` / `endMs` / `phase` / `finalState` / `fanInOutcome`；
3. 该动词走既有只读通路（与 `task list` / `goal list` / `driver live` 同一条 `execFile` 白名单），⛔ 不是新机制。

**AC2 的形态改写（取代原「本地副本 vs 上游算法的等价性回放」）**——不再有等价性证明，因为我们**没有**本地副本，直接消费 quay 自己的输出：

- **正向**：在真实 workspace 上跑该动词，返回的 `lanes` / `overflow` 与同窗口的 `quay driver live --json` 语义自洽——每条 `lanes[].runId` 要么能在 live 的 in-flight 集合里找到，要么带 `finalState` 表示已结束；
- **反向（取假必红）**：把动词输出的 `lanes` 置空但保留 `overflow` ⇒ 卡片必须渲染 `+N more` / 显式不可用文案，⛔ 不得渲染空图（`LoopPulseGantt.test.tsx` 已有对应用例，把它接到这条上）；
- 契约向量文件降级为**渲染层 fixture**（车道数 / overflow / 状态分布的样例数据），不再是等价性证明。

**上游前置（尚不存在）**：0.18.0 实测只有 `quay driver live`，它只报 in-flight worker，**不输出 packed lanes** ⇒ 需在 quay 仓新立一条任务，并在其发布后回来解除本任务。在此之前本任务保持 `needs-human`；⛔ 不得以 vendor 源码副本、`file:` 依赖、自建 tarball 或按版本化绝对路径 import 绕过（前两条用户已明确排除，最后一条按本裁定属机制 B）。
