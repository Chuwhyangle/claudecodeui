---
id: architecture-tab-i18n
title: architecture tab 的 i18n 完整性：所有 locale 补 tabs.architecture 与面板文案
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-tab-ui
goal_ac: AC-420
---
## Proposal

实现 ADR-005 决策 1 的 i18n：所有 locale 的 `chat.json` 补 `tabs.architecture` 与面板文案 key（镜像 `tabs.quay` 与 `i18nQuayTabCompleteness` 的既有模式），并新增完整性测试钉住「缺任一 key 即红」。对应 GOAL-049 的 AC-420。

<!-- dedup-ref --> 机制去重（2026-10-21 立案实测）：`grep -rl "^goal_ac: AC-420" tasks/*.md` → 0 命中。merge-candidate（`src/modules/i18n/locales/*/chat.json`）→ `peers: []`，separate。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（所有 locale 均有 `tabs.architecture` 与面板文案 key，缺任一即红）

## DoD

12 个 locale 的 `chat.json` 都实际写入 `tabs.architecture` 与面板文案，且完整性测试在真实 locale 集上通过——不是只补了英文。

## Touches

- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- tasks/architecture-tab-i18n.md