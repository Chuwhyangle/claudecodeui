---
id: quay-wall-uri-dereference-with-snapshot-fallback
title: 墙 C 片：quay:// 引用解引用（fleet L1/L2 读口主路径 + snapshot 回落）
status: todo
labels:
  - wall
  - contract
  - quay
parent: null
children: []
extra: {}
---
## Proposal

决策出处：墙方向拆分（2026-10-23，用户已确认）中的 C 片。前置：`quay-wall-addressable-view-and-input-package`（A/B 片：`quay://` 地址工具、视图契约、引用式输入包）落地后再做；fleet 侧读口来自 quay-fleet 任务 `fleet-wall-object-uri-address-space`。

问题：A/B 片之后，输入包里送的是 `quay://<project>/task/<id>` 引用，但 CloudCLI 侧还没有任何地方能把引用读回成真实对象。下游（指挥会话、项目会话）拿到引用后需要一个解引用入口。

方案：
1. 解引用入口（服务端，挂在既有 `/api/quay` 路由下）：`resolve(uri)` 返回 L1 `{uri, type, actions}`，`summary(uri)` 返回 L2 `{summary, generatedAt, sourceEventId}` 或 absent。
2. **主路径**：调用 fleet 的 L1 `resolve` 与 L2 `summary` 读口（L2 读 `.quay/object-summaries.jsonl` 最新行，读路径零生成）。`type`/`actions` 枚举原样采用 fleet 返回值，本侧不另立动作集。
3. **回落路径**：fleet 读口不可用时，task 类 URI 从既有 quay snapshot 数据读回真实任务字段；结果带 `source: "snapshot-fallback"` 标记，`actions` 为空，L2 返回 absent。绝不现场调用 LLM 生成摘要。
4. 非法或未知 URI 返回明确的错误码，不抛未处理异常。

## AC

- [ ] AC1: `npx vitest run server/modules/quay/tests/quay-uri-resolve.test.ts` exit 0——用桩 fleet 读口：`resolve(quay://<project>/task/<id>)` 返回桩给出的 type/actions 原值；`summary` 返回桩里最新一行；无行时返回 absent。
- [ ] AC2: 同一测试文件——fleet 读口不可用时，task URI 读回的标题/状态与 snapshot 夹具中该任务的真实字段相等，且结果带 `source: "snapshot-fallback"`、`actions` 为空、L2 为 absent。
- [ ] AC3: 同一测试文件——非法 URI（缺项目段、未知类型）返回错误码而非 500；整个文件中没有任何 LLM / 生成调用（以注入桩计数为 0 断言）。
- [ ] AC4: `npm run typecheck` 通过；`server/modules/quay/tests/quay-fleet-summary.test.ts` 既有用例原样通过。

## DoD

- 在真实运行的 CloudCLI 上，对一块在途任务磁贴的 URI 调用解引用入口，读回与 Quay 面板一致的真实任务数据；如实写明当时走的是 fleet 主路径还是 snapshot 回落路径。

## Touches

- server/modules/quay/quay.routes.ts
- server/modules/quay/quay.service.ts
- server/modules/quay/quay-uri-resolve.ts
- server/modules/quay/tests/quay-uri-resolve.test.ts
- tasks/quay-wall-uri-dereference-with-snapshot-fallback.md
