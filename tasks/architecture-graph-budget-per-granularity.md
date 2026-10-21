---
id: architecture-graph-budget-per-granularity
title: 图预算按粒度独立：file 图不被实体截断连带 + 逐粒度截断提示 + hops 旋钮
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

quay 项目会话打开 architecture tab 仍显示「Node budget reached — this graph is truncated.」，且此前的数量/层级操作退化。根因是**服务端截断发生在客户端 LOD 之前，两层打架**：

- `DEFAULT_HOPS=2`、`DEFAULT_MAX_NODES=2000`（`service.ts:63/71`）；
- 截断施加在**实体集**上，file 图只是截断后实体的投影（`generator.ts:492/495`：`fileNodes = [...new Set(retained.map(idToFile))]`）——所以实体截断会连带砍掉 file 视图；
- `truncated` 是**单一布尔**，面板不看当前粒度就显示旧提示（`ArchitecturePanel.tsx:76`）。

实测 quay 两个会话：种子实体 75 / **611**；1 跳 524 / **2910**；2 跳 1927 / **6169**（上限 2000）。第二个会话在 1 跳就已截断，客户端爆炸图拿到的是残缺层级。

修法：① **file 图独立预算**（文件数约为实体的 1/10，quay 2 跳仅数百，不会被截断）；② `truncated` 拆成可选字段 `entityTruncated` / `fileTruncated`（新读数缝一律可选，不破坏既有消费者），面板只对**当前显示的粒度**提示并给数字（「显示 2000 / 6169 个实体」）；③ 面板加 **hops 旋钮（1/2/3）**，切换即重新请求（hops 是 payload 参数，进入内容寻址缓存键），并如实说明「2 跳会截断，已降到 1 跳」。

这条同时修订 `architecture-explosion-zoom-lod` 的隐含前提：爆炸图的层级不应建立在被截断的实体集上——包/file 级层级必须完整（由本条保证），实体展开只在聚焦包内进行。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/architecture-routes.test.ts` exit 0：file 图独立预算（实体截断时 file 图仍完整，或按 file 自身上限截断）；响应含 `entityTruncated`/`fileTruncated` 且与各自粒度一致；既有的 `truncated` 消费者不回归
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：提示只在当前粒度被截断时出现且含实际/上限数字；hops 控件切换触发重新请求并带正确参数；既有 hover/缩放/爆炸用例不回归
- [ ] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实 quay 会话（实体 2 跳 6169 > 2000）打开 architecture tab：file 视图完整不提示截断；切到 entity 视图时提示给出「2000 / 6169」并可把 hops 降到 1 后消除截断——用户能看懂被砍了什么、并能自己把范围收回来。

## Touches

- server/modules/architecture/generator.ts
- server/modules/architecture/service.ts
- server/modules/architecture/tests/architecture-routes.test.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/tests/architectureTab.test.tsx
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
- tasks/architecture-graph-budget-per-granularity.md