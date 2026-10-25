---
id: gap-composer-quote-insert-breaks-only-for-multiline
title: 引用插入：末尾空行加 2 个回车的规则收缩为仅当插入文本含换行符时才触发
status: todo
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

- [ ] 插入规则的纯函数通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/quoteInsertion.test.ts` 退出码 0（沿用既有文件）；独立用例逐行对应上面的对照表：(a) 空框、单行：新文本 `T1`，光标在 `T1` 之后；(b) 空框、多行：新文本 `T2↵↵`，光标在末尾；(c) `第一段↵|`、单行；(d) `第一段↵|`、多行；(e) 末尾但所在行非空、多行：不加回车；(f) 光标在文字中间、多行：不加回车；(g) 含 `\r\n` 的文本也算多行；(h) 文本末尾只有一个换行符（选区钩子已去首尾空格，所以不会出现，但函数本身收到时按含换行符处理）；(i) 原有的前后补空格、选区末尾之后插入、标点算文本、回车不算文本、UTF-16 下标等既有用例全部保持通过，断言不放宽。
- [ ] 条件只有一处改动：`grep -nE "trailingBreaks" src/modules/chat/utils/inputSuggestions.ts` 的输出里，条件同时包含「在末尾且空行」与「文本含换行符」；函数的文档注释同步改成新规则，不再写「At the end of an empty line the passage opens a new paragraph」的旧表述。
- [ ] 接受契约与点击测试同步：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/suggestionChipAcceptContract.test.tsx src/modules/chat/tests/chatComposerReplyChips.test.tsx` 退出码 0；原先断言空框引用后文本为 `T↵↵` 的用例，改为单行得 `T`、多行得 `T↵↵`，两种各一条；不删用例、不放宽断言（`git diff --stat` 的删除与新增行数贴在 DoD，并说明每处删除的原因）。
- [ ] 发送去末尾空格与回车的既有用例仍然通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestionsComposer.test.tsx` 退出码 0。
- [ ] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。

## DoD

真实页面读数；用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，后端用真实网关的设置副本，不碰常驻 :3001，不重启常驻服务）；真页上**不要按 Escape**；测试会话的提示词里写明「不要写代码、不要调用任何工具」，结束后核对没有留下测试产物。读 `textarea.value`、`selectionStart`、`selectionEnd` 贴出。

- [ ] 空输入框引用一句单行的话：新内容就是这句话本身，光标在其末尾，没有回车；贴读数与截图。
- [ ] 空输入框引用跨段落的多行文本（transcript 里选中跨两段的文字）：内容末尾有两个回车，光标在末尾；贴读数。
- [ ] 输入框内容以回车结尾（`第一段↵|`）时，分别引用单行与多行，各贴一次读数，与对照表逐行一致。
- [ ] 其余对照表中不变的行（末尾非空行、文字中间）各做一次，读数与改动前一致。
- [ ] 空输入框单行引用后直接发送：贴网络请求里的消息内容，与该句话一致，末尾没有空格与回车。

## Touches

- `src/modules/chat/utils/inputSuggestions.ts`
- `src/modules/chat/tests/quoteInsertion.test.ts`
- `src/modules/chat/tests/suggestionChipAcceptContract.test.tsx`
- `src/modules/chat/tests/chatComposerReplyChips.test.tsx`
- `src/modules/chat/tests/inputSuggestionsComposer.test.tsx`
- `tasks/gap-composer-quote-insert-breaks-only-for-multiline.md`
