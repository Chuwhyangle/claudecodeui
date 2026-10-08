---
id: gap-ac305-criterion-repoint-to-repo-tsx-runner
title: AC-305：判据改用本仓 tsx runner（node --test 在 TS-ESM 下恒红，记录未跟改）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-305
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rl "AC-305" tasks/*.md` 只命中已 done 的 `gap-voice-realtime-bridge-offline-provable`（goal_ac: AC-305）——它是本条判据上一轮的实现者，不是重复立案；本仓无其他 todo/ready/needs-human 任务声明 AC-305。

### 为什么上一轮的 done 没有守住

`gap-voice-realtime-bridge-offline-provable`（status=done, goal_ac=AC-305）把实现做对了、今天仍然是对的：`server/modules/voice-realtime/` 的源文件与两份判据测试都在 `develop` 与 `HEAD` 上（`git cat-file -e` 两处均命中），`npx tsx --tsconfig server/tsconfig.json --test <两份>` 实测 `tests 10 / pass 10 / fail 0`、退出 0。缺口不在实现，在 **AC-305 记录里 `criterion` 这条命令本身跑不起来**。

AC-305 记录的 criterion 逐字是：

```
node --test server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts server/modules/voice-realtime/tests/voice-realtime-bridge.false-forms.test.ts
```

本仓 server 代码是 TS-ESM：源码 import 用 `.js` 说明符（如 `../index.js`）指向同名 `.ts`。Node v24 的类型擦除**不做** `.js → .ts` 重映射，实测 `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/modules/voice-realtime/index.js'`，exit 1。只要 criterion 还是 `node --test`，这条 AC 就恒红，与 bridge 实现是否正确无关。

**本轮实测读数（权威）**：`bash /data/home/yale/.claude/plugins/cache/quay/quay/0.17.0/bin/quay goal gate AC-305 --root /data/home/yale/work/claudecodeui` → `"verdict":"fail"`、exit 1，reason 逐字含两份判据文件各自 `✖ … 'test failed'`（两份都在解 `../index.js` 处炸）。

**为什么上一轮没修记录**：上一轮任务体里确实「记录」了命令替换（其完成记录 AC6 段写明字面 `node --test` 在本仓不可执行、改用 `tsx --tsconfig server/tsconfig.json --test`），但那次替换只留在了**任务体**，没有回写 goal 记录 AC-305 的 `criterion` 字段；driver 复跑读的是记录里的 criterion 字符串，于是每轮都撞同一条 ERR_MODULE_NOT_FOUND。这是 `gap-ac-001` / `gap-ac-024` / `gap-ac-025`（均为 criterion-repoint-to-migrated-test）同一机制的新实例——判据钉死的命令/路径与仓库现实不符、记录未跟改；区别是本次不是路径搬迁，而是 **runner 写法**在本仓不成立。

**判据红不是保证退化**：同一套测试换成本仓通用 runner → `tests 10 / pass 10 / fail 0`、退出 0。本仓 137 条 goal 判据里 136 条已用 `npx tsx --tsconfig server/tsconfig.json --test`，只有 AC-305 用 `node --test`——它是唯一的离群写法。

### 方案（最小切片）

1. **把 AC-305 记录的 criterion 改成本仓通用 runner**（两个判据文件逐字不变）。命令形态（`<QT>` = `/data/home/yale/work/claudecodeui`）：

   `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.17.0/bin/quay goal write AC-305 --criterion "npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts server/modules/voice-realtime/tests/voice-realtime-bridge.false-forms.test.ts" --origin "docs/proposals/voice-native-control-plane.md §2/§4/§10.3；criterion 修正：原写法 node --test 在本仓 TS-ESM 下 node 不重映射 .js 说明符，实测 ERR_MODULE_NOT_FOUND 恒红；改为本仓 136/137 条判据通用的 npx tsx --tsconfig server/tsconfig.json --test。两份测试文件逐字未改。" --root <QT>`

   写后复读核对：`quay goal show AC-305 --json` 的 `criterion` 逐字含 `npx tsx --tsconfig server/tsconfig.json --test`、**不含** `node --test`；`status` 仍 `active`、`goal` 仍 `GOAL-029`；`git diff --stat -- goals/` 恰好一个记录文件被改。

2. **在正向判据测试头部补一行溯源注释**，把「本判据必须用本仓 tsx runner、不可回写成 `node --test`」钉在测试侧——本轮缺口的根因正是这条约束只存在于任务体、记录一改就丢。注释必须点名 `npx tsx --tsconfig server/tsconfig.json --test` 与 `AC-305`。⛔ 纯注释：不改任何断言、import 或行为；改后该测试仍须 `pass 10 / fail 0`。

3. **回归**：`quay goal gate AC-305` 转绿；AC-306/AC-307 的记录不受影响。

**边界（不做）**：不改 `server/modules/voice-realtime/` 下任何源码或断言（只加一行注释）；不改 AC-305 的 `expect`/标题/`goal`；不改 GOAL-029 其他 AC 的记录；不重建/不迁移任何测试路径。

## 落地证据

### 判据修正（记录侧）

改前 `quay goal gate AC-305 --root /data/home/yale/work/claudecodeui` 实测 `verdict: fail`、exit 1，reason 含两份判据文件各自 `'test failed'`（两者都撞 `../index.js` 的 `ERR_MODULE_NOT_FOUND`）。`quay goal write AC-305 --criterion "<本仓 tsx runner>" --origin "<修正原因>"` 把记录里的 criterion 改为 `npx tsx --tsconfig server/tsconfig.json --test <两份判据文件>`（两份路径逐字未改）；写入落在主检出 `bacf06fc`（分支 `author`，一文件：AC-305 记录），按仓库惯例 cherry-pick 进本任务分支（`6970a209`）。改后同一命令退出 0、`reason: acceptance passed (exit 0)`，新 GateEvent `treeSha=ec7914d6…`。复读 `quay goal show AC-305 --json`：criterion 逐字含 `npx tsx --tsconfig server/tsconfig.json --test`、全文不含 `node --test`、`status: active`、`goal: GOAL-029`、`origin` 含本次修正原因。

### 「恰好一条记录」的读数

goal ABI 的写自带提交（`commitGoalFile` → `commitStoreWrite`），故写后工作树是干净的、裸 `git diff --stat -- goals/` 为空。本次改动引入的记录面读数取「本任务相对 develop 的 goals 变更」：工作树内 `git diff develop --stat -- goals/` 恰好一个文件（AC-305 记录，8 行），写提交 `bacf06fc`（及其 cherry-pick `6970a209`）的 `--stat` 同样恰好一个文件；AC-306/AC-307 及任何其他 AC 记录未被波及。

### 测试侧溯源注释（注释-only）

`server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 顶部 JSDoc 内加了一段 provenance：逐字点名 `npx tsx --tsconfig server/tsconfig.json --test` 与 `AC-305`（`grep -c` 各 ≥1），并写明本仓 server 是 TS-ESM、`node --test` 不重映射 `.js`→`.ts` 故恒红。注释-only 由判据 6 的 grep 机械证明（`+` 行过滤注释前缀后为空），`--stat` 为 `13 insertions(+), 0 deletions(-)`；改后同一命令 `tests 10 / pass 10 / fail 0`。

### 其余读数

- 判据命令（本仓 tsx runner）：退出 0，`tests 10 / pass 10 / fail 0`。
- `npm run typecheck`、`npm run lint` 退出码 0（lint 仅有既存 warning，无 error）。
- 边界守住：未改 `server/modules/voice-realtime/` 任何源码或断言（只加注释）；未改 AC-305 的 `expect`/标题/`goal`；未改 GOAL-029 其他 AC 记录；未重建/迁移任何测试路径。

L_D 该轴仍暗，理由：本任务只修一条 AC 记录的判据命令写法 + 一行注释，不产出新的领域判据，无可读的两轴读数。
L_G 该轴仍暗，理由：同上。

## AC

- [x] `bash /data/home/yale/.claude/plugins/cache/quay/quay/0.17.0/bin/quay goal gate AC-305 --root /data/home/yale/work/claudecodeui` 退出 0（改前实测 `"verdict":"fail"`、exit 1；改后必须转绿，新 GateEvent 的 `treeSha` 对应本轮 HEAD）。
- [x] `quay goal show AC-305 --json --root <QT>` 的 `criterion` 逐字含 `npx tsx --tsconfig server/tsconfig.json --test` 且全文不含 `node --test`；`status` 仍为 `active`、`goal` 仍为 `GOAL-029`；`origin` 含本次修正原因（runner 写法）。
- [x] `git diff --stat -- goals/` 显示恰好一个记录文件被修改（本次写未波及 AC-306/AC-307 或任何其他 AC 记录）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts server/modules/voice-realtime/tests/voice-realtime-bridge.false-forms.test.ts` 退出 0 且输出 `pass 10` / `fail 0`。
- [x] `server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 头部注释逐字含 `npx tsx --tsconfig server/tsconfig.json --test` 与 `AC-305`（`grep -c` 各 ≥1）。
- [x] 溯源注释是注释-only：`git diff -U0 develop...HEAD -- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts | grep -E '^\+' | grep -v '^+++' | grep -vE '^\+\s*(//|\*|/\*)'` 输出为空。
- [x] `npm run typecheck`、`npm run lint` 退出码 0。

## DoD

真实落地判据：**gate 转绿必须由真实 gate 证明，不是「我改了记录」**。`quay goal gate AC-305` 必须现场由 `fail`（reason 含两份判据文件各自 `test failed` / `ERR_MODULE_NOT_FOUND`）变为退出 0；同一 root 下复读 `goals/AC-305-*.md`，`criterion` 逐字正确、不含 `node --test`、`status` 仍 `active`、`goal` 仍 `GOAL-029`，且 `git diff --stat -- goals/` 证明本次只动了这一条记录。下一轮 driver 通过 `goal_ac: AC-305` 独立复跑时，会真的执行那两份测试（而不是撞 ERR_MODULE_NOT_FOUND），看到 AC1–AC5 与三条取假形态仍绿——即判据断言的性质在真实链路上活着，且判据本身跑得起来。测试侧注释必须在 `git diff develop...HEAD` 里可见且**零代码行改动**（由上面那条 grep 证明）。

L_D 该轴仍暗，理由：本任务只修一条 AC 记录的判据命令写法 + 一行注释，不产出新的领域判据，无可读的两轴读数。
L_G 该轴仍暗，理由：同上。

## Touches

- goals/AC-305-realtime-bridge-与工具调用在假-ws-服务端上离线可证.md
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts (edited: 头部一次注释-only 溯源，点名本仓 tsx runner)
- tasks/gap-ac305-criterion-repoint-to-repo-tsx-runner.md (self)