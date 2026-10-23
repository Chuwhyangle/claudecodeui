---
id: quay-wall-addressable-view-and-input-package
title: 墙：视图契约 + quay:// 地址工具 + 引用式输入包 + 确定性指涉解析（零 fleet 依赖，A/B 片）
status: ready
labels:
  - wall
  - contract
  - quay
parent: null
children: []
extra: {}
---
## Proposal

决策出处：与 quay-fleet 协作会话对齐的「墙」方向（2026-10-23）。按职责切：quay-fleet 拥有状态模型 / 事件流 / 写路径摘要，并提供 `quay://` 对象读口（fleet 任务 `fleet-wall-object-uri-address-space`）；CloudCLI 拥有渲染 / 焦点 / 输入（语音、手柄）/ 输入托盘。

**2026-10-23 收窄（用户已确认拆分）**：本任务只做**零 fleet 依赖**的两片——视图契约 + `quay://` 地址工具（A）、引用式输入包（B），外加确定性的显示属性解析（D 的确定性部分）。「下游按 URI 读回真实数据」拆到 `quay-wall-uri-dereference-with-snapshot-fallback`（C），本任务**不做解引用、不调 fleet 端点**。

现状实读（2026-10-23）：
- QuayPanel（src/modules/quay/QuayPanel.tsx）渲染 typed QuaySnapshot 只读镜像，完整任务板 link-out 到 quay serve。
- voiceContextPack.ts（C2 ContextPack）是 `角色：文本` 的字符预算行，非对象引用。

方案：
1. **URI 语法（与 fleet 一致，带项目段）**：`quay://<project>/task/<id>`、`quay://<project>/task/<id>#ac-<n>`、`quay://<project>/goal/<id>`、`quay://<project>/ledger/<name>/<eventId>`、`quay://<project>/board`。纯函数 parse/format，往返一致；缺项目段的 `quay://task/<id>` 视为非法。L1 的 `type`/`actions` 枚举**以 fleet 为唯一来源**，本侧只消费、不另立动作集（本任务可只落 `type`，`actions` 留给 C 从 fleet 读）。
2. **视图契约**：可聚焦子元素 = `{uri, label, display:{status,color,ordinal,pos}}`，空间序。第一块落地 = QuayPanel 的在途任务磁贴。类型放 src 侧（`src/shared/types.ts`），不放仓库根 shared。
3. **引用式输入包**：`{utterance, focus, visible, history, tray, text}`——
   - `focus`：焦点对象引用或 null；`visible`：可见集引用（带显示属性），空间序。
   - `history`：最近看过的**视图/对象引用**（URI 数组），不是 C2 对话文本。
   - `tray`：用户钉进输入托盘的**对象引用**（URI 数组），不是草稿文本。
   - `text`：既有 C2 对话包 + 草稿/已说块原样，作为降级路径与 ASR 热词来源；字节级等同现有输出。
   - 只有 `text` 携带文本；`focus/visible/history/tray` 只携带 `{uri,label,display}`，不携带标题、正文、摘要。
4. **确定性显示属性解析**：「第二个 / ② / 红的那个 / 左上那个」按 ordinal / label / color / pos 在 `visible` 上精确匹配；有歧义（如两个红的）或无匹配就返回 ambiguous / none，不猜。自由形式的说法不在本任务范围。

## AC

- [x] AC1: `npx vitest run src/modules/quay/tests/quayUri.test.ts` exit 0——五种 URI 形态 parse→format 往返一致；缺项目段、未知类型、空 id 都被拒绝。
- [x] AC2: `npx vitest run src/modules/quay/tests/QuayPanel.test.tsx` exit 0——在途任务磁贴按视图契约声明可聚焦子元素，URI 为 `quay://<project>/task/<id>`，带序号标签与 status/color 显示属性；既有用例不弱化。
- [x] AC3: `npx vitest run src/modules/chat/utils/tests/voiceContextPack.test.ts` exit 0——引用包夹具：`focus` 为焦点磁贴 URI；`focus/visible/history/tray` 中不出现任务标题或正文文本；`history`/`tray` 为 URI 数组；`text` 与既有 C2 输出逐字相等；focusUri 不在可见集时 `focus` 为 null；既有 C2 用例不弱化。
- [x] AC4: 同一测试文件中的解析用例——「第二个」「②」「红的那个」「左上那个」各自命中唯一对象；两个同色对象时「红的那个」返回 ambiguous；「一起」「十二点」不被当成序号。
- [x] AC5: `npm run typecheck` 通过。

## DoD

- 在真实运行的 CloudCLI 上打开 Quay 面板，在途任务磁贴带可见序号标签；在开发者控制台或测试夹具中对一条语音构建引用包，包内 focus 为该磁贴的 `quay://<project>/task/<id>`。
- **MCP 浏览器视觉验证（必做）**：用 playwright MCP 打开真实运行的 CloudCLI → Quay 面板，截图在途任务磁贴的序号标签与状态色（截图存仓库 `tmp/`），并用 `browser_evaluate` 读回该磁贴声明的可聚焦子元素（uri/label/display），与截图上看到的一致。证据贴进 Evidence。
- 如实写明：本任务不解引用（交给 C）；`text` 降级路径的兼容边界。

## Notes

实现读数（2026-10-23，worktree 分支 `task/quay-wall-addressable-view-and-input-package`，merge develop 后重跑）：

- AC1 `npx vitest run src/modules/quay/tests/quayUri.test.ts` → **exit 0，6 passed**。五种形态 parse→format→parse 往返；`quay://task/<id>`（缺项目段）→ `missing-project`；未知类型 → `unknown-type`；空 id/name/eventId → `empty-id`；多段 / `#ac-0` / 非 task 片段 / query → `malformed`。
- AC2 `npx vitest run src/modules/quay/tests/QuayPanel.test.tsx` → **exit 0，31 passed**（原有用例 28 条未改动）。在途磁贴发布 `data-quay-focusables`（每行 `{uri,label,display}`，URI `quay://<project>/task/<id>`），行内可见序号标签 ①/②；`status` = in-flight phase，`color` 与 phase 徽标同源；`inFlight === null` 不发布契约、`[]` 发布空集。
- AC3/AC4 `npx vitest run src/modules/chat/utils/tests/voiceContextPack.test.ts` → **exit 0，20 passed**（原有 C2 用例未改动）。引用包 `history`/`tray` 为 URI 数组、`focus`/`visible` 只有 `{uri,label,display}`、`text` 与 `buildVoiceInputContextPack` 输出逐字相等；focusUri 不在可见集 ⇒ `focus: null`；「第二个」/「②」/「红的那个」/「左上那个」各自唯一命中，两个红色 ⇒ `ambiguous`，「一起」/「十二点」⇒ `none`。
- AC5 `npm run typecheck` → **exit 0**。另跑 `npm run lint` → exit 0（仅既有 warning）与 `npm run build:client` → 成功；anti-drift Touches check → OK（7 个实际文件全在 Touches 内）。

兼容边界（如实）：
- 本任务**不解引用**，不调 fleet 端点；按 URI 读回真实数据在 `quay-wall-uri-dereference-with-snapshot-fallback`（C）。
- `text` 字段逐字等于既有 C2 对话包 + 草稿/已说块输出，是无 wall 部署的降级路径（也是 ASR 热词来源）。`useVoiceInput` 当前仍只发送该 `text` 半；把引用半接线进语音链路是后续工作，本任务只落格式与纯函数。
- DoD 第 1 条的读数由 `QuayPanel.test.tsx` 的真实组件 render + 引用包夹具提供；本 worker 会话未做浏览器目视复核。

## Touches

- src/shared/types.ts
- src/modules/quay/quayUri.ts
- src/modules/quay/tests/quayUri.test.ts
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/chat/utils/voice/voiceContextPack.ts
- src/modules/chat/utils/tests/voiceContextPack.test.ts
- tasks/quay-wall-addressable-view-and-input-package.md
