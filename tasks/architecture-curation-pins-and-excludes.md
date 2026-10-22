---
id: architecture-curation-pins-and-excludes
title: 手动调整：搜索加入（钉住）与移除/隐藏，撤销、管理弹层、按会话本地持久化，失效项按 (文件, 名字) 重新对应
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-dock-and-inspector
  - architecture-element-and-relation-filters
---
## Proposal

用户确认的模型（2026-10-22）：「能加就要能删」。实体有三种状态，关系有两种：

| 对象 | 状态 | 进入 | 离开 |
|---|---|---|---|
| 实体 | 自动（默认） | 默认 | 移除 → 已移除 |
| 实体 | **已钉住**（手动加入） | 项目搜索里点「加入」 | 取消钉住 |
| 实体 | **已移除** | 移除自动出现的实体 | 还原 |
| 关系 | 自动 / **已隐藏** | 隐藏 | 还原 |

### 一、语义

- **已移除的实体**在遍历之前就被拿掉：BFS 不穿过它，它的边一并消失；它覆盖一切筛选，只有「还原」能让它回来。直接提及的种子也允许移除，计入管理弹层。
- **已钉住的实体**是根（`distance 0`，`mentionTier: 'pinned'`，比 `direct` 更强），免受元素/关系筛选与详情裁剪影响，范围步进器照常从它向外扩；菜单里有「只显示它自己」（该钉住项不向外扩）。
- 钉住与移除互斥，后做的覆盖先做的。
- **取消钉住**时，若它仍与别的节点相连（或是自动可达），提示「已取消钉住；它仍因与 X 相连而在图中」，避免以为没删成。
- **隐藏关系**只是显示层面的，文案写明「只隐藏显示，不改代码」，不叫「删除」。

### 二、服务端

- `POST /api/architecture/graph` 新增可选参数 `extraSeeds`（实体 id 数组，上限 200）与 `excludeIds`（实体 id 数组，上限 500）；缺省 = 旧行为。`extraSeeds` 与会话种子合并为根；`excludeIds` 在遍历前从图中移除。缓存键包含两者（排序后）。响应的 `unresolved` 追加 `ids`（解析不到的 `extraSeeds`，供客户端标「已失效」）；`stats` 追加 `curation: { pinned, excluded }`（实际生效数）。隐藏关系是纯客户端显示，不进请求。
- 新增 `POST /api/architecture/search`：请求 `{ projectId, query, limit?, kinds? }` 与 `{ projectId, resolve: [{ name, file }] }` 两种形态；前者返回整个项目索引（跨 scope）里匹配的实体 `{ id, name, kind, file }`（最多 20 条，排序：精确 > 前缀 > 子串，并带 `truncated`），查询至少 2 个字符；后者按 `(file, name)` 精确查回**当前**的 id，用于重新分析后重新对应失效项。沿用 `authenticateToken`，实现文件放同一模块目录内（`search.ts`），不新建目录、不 import 兄弟模块；不新增服务端测试文件（并入既有 `architecture-routes.test.ts` / `generator.test.ts` / `cache-invalidation.test.ts`）。

### 三、客户端

- **存储** `src/modules/architecture/curationStore.ts`：`localStorage` 键 `architecture.curation.v1:<projectId>:<sessionId>`，值 `{ pins: [{ id, name, file, kind }], excluded: [同形], hiddenEdges: [{ from, to, type }] }`；不只存 id——重新分析后 id 可能变，所以同时存 `(file, name)`。找不到的项标「已失效」留在管理弹层，由用户清除，**不静默丢弃**。上限钉住 200、移除 500、隐藏关系 500，超出时提示。没有 `sessionId` 时整个调整功能禁用并说明原因（存储键依赖会话）。撤销栈深 20，`Ctrl/Cmd+Z`（画布聚焦时）撤销最近一次调整。
- **项目搜索（加入）**：工具栏搜索框的第二组结果「项目其它」（第一组「图中」是本地跳转，由工具栏任务提供）；每行 `种类图标 名字 文件路径 ＋`，`Shift+Enter` 与 `＋` 都是钉住；状态：空闲、加载中（输入框内转圈）、无匹配、出错（重试）、截断（「仅显示前 20 项，请缩小关键词」）。输入防抖 200ms。
- **移除/取消钉住/隐藏**：检查器与画布右键/长按菜单里的按钮；键盘选中后 `Delete`/`Backspace`（画布聚焦时）。每次操作弹 Toast（`role="status"`，「撤销」可聚焦，6 秒，悬停或聚焦时暂停），不弹确认框。
- **管理弹层** `已调整 N 项 ▾`（工具栏，N 为钉住 + 已移除 + 已隐藏关系之和）：三页「钉住 / 已移除 / 已隐藏关系」，每行一个「还原」，页底「全部还原」（用 `text-destructive` 仅限该按钮）；已失效的项带「已失效」徽标与「清除」。手机档位进底部抽屉。
- **读数**：筛选读数行追加「已手动移除 N 项 · 已钉住 N 项」；钉住的节点带图钉角标，不只靠颜色。
- **与筛选的次序**：已移除 > 一切筛选；已钉住 免于 元素/关系筛选与详情裁剪（与 `direct` 同级之上）。

## AC

- [x] `npx vitest run src/modules/architecture/tests/curationStore.test.ts` exit 0（新文件）：钉住/移除互斥且后做的覆盖先做的；撤销栈深 20 与顺序；上限与超出提示；存储键按 `<projectId>:<sessionId>` 隔离、换会话不串；没有 `sessionId` 时拒绝写入；读到损坏的 JSON 时回落为空并不抛错；`(file, name)` 重新对应：给定 `resolve` 的返回，失效项被更新为新 id，仍找不到的保持「已失效」
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/generator.test.ts server/modules/architecture/tests/architecture-routes.test.ts server/modules/architecture/tests/cache-invalidation.test.ts` exit 0：`excludeIds` 的节点不被遍历穿过、其边消失；`extraSeeds` 作为根且 `mentionTier === 'pinned'`、在 `kinds/relations` 筛选下仍保留；缓存键因这两个参数不同而不同、相同组合第二次不重算；解析不到的 `extraSeeds` 出现在 `unresolved.ids`；不带这两个参数时响应与改前逐字节相同；超上限返回 400；`/search` 的前缀/子串排序、`truncated`、不足 2 字符返回 400、`resolve` 形态按 `(file, name)` 精确返回当前 id、未登录 401
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：搜索「项目其它」组出现并可钉住，钉住后图重新请求且该节点带图钉角标；移除自动实体后图里不再出现它及其边，Toast 带「撤销」，点撤销后恢复；`Delete` 键移除所选且 `chat.abort` 调用计数为 0；取消钉住但仍相连时的提示文案；隐藏关系只改显示（无网络请求）并写明「不改代码」；`已调整 N 项` 弹层三页各行「还原」与「全部还原」；已失效项显示徽标与「清除」；没有会话时功能禁用并说明；换会话后调整集不串
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（12 个 locale 文案键齐全）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（PC）打开 quay 会话 architecture tab：在搜索框里输入一个当前图里没有的类名，选「项目其它」里的一项加入，图随之出现该节点并带图钉；再选中一个自动出现的节点按 `Delete`，它与它的边消失，Toast 的「撤销」能把它找回；刷新页面后两个调整都还在；打开 `已调整 N 项` 能看到钉住与已移除两页并逐条还原。再模拟重新分析（改动 `.archguard` 的 hash 或清缓存）后，钉住项按 `(文件, 名字)` 重新对应或标为「已失效」（贴 `unresolved.ids` 与弹层截图）。手机视口（390×844）重复「搜索加入、移除、撤销」。证据是操作前后节点数读数、`stats.curation` 与截图。

## Touches

- server/modules/architecture/generator.ts
- server/modules/architecture/service.ts
- server/modules/architecture/routes.ts
- server/modules/architecture/cache.ts
- server/modules/architecture/search.ts (new)
- server/modules/architecture/index.ts
- server/modules/architecture/tests/generator.test.ts
- server/modules/architecture/tests/architecture-routes.test.ts
- server/modules/architecture/tests/cache-invalidation.test.ts
- src/modules/architecture/curationStore.ts (new)
- src/modules/architecture/ArchitectureCurationManager.tsx (new)
- src/modules/architecture/hooks/useProjectSearch.ts (new)
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/ArchitectureInspector.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/elementRelationFilter.ts
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/tests/curationStore.test.ts (new)
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- src/shared/api.ts
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- tasks/architecture-curation-pins-and-excludes.md