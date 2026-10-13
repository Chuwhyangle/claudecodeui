---
id: gap-service-worker-transient-failure-not-offline-page
title: Service Worker 不得把一次瞬时 fetch 失败替换成自造 Offline 页 / Response.error()
status: ready
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

- **先复现再归因**：上一轮 suite 红在 `server/shared/tests/quay-test-script.test.ts` 的 AC2/AC3。派单的 delta-relatedness 判为 UNRELATED（一跳导入不相交），但那是**计数钉**而非导入边，实测确属本任务：本轮新增的 server 测试文件被 `scripts/test.sh` 收集，`known/unknown` 钉随之 +1。已按要求复跑核实——红复现且算术吻合（收集总数 317→318），故按真因处理，不当环境抖动。
- 修前读数（worktree 内 `node --import tsx --test`）：AC2 `known=3 unknown=315` 对钉 `unknown=314`、AC3 `known=1 unknown=317` 对钉 `unknown=316`，2 fail。把两处钉 +1（314→315、316→317）后该文件 11/11 pass。
- 新增夹具 `server/modules/static-assets/tests/service-worker-transient-failure.test.ts` 4/4 pass，含取假形态读数：保留兜底的 worker 对同一失败导航会 resolve 出自造 `Offline` 页，故「透传 ⇒ reject」这一读数不是恒 reject 的空转 stub。
- `grep -n "Offline" public/sw.js` 无匹配（exit 1）；导航分支现为 `event.respondWith(fetch(event.request))`，其余分支 `Response.error()` 改为「有缓存喂缓存、无缓存 rethrow 真实网络错误」。
- `npm run lint` 退出 0（oxlint），且本任务改动的两个文件均无告警。

## Notes

人已按「注销 SW + 清 Cache Storage」重置过并确认症状消失，故这是**已复现并已旁证**的缺陷。`clear-cache.html` 会顺带 `localStorage.clear()`，改它时要保留这个提示或改用更保守的清理。

## Blocker

**2026-10-13T03:44:07.852Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=40375 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1791863006420
- run_id：wk-prod-anchor
- session_id：81d24698-a93d-4638-a02b-edcec5df1210
