---
id: gap-claude-transcript-parsing-dedupe
title: Deduplicate Claude transcript parsing between claude-sessions.provider
  and session-conversations-search.service
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

F9（架构校准报告 2026-10-20，ArchGuard 0.1.40 加独立源码扫描，HEAD `abc2b5ed9`）：Claude 转录解析在两个文件里各存一份，属行为级复制，检测器只看见其中三个函数。

- `isInternalContent`：`server/modules/providers/list/claude/claude-sessions.provider.ts:930-932` 与 `server/modules/providers/services/session-conversations-search.service.ts:401-403` 逐字节相同。
- `extractTaggedContent`：`claude-sessions.provider.ts:939-943` 与 `session-conversations-search.service.ts:542-546` 相同。
- `parseLocalCommandPayload` / `parseClaudeLocalCommandPayload`：`:1030-1044` 与 `:554-568` 函数体相同。
- `buildLocalCommandDisplayText` / `buildClaudeLocalCommandDisplayText`：`:1053-1064` 与 `:570-581` 函数体相同。
- `ClaudeLocalCommandPayload` 类型与 `INTERNAL_CONTENT_PREFIXES` 常量也各有一份。

为什么重要：搜索与会话渲染必须对「哪些行算内部行」「斜杠命令如何显示」给出同一个答案。两份实现意味着修一条路径会静默把另一条分叉出去；这是本轮校准里价值最高的一处重复，检测器的归一化比较只看到了一半。

改法（报告给出的 remediation）：新建 `server/modules/providers/list/claude/claude-transcript-format.ts`（或 `server/modules/providers/shared/claude-transcript.ts`），导出该类型、前缀常量与四个解析/显示函数；`claude-sessions.provider.ts` 与 `session-conversations-search.service.ts` 改为从它导入并删除各自副本。只收敛解析函数，不改两条读面的语义，不合并搜索与会话渲染的其它逻辑。

<!-- dedup-ref --> 相关但不同机制：`gap-mcp-session-search` 与 `gap-mcp-session-search-time-pruning-and-stable-cursor`（均已 done）交付的是会话搜索功能本体（搜索、时间剪枝、稳定游标），不是把转录解析收敛成一份；本条只收敛解析函数，搜索语义不动。去重检索实测（`task_list`）：`extractTaggedContent` → 0，`isInternalContent` → 0，`parseClaudeLocalCommandPayload` → 0，`transcript parsing` → 0，`claude-transcript-format` → 0，`transcript-format` → 0 命中。合并候选检索：无其它 open 任务（全盘 858 条均为 done/superseded）。

## AC

- [ ] `test "$(grep -rn 'function extractTaggedContent' server --include='*.ts' | wc -l)" -eq 1`，且该唯一命中位于新建的共享模块。
- [ ] `test "$(grep -rn 'function isInternalContent' server --include='*.ts' | wc -l)" -eq 1`，且该唯一命中位于新建的共享模块。
- [ ] `test "$(grep -rnE 'function (parseLocalCommandPayload|parseClaudeLocalCommandPayload|buildLocalCommandDisplayText|buildClaudeLocalCommandDisplayText)' server --include='*.ts' | wc -l)" -eq 2`（两组函数各只保留一处定义）。
- [ ] 两个调用方都从共享模块导入：`grep -q "claude-transcript-format" server/modules/providers/list/claude/claude-sessions.provider.ts` 且 `grep -q "claude-transcript-format" server/modules/providers/services/session-conversations-search.service.ts`，两条都退出 0。
- [ ] `test "$(grep -rn 'const INTERNAL_CONTENT_PREFIXES' server/modules/providers --include='*.ts' | wc -l)" -eq 1`。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-transcript-format.test.ts` 退出 0；该表驱动用例断言共享解析器对无关内容返回 null、对带标签内容返回 `{commandName,commandMessage,commandArgs}`，并逐字写出两组读数。
- [ ] 既有会话与搜索判据不改一字仍绿：`files=$(grep -rlE 'session-conversations-search|claude-sessions\.provider' server/modules/providers/tests/*.test.ts) && test -n "$files" && for f in $files; do npx tsx --tsconfig server/tsconfig.json --test "$f" || exit 1; done` 退出 0，贴出命中文件清单与各文件 pass 数。
- [ ] `npm run typecheck` 退出 0。
- [ ] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。

## DoD

真实落地的标准是「两条真实读面真的共用同一份解析」，不是「新文件存在」。必须贴出：①四个函数在 `server/` 下的唯一定义位置（grep 行号，逐条）；②两个调用方的 import 行原文，证明 provider 会话渲染与搜索服务都经共享模块取解析结果；③新建表驱动判据的 `tests / pass / fail` 与两条返回值读数；④既有会话与搜索判据逐个文件的 pass 读数；⑤取假形态：把 `extractTaggedContent` 的一份副本临时加回任一调用方 ⇒ 唯一性 AC 必须红（计数变 2），还原后复绿，附两次读数；⑥`npm run typecheck` 退出码。若某条唯一性 AC 因同名符号出现在注释或测试里而误红，按实际符号定义位置修正 grep 口径并在完成记录写明，不得改断言方向。

## Touches

- server/modules/providers/list/claude/claude-transcript-format.ts (new)（共享解析模块：类型、前缀常量、四个函数）
- server/modules/providers/list/claude/claude-sessions.provider.ts（删除副本，改为导入）
- server/modules/providers/services/session-conversations-search.service.ts（删除副本，改为导入）
- server/modules/providers/tests/claude-transcript-format.test.ts (new)（表驱动判据）
- server/shared/tests/quay-test-script.test.ts（新增一个 server 测试文件 ⇒ 两条计数 pin 各上移一个）
- scripts/suite-duration-baseline.tsv（新增 server 测试文件的时长行）
- tasks/gap-claude-transcript-parsing-dedupe.md (self)
