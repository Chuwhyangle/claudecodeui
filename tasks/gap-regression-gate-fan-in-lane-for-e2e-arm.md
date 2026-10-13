---
id: gap-regression-gate-fan-in-lane-for-e2e-arm
title: 把 Scenario Runner 的浏览器臂接成发布候选阻断门：scripts/test.sh 增一条 e2e lane（或给出不接的书面理由）
status: ready
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

- [x] AC1 裁定已落地并写明理由：要么 `scripts/test.sh` 里存在一条 e2e lane 且被 full-collection 路径调用；要么存在一个可跑命令 + 明确的阻断语义声明位置（取假形态：把该机制去掉 ⇒ AC2 的阻断读数消失）。
- [x] AC2 **阻断是读数**：故意让 Scenario Runner 的浏览器臂失败一次，断言阻断确实发生（门非零退出，或替代机制明确拒绝放行），并把该读数记进 Notes。
- [x] AC3 该臂的时长与资源占用已实测并记录（用于判断进门的代价）。
- [x] AC4 若动到计数钉/基线，`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [x] AC5 未重启线上服务；未在主检出直接提交（改动经任务分支 + fan-in）。

## DoD

Scenario Runner 的回归检查有了**可执行且真的会阻断**的入口：要么进 `scripts/test.sh` 的合并门，要么有一条具备明确失败语义的 RC 前必跑命令；并且「它确实能阻断」是一次实测读数，不是声明。

## Touches

- scripts/test.sh
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-regression-gate-fan-in-lane-for-e2e-arm.md

## Notes

⚠️ 本任务不得以「先接了再说」的方式削弱既有门的时长预算；若实测 e2e 进门的代价过高，选 (B) 是被允许的，但必须给出**可执行**的替代阻断机制。本任务只动门与声明，不改产品行为。

### 裁定：选 (A)，依据是实测代价（2026-10-13）

`scripts/test.sh` 新增一条 e2e lane（`E2E_SPEC=e2e/session-lifecycle-scenario.spec.ts`，默认 `E2E_CMD=${QUAY_TEST_E2E_CMD:-node_modules/.bin/playwright test $E2E_SPEC}`），只在 **full-collection 路径**上跑，在 client 阶段前**后台启动**、client 阶段后收集。

**为什么不是 (B)**：(B) 需要一个「太贵」的理由来支撑替代机制，而实测把那个理由否证了 —— 单次调用墙钟 `0:09.26`、峰值 RSS `306316 kB`（≈299 MiB）、CPU 40%，12 核与 24 核负载下无差别（9.45s / 294 MiB）；Playwright 自己的配置已把它自缚在（`BOOT_CEILING_MS=40s`、`SINGLE_SPEC_CEILING_MS=55s`）之内，严格落在本脚本 watchdog（`SUITE_MAX_RUNTIME_MS=660000`）之内。fan-in 信封（16 GiB scope、实测峰值 12.16 GB、整套 ~153s、laneCount 127）容纳 +300 MiB / +~0s 无压力。

**为什么放在 client 前后台**：它**与 vitest 重叠**，因此几乎不延长门的墙钟；**不更早**是因为 server 阶段用 `jobs -rp` 自量并发，早启动会静默吃掉 16 个文件槽之一，反而拉长该阶段。

**作用域**：仅 full-collection；positional（任务自己的子集）不走它，`order`/`stages` 两个既有 seam 也跳过它 —— 所以既有 seam、钉子、顺序全不变形。失败语义复用 `first_error` + `classify_failure_kind stage`：playwright 正常非零退出＝真缺陷（`assert`），被信号切断＝`infra`。

### AC2 实测读数：故意让浏览器臂红一次

在 worktree 的 spec 末尾临时追加一个必然失败的用例后，跑**门本身**（`.quay/config.yml` 的 `loop.test_command`）：

```
QUAY_TEST_STOP_AFTER=e2e bash scripts/test.sh    # 默认命令＝真 playwright/真 Chromium
GATE_RC=1
__PERFILE__ duration_ms=9242 e2e/session-lifecycle-scenario.spec.ts passed=false end_ms=...
__PERFILE_KIND__ file=e2e/session-lifecycle-scenario.spec.ts kind=assert
not ok - e2e/session-lifecycle-scenario.spec.ts: ...
# tests 1 / # pass 0 / # fail 1
```

即：**门命令非零退出**（该退出码就是 quay 的 `loop.test_command` 读到的那个）。读数完即 `git checkout --` 回滚该探针，spec 未留在改动里（工作树最终只有 `scripts/test.sh` 与 pin 文件两处改动）。

取假形态（「把该机制去掉 ⇒ AC2 的读数消失」）也已机械化：pin 文件里 `e2e-lane false form` 一条用**同一个红命令**走 positional 路径 —— lane 不在作用域内、heavy 阶段关闭 ⇒ `rc=0` 且报告里没有该 spec 的行。删掉 lane 那一块，正是这个形态。

### AC3 读数

| 量 | 读数 |
| --- | --- |
| 墙钟（裸命令，`/usr/bin/time -v`） | `0:09.26`（playwright 自报 `3 passed (8.7s)`） |
| 峰值 RSS | `306316 kB` ≈ 299 MiB |
| CPU | 40% |
| 24 核繁忙时 | 9.45s / 294 MiB（与空载同量级） |
| 稳定性 | 连跑 5 次全绿（含一次 24 核负载） |
| 门内这一条 lane 的行 | `duration_ms=9242`（上面那次红跑，真 Chromium） |

### AC4 读数

`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` → **rc=0**，`tests 14 / pass 14 / fail 0`（原 11 条 + 本任务新增 3 条 e2e-lane 钉子）。

**计数钉与基线未同步改动，且无需改**：`AC2/AC3` 的两条 `known/unknown` 钉、`scripts/suite-duration-baseline.tsv` 的 `^[0-9]+\tserver/\S+\.test\.(ts|js)$` 形状与 90% 覆盖判据，全部只数 **server/** 下的测试文件（本机实测 `known=290 unknown=30`，共 320），e2e lane 不是 server 文件、也不写入基线，所以两者都不受影响。新增的 3 条钉子用的是 `QUAY_TEST_STOP_AFTER=e2e` + `QUAY_TEST_E2E_CMD`（stub 命令），因此**不需要装浏览器**就能钉住这条 lane 的通过/阻断管道 —— 让一个 server 侧 pin 文件依赖 Chromium 没有收益。

### AC5

未重启线上服务（本任务全程只读门脚本、跑隔离 worktree 内的测试）；改动经任务分支 + fan-in，主检出未直接提交（`git log` 上主检出无本任务提交）。
