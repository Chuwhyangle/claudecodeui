---
id: architecture-graph-endpoint
title: /api/architecture/graph 端点 + hasArchguardCache Tier-1 门控，返回
  mmd{file,entity}+stats+provenance
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - gap-architecture-graph-generator-seeded-subgraph
  - gap-architecture-seed-extraction-from-transcript
  - architecture-graph-cache
goal_ac: AC-418
---
## Proposal

实现 ADR-005 决策 1/2 的接线：新增 `server/modules/architecture/` 的 routes/service/module/index（挂 `/api/architecture`），`POST /api/architecture/graph {projectId, sessionId}` 组合 AC-415/416/417（种子提取 → 生成 → 缓存）返回 `{mmd{file,entity}, stats, provenance}`；Tier-1 门控 `Project.hasArchguardCache`（项目存在 `.archguard/query/manifest.json`）加在 server listing（`server/index.ts`）与 `mcp-overview-tools`。本 task 把三个纯函数模块接成真实可操作的端点。对应 GOAL-049 的 AC-418。

<!-- dedup-ref --> 机制去重（2026-10-21 立案实测）：`grep -rl "^goal_ac: AC-418" tasks/*.md` → 0 命中。merge-candidate `task-granularity-advice.js`（`server/index.ts`/`mcp-overview-tools.ts`/`src/shared/types.ts`）→ `peers: []`（separate：无在飞重叠）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/architecture-routes.test.ts` exit 0（端点返回 mmd{file,entity}+stats+provenance；无缓存项目 hasArchguardCache=false 端点空/404；空 transcript 空种子不调生成器）
- [x] 新增 `server/modules/architecture/` 目录后 `server-import-cycle-budget` 全量过（新目录进 manifest `server-import-cycle-budget.baseline.json` 与 `MANIFEST_PIN`），且 `scripts/test.sh` 的 unknown pin 同步重测（新增 server 测试文件会顶高，重测 360→361/362/363 并把该文件写进 Touches）

## DoD

对本仓库真实项目 `POST /api/architecture/graph`（真实 sessionId）返回非空 `mmd.file`/`mmd.entity` 且 `hasArchguardCache=true` 的 listing 读数成立——端点对真实项目真实缓存产出了可渲染图，非仅 fixture。

## Touches

- server/modules/architecture/routes.ts
- server/modules/architecture/service.ts
- server/modules/architecture/module.ts
- server/modules/architecture/index.ts
- server/modules/architecture/tests/architecture-routes.test.ts
- server/index.ts
- server/modules/mcp-gateway/mcp-overview-tools.ts
- server/modules/projects/services/projects-with-sessions-fetch.service.ts
- src/shared/types.ts
- server/shared/tests/server-import-cycle-budget.baseline.json
- server/shared/tests/server-import-cycle-budget.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/architecture-graph-endpoint.md
