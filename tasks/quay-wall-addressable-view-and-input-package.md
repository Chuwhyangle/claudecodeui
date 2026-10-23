---
id: quay-wall-addressable-view-and-input-package
title: "墙视图 + 视图契约 + 引用式输入包（CloudCLI 侧契约 #2/#3，依赖 fleet 对象 URI 契约）"
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

决策出处：与 quay-fleet 协作会话对齐的「墙」方向（2026-10-23）。按职责切：quay-fleet 拥有状态模型/事件流/写路径摘要并提供 quay:// 对象端点；CloudCLI 拥有渲染/焦点/输入（语音、手柄）与输入托盘。本任务 = CloudCLI 侧两份契约：视图描述格式 + 视图契约（该会话 §5 第 2 条）、输入包格式（第 3 条）。依赖 fleet 侧对象 URI 契约（quay-fleet 的 fleet-wall-object-uri-address-space，先钉）。

现状实读（2026-10-23）：
- QuayPanel（src/modules/quay/QuayPanel.tsx）渲染 typed QuaySnapshot 只读镜像（QuayListItem/QuayInFlightTask/QuayTimelineWindow/gantt），完整任务板 link-out 到 quay serve。
- voiceContextPack.ts（C2 ContextPack）已是「把可见内容带进语音输入」的实现，但为 角色：文本 的字符预算行，非对象引用。
- server/.../claude-resident-addressable.test.ts 说明「可寻址对象」底座已有一半。

方案：
1. 墙视图：QuayPanel 每个磁贴渲染成可寻址对象（quay:// URI + 显示属性：颜色/状态/序号标签/位置）。
2. 视图契约：每个视图组件声明可聚焦子元素（空间序 + URI + 短口语标签 ①②③ + 显示属性）；放大=进入焦点对象子视图，缩小=回父视图。
3. 输入包升级：voiceContextPack 从文本行升级为引用包（utterance + focus + visible(带显示属性) + history + tray），送引用不送内容。

## AC

- [ ] AC1: 视图契约类型落 shared/types：可聚焦子元素 = {uri, label, display}；QuayPanel 至少一块 tile 按契约声明可聚焦子元素。
- [ ] AC2: 输入包带对象引用：夹具证明一条语音的上下文里含 focus 对象 URI，且下游按 URI 读回真实数据（非转述文本）。
- [ ] AC3: 显示属性可指涉：可见集元素带颜色/状态/序号/位置，解析「红的那个/第二个」按显示属性匹配。
- [ ] AC4: 既有判据原样通过：QuayPanel / voiceContextPack 既有测试绿（不弱化断言）。

## DoD

- 一块真实 QuayPanel tile 经 quay:// 地址被输入包按引用带入语音上下文，且下游读回真实任务数据。
- 如实写明与 C2 ContextPack 的兼容边界（文本行降级路径），以及 quay:// 端点缺失时的行为。

## Touches

- src/shared/types.ts
- src/modules/quay/QuayPanel.tsx
- src/modules/chat/utils/voice/voiceContextPack.ts
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/chat/utils/tests/voiceContextPack.test.ts
- tasks/quay-wall-addressable-view-and-input-package.md
