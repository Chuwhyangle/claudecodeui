---
id: architecture-entity-kind-and-members-payload
title: 服务端把实体 kind（class/interface/function）与成员、按 kind 的统计带进架构图 payload
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

2026-10-22 对 architecture tab 的体验评审（PC 1440×900 + 手机 390×844）结论之一：Entity 图应当是 UML 类图，但现在节点只是一行名字的框。根因在数据：`server/modules/architecture/generator.ts:581` 构造的邻域节点只有 `id/label/distance`，`rendererContract.ts` 里的 `type?` 从未被服务端填充；服务端也只读 `arch-index.json`（`service.ts` 的 `readScopeIndex`），从不读各 scope 的 `arch.json`，而成员与类型恰恰只在 `arch.json` 的 entities 里（实测 quay：1110 个 entity，`type` 分布 function 805 / interface 300 / class 5；每个 entity 带 `members:[{name,type:'field'|'method',visibility,fieldType}]`）。

本任务只补数据通路，不改任何渲染：

1. 服务端对**保留下来的**实体（预算裁剪之后）按需读取其所在 scope 的 `arch.json`（读一次、按 scope 缓存进现有的内容寻址缓存，随 `archJsonHash` 失效），为节点补可选字段 `kind`（`class | interface | enum | abstract | function | other`，由 arch.json 的 `type` 归一）与 `members`（`{ name, kind: 'field'|'method', visibility, signature? }[]`，每个实体最多保留前 N 个，N 与截断标记一并返回，避免巨型类撑爆 payload）。
2. `stats` 增加 `kindCounts`（当前**范围内全部相关实体**按 kind 的计数，不是预算后的计数）与 `membersTruncated`。字段一律**可选**，缺失即旧形态，手搓 stub 与旧缓存不受影响。
3. file 粒度图不受影响；`arch.json` 缺失或解析失败时节点保持旧形态（`kind` 缺失），并在 `provenance` 的诊断里留一条可见读数，不静默吞掉。
4. 前端只扩 `ArchitectureRendererNode`/`useArchitectureGraph` 的类型（可选字段透传），不改渲染。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/generator.test.ts server/modules/architecture/tests/architecture-routes.test.ts` exit 0：用真实形态 fixture（function/interface/class 混合，含成员）断言节点带 `kind`，`members` 受上限截断并带 `membersTruncated`，`kindCounts` 统计的是预算前的全体相关实体
- [ ] 同上命令中新增用例：`arch.json` 缺失时节点无 `kind`、响应仍 200 且 provenance 带诊断；旧形态（无 `arch.json` 的 fixture）逐字节沿用既有断言不回归
- [ ] 同上命令中新增用例：`archJsonHash` 变化后 `kind/members` 随缓存失效重建（内容寻址缓存读数），未变化时第二次请求不再读 `arch.json`
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0（可选字段透传，既有用例不回归）；`npm run typecheck` 通过

## DoD

对真实 quay 会话（`/session/e2dd27de-3257-44ab-8209-4f5ac6858459`）发 `POST /api/architecture/graph`：响应里 entity 节点带 `kind`，`stats.kindCounts` 读数与 `.archguard` 实测分布（function 805 / interface 300 / class 5 量级）一致，响应体积相对改前增幅在合理范围内（贴改前后字节数）。证据是真实请求的响应摘录，不是单测绿。

## Touches

- server/modules/architecture/generator.ts
- server/modules/architecture/service.ts
- server/modules/architecture/cache.ts
- server/modules/architecture/tests/generator.test.ts
- server/modules/architecture/tests/architecture-routes.test.ts
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/architecture-entity-kind-and-members-payload.md