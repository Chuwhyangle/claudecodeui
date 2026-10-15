---
id: gap-baseline-red-suite-count-pins-336
title: develop 基线红 A：服务器测试数涨到 336，quay-test-script 的计数钉子与时长基线未跟上（卡住全部 fan-in）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

claudecodeui 的 `develop` 基线上有一条**确定性**红，与任何在飞任务无关，正在卡住所有任务的机械 fan-in（`baselineEquivalence` 判 `changed-assertion` ⇒ HARD RED）。实测把 `gap-ac351-supersede-after-per-utterance-withdraw-retirement` 卡成 22+ 轮「重派—失败—needs-human」。

**复现（2026-10-15T01:2xZ，author 与 develop 在 server/scripts/src 上零 diff，主检出直接跑）：**
`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts`
- AC7：`baseline covers 298/336 collected files (< 90%)`
- AC2：期望 `known=3 unknown=327`，实读 `known=3 unknown=333`
- AC3：期望 `known=1 unknown=329`，实读 `known=1 unknown=335`

成因：服务器测试文件数涨到 336，计数钉子与时长基线未跟上。先例提交 `87918c258`、`d347fc11f`、`ee1a62fa5`（同一类「移动计数钉子 / 补基线行」）。

修法：按现树重钉两个字面量；给 `scripts/suite-duration-baseline.tsv` 补上缺的文件行（真实测得的时长，不编造），使覆盖率回到 ≥ 90%。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts` 退出码 0
- [ ] 基线新增行的时长来自真实测量（Evidence 里写明测量命令与原始读数）

## DoD

- 落在 develop；之后 `gap-ac351-supersede-after-per-utterance-withdraw-retirement` 的 fan-in 不再因本文件红而判 HARD RED（另一条红见 `gap-baseline-red-claude-peer-name-freeze-leg-cli-drift`）。

## Touches

- scripts/suite-duration-baseline.tsv
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-baseline-red-suite-count-pins-336.md
