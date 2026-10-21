---
id: architecture-seed-extraction
title: 种子提取：按 sessionId 复用 fetchHistory 读全量 transcript，提取文件与标识符种子
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-416
---
## Proposal

实现 ADR-005 决策 3 的种子提取（`server/modules/architecture/seed-extraction.ts` 纯函数）：注入 `sessionsService.fetchHistory(sessionId, {})` 读全量 `NormalizedMessage[]`（复用 `provider.routes.ts` 的正本，不重实现 transcript 读取）；文件种子 = Read/Edit/Write/NotebookEdit 的 `toolInput.file_path`（去重 + cap 100）；标识符种子 = assistant 文本反引号代码块 + PascalCase/camelCase 词中与 `nameToIds` 精确命中者。对应 GOAL-049 的 AC-416。

<!-- dedup-ref --> 机制去重（2026-10-21 立案实测）：`grep -rl "^goal_ac: AC-416" tasks/*.md` → 0 命中，无在飞任务认领 AC-416。merge-candidate（新文件 `server/modules/architecture/seed-extraction.ts` 为主）→ `peers: []`，separate。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/seed-extraction.test.ts` exit 0（fixture NormalizedMessage[] 下文件/标识符种子、去重、cap、外部符号/普通词不进）

## DoD

`seed-extraction.ts` 对本仓库真实会话 transcript（任一有 Read/Edit 的会话）提取出的文件种子含真实 `file_path`、标识符种子与真实 `nameToIds` 精确一致——对真实 transcript 提取，非仅 fixture。

## Touches

- server/modules/architecture/seed-extraction.ts
- server/modules/architecture/tests/seed-extraction.test.ts
- tasks/architecture-seed-extraction.md