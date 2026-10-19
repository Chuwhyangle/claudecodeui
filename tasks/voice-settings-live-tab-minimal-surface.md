---
id: voice-settings-live-tab-minimal-surface
title: Voice 设置 Live Voice 子 tab 最小面：只暴露 liveVoiceDashscopeApiKey（AC-409）
status: ready
labels: []
parent: null
children: []
extra: {}
goal_ac: AC-409
---
## Proposal

把「Live Voice 设置首轮只放 key」这条已同意的决定钉成一条可运行判据（AC-409），并补上它缺的那份测试。

决定（2026-10-19 yale 拍板）：Settings - Voice 的 Live Voice 子 tab 只暴露 `liveVoiceDashscopeApiKey` 一个字段，endpoint / model / voice 用后端默认值——减少首轮表面积，后续有需求再加。

现状：UI 已经这么做了。`src/modules/settings/tabs/VoiceSettingsTab.tsx` 已有「Voice Input / Live Voice」两个子 tab（`role=tablist`，同 Agents 样式），Live Voice 子 tab 只渲染 `liveVoiceDashscopeApiKey`（无 endpoint/model/voice）。但没有任何测试把「只 key、不多字段」钉住——AC-409 的判据指向一个尚不存在的测试文件，当前必红。

本任务只做一件事：写 `src/modules/settings/tests/voiceSettingsLiveTabMinimalSurface.test.tsx`（组件测试，vitest + @testing-library/react，参考同目录 `voiceSettingsProviderSelection.test.tsx` 的装配手法），断言：

1. 两个子 tab 都在（input / live，`data-testid` 或 `role=tab` 可定位）。
2. 切到 Live Voice 子 tab 后，只出现 `liveVoiceDashscopeApiKey` 一个输入；不渲染 endpoint / model / voice 输入（断言缺失，而非断言存在）。
3. key 填写→保存→readback 是掩码、再次保存不把掩码写回（`unmaskMaskedCredentials` 持久化原值）。

不改产品代码；若发现产品代码与「只 key」不符（例如多渲染了字段），先报出来而不是在测试里迁就。

## AC

- [ ] **AC-409**：`npx vitest run src/modules/settings/tests/voiceSettingsLiveTabMinimalSurface.test.tsx` 退出码 0。Live Voice 子 tab 只暴露 `liveVoiceDashscopeApiKey`（不渲染 endpoint/model/voice），key 填写→保存→readback 掩码、再保存不写回掩码。取假形态：Live Voice tab 多渲染一个 endpoint/model/voice 字段，必红。

## DoD

- AC-409 判据转绿（`npx vitest run src/modules/settings/tests/voiceSettingsLiveTabMinimalSurface.test.tsx` 退出 0）。
- `npm run typecheck` 退出 0。
- GOAL-047 退出条件第 7 条已点名 AC-409、范围节点名 AC-409（已落地，本轮核对）。

## Touches

- src/modules/settings/tests/voiceSettingsLiveTabMinimalSurface.test.tsx
- src/modules/settings/tabs/VoiceSettingsTab.tsx
- goals/AC-409-Live-Voice-配置最小面-只暴露-liveVoiceDashscopeApiKey-endpoint-model-voice-用后端默认.md
- goals/GOAL-047-语音输出作为信心层-eyes-off-用户获得-在听-听懂了-可继续说-的信心.md
- tasks/voice-settings-live-tab-minimal-surface.md
