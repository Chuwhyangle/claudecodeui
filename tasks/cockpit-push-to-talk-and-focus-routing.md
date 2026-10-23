---
id: cockpit-push-to-talk-and-focus-routing
title: 驾驶舱 2/2：按住说话 + 焦点路由到项目目标会话（预览后确认发送）
status: ready
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
1. **语音复用现有口述机制，与文本合流**：驾驶舱输入框接上 chat 模块现有的 `useVoiceInput` 与 `VoiceInputButton`（经 `@/modules/chat` barrel 导出），行为与聊天里一致——口述的文字进入同一个输入框，可以先改再提交；不新建第二条 ASR 管线，也不另做一套语音专用输入。`candidates`（识别热词）取当前可见集的标签与项目名。**按住说话**只是同一个 hook 的另一个触发方式：焦点不在输入框时按住空格开始、松开结束（手柄以后接同一个接缝）。驾驶舱专属的输入特点（持续收音、无文本框的直接执行等）不在本任务，以后另议。
2. **两种去向（文本和语音走同一提交路径）**：
   - 提交的文本命中 `parseCockpitIntent` ⇒ 直接切换视图（可逆，无需确认）。
   - 未命中 ⇒（无论是打字还是口述） 视为「对某个项目说的话」：构建 A/B 片的引用式输入包（focus / visible / history / tray + text），**路由目标 = 焦点对象所属项目的目标会话**。
3. **目标会话（用户 2026-10-23 拍板：以 fleet 登记表为权威来源）**：每个项目的目标会话 = fleet registry 的按项目字段 `projects[].interfaceSessionId`（含义：该项目对人的会话；fleet 据此拒绝往该会话委派 dev 工作）。由 quay-fleet 侧任务新增该字段及其读写命令（CLI 形状以 fleet 落地为准，调用集中在 `cockpitRouting.ts` 的一个读取函数和一个写入函数里）。
   - 驾驶舱里「钉选为目标会话」的操作**写回 fleet**，不在 CloudCLI 本地另存。
   - fleet 字段为空或读口不可用 ⇒ 回落到该项目最近打开的会话（既有 `ui_last_opened_session` 读数），预览条上标明「未钉选，使用最近打开」；fleet 读口不可用时钉选操作禁用并说明原因。
   - 以上都没有 ⇒ 不发送，提示「该项目没有目标会话」。
4. **发送前预览 + 确认**：底部显示「→ <项目> / <会话标题>：<转写文本>；引用：<焦点标签> → <URI>」，Enter 确认发送，取消键放弃。发送走既有会话发送路径（与 MCP 网关 `session_send` 同一服务），**消息正文里附带引用 URI 列表**，下游可按 URI 解引用（C 片）。不可在未确认时发送。
5. 发送后舞台不跳走；项目条上该项目显示「已发送」直到该会话下一次状态变化。

## AC

- [ ] AC1: `npx vitest run src/modules/cockpit/tests/cockpitRouting.test.ts` exit 0——焦点在 `quay://claudecodeui/task/x` 上、fleet 字段给出会话 S 时（桩读口），未命中意图的转写生成的发送预览目标为 S，包内 focus 为该 URI；字段为空、以及读口不可用时都回落到最近打开的会话且预览标明来源；钉选操作调用的是 fleet 写入函数（桩计数 1），本地无持久化写入；两者都无时不产生发送动作；命中意图的转写只切换视图、不产生发送动作。
- [ ] AC2: 同一测试文件——未确认时发送函数调用次数为 0；确认后恰好 1 次，且消息正文包含焦点 URI；取消后为 0。
- [ ] AC3: `npx vitest run src/modules/cockpit/tests/CockpitPushToTalk.test.tsx` exit 0——驾驶舱使用的是 `@/modules/chat` 导出的 `useVoiceInput`（假语音引擎注入）；口述文字进入输入框而非直接发送；按住空格开始、松开结束；焦点在输入框内时按空格只输入空格；打字提交与口述提交得到相同的意图 / 路由结果。
- [ ] AC4: `npm run typecheck` 通过；chat 模块语音既有测试（`src/modules/chat/utils/tests/voiceContextPack.test.ts`）原样通过。

## DoD

- **MCP 浏览器实际操作 + 截图（必做）**：在真实 CloudCLI 的 `/cockpit` 上，用文件音源或注入转写走一遍「聚焦一个在途任务 → 说一句话 → 预览 → 确认」，截图预览条与目标会话里收到的那条消息（截图存 `tmp/`）；用 `browser_evaluate` 读回发送的输入包。
- 用真实麦克风至少走一次（若环境不允许，如实写明并保留文件音源证据）。
- 若场景运行器已落地，补场景 JSON 与报告。

## Notes

文案键按仓库惯例覆盖全部 12 个 locale，并照 `src/modules/project-workspace/tests/i18nQuayTabCompleteness.test.ts` 的样式加驾驶舱文案完整性测试（只在 1/2 任务里加一次，2/2 任务扩展同一测试）。


### fleet 接口会话 CLI 形状（fleet 任务 `fleet-registry-per-project-interface-session` 定稿，2026-10-23）

- 读：`quay-fleet registry interface-session get <project> --json` ⇒ `{ok:true, project, interfaceSessionId}`；未钉选时 `interfaceSessionId:null`；未知项目 ⇒ `{ok:false, reason:"unknown-project"}`，exit 2。
- 写：`registry interface-session set <project> <id> --json`（幂等）；`registry interface-session clear <project> --json`（幂等）。`set` 一个已在该项目 devSessionIds 里的会话会被拒，reason 为 `interface-session-is-dev-session`，驾驶舱要把这个原因如实显示给用户。
- fleet 未落地或 CLI 不可用 ⇒ 按方案第 3 条回落。读函数只调 `get`，写函数只调 `set`/`clear`。

## Touches

- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/CockpitInput.tsx
- src/modules/cockpit/cockpitRouting.ts
- src/modules/cockpit/hooks/useCockpitPushToTalk.ts
- src/modules/cockpit/tests/cockpitRouting.test.ts
- src/modules/cockpit/tests/CockpitPushToTalk.test.tsx
- src/modules/chat/index.ts
- src/shared/api.ts
- src/shared/context/WebSocketContext.tsx
- server/modules/quay/quay-fleet-registry.ts
- server/modules/quay/quay.routes.ts
- server/modules/quay/quay.module.ts
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
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
- tasks/cockpit-push-to-talk-and-focus-routing.md
