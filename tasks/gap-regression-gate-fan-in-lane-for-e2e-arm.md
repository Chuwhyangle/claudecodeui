---
id: gap-regression-gate-fan-in-lane-for-e2e-arm
title: 把 Scenario Runner 的浏览器臂接成发布候选阻断门：scripts/test.sh 增一条 e2e lane（或给出不接的书面理由）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-scenario-runner-playwright-executor-same-timeline
---
## Proposal

人 yale 的要求是「**检查回归成为发布候选阻断门，而不是只运行局部单测**」。现状与此直接冲突：

- `scripts/test.sh:2` 自述 lane 清单 = `typecheck + lint + server node:test + client vitest`，**没有任何 e2e lane**；`.quay/config.yml` 的 `loop.test_command` 就是 `bash scripts/test.sh`，所以**它才是合并门**。
- 因此：Scenario Runner 的**纯执行面**（vitest，见 gap-scenario-runner-shared-timeline-pure-slice）因为落在 client 全集里，**天然阻断合并**；而**浏览器执行面**（`gap-scenario-runner-playwright-executor-same-timeline` 的 spec）**一次都不会在门里跑**，它绿不绿与能否合并无关。

本任务消掉这个不对称。两条路必须**选一条并写下理由**，不许含糊：

- **(A) 接**：在 `scripts/test.sh` 的 full-collection 路径上新增一条 e2e lane，跑 Scenario Runner 的 spec（以及既有必须保留的几家），使它对合并门生效。代价：e2e 会显著拉长门的时间、需要浏览器与管理端口/数据目录，且既有计数钉与基线需同步。
- **(B) 不接**：书面论证为什么 e2e 不适合进合并门（时间预算、资源、既有 `fan-in-suite-excludes-playwright-e2e` 的取舍），并**给出替代的、可执行的阻断机制**——例如声明该 spec 属于发布候选清单、由某个显式命令在 RC 前必跑且失败即阻断。**只写"暂不接"不算完成**。

无论选哪条，都必须留下**可执行的读数**证明该决定生效（接了：门里能看到这条 lane 的输出；不接：替代机制有一条可跑的命令与其失败语义）。

## Plan

1. 先量成本：跑一次目标 spec，记时长与资源占用（本机 128 核、内存 8G 会话上限要注意）。
2. 依据读数在 (A)/(B) 间裁定，并把理由写进任务的 Notes 与相关文档。
3. 选 (A)：在 `scripts/test.sh` 增 lane，含超时/并发/失败语义；同步 `server/shared/tests/quay-test-script.test.ts` 的计数钉与 `scripts/suite-duration-baseline.tsv`。
4. 选 (B)：落地替代机制（可跑命令 + 失败即阻断的声明位置），并让该声明可被检查。
5. 两条路都要验证：**故意让该臂红一次**，确认它真的能阻断，而不是只产出日志。

## AC

- [ ] AC1 裁定已落地并写明理由：要么 `scripts/test.sh` 里存在一条 e2e lane 且被 full-collection 路径调用；要么存在一个可跑命令 + 明确的阻断语义声明位置（取假形态：把该机制去掉 ⇒ AC2 的阻断读数消失）。
- [ ] AC2 **阻断是读数**：故意让 Scenario Runner 的浏览器臂失败一次，断言阻断确实发生（门非零退出，或替代机制明确拒绝放行），并把该读数记进 Notes。
- [ ] AC3 该臂的时长与资源占用已实测并记录（用于判断进门的代价）。
- [ ] AC4 若动到计数钉/基线，`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [ ] AC5 未重启线上服务；未在主检出直接提交（改动经任务分支 + fan-in）。

## DoD

Scenario Runner 的回归检查有了**可执行且真的会阻断**的入口：要么进 `scripts/test.sh` 的合并门，要么有一条具备明确失败语义的 RC 前必跑命令；并且「它确实能阻断」是一次实测读数，不是声明。

## Touches

- scripts/test.sh
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-regression-gate-fan-in-lane-for-e2e-arm.md

## Notes

⚠️ 本任务不得以「先接了再说」的方式削弱既有门的时长预算；若实测 e2e 进门的代价过高，选 (B) 是被允许的，但必须给出**可执行**的替代阻断机制。本任务只动门与声明，不改产品行为。