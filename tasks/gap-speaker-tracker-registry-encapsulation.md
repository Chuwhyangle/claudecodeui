---
id: gap-speaker-tracker-registry-encapsulation
title: SpeakerTrackerRegistry 封装：组合根 server/index.ts 的 speakerTrackerModels Map
  收进 voice-realtime speaker 模块
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-23）**：第三批「缓存封装」机制；granularity 报 peer `gap-voice-config-file-contextpack-spendguard`（ready，共享 server/index.ts）——机制不同（它改 voice 配置装配，本条搬 speaker 状态），调度器串行，判定 **separate**。

### 现状

`server/index.ts`（组合根）里有一个模块级 `const speakerTrackerModels = new Map()` 且运行时 `.set()`——**组合根持有语音说话人追踪的运行时状态**。这是「状态在错误的地方」：装配文件不该持有可变状态，它该归 voice-realtime 的 speaker 模块。

### 改法

把 `speakerTrackerModels` 收进 voice-realtime 的 speaker 模块（`SpeakerTrackerRegistry` 类或并入既有 speaker-bank/selector），组合根只装配、不持状态。**行为保持**：说话人模型注册/查找语义不变。

## Plan

1. 盘点 `speakerTrackerModels` 的读写点与归属（读 `voice-speaker-*.ts`）。
2. 定义 `SpeakerTrackerRegistry`（私有 Map 字段 + 注册/查找），迁入 voice-realtime。
3. 组合根改为装配该 registry，删除模块级 Map。
4. 判据 + 收口。

## AC

- [ ] (a) **组合根不再持状态**：`grep -nE "^const speakerTrackerModels = new Map" server/index.ts` 计数 = **0**。
- [ ] (b) **状态进 speaker 模块**：`grep -nE "class SpeakerTrackerRegistry|speakerTrackerModels" server/modules/voice-realtime/*.ts` 命中（状态归 voice-realtime）。
- [ ] (c) **既有行为不改一字仍绿**：覆盖 speaker-tracking 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [ ] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「`speakerTrackerModels` 从组合根搬进了 voice-realtime 的 speaker 模块、有属主」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/实例行；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（模型注册/查找语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/index.ts`（删除组合根里的 speakerTrackerModels Map，改为装配 registry）
- `server/modules/voice-realtime/voice-speaker-bank.ts`（或等价 speaker 文件：SpeakerTrackerRegistry 私有字段）
- `tasks/gap-speaker-tracker-registry-encapsulation.md`（自触）
