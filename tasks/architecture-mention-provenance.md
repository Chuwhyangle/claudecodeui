---
id: architecture-mention-provenance
title: 种子分三档（直接提及/同名候选/同文件扩展）+ 提及出处 + 按需查询会话文本的接口（默认不含 tool_result，可勾选加入）
status: done
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-entity-kind-and-members-payload
---
## Proposal

2026-10-22 查明：现在的「种子」不是「会话提到的实体」。`server/modules/architecture/seed-extraction.ts` 的 `extractSeeds` 只返回名字与文件路径（无出处）；`generator.ts` 的 `resolveSeeds` 把一个名字解析成**所有同名实体**（`nameToIds`），把一个文件解析成**该文件的全部实体**（`fileToIds`）。实测 quay 的 `.archguard` 索引：`main` 对应 318 个实体，`run` 18 个，文件中位数 7 个实体，444 个文件有 10 个以上；图快照里 2000 个节点中 773 个 `distance === 0`。后果：`distance === 0` 并不等于「会话提到了它」——按它做的「种子高亮」会标出几百个节点，按它做的「种子免隐藏」会让默认隐藏函数的筛选形同虚设；实体级「看会话里谁提到了它」也无从谈起，因为没有出处。

用户已确认：种子分三档，只有「直接提及」享受高亮与免隐藏；会话文本默认不含 `tool_result` 命中、可勾选加入（提取阶段特意忽略它们的既有决定不变）。

### 一、三档与出处（提取阶段）

1. 保持 `extractSeeds(messages, knownIdentifiers)` 的签名与返回形状不变（纯函数、缓存键稳定）；新增同模块的纯函数 `extractSeedMentions(messages, knownIdentifiers, options?)`，返回每个种子的提及出处：`{ messageId, role, kind: 'text' | 'tool_use' | 'tool_result', excerpt, at }`，`messageId` 取 `NormalizedMessage.id`；`excerpt` 为命中处前后各约 80 字符；每个种子最多保留 20 条（超出置 `truncated`）。默认来源与现有一致（user/assistant 文本、四个文件工具的 `tool_use`）；`options.includeToolResults` 仅供按需接口使用，**提取默认值不变**。
2. 三档定义（`mentionTier`，只标在 `distance === 0` 的节点上）：
   - `direct`：标识符提及，且该名字解析到的实体数 ≤ `DIRECT_MAX_CANDIDATES`（起点 3，实现时在真实图上标定并把读数写进实施记录）；或同一条消息里同时出现了该实体所在文件的路径（路径共现即消歧）。
   - `name`：标识符提及，但解析到的实体数超过阈值且无路径共现（同名候选）。
   - `file`：只因所在文件被提及（用户贴了路径，或文件工具的 `tool_use`）而被展开进来的实体。
3. 一个实体同时满足多档时取最强（`direct > name > file`）。`generator.ts` 的 `resolveSeeds` 与 `distance` 语义不变，只额外返回每个已解析实体的档位。

### 二、payload（字段一律可选，缺失即旧形态）

- 节点：`mentionTier?`、`mentionCount?`（该种子的提及条数）。
- `stats.seedTiers?: { direct, name, file }`。
- 前端读到缺 `mentionTier` 的旧形态 payload，一律按 `direct` 处理（即旧行为），不报错。
- 前端「种子标记」由 `distance === 0` 改为 `mentionTier === 'direct'`；`name`、`file` 档不加种子标记。同一处改动要更新已完成的类图渲染任务留下的断言（`distance === 0` 的节点带种子标记），在实施记录里列出改了哪几条。

### 三、按需查询：`POST /api/architecture/mentions`

- 请求：`{ projectId, sessionId, entityIds?: string[], edge?: { from, to }, includeToolResults?: boolean, limit?: number }`，沿用 `authenticateToken` 与既有的 `projectsDb.getProjectPathById` / `sessionsService.fetchHistory` 绑定。
- 响应：`{ mentions: [{ entityId, candidateCount, ambiguous, hits: [{ messageId, role, kind, excerpt, at }] }], edge?: { coMentions: hits }, truncated }`。`ambiguous` 在名字对应多个实体时为真，界面据此写「名字 X 对应 N 个实体，命中可能指向其中任意一个」。边的 `coMentions` 是**两端名字同时出现在同一条消息里**的命中。
- 搜索范围与规则：按名字做词边界匹配（反引号包裹的优先排前）与路径匹配；`includeToolResults` 缺省为假，真时才扫 `tool_result`/Bash 输出，且这些命中标 `kind: 'tool_result'`。
- 性能：按会话历史版本（消息条数 + 最后一条 id 的哈希）对倒排索引做内存缓存，同一历史上多次点击不重扫；单次最多扫 20000 条消息，超出置 `truncated` 并如实返回。
- 不新增服务端测试文件（沿用既有 `architecture-routes.test.ts` 与 `seed-extraction.test.ts`）；新的服务端实现文件放在同一模块目录内（如 `mentions.ts`），不新建目录，也不 import 兄弟模块。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/seed-extraction.test.ts` exit 0：`extractSeeds` 的既有断言逐字不变；`extractSeedMentions` 返回出处（`messageId`/`role`/`kind`/`excerpt`），每个种子上限 20 并置 `truncated`；`tool_result` 与 Bash 默认不产生出处，`includeToolResults: true` 时才产生且标 `kind: 'tool_result'`
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/generator.test.ts server/modules/architecture/tests/architecture-routes.test.ts` exit 0：用真实形态 fixture（`main` 对应 ≥ 5 个实体；唯一名字；同一文件 ≥ 8 个实体）断言三档：多候选同名为 `name`、唯一名字为 `direct`、仅文件被提为 `file`、同消息含该文件路径则升为 `direct`；节点带 `mentionTier/mentionCount`，`stats.seedTiers` 计数与节点一致；不带出处的旧 fixture 响应逐字节沿用既有断言
- [x] 同上命令中 `/mentions` 用例：对唯一名字返回命中且 `messageId` 都存在于 fixture 历史；对多候选名字 `ambiguous === true` 且 `candidateCount` 正确；边查询返回两端共现的消息；`includeToolResults` 缺省为假、为真时多出 `tool_result` 命中；超过扫描上限置 `truncated`；同一历史上第二次相同请求不重建倒排索引（构建计数读数）；未登录 401，缺参数 400
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/archguardToPlantUml.test.ts` exit 0：只有 `mentionTier === 'direct'` 的节点带种子标记，`name`/`file` 档的 `distance === 0` 节点没有；缺 `mentionTier` 的旧 payload 仍按旧行为带标记；既有 hover/缩放/爆炸/下钻用例不回归
- [x] `npm run typecheck` 与 `npm run build` 通过

## DoD

对真实 quay 会话（`/session/e2dd27de-3257-44ab-8209-4f5ac6858459`）发 `POST /api/architecture/graph`：响应的 `stats.seedTiers` 读数显示 `direct` 远小于旧的 `distance === 0` 总数（贴三档计数与旧总数）；挑 3 个 `direct` 实体与 1 个多候选名字（如 `main`）调 `/api/architecture/mentions`，贴响应摘录，并对照会话 transcript 确认 `messageId` 对应的消息里确实出现了该名字。再在浏览器打开该会话的 architecture tab，种子标记只出现在 `direct` 实体上。证据是真实请求的响应摘录与截图，不是单测绿。

## Touches

- server/modules/architecture/seed-extraction.ts
- server/modules/architecture/mentions.ts (new)
- server/modules/architecture/generator.ts
- server/modules/architecture/service.ts
- server/modules/architecture/routes.ts
- server/modules/architecture/index.ts
- server/modules/architecture/tests/seed-extraction.test.ts
- server/modules/architecture/tests/generator.test.ts
- server/modules/architecture/tests/architecture-routes.test.ts
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/tests/archguardToPlantUml.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/architecture-mention-provenance.md