---
id: observation-blind-spots-declaration
title: 观察墙：盲区声明——每个观察对象带 blindSpots（按类型默认 + 生产者追加），预览末尾显示「看不见什么」与原始材料入口
status: todo
labels:
  - cockpit
  - observation
parent: null
children: []
extra: {}
depends_on:
  - observation-wall-ui
---
## Proposal

决策出处：用户 2026-10-24 确认的「盲区声明」规则（quay `docs/references/注意力投放——把处理能力引导到我们关心的流形上.md` §5.2）。依据：负载分析只统计打字，把「只看不打字的切换」投影成 0，而那正是最大负载——每个投影都会丢维度，必须显式声明它看不见什么，并给出回到原始材料的入口。观察墙的每块磁贴都是投影。

方案：
1. `ObservedObject` 增加必填字段 `blindSpots: string[]`（短句），观察层写入时缺失则按 kind 填入默认声明，生产者可追加。默认声明集中在 `server/modules/observation/blind-spots.ts`：
   - 会话（确定性摘要）：看不见会话是否偏离意图；看不见未进入 transcript 的副作用（外部进程、手工改动）；看不见子 agent 内部过程；「在问你」是启发式判断。
   - 会话（LLM 摘要，tier=llm）：摘要可能编造或遗漏；偏离提示是语义判断，仅作建议。
   - 项目（分层真相）：看不见未登记到 quay-fleet 的项目与不经 quay 的工作；部署层只对 CloudCLI 自身有意义；验证层只反映 gate 的判据，不反映判据本身是否判别。
   - 架构（结构差分）：看不见运行时依赖与动态 import；看不见语义层面的退化；规模增长口径固定为 additionsShare。
   - 观察层自身：生产者心跳只证明生产者在运行，不证明读数正确。
2. `GET /api/observation/wall` 透出 `blindSpots`。
3. 驾驶舱预览在详情末尾显示「这个视图看不见：…」，并紧跟「打开原始材料」入口（会话 → 在会话中打开；项目 → Quay tab；架构 → 架构 tab）；磁贴本身不显示盲区（避免噪声），只在预览中显示。

## AC

- [ ] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/observation/tests/blind-spots.test.ts` exit 0——四种 kind 写入时未提供 blindSpots 则填入对应默认声明且非空；生产者追加的声明与默认合并去重；tier=llm 的会话对象额外带 LLM 声明；wall 响应中每个对象都有非空 blindSpots。
- [ ] AC2: `npx vitest run src/modules/cockpit/tests/ObservationWall.test.tsx` exit 0——预览末尾渲染「看不见」列表与对应的原始材料入口；磁贴本身不渲染盲区。
- [ ] AC3: `npm run typecheck` 通过；文案覆盖 12 个 locale。

## DoD

- **浏览器实际操作 + 截图（PC 与移动）**：三类磁贴各打开一次预览，截图盲区段落与入口（存 `tmp/`）。
- 隔离实例验证必须关闭常驻会话恢复。

## Touches

- server/modules/observation/blind-spots.ts
- server/modules/observation/observation-store.ts
- server/modules/observation/observation.routes.ts
- server/modules/observation/index.ts
- server/modules/observation/tests/blind-spots.test.ts
- src/modules/cockpit/ObservationPreview.tsx
- src/modules/cockpit/tests/ObservationWall.test.tsx
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- tasks/observation-blind-spots-declaration.md
