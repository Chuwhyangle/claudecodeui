---
id: gap-baseline-red-claude-peer-name-freeze-leg-cli-drift
title: develop 基线红 B：Claude CLI 行为漂移后 freeze-leg 断言红——采纳后再交入的标题进入 custom-title
  梯子（卡住全部 fan-in）
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

claudecodeui 的 `develop` 基线上第二条**确定性**红，与任何在飞任务无关，同样卡住所有机械 fan-in（`gap-ac351-supersede-after-per-utterance-withdraw-retirement` 已因此失败 22+ 轮）。

**复现（2026-10-15T01:30Z，Claude Code CLI `2.1.300`）：**
`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts`
- `:1102` freeze-leg：`frozen.customTitles.includes(LATER_TITLE)` 期望 `false`，实读 `true`；读数 `customTitles=["AC171 Title 013147a6","AC171 Later 013147a6"]`，`registered="AC171 Later 013147a6" nameSource="auto"`。
- 其余对照（suppression / appname / new-round-1..3）读数与断言一致。

**判断：外部行为漂移，不是本仓库代码回归。** 该测试文件自 2026-10-01（`ce36452dd`）未改；它的注释说明它是「测量 freeze 实际住在哪」（`853ff24b8`「assert the freeze where it is」）。第一次在基线红记录里出现是 `.quay/baseline-red-rounds.jsonl` ts `1792005044487`（2026-10-14T19:10:44Z）。本机 CLI 会自动更新（二进制 mtime 2026-10-15T01:22Z）。即：当前 CLI 在用同一 session 直接启动并交入新标题时，会把新标题追加进 custom-title 梯子——旧测量结论「采纳后再交入的标题进不了梯子」已不成立。

需要做的：
1. 重新测量并确认 freeze 现在住在哪（读数进 Evidence）。
2. 判断产品影响：已采纳的会话名在真实使用中是否会被后续交入的标题覆盖（`claude-rename.provider.ts` / `claude-session-synchronizer.provider.ts` / `session-ai-title.service.ts` 的依赖假设是否被打破）。
3. 若无产品影响：按新测量改断言（保留读数注释，写明 CLI 版本）；若有：修产品代码让已采纳的名字保持稳定，测试照真实行为断言。⛔ 不删断言、不加 skip 造绿。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` 退出码 0
- [ ] Evidence 写明 CLI 版本、freeze-leg 的新读数、产品影响结论（有/无，及依据）

## DoD

- 落在 develop；断言描述的是当前 CLI 的真实行为而不是被放宽的空断言。
- 修复合入 develop 后，主检出全量 `npm run test:server` 中本文件不再出现在失败集合里；`gap-ac351-supersede-after-per-utterance-withdraw-retirement` 重派时 fan-in 不再因本文件判 HARD RED。

## Touches

- server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts
- server/modules/providers/list/claude/claude-rename.provider.ts
- server/modules/providers/list/claude/claude-session-synchronizer.provider.ts
- server/modules/providers/services/session-ai-title.service.ts
- tasks/gap-baseline-red-claude-peer-name-freeze-leg-cli-drift.md
