---
id: gap-reply-suggestions-composer-failure-silent-degrade
title: 回复建议失败静默降级：移除 composer 内的错误框与浮层，保留失败读数与 Diagnostics
status: needs-human
labels:
  - gap
  - defect
  - ui
  - chat
parent: null
children: []
extra:
  schema: execution
  acceptance: bash scripts/with-memory-cap.sh npx vitest run
    src/modules/chat/tests/replySuggestionsFailureNotice.test.tsx --maxWorkers=1
---
## Proposal

### 背景

2026-11-22 用户反馈：输入框 chip 生成失败时，出现一个 `Reply suggestions could not be generated` 虚线错误框，覆盖空 textarea 的整个网格单元并吞掉点击；点击后 portal 到 body 的详情浮层 `fixed bottom-24 left-4 w-72` 压在左侧会话列表上。该功能是输入增强，失败可以静默，不能阻断输入。

### 现状核实（代码）

- `src/modules/chat-composer/composer/ChatComposer.tsx:571-573` 只在空输入且有 failure 时显示；`:690` 让 notice 与 textarea 共享 `1 / 1` 网格单元；`:1157-1163` textarea 显式放到同一格；`:1183-1192` 渲染 notice。
- `src/modules/chat-composer/composer/SuggestionFailureNotice.tsx:101-131` 根节点 `relative z-30 w-full` + `gridArea:1/1`，透明区域覆盖整个输入格；只有内部小按钮有 onClick，空白点击既不聚焦也不输入。
- `SuggestionFailureNotice.tsx:133-202` 浮层 portal + `fixed bottom-24 left-4 z-[100] w-72`；侧栏默认 288px（`src/modules/sidebar/hooks/useSidebarResize.ts:10`），浮层正好压在会话列表上；没有外部点击关闭/焦点陷阱，字段是诊断信息。
- 手动失败已有就地反馈：`ChatComposer.tsx:544-618` 的 `replySuggestFailed`，`:1326`/`:1363` 的 `data-reply-suggest-state`，3 秒后恢复（`:68`）。
- 诊断已有正式入口：`src/modules/diagnostics/DiagnosticsHealthList.tsx:54-120` 健康卡显示 state/configSource/lastSuccess/lastFailure/problems，并可打开日志抽屉；`src/modules/settings/tabs/DiagnosticsSettingsTab.tsx` 承载 reply-suggestions 调试开关。

### 人的交互裁定（2026-11-22）

采用方案 A：

1. 自动 draw 失败、`misconfigured`、未请求的失败：composer 完全不显示错误框/浮层；`misconfigured` 只靠 Settings → Diagnostics。
2. 用户手动点 Suggest 失败：只保留已有的按钮失败态（`Suggest failed`），3 秒后恢复；不加行内提示。
3. 保留 `chipStrip` 的 failure 字段和控制器 episode 逻辑，失败读数/ledger/Diagnostics 不变。
4. 不修改已 done 任务 `gap-reply-suggestions-failure-reading-and-inline-notice` 的 AC；本任务是后续方向反转。

## Plan

1. `ChatComposer.tsx`：删除 `SuggestionFailureNotice` import 和 1183-1192 渲染块；`suggestionChipsShareEmptyLine` 去掉 `showSuggestionFailure`；placeholder/rows/grid 条件随之只取决于 `showSuggestionChips`。保留 `chipStrip.suggestionFailure*` 字段，不动控制器。
2. 删除 `SuggestionFailureNotice.tsx`；从 `src/modules/chat-composer/index.ts` 移除导出；同步更新 `src/shared/ports/log-drawer.port.ts` 注释与 `src/modules/diagnostics/tests/i18nLogDrawerCompleteness.test.ts` 的 DRAWER_SOURCES（不再扫描已删除文件）。
3. 重写 `src/modules/chat/tests/replySuggestionsFailureNotice.test.tsx`：自动失败不渲染 notice/popover；空 textarea 可聚焦可输入；手动 Suggest 失败 `data-reply-suggest-state="failed"`，3 秒后 idle；正常空 chip 不渲染错误 DOM。保留 controller/hook episode 判据不动。
4. i18n：不删除 `input.suggestions.failure.*`（composer 不再使用，但保留可避免无谓的 locale digest 连锁改动）；补 `input.suggestions.suggestFailed` 到 12 个 locale；更新 `inlineQuoteChip.test.tsx` 的 en/zh-CN key-set digest 与注释。
5. 验证：定向 vitest、typecheck/lint；隔离实例 + 502 stub 的真实页面读数与截图；移动端 390×844；Diagnostics 健康卡 lastFailure/problems。
6. 本任务用 `needs-human` 立案作为 live fleet 的 anti-dispatch claim；实现完成、证据入档后经 `task_write` 置 done（completeReason）。

## AC

- [ ] AC1 定向 UI 判据：`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/replySuggestionsFailureNotice.test.tsx --maxWorkers=1` 退出 0 且 `fail 0`。用例逐条断言：(a) `suggestionFailure` 非空且未 dismiss 时 `[data-slot="reply-suggestions-failure-notice"]` 与 `[data-slot="reply-suggestions-failure-popover"]` 均不存在；(b) 空 textarea 可聚焦，输入后 value 变为预期；(c) 手动点 Suggest 且 draw 返回 false 时按钮 `data-reply-suggest-state="failed"`，3 秒后回到 `idle`；(d) 正常空 chip 不渲染任何失败 DOM。
- [ ] AC2 控制器/钩子 episode 判据保持绿：`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/replySuggestionsController.test.ts src/modules/chat/tests/useReplySuggestions.test.tsx --maxWorkers=1` 退出 0 且 `fail 0`；不改这些文件。
- [ ] AC3 i18n：`input.suggestions.suggestFailed` 在 12 个 locale 均存在且非空；`inlineQuoteChip.test.tsx` 的 en/zh-CN key-set digest 按实测更新。命令：`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/i18nChatSuggestionsCompleteness.test.ts src/modules/chat/tests/inlineQuoteChip.test.tsx --maxWorkers=1` 退出 0。
- [ ] AC4 移除彻底：`grep -rn "SuggestionFailureNotice\|reply-suggestions-failure-notice\|reply-suggestions-failure-popover" src --include=*.ts --include=*.tsx` 只允许出现在 `replySuggestionsFailureNotice.test.tsx` 的“必须不存在”断言里；`SuggestionFailureNotice.tsx` 文件不存在；`src/modules/chat-composer/index.ts` 不再导出它。
- [ ] AC5 仓库门：`npm run typecheck`、`npm run lint` 均退出 0；若删除测试文件导致既有 unknown/known pin 或 architecture-ratchet 计数变化，按实测更新相关 pin，并逐字贴改前/改后数字。

## DoD

真实落地判据（不是“组件删了”）：

- 隔离实例（`scripts/isolated-instance.sh start`，dist-server/client 构建，`REPLY_SUGGESTIONS_SETTINGS_PATH` 指向临时 settings）+ 临时 stub 网关（`/v1/messages` 返回 502）。打开有 assistant 消息的会话，等自动 draw 失败：
  - `document.querySelector('[data-slot="reply-suggestions-failure-notice"]') === null`；
  - `document.querySelector('[data-slot="reply-suggestions-failure-popover"]') === null`；
  - 点击空输入框后 `document.activeElement` 是 textarea，输入文字后 value 改变；
  - 手动点 Suggest，按钮出现 `data-reply-suggest-state="failed"`，约 3 秒后回到 `idle`；
  - Settings → Diagnostics 的 reply-suggestions 健康卡能看到 `lastFailure`（category/httpStatus/at）；把临时 settings 改成缺 model/key 后重新读取，卡片显示 `misconfigured` 与 problems，composer 仍不显示任何失败框/浮层；
  - 390×844 移动视口：无遮挡层、无浮层，输入框可聚焦。
- 截图存档到 `tmp/`：至少 `tmp/reply-suggestions-silent-auto.png`、`tmp/reply-suggestions-silent-manual.png`、`tmp/reply-suggestions-silent-diagnostics.png`、`tmp/reply-suggestions-silent-mobile.png`。
- 诚实边界：只改 composer 展示层；服务端失败读数、ledger、控制器 episode、Settings/Diagnostics/log drawer 均保留；不改已 done 任务的 AC。

## Touches

- tasks/gap-reply-suggestions-composer-failure-silent-degrade.md
- src/modules/chat-composer/composer/ChatComposer.tsx
- src/modules/chat-composer/composer/SuggestionFailureNotice.tsx (delete)
- src/modules/chat-composer/index.ts
- src/modules/chat/tests/replySuggestionsFailureNotice.test.tsx
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/chat/tests/inlineQuoteChip.test.tsx
- src/shared/ports/log-drawer.port.ts
- src/modules/diagnostics/tests/i18nLogDrawerCompleteness.test.ts
- server/shared/tests/architecture-ratchet.baseline.json (only if measured count changes)
- server/shared/tests/quay-test-script.test.ts (only if unknown/known pin changes)

## 立案说明

本任务在 live fleet 运行期间立案。为避免 promotion/worker driver 与本次人工实现竞争同一 checkout/worktree，任务以 `needs-human` 状态立案作为 anti-dispatch claim；实现与证据完成后经 `task_write` 直接置 done（completeReason 记录人工授权与验证读数）。

该轴仍暗,理由:本任务只移除 composer 内的失败展示，不涉及蒸馏/图学习产物，L_D/L_G 无新读数。
