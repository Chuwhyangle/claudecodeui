---
id: architecture-tab-i18n
title: architecture tab 的 i18n 完整性：所有 locale 补 tabs.architecture 与面板文案
status: done
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

实现 ADR-005 决策 1 的 i18n：所有 locale 的 `common.json` 补 `tabs.architecture` 与面板文案 key（镜像 `tabs.quay` 与 `i18nQuayTabCompleteness` 的既有模式），并新增完整性测试钉住「缺任一 key 即红」。对应 GOAL-049 的 AC-420。

立案时写的 `chat.json` 经现状复核为错位：`tabs.*` 与 `architecture.*` 都由 `useTranslation()` 的 defaultNS（`common`，见 `src/modules/i18n/config.ts` 的 `defaultNS: 'common'`）解析，写进 `chat.json` 运行时不可达；故落地在 `common.json`。

<!-- dedup-ref --> 机制去重（2026-10-21 立案实测）：`grep -rl "^goal_ac: AC-420" tasks/*.md` → 0 命中。merge-candidate（`src/modules/i18n/locales/*/common.json`）→ `peers: []`，separate。

## AC

- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（所有 locale 均有 `tabs.architecture` 与面板文案 key，缺任一即红）

## DoD

12 个 locale 的 `common.json` 都实际写入 `tabs.architecture` 与面板文案，且完整性测试在真实 locale 集上通过——不是只补了英文。

## Touches

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
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- tasks/architecture-tab-i18n.md