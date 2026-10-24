---
id: cockpit-decision-counter-voice
title: 裁定队列「反方位」：每条待裁定项附全新上下文生成的反方（忽略了什么 / 最强反例 / 什么会证伪），不阻塞、可缓存、限额
status: todo
labels:
  - cockpit
  - initiative
  - llm
parent: null
children: []
extra: {}
---
## Proposal

决策出处：用户 2026-10-24 确认「反方位」加入裁定队列。依据：人的价值在于更尖锐、更跳跃的判断，而非更全面；系统里的 LLM 天性顺从，联络会话之间也容易互相同意——用人的信念构造的系统会放大这些信念，包括其中的错误。所以在人做裁定时，系统的职责不是附和，而是补上人不负责的那部分广度。`cockpit-initiative-view-and-decision-queue`（M6）已落地，本任务是它的增量。

方案：
1. 裁定队列里每条待裁定项（倡议上报、以及抽查分组中的联络自决条目），在首次被展示时异步生成一份「反方」：由一个**全新上下文**的模型调用产生，输入只有问题、选项、证据引用（URI 与摘要），不带此前的对话；输出 `{ignored: string[]（这个方向忽略了什么）, strongestCounter: string（最强的反例或反对理由）, falsifier: string（什么结果会证伪所倾向的选项）}`。
2. 反方挂在该条目上并缓存（同一条目不重复生成），标注 `kind=llm`、「仅作建议」；**不阻塞**裁定，默认折叠，在卡片上显示「反方」入口。人裁定时可选「已看反方」，该标记随 decide 一起写入决策日志的 rationale。
3. 复用 reply-suggestions 的 LLM 客户端结构与用量账本；在 `config/server.settings.json` 新增 `cockpit.counterVoice` 块：`enabled`、`model`（默认便宜模型）、`maxPerHour`、`apiKeyFile`。超限或失败时卡片显示「反方未生成（原因）」，不影响裁定。
4. 本任务只覆盖裁定队列；驾驶舱里人主动提出新方向时的反方（意图入口）留待意图入口建成后另立。

## AC

- [ ] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/counter-voice.test.ts` exit 0——桩 LLM：首次请求生成并缓存，二次请求不再调用；请求输入只含问题 / 选项 / 证据引用（断言请求体中没有会话 transcript 字段）；超过 maxPerHour 返回「未生成：限额」；调用失败返回原因；每次调用写一条用量记录；输出带 kind=llm。
- [ ] AC2: `npx vitest run src/modules/cockpit/tests/DecisionQueue.test.tsx` exit 0——卡片显示折叠的「反方」入口，展开后渲染三段；反方未生成时显示原因且裁定按钮仍可用；勾选「已看反方」后 decide 调用的 rationale 含该标记。
- [ ] AC3: `npm run typecheck` 通过；文案覆盖 12 个 locale。

## DoD

- 以 `architecture-graph` 倡议的上报「请确认完成判据」为真实数据，截图卡片的反方展开状态（PC 与移动），并人工评价反方三段是否切题（存 `tmp/`）。
- 隔离实例验证必须关闭常驻会话恢复。

## Touches

- server/modules/quay/counter-voice.ts
- server/modules/quay/counter-voice-settings.ts
- server/modules/quay/quay.routes.ts
- server/modules/quay/tests/counter-voice.test.ts
- config/server.settings.example.json
- src/modules/cockpit/DecisionQueue.tsx
- src/modules/cockpit/tests/DecisionQueue.test.tsx
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
- tasks/cockpit-decision-counter-voice.md
