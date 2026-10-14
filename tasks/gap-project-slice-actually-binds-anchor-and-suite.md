---
id: gap-project-slice-actually-binds-anchor-and-suite
title: claudecodeui.slice 有 48G/64G/0 但 MemoryPeak 仅 1.09MB：anchor 与 suite scope
  实测都落在 app.slice 下，项目天花板从未生效 —— 接线到同项目 slice 并核验祖先链与硬限真实生效
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**本轮只读诊断实测（2026-10-14）：** `claudecodeui.slice` 存在，且带着 `MemoryHigh=48G / MemoryMax=64G / MemorySwapMax=0`，但

```
$ systemctl --user show claudecodeui.slice -p MemoryPeak --value
1138688                       # 1.09 MB
```

**1.09 MB 的 peak 说明从来没有东西跑在它下面。** 逐进程核对落点，确认了这一点：

```
anchor(pid 778542) cgroup = …/user@1004.service/app.slice/quay-anchor-claudecodeui-1791964936453.scope
套件 scope ControlGroup   = …/user@1004.service/app.slice/run-u314553.scope
```

两个都不在 `claudecodeui.slice` 下。原因就是本仓文档 `docs/operations/process-isolation-and-memory-caps.md:704-706` 自己写的那条：**`systemd-run --scope` 不嵌套在调用者 cgroup 下**。同一份文档在 `:788-790` 把"真实 driver 跑一轮、确认 workers 继承 `QUAY_MEMORY_SLICE`"列为 **"Still not verified"** —— 本轮诊断给出了**否证**。

**后果：本项目现在没有任何按项目的天花板在真正生效。** 唯一在约束本项目的数值是 **26 GiB 的 anchor envelope**（host-derived，实测 `MemoryPeak=13.29 GiB`，51%）和每次新建的 **16 GiB 套件 scope**。在 slice 真正 bind 之前，**"调大 slice 的 `MemoryMax`"是调一个没人读的数字** —— 这正是本任务要先把接线补上的理由。

**本任务范围：接线 + 核验，不碰数字。**

- ⛔ **不自动修改既有预算**：不改 `claudecodeui.slice` 的 48G/64G/0，也不改 anchor / suite 的任何既有数值。
- ⛔ **不硬依赖 Quay 或其他项目目录**：只用本 repo 的 `scripts/` 与本项目自己的 slice 名，不读别的项目目录、不引用别的项目路径。
- ✅ **build + 安全重启已授权**（本轮由人明确授权），用于验证接线对**真实重启**成立。

<!-- dedup-ref -->
复用关系（`done`，不要重复实现）：`gap-memory-cap-slice-named-after-project-not-shared-quay-fleet` 已把 slice 改成**按项目命名**（`<basename>.slice`，并处理好 dash = 父子边界的陷阱）；`gap-npm-test-server-scripts-bounded-concurrency-and-memory-scope` 与 `gap-claude-session-cgroup-scope` 已建好会话/套件的 scope 封装。本任务补的是它们**留下的那一半**：名字对了、封装有了，但**没有任何东西真的落进这个 slice**。

**接线机制（本分支已实现，见 Evidence）：** 本仓 `scripts/start-drivers-scoped.sh` 在**子进程 PATH 首位**装一个 `systemd-run` shim。插件自己创建的 scope 用的是**不带 `--slice` 的** `systemd-run --user --scope`（本版 dist 的 `SCOPE_PROPERTY_ARGS = ["-p","MemoryAccounting=yes","-p","OOMPolicy=continue"]`，全 dist **一次都没有 `--slice`**，`QUAY_MEMORY_SLICE` 在 dist 里**零消费者**）——裸调用必落 `app.slice`；经 shim 后补上 `--slice=$QUAY_MEMORY_SLICE` 才落目标 slice。仓库内自己的 scope（`scripts/with-memory-cap.sh`）读同一个 env，本来就绑得住。

**2026-10-14 重启实测（本轮，用于划清"哪一半还需要接线"）：**

```
anchor(pid 1376399) cgroup = …/user@1004.service/app.slice/quay-anchor-claudecodeui-1791979448171.scope   # 裸路径 ⇒ app.slice
$ QUAY_MEMORY_SLICE=claudecodeui.slice bash scripts/with-memory-cap.sh bash -c 'cat /proc/self/cgroup'
0::/…/user@1004.service/claudecodeui.slice/quayprobe-cap-1573657.scope                                   # 仓库内路径 ⇒ 已在 slice
$ bash scripts/with-memory-cap.sh bash -c 'cat /proc/self/cgroup'                                        # 对照：不带 env
0::/…/user@1004.service/app.slice/run-u321525.scope
嵌套探针（在 claudecodeui.slice 里再建一个插件形状的 scope）：
outer: 0::/…/claudecodeui.slice/quayprobe-1510987-outer.scope
inner: 0::/…/app.slice/quayprobe-1510987-inner.scope                                                     # 不继承调用者 slice
```

⇒ **仓库内那一半已经绑住了；缺口只在于插件自建 scope（anchor、suite 外层）走的是不带 `--slice` 的裸 `systemd-run`，而 shim 还没上线。** shim 落在本任务的未合入分支上（见 Blocker）。

## AC

- [ ] AC1（接线把 scope 放进**本项目真实 slice**，可在 worktree 内判定）：用**插件原样的调用形状**——`systemd-run --user --scope --quiet --collect --unit=<unit> -p MemoryAccounting=yes -p OOMPolicy=continue`（**不带 `--slice`**）——在**本脚本导出的 PATH**（shim 在首）与 `QUAY_MEMORY_SLICE=claudecodeui.slice` 下执行，`cat /proc/self/cgroup` 的输出必须逐字含 `claudecodeui.slice/<unit>.scope`。判据三条同时成立：(a) 上述经 shim 的调用落 `claudecodeui.slice`；(b) 同一调用**不经 shim**（裸 `systemd-run`）落 `app.slice`——给出对照读数，证明绿来自接线而不是环境；(c) 目标 slice 必须是**真实的 `claudecodeui.slice`**，⛔ 不得拿 `*wireprobe*` / `shimwireprobe.slice` 之类一次性 slice 冒充。三条读数逐字入 Evidence。
- [x] AC2：`systemctl --user show claudecodeui.slice -p MemoryMax -p MemoryHigh -p MemorySwapMax` 三个值在启动后**真实生效**（非空、非 `infinity`），且读回与 unit 文件一致。
- [x] AC3：用**受控的受限探针**证明**父级天花板真的 bind 子 scope**（子 scope 自己的 cap 更大时仍被父级拦住，被拦的证据是子 scope 的 `Result=oom-kill` 或等价读数）。⛔ 不许拿"配置里写了"当证据。
- [ ] AC4（祖先链核验，同一读数，可在 worktree 内判定）：对 AC1 那个落进 slice 的 scope，逐级打印其 `ControlGroup` **与每一级 slice 的单位名**，证明 `claudecodeui.slice` 是它的**直接父级**（而不是兄弟或无关分支）；整条路径逐字入 Evidence。⛔ 不得只打印末级 scope 名。
- [x] AC5：**不自动修改既有预算**：`git diff` 里没有任何一处改写既有 `MemoryMax` / `MemoryHigh` / `MemorySwapMax` **数值**；脚本只做接线与核验。
- [x] AC6：**不硬依赖 Quay / 其他项目目录**：实现只用本 repo 的 `scripts/`；判据：`git diff` 与新增测试里不出现 `quay-scratch`、不出现其他项目的绝对路径。
- [x] AC7：`node --test scripts/start-drivers-scoped-slice-name.test.mjs` 全绿，且新增用例覆盖四档：slice 存在 / slice 缺失 / slice 无 `MemoryMax`（应 fail-closed 拒绝启动）/ slice 名含 dash（会隐式嵌套，必须拒绝或纠正）。

## DoD

真实落地：**接线合入并重启之后**，`claudecodeui.slice` 的 `MemoryPeak` **不再是 ~1 MB 量级**（说明真有东西跑在它下面），并且一次**真实 fan-in 全量套件**的 `ControlGroup` 在 `claudecodeui.slice` 下、`MemoryMax`/`MemorySwapMax` 读回生效。⛔ 只在探针 scope 里成立的接线不算落地 —— 那正是文档 `:788-790` 挂了很久没验的那一条。

**「重启后的运行读数」不进 AC**（它只能在接线合入并重启之后才取得到，合入前不可验证 ⇒ 逻辑上不该当判据；这是本轮重写的依据，操作步骤见 Notes）。AC1/AC4 取的是**同一段接线、同一个真实 slice 名、同一套插件调用参数**在 worktree 内的确定性读数；DoD 保留运行确认。

## Evidence

环境：systemd 255 (255.4-1ubuntu8.15)，user id 1004。诊断与核验全部只读，未改任何既有预算数字。

**AC2 — 既有预算真实生效，且与 unit 文件逐项一致（只读读回）：**

```
$ systemctl --user show claudecodeui.slice -p MemoryHigh -p MemoryMax -p MemorySwapMax
MemoryHigh=51539607552      # 48G
MemoryMax=68719476736       # 64G
MemorySwapMax=0
```

`~/.config/systemd/user/claudecodeui.slice` 写的正是 `MemoryHigh=48G / MemoryMax=64G / MemorySwapMax=0`，读回与之逐项一致；三个值都非空、非 `infinity`。本分支未触碰这三个数字（见 AC5）。

**AC3 — 受控受限探针：父级天花板真的 bind 子 scope。** 用一次性 slice `slicewireprobe<pid>.slice`，不碰 `claudecodeui.slice`：父 slice `MemoryMax=128M`；子 scope **自己的** `MemoryMax=2G`（父的 16 倍），在子 scope 里分配 ~600 MB。

```
子 scope：Result=oom-kill
子 scope：MemoryMax=2147483648        （自己的 2G 从未触及）
子 scope：MemoryPeak=133767168        （127.6 MiB，被钉在父级 128 M 上）
子 systemd-run rc=137 (Killed)
父 slice memory.events：max 35 / oom_kill 1
```

即：子自己的 cap 更大，仍被父级拦住并 OOM-kill。⛔ 这里没有拿"配置里写了"当证据。

**AC5 / AC6 — 判据在本分支的 `git diff` 上跑：**

- AC5：`git diff` 中没有任何一处改写既有 `MemoryMax` / `MemoryHigh` / `MemorySwapMax` 数值；unit 模板与 `48G` / `64G` / `0` 默认原样未动，只新增接线与核验。
- AC6：`git diff` 与新增测试里既没有 `quay-scratch`，也没有别的项目的绝对路径；实现只增改本 repo 的 `scripts/` 与文档。

**AC7 — 用例全绿，覆盖四档：**

```
$ node --test scripts/start-drivers-scoped-slice-name.test.mjs
ℹ tests 12
ℹ pass 12
ℹ fail 0
```

四档：slice 存在（validate-only 报 usable）/ slice 缺失（脚本自建 unit）/ slice 无 `MemoryMax`（stub 分别返回 `infinity` 与空值两例，均 fail-closed、退出非零）/ slice 名含 dash（显式名与派生名两例，均拒绝并不写 unit）。另有 shim 注入与三例 no-op 用例。

**AC1 / AC4 — 上一轮的探针读数（一次性 slice 名，本轮按 AC1(c) 判为不合格、需以真实 `claudecodeui.slice` 重取）：**

```
$ PATH=<shim>:$PATH QUAY_MEMORY_SLICE=shimwireprobe.slice \
    <shim>/systemd-run --user --scope --quiet --unit=shimprobe-<pid> \
      -p MemoryAccounting=yes -p OOMPolicy=continue -- cat /proc/self/cgroup
0::/user.slice/user-1004.slice/user@1004.service/shimwireprobe.slice/shimprobe-<pid>.scope

子 scope ControlGroup=/user.slice/user-1004.slice/user@1004.service/slicewireprobe<pid>.slice/probe-child-<pid>.scope
```

即：插件真实使用的 `systemd-run --user --scope`（无 `--slice`）经 shim 后确实落进目标 slice，且该 slice 出现在倒数第二级（是祖先）。⛔ 这两条用的是**探针 slice 名**，只证明机制成立，不满足 AC1(c)。

## Touches

- scripts/start-drivers-scoped.sh
- scripts/start-drivers-scoped-slice-name.test.mjs
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-project-slice-actually-binds-anchor-and-suite.md

## Notes

### 2026-10-14 重写依据：把「重启后读数」从 AC 里拿掉（按人既裁：合入前不可验证的 AC 是逻辑错的）

上一轮 park 的三条 AC（AC1 全套 / AC4 祖先链 / AC8 重启复读）**要求先重启再取读数**，而重启会杀掉取读数的人所在的 anchor scope —— 执行侧结构性不可满足（上一轮 worker 的 Blocker）。本轮按人裁定重写：

- **AC1** → 改为 worktree 内确定性读数：插件**原样调用形状**（无 `--slice`）+ 本脚本导出的 PATH + **真实** `claudecodeui.slice`，并强制给出**裸 `systemd-run` 的对照读数**（落 `app.slice`）。这比上一轮的探针 slice 读数**更强**（同一个真实 slice 名、同一套参数），且不需重启。
- **AC4** → 同一条读数上的祖先链核验（要求逐级打印，不许只打末级）。
- **AC8（原「重启后复读」）→ 删除**：它只能在接线合入并重启后成立，属 DoD 的运行确认，不是可当判据的 AC。
- DoD **原样保留**「只在探针 scope 里成立的接线不算落地」这条反真空条款 —— 重写没有削弱它，反而把 AC1 的目标 slice 从探针名**收紧**到真实名。

### 操作步骤（接线合入后，由人/operator 执行，对应 DoD）

1. 用接线后的启动路径重启 drivers：停当前 anchor scope，然后
   `QUAY_PLUGIN_DIR=<pinned dist> bash scripts/start-drivers-scoped.sh`（本轮实测该脚本会导出 `QUAY_MEMORY_SLICE=claudecodeui.slice` 与 `QUAY_TEST_SYSTEMD_RUN_LIMITS=MemoryMax=24G`，anchor 的 `/proc/<pid>/environ` 里可读到）。
2. `cat /proc/<anchorPid>/cgroup` 应含 `claudecodeui.slice`（本轮未接 shim 时实测为 `…/app.slice/quay-anchor-claudecodeui-<ts>.scope`）。
3. 下一次**真实套件**的 `.quay/suite-cgroup-evidence.txt` 的 `ControlGroup=` 应含 `claudecodeui.slice`（本轮未接 shim 时的最近一份仍是 `…/app.slice/run-u319629.scope`）。
4. `systemctl --user show claudecodeui.slice -p MemoryPeak --value` 不再是 ~1 MB 量级。

**2026-10-14 本轮重启实测（接线**未**含 shim 的 develop 版；作为「重启前/接线前」基线）**

| 读数 | 值 |
|---|---|
| 新 anchor pid / scope | 1376399 / `quay-anchor-claudecodeui-1791979448171.scope` |
| 该 scope 的 `ControlGroup` | `…/user@1004.service/app.slice/quay-anchor-claudecodeui-1791979448171.scope` ❌ 不在 slice |
| `claudecodeui.slice` `MemoryPeak` | `392908800`（393 MB，仅来自外层 `quay-drivers-…scope` 的瞬时启动；`MemoryCurrent=442368`） |
| 仓库内 `with-memory-cap.sh`（带 `QUAY_MEMORY_SLICE`） | `0::/…/claudecodeui.slice/quayprobe-cap-1573657.scope` ✅ |
| 同一脚本（不带该 env，对照） | `0::/…/app.slice/run-u321525.scope` |
| 嵌套探针（在 slice 里建插件形状 scope） | inner = `…/app.slice/quayprobe-1510987-inner.scope` ⇒ `systemd-run --scope` **不继承调用者 slice** |
| 套件证据（最近一份，10:54Z） | `ControlGroup=…/app.slice/run-u319629.scope`，`MemoryMax=16G` |

⇒ 缺口精确定位在**插件自建 scope 的裸 `systemd-run`**，而 shim 正落在本任务未合入的分支上（见 Blocker）——所以本任务一旦把 AC1/AC4 取到，就该由 driver 机械 fan-in 把它合入。

## Blocker

**2026-10-14T09:42:38.330Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 5/8，剩余未勾 3）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：3d9ef990-7a71-4fc0-ae82-1b299636f5a6

**2026-10-14 重写后处置**：原先不可满足的三条（AC1 / AC4 / AC8）已按人裁定重写/删除（见 Notes 首节），本任务不再 park，退回 todo。实现（`systemd-run` PATH shim + fail-closed 校验 + 12 例测试 + docs）**已在任务分支 `task/gap-project-slice-actually-binds-anchor-and-suite`（worktree HEAD `90604965a`）上完成但尚未合入 develop** —— 续做轮是「核验后退出」，不要重做实现。
