---
id: gap-ac307-runner-register-tsconfig-alias
title: AC-307 判据 runner 裸 register() 读到根 tsconfig：@/modules 别名解析不到致判据恒红（AC-310
  barrel 副作用）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-307
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rlE '^status: (todo|ready|needs-human)$' tasks/*.md` 后未见任何在飞任务声明 `goal_ac: AC-307`；唯一声明它的 `gap-voice-realtime-ambiguity-paired-record` 是 `status: done`（上一轮的实现者，非重复）。同机制姊妹 `run-real.mjs`（AC-309 的 runner，`goal_ac: AC-309`）本轮同样红，但那是另一条判据，**不在本任务范围**，只登记（见方案 3）。

### 为什么上一轮的 done 没有守住

`gap-voice-realtime-ambiguity-paired-record`（done, goal_ac: AC-307）把 runner 做对了，当时也确实绿：`node experiments/voice-realtime-ambiguity/run.mjs` 当场 exit 0、打印 48 条读数。它今天红，不是这段代码被改坏了——`run.mjs` 一个字节没动（`git log -- experiments/voice-realtime-ambiguity/run.mjs` 末两笔是它自己那两次提交）。把它撞红的是**后来一个无关任务**：`voice-realtime: live executor routes Realtime function calls to the real send path (AC-310)`（commit `974f5833`）把 `createVoiceRealtimeLiveExecutor` 加进了模块 barrel `server/modules/voice-realtime/index.ts`，而这个执行体**按 `@/*` 别名**引用 MCP 网关（`@/modules/mcp-gateway/index.js`）。`run.mjs` 按模块边界从该 barrel 导入 `connect`，其 tsx 注册是**裸 `register()`**——读的是**仓库根** `tsconfig.json`（`@/*` → `src/*`），不是 `server/tsconfig.json`（`@/*` → `server/*`），于是别名解析不到、runner 在产出任何读数之前就死掉。

**本轮实测（权威）**：

- `node experiments/voice-realtime-ambiguity/run.mjs` → exit 1，逐字：`FAIL: Cannot find package '@/modules' imported from /data/home/yale/work/claudecodeui/server/modules/voice-realtime/voice-realtime-live-executor.ts`。
- `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.17.0/bin/quay goal gate AC-307 --root /data/home/yale/work/claudecodeui` → `"verdict":"fail"`、exit 1，reason 逐字同上。
- 同一条裸命令带上 `TSX_TSCONFIG_PATH=server/tsconfig.json`（本仓既定形态）→ exit 0，打印 `n=24 × 2 arm(s), 48 paired reading(s)`。

⇒ 缺口在 runner 的 tsx 注册，不在读数、语料或口径本身。

### 方案（最小切片）

1. `experiments/voice-realtime-ambiguity/run.mjs`：把裸 `register()` 改成对 **server tsconfig** 注册，形态 `register({ tsconfig: fileURLToPath(new URL('../../server/tsconfig.json', import.meta.url)) })`（`fileURLToPath` 该文件已 import；`register()` 在 `HERE`/`REPO_ROOT` 计算之前调用，故用 `import.meta.url` 相对式，直接用 `REPO_ROOT` 会 TDZ）。紧邻注册处加**一行注释**钉住**为什么**：AC-310 之后 barrel 的运行时半区把 `@/` 带进了导入图，裸 register 读根 tsconfig ⇒ `Cannot find package '@/modules'`。**判据字面量 `node experiments/voice-realtime-ambiguity/run.mjs` 保持不变**——要修的是 runner，不是记录里的命令串。
2. 回归守：在既有 `server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts`（AC-310 的判据文件，其 barrel 变更正是本次根因）追加**一个用例**：以**清洗过 tsx 变量的 env** spawn 上述裸命令，断言 exit 0。清洗是必须的——本仓 worker 环境**ambient 设了 `TSX_TSCONFIG_PATH`**（`scripts/asr-cli-offline-check.mjs` 同因删除它），不删就会把缺口遮住、守用例永远绿。放在既有文件里（不新建 server 测试文件）以避开 `server/shared/tests/quay-test-script.test.ts` 的文件数 pin 与 `scripts/suite-duration-baseline.tsv` 覆盖面地板。
3. 登记（不改）：`run-real.mjs`（AC-309 的 runner）`register()` 同样裸、`node experiments/voice-realtime-ambiguity/run-real.mjs` 同样 `ERR_MODULE_NOT_FOUND`；这是同机制，留给 AC-309 的立案处理。

### 边界（不做）

不改 48 条读数、冻结语料、口径、负对照与 `docs/experiments/2026-10-09-voice-realtime-ambiguity.md` 的表；不重写 runner 的解析/离线替身逻辑（只改 tsx 注册与一行注释）；不改 `goals/AC-307-*.md` 的 `criterion` 字段（应逐字保持不变）；不改 `run-real.mjs`（AC-309 范围）；不动 barrel 本体（AC-310 的设计选择）；不新建 server 测试文件。

## AC

- [ ] AC1 判据命令本身重新跑得起来：`env -u TSX_TSCONFIG_PATH -u TSX_TS_CONFIG_PATH node experiments/voice-realtime-ambiguity/run.mjs` 退出 0，输出逐字含 `n=24 × 2 arm(s)` 与 `48 paired reading(s)`（改前同命令 exit 1、stderr 逐字 `Cannot find package '@/modules'`）。
- [ ] AC2 只修注册、不动读数：改后 `node experiments/voice-realtime-ambiguity/run.mjs --probe` 打印的两条出货模块绝对路径 + 符号名与改前逐字一致；默认运行的类别读数为 `同音 3/6 vs 6/6 · 自我更正 5/5 vs 5/5 · 指代 0/5 vs 3/5 · world-model 2/8 vs 8/8`，与 `docs/experiments/2026-10-09-voice-realtime-ambiguity.md` 表逐字一致。
- [ ] AC3 判据字面量不变且 gate 转绿：`git diff develop...HEAD -- goals/` 对 `goals/AC-307-*.md` 的 `criterion` 零改动（逐字仍 `node experiments/voice-realtime-ambiguity/run.mjs`）；`bash /data/home/yale/.claude/plugins/cache/quay/quay/0.17.0/bin/quay goal gate AC-307 --root /data/home/yale/work/claudecodeui` 退出 0（改前实测 `"verdict":"fail"`、exit 1）。
- [ ] AC4 三条取假形态在**修好的** runner 上仍各自非零退出且判词指名原因：`--corpus=empty`（判词含空读数/`EMPTY`）、`--control=inverted`（判词含 `反方向`/`against`）、`--runs=straddle`（判词含 `2 different runs`）。
- [ ] AC5 守用例证明会红：新用例以清洗 env spawn 裸命令并断言 exit 0；把 `run.mjs` 注册行临时改回裸 `register()` 后该用例**变红**、revert 后恢复绿（给出两次读数）。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts` 退出 0。
- [ ] AC6 静态门：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

真实落地判据：不是「把记录里的命令串改掉」，是**那个裸命令本身重新跑得起来，且下一次「barrel 再加一个 `@/` 依赖」不会再把它静默撞红**。判据必须由真实 gate 现场从 fail（reason 逐字 `Cannot find package '@/modules'`）变绿（不是「我改了 criterion 字段」）；守用例必须被证明**会红**——改回裸 `register()` 后变红、revert 后变绿，读数两次都给——不是「多了一个测试」。读数（48 条）与冻结物（语料/口径/负对照/记录表）零改动，`git diff develop...HEAD` 只含 `run.mjs` 的注册/注释、守用例、与本任务文件三处。

## Touches

- experiments/voice-realtime-ambiguity/run.mjs (edited: register 传 server tsconfig + 一行注释)
- server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts (edited: 追加一个守用例)
- tasks/gap-ac307-runner-register-tsconfig-alias.md (self)
