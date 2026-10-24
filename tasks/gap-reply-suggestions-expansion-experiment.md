---
id: gap-reply-suggestions-expansion-experiment
title: 回复建议扩展实验（缺省关闭）：选中某个 chip 后基于它再生成备选，替换正文；带引用时针对引用生成回应
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-reply-suggestions-composer-chips-button-selection
---
## Proposal

设计见 `docs/proposals/composer-reply-suggestions-llm.md` 的「扩展」一节（yale 2026-10-24 确认：缺省关闭的实验开关，先做 `vary`，不做 `append`）。

用户点选某个模型 chip 后，除把该条文本填入输入框外，再基于它生成几条**变体**，仍以虚线 chip 形式附在正文后面；点变体 = **替换**正文（不是追加）。设置里 `expansion` 为 `"vary"` 才生效，缺省 `"off"`，此时行为与上一任务完成时完全相同。

**与「引用」结合。** 上一任务的「引用」chip 点击后，正文是 `> 选中原文` 加换行。此时的展开不是改写引用本身，而是**针对这段引用给出回应**：请求带 `focus`（引用原文）；`seed` 取引用之后用户已写的文字，没有则为空——`seed` 为空且带 `focus` 时，服务端用「针对 focus 给出 2–3 条回应」的提示词。这样的流程是：选中一段 → 点「引用」→ 得到针对它的几条回应 chip → 点一条 → 必要时再展开。回应 chip 点击时替换的是引用之后的部分，**保留 `> 原文` 那一行**。

**服务端。** `POST /api/reply-suggestions` 增加可选参数 `seed`（截到 `maxChipChars`）；有 `seed` 时用「变体」提示词：保持 seed 的决定与意图，给出 2–3 条措辞或详略不同的替代；有 `focus` 而 `seed` 为空时用「回应」提示词；同样走去重、限流、熔断、使用记录；`expansion` 不是 `vary` 时带 `seed`、或带 `focus` 且无 `seed` 的展开请求按 400 拒绝（普通「建议」重抽带 `focus` 不受影响，仍由上一任务的路径处理，请求体用 `expand: true` 区分展开）。

**前端。** `expansion` 为 `vary` 时，点选模型 chip（或引用后）在输入框内容之后显示变体或回应 chip；点它 = 替换正文（引用行保留），并可再次展开，链深上限 5；用户手动编辑正文、清空或发送后这些 chip 消失；发 `picked` 事件时标明来源是 `seed` 还是 `focus`。

**范围外**：`append`（在正文后追加内容）、后端以外的配置项变更、离线基准。

## AC

- [ ] 服务端逐腿通过：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts` 退出码 0（在既有文件内新增独立用例）：(a) `expansion` 为 `off` 时带 `expand: true` 得 400 且无上游调用；(b) `vary` 时带 `seed` 的提示词含 seed 与「变体」指令；(c) seed 被截到 `maxChipChars`；(d) 结果与 seed 精确相同或近似重复（字符集重合度 ≥0.7）的被过滤；(e) 使用记录里该次抽取带 `seed` 或 `focus` 标记；(f) `seed` 为空且带 `focus` 时提示词含 focus 与「回应」指令；(g) 不带 `expand` 的普通重抽带 `focus` 在 `expansion` 为 `off` 时仍然成功。
- [ ] 前端逐腿通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/useReplySuggestions.test.tsx src/modules/chat/tests/chatComposerReplyChips.test.tsx` 退出码 0（在既有文件内新增独立用例）：(a) `expansion` 为 `off` 时点选 chip 不发展开请求；(b) `vary` 时点选后发一次带 `seed` 的展开请求并显示变体 chip；(c) 点变体替换正文而非追加；(d) 链深到 5 后不再展开；(e) 手动编辑正文后变体 chip 消失；(f) 发送后变体 chip 消失；(g) 点引用后展开请求带 `focus` 与空 `seed`；(h) 点回应 chip 后输入框仍以 `> 原文` 开头，只有其后的部分被替换。
- [ ] 缺省关闭成立：`node -e "const t=require('./config/reply-suggestions.settings.example.json'); if (t.expansion !== 'off') process.exit(1)"` 退出码 0。
- [ ] 文档同步：`grep -c "vary" docs/operations/reply-suggestions.md` ≥ 1，并说明 `seed`、`expand` 与限制。
- [ ] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。

## DoD

真实页面与真实网关，隔离实例，不碰常驻 :3001；截图存 `tmp/` 并贴出；不要在运行中的会话页面按 Escape。

- [ ] 开关打开（设置文件改为 `vary`，运行期按修改时间重读）：点选一个模型 chip → 贴截图：正文已填入、其后出现变体 chip；点一个变体 → 贴截图：正文被替换；再展开一次；记录每步请求次数与耗时。
- [ ] 引用流程：选中 transcript 里一段 → 点「引用」→ 贴截图：出现针对该段的回应 chip；点一条 → 贴截图：`> 原文` 保留、其后是回应；贴请求体里的 `focus` 与 `seed`（脱敏会话 id）。
- [ ] 开关关闭：同样操作无变体或回应 chip、无展开请求；贴截图与网络请求读数。
- [ ] 贴一组真实的 seed→变体样例（至少 5 组）与引用→回应样例（至少 3 组），逐组注明是否保持了 seed 的决定或是否围绕引用，有偏离的要点名。
- [ ] 390px 触屏模拟下变体 chip 单行横向滚动，贴截图。

## Touches

- `server/modules/reply-suggestions/reply-suggestions.service.ts`
- `server/modules/reply-suggestions/reply-suggestions.routes.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts`
- `docs/operations/reply-suggestions.md`
- `src/shared/api.ts`
- `src/shared/types.ts`
- `src/modules/chat/hooks/useReplySuggestions.ts`
- `src/modules/chat/composer/InputSuggestionChips.tsx`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/tests/useReplySuggestions.test.tsx`
- `src/modules/chat/tests/chatComposerReplyChips.test.tsx`
- `tasks/gap-reply-suggestions-expansion-experiment.md`
