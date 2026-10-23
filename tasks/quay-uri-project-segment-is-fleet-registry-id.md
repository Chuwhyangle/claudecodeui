---
id: quay-uri-project-segment-is-fleet-registry-id
title: quay:// 项目段改用 fleet registry id（现用 CloudCLI 项目 UUID，与 fleet 不兼容且不可说）
status: todo
labels:
  - wall
  - contract
  - quay
parent: null
children: []
extra: {}
depends_on:
  - cockpit-read-only-stage
  - quay-wall-uri-dereference-with-snapshot-fallback
---
## Proposal

决策出处：2026-10-23 对 `cockpit-read-only-stage` 截图的视觉复核。舞台状态条显示焦点为 `quay://86168fbf-16c9-4178-b23b-36b74c2eb695/board`、`quay://50654ea6-…/task/ui-scenario-driver-semantic-surface`——**URI 的项目段用的是 CloudCLI 内部的项目 UUID**（`QuayPanel.tsx` 用 `projectId` 拼 URI，驾驶舱沿用）。

问题：
1. **与 fleet 契约不兼容**：quay-fleet 的项目段是 registry id（`~/.quay-fleet/registry.json` 的 `projects[].id`，如 `quay-fleet`、`claudecodeui`、`quay`），fleet 修复任务 `fleet-wall-uri-project-segment-fix` 正是按 registry id 把项目段映射到 root。CloudCLI 的 UUID 在 fleet 侧必然 `unknown-project`。
2. **不能说出口**：UUID 不是口语句柄，违反「所见即可说」——引用里的项目必须是人能念、能认的名字。
3. **跨应用不稳定**：UUID 是 CloudCLI 本地数据库的身份，换实例就变；registry id 是 fleet 的唯一来源。

方案：
1. **项目段 = fleet registry id**。服务端在 quay 模块里建立映射：读 fleet registry（`quay-fleet registry list --json`），按 root 路径与 CloudCLI 项目路径（规范化后）相等匹配，得到 `fleetProjectId`。映射集中在一个服务函数里，带短 TTL 缓存。
2. `GET /api/quay/fleet-summary` 与 `GET /api/quay/:projectId/snapshot` 的每个项目附带 `fleetProjectId`（无匹配为 null）。
3. 前端 `QuayPanel` 与驾驶舱拼 URI 一律用 `fleetProjectId`；为 null 的项目**不声明可聚焦元素**（不可被引用），磁贴上显示「未登记到 quay-fleet」，不得退回 UUID。
4. 服务端解引用（`quay-uri-resolve.ts`）把项目段按 registry id 解析：项目段 → fleet root（`--root`）；原先按 CloudCLI projectId 查找的路径删除。
5. 驾驶舱的意图解析里的项目名（「看 claudecodeui」）与 URI 项目段使用同一个 registry id。

## AC

- [ ] AC1: `npx vitest run src/modules/quay/tests/QuayPanel.test.tsx` exit 0——在途任务磁贴 URI 为 `quay://<fleetProjectId>/task/<id>`；`fleetProjectId` 为 null 时不声明可聚焦元素并显示未登记提示；全文件断言中不出现 UUID 形态的项目段。
- [ ] AC2: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——fleet 视图项目 URI 为 `quay://<fleetProjectId>/board`；未登记项目不可聚焦。
- [ ] AC3: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/quay-fleet-project-id.test.ts` exit 0——桩 registry 按规范化 root 匹配（尾斜杠、符号链接解析后相等）得到 registry id；无匹配为 null；registry CLI 不可用时全部为 null 且不抛出。
- [ ] AC4: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/quay-uri-resolve.test.ts` exit 0——项目段按 registry id 解析到 root；UUID 形态项目段返回 `unknown-project`。
- [ ] AC5: `npm run typecheck` 通过。

## DoD

- **MCP 浏览器实际操作 + 截图（必做）**：真实 CloudCLI 的 `/cockpit` 与 Quay 面板上，状态条显示的焦点 URI 为 `quay://claudecodeui/...` 这类 registry id 形态；截图存 `tmp/`，`browser_evaluate` 读回可见集，确认无 UUID 项目段。
- 用 `ui-scenario-driver-semantic-surface` 落地的运行器跑一次 Quay 面板场景，贴报告。

## Notes

### fleet 确认（2026-10-23）

- 项目段的权威来源 = fleet registry `projects[].id`（稳定 slug）。fleet 没有改名动词：改 id 只能 remove + add，等于换新身份；将来若支持改名，会先和 CloudCLI 对齐。
- `quay-fleet registry list --json` 实测形状：`{"version":1,"projects":[{"id","root","enabled",...}],"interfaceSessionIds":[...],"devSessionIds":[...]}`。
- `enabled` 不参与映射：与 fleet 的 id→root 映射保持一致，disabled 的登记项仍可被引用。
- 当前 registry 只有 5 个项目（quay-fleet、quay、claudecodeui、archguard、plantuml-js）；驾驶舱显示的 cantus、meta-cc 未登记，修正后会显示「未登记到 quay-fleet」且不可被引用——这是预期行为，不是缺陷。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/quay.routes.ts
- server/modules/quay/quay-fleet-project-id.ts
- server/modules/quay/quay-uri-resolve.ts
- server/modules/quay/tests/quay-fleet-project-id.test.ts
- server/modules/quay/tests/quay-uri-resolve.test.ts
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/hooks/useQuayStatus.ts
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/cockpit/cockpitView.ts
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/shared/types.ts
- tasks/quay-uri-project-segment-is-fleet-registry-id.md
