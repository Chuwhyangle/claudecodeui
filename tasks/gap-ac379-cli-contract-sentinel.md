---
id: gap-ac379-cli-contract-sentinel
title: AC-379 CLI 契约哨兵（S1）：真 claude 二进制 + mock 端点在生产 SDK 路径上钉四个场景（空闲 / later
  排空合并 / next 折叠 / interrupt）的帧顺序与 SPEC §2 一致，并交付
  server/modules/providers/tests/claude-resident-cli-contract.test.ts（含检查器取假自测）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-379
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: AC-379' tasks/*.md` → **0** 命中；全库 `grep -rln 'AC-379' tasks/` → **0** 命中 ⇒ 无 todo/ready/needs-human 任务认领 AC-379。同 SPEC 的兄弟任务 `gap-ac377-cold-head-arm-stamp-and-fixture`（S0 热修）与 `gap-ac378-ledger-invariants-property-test`（S1 账本 + 性质测试）是两条不同的机制、两套独立验收，各自的判据文件互不相同；本条只新增一个判据文件，与之分开，不合并。合并候选检查（`node .claude/plugins/cache/quay/quay/0.19.0/scripts/dist/task-granularity-advice.js --root <主检出> --touches server/modules/providers/tests/claude-resident-cli-contract.test.ts --touches server/shared/tests/quay-test-script.test.ts --touches scripts/suite-duration-baseline.tsv --json`）报 `peers: []` —— 无在飞任务声明这些文件。

### 机制（SPEC §2、§11、§12 S1、§14）

SPEC §2 是从**生产实测**得来的一组 CLI 契约事实，整套账本设计（C-1..C-6）承重其上：命令终态唯一；`started` 到来时 turn 是否已开，决定该命令「折叠进当前 turn」还是「属于随后的那个 `init`」；终态与 `RESULT` 的先后**不固定**（折叠命令的终态在 RESULT 之前，主命令的在之后）；`later` 被排空合并成一个 turn（B、C 共用一个 `init` 与一个 RESULT）；interrupt 只打断在飞命令，turn 以 `is_error` 的 RESULT 结束，排队的命令照常在新 turn 里起终；轮次把手只有 `system/init … RESULT`。SPEC §14 第一条风险即「CLI 契约漂移」：设计现在依赖 §2 的顺序事实，**哨兵是唯一的保护**，升级 `claude` 前先跑它。

本条把附录 A 那一次实测、附录 B 的复现方法**常驻化**：一个**只新增测试文件**的任务，在**生产 SDK 路径**（`createSdkResidentProcess`，经 `handleChatConnection` + `providerRoutes` + `providerRegistry.resolveProvider('claude').hostDriver` 拿到的那同一个 driver）上，用真实 `claude` 二进制 + Anthropic 兼容 mock 端点（无模型费用），在 `ClaudeResidentHostDriver.prototype.observe` 上挂一个**只读**观测点，按到达顺序记 `type` / `subtype` / lifecycle `state` / `command_uuid`，逐场景断言帧顺序。判据文件与 SPEC §15 的矩阵一致：`server/modules/providers/tests/claude-resident-cli-contract.test.ts`；该文件写成时**不存在**，故基线必红（`Could not find …`）。

### 交付要点（设计约束，供执行）

- 顺序检查器必须是对 **trace 数组的纯函数**（形如 `checkContract(scenario, trace) → 'ok' | 'violated'`）：同一个函数既吃真实观测到的 trace，也吃合成的被篡改 trace —— AC (c) 的取假自测就是喂它一份互换过两帧的合成 trace。若检查器只会读「现场状态」而不是读「一串帧」，取假自测无法成立。
- 忙时档位经 `options.priority`（`CLAUDE_TURN_PRIORITY_OPTION = 'priority'`，见 `claude-host-driver.provider.ts:398`）指定；interrupt 经 `chat.abort` 帧。驱动入口是真实 `chat.send` / `chat.abort`（`claude-resident-merged-queued-turn.test.ts` 的真实二进制臂就是这套脚手架：临时 `DATABASE_PATH` / `CLAUDE_CONFIG_DIR`、`startMockAnthropic()`、`createFakeSocket()` + `handleChatConnection`）。
- mock 端点按位置作答：需要保持 turn 在飞的回合回 `bashToolStream(...)`，收尾回 `textStream(...)`；host 侧 `ANTHROPIC_BASE_URL` 指向死端口 + 一个 sentinel key，于是「能到达 mock」即证明模型条目被读到，而真实 key 不外泄。
- 观测点挂在原型上属测试侧（对 `private observe` 做 `unknown` 强制转换），**生产代码零改动**。
- 进程预算守卫（超预算 `exit 3`）与同族判据一致；**所有读数在断言之前取**，让红落在错的那条读数上而非超时。

## AC

- [ ] (a) `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-cli-contract.test.ts` 退出 0，标准输出含 `claudeBinary=<path> claudeVersion=<version>`，`<path>` 非空（空路径即红；不得 skip、不得跑空）。
- [ ] (b) 四个场景各打印一行 `contract.<scenario>=ok`：`idle`（`queued < started < init < RESULT < completed`，且 `started` 在 `init` 之前）；`later-drain`（A 的 RESULT 之后依次 `completed(A)`、`started(B)`、`started(C)`，B 与 C 的 `started` 同一个 `init` 之前，其后一个 `RESULT`，`completed(B)` / `completed(C)` 在其后）；`next-fold`（B 的 `started` 落在 A 的 `init` 之后、`RESULT` 之前，该 turn 内没有第二个 `init`，`completed(B)` 在 `RESULT` 之前、`completed(A)` 在 `RESULT` 之后）；`interrupt`（RESULT 带 `is_error=true`，其后 `cancelled(A)`、`started(B)`、新的 `init`，最终 `completed(B)`）。
- [ ] (c) 检查器取假自测：对**每个**场景构造一份互换过两帧的合成 trace，同一个检查器必须报 `contract.<scenario>=violated`（打印该行即算），证明哨兵能红。合成 trace 与真实读数分开打印，不得混淆。
- [ ] (d) 零外连、无真实 key：mock 端点只监听 `127.0.0.1`，它收到的每一个请求都不携带真实 API key（host 侧 sentinel key 不得出现在任何 mock 请求里）；host 侧 `ANTHROPIC_BASE_URL` 指向死端口，能到达 mock 即证明模型条目被读到。
- [ ] (e) 该判据文件单次运行墙钟 **< 50s**（场景里的 `Bash` sleep 取 2 秒级，不用 4 / 8 / 20 秒）。
- [ ] collateral：新增一个 `server/**/*.test.ts` ⇒ 同步 bump `server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（立案时实际 `known=3 unknown=343` → `344`、`known=1 unknown=345` → `346`），并改写两条 literal 上方那两行注释里的算术（它们现在记的是别的任务的账）。**重跑前先复量**：`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`，以当时 develop 实际的值为 `base + 1`。先量 AC7 覆盖率地板（立案时 339 baseline 行 / 346 采集 = 98.0%），仅当新增后跌破 90% 才向 `scripts/suite-duration-baseline.tsv` 追加一行（否则不动它，免得给 diff 添一个未声明的文件）。
- [ ] 只新增本判据文件；除上述两条计数 pin 外不改任何共享文件（`claude-resident-merged-queued-turn.test.ts` 等只作只读参照，不改），既有 6 个钉住 `roundsOpen` / `busyInputReading` 的测试文件不受影响。
- [ ] 遵守 `$backend-module-standards`：测试落 `server/modules/providers/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「测试存在」）：在交付的树上跑 `server/modules/providers/tests/claude-resident-cli-contract.test.ts`，它真的拉起一个**真实 `claude` 二进制**（`which claude` 解析到路径）并打印 `claudeBinary=<path> claudeVersion=<version>`，把该二进制接到一个只监听回环的 Anthropic 兼容 mock 端点上，经**生产 driver** 的 `observe` 观测点录下四个场景的原始帧顺序，四行 `contract.<scenario>=ok` 全部打印、无一 skip、无一 violated；同一次运行里四个场景的篡改合成 trace 都打印 `violated`（取假自测通过，证明哨兵能红）；真实读数与合成读数分开可见；整份运行墙钟 < 50s。`git diff` 只含这一个新测试文件、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（及两行注释），以及本任务的 task 文件（AC7 地板未破时不动 baseline）。红的是读数本身：任一场景的帧顺序被 CLI 升级改掉，对应那行先变红，据此再改 SPEC §2 与账本。

## Touches

- `server/modules/providers/tests/claude-resident-cli-contract.test.ts` （新：AC-379 判据文件——生产 SDK 路径上真 claude + mock 端点的四场景帧顺序哨兵 + 检查器取假自测）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 时才追加一行；先量，通常不动）
- `tasks/gap-ac379-cli-contract-sentinel.md` （自触）
