---
id: gap-ac323-red-attributable-and-held-run-window
title: AC-323 判据红不可归因：webServer 的 stderr 启动噪声占满 gate 的 500 字符（绿跑实测 13.9 KB，只有
  .env/DEP0190/Vite EPIPE）⇒ 两条 webServer 的 stderr 落盘（绿跑 stderr 归零，红跑 gate 才读
  stdout 尾部拿到失败用例名），并加固 composer-embedded held-run 的 20s 绝对窗口
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

<!-- dedup-ref --> 立案时 `tasks/` 内无 `status: todo|ready|needs-human` 且 `goal_ac: AC-323` 的任务（`grep -l 'goal_ac: AC-323' tasks/*.md` 命中的 8 个全部 `done`），⇒ 本任务为新案；这 8 个 done 是「上一轮修复没挺住」的证据，不是可复用的在飞任务。`task-granularity-advice --touches playwright.config.ts --touches scripts/e2e-web-server-stderr.mjs --touches e2e/voice-realtime-composer-embedded.spec.ts` 报 `peers: []`、`mentions: []` ⇒ 无合并候选。相关但不同机制：`gap-ac323-live-session-bare-reload-and-loaded-criterion-budget`（done，修的是 live-session-send 的裸 reload 与记录 timeoutMs=480000）、`gap-ac323-composer-embedded-disconnect-draft-carry-hides-entry`（done，修的是断线用例退出前的交付等待）。

### 现象（2026-10-21 台账原文 + 本轮直接重跑，不是转述）

- 台账 `.quay/gate-events.jsonl`，`item_id=AC-323`，今日最近两条 fail：
  - `2026-10-21T08:02:51.967Z`，actor `goal-sweep`，tree `0613b90f02c42639cda289145eff68f5b25d6466`，同条 stderr 首行时间 `08:01:53.895Z`（约 58 s 结束），reason 只有启动行 + `[truncated, 513 chars of stderr omitted]`；
  - `2026-10-21T08:14:50.535Z`，actor `goal-cli`，tree `f34c2a259dde9095ebf9b8b1c85c7a6833b40db1`（= 当前 HEAD 的 tree），stderr 首行 `08:12:28.582Z`（约 142 s 结束），同样是启动行 + 513 字符截断。
- 两次 reason 的可见部分逐字只有：`No .env file found or error reading it: ENOENT …`、`(node:NNN) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true …`、`(Use \`node --trace-deprecation …\`)` —— **没有一条 Playwright 的用例名或断言**。
- 同一天的 pass：`08:07:35.782Z`（tree `faef36793d697008494ef1518639cbfe470f2f7b`）、goal-round round 1219（`08:09:05.864Z`，`durationMs=182031`，headSha `01e6c836`）。⇒ 同代码面 pass/fail 交替，判据是概率性红。
- 本轮直接重跑（2026-10-21 16:17–16:24 本地，主机 load ≈40）：
  - CMD1 `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts` ⇒ **exit 0，18 passed (2.2m)**；
  - CMD2 `npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime` ⇒ **exit 0，22 files / 215 tests passed**；
  - CMD3 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` ⇒ **exit 0，6 passed (22.2s)**。
  - 整链再跑一次：CMD1 exit 0 @146 s、CMD2 exit 0 @151 s、CMD3 exit 0 @176 s（累积）——远低于记录 `timeoutMs: 480000`。两次绿 ⇒ 记录本身不在 timeout 上，红是间歇性的。
- 绿跑把 stderr 与 stdout 分流后：**stderr = 13 895 字节**，全部是 webServer 子进程的输出——`[WebServer] … No .env …`、`[WebServer] … DEP0190 …`、以及每个页面关闭/reload 时 Vite 的 `ws proxy error: Error: write EPIPE` 两段栈。stdout 才是 `Running 18 tests` / `✓ …` / `18 passed`。

### 根因一：gate 的失败原因只读 stderr，而 e2e 的 stderr 被 webServer 启动噪声占满

- 插件 0.20.0 的 `withFailureOutput`（`scripts/dist/goal-driver.js`，acceptance-runner）：`errText ? boundedExcerpt(errText, "stderr", budget, true) : outText ? boundedExcerpt(outText, "stdout", budget, false) : …`，`budget = 500 - prefix - 3`；`head=true` 保留 stderr 的**头**，`head=false` 保留 stdout 的**尾**。⇒ 只要 stderr 非空（现在恒非空，13.9 KB 噪声），失败用例名（Playwright 写在 stdout）就永远读不到。
- Playwright 的 `ListReporter.onStdErr` 把 webServer 子进程 stderr 逐字节写进 runner 的 stderr（`node_modules/playwright/lib/runner/index.js` 的 `screen.stderr.write(chunk)`，webServer 插件对子进程 `stderr` 的 `onStdErr` 转发）；用例断言失败则由同一 reporter 写 stdout。两条流的分工就是本任务的全部杠杆。
- 后果：AC-323 已经为同一个判据立案 8 次（arming 首帧、断线草稿、FakeAudioContext、预算、裸 reload、交付行读数……），每次都是盲修；本轮 08:14 的红同样无法归因。

### 根因二：composer-embedded 的 held-run 用例只有一个 20 s 绝对窗口

- `e2e/voice-realtime-composer-embedded.spec.ts` 的 `the leave control and the running turn's stop are told apart, and leaving lets the run finish` 把场景时钟写成 `{ at: 20_000, op: 'row', … }`：从 send 起 20 s 写关闭行；而离开前必须先完成 enterLiveVoice → speak → poll `callCount` → 等 `running-turn-stop` 可见 → 读两个 SVG class → 读 `paneText`，其中任何一步在负载下变慢到 20 s，`expect(await paneText(page)).not.toContain(FINAL_TURN_TEXT)` 就会读到已落地的行并红（注释逐字写着这个语义）。
- 本轮两次测量该用例 24.6 s / 27.1 s（行在 send+20 s 落地，用例尾段只等 ~5 s），余量是个位数秒；它是本链条里**唯一**的绝对时钟断言（upload-fixture 的 240 s hold 是安全方向）。
- 同文件 `test.describe.configure({ mode: 'serial' })` 没有 per-test timeout 覆盖，配置默认 `timeout: 60_000`，所以「把窗口放大」必须同时把该文件的 per-test 预算抬到 120 s，否则用例自己会被 60 s 掐断。

### 做法

1. 新增 `scripts/e2e-web-server-stderr.mjs`（遵循 `scripts/e2e-client-root.mjs` 的头注释风格；`scripts/tsconfig.json` 是 `checkJs: strict`，要用 JSDoc 标注）：导出
   - `withStderrLog(command, logPath)` → `${command} 2> ${JSON.stringify(logPath)}`；
   - `webServerStderrLogs(dataDir)` → `{ server: join(dataDir,'server.stderr.log'), vite: join(dataDir,'vite.stderr.log') }`。
2. `playwright.config.ts`：只改两处 `command`——(a) 普通分支 `: serverLaunchCommand` 改为 `withStderrLog(serverLaunchCommand, logs.server)`；`voiceRawCaptureSelection` / `clientClockCaptureSelection` 的 `2>&1 | tee` 分支逐字不动（它们本来就把子进程输出整体送到 stdout）；(b) client webServer 的 `node_modules/.bin/vite … --strictPort` 追加 `2> …/vite.stderr.log`。目的：runner 的 stderr 只在 Playwright 自己报错时才有内容；服务端诊断一行不少地进 `dataDir` 的两个文件。
3. `e2e/voice-realtime-composer-embedded.spec.ts`：held-run 的 `at: 20_000` → `at: 60_000`；离开后的落地 `expect.poll(paneText, { timeout: 30_000 })` → `{ timeout: 90_000 }`；`test.describe.configure({ mode: 'serial' })` → `{ mode: 'serial', timeout: 120_000 }`。断言一条不删、不弱化：离开前仍必须断言行**未**出现。
4. 测例：`scripts/e2e-web-server-stderr.test.mjs` 钉住 `withStderrLog` 的拼接（含带空格路径的双引号包裹、原命令逐字保留）与 `webServerStderrLogs` 的两个绝对路径；`npm run test:scripts` 会经 `scripts/**/*.test.mjs` glob 真跑到它。

### 为什么前 8 次修复没挺住

前 8 个 done 任务各自修掉一条**可命名的**断言（arming 首帧、断线草稿交接、FakeAudioContext API、预算、裸 reload、交付行读数），但没有任何一次改变「红跑时 gate 只能看到启动噪声」这一事实，也没有碰过 held-run 的 20 s 绝对窗口。所以每出现一种新的时序红，都只能靠人肉重跑猜；本任务把「下次红可命名」本身做成机制，并顺手加固唯一已知的绝对窗口。

### 边界 / 不做

- ⛔ 不改 AC-323 记录的 `criterion` / `expect` 一个字；不改 `goals/AC-323-…md`（`timeoutMs: 480000` 已足够，实测整链 176 s）。
- ⛔ 不改产品代码（`src/`、`server/`）；不改 `workers` / 重试 / `retries`；不删任何 e2e 用例；不加 `test.fixme` / `skip`。
- ⛔ 除 held-run 的窗口外，不放宽任何既有等待或断言；不放宽 `voice-realtime-silence-tail-suppression.spec.ts`（它是按 2026-10-14 裁定故意红的归档 spec，只作控制臂被显式点名）。
- ⛔ 不用「把 stderr 整个丢弃」换归零：服务端诊断必须落进 `dataDir/server.stderr.log`、Vite 诊断落进 `vite.stderr.log`。
- ⛔ 不把 `expect` 第三节被 2026-10-14 裁定删掉的 `voice-realtime-retry` 找回来：现在 spec 断言「a disconnected bar must offer no way back」；判据面是三条命令。

## AC

- [ ] AC1 绿跑 stderr 归零：`npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts >/tmp/green.out 2>/tmp/green.err` exit 0、`18 passed`，且 `test ! -s /tmp/green.err`（0 字节）。
- [ ] AC2 诊断未丢：同一次运行的 stdout 里 `[e2e] data-dir=<D>` 所指的 `<D>/server.stderr.log` 含 `No .env file found or error reading it` 与 `DEP0190`，`<D>/vite.stderr.log` 存在（该次运行若有页面关闭，还应含 `ws proxy error`）。
- [ ] AC3 红跑可归因（控制臂）：`npx playwright test e2e/voice-realtime-silence-tail-suppression.spec.ts >/tmp/red.out 2>/tmp/red.err; echo $?` 为 1、`test ! -s /tmp/red.err`；把 `/tmp/red.out` 按 gate 的规则（`\s+`→单空格、取末 469 字符）截取后同时含 `voice-realtime-silence-tail-suppression.spec.ts` 与 `1 failed`（贴该截取原文）。
- [ ] AC4 held-run 加固：`grep -c "at: 60_000, op: 'row'" e2e/voice-realtime-composer-embedded.spec.ts` == 1、`grep -c "at: 20_000, op: 'row'" e2e/voice-realtime-composer-embedded.spec.ts` == 0、`grep -c 'timeout: 120_000' e2e/voice-realtime-composer-embedded.spec.ts` ≥ 1；`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts -g "leave control"` exit 0、`1 passed`。
- [ ] AC5 判据三条命令逐字绿：CMD1 exit 0 / `18 passed`；CMD2 `npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime` exit 0（22 files / 215 tests）；CMD3 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` exit 0 / `6 passed`；各贴 `echo $?`、list reporter 摘要与 wall time。
- [ ] AC6 静态与单测：`npm run typecheck` exit 0（`scripts/tsconfig.json` 的 `checkJs: strict` 覆盖新 `.mjs`）；`npm run test:scripts` exit 0 且输出含 `scripts/e2e-web-server-stderr.test.mjs`。
- [ ] AC7 不回归兄弟腿：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` exit 0 / `7 passed`；`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts`（整份 serial）exit 0 / `7 passed`。
- [ ] AC8 隔离性：`git diff --stat develop HEAD` 恰好只有 `playwright.config.ts`、`scripts/e2e-web-server-stderr.mjs`（新）、`scripts/e2e-web-server-stderr.test.mjs`（新）、`e2e/voice-realtime-composer-embedded.spec.ts`、`tasks/gap-ac323-red-attributable-and-held-run-window.md`；全部控制臂注入已还原、`git status --porcelain` 为空。

## DoD

- 真实落地：修复在带新 `playwright.config.ts` 的树上跑通判据三条命令（AC5），并现场给出「红跑 gate 会读到什么」的直接读数（AC3 的截取原文）——不是「测试存在」而是 gate 的读数本身被操作过。
- 两半假形态各自现场红/绿并留原始输出：
  - (a) 归因这一半：临时把 server webServer 的 `command` 还原成裸 `serverLaunchCommand` ⇒ 同一条命令的 `/tmp/green.err` 远大于 0 字节、AC3 控制臂的 gate 头部又只剩启动行（红）；恢复后 AC1/AC3 绿。记录注入 diff 与两侧逐字输出。
  - (b) held-run 这一半：临时把 `at: 60_000` 改回 `at: 20_000`，并在离开前读取处注入 21 s 等待 ⇒ 该用例在 `the held run wrote its closing row before the leave` 上红；还原后 AC4 绿。记录注入 diff 与红/绿原文。
- 记录为什么 08:02Z / 08:14Z 两次红无法归因：reason 的可见部分只有 `.env` ENOENT 与 DEP0190 两行，截断标记 513；以及同树的 pass（08:07Z、round 1219）与失败为何是概率性的（stderr 噪声恒在，失败用例名恒在 stdout）。
- 不放水：不删/跳过用例、不加 retries、不改 `criterion` / `expect`、不改产品代码；held-run 只放大场景窗口与对应 per-test 预算，离开前的「行尚未落地」断言逐字保留。
- 证据逐条记明：两条 gate event 的 id/timestamp/tree、两次直接重跑的 exit code 与 wall time、绿跑 stderr 的字节数（修前 13 895 B）、控制臂 spec 的 exit 1 与 stdout 尾部原文、held-run 修前 24.6 s / 27.1 s 的两次测量。

## Touches

- playwright.config.ts
- scripts/e2e-web-server-stderr.mjs
- scripts/e2e-web-server-stderr.test.mjs
- e2e/voice-realtime-composer-embedded.spec.ts
- tasks/gap-ac323-red-attributable-and-held-run-window.md（self）
