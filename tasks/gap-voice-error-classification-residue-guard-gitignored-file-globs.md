---
id: gap-voice-error-classification-residue-guard-gitignored-file-globs
title: AC-152 判据的 no-residue 守卫只读整目录形式的 .gitignore 规则，文件级 `*.log` 面没被排除 ⇒ 线上
  server.log 被并发追写就假红；本轮按 gitignore 语义（含 `!` 反包含）覆盖文件级规则，守卫的牙仍在
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-152
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：立案时 `grep -rln "^goal_ac: *AC-152" tasks/*.md` 命中 7 条，**全部 status=done**（`gap-voice-error-single-classifier-two-paths`、`gap-voice-error-classification-residue-guard-excludes-quay-state`、`gap-voice-error-classification-residue-guard-concurrent-harness-writers`，以及分类/契约/文案/e2e 四条），**没有在飞（todo/ready/needs-human）的第八个认领者**。与两条 done 的 residue 守卫任务是**证据关系，不是重复**：它们分别把 `.quay` 与 `.playwright-mcp`/`tasks`/`goals` 加进排除面，本条处理的是它们**都没有覆盖的那一面** —— `.gitignore` 的**文件级规则**（`*.log`）从未被读进排除面。`done` 的认领者在这里不是「已有修复」，而是「上一轮修复没兜住」的证据，故必须新立一条把判据改回真。合并候选检查（`task-granularity-advice.js --touches src/shared/tests/voiceErrorClassification.test.ts`）返回 `peers: []`、`mentions: []`，无并行任务撞同一个文件。

**这条判据今天为什么是假（直接测量，不是台账尾巴）**

`AC-152` 的 `criterion:` 逐字是 `npx vitest run src/shared/tests/voiceErrorClassification.test.ts`。台账 `.quay/gate-events.jsonl` 里 `AC-152` 最近一轮读数（`2026-10-24T14:16:06.742Z`，verdict=fail）的 `reason` 逐字含：

```
FAIL src/shared/tests/voiceErrorClassification.test.ts > AC1: budget, doors, and no residue
AssertionError: the run left files behind: /server.log:202356066
```

`/server.log` 即仓库根的 `server.log`。立案时实测：

- `stat server.log` ⇒ `size=202390275`，3 秒后 `size=202395097`（**运行中的 server 在持续追写**），硬链接数 12（被多个 worktree 共享）。
- `git check-ignore -v server.log` ⇒ `.gitignore:46:*.log\tserver.log`；`git status --porcelain server.log` ⇒ **空**（git 对它什么都不报）。
- 直接跑判据命令一次（无并发写入命中窗口）可以绿（`git-clean-after=true`，85ms），但这是运气：把同一类写者制造出来就必红。确定性复现：建一个被 `*.log` 忽略的探针 `src/shared/tests/.ac152-residue-probe.log`（`git check-ignore -v` 命中 `.gitignore:46:*.log`），后台每 10ms 追加一字节，再跑判据 ⇒ `git-clean-after=false`，stderr 逐字 `the run left files behind: /src/shared/tests/.ac152-residue-probe.log:135`。探针已删除。

**根因**：`src/shared/tests/voiceErrorClassification.test.ts` 的 `gitignoredTopLevelDirs()`（约 `:411-428`）从 `.gitignore` 派生排除面，但只收「整目录规则」——正则 `^([^/*]+)\/$` 或 `^([^/*]+)\/\*\*?$`。文件级规则如 `*.log` 既不是 `dir/` 也不是 `dir/**`，**永远进不了 skip 集合**；`treeSnapshot()` 的 walk 于是把 `server.log` 当普通文件记入 `path:size`，只要 server 在判据运行的那一两秒内写了一次，尺寸就与 `SNAPSHOT_AT_START` 不同，判据红。这与该文件自己 `:377-409` 的注释矛盾：那里逐字写着读数就是 `git status --porcelain` 的同一事实——而 git **故意不报**被忽略的文件。

**为什么上一轮修复没有兜住（所以这是新立的一条，done ≠ 重复）**

`gap-voice-error-classification-residue-guard-excludes-quay-state` 与 `...-concurrent-harness-writers` 的修法是**往枚举里加名字**（`.quay`，然后 `.playwright-mcp`/`tasks`/`goals`/`quay-runtime-artifacts`）。它们把「谁在写就排除谁」写成了逐类点名，却始终让 `.gitignore` 派生面只覆盖整目录规则；文件级忽略规则（本仓 `:46 *.log`、`:55 *.pid`、`:3-7` 的 npm-debug 系）因此仍是盲区。这是同一处盲区第三次以一个实例的形式发红：先 `.quay/`、再 `.playwright-mcp/`、现在是 `server.log`。只要判据还按「枚举写者」而不是「git 忽略面」取景，下一个文件级写者就会再红一次。

**修法方向（实现者定杠杆，读数由 AC 钉死）**

- 让忽略派生面覆盖**文件级规则**：从同一份 `.gitignore` 读入文件 glob，按 gitignore 语义判定文件是否被忽略——无 `/` 的模式匹配任意深度的 basename（`*.log` 命中 `server.log` 与 `a/b/x.log` 都算）；含 `/` 的模式相对仓库根；支持 `**`、`*`、`?`；**`!` 反包含必须生效**（本仓 `:52 !scripts/__fixtures__/*.log` 把测试夹具日志重新纳入，这些路径在 `git check-ignore` 下退出 1，必须仍算残留）。
- **不得**把文件级 glob 套到目录上（目录仍只由整目录规则跳过），以免把 `src/shared/tests/` 之类真实源码树整棵隐藏。
- ⛔ 不得删掉守卫或拔掉它的牙：不经 git、不落在忽略面的路径必须仍被抓；反包含的夹具日志也必须仍被抓（AC2 两个正对照钉死）。
- 判据按构造不写盘，`AC1` 自守面要求无子进程（`openDoors()` 扫描自身源码）与 30s 预算；修法不得引入子进程（不能用 `git check-ignore`）、不得放宽 doors/预算断言。

**改动面**：出货代码一行不动。被测文件只有 `src/shared/tests/voiceErrorClassification.test.ts` 一个，只动忽略派生/文件匹配那一小块及其紧邻解释注释；21 行夹具、两条取假形态、`subprocess-imports`/`ports`/30s 断言、`SNAPSHOT_AT_START` 的比较维度（尺寸，不回到 mtime）都不动。另一处是本任务自身的记录文件。

**边界（不做）**：不改 `.gitignore`；不改、不删、不截断 `server.log`（只读观察）；不改进程/驱动/浏览器 MCP 的任何文件；不改分类器、码串表或任何出货代码；不把探针留在仓库里（用后即删）；不做真实浏览器（AC-153）。

## AC

- [x] AC1 负对照（并发文件级忽略写者下确定性绿）：修复前先记录基线——建一个被 `*.log` 忽略的探针（根级 `ac152-probe.log` 与 `src/shared/tests/.ac152-residue-probe.log` 各一次），后台每 10ms 追加，跑判据 **≥3 次且 ≥3/3 红**在 `the run left files behind` 且指名该探针（读数记入完成记录）。修复实现后，同一根杠杆分别对根级与子目录探针各连跑 **20 次**：全部退出 0、每次 stdout 含 `git-clean-after=true` 与 `6 passed`。跑完 `kill` 循环、删除探针，`git status --porcelain` 与本任务启动时逐字相同。
- [x] AC2 正对照（守卫的牙与反包含语义仍在）：(a) `git check-ignore -v src/shared/tests/.ac152-residue-probe.tmp` 退出 1（不经 git 忽略），用后台追加/新建两种形态跑判据，**都必须红**并指名该路径；(b) `git check-ignore -v scripts/__fixtures__/.ac152-probe.log` 退出 1（被 `.gitignore:52` 的 `!` 反包含重新纳入），同样制造写入，判据**必须红**并指名该路径——此条钉死「只跳过 git 真正忽略的文件」，不是把所有 `*.log` 一律略过。跑完删除探针，`git status --porcelain` 与启动时逐字相同。
- [x] AC3 实质读数不变（一次干净运行，退出 0）：stdout 逐条含 `rows=21`、`agreed=21`、`openai-family=4`、`classifier-defs=1 table-defs=1 adapter-local-tables=0 client-local-tables=0 client-imports-shared=true`、`mutation=client-second-table` 行的 `mutant-red=true`、`mutation=direct-status-only` 行的 `mutant-red=true`、`subprocess-imports=0`、`ports=0`、`git-clean-after=true`，且 `6 passed`。
- [x] AC4 忽略判定与 git 逐行一致（可复核的路径表）：在 Bash 里对一张不少于 8 行的路径表逐行看 `git check-ignore -q <path>` 的退出码，与判据内忽略判定逐行一致、零分歧；表中至少含 `server.log`（忽略）、`tunnel2.log`（忽略）、`src/shared/tests/x.log`（忽略）、`scripts/__fixtures__/fan-in-suite-lint-failure.log`（反包含⇒不忽略）、`src/shared/tests/.ac152-residue-probe.tmp`（不忽略）、`src/shared/voice/classifier.ts`（不忽略）、`tasks/gap-voice-error-classification-residue-guard-gitignored-file-globs.md`（不忽略）、`README.md`（不忽略）。路径表与分歧数记入完成记录。
- [x] AC5 源码读数（不是只加注释）：`grep -nE "mtimeMs" src/shared/tests/voiceErrorClassification.test.ts` 在残留条目/比较处零命中；`grep -nE "\\*\\*\\.log|basename|globToRegExp|startsWith\\('!'\\)|\\.startsWith\\(\\"!\\"\\)" src/shared/tests/voiceErrorClassification.test.ts` 至少命中一处落在**代码**里（不是只在注释里）；紧邻注释写明文件级规则的来源（`.gitignore`）、反包含语义、以及「不套到目录上」的理由。

## DoD

在**真实的并发写者**在位时（运行中的 server 持续追写 202MB+ 的根级 `server.log`，立案时实测 3 秒内 202390275→202395097 字节；同时可保留 Playwright MCP 与驱动写者）判据**连续 20 次全绿**，并且 `.quay/gate-events.jsonl` 里 `AC-152` 的**下一轮读数翻成 `verdict=pass`**——即这份假红是在真实运行条件下消失的，不是靠运行窗口里恰好没有写入。同时**两条正对照必须红**：不经 git 忽略的探针、以及被 `!scripts/__fixtures__/*.log` 反包含的夹具日志，判据都必须抓住并指名——证明改的是取景（「git 忽略面之外的内容变化」），守卫的牙仍在。判据的实质读数（21 行逐行同码、`classifier-defs=1`、两条取假形态仍红、`subprocess-imports=0`、`6 passed`）逐条不变。探针清理后 `git status --porcelain` 与本任务启动时逐字相同；未新增 `*.test.*` 文件；未改任何出货代码，未改 `.gitignore`。

## Evidence

实现提交：`5be99a0c1 fix(voice): derive file-level .gitignore rules for the residue guard`（worktree `…/gap-voice-error-classification-residue-guard-gitignored-file-globs`，分支 `task/gap-voice-error-classification-residue-guard-gitignored-file-globs`）。唯一改动文件：`src/shared/tests/voiceErrorClassification.test.ts`（+96 行，出货代码零改动，`.gitignore` 零改动）。

**AC1 基线（修复前，10ms 追加探针）**：根级 `ac152-probe.log` 与 `src/shared/tests/.ac152-residue-probe.log` 同时被后台每 10ms 追加，判据连跑 3 次 ⇒ **3/3 红**，每次 `git-clean-after=false`、stderr 逐字指名两条探针：
- run1 `the run left files behind: /ac152-probe.log:104, /src/shared/tests/.ac152-residue-probe.log:106`
- run2 `… /ac152-probe.log:223, /src/shared/tests/.ac152-residue-probe.log:225`
- run3 `… /ac152-probe.log:339, /src/shared/tests/.ac152-residue-probe.log:341`

**AC1 修复后（同一根杠杆，各 20 连跑）**：根级探针 `fails=0 / 20`；子目录探针 `fails=0 / 20`；每轮 rc=0，stdout 均含 `git-clean-after=true` 与 `6 passed`。循环 `kill`、探针删除后 `git status --porcelain` 仅剩本任务的实现改动 `M src/shared/tests/voiceErrorClassification.test.ts`（启动时工作树干净，除该实现文件外逐字相同）。

**DoD 真实写者在位**：在 worktree 根建 `server.log` 符号链接指向线上 `/data/home/yale/work/claudecodeui/server.log`（`statSync` 跟随链接，条目形状与假红时的 `/server.log:<size>` 相同；server 本轮从 `202444549` 追写到 `202446282` 字节），判据连跑 **20 次 ⇒ 20/20 rc=0**，每次 `git-clean-after=true`、`6 passed`。如实说明两点：(i) 以线上一份未修复源码对同一 live `server.log` 重放 8 次在本窗口全绿——server 的 flush 没有落进约 70ms 的 snapshot 窗口，说明这份假红是间歇的；确定性红以 10ms 探针 3/3 与台账 `2026-10-24T14:16:06.742Z` 的 `/server.log:202356066` 为准。(ii) `.quay/gate-events.jsonl` 里 `AC-152` 的下一轮 `verdict` 由 develop 上的 goal gate 在落地后机械写入，worker 会话内无法也不应代写；本任务提供的是它翻绿所依赖的判据读数。

**AC2 正对照（修复后均必须红）**：
- (a) `git check-ignore -q src/shared/tests/.ac152-residue-probe.tmp` ⇒ exit 1（不经 git 忽略）。追加形态：rc=1，逐字 `the run left files behind: /src/shared/tests/.ac152-residue-probe.tmp:108`；新建形态（文件在运行中约 0.9s 由写者创建并持续追加）：rc=1，逐字 `… /src/shared/tests/.ac152-residue-probe.tmp:36`。
- (b) `git check-ignore -q scripts/__fixtures__/.ac152-probe.log` ⇒ exit 1（`.gitignore:52` 的 `!scripts/__fixtures__/*.log` 反包含）。追加形态：rc=1，逐字 `the run left files behind: /scripts/__fixtures__/.ac152-probe.log:113`。⚠️ 读数更正：`git check-ignore -v <path>` 对该路径打印 `.gitignore:52:!scripts/__fixtures__/*.log` 但 **exit 0**——`-v` 的退出码只表示「有规则匹配（含 `!` 规则）」，判「是否被忽略」要看 `-q`（exit 1 = 不忽略），AC 正文里的 `-v … 退出 1` 是命令形态笔误，语义未变。
- 探针清理后 `git status --porcelain` 仍只有实现改动。

**AC3 一次干净运行（rc=0）逐条读数**：
`rows=21 openai-family=4 agreed=21 unknown-code-fallback=UNAUTHORIZED`；`classifier-defs=1 table-defs=1 adapter-local-tables=0 client-local-tables=0 client-imports-shared=true`；`mutation=client-second-table base-green=true mutant-red=true which=403|AccessDenied.Unpurchased outside-family-green=true`；`mutation=direct-status-only base-green=3/2/2 mutant-red=true which=403|AccessDenied.Unpurchased outside-family-green=true`；`reading AC1 scope = elapsed-ms=69 subprocess-imports=0 [] git-clean-after=true offline-transport=injected ports=0 shipped=true`；`Tests 6 passed (6)`。

**AC4 路径表（判据内 `isIgnoredFile` 由测试源码原样抽取 + esbuild 转译后驱动，对照 `git check-ignore -q`）**：`rows=8 divergences=0`
| 路径 | git | 判据内判定 |
| --- | --- | --- |
| `server.log` | ignored | ignored |
| `tunnel2.log` | ignored | ignored |
| `src/shared/tests/x.log` | ignored | ignored |
| `scripts/__fixtures__/fan-in-suite-lint-failure.log` | kept（`!` 反包含） | kept |
| `src/shared/tests/.ac152-residue-probe.tmp` | kept | kept |
| `src/shared/voice/classifier.ts` | kept | kept |
| `tasks/gap-voice-error-classification-residue-guard-gitignored-file-globs.md` | kept | kept |
| `README.md` | kept | kept |

**AC5 源码读数**：`grep -nE "mtimeMs"` ⇒ exit 1（零命中）；`grep -nE "\*\*\.log|basename|globToRegExp|startsWith\('!'\)|\.startsWith\(\"!\"\)"` ⇒ 代码命中 `465: function globToRegExp`、`502: trimmed.startsWith('!')`、`505: rules.push({ pattern: globToRegExp(pattern), … })`、`514: const basename = …`、`519: rule.pattern.test(basename)`（517 行为同主题注释）。紧邻注释写明来源为仓库根 `.gitignore`、`!` 反包含与 last-match-wins 语义、以及文件规则不套到目录上的理由（`*.log` 不得隐藏 `src/shared/tests/`）。

**其它**：`npx tsc --noEmit -p tsconfig.json` ⇒ exit 0。未新增 `*.test.*` 文件，未改出货代码，未改 `.gitignore`。

## Touches

- src/shared/tests/voiceErrorClassification.test.ts
- tasks/gap-voice-error-classification-residue-guard-gitignored-file-globs.md
