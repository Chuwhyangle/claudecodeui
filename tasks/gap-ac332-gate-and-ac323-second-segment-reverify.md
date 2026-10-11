---
id: gap-ac332-gate-and-ac323-second-segment-reverify
title: AC-332 判据（CMD2 vitest + CMD3 mobile -g idle + CMD4 typecheck，逐命令带
  VOICE_REALTIME_MODE=continuous）无任务以 goal_ac 认领：在 GOAL-038 实现落地树上复验三链全绿（段串行
  ≈47.6s < 声明 timeoutMs 100000）、闸 --dry-run 写出 pass、四文件白名单守卫、CMD2 紧凑栏判别力假形态
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-332
---
## Proposal

（去重 / 粒度）<!-- dedup-ref --> 本任务与现存任务的关系：仓内**无任何任务以 `goal_ac: AC-332` 认领本 AC**（`grep -l '^goal_ac: AC-332' tasks/*.md` 为空）；只有两处**散文提及**——`gap-ac331-gate-deadline-and-ac323-regression-reverify`（`goal_ac: AC-331`）的 `## AC` 口径变更块把本段列为「AC-332 段」，`gap-voice-realtime-live-session-send-375px-red-under-default-segmented-mode`（`goal_ac: null`）的 expect 引用块提到本段判据范围。两者都**不认领** AC-332 ⇒ 本任务为新案。`task-granularity-advice` 对 `goals/AC-332-…md` + 本任务路径报 `peers: []`、`mentions: []`，无合并候选。**粒度决定：separate** —— AC-331 与本段各由一条 AC 记录承载，`goal_ac` 是单值、driver 按 AC 独立验证，两条记录必须各有认领任务，不能合并进 AC-331 的任务。

### 现状（2026-10-11 复核，主检出 HEAD `945ff390`）

AC-332（`goals/AC-332-…-typecheck.md`，`timeoutMs: 100000`）的 `criterion` 是三条命令的 `&&` 串行链（逐命令带 `VOICE_REALTIME_MODE=continuous`）：

```
CMD2 VOICE_REALTIME_MODE=continuous npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime
CMD3 VOICE_REALTIME_MODE=continuous npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "
CMD4 npm run typecheck
```

（1）**判据在当前 develop 树上逐条绿**（本次实测，`scripts/with-memory-cap.sh` 包、cwd = 主检出、每命令带 continuous；日志 `/tmp/ac332-c2..c4.log`）：CMD2 rc=0 3572ms（`Test Files 9 passed (9)`、`Tests 124 passed (124)`）、CMD3 rc=0 26555ms（`6 passed`）、CMD4 rc=0 17484ms（三条 `tsc --noEmit` 全过）；**段串行 47611ms < 100000ms**。⇒ 本段不存在 AC-331 式的 deadline 问题。

（2）**GOAL-038 实现未碰承重四文件**：`git diff --stat ec621a2b^..8be9df6b -- <四文件>` 为空（`ec621a2b` = AC-326 实现、`8be9df6b` = AC-327 实现）；CMD3 的被判对象 `e2e/mobile-workspace-composer-layout.spec.ts` 在白名单内，最后改动 `7fd3598b`（早于 GOAL-038）。

（3）**闸 reason 的一个误导性读数（须照实记）**：账本里 AC-332 唯一一条 goal 事件（`2026-10-11T09:57:28Z`、`verdict:"fail"`、tree `6d10f96`）的 `reason` 逐字引了 `src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts Error: Not implemented: HTMLCanvasElement.prototype.getContext`。复核确认这是 **`@xterm/xterm` / `@xterm/addon-webgl` 在 jsdom 下 module-eval 期的非致命 stderr**（本次 CMD2 复跑 3/3 均 rc=0，该报错仍打印 14 次），acceptance runner 把它当作**最大 stderr 块**展示，并非失败命令。❗ 不得据此把 CMD2 判红。

### 做法

1. 在**合并了 develop（含 GOAL-038 实现 `ec621a2b`/`8be9df6b`）的工作树**里，按判据原文（每命令带 `VOICE_REALTIME_MODE=continuous`）逐条跑 CMD2–CMD4，`scripts/with-memory-cap.sh` 包住，记 rc/墙钟/读数。
2. `quay goal gate AC-332 --dry-run --root <工作树>` 自证闸能写 pass。
3. 四文件白名单守卫（限定在 GOAL-038 自身实现提交，避开 GOAL-038 之后无关落地的改动）。
4. 假形态 A（deadline 敏感性）：用 `--timeout <低于 floor>` 显式压出 `not-evaluated(timeout)`；不带 `--timeout` 复绿。⚠️ 本段 floor ≈47.6s **< 默认 60000ms**，故 AC-331 的「删 `timeoutMs` 行」形态在本段**不产生** timeout，改用显式 `--timeout` 做确定性证明。
5. 假形态 B（CMD2 判别力）：把 `src/modules/chat/composer/ChatComposer.tsx:904` 紧凑分支的 `'flex-nowrap'` 改成 `'flex-wrap'` ⇒ `composerCompactTier.test.tsx` 的 `the compact row may not wrap` 断言必红（本次实测 `wrapTokens:["flex-wrap"]`）；`git checkout --` 还原回绿。

### 边界 / 不做

- ⛔ 不改 AC-332 的 `criterion` / `expect` 文本一个字，不删或弱化其中任何命令（尤其 CMD4 `npm run typecheck`）。
- ⛔ 不改四个白名单文件、任何 spec 或产品代码（第 5 条的临时注入测后 `git checkout --` 还原，`git status --porcelain` 为空）。
- ⛔ 不动任何其它 goal 记录。
- ⛔ 不靠前置/放宽 mode 或配置换绿——判据自身已显式声明它判断的配置。

## AC

- [ ] AC1 判据三链逐条绿：在合并了 develop（含 `ec621a2b`/`8be9df6b`）的工作树里，以 `scripts/with-memory-cap.sh` 包住、判据原文逐字（每命令带 `VOICE_REALTIME_MODE=continuous`）跑 CMD2/CMD3/CMD4，三条**各 exit 0**；贴 CMD2 的 `Test Files 9 passed (9)`+`Tests 124 passed (124)`、CMD3 的 `6 passed`、CMD4 的三条 `tsc --noEmit` 原文；记各自墙钟，**段串行合计 < 100000ms**。若某条红，附失败原文并定位是负载/端口毛刺还是真回归（⛔ 不做归因就放过）。
- [ ] AC2 闸自证：`quay goal gate AC-332 --dry-run --root <工作树>` exit 0，stdout JSON `verdict == "pass"`、`cause == null`、`timeoutMs == 100000`。原文贴 Evidence。
- [ ] AC3 四文件白名单守卫：`git diff --exit-code ec621a2b^1 ec621a2b -- <四文件>` 与 `git diff --exit-code 8be9df6b^1 8be9df6b -- <四文件>` **均须为空**（`<四文件>` = `e2e/voice-realtime-live-session-send.spec.ts`、`e2e/voice-realtime-composer-embedded.spec.ts`、`e2e/mobile-workspace-composer-layout.spec.ts`、`src/modules/chat/tests/composerCompactTier.test.tsx`；`^1` 让 merge 提交取第一父）。如实记：相对 `$(git merge-base develop ec621a2b)..HEAD` 的 diff **非空**（三份白名单文件被 GOAL-038 之后的无关落地改过 `d70968d8`/`ec6b0145`/`d5f97823`），故按原意把 diff 限定在 GOAL-038 实现提交自身。
- [ ] AC4 假形态 A（deadline 敏感性）：`quay goal gate AC-332 --dry-run --timeout 20000 --root <工作树>` ⇒ exit 非 0、`verdict == "not-evaluated"`、`cause == "timeout"`、reason 含 `timed out after 20000ms`；不带 `--timeout`（用记录 100000）⇒ 复绿（AC2 原文）。Evidence 须注明：本段 floor ≈47.6s **< 默认 60000ms**，故「删 `timeoutMs` 行」不产生 timeout，改用低于 floor 的显式 `--timeout` 做确定性证明。
- [ ] AC5 假形态 B（CMD2 判别力）：`src/modules/chat/composer/ChatComposer.tsx:904` 紧凑分支 `'flex-nowrap'`→`'flex-wrap'` ⇒ CMD2 中 `composerCompactTier.test.tsx` 的 `the compact row may not wrap` 断言必红，贴失败断言原文（`wrapTokens:["flex-wrap"]`）与文件名/行号；`git checkout --` 还原 ⇒ CMD2 复绿、`git status --porcelain` 为空。
- [ ] AC6 隔离性：`git diff --stat develop HEAD` 恰为 `tasks/gap-…（self）`（若因「段串行 ≥ 声明值」需调 AC-332 记录的 `timeoutMs`，只允许多 `+timeoutMs: <N>` 一行）；`goals/` 下其它记录 diff 为空；`git status --porcelain` 为空（注入已还原）；未改 `criterion`/`expect` 一字、未改四文件/任何 spec/产品代码。

## DoD

在带可写 `.quay/` 的根真实跑 `quay goal gate AC-332`（非 `--dry-run`）拿到 `verdict: "pass"` 的 GateEvent 并留原文，AC-332 的 `status` 随之翻 `achieved`（driver 下一轮亦会独立复验：本任务携带顶层 `goal_ac: AC-332`，readTaskFacts 计数到它）。三条判据命令各跑一次、记 wall time 与 exit code。一次假形态（CMD2 紧凑栏判别力）现场红、还原绿，原始输出留档。Evidence 逐条记明：(a) 段串行 floor 与 100000ms 的余量；(b) 默认 60000 与本段 floor 的关系（47.6s < 60000 ⇒ 删行不产 timeout，故 AC4 用 `--timeout` 显式证明）；(c) `@xterm` jsdom canvas stderr 为非致命噪声、且曾被 gate reason 当证据展示这一误导；(d) 四文件守卫结果与所用的提交对。

## Touches

- goals/AC-332-goal-038-不回归-ac-323-判据第二段-vitest-紧凑栏-mobile-workspace-idle-腿-typecheck.md
- tasks/gap-ac332-gate-and-ac323-second-segment-reverify.md（self）
