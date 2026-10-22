---
id: architecture-plantuml-export-menu
title: 导出菜单：PlantUML（.puml，主选项）/ 复制 PlantUML / SVG / PNG / Mermaid（旧格式）
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-class-diagram-rendering
---
## Proposal

现在只有一个 `Export .mmd`（Mermaid，`ArchitecturePanel.tsx:327` 的 `exportMmd`），而画面本身是由 PlantUML 文本渲染出来的——用户拿不到真正画出来的那份源。本任务把导出做成一个菜单，PlantUML 是主选项：

1. **`导出 ▾` 菜单**（占用工具栏里为它预留的槽；若该槽尚不存在则放在现有头部右侧）：
   - **PlantUML（.puml）**：下载**当前画面对应**的 puml 文本——视角（类图/文件）、范围、详情、当前下钻的视图（overview/group/neighborhood/hierarchy）全部生效；内容就是桥接 `archguardToPlantUml` 产出的那份（含嵌套 package、构造型、成员分栏），不是另行生成的近似物。
   - **复制 PlantUML**：同一份文本写入剪贴板，成功/失败有 `aria-live` 提示；剪贴板不可用时回落为选中文本的对话框。
   - **SVG**：下载当前渲染出的 SVG（去掉运行期注入的 `arch-dim/arch-hl-*` 高亮类与内联缩放尺寸，viewBox 保留）。
   - **PNG**：把上述 SVG 栅格化（2× 缩放，长边上限 8192px，超限等比缩小并提示）。
   - **Mermaid（.mmd，旧格式）**：保留现有 `exportMmd` 行为，菜单里标注「旧格式」，排在最后；文件名与内容与改前逐字相同。
2. 文件名带粒度与时间：`architecture-class-<项目>-<YYYYMMDD-HHmm>.puml`（项目名做文件名安全化）。
3. 导出的 puml 可被 plantuml-js 与标准 PlantUML 解析：测试里用 plantuml-js 的 `checkSyntax`（包自带）校验产物无 error 级诊断。
4. 菜单是标准的 disclosure/menu 语义（`aria-haspopup="menu"`、方向键、Escape 仅关闭菜单且 `stopPropagation`，不触发聊天页的全局 abort），手机上以底部抽屉形态呈现（抽屉本身由手机布局任务提供，这里菜单内容与逻辑与形态无关）。

## AC

- [x] `npx vitest run src/modules/architecture/tests/exportMenu.test.tsx` exit 0（新文件）：菜单含五项且 Mermaid 标「旧格式」排最后；`.puml` 下载内容与桥接对当前视图产出的 puml 逐字相同（分别断言类图/文件、下钻 group/neighborhood 三种视图）；范围/详情变化后导出内容随之变化；复制 PlantUML 调用剪贴板并有成功提示；剪贴板拒绝时走回落路径
- [x] 同文件：导出的 puml 经 plantuml-js `checkSyntax` 无 error 级诊断；SVG 导出不含 `arch-dim`/`arch-hl-` 类名；PNG 栅格化的长边不超过 8192 且超限时有提示；`.mmd` 导出与改前逐字相同
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：旧的单独 `Export .mmd` 按钮不再作为独立控件出现；Escape 只关闭菜单、不触发会话 abort（`chat.abort` 调用计数为 0）；既有用例不回归
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器打开 quay 会话 architecture tab（类图视角）：`导出 ▾` → PlantUML，下载得到的 `.puml` 文件能直接粘进 PlantUML 在线/本地渲染器并画出与屏幕一致的图（贴文件头几行与该渲染结果的截图）；把范围从 +2 调到 +1 再导出，文件内容变小；复制 PlantUML 后粘贴到编辑器内容一致；SVG/PNG 能打开；Mermaid 项仍可用且标了旧格式。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/exportArtifacts.ts (new)
- src/modules/architecture/tests/exportMenu.test.tsx (new)
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- src/modules/architecture/tests/mobileGestures.test.tsx
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/de/common.json
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
- tasks/architecture-plantuml-export-menu.md