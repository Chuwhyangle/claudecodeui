---
id: gap-ui-visible-context-extended-fields
title: ui_visible_context 增加 selectedText / currentDiff / currentTask 字段（落地
  gap-ui-visible-context-extended-focus-scope 的范围决策；focusedMessage 暂不纳入）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 去重（按机制）：`task_list search="ui_visible_context"` 命中 9 个任务，其中 `gap-ui-visible-context-extended-focus-scope`（done）已产出范围决策文档 `docs/proposals/ui-visible-context-extended-scope.md`，对 focused message / selected text / current diff / current task 四个维度逐一做了三态判定，并明确建议拆成下游实施任务；其余为基础设施与缺陷修复任务。没有任何任务实现这些新字段，故本任务不是重复，而是该文档的下游实施。

与原始立案简述的偏差（据该文档如实调整）：(1) focused message 判为「暂不纳入」——转录区没有 reply/quote、点击选中或常驻焦点行，`visibleMessages` 之外无数据源可读，本任务不新增 `focusedMessageId`；(2) current task 只做 TaskMaster 的 `selectedTask`（`TaskMasterPanel.tsx`），quay 的 `QuayPanel` 是只读镜像、无选中概念，字段带 `source` 标注命名空间；(3) selected text 是正文内容，须新 scope `cloudcli:selection`（追加在 `ACCESS_TOKEN_SCOPES` 末尾）并截断降级，文档推荐为独立读工具而非塞进 `cloudcli:read` 的 `ui_visible_context`；(4) current diff 是集合（Git 面板可同屏展开多个 diff），字段为 `{view, files[], commits[]}`，经 `aria-expanded` / `data-git-expanded-*` DOM 契约读取，不返回 diff 正文。实施前先 Read 该文档 §3-§5 取字段类型，并在 Plan 中核实其引用的行号仍然成立（该文档是 2026-10-07 快照）。

## Plan

1. currentDiff：给 Changes 展开按钮补 `aria-expanded` 与 `data-git-expanded-file`，History 补 `data-git-expanded-commit`；`useUiStateResponder.ts` 增 `readCurrentDiff()`，仅 `panel==='git'` 时读取，否则 null。
2. currentTask：TaskDetailModal 打开时根节点带 `data-task-selected`，`readCurrentTask()` 读取，返回 `{source:'taskmaster', id, title}` 或 null。
3. selectedText：`readSelectedText()` 仅在选区落在转录容器内时返回，截断 500 字符并带 `truncated`；服务端新增 `cloudcli:selection` scope 与独立读工具，无 scope 时 `'withheld'`。
4. 服务端投影白名单（`ui-state-request.service.ts`）放行新字段；同步 pinned 测试（工具计数、english-only、error-envelope、invalid-argument 参数表）。
5. 范围内改到的、本列表未声明的 pinned 测试文件，先用 task_write 补进 Touches 再改。

## AC

- [x] `npx vitest run src/modules/chat/tests/uiStateResponder.test.tsx` 退出码 0，新增用例分别断言：Git 面板展开两个文件时 `currentDiff.files` 恰为这两个路径、`panel!=='git'` 时为 null、展开零个时为 `{view,files:[],commits:[]}`（与 null 区分）；TaskMaster 模态打开时 `currentTask` 等于 `{source:'taskmaster',id,title}`，关闭后 null；转录区内选区返回 `{text,truncated,region:'transcript'}`，转录区外选区返回 null，超 500 字符时 `truncated===true`。
- [x] `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/mcp-gateway/tests/mcp-ui-visible-context.test.ts` 退出码 0：真实 payload 里 `currentDiff`、`currentTask` 各有一条活值断言（非仅类型），且返回里不含 diff 正文；令牌无 `cloudcli:selection` 时 selectedText 读数为 `'withheld'`，有 scope 时为对象。
- [x] `grep -n "cloudcli:selection" server/modules/oauth/access-tokens.service.ts` 命中，且该字符串在 `ACCESS_TOKEN_SCOPES` 数组中位于最后一项。
- [x] 取假形态：把 `readCurrentDiff` 改为恒返回 null，AC1 的 currentDiff 用例必须红；记录红行与恢复命令。
- [x] `npm run typecheck` 退出码 0；`mcp-tool-annotations.test.ts`、`mcp-error-vocabulary.test.ts` 逐文件运行退出码 0。

## DoD

在真实运行的服务上用真实浏览器：打开 Git 面板展开一个真实文件 diff、在转录里实际选中一段文字、打开一个 TaskMaster 任务详情，然后用带/不带 `cloudcli:selection` 的 PAT 经 `/mcp` 调用，响应分别反映这三个真实状态（路径、选中文本截断读数或 withheld、任务 id）。仅有单元夹具通过不算完成。

## Touches

- src/modules/chat/hooks/useUiStateResponder.ts
- src/modules/git-panel/changes/FileChangeItem.tsx
- src/modules/git-panel/history/CommitHistoryItem.tsx
- src/modules/git-panel/GitViewTabs.tsx (data-git-view on each tab, so readCurrentDiff reports the active Git sub-view)
- src/modules/task-master/modals/TaskDetailModal.tsx
- src/shared/types.ts
- server/shared/types.ts
- server/modules/websocket/services/ui-state-request.service.ts
- server/modules/mcp-gateway/mcp-ui-visible-context.ts (currentDiff/currentTask on ui_visible_context; the new ui_selected_text tool and its scope gate)
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts (stage-3 table, body and routing for ui_selected_text; optional ctx on the read seam)
- server/modules/mcp-gateway/mcp-gateway.transport.ts (pass the caller principal to read handlers so the selection scope can gate content)
- server/modules/mcp-gateway/mcp-tool-annotations.ts (annotation row for ui_selected_text)
- server/modules/mcp-gateway/mcp-tool-error-codes.ts (error-code row for ui_selected_text)
- server/modules/oauth/access-tokens.service.ts (the appended cloudcli:selection scope)
- server/modules/oauth/oauth-consent.service.ts (description and risk code for the appended scope, so the consent vocabulary stays complete)
- server/modules/oauth/tests/access-token-scopes.test.ts (the vocabulary literal gains the appended scope)
- server/modules/oauth/tests/oauth-consent-page.test.ts (the vocabulary literal gains the appended scope)
- src/modules/chat/tests/uiStateResponder.test.tsx
- server/modules/mcp-gateway/tests/mcp-ui-visible-context.test.ts
- server/modules/mcp-gateway/tests/mcp-ui-clients-list.test.ts (the report fixture gains the three extended readings)
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts (stage-3 read-set count 11 to 12)
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts (23-tool set; success and failure probe for ui_selected_text)
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts (23-tool set; probe for ui_selected_text)
- tasks/gap-ui-visible-context-extended-fields.md


## 完成记录

范围决策见 `docs/proposals/ui-visible-context-extended-scope.md`；focusedMessageId 按该文档判为「暂不纳入」，本任务未新增。

实现：`FileChangeItem` / `CommitHistoryItem` 补 `data-git-expanded-file` / `data-git-expanded-commit`，`GitViewTabs` 每个子视图 tab 补 `data-git-view`；`useUiStateResponder.ts` 的 `readCurrentDiff()` 仅 `panel==='git'` 时读，返回 `{view,files[],commits[]}`，零展开时 `{view,files:[],commits:[]}`（与 null 区分），非 git 面板为 null；`readCurrentTask()` 读 `TaskDetailModal` 打开时的 `data-task-selected` / `data-task-selected-title`，返回 `{source:'taskmaster',id,title}` 或 null；`readSelectedText()` 仅在选区两端都落在 `[data-message-anchor-id]` 内时返回，截断 500（`SELECTED_TEXT_MAX_LENGTH`）并带 `truncated`、`region:'transcript'`。服务端把 `cloudcli:selection` 追加在 `ACCESS_TOKEN_SCOPES` 末尾（append-only，前六位位置不变），新增读工具 `ui_selected_text`（requiredScope `cloudcli:read` + handler 内 scope 门，无 scope 读 `'withheld'`、有 scope 读对象），`ui_visible_context` 经 `Omit<UiVisibleContextTab,'selectedText'>` + `withoutSelection()` 彻底剥离 selectedText（连"存在选区"都不泄露）；读缝 `McpReadToolRegistration.handler` 增加可选 `ctx`（`{principal}`），由 transport 注入；投影白名单 `ui-state-request.service.ts` 放行三字段；`oauth-consent.service.ts` 为 `cloudcli:selection` 补 description 与 risk code，使 consent 词表保持完整。

- AC1 ✅ `npx vitest run src/modules/chat/tests/uiStateResponder.test.tsx` → 16/16 passed（新增 6 条用例）。
- AC2 ✅ `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/mcp-gateway/tests/mcp-ui-visible-context.test.ts` → 10/10 pass；leg (4) 对 `currentDiff`、`currentTask` 各一条活值断言且返回不含 diff 正文，leg (5) 无 scope `'withheld'`、有 scope 对象。
- AC3 ✅ `grep -n "cloudcli:selection" server/modules/oauth/access-tokens.service.ts` → 第 55 行命中，且为 `ACCESS_TOKEN_SCOPES` 数组最后一项（前一项 `cloudcli:navigate`）。
- AC4 ✅ 取假形态已执行并恢复。把 `readCurrentDiff` 守卫改为 `if (true || !hasDocument() || readActivePanel() !== 'git') {`（带 FALSIFICATION 注释）。红行：`AssertionError: expected null to deeply equal { view: 'changes', …(2) }`，落点 `src/modules/chat/tests/uiStateResponder.test.tsx:500`；另红一条 `expected null to deeply equal { view: 'history', files: [], …(1) }`，落点同文件 `:527`；`Tests 2 failed | 14 passed (16)`。恢复命令为 Edit 的逆操作——把守卫改回 `if (!hasDocument() || readActivePanel() !== 'git') {`（切勿用 `git checkout -- <file>` 恢复，会抹掉本任务在该文件的全部改动）。恢复后该文件 `git diff --stat` 为 114 insertions(+)、0 deletions，16/16 复绿。
- AC5 ✅ `npm run typecheck` 退出码 0；`mcp-tool-annotations.test.ts`、`mcp-error-vocabulary.test.ts` 逐文件运行退出码 0（另复跑 mcp-invalid-argument / mcp-read-tools / mcp-english-only / mcp-error-envelope / mcp-ui-clients-list / mcp-ui-open-session / mcp-not-found-semantics / mcp-production-session-wiring / mcp-insufficient-scope / access-token-scopes / oauth-consent-page 亦全绿）。

DoD ✅ 真实运行的服务 + 真实浏览器，读数由一次性探针规格（`e2e/zz-dod-ui-visible-context-extended-fields.spec.ts`，连同 `playwright.config.ts` 里为它临时加的 seed、`connectedAppsSelection` 分支与 stub `task-master` 的 PATH）驱动：R1 在 Git 面板展开真实 `notes.md` 的 diff（页面真实渲染出 `the added line`，证明 diff 正文确实取到）→ `ui_visible_context.currentDiff = {view:'changes',files:['notes.md'],commits:[]}` 且返回体内不含 diff 正文；R2 打开 TaskMaster 任务详情模态 → `currentTask = {source:'taskmaster',id:'7',title:'DoD task seven'}`；R3 在转录里真实选中一段文字 → 带 `cloudcli:selection` 的 PAT 经 `ui_selected_text` 读到 `{text:'the quick brown fox jumps over the lazy dog',truncated:false,region:'transcript'}`，不带该 scope 的 PAT 读到 `'withheld'`。连续两次 `npx playwright test` 绿（9.9s / 10.0s）。脚手架已全部回退：`playwright.config.ts` 相对 HEAD 无 diff，临时 spec 已删除。

Touches 与实际改动一致（服务端 16 个 + 前端 6 个文件，外加本任务文件）；未新增服务器测试文件，`mcp-read-tools.test.ts` 的阶段-3 读集计数由 11 改为 12。
