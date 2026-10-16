---
id: gap-ac393-resident-legacy-path-ratchet
title: AC-393 旧路径棘轮：server/ 全部非测试代码里 `supersedeRunning` / `resultTimes` /
  `resultsSeenAtStart` 与 driver 的 `.rounds` 的活代码 AST 计数只减不增，`resultsSeenAtStart`
  恒为 0；交付 server/shared/tests/resident-legacy-path-ratchet.test.ts +
  入库基线（含负对照与取假形态）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-393
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: *AC-393' tasks/*.md` → **0** 命中；`grep -rln 'AC-393' tasks/` → **0** 命中；`ls tasks/ | grep -i ratchet` → **0** 命中 ⇒ 无任何状态（含 todo / ready / needs-human）的任务认领 AC-393。同批兄弟 `gap-ac380` … `gap-ac392` 各认领各自 AC，判据文件互不相同；本条与 `gap-ac390`（对账与可观测）同属 GOAL-045，但机制不同——前者是**行为**判据，本条是**静态位置符号计数**棘轮，无实现交集。

合并候选：`node /data/home/yale/.claude/plugins/cache/quay/quay/0.20.0/scripts/dist/task-granularity-advice.js --touches server/shared/tests/resident-legacy-path-ratchet.test.ts --touches server/shared/tests/resident-legacy-path-ratchet.baseline.json --touches scripts/suite-duration-baseline.tsv --touches server/shared/tests/quay-test-script.test.ts --json` → `peers: []`、`mentions: []`（测试/基线类路径不参与重叠判定）⇒ 判定 **none found / separate**。

**现状读数（立案时本人在 HEAD 5329fe9da 上用 TypeScript 5.9.3 的 `ts.createSourceFile` + AST 遍历实测，注释与字符串不计）**：四个读数目前只落在三个文件上——

```
server/modules/providers/list/claude/claude-host-driver.provider.ts     resultTimes=9            .rounds=15
server/modules/websocket/services/chat-run-registry.service.ts          supersedeRunning=2
server/modules/websocket/services/chat-websocket.service.ts             supersedeRunning=1
（supersedeRunning 合计 3、resultTimes 合计 9、resultsSeenAtStart 合计 0、rounds(driver)=15）
```

`server/` 下另有三个 `.js`（`notification-orchestrator.service.js`、`cursor-runtime.provider.js`、`opencode-runtime.provider.js`）不含这些名字，故 AST 口径与三文件口径的读数一致；扩到「全部非测试代码」是为了让**新文件**里再写旧符号也被抓到。泛名风险已实测排除：`resultsSeenAtPush`（S0 的改名产物）不在被计名字内，`resultsSeenAtStart` 全库为 0。

**交付**：`server/shared/tests/resident-legacy-path-ratchet.test.ts`（新判据 + 计数器 + 负对照用例）+ `server/shared/tests/resident-legacy-path-ratchet.baseline.json`（入库基线，四项与立案实测同值，只许下调）。这不是「退役」任务：`supersedeRunning` 的 3 处是 flag 关态的回滚路径（SPEC §12「回滚即关」），基线保持 3、不得为降数删码；真正的退役在 flag 默认开启并浸泡之后由人另立。本条是 S1/S2 的影子期护栏——先立棘轮，之后任何新写旧路径符号的提交都会在第一时间被点名（文件 + 行），而不是等到行为判据以别的形状红。

依据：`docs/proposals/resident-delivery-turn-ledger-SPEC.md` §4.4 I6、§12、§14。

## AC

- [x] (a) `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/resident-legacy-path-ratchet.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。同一次运行用 TypeScript 编译器 API（`ts.createSourceFile`，`ts.ScriptKind` 按扩展名给）统计 `server/` 下全部**非测试**代码（`*.ts` / `*.js` / `*.mjs` / `*.tsx`，排除 `*.test.*`、`*.spec.*`、`node_modules/`、`dist/`）里标识符 `supersedeRunning`、`resultTimes`、`resultsSeenAtStart` 的出现次数（注释与字符串字面量**不计**——AST 里它们不是 `Identifier` 节点，不得退回文本 grep），以及 `claude-host-driver.provider.ts` 里属性访问 `.rounds`（`PropertyAccessExpression` 且 `name.text === 'rounds'`）的次数。先按文件打印明细，再打印一行 `legacy supersedeRunning=<n> resultTimes=<n> resultsSeenAtStart=<n> rounds(driver)=<n>`，打印后才断言。立案实测：`supersedeRunning=3`（registry 2、chat-websocket 1）、`resultTimes=9`（driver）、`resultsSeenAtStart=0`、`rounds(driver)=15`。
- [x] (b) 入库基线 `server/shared/tests/resident-legacy-path-ratchet.baseline.json` 存在且含 `supersedeRunning` / `resultTimes` / `resultsSeenAtStart` / `roundsDriver` 四项与 `measuredAt`（带日期）；测试同时断言 **(b1)** 基线每一项都**不大于**立案初始上限（`supersedeRunning ≤ 3`、`resultTimes ≤ 9`、`resultsSeenAtStart = 0`、`roundsDriver ≤ 15`）——只许下调、不许上调；**(b2)** 实际计数每一项都**不大于**入库基线。执行时先复量：计数**下降**把基线一并下调；**上升**不得上调基线，按 (c) 处理。
- [x] (c) 失败信息必须同时给出两点：新增命中所在的**文件与行号**（`file:line`，逐条列出），以及一句判读——若它是与旧账无关的同名局部变量（`resultTimes` / `rounds` 都是泛名），**改名**而不是上调基线。可用内存夹具自证：喂一份在别处新增一次活使用的源码 ⇒ 失败消息里出现 `server/...:<line>`。
- [x] (d) 退役不是本条的目标，且不得为降数删码：测试**不得**断言 `supersedeRunning` 为 0（基线该项保持 3，只许下调不得下调到删码的地步）；`git diff` 最终只含新判据文件、入库基线、`server/shared/tests/quay-test-script.test.ts` 的计数 pin（及确需时的 `scripts/suite-duration-baseline.tsv` 一行）与任务文件自身，**不含** `claude-host-driver.provider.ts`、`chat-run-registry.service.ts`、`chat-websocket.service.ts` 三个文件里的逻辑改动（唯一例外：确需为同名无关局部变量改名，须在完成记录里逐条说明并保持 AST 计数不增）；三文件里 flag 关态的 `supersedeRunning` 回滚路径仍在——AST 口径下 registry 仍为 2、chat-websocket 仍为 1，任一项变 0 即说明被删。
- [x] (e) 负对照（防空转，测试内建一条用例）：把一份**内存**源码喂给同一个计数函数——该源码里这些名字**只出现在注释与字符串字面量里** ⇒ 四条读数全为 0（`supersedeRunning=0 resultTimes=0 resultsSeenAtStart=0 rounds(driver)=0`），证明计数器不是「出现即计」的文本匹配。
- [x] (f) 取假形态可复现：在任一非测试文件（含新建文件）新增**一次活的使用**（例：`chat-websocket.service.ts` 里加一处 `supersedeRunning` 的真引用）⇒ 判据**红**，且红落在**计数读数的断言**上、写明 `文件:行`，不是超时或别的腿先红；逐字红态读数、退出码与命令行抄进完成记录；用后还原、复跑恢复绿，`git status --porcelain` 只该剩任务文件 ⇒ 最终 `git diff` 不含该临时代码。⚠️ 改前先 `cp` 一份冻结件并打 `sha256sum`（本仓库有「`git checkout --` 丢掉未提交实现」的先例）。
- [x] (g) 该判据文件单次运行墙钟 **< 20s**（AC 明文上限）；照兄弟文件用进程预算守卫（`exit 3`，进程级杀，不是单用例失败）；四条读数在断言之前先采齐。
- [x] (h) collateral：新增一个 `server/**/*.test.ts` ⇒ 先复量 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案时 **355**，以执行时实测为准），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin（立案读数 AC2 的 `known=3 unknown=352`、AC3 的 `known=1 unknown=354`，即各自 `base+1`）各 **+1**，并改写其上方注释里的算术（立案读数注释为 `355 - 3 = 352` / `355 - 1 = 354`）；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 **0**。
- [x] (i) 遵守 `$backend-module-standards`：判据落 `server/shared/tests/`、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 **0**；`npx oxlint server/` 退出 **0**。

## DoD

真实落地判据（不是「测试存在」）：在交付的树上跑 `server/shared/tests/resident-legacy-path-ratchet.test.ts`——它读盘的是 `server/` 下**真实的**那三个文件与全部非测试代码（`fs.readFileSync` + `ts.createSourceFile`），不是夹具副本；打印的四条读数与立案实测一致（`supersedeRunning=3 resultTimes=9 resultsSeenAtStart=0 rounds(driver)=15`，或更小）；入库基线与初始上限同值并入库；负对照用例证明「只在注释/字符串里出现 ⇒ 0」；取假形态（任一非测试文件新增一次活使用 ⇒ 红且写明 `file:line`）可复现、还原后恢复绿 ⇒ 棘轮有牙且不空转。

`git diff` 须只含：新判据文件、入库基线、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（地板未破时不动 `scripts/suite-duration-baseline.tsv`），以及本任务的 task 文件。回滚路径（`supersedeRunning` 的 3 处）逐字未动——本条不退役它。

## Touches

- `server/shared/tests/resident-legacy-path-ratchet.test.ts` （新：AC-393 判据文件——AST 计数器 + 四条读数 + 基线双向断言 + 负对照用例 + 失败消息带 `file:line`）
- `server/shared/tests/resident-legacy-path-ratchet.baseline.json` （新：入库基线，四项与立案实测同值，只许下调）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1 并改写注释算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac393-resident-legacy-path-ratchet.md` （自触）