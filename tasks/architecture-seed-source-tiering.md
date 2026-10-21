---
id: architecture-seed-source-tiering
title: 种子治理：按来源可见性分层——user/assistant 文本核心、tool file_path 严格 cap、tool_result 不提取
status: done
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

现状 extractSeeds 只从 tool_use 的 file_path 取文件、从 assistant text 取 Entity，既漏了最高意图的 user text，也没挡住最大噪声源 tool_result。量化（2026-10-21 实测 5 个真实会话）：tool_result 占 Entity 命中的 50–70%（29–198 个），是折叠最深却噪声最大的来源；user text 命中 6–32，是最纯净的意图来源。按「来源可见性」分层：user text + assistant text 走同一套「反引号 + camelCase + 精确命中 nameToIds」规则（核心种子）；tool_use 的 file_path（Read/Edit/Write/NotebookEdit）保留但严格 cap（20）；tool_result 与 Bash 命令文本不提取。user text 里的文件路径用正则匹配项目内路径（非任意 URL）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/seed-extraction.test.ts` exit 0，新增用例覆盖：user text 的 Entity（反引号 + camelCase 精确命中）进种子；user text 粘贴的项目内文件路径进文件种子；tool_result 与 Bash 命令文本不进任何种子；文件种子 cap（20）；标识符种子 cap（40）
- [x] 既有 AC-416 用例仍 exit 0（assistant text Entity 提取、Read/Edit file_path 提取、文件去重不回归）

## DoD

对真实会话（quay PlantUML、archguard 待改进项）跑新 extractSeeds：标识符种子从「几百个顺带类名」塌缩到「user + assistant 直接说出的核心（<50）」，文件种子含 user text 粘贴路径与 Read/Edit file_path（cap 后），且 tool_result 的类名不再进入种子——默认视图是意图核心而非噪声池。

## Touches

- server/modules/architecture/seed-extraction.ts
- server/modules/architecture/tests/seed-extraction.test.ts
- tasks/architecture-seed-source-tiering.md
