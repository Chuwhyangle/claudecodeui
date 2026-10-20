---
id: gap-shared-bounded-approval-ledger-and-directory-bytes
title: Extract a shared bounded approval ledger and directoryBytes helper
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

F10（架构校准报告 2026-10-20）：两族重复——纯函数 `directoryBytes` 与有界审批账本（bounded approval ledger）。

`directoryBytes`：`server/modules/voice-realtime/voice-realtime-log.ts:373-386` 与 `server/modules/voice/voice-data.ts:344-357` 完全相同（检测器分组 `662ebec7fb79415d`，77 tokens）。

审批账本：`rememberHeldApproval` 在 `server/modules/debug-agent/debug-agent.provider.ts:513-522` 与 `server/modules/providers/list/claude/claude-runtime.provider.ts:140-149` 各一份；`rememberApprovalDecision` 在 `debug-agent.provider.ts:540-549` 与 `claude-runtime.provider.ts` 里的对应函数各一份（相同的淘汰策略、相同的 `MAX_REMEMBERED_APPROVALS`）。检测器分组 `4caf0fb9190bda44`、`d77f2dca5c945be3`。

为什么重要：`directoryBytes` 是纯函数、可直接共享；审批账本编码了一条微妙的有界淘汰策略，调试 agent 与真实运行时之间一旦分叉，就会改变「ALREADY_DECIDED」的语义。

改法（报告给出的 remediation）：把 `directoryBytes` 移到 `server/shared/fs-bytes.ts`；抽出 `createBoundedLedger(cap)` 辅助函数（或 `BoundedApprovalLedger` 类），两条审批路径都用它。

<!-- dedup-ref --> 相关但不同机制：`gap-voice-data-local-store-default-on`（done）在语音数据落盘里使用了一份 `directoryBytes`，那是用户数据存储功能，不是把该函数收敛成共享实现；本条只抽共享纯函数与账本，不改语音存储的默认开关、清空或容量语义。去重检索实测：`directoryBytes` 仅命中上述任务（done），`approval ledger` / `bounded ledger` / `bounded approval` / `rememberHeldApproval` / `MAX_REMEMBERED_APPROVALS` 均 0 命中。

## AC

- [ ] `test "$(grep -rn 'function directoryBytes' server --include='*.ts' | wc -l)" -eq 1`，且该唯一命中位于 `server/shared/fs-bytes.ts`（立案时 2 份）。
- [ ] `test "$(grep -rn 'const MAX_REMEMBERED_APPROVALS' server --include='*.ts' | wc -l)" -eq 1`：常量的唯一定义在共享账本模块；两个调用方经 import 取用，贴出两处 import 行。
- [ ] 新增 `server/shared/tests/bounded-approval-ledger.test.ts`，`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/bounded-approval-ledger.test.ts` 退出 0；用例至少三条：重复插入把 id 移到最新（读回顺序）、超过 cap 插入淘汰最旧、查询被淘汰 id 返回保守原因（逐字写出三组读数与返回原因文案）。
- [ ] 两条审批路径的既有判据不改一字仍绿：`files=$(grep -rlE 'rememberHeldApproval|ALREADY_DECIDED|MAX_REMEMBERED_APPROVALS' server/modules/debug-agent/tests server/modules/providers/tests) && test -n "$files" && for f in $files; do npx tsx --tsconfig server/tsconfig.json --test "$f" || exit 1; done` 退出 0，贴出命中文件清单与各文件 pass 数。
- [ ] `npm run typecheck` 退出 0，`npm run lint` 退出 0。
- [ ] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。

## DoD

真实落地的标准是「调试 agent 与真实 Claude 运行时真的共用同一个有界账本实现」，不是「类/函数存在」。必须贴出：①`directoryBytes` 的前后定义计数（2→1）与唯一路径；②`MAX_REMEMBERED_APPROVALS` 的唯一定义位置与两条审批路径的 import 行原文，证明 `rememberHeldApproval` / `rememberApprovalDecision` 都委托给共享账本；③判据的三条读数：重复插入后的顺序、超 cap 淘汰的 id、被淘汰 id 的保守原因文案；④两条审批路径既有判据逐个文件的 pass 读数；⑤typecheck / lint 退出码；⑥取假形态：把共享账本的淘汰方向临时改成「淘汰最新」⇒ 判据的淘汰读数必须红，还原后复绿，附两次读数。

## Touches

- server/shared/fs-bytes.ts (new)（`directoryBytes` 的共享实现）
- server/shared/bounded-approval-ledger.ts (new)（`MAX_REMEMBERED_APPROVALS`、`createBoundedLedger(cap)` 或 `BoundedApprovalLedger`）
- server/modules/voice-realtime/voice-realtime-log.ts（删除副本，改为导入）
- server/modules/voice/voice-data.ts（删除副本，改为导入）
- server/modules/debug-agent/debug-agent.provider.ts（审批账本改用共享实现）
- server/modules/providers/list/claude/claude-runtime.provider.ts（审批账本改用共享实现）
- server/shared/tests/bounded-approval-ledger.test.ts (new)（三条账本语义判据）
- server/shared/tests/quay-test-script.test.ts（新增 server 测试文件 ⇒ 两条计数 pin 各上移一个）
- scripts/suite-duration-baseline.tsv（新增 server 测试文件的时长行）
- tasks/gap-shared-bounded-approval-ledger-and-directory-bytes.md (self)
