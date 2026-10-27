/**
 * route-scroll.test.mjs — 换页时的滚动落点。
 *
 * 规则：
 *   · 进入新页面（点课程 / 点 Tab / 二级页）→ 从**顶部**开始；
 *   · 返回（系统返回键、二级页的「返回」）→ 回到**原来的位置**。
 *
 * 【真机事故】课表滚到 420px 点进课程详情，详情页顶栏被顶到视口外面（top = -11px）。
 * 根因：`render()` 只替换 innerHTML，document 的滚动位置原样带过去，被新页高度钳制后停在 21px。
 *
 * 这类逻辑跑在 DOM 上，jsdom 量不了滚动（scrollTo 是空实现），
 * 所以这里钉的是"代码路径存在且顺序正确"，实际落点靠真机探针验证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync('src/main.js', 'utf8');

test('换页前先记住"离开时"的位置（必须在替换 innerHTML 之前）', () => {
  const memoAt = main.indexOf('routeScrollMemo.set(prevRouteKey, window.scrollY)');
  const firstRenderAt = Math.min(
    main.indexOf('TT.renderDetail(view'),
    main.indexOf('TT.renderTimetable(view'),
    main.indexOf('REM.renderReminder(view')
  );
  assert.ok(memoAt > 0, '缺少"离开时记录滚动位置"的代码');
  assert.ok(firstRenderAt > 0, '找不到页面渲染调用');
  assert.ok(memoAt < firstRenderAt, '记录必须发生在替换 DOM 之前，否则读到的是新页面的 scrollY');
});

test('只有历史回退才还原，其余一律归零', () => {
  assert.ok(main.includes('const cameFromHistory = routeFromHistory'), '缺少"这次是不是回退"的判断');
  assert.ok(
    main.includes('cameFromHistory && remembered != null ? remembered : 0'),
    '落点规则被改坏了：回退才用记忆值，其他情况必须是 0'
  );
  assert.ok(main.includes('function applyRouteScroll('), '缺少 applyRouteScroll');
});

test('popstate 负责标记"这是历史回退"', () => {
  const at = main.indexOf("addEventListener('popstate'");
  assert.ok(at > 0, '缺少 popstate 监听：系统返回键会走历史回退');
  const block = main.slice(at, at + 120);
  assert.ok(block.includes('routeFromHistory = true'), 'popstate 里要置位 routeFromHistory');
});

test('位置只在路由真的变化时才动，同页重绘不受影响', () => {
  const at = main.indexOf('if (routeChanged) {', main.indexOf('routeChanged && prevRouteKey') >= 0 ? 0 : 0);
  assert.ok(at > 0, '找不到换页分支');
  assert.ok(
    main.includes('if (routeChanged) {\n    const remembered'),
    '滚动落点必须包在 routeChanged 里：改个节次时间不该把人送回顶部'
  );
});
