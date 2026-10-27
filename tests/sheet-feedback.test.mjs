/**
 * sheet-feedback.test.mjs — 表单提交被拦下时的反馈动画。
 *
 * 【真机事故（2026-10-26）】用户录屏：每次点「添加活动」（名称没填）整块弹层会闪一下。
 * 逐帧分析发现弹层所在区域亮度从 244 掉到 166 —— 面板整体变透明又回来。
 * 根因：失败分支给 `<form class="sheet">`（就是面板本身）重放了 `.fade-in`，
 * 而 `.fade-in` 的 keyframes 是 `opacity: 0 → 1` + `translateY(4px)`。
 *
 * 现在改成 `.sheet.is-nope`：只做水平抖动，**动画里不允许出现 opacity**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const comp = fs.readFileSync('src/ui/components.js', 'utf8');
const css = fs.readFileSync('assets/css/app.css', 'utf8');

test('提交失败不再给整块面板加透明动画', () => {
  assert.ok(!comp.includes("classList.add('fade-in')"), '还在用 .fade-in：那是 opacity 0→1，整块面板会闪');
  assert.ok(!comp.includes("classList.remove('fade-in')"), '还在用 .fade-in');
  assert.ok(comp.includes("classList.add('is-nope')"), '应改为抖动反馈 .is-nope');
});

test('抖动的 keyframes 里不能有 opacity / 位移 Y', () => {
  const at = css.indexOf('@keyframes sheet-nope');
  assert.ok(at > 0, '缺少 sheet-nope 动画');
  const body = css.slice(at, css.indexOf('@media', at));
  assert.ok(!body.includes('opacity'), '抖动动画里出现 opacity 就会闪');
  assert.ok(!body.includes('translateY'), '抖动不要带纵向位移（会看着像面板跳了一下）');
  assert.ok(body.includes('translateX'), '应当是水平方向的小幅抖动');
});

test('reduced-motion 下不抖', () => {
  assert.ok(css.includes('prefers-reduced-motion'), '缺少无障碍兜底');
  const idx = css.indexOf('prefers-reduced-motion', css.indexOf('@keyframes sheet-nope'));
  const block = css.slice(idx, idx + 200);
  assert.ok(block.includes('.sheet.is-nope'), 'reduced-motion 下要关掉抖动');
});
