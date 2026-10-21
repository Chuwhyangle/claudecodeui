---
id: gap-ac408-beforeall-abort-artifact-and-harness-attribution
title: AC-408 红跑不可归因且 beforeAll 中止不留证据：08:33 的 fail 无 run.json、gate 只读到 .env
  噪声（同树复跑 3/3 绿）⇒ harness 侧阶段标记 + 部分 dump + 失败原因落 stderr/日志
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-408
---
## Proposal

### 现象（本轮直接测量，不是台账转述）

- 台账 fail：`.quay/gate-events.jsonl` 的 `id=57ee044f-6959-4db3-a29a-1e9d6fabc790`，`2026-10-21T08:33:24.585Z`，`item_id=AC-408`，`treeSha=9a06bd3aac2677375af5feea0863ffaa2f276817`（= 当前 HEAD `543f87e39` 的 tree）。`reason` 逐字只有一行：
  `acceptance failed (exit 1) — [WebServer] 2026-10-21T08:32:59.505Z No .env file found or error reading it: ENOENT: no such file or directory, open '/data/home/yale/work/.claudecodeui-envfree-4d8xty/.env'`
  ——没有任何 Playwright 用例名、断言或错误本体，也没有 `[truncated, … stderr omitted]` 标记（说明 stderr 本身很短）。
- 同树直接复跑 3 次（本地 16:34 / 16:35 / 16:36，即 08:34Z / 08:35Z / 08:36Z）：全部 **exit 0**、Playwright `9 passed`、`[voice-e2e] RESULT: PASS (exit 0)`；`narrator speaks` 5 条、`tts-requests=1 audio-bytes=80044 played=true`、`detector utterances=4/4`。⇒ **AC-408 的保证当前为真**，上一版修复（commit `35c9ba549`）确实守住了；本轮红不是行为回归。
- 失败跑的唯一产物目录 `/tmp/voice-e2e-plan-bQYyWs/` **只有 `plan.json`，没有 `run.json`**。spec 的 dump 写在 `beforeAll` 末尾（`e2e/voice-output-e2e-harness.spec.ts:1053`），所以没有 dump ⇒ 这次红是 **`beforeAll` 阶段中止**，不是 9 条断言中的某一条。
- 失败跑从 server 启动（08:32:59.505）到 gate 记账（08:33:24.585）约 **25 s**；正常绿跑约 40 s。早段中止与「dump 未写」一致。

### 根因一：`beforeAll` 中止不留任何证据

`test.describe.configure({ mode: 'serial', timeout: 180_000 })`（spec:609）+ 一个承担全部交互的 `test.beforeAll`（spec:611–1069）。`beforeAll` 里任一 await 抛错或超时，Playwright 把失败记到第一条用例（本轮实测形状：`:1071:3` 0 ms，其后 8 条 `did not run`），而 `VOICE_E2E_DUMP` 的写入发生在 `beforeAll` 最后（spec:1053–1059），**永远执行不到**。⇒ 下一次红仍然只能靠猜。

### 根因二：失败原因在 stdout，而 gate 只读 stderr

- `experiments/voice-e2e-harness/run.mjs:415-417` 用 `stdio: 'inherit'` 启动 Playwright：它既不捕获、也不落盘、更不能在失败时重述子进程的输出。
- Playwright 把用例/`beforeAll` 错误写 **stdout**；stderr 里是 webServer 子进程的输出（`.env` 警告、DEP0190、Vite EPIPE）。
- 插件 0.20.0 的 `withFailureOutput`（`packages/quay/src/gate/acceptance-runner.ts`）**只要 stderr 非空就取 stderr 的头 460 余字符**，只有 stderr 为空才回退到 stdout 尾部。⇒ 现在 stderr 恒非空，失败本体（stdout）永远进不了 `reason`。

本轮做了两个**确定性控制臂**（不是推断）：

1. `node experiments/voice-e2e-harness/run.mjs --sample 402fad85 -- --grep 'zzz-no-such-test-name'` → exit 1；stdout 末段有 `Error: No tests found.`；stderr 只有 `.env` 一行。
2. 先用一个 loopback server 占住端口 P，再直接跑
   `VOICE_E2E_PLAN=/tmp/voice-e2e-plan-EybQAK/plan.json VOICE_E2E_DUMP=/tmp/ac408-partial-probe.json VOICE_E2E_TTS_PORT=$P VOICE_REALTIME_TTS_VOICE=voice-e2e-standin VOICE_E2E_ANNOUNCE_TEXT='好的，我来查一下。' VOICE_E2E_SUMMARY_TEXT='本轮任务已结束，全部检查通过。' npx playwright test e2e/voice-output-e2e-harness.spec.ts`
   → exit 1；stdout 有 `Error: listen EADDRINUSE: address already in use 127.0.0.1:$P`、`1 failed`、`8 did not run`；stderr 只有 `.env` 一行；`/tmp/ac408-partial-probe.json` **不存在**。

  两个控制臂经 gate 的 `withFailureOutput` 规则（stderr 非空 ⇒ 取 stderr 头）后，读数与 08:33 台账逐字同形。控制臂 2 同时证明了「`beforeAll` 中止 ⇒ 无产物」这条路径可确定性复现。

### 为什么上一版修复没守住

上一版 `gap-ac408-harness-pin-early-announce-id-family`（done，commit `35c9ba549`）修的是判据钉住的 announce id 族，它**守住了**（本轮同树 3/3 绿）。08:33 不是那条修复失效，而是「红跑不可归因 + `beforeAll` 中止无产物」这族缺陷。它今天在 AC-323 上已被立案（`gap-ac323-red-attributable-and-held-run-window`，ready），但那条改的是 `playwright.config.ts` 的 webServer stderr 落盘，走 gate 的 **stdout 尾部**；对 AC-408 这条 `beforeAll` 中止，stdout 尾部只有「第一条用例名 + 1 failed + 8 did not run」，仍读不到错误本体（`EADDRINUSE` 在更早的 numbered failure block 里），也不会留下 harness 自己的阶段产物。

<!-- dedup-ref --> 机制去重：与本任务最接近的在飞任务是 `gap-ac323-red-attributable-and-held-run-window`（`status: ready`，`goal_ac: AC-323`）。**separate**：它只改 `playwright.config.ts` + composer-embedded spec，走「stderr 归零、gate 读 stdout 尾」；本任务只在 AC-408 自己的 harness 内做「阶段产物 + 失败原因落 stderr/日志」，不碰 `playwright.config.ts`，两条不共享 Touches（`task-granularity-advice.js`：`peers: []`、`mentions: []`）。相关但已 done 的任务：`voice-output-tts-downlink-wiring`（首次接通下行）、`gap-ac408-harness-pin-early-announce-id-family`（id 族对齐）——都不是本次机制。

### 要做的

1. **`run.mjs` 捕获并转发子进程输出**：`spawnSync(playwright, …)` 的 `stdio` 从 `'inherit'` 改为 `['ignore','pipe','pipe']`；把子进程 stdout 原样写到本进程 stdout、stderr 原样写到本进程 stderr（绿跑的输出与退出码逐字不变），并把两者全量落盘到 **dump 同目录的 `playwright.log`**（`--dump /x/run.json` ⇒ `/x/playwright.log`；无 `--dump` 时落在 plan 目录）。
2. **失败摘要进 stderr**：子进程非 0 时，从捕获文本里挑出失败摘要（含 `Error:`、`failed`、`did not run`、`✘` 的行；限长约 4 KiB），在 `[voice-e2e] RESULT: FAIL` 之前写到 **stderr**——这样只读 stderr 的 gate 也能拿到原因。⛔ 不要为了归因把 stdout 整个灌进 stderr（日志会翻倍且掩盖真实原因）。
3. **spec 阶段标记 + 部分 dump**：在 `beforeAll` 主体里维护 `currentPhase`，至少覆盖 `upstream-standin` → `tts-standin` → `account` → `scenario-armed` → `resident-started` → `client-warm` → `mounted` → `live-voice-entered` → `upstream-connected` → `played` → `utterances-heard` → `relayed` → `tts-observed` → `narrator-observed`；用 `try/catch` 包住 `beforeAll` 主体，`catch` 里先写 `{ plan, failure: { phase: currentPhase, message, stack } }` 到 `VOICE_E2E_DUMP`，再原样 `throw`。
4. **文档说真话**：在 `run.mjs` 的头注释里补一句「失败时原因落在 stderr + `playwright.log`」，在 spec 的 `RUN` 注释旁补一句「`beforeAll` 中止会写只含 `failure` 的部分 dump」。

### 不要做的

- ⛔ 不改 `playwright.config.ts`（在飞的 AC-323 任务拥有它；两边同时改会撞 Touches）。
- ⛔ 不改 `criterion` / `expect`、不删/跳过任何用例、不加 `retries`、不放宽任何等待或断言。
- ⛔ 不改产品代码（`server/`、`src/`）；本任务只动 harness。
- ⛔ 不把 stderr 摘要做成「全文转储」；全量留在 `playwright.log`。
- ⛔ 不在本任务里声称已找到 08:33 的瞬时根因：目标是让**下一次**红自己点名阶段；若连跑中出现红，按产物修那一条腿，但不得用重试掩盖。

## AC

- [ ] **AC1 判据当前为真且可重复**：`node experiments/voice-e2e-harness/run.mjs --sample 402fad85` 连续 3 次，每次 exit 0、Playwright 汇总含 `9 passed`、日志含 `[voice-e2e] RESULT: PASS (exit 0)`，且不得出现 `did not run`。贴三次的起止时刻与 `narrator speaks` 读数。
- [ ] **AC2 失败原因进 stderr 且全量落盘（控制臂）**：`node experiments/voice-e2e-harness/run.mjs --sample 402fad85 --dump /tmp/ac408-ac2/run.json -- --grep 'zzz-no-such-test-name' >/tmp/ac408-ac2.out 2>/tmp/ac408-ac2.err; echo $?` 为 1；`/tmp/ac408-ac2.err` 含 `No tests found`；`/tmp/ac408-ac2/playwright.log` 存在且含 `Running` 或 `No tests found`。取假形态：把 `run.mjs` 的 `stdio` 改回 `'inherit'` 时 `/tmp/ac408-ac2.err` 只有 `.env` 一行、必红（本立案日已实测该假形态）。
- [ ] **AC3 beforeAll 中止写部分 dump（控制臂）**：占住一个 loopback 端口 P 后，用
  `PLAN=$(node experiments/voice-e2e-harness/run.mjs --sample 402fad85 --plan-only | sed -n 's/^\[voice-e2e\] plan=//p')`，
  `VOICE_E2E_PLAN=$PLAN VOICE_E2E_DUMP=/tmp/ac408-ac3/run.json VOICE_E2E_TTS_PORT=$P VOICE_REALTIME_TTS_VOICE=voice-e2e-standin VOICE_E2E_ANNOUNCE_TEXT='好的，我来查一下。' VOICE_E2E_SUMMARY_TEXT='本轮任务已结束，全部检查通过。' npx playwright test e2e/voice-output-e2e-harness.spec.ts` 为 exit 1；且 `/tmp/ac408-ac3/run.json` 存在、`failure.phase === 'tts-standin'`、`failure.message` 含 `EADDRINUSE`。取假形态：当前实现（本立案日已实测）该文件不存在、必红。
- [ ] **AC4 成功路径不写 failure、既有读数字段不丢**：正常跑一次并 `--dump /tmp/ac408-ac4/run.json`（exit 0）后，`node -e` 读该 dump 断言：`failure` 键不存在，且 `plan`、`detector.speechStopped`、`relay.messages`、`narrator.speaks`、`narrator.tts` 均存在（与 AC-408 既有判据同源读数）。
- [ ] **AC5 静态不回归**：`npm run typecheck` exit 0；`npm run lint` exit 0。

## DoD

- **真实对象被真正操作过**：在本仓库真实 app server + 真实浏览器上把判据跑完 3 次（AC1），并现场做两条控制臂（AC2/AC3），贴出原始 stdout/stderr 与产物文件的 `ls -l`、`cat` 读数——不是「测试存在」。
- **gate 读数被现场重放**：把 AC2/AC3 修后的 stderr 按 `withFailureOutput` 的规则（stderr 非空 ⇒ 取头 460 余字符）截取，结果必须含 `No tests found` / `EADDRINUSE`，而不是 `.env` 噪声；贴该截取原文。
- **阶段产物可读**：贴出 AC3 的 `run.json` 中 `failure` 对象原文（`phase` + `message` + `stack` 首行），并说明它把 08:33 那种「无产物红」变成可命名的阶段。
- **不真空**：AC2 的假形态（`stdio:'inherit'`）与 AC3 的假形态（当前实现）都必须在立案日已有的读数上变红；AC4 证明成功路径没有被失败分支污染。
- **不改判据面**：不删/跳过用例、不加 retries、不放宽断言、不改产品代码、不碰 `playwright.config.ts`；`git diff --stat develop HEAD` 只含本任务 Touches 的文件。
- **诚实边界**：08:33 的瞬时根因仍未定位；本任务交付的是「下一次红可归因 + 可命名阶段」。若 AC1 的 3 次里出现红，按新产物点名阶段并记录，但不得用重试或放宽断言凑绿。

## Touches

- experiments/voice-e2e-harness/run.mjs
- e2e/voice-output-e2e-harness.spec.ts
- tasks/gap-ac408-beforeall-abort-artifact-and-harness-attribution.md
