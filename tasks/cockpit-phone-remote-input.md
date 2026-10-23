---
id: cockpit-phone-remote-input
title: 驾驶舱手机遥控器：/cockpit/remote 按住说话 + 打字 + 方向键 + 手机上确认，输出在桌面
status: ready
labels:
  - cockpit
  - ui
  - voice
  - mobile
parent: null
children: []
extra: {}
depends_on:
  - cockpit-hub-cross-device-state
---
## Proposal

决策出处：用户 2026-10-23 确认的跨端第一种输入形态——**手机作遥控器**：手机始终在手上，是天然「始终有焦点」的输入设备；输出仍在桌面浏览器。前置：`cockpit-hub-cross-device-state`（中枢、语义事件、显示端上报可见集、中枢内待确认发送）。

方案：只做输入与确认，不做第二块舞台。
1. **新路由 `/cockpit/remote`**（手机布局），以 `input` 角色连接中枢。同一登录用户即自动绑定该用户的中枢；桌面 `/cockpit` 显示一个二维码，内容是 remote 的 URL（登录沿用现有认证，不新增令牌机制）。
2. **控件**：
   - 大的按住说话按钮：复用 chat 模块的 `useVoiceInput`（经 `@/modules/chat` barrel），口述文字进入遥控器上的输入框，可以先改再提交；也可以直接打字（复用 `PromptInput` 系列）。识别热词取中枢下发的可见集标签。
   - 回显：当前焦点对象的标签、待确认发送的「→ 项目 / 会话：文本；引用」。
   - **确认 / 取消**两个大按钮：确认放在发起输入的设备上，这是不可逆操作的离散通道。
   - 触摸方向键 + 放大 / 返回 + 钉托盘：发 `move`/`zoom`/`back`/`pin` 事件。
3. **保持可用**：收音期间申请 Screen Wake Lock，失败时如实提示「锁屏会中断收音」。
4. **安全上下文**：手机浏览器只在 HTTPS（或 localhost）下允许麦克风。遥控器页面检测 `window.isSecureContext`，不满足时禁用说话按钮并说明原因，打字和方向键照常可用。

## AC

- [ ] AC1: `npx vitest run src/modules/cockpit/tests/CockpitRemote.test.tsx` exit 0——方向键、放大、返回、钉托盘各发出对应语义事件（假中枢连接计数）；输入框提交发 `utterance`；有 `pendingSend` 时显示预览与确认 / 取消，点确认发 `confirm` 恰好一次；无 `pendingSend` 时确认按钮不可用；非安全上下文时说话按钮禁用且显示原因，打字仍可提交。
- [ ] AC2: 同一测试文件——遥控器使用 `@/modules/chat` 导出的 `useVoiceInput`（假语音引擎）；口述文字进入输入框而非直接发送；`candidates` 来自中枢 state 的可见集标签。
- [ ] AC3: `npx playwright test e2e/cockpit-remote.spec.ts` exit 0（在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）——同一用户两个页面：桌面视口 `/cockpit` + 手机视口 `/cockpit/remote`；在 remote 点方向键与提交「看 <项目>」后，桌面页焦点与视图随之变化；控制臂：remote 以另一用户登录时桌面页不变。
- [ ] AC4: `npm run typecheck` 通过；文案覆盖 12 个 locale 并扩展驾驶舱文案完整性测试。

## DoD

- **MCP 浏览器实际操作 + 截图（必做）**：手机视口的 remote 与桌面视口的 `/cockpit` 并排操作一遍「移动焦点 → 说 / 打一句话 → 预览 → 在手机上确认」，截图两端（存 `tmp/`）。
- 用真实手机至少走一次（HTTPS 访问）；若环境不具备，如实写明并保留模拟证据。
- 场景运行器可用时补场景与报告。

## Touches

- src/App.tsx
- src/modules/cockpit/index.ts
- src/modules/cockpit/CockpitRemote.tsx
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/hooks/useCockpitHub.ts
- src/modules/cockpit/tests/CockpitRemote.test.tsx
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
- src/modules/chat/index.ts
- e2e/cockpit-remote.spec.ts
- playwright.config.ts
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
- tasks/cockpit-phone-remote-input.md
