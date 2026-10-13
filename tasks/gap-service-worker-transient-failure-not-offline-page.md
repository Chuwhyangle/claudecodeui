---
id: gap-service-worker-transient-failure-not-offline-page
title: Service Worker 不得把一次瞬时 fetch 失败替换成自造 Offline 页 / Response.error()
status: todo
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

- [ ] AC1 `grep -n "Offline" public/sw.js` 不在导航失败路径上；失败时透传真实响应而不是自造 HTML。
- [ ] AC2 新增夹具断言：一次失败的导航 fetch 不会被替换成自造 HTML（取假形态：恢复离线页兜底 ⇒ 红）。
- [ ] AC3 `npm run lint` 退出 0。

## DoD

源站瞬时不可达不再让页面显示自造的 "Offline"，也不再把请求变成 `Response.error()`；页面靠自身重试恢复，不需要人手动刷新。

## Touches

- public/sw.js
- public/clear-cache.html
- tasks/gap-service-worker-transient-failure-not-offline-page.md

## Notes

人已按「注销 SW + 清 Cache Storage」重置过并确认症状消失，故这是**已复现并已旁证**的缺陷。`clear-cache.html` 会顺带 `localStorage.clear()`，改它时要保留这个提示或改用更保守的清理。