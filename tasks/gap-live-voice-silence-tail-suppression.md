---
id: gap-live-voice-silence-tail-suppression
title: Silence Tail Suppression 产品实现（开关默认关闭）：偏向语音的静音检测、真实底噪 tail、停传与前滚恢复，本地 S-1..S-7
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-silence-tail-suppression-probe
  - gap-live-voice-continuous-experience-e2e-harness
goal_ac: AC-364
---
## Proposal

### 背景

Silence Tail Suppression（STS）定义见 `docs/proposals/live-voice-experience-first-decision-2026-10.md` §10（提交 `18616927`）。本任务是**产品实现**，必须满足三个前提：
- AC-363 探针给出 V-1..V-8 读数，`T` / `P` 推荐值有出处；
- AC-361 的本地确定性 E2E 设施可用（fake upstream 两种时间基、停传与恢复场景）；
- **功能开关默认关闭**；开启需人确认（决策文档 H-S2）。

### 要做的事（默认落点：服务端中继，⚖️ H-S1 若人改判为浏览器侧，派发前改写本任务）

1. **偏向语音的静音检测器**（独立于 `voice-realtime-local-speech.ts` 的看门狗门限）：低阈值、自适应底噪、挂起（hangover）。误判静音率 = 0 是硬要求。
2. **上传状态机**：`streaming → tail(T，上传真实底噪) → suppressed（停传，维持前滚环形缓冲 P）→ streaming（先补发 P 再逐帧）`。不 commit、不 `response.create`、不关 WS；只在 continuous 模式生效（握手回退到 continuous 时同样生效；manual / segmented 下关闭）。
3. **不得误触发**：停传期间 stall 看门狗、`turn_unanswered`、upstream pool 空闲轮换的判断依据必须不被「上游收不到音频」影响（按 AC-363 V-2 读数决定是否需要 keepalive）。
4. **开关与参数**：环境变量开关（默认关闭）；`T`、`P`、阈值默认值在代码注释中引用 AC-363 读数。
5. **journal**：记录每次进入 / 退出 suppressed、上传秒数，供 V-8 / 成本阶段统计（结构化字段，不靠自由文本）。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


<!-- dedup-ref --> 机制去重：现有 `VOICE_REALTIME_SEGMENT_COMMIT=server-vad`（`voice-realtime-bridge.service.ts:243-334, 622-662`）是 segmented 帧格式下的「补发静音」，不是 continuous 的停传门控；open 任务 0 命中。

## Plan

1. 读 AC-363 报告，确定 `T` / `P` / 阈值与 keepalive 需求；2. 实现检测器与上传状态机（开关默认关）；3. 判据：服务端单测（两臂逐事件等价、两种时间基、前滚、长停传虚拟时钟、误判语料）+ e2e spec（复用 AC-361 设施）；4. 新测试文件同步 quay-test-script 钉子与基线；typecheck / lint。

## AC

- [x] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts` 退出 0；「tail 用合成零值代替真实底噪」与「去掉前滚」两个取假形态下 S-2 用例必须红。
- [x] AC2（S-1/S-3）：同文件断言 STS 开与关两臂在 `audio-time` 与 `wall-clock` 两种 fake 时间基下逐事件一致（或按 AC-363 V-1 结论只要求真实时间基那一种，并在注释中引用读数），时刻差 p50 ≤ 100 ms。
- [x] AC3（S-4/S-5）：虚拟时钟停传 ≥ 30 min 后恢复正常，stall / `turn_unanswered` / pool 轮换零误触发；低音量与噪声语料误判静音率 = 0。
- [x] AC4（S-6）：开关关闭时逐帧行为与现状一致（对照断言）。
- [x] AC5：`npx playwright test e2e/voice-realtime-silence-tail-suppression.spec.ts` 退出 0（零外联）。
- [x] AC6（S-7）：`T` / `P` / 阈值默认值注释引用 AC-363 报告；`npm run typecheck`、`npm run lint`、`server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

开关默认关闭地合入；在本地确定性 E2E 与 AC-363 读数支持下，S-1..S-7 成立；**不做生产开启**（开启由人确认后另行操作）。

## Touches

- server/modules/voice-realtime/voice-realtime-silence-tail.ts (new)
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts（接入上传状态机）
- server/modules/voice-realtime/voice-realtime-bridge.service.ts（仅当上传路径需要接缝）
- server/modules/voice-realtime/voice-realtime-log.ts（journal 结构化字段）
- server/modules/voice-realtime/index.ts（barrel 导出 STS 模块）
- server/modules/voice-realtime/voice-realtime-upstream-pool.ts（noteLocalActivity：停传期间保持连接活跃，防被读作空闲轮换）
- server/index.ts（开关与参数装配）
- server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts (new)
- e2e/voice-realtime-silence-tail-suppression.spec.ts (new)
- playwright.config.ts（新 spec 预算登记）
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-silence-tail-suppression.md

## Notes

立项：Opus 常驻会话，2026-10-12，人 yale 提出 STS（GOAL-044 / AC-364）。派发条件：AC-363 与 AC-361 已 done；落点按 H-S1 裁定。

证据（2026-10-13，worktree `/data/home/yale/work/claudecodeui-wt/sts`）：
- AC1：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts` → 13/13，exit 0；两个取假形态（`synthetic-zero-tail` / `no-preroll`，各自对 shipping 源做文本突变）断言 S-2 必须红。
- AC2：同文件 `audio-time` 与 `wall-clock` 两种时间基下 STS 开/关两臂逐事件一致，p50 ≤ 100 ms。
- AC3：虚拟时钟停传 30 min 后恢复；低音量与噪声语料误判静音率 = 0；stall / `turn_unanswered` / pool 轮换零误触发（含非空性对照臂）。
- AC4：开关关闭时 continuous 线上逐帧为恒等中继（含开关打开时不是恒等中继的对照）。
- AC5：`node_modules/.bin/playwright test e2e/voice-realtime-silence-tail-suppression.spec.ts` → `4 passed (14.8s)`，exit 0；egress guard 在线、零拒绝、脚本化 upstream 为替身（零外联）。
- AC6：`npm run typecheck` exit 0；`npm run lint` exit 0（仓库既有 242 条 warning，本次新增文件零命中）；`server/shared/tests/quay-test-script.test.ts` 11/11，exit 0（dispatch 计数钉子已按新文件数 +1）。

再次复核（2026-10-13 本轮，develop 已并入后于合并树重跑）：
- anti-drift 上轮红因 `## Touches` 未声明两个真实实现文件：`server/modules/voice-realtime/index.ts`（barrel 导出 STS 模块）与 `server/modules/voice-realtime/voice-realtime-upstream-pool.ts`（`noteLocalActivity` 使停传期间不被读作空闲而轮换）。二者为承重实现，按「声明而非删除」处理，Touches 已补齐；检查器现报 `ANTI-DRIFT OK — 12 actual file(s), all within declared Touches (13 glob(s))`。
- 合并树重跑：STS 服务端测试 13/13 exit 0；`quay-test-script.test.ts` 11/11 exit 0；`npm run typecheck` exit 0；`npm run lint` exit 0（仅既有 warning）；`playwright test e2e/voice-realtime-silence-tail-suppression.spec.ts` → `4 passed`，exit 0。

## Blocker

**2026-10-12T17:18:42.485Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=anti-drift: ANTI-DRIFT HARD FAIL: task gap-live-voice-silence-tail-suppression — 2 violation(s)
- run_id：wk-prod-anchor
- session_id：2923b781-cbd9-4a3f-80ac-a0d5eb6ca1df
