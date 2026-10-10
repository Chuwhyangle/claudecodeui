---
id: gap-memory-cap-slice-named-after-project-not-shared-quay-fleet
title: 内存封顶 slice 按项目命名（默认「项目目录名.slice」），不再默认共用 quay-fleet.slice，代码与文档中不再出现 fleet 字样
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
---
id: gap-memory-cap-slice-named-after-project-not-shared-quay-fleet
title: 内存封顶 slice 按项目命名（默认「项目目录名.slice」），不再默认共用 quay-fleet.slice，代码与文档中不再出现 fleet 字样
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现状（2026-10-10 读数）**：`scripts/start-drivers-scoped.sh:36` 的默认 slice 是字面量 `quay-fleet.slice`，`scripts/with-memory-cap.sh` 的说明与 `docs/operations/process-isolation-and-memory-caps.md`（11 处）、`server/modules/voice/tests/voice-error-classification.false-forms.test.ts` 的注释都沿用该名。该名来自另一个已暂停的项目 `/home/yale/work/quay-fleet`，不是本项目名。实测 `QUAY_MEMORY_SLICE` 只被本仓库这两个脚本读取：quay 插件 0.18.0 的 dist 不读它，cantus、archguard、meta-cc 的 anchor 环境里没有它——所谓「跨项目共用的总闸」实际只有本项目在用。该 slice 的 unit 文件在 `~/.config/systemd/user/` 里、不在仓库，新机器要手工建；其 `memory.peak` 曾到 54.99G（已越过 `MemoryHigh=48G`），但无法区分是哪个项目造成的。另有 systemd 的命名事实：`a-b.slice` 自动成为 `a.slice` 的子单元，所以若新名仍以 `quay-fleet-` 开头会反而嵌进旧的共享 64G。

<!-- dedup-ref -->相关但机制不同：`gap-claude-resident-slice-memory-cap`（done，只管会话 scope 的上限）、`gap-claudecodeui-reuses-quay-resource-gate-for-fleet-admission`（done，管派发准入，不涉及 slice 命名）。本任务只改 slice 的**命名与创建方式**，不改任何数值上限。

**提案**：默认 slice 名由项目根目录名推导：`${QUAY_MEMORY_SLICE:-$(basename "$ROOT_DIR").slice}`（本项目得到 `claudecodeui.slice`；显式设置的 `QUAY_MEMORY_SLICE` 仍逐字优先）。名字里不含 `fleet`，也不含任何会让它嵌进别的共享 slice 的前缀。slice 不存在时由脚本从内置模板创建 `~/.config/systemd/user/<名>.slice` 并 `systemctl --user daemon-reload`，数值默认沿用 `MemoryHigh=48G / MemoryMax=64G / MemorySwapMax=0`（可由 `QUAY_SLICE_MEMORY_HIGH`、`QUAY_SLICE_MEMORY_MAX` 覆盖）——这些数值是沿用不是重新校准，待新 slice 跑几天后按它自己的 `memory.peak` 再定。旧的 `quay-fleet.slice` unit 文件不删除，也不在本任务里动。

## AC

- [x] `node --test scripts/start-drivers-scoped-slice-name.test.mjs` 退出码 0：干跑模式（`START_DRIVERS_SCOPED_DRY_RUN=1`，只打印解析出的 slice 名与将写入的 unit 文本，不调用 systemd）下，根目录名为 `claudecodeui` 与 `cantus` 时分别得到 `claudecodeui.slice` 与 `cantus.slice`；显式 `QUAY_MEMORY_SLICE=custom.slice` 逐字覆盖；解析结果不以 `quay-fleet` 开头
- [x] 记录搜索：`git grep -n -E 'quay-fleet|fleet slice|fleet ceiling|fleet\.slice' -- scripts docs/operations server/modules/voice/tests/voice-error-classification.false-forms.test.ts` 无输出；`docs/operations/process-isolation-and-memory-caps.md` 里原「The fleet ceiling」一节改以项目 slice 命名描述，且含「按项目命名、不跨项目共用」与「`a-b.slice` 会嵌进 `a.slice`」两点
- [x] 真实 cgroup（本机，不重启 driver）：`QUAY_MEMORY_SLICE=claudecodeui.slice bash scripts/with-memory-cap.sh cat /proc/self/cgroup` 的输出路径含 `claudecodeui.slice`，不含 `quay-fleet`；同命令下 `systemctl --user show claudecodeui.slice -p MemoryMax --value` 为 `68719476736`
- [x] 取假形态必须变红：把默认值改回字面量 `quay-fleet.slice` ⇒ 干跑用例红；去掉 slice 不存在时的创建步骤 ⇒ 创建用例红
- [x] 既有守卫不退化：`bash scripts/vitest-heap-limit-check.sh` 退出码 0；`npm run lint` 与 `npm run typecheck` 退出码 0
- [ ] 合入后在 driver 空闲窗口用 `scripts/start-drivers-scoped.sh` 重启，anchor 环境的 `QUAY_MEMORY_SLICE` 为 `claudecodeui.slice`，新起的 `test.sh` scope 出现在该 slice 之下而 `quay-fleet.slice` 不再新增成员（该行只能在合入并重启 driver 之后读到，且重启会中断在飞 worker，须由人 yale 授权后由会话执行）（待外部）

## DoD

真实落地标准：在本机真实 systemd 用户实例上，由脚本自己创建出 `claudecodeui.slice`（不是手工预先建好），并让一个真实的 `with-memory-cap.sh` 测试 scope 落进去，贴出 `/proc/self/cgroup` 与 `systemctl --user show` 的原始读数；`git grep` 的空输出原样贴出，而不是只贴测试通过。未验证项须如实写明：是否重启 driver、旧 `quay-fleet.slice` 是否仍有成员。

## Touches

- scripts/start-drivers-scoped.sh
- scripts/with-memory-cap.sh
- scripts/start-drivers-scoped-slice-name.test.mjs (new)
- docs/operations/process-isolation-and-memory-caps.md
- server/modules/voice/tests/voice-error-classification.false-forms.test.ts
- tasks/gap-memory-cap-slice-named-after-project-not-shared-quay-fleet.md

## 验证记录

- **AC1** `node --test scripts/start-drivers-scoped-slice-name.test.mjs` → exit **0**，`tests 6 / pass 6 / fail 0`。
- **AC2** `git grep -n -E 'quay-fleet|fleet slice|fleet ceiling|fleet\.slice' -- scripts docs/operations server/modules/voice/tests/voice-error-classification.false-forms.test.ts` → **无输出**（rc 1）。文档原「The fleet ceiling」一节已改为 `## The per-project ceiling: <project>.slice`，含「按项目命名、不跨项目共用」与「`a-b.slice` 会嵌进 `a.slice`」两点。
- **AC3** 切片由脚本自身创建（非手工预建）：`QUAY_MEMORY_SLICE=claudecodeui.slice QUAY_ENSURE_SLICE_ONLY=1 bash scripts/start-drivers-scoped.sh` 打印 `created /data/home/yale/.config/systemd/user/claudecodeui.slice`。读数：`QUAY_MEMORY_SLICE=claudecodeui.slice bash scripts/with-memory-cap.sh cat /proc/self/cgroup` → `0::/user.slice/user-1004.slice/user@1004.service/claudecodeui.slice/run-u181640.scope`；`systemctl --user show claudecodeui.slice -p MemoryMax --value` → `68719476736`。
- **AC4** 取假形态实测：(a) 默认值改回字面量 `quay-fleet.slice` ⇒ 干跑命名用例红（`3 fail`，含「dry run derives the slice name from the project directory name」）；(b) 删去 `if [ ! -e "$SLICE_UNIT_FILE" ]` 创建块 ⇒ 创建用例红（`2 fail`，含「the script creates the slice unit itself when it is missing」）。两次变异后均已还原。
- **AC5** `bash scripts/vitest-heap-limit-check.sh` → exit **0**（`PASS — 受限`，整树 RSS 峰值 5106MB ≤ 1.5×6528MB，正对照 exit 0）；`npm run lint` → exit **0**；`npm run typecheck` → exit **0**。
- **AC6** 未勾：须由人 yale 授权后在 driver 空闲窗口重启 driver 才能读到，本次未重启（重启会中断在飞 worker）。
