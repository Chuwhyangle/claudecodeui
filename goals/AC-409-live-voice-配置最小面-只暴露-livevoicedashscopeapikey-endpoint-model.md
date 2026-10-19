---
id: AC-409
title: Live Voice 配置最小面：只暴露 liveVoiceDashscopeApiKey（endpoint/model/voice 用后端默认）
status: active
kind: criterion
goal: GOAL-047
criterion: npx vitest run
  src/modules/settings/tests/voiceSettingsLiveTabMinimalSurface.test.tsx
expect: 退出码 0（⚠️ 当前必红：测试文件不存在）。Settings - Voice 分「Voice Input / Live Voice」两个子
  tab（role=tablist，与 Agents 同款）。Live Voice 子 tab 只暴露 liveVoiceDashscopeApiKey
  一个字段：不渲染 endpoint / model / voice 输入（后端默认）。key 填写→保存→readback
  为掩码、再次保存不把掩码写回（unmask 持久化原值）。取假形态：Live Voice tab 里多渲染出一个 endpoint/model/voice
  字段，必红。
origin: 本会话 2026-10-19 yale 与 Claude 讨论产出：Live Voice 设置首轮只放
  key（endpoint/model/voice 用后端默认，减少首轮表面积，后续有需求再加）。跑通完整典型场景的配置前提——只需配 key 即可出声。
activatedAt: 2026-10-19T09:55:26.305Z
---
