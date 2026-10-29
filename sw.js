/**
 * 北邮课程表 · Service Worker
 *
 * 职责严格限定为三件事（见 docs/ARCHITECTURE.md §0.1 修正 1）：
 *   1. 缓存应用壳（install 预缓存 → activate 清旧版 → fetch 同源 GET cache-first）
 *   2. 接收页面下发的 showNotification（**本文件内不存放任何定时器**：
 *      SW 约 30s 空闲即被浏览器终止，setTimeout 靠不住；定时器留在页面 src/reminder.js）
 *   3. notificationclick 回跳 / push 预留
 */

const CACHE = 'bupt-v92';

/** 预缓存清单：应用壳全部本地文件（云端 SDK 走 CDN，不在壳里）。 */
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/app.css',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './src/main.js',
  './src/homework.js',
  './src/model.js',
  './src/holidays.js',
  './src/semesters.js',
  './src/diff.js',
  './src/permissions.js',
  './src/keepalive.js',
  './src/calendar.js',
  './src/reminder.js',
  './src/store.js',
  './src/native.js',
  './src/semester.js',
  './src/grab.js',
  './src/widget.js',
  './src/parsers/index.js',
  './src/parsers/html.js',
  './src/parsers/json.js',
  './src/ui/components.js',
  './src/ui/timetable.js',
  './src/ui/dragdrop.js',
  './src/ui/makeupPrompt.js',
  './src/ui/import.js',
  './src/ui/reminderView.js',
  './src/ui/homework.js',
  './src/ui/onboard.js',
  './src/ui/notifyGuide.js',
  './src/ui/batteryMode.js',
  './src/ui/returnCheck.js',
  './src/ui/settings.js',
  './src/ui/privacy.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 逐条 add：某个文件缺失不至于整体 install 失败（离线壳仍可部分工作）
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 只接管同源请求
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) {
        // 后台静默更新，不阻塞本次响应
        fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
          })
          .catch(() => undefined);
        return cached;
      }
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        if (req.mode === 'navigate') {
          const shell = await cache.match('./index.html', { ignoreSearch: true });
          if (shell) return shell;
        }
        return new Response('离线且未缓存该资源', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })()
  );
});

/** 点击通知：优先聚焦已打开的窗口并跳到对应 hash 路由，否则新开。 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = (event.notification.data && event.notification.data.url) || './index.html';
  const target = new URL(rawUrl, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      });
      for (const client of clientList) {
        if (client.url && new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if (typeof client.navigate === 'function') {
            try {
              await client.navigate(target);
            } catch (err) {
              /* 部分内核不允许 navigate，忽略即可 */
            }
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});

/**
 * push 预留：当前无后端，仅接好管线。
 * 将来若接入推送服务，payload 形状与 ReminderPoint 对齐即可复用同一条渲染路径。
 */
self.addEventListener('push', (event) => {
  let payload = { title: '即将上课', body: '你有一节课即将开始' };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch (err) {
    /* 非 JSON payload，用默认文案 */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: './assets/icons/icon-192.png',
      badge: './assets/icons/icon-192.png',
      tag: payload.tag || 'bupt-push',
      data: { url: payload.url || './index.html#/timetable' }
    })
  );
});

/** 允许页面在需要时立即接管（`registration.update()` 之后）。 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
