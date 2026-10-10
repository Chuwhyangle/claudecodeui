---
id: gap-voice-realtime-test-files-restore-quay-test-script-pins
title: 修复 develop 上 quay-test-script 的测试文件数钉子与耗时基线覆盖：新增的 5 个 voice-realtime
  服务端测试文件未同步（先前绕过 Quay 直接提交造成）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 去重检查（2026-10-10）：`task_list --search quay-test-script` 与 `grep -l "known=3 unknown" tasks/*.md` 未发现同机制的开放任务；记忆里有同机制的历史教训（新增服务端测试文件必须同步该钉子），但没有开放的修复任务。

### 现状（2026-10-10 在 develop@75bd6a89 上实测）

`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 1，3 个用例红：

- AC2 钉着 `known=3 unknown=262`（第 154 行），AC3 钉着 `known=1 unknown=264`（第 203 行），二者都由 `server/**/*.test.{ts,js}` 的总数推导（现钉 265）。
- AC7 要求 `scripts/suite-duration-baseline.tsv` 覆盖 ≥ 90% 的服务端测试文件。

原因：2026-10-09/10 对 Live Voice 的修复直接提交到 develop、没有走 fan-in，新增了 5 个服务端测试文件，没有同步上面的钉子与基线：

- `server/modules/voice-realtime/tests/voice-realtime-diagnose.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-replay.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-spend-guard.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-streaming-stages.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-ws-proxy.real-transport.test.ts`

后果：任何经 fan-in 的任务都会被这个红拖成「UNATTRIBUTABLE」并 `⛔ 不再重派`，且与该任务自己的改动无关。因此本任务优先于 GOAL-034 的所有任务。

### 方案

1. 钉子数字改成**当前实际总数推导出的值**：先 `find server \( -name '*.test.ts' -o -name '*.test.js' \) -not -path '*/node_modules/*' | wc -l` 取数，再改 AC2/AC3 两行（只改数字）。
2. 基线：给新增文件各补一行 `<ms>\t<server/...test.ts>`，ms 取自对该文件**单独**跑一次的 `duration_ms`（`npx tsx --tsconfig server/tsconfig.json --test <file>`，一次一个文件，不要扇出）；header 里的再生命令与来源轮次保持文档要求的形态。
3. 不改产品代码，不改其它测试，不放宽任何阈值。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0（11 个用例全绿）
- [x] `git diff develop -- server/shared/tests/quay-test-script.test.ts` 只含 AC2/AC3 那两行里的数字变化，数字等于 `find` 实际计数推导出的 `unknown`
- [x] `scripts/suite-duration-baseline.tsv` 新增的行恰为上述 5 个文件，每行格式 `^[0-9]+\tserver/\S+\.test\.(ts|js)$`，且 `awk` 校验覆盖率 ≥ 90%
- [x] `git diff --stat develop` 只列出本任务 Touches 里的 3 个文件

## DoD

真实落地判据：在 develop 之上合并后，fan-in 的服务端套件分发行 `test.sh: server dispatch order=longest-first … known=… unknown=…` 与测试里的钉子一致；变绿不是靠放宽阈值或删除断言得到的（`git diff` 只动数字与基线行）。之后每个新增服务端测试文件的任务都会再次触发同一个钉子，本任务不解决该机制本身，只恢复当前一致。

## Touches

- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-realtime-test-files-restore-quay-test-script-pins.md