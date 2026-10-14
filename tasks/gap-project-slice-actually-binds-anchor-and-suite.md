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

## AC

- [ ] AC1：anchor 与其派生的 suite / 包装器 scope 的 `ControlGroup` 都落在 `claudecodeui.slice` 之下。判据两条同时成立：`cat /proc/<anchorPid>/cgroup` 含 `claudecodeui.slice`；一次**真实套件**的 `.quay/suite-cgroup-evidence.txt` 里 `ControlGroup=` 含 `claudecodeui.slice`（现在是 `…/app.slice/run-uXXXX.scope`）。
- [x] AC2：`systemctl --user show claudecodeui.slice -p MemoryMax -p MemoryHigh -p MemorySwapMax` 三个值在启动后**真实生效**（非空、非 `infinity`），且读回与 unit 文件一致。
- [x] AC3：用**受控的受限探针**证明**父级天花板真的 bind 子 scope**（子 scope 自己的 cap 更大时仍被父级拦住，被拦的证据是子 scope 的 `Result=oom-kill` 或等价读数）。⛔ 不许拿"配置里写了"当证据。
- [ ] AC4：**祖先链核验**：逐级打印 anchor → suite scope 的 cgroup 路径，证明 `claudecodeui.slice` 是它们的**祖先**而不是兄弟或无关分支；把路径逐字入 Evidence。
- [x] AC5：**不自动修改既有预算**：`git diff` 里没有任何一处改写既有 `MemoryMax` / `MemoryHigh` / `MemorySwapMax` **数值**；脚本只做接线与核验。
- [x] AC6：**不硬依赖 Quay / 其他项目目录**：实现只用本 repo 的 `scripts/`；判据：`git diff` 与新增测试里不出现 `quay-scratch`、不出现其他项目的绝对路径。
- [x] AC7：`node --test scripts/start-drivers-scoped-slice-name.test.mjs` 全绿，且新增用例覆盖四档：slice 存在 / slice 缺失 / slice 无 `MemoryMax`（应 fail-closed 拒绝启动）/ slice 名含 dash（会隐式嵌套，必须拒绝或纠正）。
- [ ] AC8：**接线对真实重启成立**：重启 anchor 后重跑 AC1/AC2 的判据仍成立；Evidence 里同时给出重启前与重启后的 `ControlGroup` 与三个预算读数。

## DoD

真实落地：**重启之后**，`claudecodeui.slice` 的 `MemoryPeak` **不再是 ~1 MB 量级**（说明真有东西跑在它下面），并且一次**真实 fan-in 全量套件**的 `ControlGroup` 在 `claudecodeui.slice` 下、`MemoryMax`/`MemorySwapMax` 读回生效。只在探针 scope 里成立的接线不算落地 —— 那正是文档 `:788-790` 挂了很久没验的那一条。

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

**AC4（部分）— 祖先链，在探针 scope 上实测：**

```
子 scope ControlGroup=/user.slice/user-1004.slice/user@1004.service/slicewireprobe<pid>.slice/probe-child-<pid>.scope
```

父 slice 出现在倒数第二级 ⇒ 该 slice 是祖先，而不是兄弟或无关分支。anchor 与真实 suite 的整条链要等重启（见 Blocker）。

**接线 shim 的实测（未带 `--slice` 的插件原样调用，经 shim 后的落点）：**

```
$ PATH=<shim>:$PATH QUAY_MEMORY_SLICE=shimwireprobe.slice \
    <shim>/systemd-run --user --scope --quiet --unit=shimprobe-<pid> \
      -p MemoryAccounting=yes -p OOMPolicy=continue -- cat /proc/self/cgroup
0::/user.slice/user-1004.slice/user@1004.service/shimwireprobe.slice/shimprobe-<pid>.scope
```

即：插件真实使用的 `systemd-run --user --scope`（无 `--slice`）经 shim 后落进目标 slice。

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

**AC1 / AC4 / AC8 / DoD — 待一次重启（见 Blocker）。** 现存 anchor（pid 778542）是本轮接线之前启动的，cgroup 仍是 `…/app.slice/quay-anchor-claudecodeui-1791964936453.scope`，slice 的 `MemoryPeak` 仍停在 ~2 MB。已创建的 scope 不能重挂到别的 slice 上，只有下一次真实启动才会改变这些读数。

## Blocker

**需要一次人操作的 driver 重启，才能验完 AC1 / AC4 / AC8 与 DoD。** 本 worker 的会话本身就是 anchor scope 的子进程：

```
$ cat /proc/self/cgroup
0::/user.slice/user-1004.slice/user@1004.service/app.slice/quay-anchor-claudecodeui-1791964936453.scope
```

重启 anchor 会同时杀掉本会话与 driver，本轮无法执行；而且已经创建出来的 scope 无法重新挂到别的 slice 上，所以"重启后 slice 真的 bind"这一条只能在人重启后读。

**人要做的那一步：** 用 `bash scripts/start-drivers-scoped.sh` 重启本项目的 drivers（它会安装 systemd-run 接线 shim，并把 slice 名与 shim 目录打进 driver 树的环境）。重启后应看到：

- `cat /proc/<anchorPid>/cgroup` 含 `claudecodeui.slice`（AC1 前半、AC4）；
- 一次真实 fan-in 套件的 `.quay/suite-cgroup-evidence.txt` 里 `ControlGroup=` 含 `claudecodeui.slice`（AC1 后半）；
- `systemctl --user show claudecodeui.slice -p MemoryPeak --value` 不再是 ~1 MB 量级（DoD）；
- 三项预算读回与 unit 文件一致（AC2）。

⛔ 不要改既有预算数字（48G/64G/0）—— 本任务只接线与核验。

## Touches

- scripts/start-drivers-scoped.sh
- scripts/start-drivers-scoped-slice-name.test.mjs
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-project-slice-actually-binds-anchor-and-suite.md
