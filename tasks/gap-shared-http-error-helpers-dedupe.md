---
id: gap-shared-http-error-helpers-dedupe
title: Extract toResponseJson/getApiErrorMessage into src/shared and remove
  three copies
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

F8（架构校准报告 2026-10-20）：web-client 的 HTTP 错误辅助函数在多个 hook 里被复制。

类型与度量：精确克隆，检测器分组 `62411b49e6e36f7b`，173 tokens，可省 25 行。

文件：
- `src/modules/mcp/hooks/useMcpServers.ts:73-97` 与 `src/modules/skills/hooks/useProviderSkills.ts:56-80` 的 `getApiErrorMessage` 逐字节相同。
- 两个文件还各自定义同一段单行 `toResponseJson`：`useMcpServers.ts:71`、`useProviderSkills.ts:54`；第三份在 `src/modules/settings/hooks/useSettingsController.ts:76`。

为什么重要：三块界面各自维护错误信封（error envelope）的解析，任一处改动都会静默分叉出不同的 UX 行为。检测器漏掉 `toResponseJson` 只是因为它只有一行。

改法（报告给出的 remediation）：新增 `src/shared/apiResponse.ts` 导出 `toResponseJson` 与 `getApiErrorMessage`，三个 hook 改为从它导入并删除各自副本。

<!-- dedup-ref --> 去重检索实测：`getApiErrorMessage` → 0，`toResponseJson` → 0，`apiResponse` → 0 命中，无任务以「收敛 HTTP 错误信封解析」为机制；`directoryBytes`/`bounded ledger` 等命名空间命中的任务属其它机制（语音本机存储、审批账本），与本条无实现交集。

## AC

- [ ] `test "$(grep -rn 'const getApiErrorMessage' src --include='*.ts' --include='*.tsx' | wc -l)" -eq 1`，且该唯一命中位于 `src/shared/`（贴出路径与行号；立案时 2 份）。
- [ ] `test "$(grep -rn 'const toResponseJson' src --include='*.ts' --include='*.tsx' | wc -l)" -eq 1`，且该唯一命中位于 `src/shared/`（立案时 3 份）。
- [ ] 三个 hook 都从共享模块导入：`grep -q "src/shared/apiResponse\|@/shared/apiResponse" src/modules/mcp/hooks/useMcpServers.ts`、`... src/modules/skills/hooks/useProviderSkills.ts`、`... src/modules/settings/hooks/useSettingsController.ts` 三条命令都退出 0。
- [ ] 新增 `src/shared/tests/apiResponse.test.ts`，`npx vitest run src/shared/tests/apiResponse.test.ts` 退出 0；用例至少覆盖四种形状：`{error:{message}}`、`{error:"str"}`、`{details:"str"}`、以及无错误字段时的兜底，并逐字写出四种返回值。
- [ ] 三个 hook 的既有判据不改一字仍绿：`npx vitest run src/modules/mcp src/modules/skills src/modules/settings` 退出 0，贴出 `Test Files / Tests` 读数与命中文件清单。
- [ ] `npm run typecheck` 退出 0，`npm run lint` 退出 0。
- [ ] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。

## DoD

真实落地的标准是「三块界面的错误信封解析真的只剩一份且行为一致」，不是「新文件存在」。必须贴出：①两条 grep 的前后计数（`getApiErrorMessage` 2→1、`toResponseJson` 3→1）与唯一命中路径；②三个 hook 的 import 行原文；③四种错误信封形状的返回值读数（含 `{error:{message}}` 取 message、`{error:"str"}` 取字符串、`{details:"str"}` 取 details、兜底文案）；④三个 hook 目录的 vitest 读数；⑤typecheck / lint 退出码；⑥取假形态：把 `getApiErrorMessage` 的一份副本临时加回任一 hook ⇒ 唯一性 AC 红（计数变 2），还原后复绿，附两次读数。

## Touches

- src/shared/apiResponse.ts (new)（`toResponseJson` 与 `getApiErrorMessage` 的共享实现）
- src/modules/mcp/hooks/useMcpServers.ts（删除副本，改为导入）
- src/modules/skills/hooks/useProviderSkills.ts（删除副本，改为导入）
- src/modules/settings/hooks/useSettingsController.ts（删除第三份 `toResponseJson`，改为导入）
- src/shared/tests/apiResponse.test.ts (new)（四种错误信封形状的判据）
- tasks/gap-shared-http-error-helpers-dedupe.md (self)
