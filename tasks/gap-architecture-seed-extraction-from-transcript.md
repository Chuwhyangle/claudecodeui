---
id: gap-architecture-seed-extraction-from-transcript
title: 架构图种子提取：transcript → 文件种子 + 标识符种子（AC-416）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-416
---
## Proposal

本任务实现 GOAL-049 / ADR-005 决策 3 的服务端「种子提取」纯函数：从按 `sessionId` 读到的全量 `NormalizedMessage[]` 中提取 file 种子与 identifier 种子。范围只是「消息 → 种子」这一步；transcript 读取与 `sessionsService.fetchHistory` 接线归 AC-418，图扩展/两级聚合归 AC-415，内容寻址缓存归 AC-417，前端 tab 归 AC-419，均不在本任务范围内。

新增 `server/modules/architecture/seed-extraction.ts`（遵循 `$backend-module-standards`：模块内不建 `types.ts`/`utils.ts`，一次性类型就定义在本文件；跨模块只经对方 barrel / `@/shared/types.js`）：

- 导出 `extractSeeds(messages, knownIdentifiers)`，纯函数：不读文件系统、不读 `.archguard`、不碰 route/缓存。
- **file 种子**：按消息顺序扫 `kind === 'tool_use'` 且 `toolName` 属于 `{Read, Edit, Write, NotebookEdit}` 的消息，取 `toolInput.file_path`（非空字符串）。`toolInput` 为 JSON 字符串时（codex 历史存在该形态）先 `JSON.parse` 再取；解析失败按无 `file_path` 处理。路径原样保留，不做绝对/相对转换、不做 scope 前缀拆分——那是调用方 AC-418 的职责。按首次出现顺序去重。
- **cap**：`MAX_FILE_SEEDS = 100`，模块私有常量（不从 barrel 导出）。去重后只保留前 100 个文件种子；cap 不作用于 identifier 种子。
- **identifier 种子**：只扫 `kind === 'text' && role === 'assistant'` 的 `content`（provider 历史归一化的实际字段，见 `server/modules/providers/list/claude/claude-sessions.provider.ts:1576-1585`）。候选 = ① 反引号 span 内所有 identifier 形状 token（任何大小写都算，`` `reassemble` `` 这类全小写名字也要能命中）；② 全文里含至少一个大写字母的 identifier 形状 token（覆盖 PascalCase 与 camelCase）。token 形状为 `[A-Za-z_$][A-Za-z0-9_$]*`。候选按首次出现顺序去重后，只保留 `knownIdentifiers.has(token)` 为真的项（精确、大小写敏感）——普通词与外部符号自然被排除。
- **返回** `{ files: string[]; identifiers: string[] }`，两者都保持首次出现顺序。不返回 stats：AC-417 的缓存键依赖这个顺序的稳定性，额外读数由调用方按需计算。
- `knownIdentifiers` 是 `ReadonlySet<string>`，由调用方传入（三个 scope 的 `nameToIds` key 并集）——本模块不合并 scope、不读 manifest。
- **barrel**：`server/modules/architecture/index.ts` 增加 `export { extractSeeds } from './seed-extraction.js';` 与返回类型。若该文件尚不存在（本任务先于 AC-415 兄弟任务执行），只创建含本任务导出的 leaf barrel；若已存在，只追加，不删既有导出。

<!-- dedup-ref -->
与 `gap-architecture-graph-generator-seeded-subgraph`（AC-415）共享 `server/modules/architecture/index.ts` 与两处测试计数/pin 文件，但两者机制与验收独立（生成器 vs 种子提取，测试文件不同），且 AC-415 任务正文已明确把种子提取排除在范围外，故分别立案；调度按 Touches 串行，无需合并。

测试 `server/modules/architecture/tests/seed-extraction.test.ts`（`node:test` + `node:assert/strict`，fixture 内联在测试文件）：

- 用 `createNormalizedMessage` 构造真实形状的 `NormalizedMessage[]`：Read/Edit/Write/NotebookEdit 各一条（含重复路径）、`tool_result`/`thinking` 噪声行、若干 assistant text 行。
- `knownIdentifiers` fixture 从真实 `.archguard/query/<scope>/arch-index.json` 的 `nameToIds` 裁剪，注明来源 scope 与 `archJsonHash`（`src` scope `93e0a992`、`server` scope `bcc56acf`；含 `App`/`useAuth`/`MermaidDiagram`/`createNormalizedMessage` 等真实名字，以及全小写键如 `reassemble`）。它是冻结快照，不是对 live 缓存的断言。
- 测试块按腿独立命名，前缀 `AC-416`，便于 `--test-name-pattern` 单腿复跑：
  1. `AC-416 文件种子：Read/Edit/Write/NotebookEdit 的 file_path 全提取并去重`
  2. `AC-416 标识符种子：反引号 span 与 PascalCase/camelCase 词中与 nameToIds 精确命中`
  3. `AC-416 普通词与外部符号：不在 nameToIds 的 token 不进种子`
  4. `AC-416 文件种子 cap：去重后只保留前 100 个`
  5. `AC-416 假形态 A：漏读 Edit 的 file_path ⇒ 文件种子断言红`
  6. `AC-416 假形态 B：把普通词当标识符 ⇒ 标识符种子断言红`

假形态的取法（每腿一个独立读数，不是重复同一条断言）：

- A：全量 fixture 的 `files` 必须包含 Edit 独有的路径；再从不含 Edit tool_use 的同一 fixture 提取，该路径必须缺席，两次差集非空——证明「Edit 路径在种子中」这条断言确实有区分力。
- B：普通词（不在 fixture 的 `knownIdentifiers` 里）必须缺席；随后用一份把该普通词加入 `knownIdentifiers` 的镜像集合再提取，它必须出现——证明排除它的是「精确命中」过滤，而不是分词阶段把它丢掉了。

已知联动（完成前必查，别等 suite 红）：

- 新增 `server/modules/architecture/tests/seed-extraction.test.ts` 会把 server 测试文件 collected 计数顶高 1。用与 `server/shared/tests/quay-test-script.test.ts` 的 `collectedServerFiles()` 完全相同的 find 命令重新测量实际值（当前为 391；若 AC-415 的 `generator.test.ts` 已先合入则为 392），据此更新 AC2/AC3 两处 pin（`unknown = collected − known`）与上方计数注释，不要照抄预测数字。
- AC7 的 90% 覆盖率地板：在 `scripts/suite-duration-baseline.tsv` 按 header 约定补一行 `<实测 ms>\tserver/modules/architecture/tests/seed-extraction.test.ts`，header 记明测量日期与「新文件、尚无绿色轮次包含它」。
- 新目录必须保持 leaf（AC-394 棘轮）：本模块只 import `@/shared/types.js`，不改 `server-import-cycle-budget.baseline.json`、不改 `MANIFEST_PIN`。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/seed-extraction.test.ts` 退出码 0（整份 criterion 绿）。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "AC-416 文件种子：" server/modules/architecture/tests/seed-extraction.test.ts` 退出码 0：Read/Edit/Write/NotebookEdit 的 `toolInput.file_path` 全部进入 `files`，重复路径只保留一次，顺序为首次出现顺序。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "AC-416 标识符种子：" server/modules/architecture/tests/seed-extraction.test.ts` 退出码 0：反引号 span 内 token（含全小写名）与全文 PascalCase/camelCase 词中，精确命中 `knownIdentifiers` 的名字全部进入 `identifiers`，且去重。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "AC-416 普通词与外部符号：" server/modules/architecture/tests/seed-extraction.test.ts` 退出码 0：不在 `knownIdentifiers` 的普通词/外部符号不出现在 `identifiers`。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "AC-416 文件种子 cap：" server/modules/architecture/tests/seed-extraction.test.ts` 退出码 0：喂 101 个不同路径时 `files.length === 100`，保留的是前 100 个，第 101 个缺席，重复项不占 cap 名额。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "AC-416 假形态 A：" server/modules/architecture/tests/seed-extraction.test.ts` 退出码 0：Edit 独有路径在全量输入中存在、在去掉 Edit tool_use 的输入中缺席，差集非空。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "AC-416 假形态 B：" server/modules/architecture/tests/seed-extraction.test.ts` 退出码 0：普通词在真实 `knownIdentifiers` 下缺席，在把该词加入的镜像集合下出现。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0（collected 计数已按实测更新，AC2/AC3 pin 与注释一致）。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` 退出码 0（新目录作为 leaf 通过，未改 baseline/manifest）。
- [ ] `npm run typecheck` 退出码 0；`npm run lint` 退出码 0。

## DoD

种子提取被真实执行过一遍完整机制，而不是只有 fixture 和字符串比较：

- 用 checked-in/内联 fixture 调 `extractSeeds`，走完「NormalizedMessage[] → file 种子（四类工具 + 去重 + cap）→ assistant text → 候选 token → nameToIds 精确命中 → identifier 种子」全链路；测试打印或断言实际读数（`files.length` / `identifiers` 列表 / 被 cap 丢弃的种子数），并点名每条假形态腿读到的差集。
- `knownIdentifiers` fixture 来自真实 `.archguard/query` 快照并注明 scope key 与 `archJsonHash`；消息 fixture 是真实 `NormalizedMessage` 形状（`kind`/`role`/`content`/`toolName`/`toolInput`），不是手编的假形状。
- 上列 AC 命令在落地的分支上全绿；`server-import-cycle-budget` 与 `quay-test-script` 也绿，且没有改 baseline/manifest 去「祝福」新目录。
- 任务记录/提交说明里贴出实际测试输出摘要（文件种子数、标识符种子列表、cap 读数、两条假形态的差集），供 driver 复核。

## Touches

- server/modules/architecture/seed-extraction.ts (new)
- server/modules/architecture/index.ts (new 或追加导出)
- server/modules/architecture/tests/seed-extraction.test.ts (new)
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-architecture-seed-extraction-from-transcript.md
