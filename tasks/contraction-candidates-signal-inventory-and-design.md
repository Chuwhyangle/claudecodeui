---
id: contraction-candidates-signal-inventory-and-design
title: 收缩候选（观察墙之后）：盘点「从不发声的仪器」等退役信号 + 只读扫描原型 + 进入观察墙与裁定落地的设计
status: needs-human
labels:
  - cockpit
  - observation
  - proposal
parent: null
children: []
extra: {}
depends_on:
  - observation-wall-ui
---
## Proposal

决策出处：用户 2026-10-24 同意把「收缩候选」作为观察墙之后的下一个题目。依据（quay references）：《维度边界与结晶》§10.4、harness §7.4/§12——收缩动作 4 次全部人工发起、机制发起 0 次；§11 列出的静默失败实例（18 个闸 0 事件；arch-cycle 26/26 轮 `evaluated:false`；`two-phase-state.json` 代码读者 0；fan-in 里 archguard 闸 244 次 `sccCount` 从未非零；meta-driver 1,738 失败 / 0 通过）；ADR-021「元机制必须比被治理对象小一个量级」而现实是 3.7 倍倒挂。人的职责里「收缩与退役」至今没有任何机制信号支撑。

问题：活性读数（观察层自身的活性、T3 的项目活性）天然能揭示「从不发声的仪器」——这些正是退役候选，但目前没有地方把它们汇成可裁定的对象。

方案（本任务是**调研 + 设计 + 只读原型**，不做任何删除）：
1. 盘点三个仓库（claudecodeui、quay、quay-fleet）里可计算的收缩候选信号，至少覆盖：
   - 零事件 / 恒绿的闸与判据（窗口内从未变红、或 `evaluated:false` 连续 N 轮）；
   - 零读者的状态文件 / 账本（有写入者、无代码读者）；
   - 读数恒定的仪器（窗口内输出不变）；
   - 从未被触发的规则 / 机制（如 meta-driver 人工转向通道「从未被使用」）；
   - 文档与代码比例异常、长期无人引用的文档；
   - 元机制体积（治理代码 vs 被治理代码的行数比）。
   每类给出：数据来源（文件 / 命令）、计算方法、窗口、误报风险、「为什么它可能仍然必要」的反例检查。
2. 写一个只读脚本 `scripts/contraction-candidates/scan.mjs`：对给定仓库根输出 JSON 候选列表 `{kind, target, evidence[], window, confidence, counterCheck}`，不修改任何文件。
3. 设计文档 `docs/proposals/contraction-candidates.md`：候选对象如何进入观察墙（作为方向面的一种磁贴「可能该退役的仪器」，周期性而非实时）、人的裁定动词（退役 / 保留并注明理由 / 改为按需）、裁定如何落成任务（由 quay 立退役任务，不由驾驶舱直接删除），以及与 fleet attention 的关系。

## AC

- [x] AC1: `node scripts/contraction-candidates/scan.mjs --root /data/home/yale/work/quay --json > /tmp/cc-quay.json` exit 0，输出合法 JSON，覆盖方案第 1 条中至少 4 类，每条候选带非空 `evidence` 与 `counterCheck`；对 claudecodeui、quay-fleet 两个根同样 exit 0。
- [x] AC2: `node --test scripts/contraction-candidates/scan.test.mjs` exit 0——夹具仓库中：一个从未变红的闸被识别、一个零读者状态文件被识别、一个有读者的状态文件不被识别（负对照）；脚本运行前后夹具目录 git 状态不变（只读）。
- [x] AC3: `test -f docs/proposals/contraction-candidates.md && grep -c "^## " docs/proposals/contraction-candidates.md` 输出 ≥ 5（信号盘点 / 计算方法 / 误报与反例检查 / 观察墙呈现 / 裁定与落地）。

## DoD

- 贴出三个仓库的真实扫描结果摘要（每类候选数 + 3 条最有把握的候选及证据），并人工核对其中至少 5 条是否属实。
- 设计文档需用户审阅；裁定动词与落地路径以用户意见为准。

## Notes

fleet 侧的数据（每项目 `.quay/gate-events.jsonl`、`~/.quay-fleet/decisions.jsonl`）不要直接读文件：按「CloudCLI 不读 fleet 内部状态文件」的原则，启动本任务时先请 quay-fleet 暴露只读动词（例如基于这两个账本的 `inventory --json`），口径定了再由 fleet 立读口。各项目自己仓库里的文件（如 quay 的闸定义、文档）可以直接扫描。

### 2026-10-24 worker round — AC verified, DoD review still open

AC1–AC3 all pass in the task worktree (readings pasted in the doc §8): three roots exit 0 with
7 / 3 / 3 kinds covered and 0 candidates missing evidence/counterCheck; the fixture test passes
including the negative control and the read-only `git status` comparison; the doc has 9 `## `
headings. Seven real candidates were manually cross-checked (§8 table).

The DoD's second bullet is a **human review gate**: the design doc must be reviewed and the
adjudication verbs / landing path confirmed by the user. That review has not happened, so the
task is parked `needs-human` with all ACs ticked — it must not be flipped done before the
review lands in the doc's `## Adjudication` section or in this task's Notes.

## Touches

- scripts/contraction-candidates/scan.mjs (new)
- scripts/contraction-candidates/scan.test.mjs (new)
- scripts/contraction-candidates/testdata/fixture-repo/README.md (new)
- docs/proposals/contraction-candidates.md (new)
- tasks/contraction-candidates-signal-inventory-and-design.md
