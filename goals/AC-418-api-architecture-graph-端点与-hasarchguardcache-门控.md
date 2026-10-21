---
id: AC-418
title: /api/architecture/graph 端点与 hasArchguardCache 门控
status: active
kind: criterion
goal: GOAL-049
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/architecture/tests/architecture-routes.test.ts
expect: |-
  - POST /api/architecture/graph {projectId, sessionId} → 200，含 mmd{file,entity}、stats（seed 计数/unresolved/nodeCount/edgeCount/truncated）、provenance（generatedAt/fingerprints/cacheHit）；
  - 无 .archguard/query/manifest.json 的项目 hasArchguardCache=false，端点返回空/404；
  - 无会话或空 transcript ⇒ 空种子，不调生成器（或返回空图）。
origin: ADR-005 决策 1/2；GOAL-049 退出条件
activatedAt: 2026-10-21T07:01:58.368Z
statusLog:
  - at: 2026-10-21T07:01:58.368Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-21T07:01:58.368Z
---
