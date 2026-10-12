---
id: gap-ac352-replay-criteria-record-timeoutms
title: AC-352/356/357/358/360 判据记录声明 timeoutMs 115000：76–83s 的单文件 Playwright
  回放成为可判定的 goal 门禁（不再 not-evaluated timeout）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 问题

AC-352、AC-356、AC-357、AC-358、AC-360 的判据都是 `DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1`（前置若干 grep/存在性闸）。`gap-live-voice-segmented-replay-20261012` 的实测：单文件运行 76–83 s（含 webServer 启动）。goal 判据默认 deadline 60000 ms ⇒ 这些 AC 会恒为 `not-evaluated (timeout)`（同 AC-319 现状），回放实际上没有自动门禁（fan-in 全量 suite 也不含 Playwright e2e）。

### 机制（已核对）

- `resolveAcceptanceTimeout` 的优先级：记录 frontmatter 的 `timeoutMs` > `--timeout` > `QUAY_ACCEPTANCE_TIMEOUT_MS` > 60000；AC-323（115000）、AC-317（`c3db6533`）是先例。
- goal-driver 对判据 spawn 有不可配置的 120000 ms SIGKILL ⇒ 可行区间 floor < timeoutMs < 120000；取 115000（floor 83 s 的约 1.39 倍）。
- 没有 ABI 动词写 `timeoutMs`：只能手写 frontmatter 并提交；ABI 后续写入会保留该字段。

### SCOPE BOUNDARY

- 只加 `timeoutMs` 一个字段；⛔ 不改 criterion/expect/status/origin；不动其他 goal 记录。

## Plan

1. 五份 AC 记录 frontmatter 各加 `timeoutMs: 115000`；2. 在任务工作树用 store 方言跑 `quay goal gate AC-352 --store --root <工作树>` 读 verdict 与耗时；3. 记录读数。

## AC

- [x] AC1：五份记录的 frontmatter 均含 `timeoutMs: 115000`，其余字段与改前逐字相同（`git diff` 只增这一行 ×5）。
- [x] AC2：`quay goal gate AC-352 --store --root <工作树>` 输出 `timeoutMs: 115000`、verdict 为 pass（不是 not-evaluated），实测耗时写入 Notes。
- [x] AC3：`quay goal get AC-356 --json --store --root <工作树>` 回读到 `timeoutMs: 115000`；AC-356 的 gate 以 fail（因仍有缺陷腿）而非 timeout 结束，失败行写入 Notes。

## DoD

主检出合并后，下一轮 goal-driver 对 AC-352 的 gate 事件（`.quay/gate-events.jsonl`）verdict 为 pass、reading 不含 `timed out`，原文写入 Notes。

## Touches

- goals/AC-352-2026-10-12-五句话-live-voice-segmented-输入的确定性-playwright-回放-scr.md
- goals/AC-356-回放收口-2026-10-12-五句话回放-spec-不再含任何预期失败-跳过腿-全部用例在当前代码上通过.md
- goals/AC-357-回放缺陷腿按特定错误签名判定-不再用-test-fail-每条缺陷腿经-expectknowndefect-签名-只在.md
- goals/AC-358-回放节奏改为事件-有界状态同步-固定-waitfortimeout-只保留有书面理由的少数处-录制在-cpu-压力下逐用.md
- goals/AC-360-live-voice-回放的本地封闭性-无-dashscope-key-debug-agent-代-claude-本地注.md
- tasks/gap-ac352-replay-criteria-record-timeoutms.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 测试基建建议 (1)）。纯记录维护，不挂 goal_ac。参考记忆：record timeoutMs 优先于 env 与 --timeout；driver 120s 硬上限。

补充（2026-10-12 09:12Z）：主检出跑 AC-352 当前红在正向腿「upstream dial carried a credential」——仓根 `.env` 的 DASHSCOPE_API_KEY 被 `server/load-env.ts:42` 回填（`!process.env[key]` 把空串当缺失），由 `gap-ac352-criterion-harden-against-repo-dotenv` 修。本任务 AC2 在任务工作树（无仓根 `.env`）读 verdict；DoD 的主检出 goal-driver pass 读数需等该任务落地，未落地时记录 verdict 与失败行（应为 fail 而非 timeout），不得把 fail 记成 pass。

补充（2026-10-12 09:16Z，本任务工作树实测读数）：

- AC1：`git diff` = 5 文件 / +5 行，每份只增 `timeoutMs: 115000` 一行，其余字段逐字未动；五份记录经 `quay goal get <id> --json --store --root <工作树>` 均回读 `"timeoutMs": 115000`（AC-352/356/357/358/360，status 均 `active`、kind 均 `criterion`）。
- AC2：`quay goal gate AC-352 --store --root <工作树>` → `verdict: pass`（`reason: acceptance passed (exit 0)`），`timeoutMs: 115000`，实测耗时 **80 s**（含 webServer 启动），`payload.evaluationRoot` = 任务工作树，`treeSha` = `83584b9f55ed07e202c451246152579b7df49217`。即该判据已从 `not-evaluated (timeout)` 变为可判定。
- AC3：`quay goal gate AC-356 --store --root <工作树>` → `verdict: fail`、耗时 **0 s**（前置 grep 闸即退，**不是** timeout），`timeoutMs: 115000`；失败行原文（spec 仍含 9 条 `test.fail(` 缺陷腿）：

```
685:  test.fail('(a) every session.update after segments started keeps turn_detection null (manual mode)', () => {
702:  test.fail('unrelayed transcripts are never shown as delivering while S5 is in flight', () => {
717:  test.fail('unrelayed transcripts stay visibly heard after S5 is delivered, each at its spoken position', () => {
734:  test.fail('(c) branch A: the segment C that never got a transcript is visibly marked before Exit', () => {
743:  test.fail('(c) branch A: leaving with an unrecognized segment leaves an exit trace', () => {
751:  test.fail('(d) branch B: Exit back-fills S2, S3, S4 in SPOKEN order, not arrival order', () => {
759:  test.fail('(d) branch B: the late S3 transcript sits at its spoken position (before S4) on screen', () => {
779:  test.fail('(b) variant V: a late EMPTY transcript for item C does not refuse the active segment\'s S5 relay', () => {
789:  test.fail('(b) variant V: the segment that carried words is not acked dropped/empty-transcript', () => {
```

AC-356 的 fail 是内容红（缺陷腿未修，AC-353/354/355 尚未落地），不是 deadline 假红——这正是 AC-357 要的可区分读数。

DoD 状态：主检出下一轮 goal-driver 的 AC-352 gate pass 读数仍待 `gap-ac352-criterion-harden-against-repo-dotenv` 落地（本工作树无仓根 `.env`，故此处 pass 不单独证明主检出 pass）。
