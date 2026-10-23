---
id: gap-ac323-vitest-stderr-masks-load-flake
title: AC-323 同树概率性红（5 连绿 → 20:24 load≈90–100 时 exit 1）：CMD2 vitest 的
  console.error 占满 gate 的 stderr 头部使红不可归因 ⇒ 噪声落盘恢复归因、复现并修掉负载时序红
status: done
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

- [x] AC1 归因恢复（绿跑 stderr 去噪）：`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime >/tmp/ac323-cmd2.out 2>/tmp/ac323-cmd2.err; echo $?` → exit 0，且 `grep -cE "session lapse recorded|Not implemented|UPSTREAM_ERROR" /tmp/ac323-cmd2.err` == 0；`/tmp/ac323-cmd2.out` 含落盘日志路径，该日志含 `session lapse recorded` 与 `UPSTREAM_ERROR`（内容没丢）。
- [x] AC2 控制臂（红可命名）：临时新增必然失败的 `src/modules/chat/voice-realtime/tests/ac323AttributionProbe.test.ts`（`expect(1).toBe(2)`），跑 AC1 同一条命令 → exit 1；把其输出按 gate 规则（`\s+`→单空格、500 字符、stderr 头 else stdout 尾）截取后同时含 `ac323AttributionProbe.test.ts` 与 `1 failed`；删除探针后该文件不在 `git status --porcelain`。贴截取原文。
- [x] AC3 负载臂 3 连绿：`cat /proc/loadavg` 贴三次读数（均 ≥90），在每次读数下完整跑 criterion 三条命令各一遍，三次均 exit 0、单次 wall time < 480000ms；若修前在该臂下复现过红，贴出恢复归因后的失败名与所修那一行的 diff。
- [x] AC4 三条命令逐字绿：CMD1 `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts` exit 0 / `18 passed`；CMD2 exit 0（`22 files` / 218 tests）；CMD3 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` exit 0 / `6 passed`；各贴 `echo $?`、摘要、wall time。
- [x] AC5 边界未破：`grep -nE "WEB_SERVER_TIMEOUT_MS|BOOT_CEILING_MS|SINGLE_SPEC_CEILING_MS" playwright.config.ts` 的三个常量若被抬，仍满足 `WEB < BOOT < SINGLE < 60_000` 的严格序（贴数值与一次 `node -e` 断言 exit 0）；`git diff -- goals/` 为空。
- [x] AC6 不回归兄弟腿：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` exit 0 / `7 passed`；`npm run test:scripts` exit 0 且输出含新增 `scripts/vitest-console-log.test.mjs`（若该文件存在）。
- [x] AC7 隔离性：`git diff --stat develop HEAD` 只含本任务 `## Touches` 列出的文件；`git status --porcelain` 为空；`git diff develop HEAD -- e2e src playwright.config.ts vitest.config.ts scripts | grep -cE "test\.fixme|\.skip\(|retries"` == 0（无新增放水）。

## DoD

- 真实落地：归因机制在**真实 gate 读数**上被操作过——贴一条故意红跑经 gate 规则截取后的原文，证明失败用例名回到 excerpt；不是「加了一个 helper、写了一个单测」。
- 两次现场假形态，红/绿各留原文：
  - (a) 归因臂：临时恢复「测试 console 直接进 stderr」⇒ AC2 的截取只剩 console 噪声、不含失败用例名（红）；恢复后含失败用例名（绿）。记录注入 diff。
  - (b) 负载臂：若修的是 boot/vitest 界，临时把该界改回旧值并在 load1 ≥90 下跑，红/绿各一次并贴原文；还原后 AC3 绿。
- 记录为什么同树 5 绿 1 红：逐条列出 6 个 gate event 的 id/timestamp/tree/verdict、fail 时的 `checker-cost` load 读数、以及本轮 8 次 CMD2 + 2 次 CMD3 的绿读数。
- 不放水：不删/跳过用例、不加 retries、不改 `criterion`/`expect`、不放宽任何断言；只允许「把噪声搬到文件」和「按严格序抬界」。
- 证据逐条记明：每条 AC 的命令原文、exit code、wall time、关键 grep 计数。

## Evidence

### AC1 归因恢复（绿跑 stderr 去噪）

```
$ npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime >/tmp/ac323-cmd2.out 2>/tmp/ac323-cmd2.err; echo $?
0                                   # WALL=5673ms
$ wc -c /tmp/ac323-cmd2.err
0 /tmp/ac323-cmd2.err               # 绿跑 stderr 全空
$ grep -cE "session lapse recorded|Not implemented|UPSTREAM_ERROR" /tmp/ac323-cmd2.err
0
$ grep -o 'console-log=[^ ]*' /tmp/ac323-cmd2.out | head -1
console-log=/tmp/quay-vitest-console-814503.log
$ grep -c 'session lapse recorded' /tmp/quay-vitest-console-814503.log ; grep -c 'UPSTREAM_ERROR' /tmp/quay-vitest-console-814503.log ; wc -l < /tmp/quay-vitest-console-814503.log
2 ; 4 ; 1130                        # 内容没丢
Test Files  22 passed (22) ; Tests  218 passed (218)
```

机制：`scripts/vitest-console-log.mjs` 的 `onConsoleLog` 把每行测试 console 追加到 `QUAY_VITEST_CONSOLE_LOG`（owner pid 命名，fork 出的 worker 继承同一路径），返回 `false` 停止转发；`vitest.config.ts` 在 stdout 报路径。

### AC2 控制臂（红可命名）

临时探针 `src/modules/chat/voice-realtime/tests/ac323AttributionProbe.test.ts`（`expect(1).toBe(2)`），同一命令 → **exit 1**（stdout 22 passed + 1 failed；stderr 738 字节）。按 gate 规则截取（`\s+`→单空格；`budget = 500 - len("acceptance failed (exit 1)") - len(" — ") = 471`；stderr 非空取头），**源=stderr**：

```
acceptance failed (exit 1) — [vitest] 1 failed | 22 passed (23 files) ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯ FAIL src/modules/chat/voice-realtime/tests/ac323AttributionProbe.test.ts > AC2 attribution probe: deliberately fails AssertionError: expected 1 to be 2 // Object.is equality [32m- Expected[39m [31m+ Received[39m [32m- 2[39m [31m+ 1[39m ❯ src/modules/chat/voice-realtime/tests/ac323AttributionProbe.test.ts:6:13 4| // This file is created, run once … [truncated, 593 chars of stderr omitted]
```

- 含 `ac323AttributionProbe.test.ts` = **true**；含 `1 failed` = **true**
- 删除探针后 `git status --porcelain` 只剩 ` M vitest.config.ts` / `?? scripts/vitest-console-log.mjs` / `?? scripts/vitest-console-log.test.mjs`，不含探针文件。

为什么还要 verdict reporter：vitest 把失败块写 stderr，但 `1 failed` 只在 stdout 的摘要里。只做 console 降噪时，excerpt 有失败文件名却没有 verdict。`scripts/vitest-console-log.mjs` 的 `createFailureVerdictReporter()` 注册在 `default` 之前（`report()` 按数组序同步调用），红跑把 `[vitest] N failed | M passed (K files)` 写在 stderr 首行；绿跑不写（AC1 的 stderr=0 就是它的证据）。

### AC3 负载臂 3 连绿

受控忙循环：90×`nice -n 5 yes >/dev/null`（PID 记在 `/tmp/ac323-burners.pids`，三轮后逐 PID kill，`pgrep -c -x yes`=0）。每轮开头读 `/proc/loadavg`，随后完整跑三条命令。

| 轮 | LOAD_AT_START（load1≥90） | CMD1 | CMD2 | CMD3 | TOTAL |
|---|---|---|---|---|---|
| 1 | `92.58 71.92 64.70` | exit 0 / 191401ms / `18 passed (3.2m)` | exit 0 / 8368ms / 218 tests | exit 0 / 45738ms / `6 passed (44.1s)` | 245507ms |
| 2 | `143.94 106.11 80.29` | exit 0 / 209743ms / `18 passed (3.5m)` | exit 0 / 8642ms / 218 tests | exit 0 / 38778ms / `6 passed (36.8s)` | 257163ms |
| 3 | `140.33 145.11 104.84` | exit 0 / 195882ms / `18 passed (3.2m)` | exit 0 / 8826ms / 218 tests | exit 0 / 38934ms / `6 passed (37.5s)` | 243642ms |

三轮均 exit 0；单轮 wall 245.5s / 257.2s / 243.6s **< 480000ms**；三轮 CMD1/CMD2/CMD3 的 stderr 均 0 字节。**该臂下未复现红** ⇒ 无「恢复归因后的失败名」可贴，也没有抬任何 boot/vitest 界（`git diff develop HEAD -- playwright.config.ts` 为空）。

### AC4 三条命令逐字绿（quiet 链，per-command 记录）

```
CMD1 exit=0 wall=173861ms report=18 passed (2.9m)
CMD2 exit=0 wall=5376ms  report=Tests 218 passed (218) files=Test Files 22 passed (22)
CMD3 exit=0 wall=24520ms report=6 passed (23.7s)
TOTAL wall=203759ms ; CHAIN_EXIT=0 ; STDERR_BYTES=0
```

### AC5 边界未破

- `WEB_SERVER_TIMEOUT_MS=35000`、`BOOT_CEILING_MS=40000`、`SINGLE_SPEC_CEILING_MS=55000`（三者均**未改**）。
- `node -e` 断言 `35000 < 40000 < 55000 < 60000` → **exit 0**（打印 `STRICT ORDER OK`）。
- `git diff -- goals/` 为空（0 行）。

### AC6 不回归兄弟腿

- `npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` → **exit 0**，`7 passed (1.8m)`，wall 106003ms，stderr 0 字节。
- `npm run test:scripts` → **exit 0**，`ℹ tests 510 / ℹ pass 510 / ℹ fail 0`，wall 132777ms；输出含 `scripts/vitest-console-log.test.mjs`（`node scripts/list-script-tests.mjs` 与 `node --test` 各一次）。

### AC7 隔离性

- `git diff --stat develop HEAD` = 7 个文件，全部在 `## Touches`：`vitest.config.ts`、`scripts/vitest-console-log.mjs`、`scripts/vitest-console-log.test.mjs`、`scripts/asr-health-provider-check.mjs`、`scripts/asr-pause-cues-source-check.mjs`、`scripts/asr-proxy-only-ssrf-check.test.mjs`、`scripts/asr-trim-capability-check.test.mjs`（第 8 个是本 task 文件，由 `task_write` 自提交）。
- `git status --porcelain` 为空。
- `git diff develop HEAD -- e2e src playwright.config.ts vitest.config.ts scripts | grep -cE "test\.fixme|\.skip\(|retries"` = **0**。

### DoD (a) 归因臂假形态（红/绿各留原文）

注入：`git show develop:vitest.config.ts > vitest.config.prefix-probe.ts`，用 `npx vitest run --config vitest.config.prefix-probe.ts …` 跑同一探针（临时文件，跑完即删，未提交）。**红（修前）**：exit 1，stderr 11975 字节，excerpt 源=stderr：

```
acceptance failed (exit 1) — stderr | src/modules/chat/tests/composerCompactTier.test.tsx > (a) a wide window with a box under the threshold takes the compact arrangement [Auth] session lapse recorded: {"reason":"storage-empty","exp":null,"now":1792787719695,"at":"2026-10-23T20:35:19.695Z"} stderr | src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx > a recoverable failure stays in the console > UPSTREAM_ERROR and MODEL_TEXT_REPLY  … [truncated, 11565 chars of stderr omitted]
```

含探针文件名 = **false**，含 `1 failed` = **false** —— 与 20:24 的真实 gate 红逐字同形（两条 console 行 + truncation）。**绿（修后）**：见 AC2，两者皆 true。

### DoD (b) 负载臂假形态

**不适用**：本轮未修 boot/vitest 界（AC3 三次都没复现红），`playwright.config.ts` 与 `vitest.config.ts` 的 timeout 常量均未动，故没有「改回旧值」的对象。

### DoD 为什么同树 5 绿 1 红

6 条同树 gate event（tree `c6f8a24c65f6a3f0fa946ff6bcb467edc104fc76`）：

| id | timestamp | verdict |
|---|---|---|
| ddc66391-5909-4d82-bf28-e3adde7975ba | 2026-10-23T19:49:35.134Z | pass |
| 5522b53e-7ebb-4258-9724-366d3f9f3af5 | 2026-10-23T19:55:19.339Z | pass |
| 19f08e82-c36a-4720-9036-098c8a77d40c | 2026-10-23T20:00:59.648Z | pass |
| 97866769-3da9-4a90-83b6-d2fdedad4834 | 2026-10-23T20:06:31.523Z | pass |
| 17edc5ea-fe9c-45ee-9381-dc5e0d298c34 | 2026-10-23T20:12:21.592Z | pass |
| 7ca8e111-48ff-44b8-abb9-043bc399cf63 | 2026-10-23T20:18:02.958Z | pass |
| f4d801da-599b-4fc2-8996-84e4c97977ab | 2026-10-23T20:24:03.719Z | **fail** |

fail 前后 `.quay/checker-cost.jsonl` 的 load（20:22:46–20:24:07）：`102.45 / 98.09 / 94.32 / 97.33 / 90.43 / 99.69 / 95.71 / 97.01 / 95.41 / 89.36`，而 20:22:13 还是 `36.34` ⇒ 红与负载尖峰同窗。立案轮的两条快腿读数：CMD2 8 连 exit 0（22 files/218 tests，4.7–5.5s，load≈66）、CMD3 2 连 exit 0（6 passed，26.6–28.4s）。本轮新增绿读数：CMD2 5 次 5.376–8.826s、CMD3 5 次 23.7–45.7s（含 load1 92.6–143.9 的三轮）。

### 附加：基线红恢复（AC6 第二条腿的前置）

`npm run test:scripts` 在 develop tip 上本来就是红的（26 fail / 4 文件）。在**主检出（= develop tip 52133348a，不含本分支任何改动）**逐字复跑 `node --test <file>` 复现同一红 ⇒ 红在 develop 侧，由 099740ca0（`shared/voice/voiceContextTruncation.ts` 经 `@shared` 别名进入 voice.service）与 46a872e3f/87a4199ab（relay provider 注册）造成，四套反证夹具没跟着长。为让 AC6 逐字成立，本任务**只补夹具输入/恢复被注释散文打红的读数**：

- `scripts/asr-health-provider-check.mjs`：`FIXTURE_FILES` 补 `shared/voice/voiceContextTruncation.ts` → 8/8。
- `scripts/asr-proxy-only-ssrf-check.test.mjs`：`SHIPPING_FILES` 补 `shared/voice/{voiceSettingsRegistry,voiceContextTruncation}.ts` → 6/6。
- `scripts/asr-trim-capability-check.test.mjs`：`SHIPPING_FILES` 补 relay 的 evidence 记录；`CONSUMER_IMPORT` 重锚到当前 `import { trimDecisionFor, trimSilenceEdges } …`（`099740ca0` 后漂移），变异只摘掉 capability 符号 → 12/12。
- `scripts/asr-pause-cues-source-check.mjs`：客户端声明扫描先 `stripComments`（与 `asr-health-provider-check.mjs` 自 de6a8afe6 起用的同一 quote/regex-aware walk），JSDoc 里的 `pauseCues: 'neutral'` 不再被读成客户端第二张表 → 7/7。

未删/跳过任何用例、未加 retries、未改任何断言、未改 `criterion`/`expect`。

## Touches

- vitest.config.ts
- scripts/vitest-console-log.mjs
- scripts/vitest-console-log.test.mjs
- scripts/asr-health-provider-check.mjs
- scripts/asr-proxy-only-ssrf-check.test.mjs
- scripts/asr-trim-capability-check.test.mjs
- scripts/asr-pause-cues-source-check.mjs
- playwright.config.ts
- e2e/voice-realtime-composer-embedded.spec.ts
- tasks/gap-ac323-vitest-stderr-masks-load-flake.md（self）
