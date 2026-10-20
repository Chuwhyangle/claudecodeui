---
id: gap-voice-announce-phrases-settings-key
title: announce 短语可配置化：落进 voice-realtime.settings.json 的 announcePhrases 键（默认改 2
  字以上），不开新 env；settings 文件补模板/本地分离
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

「voice-realtime 部署旋钮从 env 收敛到设置文件」的第一步、也是示范键：把 announce 短语从硬编码表收进 `voice-realtime.settings.json` 的 `announcePhrases` 键，默认表同时从 1–2 字提到 2 字以上，**不再为它开新 env**。settings 文件补齐「模板跟踪 + 本地忽略」的纪律。

现状（已核对）：
- announce 短语硬编码在 `voice-realtime-announce-phrases.ts`：`ANNOUNCE_PHRASES = ['哦。','嗯。','好。','收到。']`，proxy（`voice-realtime-ws-proxy.service.ts:5985`）直接 `pickAnnouncePhrase(seq)`，cache warm（`server/index.ts:763`）直接 `phrases: ANNOUNCE_PHRASES`。
- 现有两个测试是表无关的（用 `ANNOUNCE_PHRASES.includes` / `pickAnnouncePhrase`，不钉「哦/嗯/好/收到」字面量），改表内容不红。
- settings 文件（`voice-realtime-settings.ts`）已有 `version`/`instructions`/`contextTemplate`/`turnDetection`/`omissionFill` 五个键，其中 `turnDetection` 就是「部署旋钮进设置文件」的既有先例（`gap-live-voice-turn-detection-silence-in-settings-file-default-800`），优先级 env > 文件 > 默认。
- `VOICE_REALTIME_RUN_END_ACK` 是「`|` 分隔候选 → 纯函数拆分 → 穿进 wiring」的既有范式，announce 短语照抄它的拆分，但不走 env、只有「文件覆盖默认表」一层。

改法（四件）：

1. `voice-realtime-announce-phrases.ts`：默认表改为 2 字以上（如 `好的|收到|明白|在办`）；新增 `resolveAnnouncePhrases(raw)` 纯函数——`|` 分隔、trim、去空，非法（<3 条、某条空或超 15 字）回退默认并给出问题列表。
2. `voice-realtime-settings.ts`：加 `announcePhrases` 键（字符串），校验走 `resolveAnnouncePhrases`，拒绝则回退默认并进 `problems`（沿用「形状错整份拒绝、I/O 失败用默认」的既有规则）。
3. proxy 与 cache warm 同源：announce 门和 `server/index.ts:763` 的 cache 短语集都读 settings 解析出的同一张表，不再各自引用硬编码 `ANNOUNCE_PHRASES`。
4. 模板/本地分离：新增 `config/voice-realtime.settings.example.json`（git 跟踪，含 `announcePhrases` 默认值注释）；本地 `voice-realtime.settings.json` 进 `.gitignore`。

<!-- dedup-ref --> 与 `gap-narrator-announce-phrase-cache`（已 done，把 announce 从模型措辞换成固定表）、`gap-voice-realtime-context-pack-and-hot-settings`（已 done，建 settings 文件）、`gap-live-voice-turn-detection-silence-in-settings-file-default-800`（已 done，turnDetection 进 settings 文件）的关系：本条是同一收敛机制在 announce 短语上的下一个实例，独立交付。其余 ~14 个部署旋钮（TTS/summaryModel/closingTurn/silenceTail/uplinkVad…）的收敛是后续逐条任务，不在本条。

## AC

- [x] `npx vitest run server/modules/voice-realtime/tests/voice-realtime-announce-phrases.test.ts` 退出 0，且新增 `resolveAnnouncePhrases` 用例：`|` 分隔正确拆分、trim、去空；<3 条回退默认、某条空或超 15 字回退默认；默认表每条长度 ≥2。
- [x] `npx vitest run server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts` 退出 0，且新增 `announcePhrases` 键用例：文件覆盖默认表、非法值回退默认并进 `problems`。
- [x] 同源判据：`server/index.ts` 与 `voice-realtime-ws-proxy.service.ts` 的 announce 门都不再直接 import/引用硬编码 `ANNOUNCE_PHRASES`（`grep -n "ANNOUNCE_PHRASES" server/index.ts server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 无命中，装配点与 proxy 都读 settings 解析结果）。
- [x] 模板/本地分离：`config/voice-realtime.settings.example.json` 存在且被 git 跟踪（`git ls-files` 命中）；`.gitignore` 含 `voice-realtime.settings.json`（或等价本地路径条目）。
- [x] `npm run typecheck` 退出 0；`npm run build:server` 退出 0。

**AC1/AC2 字面命令的偏差（记录读数，勿误读为用例失败）**：本仓库 `vitest.config.ts` 的 `include` 只有 `src/**/*.test.ts(x)`，把 `server/` 路径交给 `npx vitest run` 会打印 `No test files found` 并退出 1。服务端测试的规范 runner 是 `node:test`（`package.json` 的 `test:server`），实测：
- `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-announce-phrases.test.ts` → 7/7 通过（含新增的 `resolveAnnouncePhrases` 4 组用例与 settings 覆盖的 proxy 端到端用例）。
- `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts` → 13/13 通过（含 `announcePhrases` 文件覆盖、缺省保持默认、非法值回退并进 `problems` 三组用例）。
- 兄弟用例 `voice-realtime-tts-cache.test.ts`（9/9）与 `voice-realtime-announce-narrator.test.ts`（2/2）同 runner 全绿，默认表内容变化未红。

## DoD

`voice-realtime.settings.json` 的 `announcePhrases` 键真实生效：改文件后下一连接 speak 的短语来自文件、默认（无文件）为 2 字以上新表，proxy 与 cache warm 用同一张表（单测 + 上面的 grep 同源判据钉住）；模板文件跟踪、本地文件忽略。不在本任务的：其余部署旋钮收敛、真实 DashScope 出声（H1 人工验收门）。

## Touches

- server/modules/voice-realtime/voice-realtime-announce-phrases.ts
- server/modules/voice-realtime/voice-realtime-settings.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/index.ts
- server/index.ts
- config/voice-realtime.settings.example.json
- .gitignore
- server/modules/voice-realtime/tests/voice-realtime-announce-phrases.test.ts
- server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts
- tasks/gap-voice-announce-phrases-settings-key.md
