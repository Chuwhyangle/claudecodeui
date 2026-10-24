---
id: cockpit-walkthrough-interaction-defects
title: 驾驶舱走查（交互/功能）：board 无可指对象、序号提示错误、无目标死路、遥控器误可确认、后退退出驾驶舱、URL 用 UUID
status: superseded
labels:
  - cockpit
  - ui
  - regression
parent: null
children: []
extra: {}
depends_on:
  - cockpit-entry-mode-switch-and-attention-badge
---
## Proposal

决策出处：2026-10-24 用户要求的驾驶舱现状走查（当前构建 HEAD `aa0a0d44`，同一份 dist 起隔离实例，headless 浏览器 PC 1440×900 与手机 390×844 两套；截图 `tmp/ux/pc-*.png`、`tmp/ux/mob-*.png`）。本任务收**交互与功能**类问题；布局 / 视觉类在 `cockpit-mobile-layout-and-legibility`。

问题（均为实测）：
1. **board 视图几乎没有可指的对象**：quay-fleet 的 board 里「No in-flight tasks declared」，可聚焦元素为 0，焦点为 none；下面的 Recent tasks、Stage goals 行都不可聚焦。最需要你的东西（needs-human 任务）在 board 里既不突出、也指不到。结果在 board 上说「第三个」「这个任务……」都无从解析。
2. **序号指涉的提示错误**：在可聚焦元素为 0 的 board 上说「第三个」，回复「Focus a project or task before saying "第三个"」——序号本应在可见集里选，不需要先聚焦；真实原因是「这个视图里没有可选的对象」。
3. **无焦点时「放大」无任何反馈**（静默无操作）。
4. **没有目标会话时是死路**：未命中意图的话一律回复「"…" has no target conversation to route to.」，界面上没有任何「选一个会话 / 钉选目标会话」的操作；话里点名了项目（「帮我总结一下 archguard 的进展」）也不会改变目标，仍按焦点项目（quay-fleet）找目标。
5. **遥控器在没有目标时「确认」仍可点**：上面那张「没有目标」的卡片出现后，遥控器的 Confirm 是可用的实心主按钮（只有「取消」才有意义）。且这张卡片会一直留着，新打开的遥控器也能看到它。
6. **视图切换用 `navigate(..., { replace: true })`**（`CockpitPage.tsx:446`）：在驾驶舱里切了几次视图后按浏览器后退，直接退出驾驶舱回到 `/`，而不是回到上一个视图。
7. **视图 URL 用 CloudCLI 项目 UUID**（`/cockpit?view=board&project=cc478371-…`），而对象 URI 用 fleet 项目 id（`quay://quay-fleet/board`）；链接不可读、不可分享，与「项目段 = fleet registry id」不一致。

方案：
1. board 视图在「In flight」之外，把 **needs-human 任务**（置顶、强调色）和 **Recent tasks** 行也声明为可聚焦对象（`quay://<project>/task/<id>`，带序号标签与状态色）；goal 行声明为 `quay://<project>/goal/<id>`。
2. 序号 / 标签 / 颜色指涉在可见集里解析，不要求先有焦点；可见集为空时提示「这个视图里没有可选的对象」。
3. 「放大」「返回」等导航在无法执行时给出一行说明（如「没有焦点对象，先用方向键选一个」）。
4. 没有目标会话时的卡片提供操作：列出该项目最近的会话（标题 + 时间），可选一个本次发送；可「钉为目标会话」（写 fleet `registry interface-session set`）。话里点名了已登记项目、且与焦点项目不同时，以点名的项目为目标并在预览里写明「按话里的项目」。
5. 没有目标时遥控器与桌面的「确认」都禁用；这类卡片在下一次输入或 30 秒后自动消失。
6. 视图切换 push 历史（同一视图重复不 push），浏览器后退回到上一个视图；Backspace 行为不变。
7. 视图 URL 的 project 参数改用 fleet 项目 id；旧的 UUID 链接仍能打开（映射后 replace 成新形式）。

## AC

- [ ] AC1: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——board 夹具含 1 个 needs-human、3 个 recent 任务、0 个 in-flight 时，可聚焦元素 ≥ 4 且 needs-human 排第一并带强调标记；goal 行 URI 为 `quay://<project>/goal/<id>`；视图切换后 history 长度加 1，同一视图重复切换不加；视图 URL 的 project 为 fleet id，UUID 链接打开后被替换为 fleet id 形式。
- [ ] AC2: `npx vitest run src/modules/cockpit/tests/cockpitIntent.test.ts` exit 0——无焦点时「第三个」在 5 个可见对象上命中第 3 个；可见集为空时返回「无可选对象」原因（不是「先聚焦」）；「帮我总结一下 archguard 的进展」在焦点为 quay-fleet 时解析出点名项目 archguard。
- [ ] AC3: `npx vitest run src/modules/cockpit/tests/cockpitRouting.test.ts` exit 0——点名项目优先于焦点项目并标注来源；无目标时卡片带该项目最近会话列表（桩）与「钉为目标」动作，钉选调用 fleet 写函数恰好 1 次。
- [ ] AC4: `npx vitest run src/modules/cockpit/tests/CockpitRemote.test.tsx` exit 0——无目标卡片下遥控器确认按钮 disabled；卡片在下一次输入后清除。
- [ ] AC5: `npx tsx --tsconfig server/tsconfig.json --test server/modules/cockpit/tests/cockpit-reducer.test.ts` exit 0——无焦点的 `zoom` 产生可显示的原因而不是静默；无目标的 pendingSend 上 `confirm` 不产生发送；该卡片过期后清除。
- [ ] AC6: `npm run typecheck` 通过。

## DoD

- **浏览器实际操作 + 截图（必做，PC 与手机各一套）**：在一个有 needs-human 任务的项目 board 上用方向键与「第一个」选中它；无目标时从卡片里选一个会话并预览；钉为目标会话后再次发送直接出预览（验证后用 `registry interface-session clear` 清掉钉选）；浏览器后退回到上一个视图。截图存 `tmp/`。
- 隔离实例必须关闭 residentRestore（`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`）。

## Touches

- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/CockpitRemote.tsx
- src/modules/cockpit/cockpitIntent.ts
- src/modules/cockpit/cockpitRouting.ts
- src/modules/cockpit/cockpitView.ts
- src/modules/cockpit/hooks/useCockpitHub.ts
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/modules/cockpit/tests/cockpitIntent.test.ts
- src/modules/cockpit/tests/cockpitRouting.test.ts
- src/modules/cockpit/tests/CockpitRemote.test.tsx
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
- server/modules/cockpit/cockpit.reducer.ts
- server/modules/cockpit/cockpit-hub.service.ts
- server/modules/cockpit/tests/cockpit-reducer.test.ts
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
- tasks/cockpit-walkthrough-interaction-defects.md


2026-10-24 用户确认：由 observation-wall-ui（观察墙 T5）取代；其中在新模型下仍成立的条目已并入该任务。