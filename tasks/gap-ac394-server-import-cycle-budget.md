---
id: gap-ac394-server-import-cycle-budget
title: AC-394 依赖环预算棘轮：交付
  server/shared/tests/server-import-cycle-budget.test.ts（server/ 目录级静态+字面量动态
  import 图 Tarjan SCC 扫描器 + 三组基线 11/2/2 逐成员包含断言 + 新目录只许叶子 + server/shared 对
  modules 零入边 + 夹具与取假形态）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-394
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`task_list search=AC-394` → **0** 命中；`grep -rl '^goal_ac: *AC-394' tasks/*.md` → **0** 命中；`ls tasks/ | grep -i 'import-cycle'` → **0** 命中 ⇒ 无任何状态（含 todo / ready / needs-human）的任务认领 AC-394。同批兄弟 `gap-ac390` … `gap-ac393` 各认领各自 AC，判据文件互不相同，本条与它们无实现交集。合并候选：`node /data/home/yale/.claude/plugins/cache/quay/quay/0.20.0/scripts/dist/task-granularity-advice.js --touches server/shared/tests/server-import-cycle-budget.test.ts --touches scripts/suite-duration-baseline.tsv --touches server/shared/tests/quay-test-script.test.ts --json` → `peers: []`、`mentions: []` ⇒ 判定 **none found / separate**（`scripts/suite-duration-baseline.tsv` 与 `server/shared/tests/quay-test-script.test.ts` 是被 55 / 97 个已落地任务改过的公共钉子文件，不是合并候选）。

**现状（立案时实测，本树 HEAD d90a5b70a）**：判据文件 `server/shared/tests/server-import-cycle-budget.test.ts` **不存在** ⇒ 判据必红（`Could not find '…'`）。约定基线（AC-385 落地后的 HEAD 上复测）为三组非平凡 SCC：11 成员环、2 成员 `{modules/database, modules/database/repositories}`、2 成员 `{server 根目录, modules/browser-use}`。本人在本树用 `find server -type d`（排除 `/tests/`、`node_modules`、`dist`）粗点得 **49** 个目录，其中 `server` 与 `server/modules` 可能不含直接源文件、未必成为节点；扫描器按「文件所在目录」建节点时的实际节点数由判据自己打印 ⇒ (c) 的「46」是立案会话的读数，**以扫描器实测清单为准入库**（实测不同即在完成记录写出差异原因）。`server/shared` 今日对 `server/modules/**` 的 import（含动态）逐条实测为 **0**（`grep -rn '@/modules\|/modules/' server/shared --include=*.ts` 唯一命中是 `server/shared/interfaces.ts:95` 的一句注释，不是 import）⇒ (d) 的叶子基线成立。

**交付**：`server/shared/tests/server-import-cycle-budget.test.ts`（扫描器 + 全部断言 + 合成树夹具 + 真实树取假形态）、`server/shared/tests/server-import-cycle-budget.baseline.json`（(c) 的基线目录清单 + (e) 的未解析预算与点名文件 + (b) 的三组基线，入库、棘轮只减不增）。archguard 不是项目依赖（兄弟仓路径），判据**不**调用它；其 `detect_cycles` 0.1.40 只用于立案时的人工交叉核对。

**为什么要在意**：GOAL-045 的账本重构会在 `server/modules/**` 里新增/搬迁目录；11 成员环是「账本内联在 driver、`RESIDENT_RUN_IS_TURN` 双读」这一类耦合的静态影子。本条把「环只许缩小、新目录只许是叶子、shared 不得回指 modules」变成一条能在任何提交上第一时间红的读数，而不必等行为判据以别的形状红。它与 `gap-ac393` 的符号棘轮互补：那条数旧符号的出现次数，本条数目录图的结构位置。

**执行注意（来自已落地教训，供执行者用，非额外断言）**：判据里的每条夹具与取假形态各自用**独立的 test 块 + 独立的扫描调用**（纯计数器式的合并块会掩盖「分两次投递」式的语义，且无法用 `--test-name-pattern` 定位单腿）；夹具的合成目录树写在 `mkdtempSync` 的临时目录里，**不要**写进仓库；`tsx` 的 `--tsconfig` 用等号形还是空格形按本判据既定命令（`--tsconfig server/tsconfig.json --test <file>`）走，别改成 `-e`。

## AC

- [ ] (a) **判据存在且跑通**（当前必红：文件不存在，文案含 `Could not find`）。`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` 退出 **0**；扫描器**先打印**一行 `files=<n> staticEdges=<n> dynamicEdges=<n> sccs=[<size>…]` 再断言。口径：对 `server/` 下全部非测试 `.ts`/`.tsx`（排除 `/tests/` 与 `*.test.*`）用 TypeScript 取静态 `import` / `export-from`、以及**字面量**说明符的动态 `import()`（AST 取调用；`import type` 同算），解析 `@/` 别名（`@/*` → `server/*`，见 `server/tsconfig.json`）与相对路径（`.js`→`.ts`、目录 `index`），节点 = 文件所在目录，边 = 跨目录 import，Tarjan 求强连通分量。
- [ ] (b) **三组基线的逐成员包含断言**：每个非平凡 SCC（size ≥ 2）的成员集合都必须**包含于**下列某一组，只许缩小，不许新增成员，不许合并两组 ——
      G1(11) `{modules/mcp-gateway, modules/projects, modules/projects/services, modules/providers, modules/providers/list/claude, modules/providers/services, modules/session-hosts, modules/voice, modules/voice-realtime, modules/websocket, modules/websocket/services}`；
      G2(2) `{modules/database, modules/database/repositories}`；
      G3(2) `{server 根目录, modules/browser-use}`。
      同时断言：**静态**与**静态+字面量动态**两种口径得到同一结果（立案读数 `staticEdges=1246`、`static+dynamic=1252`），且与基线 JSON 的三组逐成员相同。贴出读数。
- [ ] (c) **新目录规则 + 基线清单入库**：`server/shared/tests/server-import-cycle-budget.baseline.json` 存在，含扫描器实测的**基线目录清单**与 `measuredAt`（带日期）。断言：任何不在清单里的**新**目录，其 import 目标只许是 `server/shared/**` 与它自身，对其它 `server/modules/**` **零入边零出边**（求值叶子）；清单内目录只许缩小（删目录可以，新增即红，除非该新目录满足叶子规则）。执行时按实测入库；实测节点数与本条「46」不同时以实测为准并在完成记录写出差异原因。
- [ ] (d) **shared 叶子断言（单独一条，不把 shared 当普通目录默认安全）**：`server/shared`（注意不是仓库根 `shared/`）下全部非测试文件对 `server/modules/**` 的 import（含动态）为 **0**；立案实测为 0。夹具：在 `server/shared` 里加一条回指 modules 的 import ⇒ 该断言必须红（给出「加入 ⇒ 红、还原 ⇒ 绿」两次读数）。
- [ ] (e) **非字面量动态说明符预算**：非字面量动态说明符只允许出现在点名的一处 `server/modules/voice-realtime/voice-realtime-uplink-vad.ts`，该文件内计数不得超过 **1**；出现在任何其它文件即红，总数不变也不行。**内部说明符未解析数 ≤ 19**（基线，只减不增；这 19 个落在环外目录或仓库根 `shared/`）。两项都入库进基线 JSON，测试断言实际值 ≤ 基线值。
- [ ] (f) **防空转自检 + 合成树夹具**：已解析的**文件级**边数 ≥ **1000**，且在**真实树**上复现 (b) 的三组 —— 缺一即红。合成小目录树（喂同一扫描器）必须给出：A→B→A 报出 SCC；A→B 无环不报；新目录 import 某 SCC 成员报违规；**环外目录经字面量动态 import 回指环内成员（且环内已有静态边指向它）⇒ 该目录被卷入 SCC，判据必须红**（证明扫描器确实解析了动态 import 而不是空转）。
- [ ] (g) **取假形态（真实树）**：把一个环外目录卷入环（令它与环内成员双向 import）⇒ (b) 红；用后**字节级还原**（`git checkout -- <file>` 或等价手法，完成记录写清）⇒ (b) 绿。给出「卷入 ⇒ 红」「还原 ⇒ 绿」两次读数。
- [ ] (h) **性能**：单文件单次运行 < **30s**（贴 `duration_ms` 或 `time` 读数）。
- [ ] (i) **静态门与钉子**：把本判据文件按 `\<duration_ms\>\t\<path\>` 追加一行到 `scripts/suite-duration-baseline.tsv` 末尾，并同步它头部的覆盖说明；`server/shared/tests/quay-test-script.test.ts` 的两条 `unknown=` pin 各上移一个（立案实测 `known=3 unknown=352` 与 `known=1 unknown=354`，因新增一个 server 测试文件而 +1，按复测实值落）；`npm run typecheck` 退出 **0**；`npm run lint` 退出 **0**。
- [ ] (j) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列，不含第六个文件。

## DoD

真实落地的标准是「扫描器真的在**本仓 `server/` 树**上跑出并守住读数」，不是「文件存在」。必须贴出：①(a) 那行 `files=<n> staticEdges=<n> dynamicEdges=<n> sccs=[…]` 的原样输出；②(b) 的三组逐成员读数，**两种口径各一次**；③(c) 入库清单的节点数与文件路径；④(d)(f)(g) 的**取假形态红读数**与还原后绿读数逐字 —— 这是「真实对象被机制操作过」的证据：扫描器对真实树的一次有意破坏必须红、还原必须绿（夹具/基线本身只是 necessary-not-sufficient）；⑤(e) 的两个计数；⑥(i) 的 typecheck / lint / 两个 pin 读数。若 (b) 出现「某两组被合并」或「新增成员」，**不得改基线迁就** —— 按 (c) 的红处理并归因（是真回归还是 `server/` 新目录引入的耦合）。本条不含任何需要人工或需在其它任务之后才能满足的 AC。

## Touches

- server/shared/tests/server-import-cycle-budget.test.ts (new)（本任务主判据文件）
- server/shared/tests/server-import-cycle-budget.baseline.json (new)（(c) 目录清单 + (e) 预算 + (b) 三组基线的入库）
- scripts/suite-duration-baseline.tsv（新增 server 测试文件的时长行）
- server/shared/tests/quay-test-script.test.ts（两条 `unknown=` pin 上移；baseline 覆盖率地板）
- tasks/gap-ac394-server-import-cycle-budget.md (self)
