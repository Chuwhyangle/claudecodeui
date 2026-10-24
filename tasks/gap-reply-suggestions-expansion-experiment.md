---
id: gap-reply-suggestions-expansion-experiment
title: 回复建议扩展实验（缺省关闭）：选中某个 chip 后基于它再生成备选，替换正文
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

**服务端。** `POST /api/reply-suggestions` 增加可选参数 `seed`（被点选的 chip 文本，截到 `maxChipChars`）；有 `seed` 时用「变体」提示词：保持 seed 的决定与意图，给出 2–3 条措辞或详略不同的替代；同样走去重、限流、熔断、使用记录；`expansion` 不是 `vary` 时带 `seed` 的请求按 400 拒绝。

**前端。** `expansion` 为 `vary` 时，点选模型 chip 后在输入框内容之后显示变体 chip；点变体 = 用其文本替换正文，并可再次基于它展开，链深上限 5；用户手动编辑正文、清空或发送后变体 chip 消失；发 `picked` 事件时标明来源是 `seed`。

**范围外**：`append`（在正文后追加内容）、后端以外的配置项变更、离线基准。

## AC

- [ ] 服务端逐腿通过：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts` 退出码 0（在既有文件内新增独立用例）：(a) `expansion` 为 `off` 时带 `seed` 得 400 且无上游调用；(b) `vary` 时提示词含 seed 与「变体」指令；(c) seed 被截到 `maxChipChars`；(d) 结果与 seed 精确相同或近似重复（字符集重合度 ≥0.7）的被过滤；(e) 使用记录里该次抽取带 seed 标记。
- [ ] 前端逐腿通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/useReplySuggestions.test.tsx src/modules/chat/tests/ChatComposerReplyChips.test.tsx` 退出码 0（在既有文件内新增独立用例）：(a) `expansion` 为 `off` 时点选 chip 不发带 `seed` 的请求；(b) `vary` 时点选后发一次带 `seed` 的请求并显示变体 chip；(c) 点变体替换正文而非追加；(d) 链深到 5 后不再展开；(e) 手动编辑正文后变体 chip 消失；(f) 发送后变体 chip 消失。
- [ ] 缺省关闭成立：`node -e "const t=require('./config/reply-suggestions.settings.example.json'); if (t.expansion !== 'off') process.exit(1)"` 退出码 0。
- [ ] 文档同步：`grep -c "vary" docs/operations/reply-suggestions.md` ≥ 1，并说明 `seed` 与限制。
- [ ] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。

## DoD

真实页面与真实网关，隔离实例，不碰常驻 :3001；截图存 `tmp/` 并贴出。

- [ ] 开关打开（设置文件改为 `vary`，运行期按修改时间重读）：点选一个模型 chip → 贴截图：正文已填入、其后出现变体 chip；点一个变体 → 贴截图：正文被替换；再展开一次；记录每步请求次数与耗时。
- [ ] 开关关闭：同样操作无变体 chip、无带 `seed` 的请求；贴截图与网络请求读数。
- [ ] 贴一组真实的 seed→变体样例（至少 5 组），逐组注明变体是否保持了 seed 的决定，有改变决定的要点名。
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
- `src/modules/chat/components/InputSuggestionChips.tsx`
- `src/modules/chat/components/ChatComposer.tsx`
- `src/modules/chat/tests/useReplySuggestions.test.tsx`
- `src/modules/chat/tests/ChatComposerReplyChips.test.tsx`
- `tasks/gap-reply-suggestions-expansion-experiment.md`
