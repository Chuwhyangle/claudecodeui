---
id: observation-architecture-structural-delta
title: 观察墙 T4：架构磁贴生产者——落地后结构快照与「自上次看过」的结构差分
status: ready
labels:
  - cockpit
  - observation
  - architecture
parent: null
children: []
extra: {}
depends_on:
  - observation-object-model-seen-cursor-and-delta
---
## Proposal

决策出处：2026-10-24 与用户确定的「观察墙」方案（驾驶舱首先是观察面）。依据：14 天负载分析（2159 条人类输入、相邻输入一半落在不同会话、切换中位间隔 2.4 分钟；只看不打字的切换未被记录，真实观察负载更高）；用户确认观察会话输出 / quay 状态 / 架构以及为此做的切换是最大负载。硬约束（quay references）：读数三态（取不到 = 未评估 + 原因，不得显示为绿）、每盏绿灯带活性时间戳、语义判断标注「仅建议」、驾驶舱本身比被治理对象小一个量级。

方案：任务落地（develop 前进）时，限频（同一项目每小时至多一次）复用 architecture 模块的生成器与缓存生成结构快照（包级依赖图 + 环 + 规模），保存快照 id；架构对象的差量 = 当前快照相对「已看到」快照的结构差分：
- 新增/消失的环（SCC），列出成员；
- 新增的跨层或反向依赖边（按项目已有的分层声明；无声明的项目只报新增边）；
- 规模增长最多的前 5 个模块，以及增长是否回流到中心模块（按 additionsShare 口径，注明口径）。
磁贴只显示差量；预览打开现有架构 tab 并高亮差异元素（传入差异集合）。快照生成失败 ⇒ unevaluated + reason。语义层面的「这是不是退化」不在本任务，结构差分只陈述事实。

## AC

- [ ] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/observation/tests/architecture-delta.test.ts` exit 0——两份快照夹具：新增环、消失环、新增反向边、规模增长前 5 各自正确；口径字段存在；同一项目一小时内第二次触发不重新生成。
- [ ] AC2: `npx vitest run src/modules/architecture/tests/architectureDiffHighlight.test.tsx` exit 0——传入差异集合时对应节点/边带高亮标记，未传时渲染不变。
- [ ] AC3: `npm run typecheck` 通过。

## DoD

- 在 claudecodeui 上选两个相隔若干次落地的提交生成差分，贴出结果并人工核对至少一条环/边的真实性。
- **浏览器实际操作 + 截图（必做，PC 1440×900 与移动 390×844 各一套）**，截图存 `tmp/`；场景运行器可用时补场景与报告（AGENTS.md「UI 验证」）。
- 隔离实例验证必须关闭常驻会话恢复（`SERVER_SETTINGS_PATH` 指向含 `{"residentRestore":{"enabled":false}}` 的文件，或使用 T7 的隔离实例脚本），否则会对线上同一批会话重复起进程。

## Touches

- server/modules/observation/architecture-delta.ts
- server/modules/observation/architecture-delta.producer.ts
- server/modules/observation/tests/architecture-delta.test.ts
- server/modules/observation/index.ts
- server/modules/architecture/service.ts
- server/modules/architecture/index.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/tests/architectureDiffHighlight.test.tsx
- tasks/observation-architecture-structural-delta.md
