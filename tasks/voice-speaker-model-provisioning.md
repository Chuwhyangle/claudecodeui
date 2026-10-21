---
id: voice-speaker-model-provisioning
title: 声纹模型按需安装：项目内 models/speaker、不入库、不随交付物、设置页触发服务端下载
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
depends_on:
  - voice-speaker-tracking-settings-file
---
## Proposal

声纹跟踪需要 CAM++ 模型 `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`（28,281,164 bytes，sha256 `aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2`）。它现在只存在于实验目录 `/tmp/tse-eval-models/alt/`，不是交付形态。

交付要求（用户 2026-10-21）：

1. 模型文件放在**本项目目录下**（默认 `models/speaker/`），但**不被 git 跟踪**；
2. 后续实际交付物（npm 包、Electron 包、Docker 镜像）**不带该文件**；
3. 在 **settings 页**提供“触发服务端下载”的能力，把文件下载到设置文件指定的目录；
4. 下载源固定、校验 sha256、原子落盘、可重试、并发安全；客户端不能指定任意 URL 或任意路径。

本任务只做模型安装/状态/UI；声纹跟踪的 mode/阈值文件化由 `voice-speaker-tracking-settings-file` 负责。

固定来源：

- URL：`https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`
- 文件名：`3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`
- sha256：`aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2`
- 许可/归属：3D-Speaker 模型，Apache-2.0；状态读数与设置页要显示来源与许可。

默认路径来自设置文件（与上一任务同一 `speakerTracking` 段）：

```json
{
  "speakerTracking": {
    "modelDir": "models/speaker",
    "modelFile": "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "modelPath": ""
  }
}
```

解析：`modelPath` 非空则用它；否则 `join(modelDir, modelFile)`。`modelDir` 是相对仓库根解析的（也允许绝对路径，但必须由设置文件给出，客户端不可写）。

## AC

- [ ] AC1：新增 `server/modules/voice-realtime/voice-realtime-speaker-model.ts`：解析 `modelDir`/`modelFile`/`modelPath`，提供 `status()` 与 `download()`。`status` 返回 `missing|downloading|installed|invalid|failed`、解析路径、字节数、期望 sha256、来源 URL、许可；`installed` 必须实际重算 sha256 匹配。
- [ ] AC2：`download()` 使用固定 URL（不读请求体里的 URL/路径），HTTPS + 重定向跟随、超时（建议 120 s）、大小上限（建议 64 MiB）；写 `<path>.part`，边下边算 sha256，完成后校验再原子 rename；失败删除 `.part` 并记录可读原因；同一路径同时只有一个下载在飞，第二个请求加入/返回当前进度而不是再开一条。
- [ ] AC3：`GET /api/voice-realtime/speaker-model` 返回 AC1 的状态；`POST /api/voice-realtime/speaker-model/download` 启动或加入下载并返回 202/当前状态。两个路由挂在既有 `createVoiceRealtimeRouter` 下、沿用 `authenticateToken`；路由只解析/调用 service，不做文件 I/O。不新增“删除模型”路由（本任务不做）。
- [ ] AC4：`server/index.ts` 组装下载 service 与路由依赖；`modelDir` 从每连接设置读取（或从设置文件解析一次），客户端不能通过请求改变目标目录；路径必须落在解析后的 `modelDir`/`modelPath`，拒绝 `..` 越界。
- [ ] AC5：设置页 Live Voice tab 增加“声纹模型” section：显示状态（未安装/下载中/已安装/校验失败）、解析路径、来源与许可；提供“下载模型”按钮与进度（received/total/rate，复用现有下载进度样式）；错误显示 service 的可读原因；说明“下载完成后下一次 Live Voice 连接生效”。所有文案进 `settings` i18n 的全部 locale。
- [ ] AC6：`.gitignore` 增加 `/models/`（或精确到 `/models/speaker/`）；确认模型不被 git 跟踪；`npm pack --dry-run` 与 Electron `build.files` 白名单不含 `models/`；Docker 走 npm 安装，不包含该目录。若现有白名单已经排除，记录“无需改 package.json”的证据即可。
- [ ] AC7：测试：新增 `server/modules/voice-realtime/tests/voice-realtime-speaker-model.test.ts`（service 的 status/download/原子性/校验失败/并发；route 的 200/202/错误），并更新 `server/shared/tests/quay-test-script.test.ts` 的收集数 pin（当前全树 389，新增一个测试文件后按该测试自身口径重测，预计 390 / `unknown=387`/389；以实际重测为准）。客户端用例加进既有 `src/modules/settings/tests/voiceSettingsLiveTabMinimalSurface.test.tsx`，不新增客户端测试文件。
- [ ] AC8：真机验证：设置页点“下载模型” → `models/speaker/<file>` 出现、sha256 匹配、状态变 `installed`；`git status` 不显示该文件；下一次 shadow 会话日志出现 `CAM++ model loaded path=...` 与 `speaker_shadow` 行；无模型时状态为 `missing` 且不影响普通 Live Voice。

## DoD

- service/route 测试与客户端用例如上全绿；`npm run typecheck` exit 0。
- `quay-test-script.test.ts` 全绿，pin 已按 AC7 重测更新。
- 真机下载一次，sha256 与固定值一致；`npm pack --dry-run` 输出不含 `models/`；`git status` 不含模型文件。
- 设置页文案在全部 locale 完整（i18n 完整性测试绿）。
- 不提交模型二进制；不在客户端暴露任意下载 URL/路径。

## Touches

- server/modules/voice-realtime/voice-realtime-speaker-model.ts
- server/modules/voice-realtime/voice-realtime.routes.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/tests/voice-realtime-speaker-model.test.ts
- server/shared/tests/quay-test-script.test.ts
- server/index.ts
- config/voice-realtime.settings.example.json
- .gitignore
- src/modules/settings/tabs/VoiceSettingsTab.tsx
- src/modules/settings/hooks/useSpeakerModelStatus.ts
- src/modules/settings/tests/voiceSettingsLiveTabMinimalSurface.test.tsx
- src/shared/api.ts
- src/modules/i18n/locales/de/settings.json
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/es/settings.json
- src/modules/i18n/locales/fr/settings.json
- src/modules/i18n/locales/id/settings.json
- src/modules/i18n/locales/it/settings.json
- src/modules/i18n/locales/ja/settings.json
- src/modules/i18n/locales/ko/settings.json
- src/modules/i18n/locales/ru/settings.json
- src/modules/i18n/locales/tr/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- src/modules/i18n/locales/zh-TW/settings.json
- .env.example
- experiments/voice-tse-eval/PLAN.md
- tasks/voice-speaker-model-provisioning.md

## 参考

- `experiments/voice-tse-eval/thresholds.v1.json` — 模型名、sha256、样本率与阈值。
- `server/modules/voice/voice.service.ts` 的 client-assets 状态/校验模式（只读模型状态、sha256、下载前拒绝坏文件）。
- `src/modules/settings/tabs/VoiceSettingsTab.tsx` 的 on-device recogniser 下载进度样式（本任务复用它，不复用它的浏览器侧引擎）。
- `server/modules/voice-realtime/voice-realtime.routes.ts` — 既有 `authenticateToken` 挂载与“路由只解析/调 service”的形状。
