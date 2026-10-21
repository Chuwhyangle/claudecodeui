---
id: AC-417
title: 缓存内容寻址，种子或 archJsonHash 变化即失效
status: draft
kind: criterion
goal: GOAL-049
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/architecture/tests/cache-invalidation.test.ts
expect: >-
  - 相同 (projectId, sessionId, seeds, params, archJsonHash) 第二次读取 cacheHit=true
  且不重新读盘；

  - seeds 变 / archJsonHash 变 / params（hops、粒度）变任一 ⇒ cacheHit=false。
origin: ADR-005 决策 6；GOAL-049 退出条件
---
