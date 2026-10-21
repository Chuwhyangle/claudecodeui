---
id: GOAL-049
title: 会话级架构分析 tab：本会话提到的文件/标识符的架构图，按需生成、缓存随种子或 .archguard 更新失效
status: active
kind: goal
origin: 本会话（2026-10-21）关于会话级架构分析 tab 的设计讨论，人 yale 指令收敛为 ADR-005 并落成 quay goal
activatedAt: 2026-10-21T07:02:11.826Z
---
## 背景

每个会话顶部新增 architecture tab（Quay 右侧），点击后显示「本会话提到的代码文件/标识符」的架构图：按 `sessionId` 读全量 transcript 提取种子，基于 `.archguard/query/` 缓存的预建邻接结构解析并双向扩展，生成 file 级与 entity 级两份 `.mmd`，前端经 `MermaidDiagram` 渲染。按需生成（点 tab 即生成），结果内容寻址缓存——种子列表更新或 `.archguard` 更新即失效。设计依据 ADR-005。

## 退出条件

- AC-415 生成器：种子解析 → 双向扩展 → 聚合 → emit `.mmd` 正确（fixture `arch-index.json`，file 级与 entity 级、节点预算截断、mermaid 合法性）。
- AC-416 种子提取：transcript → 文件种子（tool_use `file_path`）+ 标识符种子（`nameToIds` 精确命中）正确，去重与 cap 生效。
- AC-417 缓存内容寻址：相同键命中；种子变 / `archJsonHash` 变 / 参数变即失效。
- AC-418 REST 端点与门控：`POST /api/architecture/graph` 返回 `{mmd{file,entity}, stats, provenance}`；`hasArchguardCache` Tier-1 门控正确。
- AC-419 前端 tab：门控 + snap-back + 激活即 fetch + `MermaidDiagram` 渲染 + file/entity 本地切换 + provenance 诚实栏 + 空态。
- AC-420 i18n 完整性：所有 locale 均有 `tabs.architecture` 与面板文案。

## 非目标

全项目 package 概览、变更影响/风险叠加层、按需跑分析、`.mmd` 落盘（见 ADR-005 非目标）。

## 已知实现约束（落地时必查）

- 跨模块导入 `MermaidDiagram` 须经 barrel（repo lint 深导入会红 boundaries）。
- `src/modules/architecture/` 新叶子目录须按 AC-394 棘轮同时进 manifest 与 MANIFEST_PIN。
- 新增 server 测试文件会顶高 quay-test-script 的 unknown pin、压 AC7 覆盖率地板：实现时同步调 pin 并把新测试文件写进 Touches。