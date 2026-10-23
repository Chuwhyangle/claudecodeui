---
id: gap-ac323-vitest-stderr-masks-load-flake
title: AC-323 同树概率性红（5 连绿 → 20:24 load≈90–100 时 exit 1）：CMD2 vitest 的
  console.error 占满 gate 的 stderr 头部使红不可归因 ⇒ 噪声落盘恢复归因、复现并修掉负载时序红
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-323
---
## Proposal

（立案去重）<!-- dedup-ref --> 立案时 `grep -l '^goal_ac: AC-323' tasks/*.md` 命中的 10 个任务全部 `done`（`gap-ac323-embedded-fake-audiocontext-missing-statechange-api`、`gap-ac323-red-attributable-and-held-run-window`、`gap-ac323-composer-embedded-disconnect-draft-carry-hides-entry`、`gap-ac323-gate-deadline-below-criterion-serial-time`、`gap-ac323-live-session-bare-reload-and-loaded-criterion-budget`、`gap-ac323-upload-fixture-delivered-row-carries-heard-pieces`、`gap-ac323-composer-embedded-arming-first-frame-and-criterion-deadline`、`gap-live-voice-composer-embedded-dual-entry`、`gap-live-voice-composer-embedded-acceptance-spec`、`gap-ac323-late-final-caption-unclaimed-by-its-delivery`）⇒ 无在飞任务可复用，本任务为新案；这 10 个 done 是「上一轮修复没挺住」的证据。机制去重：按 `stderr`/`归因`/`概率性红`/`console\.error` 搜 `tasks/*.md` 的在飞集为空。粒度：`node scripts/dist/task-granularity-advice.js --touches vitest.config.ts --touches playwright.config.ts --touches scripts/vitest-console-log.mjs --json` 报 `peers: []`、`mentions: []` ⇒ 无合并候选。

### 直接读数（2026-10-23，不是台账转述）

- `.quay/gate-events.jsonl` 中 `item_id=AC-323` 在**同一个 tree** `c6f8a24c65f6a3f0fa946ff6bcb467edc104fc76`（= 当前 HEAD `bdda1ba0` 的 tree）上连续 5 次 pass：`19:55:19`、`20:00:59`、`20:06:31`、`20:12:21`、`20:18:02`，随后 `20:24:03` fail「acceptance failed (exit 1)」。同树、同 HEAD ⇒ 判据不是确定性红，是**概率性红**。
- 失败时主机负载：`.quay/checker-cost.jsonl` 在 `20:22:46–20:24:07` 的 `load` 为 **89–102**（此前 `20:21` 还在 31–41）；`19:01:53` 的另一次同类 fail（boot watchdog：`port 10923 (server) is not listening`）的 load 为 **137–165**。⇒ 红与负载尖峰相关。
- 本轮直接重跑（不依赖上一轮台账）：CMD2 `npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime` 8 连 exit 0（22 files / 218 tests，每次 4.7–5.5s，load≈66）；CMD3 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` 2 连 exit 0（6 passed，26.6–28.4s，stderr 0 字节）。⇒ 两条快的腿在中等负载下稳定，红只出现在负载尖峰或 CMD1 的 boot 阶段。

### 机制：红仍然不可归因，这是本任务的第一承重项

- 插件 0.20.0 的 acceptance runner（`scripts/dist/driver-runtime.js` 的 `withFailureOutput`）：`const body = errText ? boundedExcerpt(errText, "stderr", budget, true) : outText ? boundedExcerpt(outText, "stdout", budget, false) : …`，`budget = 500 - prefix - 3`，且 **stderr 取头部**。
- `gap-ac323-red-attributable-and-held-run-window`（done）只把 CMD1 的两条 webServer stderr 落盘，绿跑 CMD1 stderr 归零；但判据的 CMD2 是 `npx vitest run`，测试里的 `console.error`（jsdom xterm `Not implemented`、`[Auth] session lapse recorded`、`UPSTREAM_ERROR`）**每次运行都写进 stderr 且非零**。
- `20:24` fail 的 reason 可见部分逐字就是两条 vitest console 行（`composerCompactTier.test.tsx > (a) a wide window with a box under the threshold takes the compact arrangement [Auth] session lapse recorded…`、`voiceSegmentHonestState.test.tsx > a recoverable failure stays in the console > UPSTREAM_ERROR and MODEL_TEXT_REPLY`），随后 `[truncated, 10911 chars of stderr omitted]`；真正的失败用例名（Playwright/vitest 都写 stdout）永远读不到。⇒ 本轮无法从台账命名红腿，只能靠重跑猜——上一轮修好的一半被 CMD2 重新打开。

### 为什么前 10 次修复没挺住

10 个 done 各自修掉一条**可命名**的断言或预算（arming 首帧、断线草稿交接、FakeAudioContext API、交付行读数、裸 reload、迟到 final 字幕、criterion deadline 480000ms 等）。`gap-ac323-red-attributable-and-held-run-window` 修的是归因，但只覆盖 CMD1 的 webServer，没有覆盖 CMD2 的 vitest console 噪声；`gap-ac323-gate-deadline-below-criterion-serial-time` 验明整链实测 165–230s 远低于 `timeoutMs: 480000`，所以 20:24 的红不是 timeout。**没有任何一次处理「负载尖峰下的 boot / vitest 时序红」**，也没有让 CMD2 的失败名回到 gate 的 excerpt 里；所以每次红都只能盲修一条断言，下一次换一条腿红。

### 做法

1. **先恢复归因（不改判据文本）**：把 CMD2 的测试 console 输出从 runner 的 stderr 移走并落盘，镜像 `scripts/e2e-web-server-stderr.mjs` 的做法。首选新增 `scripts/vitest-console-log.mjs`：提供 `withConsoleLog(logPath)` / `consoleLogPath(dataDir)` 一类的纯函数，由 `vitest.config.ts` 的 `test.onConsoleLog` 调用（把 file/type/正文追加到日志），返回 `false` 只抑制转发、不丢内容，并把日志路径打到 stdout。若 `onConsoleLog` 覆盖不到 jsdom virtualConsole 的 `Not implemented`，改在 setup file 里重定向 `console.error`/`console.warn`，同样落盘 + stdout 报路径。
   - 口径：绿跑 CMD2 的 `stderr` 里不再出现 `session lapse recorded` / `Not implemented` / `UPSTREAM_ERROR` 这类**测试 console** 行；vitest 自身的错误（worker 崩、`Timeout calling "fetch"`）仍留在 stderr，从而重新成为 gate 头部能读到的第一条。
2. **让红可命名**：用一条临时故意失败的 vitest 用例（跑完删除）驱动同一段链，按 gate 的规则（`\s+`→单空格、取前缀 500 字符、stderr 非空取头否则取 stdout 尾）截取，证明 excerpt 里同时出现失败文件名与 `1 failed`。这条控制臂就是「下次红可命名」的证据。
3. **复现并命名负载红**：在 load1 ≥90 的负载臂下（主机已有并发时直接跑；没有就用受控忙循环把 load1 抬到 ≥90，跑完即收）重复 criterion 三条命令至少 3 次。若复现红，贴出恢复归因后的失败名，并修**那个被点名的界**：候选是 `playwright.config.ts` 的 `WEB_SERVER_TIMEOUT_MS=35_000` / `BOOT_CEILING_MS=40_000`（头注释已记录 load 206 时 boot 超过 30s），或 vitest 的 5s `testTimeout` / worker collect。修完后同一负载臂 3/3 exit 0。
   - 边界：若要抬 boot 界，必须保持 `WEB_SERVER_TIMEOUT_MS < BOOT_CEILING_MS < SINGLE_SPEC_CEILING_MS(55s) < 60s gate kill` 的严格序（例如 45/50/55），不得破坏「60s 闸能在 kill 前读到 watchdog 行」的既有不变量。
4. **判据真绿**：完整三条命令逐字跑，exit 0，贴各命令 exit code / list reporter 摘要 / wall time。
5. **收尾**：不改 `goals/AC-323-*.md` 的 `criterion`/`expect`；不删/跳过用例、不加 retries、不放宽任何既有断言。

## AC

- [ ] AC1 归因恢复（绿跑 stderr 去噪）：`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime >/tmp/ac323-cmd2.out 2>/tmp/ac323-cmd2.err; echo $?` → exit 0，且 `grep -cE "session lapse recorded|Not implemented|UPSTREAM_ERROR" /tmp/ac323-cmd2.err` == 0；`/tmp/ac323-cmd2.out` 含落盘日志路径，该日志含 `session lapse recorded` 与 `UPSTREAM_ERROR`（内容没丢）。
- [ ] AC2 控制臂（红可命名）：临时新增必然失败的 `src/modules/chat/voice-realtime/tests/ac323AttributionProbe.test.ts`（`expect(1).toBe(2)`），跑 AC1 同一条命令 → exit 1；把其输出按 gate 规则（`\s+`→单空格、500 字符、stderr 头 else stdout 尾）截取后同时含 `ac323AttributionProbe.test.ts` 与 `1 failed`；删除探针后该文件不在 `git status --porcelain`。贴截取原文。
- [ ] AC3 负载臂 3 连绿：`cat /proc/loadavg` 贴三次读数（均 ≥90），在每次读数下完整跑 criterion 三条命令各一遍，三次均 exit 0、单次 wall time < 480000ms；若修前在该臂下复现过红，贴出恢复归因后的失败名与所修那一行的 diff。
- [ ] AC4 三条命令逐字绿：CMD1 `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts` exit 0 / `18 passed`；CMD2 exit 0（`22 files` / 218 tests）；CMD3 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` exit 0 / `6 passed`；各贴 `echo $?`、摘要、wall time。
- [ ] AC5 边界未破：`grep -nE "WEB_SERVER_TIMEOUT_MS|BOOT_CEILING_MS|SINGLE_SPEC_CEILING_MS" playwright.config.ts` 的三个常量若被抬，仍满足 `WEB < BOOT < SINGLE < 60_000` 的严格序（贴数值与一次 `node -e` 断言 exit 0）；`git diff -- goals/` 为空。
- [ ] AC6 不回归兄弟腿：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` exit 0 / `7 passed`；`npm run test:scripts` exit 0 且输出含新增 `scripts/vitest-console-log.test.mjs`（若该文件存在）。
- [ ] AC7 隔离性：`git diff --stat develop HEAD` 只含本任务 `## Touches` 列出的文件；`git status --porcelain` 为空；`git diff develop HEAD -- e2e src playwright.config.ts vitest.config.ts scripts | grep -cE "test\.fixme|\.skip\(|retries"` == 0（无新增放水）。

## DoD

- 真实落地：归因机制在**真实 gate 读数**上被操作过——贴一条故意红跑经 gate 规则截取后的原文，证明失败用例名回到 excerpt；不是「加了一个 helper、写了一个单测」。
- 两次现场假形态，红/绿各留原文：
  - (a) 归因臂：临时恢复「测试 console 直接进 stderr」⇒ AC2 的截取只剩 console 噪声、不含失败用例名（红）；恢复后含失败用例名（绿）。记录注入 diff。
  - (b) 负载臂：若修的是 boot/vitest 界，临时把该界改回旧值并在 load1 ≥90 下跑，红/绿各一次并贴原文；还原后 AC3 绿。
- 记录为什么同树 5 绿 1 红：逐条列出 6 个 gate event 的 id/timestamp/tree/verdict、fail 时的 `checker-cost` load 读数、以及本轮 8 次 CMD2 + 2 次 CMD3 的绿读数。
- 不放水：不删/跳过用例、不加 retries、不改 `criterion`/`expect`、不放宽任何断言；只允许「把噪声搬到文件」和「按严格序抬界」。
- 证据逐条记明：每条 AC 的命令原文、exit code、wall time、关键 grep 计数。

## Touches

- vitest.config.ts
- scripts/vitest-console-log.mjs
- scripts/vitest-console-log.test.mjs
- playwright.config.ts
- e2e/voice-realtime-composer-embedded.spec.ts
- tasks/gap-ac323-vitest-stderr-masks-load-flake.md（self）
