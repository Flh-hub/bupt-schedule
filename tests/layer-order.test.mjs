/**
 * layer-order.test.mjs — 浮层层级：提示条必须压在弹层之上。
 *
 * 【这个 bug 长什么样】
 * 「补课 / 活动」表单里点「添加活动」但名称没填，代码里明明调了红色 snackbar，
 * 用户却什么也看不到 —— 因为 `.snackbar-host` 的 z-index 是 60，而 `.sheet-host` 是 70：
 * 提示条被画在弹层遮罩**下面**，视觉上等于没弹。
 *
 * 所以这里把"谁压在谁上面"写成断言，以后谁把数字改回去就直接红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync('assets/css/app.css', 'utf8');

/** 取某个选择器规则块里的 z-index（只认同名规则的第一处）。 */
function zIndexOf(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const m = css.match(re);
  if (!m) return null;
  const z = m[2].match(/z-index:\s*(-?\d+)/);
  return z ? Number(z[1]) : null;
}

test('提示条（snackbar）必须高于所有浮层', () => {
  const snack = zIndexOf('.snackbar-host');
  const sheet = zIndexOf('.sheet-host');
  const dialog = zIndexOf('.dialog-host');
  const picker = zIndexOf('.picker-host');

  assert.ok(snack != null, '找不到 .snackbar-host 的 z-index');
  for (const [name, value] of [
    ['弹层 sheet-host', sheet],
    ['确认框 dialog-host', dialog],
    ['选择器 picker-host', picker]
  ]) {
    assert.ok(value != null, `找不到 ${name} 的 z-index`);
    assert.ok(
      snack > value,
      `提示条 z-index=${snack} 必须大于 ${name}=${value}，否则弹层一开提示就看不见`
    );
  }
});

test('提示条在弹层打开时要避让按钮行（不是只改层级）', () => {
  const src = fs.readFileSync('src/ui/components.js', 'utf8');
  const body = src.slice(src.indexOf('export function snackbar('), src.indexOf('export function sheet('));
  assert.match(body, /positionOverSheet\(host\)/, 'snackbar 必须在渲染前调用 positionOverSheet');
  assert.match(src, /function positionOverSheet\(host\)/, '缺少 positionOverSheet 实现');
  assert.match(src, /sheet-foot/, '避让要按弹层按钮行（.sheet-foot）实测位置算，不要写死像素');
  assert.match(src, /is-over-sheet/, '需要给宿主打标记，样式/测试都靠它');
});

test('提示条是红色危险样式，不是普通提示', () => {
  assert.match(css, /\.snackbar\.is-danger/, '缺少 .snackbar.is-danger 样式');
});

/* ------------------------------------------------------------ 弹层不该带着页面一起滚 */

const css2 = fs.readFileSync('assets/css/app.css', 'utf8');
const comp = fs.readFileSync('src/ui/components.js', 'utf8');
const mainSrc = fs.readFileSync('src/main.js', 'utf8');

/** 取某个选择器规则块的大括号内容。 */
function ruleBody(text, selector) {
  // 选择器可能带多个（`a, b {`），也可能有同前缀的别的类（`.sheet` vs `.sheet-inline-actions`），
  // 所以逐个候选往后找，命中「后面紧跟 { 或 ,」的那个才算。
  let from = 0;
  for (;;) {
    const at = text.indexOf(selector, from);
    if (at < 0) return '';
    const after = text.slice(at + selector.length, at + selector.length + 2);
    if (after === ' {' || after.startsWith(',')) {
      const open = text.indexOf('{', at);
      const end = text.indexOf('}', open);
      return end < 0 ? '' : text.slice(open + 1, end);
    }
    from = at + selector.length;
  }
}

// 注意：这里一律用「字面量包含」而不是正则 —— 断言的是固定的几行 CSS，不需要模式匹配。
test('浮层打开时锁住文档滚动（html.is-overlay-open）', () => {
  assert.ok(css2.includes('html.is-overlay-open'), '缺少滚动锁样式');
  assert.ok(ruleBody(css2, 'html.is-overlay-open').includes('overflow: hidden'), '滚动锁必须 overflow: hidden');
  assert.ok(comp.includes('function syncScrollLock()'), '缺少 syncScrollLock()');
  const calls = comp.match(/syncScrollLock\(\)/g) || [];
  assert.ok(calls.length >= 6, '弹层/选择器/确认框的开关都要调 syncScrollLock（当前 ' + calls.length + ' 处）');
});

test('滚动链不外溢：sheet-body 要 overscroll-behavior: contain', () => {
  assert.ok(
    ruleBody(css2, '.sheet-body').includes('overscroll-behavior: contain'),
    '表单滑到底会把滚动传给文档 → 课表跟着动'
  );
});

test('遮罩上拖动不滚页面（touch-action: none）', () => {
  assert.ok(ruleBody(css2, '.sheet-mask').includes('touch-action: none'));
});

test('弹层高度按容器百分比，不用 vh（键盘弹起时才不跳）', () => {
  const sheet = ruleBody(css2, '.sheet');
  assert.ok(sheet.includes('max-height: 88%'), '应使用 88% 而不是 88vh');
  // 注释里提到 88vh 是允许的，只否定"真的用了 88vh"这条声明
  assert.ok(!sheet.includes('max-height: 88vh'), '仍是 88vh：与键盘后的可视高度不同口径，会跳一下');
});

test('聚焦要等滑入动画结束，并且 preventScroll', () => {
  assert.ok(mainSrc.includes('function focusSheetField('), '缺少 focusSheetField');
  assert.ok(mainSrc.includes('preventScroll: true'), 'focus 必须带 preventScroll，否则浏览器会滚文档');
  assert.ok(
    !mainSrc.includes("getElementById('slot-title')?.focus(), 260"),
    '旧的 260ms 聚焦还在：动画 280ms 未结束就弹键盘，面板会被顶一下'
  );
});

test('程序化滚动也要挡住（键盘弹起时浏览器会滚文档）', () => {
  assert.ok(comp.includes('function scrollGuard()'), '缺少 scrollGuard()');
  assert.ok(comp.includes("addEventListener('scroll', scrollGuard"), '滚动守卫必须挂在 window 的 scroll 上');
  assert.ok(comp.includes('lockedScrollY'), '需要记住锁定时的滚动位置，才能滚回原位');
});

test('程序化滚动也要挡住（键盘弹起时浏览器会滚文档）', () => {
  assert.ok(comp.includes('function scrollGuard()'), '缺少 scrollGuard()');
  assert.ok(comp.includes("addEventListener('scroll', scrollGuard"), '滚动守卫必须挂在 window 的 scroll 上');
  assert.ok(comp.includes('lockedScrollY'), '需要记住锁定时的滚动位置，才能滚回原位');
});
