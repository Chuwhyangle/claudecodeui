---
id: gap-live-voice-segmented-replay-closure
title: 回放收口：2026-10-12 五句话回放 spec 去尽 test.fail/fixme/skip，单文件 playwright 退出
  0（AC-356 收口）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-segmented-replay-20261012
  - gap-live-voice-manual-mode-session-update-keeps-vad-off
  - gap-live-voice-caption-segment-attribution-by-item-id
  - gap-live-voice-segment-honest-heard-unrecognized-state
goal_ac: AC-356
---
## Proposal

### 问题

`GOAL-043` 的 AC-352/353/354/355 各自把 2026-10-12 五句话回放 spec 的一条（或两条）缺陷腿转绿：AC-352 建立 `e2e/voice-realtime-segmented-replay-20261012.spec.ts`（缺陷腿以 `test.fail()` 红先行）；AC-353 翻绿腿 (a)；AC-354 翻绿腿 (b)；AC-355 翻绿腿 (c)(d)。但没有任何任务的顶层 `goal_ac` 是 AC-356——整份 spec 的**收口**（`test.fail|fixme|skip` 计数为 0，且 `DASHSCOPE_API_KEY= npx playwright test <spec> --workers=1` 退出 0）没有独立承担者。

逐腿翻绿不蕴含整份口径绿：(1) 某条已翻绿的腿残留 `test.fail()` 标注——playwright 把「标注期望失败却通过」计为失败，整份非 0 退出；(2) 三条修复合并到 develop 后某条正向腿回归；(3) 修订后运行时序变化越过 playwright 单 spec 预算。这些读数只在整份 spec 层面可见，逐腿任务看不到。AC-356 判据当前读数：`acceptance failed (exit 1) — 缺判据文件：e2e/voice-realtime-segmented-replay-20261012.spec.ts`。

### 要做的事（收口，不重做修复）

在 AC-352/353/354/355 全部落地后，于 develop 上对回放 spec 做整份收口：清零任何残留的 `test.fail/fixme/skip` 标注；无云调用地整份运行退出 0；连续两次运行通过集合一致；若发现合并后的回归或预算越界，修该处（限回放 spec 与 `playwright.config.ts` 登记面）。若收口时某条腿在 develop 上仍红，说明对应修复未真正落地——停下并报告是哪条腿，不代改产品代码；产品代码层残留缺陷按机制另立任务。

<!-- dedup-ref --> 分离决定：与回放任务 `gap-live-voice-segmented-replay-20261012`（ready）共用 `playwright.config.ts`，与 `gap-live-voice-caption-segment-attribution-by-item-id`、`gap-live-voice-manual-mode-session-update-keeps-vad-off`、`gap-live-voice-segment-honest-heard-unrecognized-state` 共用回放 spec；调度器按 Touches 串行。保持独立而非并入：AC-356 的验收是**整份 spec**（零标注 + 单文件退出 0），与逐腿验收不同，且 driver 的逐 AC 校验需要一个顶层 `goal_ac: AC-356` 的承载任务。这四个任务是前置（见 frontmatter `depends_on` 四边），不是重复。

## Plan

1. 前置：等 AC-352/353/354/355 四个前置任务 done（frontmatter `depends_on` 四条边）；在 develop 上取回放 spec 当前形态。
2. 去标注：对回放 spec 执行 `grep -nE "test\.(fail|fixme|skip)\("`，逐条清除残留标注。若某条腿去标注后仍红，说明对应修复未落到 develop——停下报告腿号，不代改产品代码。
3. 整份绿：`env -u VOICE_REALTIME_MODE -u VOICE_REALTIME_CAPTURE -u VOICE_CAPTURE DASHSCOPE_API_KEY= bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1` 退出 0；全程零云调用。
4. 确定性：连续跑两次，逐用例 pass 列表一致。
5. 预算/登记：若修订后单 spec 越过 `playwright.config.ts` 里登记的单 spec 预算，调整该 spec 的预算条目；不动其它 spec 的登记。
6. 回归：`npm run typecheck`、`npm run lint` 退出 0；`e2e/voice-realtime-scripted-scenarios.spec.ts` 单跑退出 0（共享测试桩未被本轮改动）。

## AC

- [ ] AC1（取假形态排最前）：在任一已转绿用例上加回一个 `test.fail()` 标注，整份运行必须非 0 退出（证明「零标注 + 退出 0」这条读数真的在判事）；随后删该标注恢复绿。
- [ ] AC2：`f=e2e/voice-realtime-segmented-replay-20261012.spec.ts; [ -f "$f" ]` 通过，且 `! grep -qE "test\.(fail|fixme|skip)\(" "$f"` 为真（计数 0）。
- [ ] AC3：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1` 退出 0；全程零云调用（key 置空）。
- [ ] AC4：连续两次运行通过用例集合一致（逐用例 pass 列表逐字相同）。
- [ ] AC5：`npm run typecheck`、`npm run lint` 退出 0；`e2e/voice-realtime-scripted-scenarios.spec.ts` 单跑退出 0。
- [ ] AC6：本任务对 develop 的 diff（`git diff --stat develop...HEAD`）只含回放 spec、`playwright.config.ts`（仅当预算需调整）与本任务文件；未改任何产品代码。

## DoD

在 develop 上实际整份运行回放两次；把每用例 pass 列表、两次运行时长、`grep` 计数读数、退出码与单文件 playwright 原始输出尾部写入 Notes；零云调用。收口达成的判据是「spec 中不再有任何 `test.fail/fixme/skip`，且在没有期望失败的整份运行里退出 0」——不是「测试文件存在」。

## Touches

- e2e/voice-realtime-segmented-replay-20261012.spec.ts
- playwright.config.ts（仅当单 spec 预算/登记需调整）
- tasks/gap-live-voice-segmented-replay-closure.md

## Notes

立项：gap-filing agent 2026-10-12（GOAL-043 / AC-356，人 yale 授权）。AC-356 判据当前读数 `缺判据文件`。四个前置任务：AC-352 `gap-live-voice-segmented-replay-20261012`（ready）、AC-353 `gap-live-voice-manual-mode-session-update-keeps-vad-off`（todo）、AC-354 `gap-live-voice-caption-segment-attribution-by-item-id`（todo）、AC-355 `gap-live-voice-segment-honest-heard-unrecognized-state`（todo）。AC-355 的 AC7 顺带勾了「整份 spec 不含 test.fail」，但其顶层 `goal_ac` 是 AC-355；本任务补上 AC-356 的顶层承载。查重：`grep -rn "goal_ac: *AC-356" tasks/` 无匹配。granularity 仪器读数：peer `gap-live-voice-segmented-replay-20261012` 共用 `playwright.config.ts`（keep-separate，见 Proposal）。