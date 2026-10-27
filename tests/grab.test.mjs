/**
 * tests/grab.test.mjs — 「填学号密码 → 后台抓取」这条任务的状态机规则。
 *
 * 抓取本身在原生侧跑，这里测的是**网页层怎么消化那一串事件**。
 * 三条铁律（进度单调、终态不可覆盖、事件必须属于本次任务）如果破了，
 * 用户看到的就是：进度条倒着走、点了取消还在转圈、上一次的结果把这一次顶掉。
 * 所以每一条都单独钉一个用例。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRAB_ERRORS,
  GRAB_STEPS,
  applyGrabEvent,
  createGrab,
  grabElapsedSec,
  grabErrorInfo,
  grabHeadline,
  grabIsRunning,
  grabIsSettled,
  grabIsStalled,
  grabStepList,
  isGrabErrorCode
} from '../src/grab.js';

const T0 = 1_700_000_000_000;

/** 便捷构造：从空任务开始按顺序吃一串事件。 */
function run(events, id = 'task-1') {
  return events.reduce((grab, ev, i) => applyGrabEvent(grab, ev, T0 + (i + 1) * 1000), createGrab(id, T0));
}

test('新建任务：从第一步开始，0% 且处于运行中', () => {
  const grab = createGrab('a', T0);
  assert.equal(grab.status, 'running');
  assert.equal(grab.step, 'connect');
  assert.equal(grab.percent, 0);
  assert.equal(grab.id, 'a');
  assert.ok(grabIsRunning(grab));
  assert.ok(!grabIsSettled(grab));
});

test('进度事件按原生给的百分比推进', () => {
  const grab = run([
    { type: 'progress', id: 'task-1', step: 'login', percent: 20, text: '正在登录…' }
  ]);
  assert.equal(grab.step, 'login');
  assert.equal(grab.percent, 20);
  assert.equal(grab.text, '正在登录…');
});

test('★ 进度只增不减：倒退的事件被夹住，不会让进度条往回走', () => {
  const grab = run([
    { type: 'progress', id: 'task-1', step: 'find', percent: 50 },
    { type: 'progress', id: 'task-1', step: 'connect', percent: 3 }
  ]);
  assert.equal(grab.percent, 50);
  assert.equal(grab.step, 'find', '步骤也不能倒退');
});

test('★ 进度不越过当前步骤的上限（不会出现「登录中 90%」）', () => {
  const grab = run([{ type: 'progress', id: 'task-1', step: 'login', percent: 99 }]);
  const login = GRAB_STEPS.find((s) => s.key === 'login');
  assert.equal(grab.percent, login.to);
});

test('没带 percent 的进度事件落到该步骤的起点，而不是停在 0', () => {
  const grab = run([{ type: 'progress', id: 'task-1', step: 'read' }]);
  const read = GRAB_STEPS.find((s) => s.key === 'read');
  assert.equal(grab.percent, read.from);
  assert.ok(grab.text.length > 0, '没给文案也要有兜底文案');
});

test('未知的 step 不会把状态带坏（保留当前步骤，只更新文字）', () => {
  const grab = run([
    { type: 'progress', id: 'task-1', step: 'find', percent: 40 },
    { type: 'progress', id: 'task-1', step: 'quantum', percent: 45, text: '处理中…' }
  ]);
  assert.equal(grab.step, 'find');
  assert.equal(grab.text, '处理中…');
});

test('★ 终态不可覆盖：失败之后迟到的进度、完成事件全部丢掉', () => {
  let grab = run([{ type: 'error', id: 'task-1', code: 'timeout' }]);
  assert.equal(grab.status, 'failed');
  const after = [
    { type: 'progress', id: 'task-1', step: 'read', percent: 80 },
    { type: 'done', id: 'task-1' }
  ].reduce((g, ev) => applyGrabEvent(g, ev, T0 + 9000), grab);
  assert.equal(after, grab, '同一个对象原样返回，说明事件被丢弃');
  assert.equal(after.status, 'failed');
  assert.equal(after.error, 'timeout');
});

test('★ 完成之后也拒绝被改成失败', () => {
  const done = run([{ type: 'done', id: 'task-1' }]);
  assert.equal(done.percent, 100);
  const after = applyGrabEvent(done, { type: 'error', id: 'task-1', code: 'timeout' }, T0 + 9999);
  assert.equal(after, done);
});

test('★ 事件 id 对不上就忽略（上一次抓取的残留不能污染这一次）', () => {
  const grab = createGrab('task-new', T0);
  const after = applyGrabEvent(grab, { type: 'error', id: 'task-old', code: 'bad_credentials' }, T0 + 100);
  assert.equal(after, grab);
  assert.equal(after.status, 'running');
});

test('事件没带 id 时按「属于当前任务」处理（原生老版本兼容）', () => {
  const grab = applyGrabEvent(createGrab('t', T0), { type: 'progress', step: 'login', percent: 12 }, T0 + 100);
  assert.equal(grab.percent, 12);
});

test('非法 / 空事件不改变状态', () => {
  const grab = createGrab('t', T0);
  assert.equal(applyGrabEvent(grab, null, T0), grab);
  assert.equal(applyGrabEvent(grab, 'oops', T0), grab);
  assert.equal(applyGrabEvent(grab, { type: 'unknown-type', id: 't' }, T0), grab);
  assert.equal(applyGrabEvent(null, { type: 'progress' }, T0), null);
});

test('未知失败码归一到 unknown，并且仍然有可展示的文案', () => {
  const grab = run([{ type: 'error', id: 'task-1', code: 'aliens' }]);
  assert.equal(grab.error, 'unknown');
  assert.equal(grabErrorInfo(grab.error).title, GRAB_ERRORS.unknown.title);
});

test('每个失败码都写清了原因与下一步，且 manual 明确', () => {
  for (const [code, info] of Object.entries(GRAB_ERRORS)) {
    assert.ok(info.title.length >= 2, `${code} 缺标题`);
    assert.ok(info.hint.length >= 10, `${code} 缺可操作的说明`);
    assert.equal(typeof info.manual, 'boolean', `${code} 的 manual 必须是布尔`);
    assert.ok(isGrabErrorCode(code));
  }
  // 内网不可达与验证码是两种最常见、也最需要"改手动"的情况
  assert.equal(GRAB_ERRORS.no_network.manual, true);
  assert.equal(GRAB_ERRORS.captcha.manual, true);
  // 用户自己取消不该再劝他去手动抓
  assert.equal(GRAB_ERRORS.cancelled.manual, false);
});

test('非法失败码不被 isGrabErrorCode 认成合法', () => {
  assert.equal(isGrabErrorCode('aliens'), false);
  assert.equal(isGrabErrorCode(null), false);
  assert.equal(isGrabErrorCode(undefined), false);
  assert.equal(isGrabErrorCode(42), false);
  assert.equal(isGrabErrorCode('toString'), false, '原型上的键不能算合法码');
  assert.equal(isGrabErrorCode('__proto__'), false);
});

test('看门狗：75 秒没结果判停滞，之前的正常等待不算', () => {
  const grab = createGrab('t', T0);
  assert.equal(grabIsStalled(grab, T0 + 30_000), false);
  assert.equal(grabIsStalled(grab, T0 + 74_000), false);
  assert.equal(grabIsStalled(grab, T0 + 76_000), true);
  // 已经结束的任务不叫"停滞"
  const failed = run([{ type: 'error', id: 'task-1', code: 'timeout' }]);
  assert.equal(grabIsStalled(failed, T0 + 999_999), false);
});

test('看门狗在没有时间信息时不乱判（不误杀）', () => {
  const grab = createGrab('t', 0);
  assert.equal(grabIsStalled(grab, 80_000), false);
});

test('已用秒数：运行中按 now 算，结束后冻结在结束时刻', () => {
  const grab = createGrab('t', T0);
  assert.equal(grabElapsedSec(grab, T0 + 12_400), 12);
  const done = run([{ type: 'done', id: 'task-1' }]); // 每步 +1s
  assert.equal(grabElapsedSec(done, T0 + 999_999), 1);
  assert.equal(grabElapsedSec(null, T0), 0);
});

test('步骤清单：走过的打勾、当前的进行中、后面的待办', () => {
  const grab = run([{ type: 'progress', id: 'task-1', step: 'find', percent: 40 }]);
  const list = grabStepList(grab);
  assert.equal(list.length, GRAB_STEPS.length);
  assert.deepEqual(
    list.map((s) => s.state),
    ['done', 'done', 'active', 'todo', 'todo']
  );
  assert.deepEqual(
    list.map((s) => s.key),
    GRAB_STEPS.map((s) => s.key)
  );
});

test('完成后所有步骤都算走完', () => {
  const done = run([{ type: 'done', id: 'task-1' }]);
  assert.ok(grabStepList(done).every((s) => s.state === 'done'));
});

test('标题文案：抓取中带秒数，结束写结论', () => {
  const running = createGrab('t', T0);
  assert.ok(grabHeadline(running, T0 + 5000).includes('秒'));
  const done = run([{ type: 'done', id: 'task-1' }]);
  assert.ok(grabHeadline(done, T0 + 9000).includes('抓取完成'));
  const failed = run([{ type: 'error', id: 'task-1', code: 'captcha' }]);
  assert.equal(grabHeadline(failed, T0 + 9000), GRAB_ERRORS.captcha.title);
});

test('cancel 之后原生再报 batch busy / 迟到结果都不会改状态', () => {
  const grab = run([
    { type: 'error', id: 'task-1', code: 'cancelled' },
    { type: 'progress', id: 'task-1', step: 'read', percent: 70 }
  ]);
  assert.equal(grab.status, 'failed');
  assert.equal(grab.error, 'cancelled');
  assert.equal(grab.percent, 0, '取消时进度不该被后来的事件推进');
});

test('getGrabTestHooks 不需要——状态机可以完全靠纯函数驱动', () => {
  // 这条用例存在只是为了说明：本模块没有隐藏状态，所有断言都可复现
  const a = run([{ type: 'progress', id: 'task-1', step: 'login', percent: 20 }]);
  const b = run([{ type: 'progress', id: 'task-1', step: 'login', percent: 20 }]);
  assert.deepEqual(a, b);
});
