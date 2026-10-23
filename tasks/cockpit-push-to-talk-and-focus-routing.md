---
id: cockpit-push-to-talk-and-focus-routing
title: 驾驶舱 2/2：按住说话 + 焦点路由到项目目标会话（预览后确认发送）
status: todo
labels:
  - cockpit
  - ui
  - voice
parent: null
children: []
extra: {}
depends_on:
  - cockpit-read-only-stage
---
## Proposal

决策出处：用户 2026-10-23 确认的驾驶舱第一步中的「按住说话 + 焦点路由」。前置：`cockpit-read-only-stage`（舞台、焦点、确定性意图）。

方案：
1. **按住说话**：驾驶舱里按住一个键（默认空格，焦点不在文本框时生效；手柄以后接同一个接缝）开始收音，松开结束。复用 chat 模块既有的语音输入（经 `@/modules/chat` barrel 暴露所需 hook，不深导入），**不新建第二条 ASR 管线**。收音时舞台上方显示实时转写；识别热词使用当前可见集的标签与项目名。
2. **两种去向**：
   - 转写命中 `parseCockpitIntent` ⇒ 直接切换视图（可逆，无需确认）。
   - 未命中 ⇒ 视为「对某个项目说的话」：构建 A/B 片的引用式输入包（focus / visible / history / tray + text），**路由目标 = 焦点对象所属项目的目标会话**。
3. **目标会话**：每个项目的目标会话 = 用户为该项目钉选的会话；未钉选时用该项目最近打开的会话（既有 `ui_last_opened_session` 读数）；两者都没有 ⇒ 不发送，提示「该项目没有目标会话」。
4. **发送前预览 + 确认**：底部显示「→ <项目> / <会话标题>：<转写文本>；引用：<焦点标签> → <URI>」，Enter 确认发送，取消键放弃。发送走既有会话发送路径（与 MCP 网关 `session_send` 同一服务），**消息正文里附带引用 URI 列表**，下游可按 URI 解引用（C 片）。不可在未确认时发送。
5. 发送后舞台不跳走；项目条上该项目显示「已发送」直到该会话下一次状态变化。

## AC

- [ ] AC1: `npx vitest run src/modules/cockpit/tests/cockpitRouting.test.ts` exit 0——焦点在 `quay://claudecodeui/task/x` 上、项目已钉选会话 S 时，未命中意图的转写生成的发送预览目标为 S，包内 focus 为该 URI；未钉选时回落到最近打开的会话；两者都无时不产生发送动作；命中意图的转写只切换视图、不产生发送动作。
- [ ] AC2: 同一测试文件——未确认时发送函数调用次数为 0；确认后恰好 1 次，且消息正文包含焦点 URI；取消后为 0。
- [ ] AC3: `npx vitest run src/modules/cockpit/tests/CockpitPushToTalk.test.tsx` exit 0——按住键开始、松开结束（用假语音引擎）；焦点在文本框内时按空格不触发收音；收音期间显示实时转写。
- [ ] AC4: `npm run typecheck` 通过；chat 模块语音既有测试（`src/modules/chat/utils/tests/voiceContextPack.test.ts`）原样通过。

## DoD

- **MCP 浏览器实际操作 + 截图（必做）**：在真实 CloudCLI 的 `/cockpit` 上，用文件音源或注入转写走一遍「聚焦一个在途任务 → 说一句话 → 预览 → 确认」，截图预览条与目标会话里收到的那条消息（截图存 `tmp/`）；用 `browser_evaluate` 读回发送的输入包。
- 用真实麦克风至少走一次（若环境不允许，如实写明并保留文件音源证据）。
- 若场景运行器已落地，补场景 JSON 与报告。

## Touches

- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/cockpitRouting.ts
- src/modules/cockpit/hooks/useCockpitPushToTalk.ts
- src/modules/cockpit/tests/cockpitRouting.test.ts
- src/modules/cockpit/tests/CockpitPushToTalk.test.tsx
- src/modules/chat/index.ts
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/zh-CN/common.json
- tasks/cockpit-push-to-talk-and-focus-routing.md
