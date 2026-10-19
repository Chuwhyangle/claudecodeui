---
id: gap-voice-realtime-per-user-key
title: live voice realtime 凭据改读 per-user dashscopeApiKey（仅 key）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 相关既有任务 `gap-asr-dashscope-user-credential-configured-mask-and-log` 已把 `dashscopeApiKey`/`dashscopeEndpoint`/`dashscopeModel` 加进 per-user 设置并接进 one-shot ASR 路径；本任务是把**同一把 key** 接到 realtime 路径——realtime 现在只读 `DASHSCOPE_API_KEY` env，机制不同、不重复它。

现状：live voice realtime 的 DashScope 凭据只读服务端环境变量 `DASHSCOPE_API_KEY`（`server/index.ts:762` 注入 `createDashscopeTransport({ apiKey: process.env.DASHSCOPE_API_KEY })`，拨号时使用，缺了报 `MISSING_API_KEY`）；而 voice input 的 one-shot `dashscope-omni` 已走 per-user 设置——`voice.service.ts:293-294` 用户 `dashscopeApiKey` 优先、回落 env。同一把 DashScope key 分两处、只有一路上了设置页。

关键事实：设置读是同步的（`voice-settings.db.ts:109` `getSettings(userId): VoiceSettings`，better-sqlite3），且 realtime 组装点已收到 `userId`（`server/index.ts:1032`），只差组装点拿不到设置仓库——`voice.module.ts:359` 建的 `voiceSettingsService` 没从 barrel 导出，`server/index.ts` 只 import 了 `voiceRoutes`/`voiceClientAssetRoutes`。

方案（仅统一 key；endpoint/model 保持部署级）：
1. 从 voice barrel 导出一条设置读取口（`voiceSettingsDb.getSettings` 或窄化 helper）。
2. 把 key 解析抽成可单测的小纯函数 `resolveRealtimeApiKey(userDashscopeApiKey, envApiKey)`：`userDashscopeApiKey.trim() || envApiKey || ''`，放进 voice-realtime 模块并导出。
3. `buildVoiceRealtimeSeams` 把 `apiKey` 改为 `resolveRealtimeApiKey(getSettings(input.userId).dashscopeApiKey, process.env.DASHSCOPE_API_KEY)`，照抄 one-shot 的优先级：用户 key 优先、回落 env、双空仍 `MISSING_API_KEY`；transport 自身的 `?? process.env` 回落保持不动（其他调用方仍依赖它）。

范围外（有意不做）：realtime 端点打固定 `PUBLIC_HOSTNAME`（`voice-realtime-dashscope-transport.ts:150`），不改用用户 `dashscopeEndpoint`——避免给 realtime WS 打开用户自定义端点的 SSRF 面；realtime 模型 `qwen3.8-omni-flash-realtime` 与 one-shot 的 `dashscopeModel` 是两个不同 model id，不复用同一字段。设置页字段已存在（`VoiceSettingsTab` 按 provider 声明动态渲染），无需新增设置面；文案是否注明「也作用于 Live Voice」留作后续小改。

## AC

- [x] `grep -n "dashscopeApiKey" server/index.ts` 命中，且 `grep -nE "apiKey: process\.env\.DASHSCOPE_API_KEY" server/index.ts | wc -l` 为 0（组装点改为经 per-user 设置解析，不再只读 env）。
- [x] 新增服务端单测钉住 `resolveRealtimeApiKey` 优先级：`('u','e')→'u'`、`('','e')→'e'`、`('  ','e')→'e'`、`('','')→''`；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-api-key-resolution.test.ts` exit 0。
- [x] 既有 `voice-realtime-dashscope-transport` 的 `MISSING_API_KEY` 与「拨号 URL/日志不含凭据」判据仍绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts` exit 0。
- [x] `npx tsc --noEmit -p server/tsconfig.json` 与 `npx oxlint server/` 对改动文件 exit 0。

## DoD

真实落地判据（机械、无需真实 key）：`resolveRealtimeApiKey` 单测 + `server/index.ts` 组装点 grep 证明 per-user key 被读进 transport 的 `apiKey`；既有 transport 单测证明该 key 以 `Authorization: Bearer` 进拨号头、双空 `MISSING_API_KEY`、不落日志/拨号 URL。三件合起来即「per-user 机制实际驱动了 realtime transport」，不靠 fixtures 自证。另注：『同一把 key 能否打 realtime WS』需人用一把真实 key 做一次握手冒烟（受 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION` 上限约束），属落地后人工验证、不阻塞本任务。

## Touches

- server/index.ts
- server/modules/voice/voice.module.ts
- server/modules/voice/index.ts
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/tests/voice-realtime-api-key-resolution.test.ts (new)
- server/shared/tests/quay-test-script.test.ts (re-measure the collected-server-file unknown-count pins after the new criterion file: 374→375)
- tasks/gap-voice-realtime-per-user-key.md (self)

## Blocker

**2026-10-19T06:48:18.051Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=76931 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1792392160727
- run_id：wk-prod-anchor
- session_id：e179731c-cc3c-45b0-81fc-c02482f0c4f0
