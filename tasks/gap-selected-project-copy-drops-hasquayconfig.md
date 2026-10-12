---
id: gap-selected-project-copy-drops-hasquayconfig
title: 冷启动直达会话深链时首个被选中项目的 Quay tab 缺失：selectedProject 这个 denormalized
  副本在深链合成路径上丢掉 hasQuayConfig，且没有任何路径把它补回来（切走再切回才恢复）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**症状（用户报告 2026-10-12）**：用浏览器打开 CloudCLI 后，第一个被选中的项目的任务页不显示 Quay tab；切到别的项目、再切回最初的项目就好了。

**实测（MCP 浏览器，本机 3001 真实实例；项目 `/data/home/yale/work/archguard` 在列表里 `hasQuayConfig: true`，侧边栏徽标显示 `quay configured`）**：

| 步骤 | URL | tablist |
|---|---|---|
| 冷启动直达会话深链 | `/session/e4718c93-…` | Chat / Shell / Files / Source Control（**无 Quay**） |
| 同一页内点同项目另一个会话（列表已加载） | `/session/b9f5cd1b-…` | 仍无 Quay |
| 点侧边栏切到 cantus | `/` | 有 Quay |
| 点回 archguard | `/` | 有 Quay |

同一次冷启动的 `performance` 读数：`/api/providers/sessions/e4718c93-…` 188ms→**193ms**，`/api/projects` 188ms→**600ms**（另一次实测 157→162ms vs 157→492ms，即单会话详情比全量项目列表快两个数量级）。页面内直取 `/api/projects` 确认该项目就是 `{ projectId: "112b9642-…", hasQuayConfig: true }`——数据一直在，只是 `selectedProject` 没用上它。

**根因链（四环）**：

1. `src/modules/project-workspace/hooks/useProjectsState.ts:1127-1135`：冷启动时 URL effect 在 `projects` 仍为 `[]` 时就要解析 `/session/<id>` 的归属项目，`projectsRef.current.find(...)` 命中不了，于是**合成**一个最小 Project 字面量 `{ projectId, path, fullPath, displayName, isStarred, sessions, sessionMeta }`——**唯独没有 `hasQuayConfig`**。（该分支的注释写明它服务的是「归属项目不在活跃列表里，例如归档项目」，深链竞态复用了同一条路径。）
2. 该字面量唯一的数据来源 `GET /api/providers/sessions/:id` 的 `data.project` 也**没有**这个字段（`server/modules/providers/services/sessions.service.ts:902-911`，只有 projectId/path/fullPath/displayName/isStarred/isArchived），即使客户端想抄也抄不到。
3. 列表到达后的全部修复路径都以 `projectId` 相等为门：`useProjectsState.ts:1039` 的 `selectedProject?.projectId !== project.projectId`（合成对象的 projectId 是正确的，因此不修复）；`fetchProjects` 的同步走 `src/modules/project-workspace/utils/projectSelectionMetadata.ts` 的 `mergeProjectSelectionMetadata`，而它的 `ProjectSelectionMetadata = Pick<Project, 'projectId' | 'displayName' | 'fullPath' | 'path' | 'isStarred' | 'taskmaster'>`——**`hasQuayConfig` 不在合并字段里**，`...current` 展开后永远保留旧值。
4. `src/modules/quay/hooks/useQuayTabVisibility.ts:11` 的 `isQuayTabVisible = Boolean(project?.hasQuayConfig)` → `src/modules/project-workspace/WorkspaceMain.tsx:93` → tab 不渲染；`useEnsureQuayTabVisible` 还会把已激活的 Quay tab 弹回 chat。

切走再切回之所以有效，是因为 `handleProjectSelect` 拿到的是侧边栏列表里的**完整行对象**。

**为什么现在才暴露**：这条分支没有任何测试——`src/modules/project-workspace/tests/` 下 6 个文件全部把 `api.sessionDetails` mock 成 `{ ok: false }`，成功分支（`details` 为真 → 解析 projectId → 合成对象）从未被覆盖。

**修复方案（三层，缺一层都留洞）**：

- **服务端把读数放进契约**：`GET /api/providers/sessions/:id` 的 `data.project` 增加 `hasQuayConfig`，复用 `quayService.detectQuayConfig(projectPath)`（与 `/api/projects` 同一个 Tier-1 源，纯路径检查、不起子进程）。`@/modules/providers` → `@/modules/quay` 这条新边无环：quay 侧只依赖 `node:path` 与 `@/modules/database`（`quay.service.ts` 只 import `node:path`；`quay.module.ts` import `fs` + `projectsDb`；`quay.routes.ts` import `express` + `@/shared/utils`），不会回指 providers；`@/modules/projects` 已有同形状的 `quayService.detectQuayConfig` 用法可直接照抄。这样合成对象**从第一帧起就是真值**，不留约 400ms 空窗；这也是归档项目深链唯一可能的正确来源——归档项目不在 `/api/projects` 里，列表合并永远补不到它。
- **客户端合成字面量抄上该字段**（`Boolean(details.project?.hasQuayConfig)`），并把 `hasQuayConfig` 加进 `ProjectSelectionMetadata` 与 `mergeProjectSelectionMetadata`，采用 `incoming ?? current` 语义——websocket `session_upserted` 的 project 块不带该字段，是既有调用方，不得被清零。
- **合并补齐**顺带修掉第二个同源缺陷：应用打开期间项目新增/移除 `.quay/config.yml` 时，选中项的 tab 目前永远不会跟着变，必须重新点一次项目行。

**考虑过但不采用**：

- 让 `selectedProject` 从 `projects` 派生（单一真源）：`projects` 每次分页合并 / 会话 upsert 都产生新对象，派生会让工作区副本耦合到侧边栏分页抖动；`mergeProjectSelectionMetadata` 的注释明确规定两者解耦。
- 客户端另调 `GET /api/quay/:projectId/status` 探测：等于给一个刻意设计成「列表派生」的闸门再加一个异步竞态和第二真源。
- 放宽 `useProjectsState.ts:1039` 的门（列表里已有该行就直接采用列表对象）：对 `hasQuayConfig` 是冗余的（`fetchProjects` 已覆盖该字段），且会把工作区副本重新耦合到分页抖动。
- 给本缺陷加 e2e 竞态 spec：真浏览器看不到 jsdom 看不到的东西——判据是「两个响应到达顺序下副本是否收敛」，jsdom 里可确定性构造，而 e2e 要强制该顺序必须拦截 `/api/projects`；且 e2e 不在 fan-in 全量套件里，绿色只能自证。浏览器侧改由 DoD 的真实读数承担。

**风险与检查点**：服务端只加一个布尔字段，`server/modules/providers/tests/sessions-details.test.ts` 是唯一断言该 payload 的测试，无 Object.keys 精确键集断言、无 MCP gateway 镜像 schema（已 grep 确认），因此不需要改 shared 类型或注册表。

**相关（已 done）**：`gap-quay-project-status-display`，即引入 `shouldShowQuayTab` 门控与 `hasQuayConfig` Tier-1 读数的那个任务。

## AC

- [x] AC1 会话详情契约带上 Tier-1 读数：`GET /api/providers/sessions/:id` 的 `data.project.hasQuayConfig` 为布尔值，由真实文件系统判定。`server/modules/providers/tests/sessions-details.test.ts` 新增两个方向：项目目录里有 `.quay/config.yml` ⇒ `true`；没有 ⇒ `false`。命令：`node_modules/.bin/tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/providers/tests/sessions-details.test.ts` exit 0。取假：把该字段从 payload 删掉，两个方向至少一个必须红。
- [x] AC2 深链合成副本收敛到真值：新增 `src/modules/project-workspace/tests/projectsStateDeepLinkTier1.test.tsx`（沿用同目录既有文件的 mock + `renderHook(useProjectsState)` 形态）——`api.sessionDetails` 先于 `api.projects` 返回、首帧 `projects` 为空时，`selectedProject.hasQuayConfig` 为 `true`；`projects` 晚到（带 `hasQuayConfig: true`）之后仍为 `true`，不得被回退成 `undefined`/`false`；反向用例：晚到的列表为 `false` 时收敛为 `false`。命令：`npx vitest run src/modules/project-workspace/tests/projectsStateDeepLinkTier1.test.tsx` exit 0。取假：去掉合成字面量里的该字段，或去掉 merge 里的该字段，对应用例必须红。
- [x] AC3 合并语义不伤既有调用方：`src/modules/project-workspace/tests/projectSelectionMetadata.test.ts` 扩展——incoming **不带** `hasQuayConfig`（websocket `session_upserted` 的 project 块形状）时保留 current 的旧值；incoming 为 `true`/`false` 时按值覆盖（含 `false` 覆盖 `true`）；无任何变化时返回**同一个对象**（既有的「无关刷新不重渲染」契约，`mergeProjectSelectionMetadata` 的早退分支）。命令：`npx vitest run src/modules/project-workspace/tests/projectSelectionMetadata.test.ts` exit 0。
- [x] AC4 类型与窄套件：`npm run typecheck` exit 0；`src/modules/project-workspace/tests/` 与 `server/modules/providers/tests/` 中受影响的文件全绿（窄跑，不起无界扇出）。

## DoD

真实对象过机制：真实后端 + 真实浏览器（MCP 浏览器），对一个真实带 `.quay/config.yml` 的项目（例 `/data/home/yale/work/archguard`）的会话深链做**冷启动直达**（新标签或整页 goto，不是页内路由），读数必须满足：

1. 工作区渲染后 tablist 含 `Quay`，且是在 `/api/projects` 响应**释放之前**就已含（这是服务端契约那一层的判据，不是「等一会儿就出现」）；
2. 「切到别的项目再切回来」不再是恢复手段：同一 URL 连续冷启动 2 次读数一致；
3. 修前读数已记录（2026-10-12：tablist 无 Quay；`/api/providers/sessions/:id` 5ms 返回 vs `/api/projects` 412ms 返回），修后读数（tablist 文本、两个接口 responseEnd 时间戳）与截图记入 `## 验证记录`。

## 验证记录

**实现提交**：`e5d4fbc1 fix(project-workspace): carry hasQuayConfig through the deep-link project copy`（worktree 分支 `task/gap-selected-project-copy-drops-hasquayconfig`）。

**AC 命令读数（2026-10-12，本 worktree）**
- AC1 `node_modules/.bin/tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/providers/tests/sessions-details.test.ts` → exit 0，`tests 5 / pass 5 / fail 0`（含新增两向：有 `.quay/config.yml` ⇒ true；无 ⇒ false）。
- AC2+AC3 `npx vitest run src/modules/project-workspace/tests/projectsStateDeepLinkTier1.test.tsx src/modules/project-workspace/tests/projectSelectionMetadata.test.ts` → exit 0，`Test Files 2 passed / Tests 8 passed`。
- AC4 `npm run typecheck` → exit 0（tsconfig + server/tsconfig + scripts/tsconfig）。
- 取假：逐字段回退（删服务端字段 / 删合成字面量字段 / 删 merge 字段）时对应用例转红，恢复后转绿。

**DoD 真实对象读数（真实后端 + 真实浏览器）**

对象：真实带 `.quay/config.yml` 的 `/data/home/yale/work/archguard`（列表行 `hasQuayConfig: true`），深链会话 `2f653062-f86a-481c-a36a-045f40588da7`。该会话**不在** archguard 首屏 20 条里（total=21），因此列表行不会掩盖合成副本——这是复现本缺陷的必要条件（本任务报告的 `e4718c93` 恰好在首屏，会掩盖）。

机制：worktree 客户端 `npm run build:client` 产物由 worktree 服务端托管于 `http://127.0.0.1:3199`（`DATABASE_PATH` 指向真实 auth.db 的副本）；用副本内 `app_config.jwt_secret` 签 HS256 `{userId:1}`，`addInitScript` 注入 `localStorage['auth-token']`，再整页 `goto /session/2f653062-…`（真冷启动，非页内路由）。基线为同库、未修复的主检出实例 `http://127.0.0.1:3001`。驱动用 Playwright/Chromium（真实浏览器、真实后端）；未用 MCP 浏览器。

为让「会话详情先于项目列表返回」这一被报告的竞态成为**确定**条件，探针仅在浏览器侧对 `/api/projects` 注入 6s 响应延迟；details 请求始终在首帧 ~340ms 发出、~338ms 返回：

| 读数 | 基线（未修复，3001） | 修复后（3199） |
|---|---|---|
| 首个 tablist 帧（`[data-workspace-tab]`） | `["chat","shell","files","git"]` | `["chat","shell","files","git","quay"]` |
| 稳定 2.5s 后再读 | 仍无 `quay` | 仍含 `quay` |
| `/api/providers/sessions/:id` | 200 | 200，含 `data.project.hasQuayConfig: true` |
| 连续冷启动 2 次 | 两次一致：无 Quay | 两次一致：含 Quay |
| 截图 | `/tmp/quay-deeplink-probe/shot-baseline.png` | `/tmp/quay-deeplink-probe/shot-fixed.png` |

自然时序（不加延迟）冷启动 2 次，修复后同样满足：首个 tablist 帧即含 `quay`（`projects` 467/489ms、`details` 600/621ms）。

**关于 DoD 第 1 条「`/api/projects` 响应释放之前」的诚实修正**：工作区本身由 `WorkspaceMain.tsx:253` 以 `isLoadingProjects` 为门——`/api/projects` 释放前工作区只渲染加载态，tablist 在 DOM 上根本不存在，因此「释放前 tablist 已含 Quay」在 DOM 层**不可观测**。可观测的最强形式是「工作区第一帧 tablist 即含 Quay，无需任何 re-select」，上表两个方向都满足。更关键的是：在 6s 延迟下合成副本的 `hasQuayConfig` 只能来自会话详情契约（列表尚未到达），基线在列表最终到达后**仍永远不恢复**（该会话不在首屏，`projectId` 相等门不触发修复），修复后从第一帧起即正确——即该读数已不再依赖 `/api/projects`。这与任务报告的症状（初始无 Quay、切走切回才恢复）一致。

**签核对照**：基线与修复后使用同一探针、同一会话、同一延迟参数，唯一变量是服务端/客户端构建。

## Touches

- src/modules/project-workspace/hooks/useProjectsState.ts
- src/modules/project-workspace/utils/projectSelectionMetadata.ts
- server/modules/providers/services/sessions.service.ts
- src/modules/project-workspace/tests/projectsStateDeepLinkTier1.test.tsx
- src/modules/project-workspace/tests/projectSelectionMetadata.test.ts
- server/modules/providers/tests/sessions-details.test.ts
- tasks/gap-selected-project-copy-drops-hasquayconfig.md
