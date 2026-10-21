---
id: ADR-005
title: 会话级架构分析 tab——按需生成与内容寻址缓存
status: accepted
---
## 背景

用户需要为每个会话提供「本会话提到的代码文件/标识符」的架构图：在会话顶部 Quay tab 右侧新增 architecture tab，点击后显示基于 `.archguard` 缓存摘取相关文件/标识符并适当扩展生成的架构图，优先用 `.mmd` 渲染。

现状盘点（本 ADR 依赖的既有事实）：

- Tab 接线模板现成：`AppTab` 联合类型（`src/shared/types.ts:92`）+ `WorkspaceTabs.tsx` 的 `BASE_TABS`/条件 tab（QUAY_TAB 即模板）+ `WorkspaceMain.tsx` 的 `activeTab === 'quay'` 渲染闸 + `useQuayTabVisibility.ts` 的「gate 纯函数 + snap-back」。
- 渲染器现成：`src/modules/code-editor/markdown/MermaidDiagram.tsx` 懒加载 mermaid、`maxEdges: 5000`（注释明确为 ArchGuard 包图调大）；本分支另有 `.mmd` 预览施工。
- `.archguard` 缓存可离线查询：`query/manifest.json`（3 个 scope）；`query/<scope>/arch-index.json` 是预建邻接结构（`fileToIds`/`nameToIds`/`dependencies`/`dependents`/`relationsByType`/`cycles`，顶层 `archJsonHash` 是数据指纹）；`query/<scope>/arch.json` 是实体/关系全集（实体含 `type`/`sourceLocation`）。
- 传输现成：`GET /api/file-tree/projects/:projectId/files/content?path=` 直读任意项目内文件（`resolvePathInsideProject` 只防穿越、不套 gitignore），前端 `api.readFile` 已包装；但本 ADR 走更薄的服务端生成路径，见决策 2。

## 决策

1. 新增 architecture tab，门控为「项目存在 `.archguard/query/manifest.json`」——`Project.hasArchguardCache`（Tier-1，镜像 `hasQuayConfig`）。tab 失效时 snap 回 chat。

2. 按需生成，服务端生成、浏览器只渲染：点 tab 触发 `POST /api/architecture/graph`，server 读 `.archguard` 缓存、生成 `.mmd` 字符串直接作为响应体返回（不落盘），前端用 `MermaidDiagram` 渲染。浏览器永不直接读 `.archguard`。

3. 种子提取在 server、按 `sessionId` 读全量 transcript：复用 `sessionsService.fetchHistory(sessionId, {})`（`provider.routes.ts` 的全量 history 正本），不重实现 transcript 读取。种子 = tool_use 的 `file_path`（Read/Edit/Write/NotebookEdit）+ 与 `nameToIds` 精确命中的标识符 token（反引号代码块 + PascalCase/camelCase 词）。

4. 扩展 = 在 `arch-index.json` 的 `dependencies`/`dependents` 邻接上做双向 BFS（entity 级），默认 1 跳、带节点预算（截断返回 truncated）。生成器只需 `arch-index.json`；`arch.json` 仅在 entity 级需要 `type`/`sourceLocation` 样式时读取。种子解析按 scope 前缀拆分、跨 scope 合并。

5. 双粒度：file 级 + entity 级，一次响应一起返回（`mmd: { file, entity }`），前端本地切换、不重新请求。

6. 缓存内容寻址：`key = hash(projectId, sessionId, extractedSeeds, params, 各 scope archJsonHash)`。两层：解析层按 `archJsonHash` memoize 解析结果；结果层按全 key memoize（LRU、内存）。失效由键保证——种子列表更新即键变、`.archguard` 重新分析即 `archJsonHash` 变——无 TTL、无事件、无显式驱逐。

7. 诚实性：面板显示 `generatedAt`、未解析种子（unresolved）、截断提示（truncated）；架构图反映最近一次 ArchGuard 分析，不是 live working tree。

## 影响

- 新增 `server/modules/architecture/`（routes/service/module + tests），挂 `/api/architecture`。
- 新增 `src/modules/architecture/`（panel + hook + gate + i18n + tests）。
- server listing 与 `mcp-overview-tools` 增加 `hasArchguardCache`。
- 复用 `sessionsService.fetchHistory`、`MermaidDiagram`；不改变 `.archguard` 缓存格式。

## 非目标

- 全项目 package 概览（已有 `.archguard/output/overview/package.mmd`）。
- 变更影响/风险叠加层（`change_context`/`change_risk`）。
- 按需跑 archguard 分析（只读静态缓存）。
- `.mmd` 落盘（v1 是内存字符串；若要复用 CodeEditor 的 `.mmd` 预览再落盘）。