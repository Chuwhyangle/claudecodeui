---
id: gap-ui-visible-context-extended-fields
title: ui_visible_context 增加 selectedText / currentDiff / currentTask 字段（落地
  gap-ui-visible-context-extended-focus-scope 的范围决策；focusedMessage 暂不纳入）
status: todo
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

- [ ] `npx vitest run src/modules/chat/tests/uiStateResponder.test.tsx` 退出码 0，新增用例分别断言：Git 面板展开两个文件时 `currentDiff.files` 恰为这两个路径、`panel!=='git'` 时为 null、展开零个时为 `{view,files:[],commits:[]}`（与 null 区分）；TaskMaster 模态打开时 `currentTask` 等于 `{source:'taskmaster',id,title}`，关闭后 null；转录区内选区返回 `{text,truncated,region:'transcript'}`，转录区外选区返回 null，超 500 字符时 `truncated===true`。
- [ ] `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/mcp-gateway/tests/mcp-ui-visible-context.test.ts` 退出码 0：真实 payload 里 `currentDiff`、`currentTask` 各有一条活值断言（非仅类型），且返回里不含 diff 正文；令牌无 `cloudcli:selection` 时 selectedText 读数为 `'withheld'`，有 scope 时为对象。
- [ ] `grep -n "cloudcli:selection" server/modules/oauth/access-tokens.service.ts` 命中，且该字符串在 `ACCESS_TOKEN_SCOPES` 数组中位于最后一项。
- [ ] 取假形态：把 `readCurrentDiff` 改为恒返回 null，AC1 的 currentDiff 用例必须红；记录红行与恢复命令。
- [ ] `npm run typecheck` 退出码 0；`mcp-tool-annotations.test.ts`、`mcp-error-vocabulary.test.ts` 逐文件运行退出码 0。

## DoD

在真实运行的服务上用真实浏览器：打开 Git 面板展开一个真实文件 diff、在转录里实际选中一段文字、打开一个 TaskMaster 任务详情，然后用带/不带 `cloudcli:selection` 的 PAT 经 `/mcp` 调用，响应分别反映这三个真实状态（路径、选中文本截断读数或 withheld、任务 id）。仅有单元夹具通过不算完成。

## Touches

- src/modules/chat/hooks/useUiStateResponder.ts
- src/modules/git-panel/changes/FileChangeItem.tsx
- src/modules/git-panel/history/CommitHistoryItem.tsx
- src/modules/task-master/modals/TaskDetailModal.tsx
- src/shared/types.ts
- server/shared/types.ts
- server/modules/websocket/services/ui-state-request.service.ts
- server/modules/mcp-gateway/mcp-ui-visible-context.ts
- server/modules/oauth/access-tokens.service.ts
- src/modules/chat/tests/uiStateResponder.test.tsx
- server/modules/mcp-gateway/tests/mcp-ui-visible-context.test.ts
- tasks/gap-ui-visible-context-extended-fields.md
