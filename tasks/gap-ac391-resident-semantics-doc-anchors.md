---
id: gap-ac391-resident-semantics-doc-anchors
title: AC-391 文档锚点（文档阶段）：id-relations 的 A.2/A.3/B-2/B-7 改写为状态通道版本、新增
  B-8（处理中单写者）/B-9（终态与 RESULT 顺序无关），resident-sessions §8 补 C-4 排空合并 —— 7 条稳定 HTML
  注释锚点 + 锚点定位（非全文 grep）的编号引用；交付
  server/modules/websocket/tests/resident-semantics-doc-anchors.test.ts（(a) 锚点齐全
  + (b) 锚点切片内编号引用 + (c) §15 矩阵 15 个判据文件存在且各被一个 goals/AC-*.md 的 criterion 逐字引用 +
  (d) 取假形态）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac387-pending-deliveries-from-activity-snapshot
  - gap-ac388-activity-dock-honest-status
  - gap-ac389-escape-abort-guard
  - gap-ac390-resident-reconcile-observability
goal_ac: AC-391
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: *AC-391' tasks/*.md` → **0** 命中；`grep -rln 'AC-391' tasks/*.md` → **0** 命中；`grep -rln 'AC-391' goals/` → 只命中 `goals/AC-391-…md`（AC 记录本体，非任务认领）与 `goals/GOAL-045-…md`（goal 正文）⇒ 无任何状态（含 todo / ready / needs-human）的任务认领 AC-391。机制词 grep：`resident-semantics-doc-anchors` / `doc-anchors` / `文档锚点` 在 `tasks/`、`server/`、`src/` 下 **0** 命中；`grep -rn 'anchor:' docs/` → **0** 命中（该形态尚不存在；唯一命中是 `docs/proposals/voice-correction-feedback-loop.md:683` 的 `placePopover(anchor: …)`，函数参数不是 HTML 注释锚点）。GOAL-045 的同批任务（AC-377..AC-390）各有自己的判据文件与实现面，无一认领或触及本条的两份 docs。**合并候选**（`node /data/home/yale/.claude/plugins/cache/quay/quay/0.20.0/scripts/dist/task-granularity-advice.js --root /data/home/yale/work/claudecodeui --touches docs/proposals/id-relations-and-projection-invariants.md --touches docs/proposals/claude-resident-sessions.md --touches server/modules/websocket/tests/resident-semantics-doc-anchors.test.ts --touches server/shared/tests/quay-test-script.test.ts --json`）报 `peers: []`、`mentions: []`，`substantiveInputs` 只含两份 docs ⇒ 判定 **none found / separate**：无任何开放任务声明同批文件。本条是 GOAL-045 的**文档阶段**出口（SPEC §12 末行「文档」行），它不消费运行时实现面（纯文档改写 + 一个只读文档的判据），但它的 (c) 腿要求 SPEC §15 矩阵列出的**全部 15 个判据文件**在仓内存在（含 S0–S5 各条的实现判据）⇒ 它必须在 S0–S5 全部落地后才能绿；该阶段先后在全任务层以结构化 `depends_on` 声明（见 frontmatter），正文不复述这层关系。

### 机制（SPEC §12 文档行、§13.3、§15；AC-391 的 title/expect/origin）

SPEC §12 末行把「文档」单列成一个阶段，出口 AC 即 **AC-391**：「在 S2 / S3 重写 `id-relations` A.2 / A.3 / A.4、B-2、B-7，新增 B-8（处理中单写者）、B-9（终态与 RESULT 顺序无关）；`claude-resident-sessions.md` §8 补 C-4」。§13.3 是同一件事的清单式复述。AC-391 的 title/expect 把它收敛成「**稳定锚点可机械核对**」这一条可判读的形态——不是「文档改了没有」（散文无法机械判），而是「每条要求挂着一条稳定 HTML 注释锚点，且判据只在该锚点之后的那一小节里核对编号引用」。

现状（立案时实测读基线）：

- `docs/proposals/id-relations-and-projection-invariants.md` 的 A.2（`:81`）今天把 `deliveryId` 的载体写成「CLI 铸的 `command_uuid`」，A.3（`:114`）把 `runId` 写成「一次执行的身份」、由**聊天 socket** 在收到用户回合时开 run（含 `supersedeRunning` 顶替，`:124`）——这是 S2 之前的形态；本条按 S2 改写成「`runId` = turn（`init` 铸造）、`runId → 投递` 1:N 与代码一致」。
- B-2（`:198`）与 B-7（`:302`）今天把投递的终态投影写成「`command_lifecycle` 帧必须抵达正在看的 socket」——这是**帧通道**版本；S2 后 delivery 状态走 **activity 协议快照**（SPEC §7），本条改写为状态通道版本。
- B-8 / B-9 尚不存在；`<!-- anchor: … -->` 这种稳定可机检的锚点在两份 docs 里 0 命中。
- `docs/proposals/claude-resident-sessions.md` §8（`:310`）有 E9 实测的「三档都不并入当前轮」，但没有 C-4（`later` 被排空合并成一个 turn）这条与投递终态顺序无关的说明。
- 判据文件 `server/modules/websocket/tests/resident-semantics-doc-anchors.test.ts` 不存在（AC-391 的 `criterion` 命令因此 `Could not find …` 必红）。

由此本条的判据不能落成「整篇正文 grep 某些词」：那会把**解释某条要求为何缺席的散文**也算命中（`absence-ac-grep-counts-the-prose-that-explains-the-absence`），且文档一改写就红。**必须靠锚点定位**：锚点紧跟其后、到下一个 heading / 下一个锚点为止的那一小节就是该要求的正文；判据只在这一小节切片内断言编号引用，不 grep 全文。这正是 AC-391 (b) 的口径（「用锚点定位而不是整篇正文 grep」）。

### 交付（三件，同一任务）

1. **两份 docs 的锚点与改写**（SPEC §12 文档行 / §13.3）。每条要求锚点放在其小节标题之后、正文之前；A.2 / A.3 / B-2 / B-7 是**就地改写**（保留节号），B-8 / B-9 新插入在 B-7 与「## (c) 重构闸门」之间。锚点逐字如下：

| 文档 | 小节 | 锚点（HTML 注释，逐字） | 该小节要求的关键断言编号引用 |
|---|---|---|---|
| `docs/proposals/id-relations-and-projection-invariants.md` | A.2 `deliveryId` | `<!-- anchor: delivery-id -->` | `deliveryId` 的载体即 CLI `command_uuid`（SPEC §4.2 的身份式）；引用 SPEC §4.4 的 **I2** / **I4** |
| 同上 | A.3 `runId` | `<!-- anchor: run-is-turn -->` | `runId` 重述为 turn（`init` 铸造）、`runId → 投递` **1:N**；引用 SPEC §4.4 的 **I2** / **I3** |
| 同上 | B-2 | `<!-- anchor: b2-state-channel -->` | 改写为状态通道版本（delivery 状态走 activity 快照）；引用 SPEC §7 与 §4.4 的 **I2** |
| 同上 | B-7 | `<!-- anchor: b7-state-channel -->` | 同上（投递终态投影 = 快照必须抵达正在看的 socket）；引用 SPEC §7 与 §4.4 的 **I2** |
| 同上 | B-8（新增） | `<!-- anchor: b8-processing-single-writer -->` | 「处理中」单一写者（六读者同源于账本）；引用 SPEC §4.3 与 §4.4 的 **I1** / **I6** |
| 同上 | B-9（新增） | `<!-- anchor: b9-terminal-order-independent -->` | 终态与 `RESULT` 顺序无关；引用 SPEC §5.3「顺序无关」与 §2 的 **C-3** |
| `docs/proposals/claude-resident-sessions.md` | §8 | `<!-- anchor: resident-drain-merge -->` | 补 **C-4**（`later` 被排空合并成一个 turn，终态与该合并 turn 的 `RESULT` 顺序不固定）；引用 SPEC §2 的 **C-4** |

   AC-391 的 expect (b) 只给了两个例子（A.3→I2/I3、B-8→I1/I6），表中其余行的编号是**按 SPEC 各节自带的编号**（§4.4 的 I1–I6、§5.3 顺序无关、§2 的 C-1..C-6）推导的起始提案；执行时须以 SPEC 正文逐条核对，**不得自造编号**，也不得把「编号恰好出现在别处」当成命中（判据 (b) 只认锚点切片内）。

   注：SPEC §12 的「文档」行同时列了「`server/shared/types.ts` 的 `HostInputPriority` 注释补『`later` 被排空合并成一个 turn』」，但 AC-391 的 title / criterion / expect 均**未覆盖**它（(a) 的锚点清单里没有对应锚点、(c) 只认 §15 矩阵的判据文件）⇒ 本条**不纳入**那个 `types.ts` 注释改动，以免在 Touches 里放一个无判据、且可能顶到共享假形态 anchor 的文件（`required-stats-field-widening-reds-sibling-falseform-anchor` 的同源风险）。它留给后续需求；本条的 DoD 不含 `server/shared/types.ts`。

2. **判据文件**（新文件 `server/modules/websocket/tests/resident-semantics-doc-anchors.test.ts`，即 AC-391 的 `criterion`）。骨架照 `server/modules/mcp-gateway/tests/dependency-declaration.test.ts`：只 import node builtins（`node:fs` / `node:path` / `node:url` / `node:test` / `node:assert/strict`），`REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')`，`readFileSync` 读**活文件**（不做文本匹配），四条腿：

   - **(a) 锚点齐全**：读两份 docs，逐条断言上表 7 个锚点逐字出现，且出现在**正确的文档**里（`delivery-id` / `run-is-turn` / `b2-state-channel` / `b7-state-channel` / `b8-processing-single-writer` / `b9-terminal-order-independent` 在 `id-relations-…md`；`resident-drain-merge` 在 `claude-resident-sessions.md`）。打印 `anchorsPresent=<n>` / `anchorsMissing=<n>`（后者须 0）。
   - **(b) 锚点定位的编号引用**：对每个锚点取「锚点位置 → 下一个 `/^#{2,4} /` 标题 或 下一个 `<!-- anchor:` 之前的切片」，只在该切片内断言上表那一行的每个编号引用出现；**不得**对全文 grep（该判据要区分「这条要求的正文写对了」与「别处恰好提过这个词」）。切片为空 / 编号缺失 ⇒ 红；打印 `sectionsChecked=7` / `refsMissing=<n>`（须 0）。
   - **(c) §15 矩阵与 criterion 引用**：读 `docs/proposals/resident-delivery-turn-ledger-SPEC.md`，解析 §15 表（列 `| AC | 阶段 | 判据文件 | 激活 |`）的每一行，取第 3 列反引号里的判据文件路径（应为 15 条：AC-377..AC-391）；对每个路径 (i) 断言 `fs.existsSync(path.join(REPO_ROOT, p))`；(ii) 断言该路径**逐字**出现在至少一个 `goals/AC-*.md` 的 `criterion` 里。**必须解析 YAML frontmatter 的折叠标量**——`criterion:` 在文件里跨行折行（见 `goals/AC-391-…md:8-9`），按行 grep 会 0 命中（`line-wise-grep-ac-breaks-when-the-assertion-wraps`），要先把折叠的空白归一化再比。另断言表行内路径不重复、无多余路径。打印 `matrixFiles=15` / `filesMissing=<n>` / `criterionQuoted=<n>`（后两者须 0/15）。
   - **(d) 取假形态**（执行者手工，不在提交的判据里）：删掉或改名任一锚点 ⇒ (a)（或 (b) 的切片）必红；改回即恢复绿。**只删锚点、不改正文**——用来证明红落在锚点读数上，不落在别处。

   该判据只读 docs 与 `goals/`，不 import `server/` 任何模块；仍按测试目录规范落 `server/modules/websocket/tests/`、无 `any`。跑测试遵守 `AGENTS.md`：单文件直接跑，不做无界多文件 `--test` fan-out。

3. **collateral（登记，不另立任务）**：新增一个 `server/**/*.test.ts` ⇒ 会让 `server/shared/tests/quay-test-script.test.ts` 的两条 server 文件计数 pin **相对下降**。**先复量**：`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案读数 **350**，执行时以实测为准——S2/S3/S4 各条也会新增判据文件），按该测试自身口径把 AC2 的 `known=3 unknown=347` 与 AC3 的 `known=1 unknown=349` 各 +1（即 `351 - 3 = 348`、`351 - 1 = 350`），并改写其上方注释里的算术。`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动）。

## AC

- [ ] (a) 锚点齐全：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/resident-semantics-doc-anchors.test.ts` 退出 0（当前必红：文件不存在，文案含 `Could not find`），标准输出含 `anchorsPresent=7 anchorsMissing=0`；7 个锚点逐字各出现在正确的文档里（`id-relations-…md` 6 条 + `claude-resident-sessions.md` 1 条）。
- [ ] (b) 锚点定位的编号引用：同一次运行内，对每个锚点取「到下一个 heading / 下一个锚点」的切片，切片内逐条断言该要求的关键断言编号出现；打印 `sectionsChecked=7 refsMissing=0`。断言**只读切片**（用锚点定位，不整篇 grep）；切片为空或编号缺失即红。
- [ ] (c) §15 矩阵：同一次运行内解析 SPEC §15 表，得到 15 条判据文件路径（AC-377..AC-391），每条 (i) 在仓内存在、(ii) 逐字出现在某个 `goals/AC-*.md` 的 `criterion` 字段里（**按 YAML 折叠标量解析**，不按行 grep）；打印 `matrixFiles=15 filesMissing=0 criterionQuoted=15`。
- [ ] (d) 取假形态可复现：删掉或改名**任一**锚点后重跑 ⇒ 退出码非 0，且红落在锚点读数（`anchorsMissing>0` 或该锚点的 `refsMissing>0`、文案点名那个锚点），**不是别的腿先红**；改回后重跑恢复 `anchorsMissing=0 refsMissing=0`。逐字红态读数、退出码与命令行抄进完成记录；`git diff` 最终不含该临时删除。
- [ ] (e) 该判据文件单次运行墙钟 **< 30s**（只读三个文件 + 15 个 `fs.accessSync`，无网络/无 DB），每条读数在断言之前先采齐（红要落在错的读数上，不落在超时上）。
- [ ] (f) collateral：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0 —— 按**执行时实测**的 server 测试文件数改写该文件两条计数 pin（AC2 的 `unknown=347`、AC3 的 `unknown=349` 相对 +1）与上方注释的算术；`scripts/suite-duration-baseline.tsv` 未因此追加行（先量，地板未破则不动）。
- [ ] (g) 遵守仓库规范：判据落 `server/modules/websocket/tests/`、只 import node builtins、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「文档里出现了某几个词」、也不是「测试文件存在」）：在交付的树上跑 `server/modules/websocket/tests/resident-semantics-doc-anchors.test.ts`，它读**活的**两份 docs、SPEC 与 `goals/` 记录：

(a) 7 条锚点逐字出现在正确文档里；
(b) 每条锚点之后、到下一个标题/锚点为止的**那一小节**内，含有该条要求的关键断言编号（A.2→I2/I4、A.3→I2/I3、B-2/B-7→§7+状态通道、B-8→I1/I6、B-9→§5.3 顺序无关+C-3、resident-drain-merge→C-4），且断言不跨切片；
(c) SPEC §15 矩阵列出的 15 个判据文件在仓内存在，且每个路径逐字出现在某个 `goals/AC-*.md` 的 `criterion` 里；
(d) 删掉或改名任一锚点后重跑 ⇒ 红且红在锚点读数（`anchorsMissing>0` 或该切片 `refsMissing>0`、文案点名锚点），改回即恢复绿 —— 即红的是那条读数本身，判据有洞会被看见。

`git diff` 须只含：两份 docs（`docs/proposals/id-relations-and-projection-invariants.md`、`docs/proposals/claude-resident-sessions.md`），这一个新判据文件，`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（及注释算术；地板未破时不动 `scripts/suite-duration-baseline.tsv`），以及本任务的 task 文件。**不含** `server/shared/types.ts`（`HostInputPriority` 注释不在本条判据面内，见 Proposal 注）。

## Touches

- `docs/proposals/id-relations-and-projection-invariants.md` （A.2/A.3/B-2/B-7 就地改写为 S2 形态 + 新增 B-8/B-9，各挂稳定 HTML 注释锚点 `delivery-id` / `run-is-turn` / `b2-state-channel` / `b7-state-channel` / `b8-processing-single-writer` / `b9-terminal-order-independent`，锚点后同小节内写编号引用）
- `docs/proposals/claude-resident-sessions.md` （§8 补 C-4 `later` 排空合并，挂锚点 `resident-drain-merge`）
- `server/modules/websocket/tests/resident-semantics-doc-anchors.test.ts` （新：AC-391 判据文件——(a) 锚点齐全 + (b) 锚点切片内编号引用 + (c) §15 矩阵 15 文件存在且被 `goals/AC-*.md` criterion 逐字引用 + (d) 取假形态）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条 server 文件计数 pin 按该测试自身口径各 +1（立案读数 350 ⇒ 351：`unknown=347`⇒348、`unknown=349`⇒350），并改写其上方注释里的算术；先复量再改）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac391-resident-semantics-doc-anchors.md` （自触）
