/**
 * tests/toggle-switch.test.mjs — 开关（switch）的 DOM 契约。
 *
 * 这里的断言不是"好不好看"，而是**动效能不能工作**的前提：
 *  1. knob 必须是真实子元素 `.knob`。伪元素 `::after` 没法被 Web Animations API
 *     单独补间，而整页 innerHTML 重建后正是靠 WAAPI 把"旧位置→新位置"补出来的。
 *  2. 必须带 `data-switch-key` —— 跨渲染识别"这是同一个开关"的唯一线索，
 *     没有它就没法判断该不该补间。
 *  3. `--switch-travel` 在 CSS 里，JS 读它算位移；这里只钉住 HTML 侧。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { toggleSwitch } from '../src/ui/components.js';

test('开关输出真实 knob 元素（WAAPI 能单独补间的对象）', () => {
  const html = toggleSwitch(true, 'reminder-enabled', '应用内通知');
  assert.ok(html.includes('<span class="knob">'), '必须有 .knob 子元素');
  assert.ok(!html.includes('::after'), '不能再依赖伪元素画滑块');
});

test('开关带跨渲染识别用的 data-switch-key', () => {
  const html = toggleSwitch(true, 'reminder-sound', '提醒声音');
  assert.ok(html.includes('data-switch-key="reminder-sound"'));
  assert.ok(html.includes('data-action="reminder-sound"'));
});

test('开启态带 is-on 且 aria-checked 同步', () => {
  const on = toggleSwitch(true, 'a', 'x');
  assert.ok(on.includes('is-on'));
  assert.ok(on.includes('aria-checked="true"'));

  const off = toggleSwitch(false, 'a', 'x');
  assert.ok(!off.includes('is-on'), '关闭态不能残留 is-on');
  assert.ok(off.includes('aria-checked="false"'));
});

test('role=switch 与可读标签始终存在（动效不影响无障碍）', () => {
  const html = toggleSwitch(false, 'holiday-toggle', '节假日跳过提醒');
  assert.ok(html.includes('role="switch"'));
  assert.ok(html.includes('aria-label="节假日跳过提醒"'));
});

test('标签里的尖括号被转义（防注入）', () => {
  const html = toggleSwitch(true, 'x', '<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});
