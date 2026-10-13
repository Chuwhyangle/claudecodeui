---
id: gap-service-worker-transient-failure-not-offline-page
title: Service Worker 不得把一次瞬时 fetch 失败替换成自造 Offline 页 / Response.error()
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**症状（2026-10-13 实测，人已确认元凶）**：页面长时间不更新、要反复刷新才看到进展。浏览器控制台留下：

```
The FetchEvent for "https://cloudcli.lrfz.com/session/aec453a1-…" resulted in a network error response:
the promise was resolved with an error response object.
SW registered: ServiceWorkerRegistration
```

**机制**：`public/sw.js` 的导航分支在 fetch 失败时用**自造页面**顶替：

```js
if (event.request.mode === 'navigate') {
  event.respondWith(fetch(event.request).catch(() => caches.match('/manifest.json').then(() =>
    new Response('<h1>Offline</h1><p>Please check your connection.</p>', …))));
}
```

其它分支则用 `Response.error()` 顶替。于是**源站一次瞬时不可达（例如服务重启掐断在途请求）被 SW 放大成"页面离线"**，而它本该由页面自身重试恢复。`/assets/` 是 cache-first，同类放大也会让旧资源被持续喂给页面。

排除过程：源站与隧道实测均健康（`http://localhost:3001/session/<id>` 200/1.6ms；`https://cloudcli.lrfz.com/session/<id>` 200/61ms），所以问题不在源站，而在 SW 的顶替行为。

## Plan

1. 导航分支不再用自造 HTML 覆盖失败——透传真实的网络失败（或仅在确证离线时兜底），让页面的重试逻辑接管。
2. `/assets/` 的 cache-first 保留，但补上失效依据，避免一次坏响应被长期固化。
3. 用失败注入验证：一次失败的导航请求不得被替换成自造页面。

## AC

- [x] AC1 `grep -n "Offline" public/sw.js` 不在导航失败路径上；失败时透传真实响应而不是自造 HTML。
- [x] AC2 新增夹具断言：一次失败的导航 fetch 不会被替换成自造 HTML（取假形态：恢复离线页兜底 ⇒ 红）。
- [x] AC3 `npm run lint` 退出 0。

## DoD

源站瞬时不可达不再让页面显示自造的 "Offline"，也不再把请求变成 `Response.error()`；页面靠自身重试恢复，不需要人手动刷新。

## Touches

- public/sw.js
- public/clear-cache.html
- server/modules/static-assets/tests/service-worker-transient-failure.test.ts (new)
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-service-worker-transient-failure-not-offline-page.md

## Evidence

- **先复现再归因**：两轮 suite 都红在 `server/shared/tests/quay-test-script.test.ts` 的 AC2/AC3。派单的 delta-relatedness 判为 RELATED，实测确属本任务：新增的 server 测试文件被 `scripts/test.sh` 收集，`known/unknown` **计数钉**（不是导入边）随之移动。复跑复现且算术逐位吻合，故按真因处理，不当环境抖动。
- **第一轮**：本任务新增 `server/modules/static-assets/tests/service-worker-transient-failure.test.ts` 使 collected 317→318，把两处钉 314/316 → 315/317，该文件 11/11 pass。
- **第二轮（本轮，合并后）**：develop 侧 `gap-voice-queue-row-lifecycle-completion-path` 同样新增了一个 server 夹具，并把**同一对**字面量也 314/316 → 315/317。两分支撞了同一个钉，merge 把重复的那次 +1 折叠掉，于是合并树 collected=319 而钉仍读作 318：AC2 实测 `known=3 unknown=316` 对钉 315、AC3 实测 `known=1 unknown=318` 对钉 317（9 pass / 2 fail，41626ms）。钉改到合并后的**并集** 316/318。
- 本轮复跑读数（worktree 内 `node --import tsx --test server/shared/tests/quay-test-script.test.ts`，合并 develop 之后再跑一次）：`tests 11 / pass 11 / fail 0`；同树 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules` 计得 319，与 316+known3 / 318+known1 两位吻合。
- 新增夹具 `server/modules/static-assets/tests/service-worker-transient-failure.test.ts` 4/4 pass，含取假形态读数：保留兜底的 worker 对同一失败导航会 resolve 出自造 `Offline` 页，故「透传 ⇒ reject」这一读数不是恒 reject 的空转 stub。
- `grep -n "Offline" public/sw.js` 无匹配（exit 1）；导航分支现为 `event.respondWith(fetch(event.request))`，其余分支 `Response.error()` 改为「有缓存喂缓存、无缓存 rethrow 真实网络错误」。
- `npm run lint` 退出 0（oxlint，仅既有 warning），本任务改动的两个文件均无告警。

## Notes

人已按「注销 SW + 清 Cache Storage」重置过并确认症状消失，故这是**已复现并已旁证**的缺陷。`clear-cache.html` 会顺带 `localStorage.clear()`，改它时要保留这个提示或改用更保守的清理。
