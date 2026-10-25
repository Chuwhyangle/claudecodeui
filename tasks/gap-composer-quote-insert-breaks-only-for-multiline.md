---
id: gap-composer-quote-insert-breaks-only-for-multiline
title: 引用插入：末尾空行加 2 个回车的规则收缩为仅当插入文本含换行符时才触发
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-25 yale 对引用 chip 的插入规则做一处收缩（其余规则一概不动）。

**现状。** `src/modules/chat/utils/inputSuggestions.ts` 的 `insertQuotedText` 里：

```ts
const endsOnEmptyLine = insertAt === input.length && isCaretOnEmptyLine(input, insertAt);
const trailingBreaks = endsOnEmptyLine ? '\n\n' : '';
```

只要光标在输入框末尾且所在行是空行，就在插入文本后加 `\n\n`，不看插入的文本有几行。所以空输入框里引用一句单行的话，也会得到 `T↵↵|`。

**改成。** 「光标在输入框末尾且是空行」之外再加一个条件：**插入的文本含换行符**（`\n` 或 `\r`，即「不止一行」）。不含换行符的单行文本回到单行规则：只有空格规则，不加回车。「一行」按**换行符**算，不按页面上的折行显示算（折行取决于窗口宽度，用它判断同一段文字在不同宽度下行为会不一样）。其余规则（前后补空格、选区末尾之后插入、光标位置、回车不算文本等）完全不变。

对照表（`|` 是光标，`T1` 是单行文本，`T2` 是含换行符的多行文本，`↵` 是回车）：

| 插入前 | 文本 | 现在 | 改后 |
|---|---|---|---|
| 空输入框 | `T1` | `T1↵↵\|` | `T1\|` |
| 空输入框 | `T2` | `T2↵↵\|` | `T2↵↵\|`（不变） |
| `第一段↵\|` | `T1` | `第一段↵T1↵↵\|` | `第一段↵T1\|` |
| `第一段↵\|` | `T2` | `第一段↵T2↵↵\|` | 不变 |
| `我同意\|`（末尾，所在行非空） | `T2` | `我同意 T2\|` | 不变 |
| `前面\|后面` | `T2` | 只加空格，不加回车 | 不变 |
| `我同意\|` | `T1` | `我同意 T1\|` | 不变 |

单行文本紧贴光标：例如空框引用 `T1` 后接着打字会得到 `T1我同意`，这是规则字面推出的结果，yale 已确认可以，不加额外规则。

**范围外**：其他任何插入规则；chip 的呈现与退场；发送去末尾空格与回车（仍需要，多行文本时末尾仍有两个回车）。

## AC

- [x] 插入规则的纯函数通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/quoteInsertion.test.ts` 退出码 0（沿用既有文件）；独立用例逐行对应上面的对照表：(a) 空框、单行：新文本 `T1`，光标在 `T1` 之后；(b) 空框、多行：新文本 `T2↵↵`，光标在末尾；(c) `第一段↵|`、单行；(d) `第一段↵|`、多行；(e) 末尾但所在行非空、多行：不加回车；(f) 光标在文字中间、多行：不加回车；(g) 含 `\r\n` 的文本也算多行；(h) 文本末尾只有一个换行符（选区钩子已去首尾空格，所以不会出现，但函数本身收到时按含换行符处理）；(i) 原有的前后补空格、选区末尾之后插入、标点算文本、回车不算文本、UTF-16 下标等既有用例全部保持通过，断言不放宽。
- [x] 条件只有一处改动：`grep -nE "trailingBreaks" src/modules/chat/utils/inputSuggestions.ts` 的输出里，条件同时包含「在末尾且空行」与「文本含换行符」；函数的文档注释同步改成新规则，不再写「At the end of an empty line the passage opens a new paragraph」的旧表述。
- [x] 接受契约与点击测试同步：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/suggestionChipAcceptContract.test.tsx src/modules/chat/tests/chatComposerReplyChips.test.tsx` 退出码 0；原先断言空框引用后文本为 `T↵↵` 的用例，改为单行得 `T`、多行得 `T↵↵`，两种各一条；不删用例、不放宽断言（`git diff --stat` 的删除与新增行数贴在 DoD，并说明每处删除的原因）。
- [x] 发送去末尾空格与回车的既有用例仍然通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestionsComposer.test.tsx` 退出码 0。
- [x] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。

## DoD

真实页面读数；用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，后端用真实网关的设置副本，不碰常驻 :3001，不重启常驻服务）；真页上**不要按 Escape**；测试会话的提示词里写明「不要写代码、不要调用任何工具」，结束后核对没有留下测试产物。读 `textarea.value`、`selectionStart`、`selectionEnd` 贴出。

- [x] 空输入框引用一句单行的话：新内容就是这句话本身，光标在其末尾，没有回车；贴读数与截图。
- [x] 空输入框引用跨段落的多行文本（transcript 里选中跨两段的文字）：内容末尾有两个回车，光标在末尾；贴读数。
- [x] 输入框内容以回车结尾（`第一段↵|`）时，分别引用单行与多行，各贴一次读数，与对照表逐行一致。
- [x] 其余对照表中不变的行（末尾非空行、文字中间）各做一次，读数与改动前一致。
- [x] 空输入框单行引用后直接发送：贴网络请求里的消息内容，与该句话一致，末尾没有空格与回车。

## Evidence

**实现。** `src/modules/chat/utils/inputSuggestions.ts:235`（唯一改动的一处条件）：

```ts
const trailingBreaks = endsOnEmptyLine && /[\r\n]/.test(quoted) ? '\n\n' : '';
```

`endsOnEmptyLine`（上一行）= 光标在输入框末尾且所在行为空行；`/[\r\n]/` = 插入文本含换行符。函数文档注释已改为「At the end of an empty line, a passage that itself contains a line break opens a new paragraph with two line breaks under it; a one-line passage stays on the line it was inserted on.」，旧表述「At the end of an empty line the passage opens a new paragraph」不再存在。

**AC-2 的 grep 读数：**

```
$ grep -nE "trailingBreaks" src/modules/chat/utils/inputSuggestions.ts
235:  const trailingBreaks = endsOnEmptyLine && /[\r\n]/.test(quoted) ? '\n\n' : '';
236:  const inserted = `${leadingSpace}${quoted}${trailingSpace}${trailingBreaks}`;
```

**AC-1/3/4 的命令读数（worktree 内，`with-memory-cap.sh`）：**

- `bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/quoteInsertion.test.ts` → exit 0，18 tests passed。
- `bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/suggestionChipAcceptContract.test.tsx src/modules/chat/tests/chatComposerReplyChips.test.tsx` → exit 0，50 tests passed（12 + 38）。
- `bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestionsComposer.test.tsx` → exit 0，49 tests passed。

**AC-5：** `npm run typecheck` → exit 0；`npm run lint` → exit 0（既有文件的 371 条 warning，四个被改文件零 warning）。

**AC-3 的 diff（`git diff 440e5dcbd..HEAD`，440e5dcbd 是开工时的 develop 尖端）：**

```
 src/modules/chat/tests/chatComposerReplyChips.test.tsx       | 33 +++++-
 src/modules/chat/tests/suggestionChipAcceptContract.test.tsx | 66 +++++++++--
```

numstat：chatComposerReplyChips `+29/−4`；suggestionChipAcceptContract `+56/−10`；用例数只增不减（两文件从 38/11 变为 38/12）。新增用例：`(quoted, multi-line)`、`(c2)` 空框多行、`(d4)` 第一段↵ 后多行。逐处删除原因——全部是**旧规则的期望值、断言与注释**，没有删除任何用例：(1) `'选中的原文\n\n'` 与 `'第一段\n选中的原文\n\n'` 两处 `expectedDraft`/`expectedCaret` 改为单行结果；(2) 三条用例标题由「opens a new paragraph」改为「one-line passage: … no paragraph break」；(3) 两段「the passage lands there, followed by the two line breaks」的注释改写。断言没有放宽：单行分支严格等于 `T`（连同 caret 与聚焦），多行分支仍然严格等于 `T↵↵`，且多行用例是新加的一条，不是把旧断言改宽。

**DoD 环境（隔离实例）：**

- 自建隔离实例 `http://127.0.0.1:25845`（随机空闲端口）：
  - `DATABASE_PATH=/data/home/yale/work/gap-composer-quote-dod/auth.db`（live DB 的 better-sqlite3 online backup，仅对该副本重置本实例一次性口令）；
  - `SERVER_SETTINGS_PATH=/data/home/yale/work/gap-composer-quote-dod/server.settings.json` = 真实 `~/.config/claudecodeui/server.settings.json` 的副本 + `residentRestore.enabled=false`，内容 `{"residentRestore":{"enabled":false,"max":16,"maxAgeMs":86400000}}`；
  - `HOME=/data/home/yale/work/gap-composer-quote-dod/home`（测试 transcript `~/.claude/projects/quote-insert-dod-workspace/quote-insert-dod-session.jsonl` 在服务启动前 seed）；`CLAUDE_SESSION_SCOPE_SWEEP=off`；
  - 服务用 **worktree 自己的** `dist-server/` + `dist/` 启动；`/health` 回的 `buildSha=82b4c5a969fffdca6d9c681db1334a3557a0bde8` 是本任务分支 HEAD；
  - 启动日志无任何 `[resident-restore]` 行；该 server pid 名下 `claudecodeui-session-<pid>-*` scope 数为 **0**；常驻 :3001 未触碰、未重启；验证后实例已停止（按精确 pid TERM，端口关闭）并删除。
- 测试会话的 user turn 文本为「这是一条测试会话：请不要写代码、不要调用任何工具。」；全程没有 provider turn（`chat.send` 在 WS 层被记录后不转发给服务端），结束后 `workspace` 文件数 **0**（无测试产物）。
- 真页操作：真实 Chromium 打开 `/session/quote-insert-dod-session`，用真实 DOM Range 选中 transcript 文本，点真实 `button[data-chip-source="quoted"]`，读活 textarea。**未按 Escape。**

**DoD 读数（`textarea.value` / `selectionStart` / `selectionEnd`）：**

| 腿 | 场景 | textarea.value（JSON） | start/end |
|---|---|---|---|
| 1 | 空框、单行 | `"今天的天气不错，适合出门散步。"` | 15 / 15 |
| 2 | 空框、跨段多行 | `"今天的天气不错，适合出门散步。\n第二段会用来验证跨段落的选择。\n\n"` | 33 / 33 |
| 3a | `第一段↵`、单行 | `"第一段\n今天的天气不错，适合出门散步。"` | 19 / 19 |
| 3b | `第一段↵`、多行 | `"第一段\n今天的天气不错，适合出门散步。\n第二段会用来验证跨段落的选择。\n\n"` | 37 / 37 |
| 4a | 末尾非空行、多行 | `"我同意 今天的天气不错，适合出门散步。\n第二段会用来验证跨段落的选择。"` | 35 / 35 |
| 4b | 文字中间、多行 | `"前面 今天的天气不错，适合出门散步。\n第二段会用来验证跨段落的选择。 后面"` | 35 / 35 |
| 5 | 空框单行后发送 | 发送前 `"今天的天气不错，适合出门散步。"` | 15 / 15 |

腿 5 的发送帧（客户端 → 服务端 socket 上捕获的 `chat.send`）：

```json
{"type":"chat.send","sessionId":"quote-insert-dod-session","content":"今天的天气不错，适合出门散步。"}
```

与选中句逐字一致，末尾没有空格、没有回车。

页内异常读数：`pageErrors=[]`、`unhandledRejections=[]`；只有 2 条 `Failed to load resource: 403` 的资源加载行（静态资源，与本次交互无关）。完整读数 JSON：`tmp/quote-insert-dod/report.json`（`"ok": true`）。

**截图**（仓库内 `tmp/quote-insert-dod/`，gitignored）：

- `leg-1-empty-single-line.png`
- `leg-2-empty-multi-line.png`
- `leg-3a-first-paragraph-single-line.png`
- `leg-3b-first-paragraph-multi-line.png`
- `leg-4a-end-nonempty-line-multi-line.png`
- `leg-4b-middle-multi-line.png`
- `leg-5-before-send.png`

**第 2 轮复核（2026-10-25T14:56Z）：前一轮 suite 红是 develop 侧，不是本任务 delta。**

前一轮 blocker 的 `server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts` 本轮在 worktree 内单跑（`node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test`，包在 `scripts/with-memory-cap.sh` 里）仍 exit 1：`the returned runId must be the registry current run verbatim`（actual `'null'`）与 `the run registry must record the aborted terminal state`（actual `'unknown'`）⇒ 不是一次性负载抖动。但读驱动自己的 develop 基线跑 `.quay/fan-in-suite-gap-composer-quote-insert-breaks-only-for-multiline~wk-prod-anchor~baseline-1792939760749-22e83a.log`（跑在 `.baseline-red-gap-composer-quote-insert-breaks-only-for-multiline-wk-prod-anchor/` 的纯 develop 检出里），同一批文件逐字 `passed=false`：`mcp-session-lifecycle`、`mcp-session-send`、`mcp-cancel-queued`、`debug-agent-control-queue`、`claude-resident-busy-input`；兄弟任务 `gap-quay-snapshot-loop-status-version-drain-orphan` 的 Blocker 也是同一条 `claude-resident-busy-input`。⇒ 红在 develop 侧且跨任务复现；本任务 delta 只含 `src/modules/chat/**` 的 4 个前端文件，与这些文件没有导入交集，未改也未碰它们。

本轮复核读数：AC-1 `quoteInsertion.test.ts` → exit 0，18 passed；AC-3 `suggestionChipAcceptContract.test.tsx` + `chatComposerReplyChips.test.tsx` → exit 0，50 passed（12 + 38）；AC-4 `inputSuggestionsComposer.test.tsx` → exit 0，49 passed；AC-5 `npm run typecheck` exit 0、`npm run lint` exit 0（仅既有 warning）。`git merge develop` 干净（只带进两份 task 文件的 blocker 记录），worktree clean。


## Touches

- `src/modules/chat/utils/inputSuggestions.ts`
- `src/modules/chat/tests/quoteInsertion.test.ts`
- `src/modules/chat/tests/suggestionChipAcceptContract.test.tsx`
- `src/modules/chat/tests/chatComposerReplyChips.test.tsx`
- `src/modules/chat/tests/inputSuggestionsComposer.test.tsx`
- `tasks/gap-composer-quote-insert-breaks-only-for-multiline.md`

## Blocker

**2026-10-25T14:54:20.908Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=35801 server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts passed=false end_ms=1792938842984
- run_id：wk-prod-anchor
- session_id：43fa44ba-ee3d-48fc-9a98-b051ce1b302e
