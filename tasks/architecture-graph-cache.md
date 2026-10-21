---
id: architecture-graph-cache
title: 内容寻址缓存：解析层按 archJsonHash memoize、结果层按全 key memoize，种子/指纹/参数变即失效
status: done
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-417
---
## Proposal

实现 ADR-005 决策 6 的缓存（`server/modules/architecture/cache.ts`）：两层内容寻址——解析层按 scope `archJsonHash` memoize `arch-index.json` 解析结果；结果层按 `hash(projectId, sessionId, extractedSeeds, params, archJsonHash...)` memoize 生成 reading（LRU 内存）。失效由键保证（种子变/`archJsonHash` 变/参数变 → 键变 → miss），无 TTL/事件。对应 GOAL-049 的 AC-417。

<!-- dedup-ref --> 机制去重（2026-10-21 立案实测）：`grep -rl "^goal_ac: AC-417" tasks/*.md` → 0 命中，无在飞任务认领 AC-417。merge-candidate（新文件 `server/modules/architecture/cache.ts` 为主）→ `peers: []`，separate。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/cache-invalidation.test.ts` exit 0（相同键命中且不重读盘；seeds/archJsonHash/params 任一变化 miss）

## DoD

`cache.ts` 以真实 `arch-index.json` 的 `archJsonHash` 为指纹：同键二次读命中（不触发文件系统读）、改任一键成分即 miss——缓存真的随种子与 `.archguard` 更新失效，非仅 fixture。

## Touches

- server/modules/architecture/cache.ts (new)
- server/modules/architecture/tests/cache-invalidation.test.ts (new)
- scripts/suite-duration-baseline.tsv
- server/shared/tests/quay-test-script.test.ts
- tasks/architecture-graph-cache.md
