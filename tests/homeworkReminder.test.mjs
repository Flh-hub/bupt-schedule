/**
 * homeworkReminder.test.mjs — 作业截止提醒「什么时候响」的契约。
 *
 * 这块全是边界：没有截止时间、已经过期、前一天 20:00 已经过去、截止就在眼前。
 * 每一个判断错了，要么半夜吵醒人，要么静默漏掉一条作业。
 *
 * ★ 造日期一律用本地时区的 `new Date(y, m, d, h, mi)`，不要写 ISO 串 ——
 *   本机是 UTC+8，`new Date('2026-11-02T23:59:00')` 会被当成 UTC，差 8 小时。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  remindAtFor,
  prevDayAt,
  formatDue,
  getHomeworkReminders,
  DEFAULT_REMIND_HOUR,
  DEFAULT_LEAD_MS
} from '../src/homeworkReminder.js';

/** 本地时间构造（月份从 0 开始，与 Date 一致）。 */
const at = (y, m, d, h = 0, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s).getTime();

test('正常情况：截止前一天 20:00，而不是"截止减 24 小时"', () => {
  // 截止 11-02 23:59 → 提醒 11-01 20:00（不是 11-01 23:59 那个半夜点）
  const due = at(2026, 11, 2, 23, 59, 59);
  const now = at(2026, 10, 29, 10, 0);
  const t = remindAtFor(due, now);
  assert.equal(t, at(2026, 11, 1, 20, 0));
  assert.equal(new Date(t).getHours(), DEFAULT_REMIND_HOUR);
  // 距截止 27.98 小时，落在"前一天"
  assert.ok(due - t > 24 * 3600 * 1000);
});

test('截止在早上：前一天 20:00 仍然成立（距截止 12 小时）', () => {
  const due = at(2026, 11, 2, 8, 0);
  const now = at(2026, 10, 30, 9, 0);
  const t = remindAtFor(due, now);
  assert.equal(t, at(2026, 11, 1, 20, 0));
});

test('前一天 20:00 已经过了 → 退到截止前 1 小时，不漏提醒', () => {
  // 现在 11-01 21:00，作业 11-02 08:00 截止：前一天 20:00 已经过去
  const due = at(2026, 11, 2, 8, 0);
  const now = at(2026, 11, 1, 21, 0);
  const t = remindAtFor(due, now);
  assert.equal(t, at(2026, 11, 2, 7, 0));
  assert.equal(due - t, DEFAULT_LEAD_MS);
});

test('截止日就是今天、前一天已过 → 走截止前 1 小时', () => {
  const due = at(2026, 11, 2, 18, 0);
  const now = at(2026, 11, 2, 10, 0);
  const t = remindAtFor(due, now);
  assert.equal(t, at(2026, 11, 2, 17, 0));
});

test('无截止时间 / 脏数据 → 不排（绝不拿"今天"凑一个出来）', () => {
  const now = at(2026, 11, 1, 10, 0);
  assert.equal(remindAtFor(null, now), null);
  assert.equal(remindAtFor(undefined, now), null);
  assert.equal(remindAtFor('', now), null);
  assert.equal(remindAtFor(NaN, now), null);
  assert.equal(remindAtFor(0, now), null);
  assert.equal(remindAtFor(-1, now), null);
  assert.equal(remindAtFor('abc', now), null);
});

test('已过期的截止时间 → 不排', () => {
  const now = at(2026, 11, 2, 10, 0);
  assert.equal(remindAtFor(at(2026, 11, 1, 23, 59), now), null);
  assert.equal(remindAtFor(now, now), null); // 正好等于现在也算过期
});

test('截止就在 30 秒内 → 不排（排完立刻响，用户会当成 bug）', () => {
  const now = at(2026, 11, 2, 10, 0);
  assert.equal(remindAtFor(now + 10 * 1000, now), null);
  assert.equal(remindAtFor(now + 29 * 1000, now), null);
});

test('提前量可配置：leadMs 变化时 fallback 跟着变', () => {
  const due = at(2026, 11, 2, 8, 0);
  const now = at(2026, 11, 1, 22, 0);
  const t = remindAtFor(due, now, { leadMs: 30 * 60 * 1000 });
  assert.equal(t, at(2026, 11, 2, 7, 30));
});

test('提醒整点可配置；非法值退回默认 20:00，不抛错', () => {
  const due = at(2026, 11, 2, 23, 59);
  const now = at(2026, 10, 29, 10, 0);
  assert.equal(remindAtFor(due, now, { hour: 9 }), at(2026, 11, 1, 9, 0));
  assert.equal(remindAtFor(due, now, { hour: 99 }), at(2026, 11, 1, 20, 0));
  assert.equal(remindAtFor(due, now, { hour: -1 }), at(2026, 11, 1, 20, 0));
  assert.equal(remindAtFor(due, now, { hour: 8.5 }), at(2026, 11, 1, 20, 0));
});

test('跨月 / 跨年：前一天由 Date 自己算，不是减 86400000', () => {
  // 截止 2027-01-01 → 提醒 2026-12-31 20:00
  assert.equal(prevDayAt(at(2027, 1, 1, 9, 0), 20), at(2026, 12, 31, 20, 0));
  // 截止 2026-03-01 → 提醒 2026-02-28 20:00（2026 不是闰年）
  assert.equal(prevDayAt(at(2026, 3, 1, 9, 0), 20), at(2026, 2, 28, 20, 0));
});

test('formatDue：补零到「MM-DD HH:mm」', () => {
  assert.equal(formatDue(at(2026, 11, 2, 23, 59)), '11-02 23:59');
  assert.equal(formatDue(at(2026, 1, 5, 8, 0)), '01-05 08:00');
  assert.equal(formatDue(NaN), '');
});

/* ---------------------------------------------------------------- 列表级 */

const mkState = (items, cfg) => ({
  homework: { items },
  settings: { homeworkReminder: cfg === undefined ? { enabled: true } : cfg }
});

const item = (id, title, dueMs, courseName) => ({ id, title, dueMs, courseName });

test('getHomeworkReminders：只产出能排出时刻的条目，字段齐整', () => {
  const now = at(2026, 10, 29, 10, 0);
  const state = mkState([
    item('h1', '第三次作业', at(2026, 11, 2, 23, 59, 59), '高等数学（上）'),
    item('h2', '没有截止时间的作业', NaN, '大学物理'),
    item('h3', '昨天的作业', at(2026, 10, 28, 23, 59), '线性代数')
  ]);
  const out = getHomeworkReminders(state, now);

  assert.equal(out.length, 1, '只有 h1 能排');
  const p = out[0];
  assert.equal(p.kind, 'homework');
  assert.equal(p.hwId, 'h1');
  assert.equal(p.title, '第三次作业');
  assert.equal(p.courseName, '高等数学（上）');
  assert.equal(p.dueText, '11-02 23:59');
  assert.equal(p.triggerAt, at(2026, 11, 1, 20, 0));
  assert.match(p.key, /^hw:h1@/);
});

test('getHomeworkReminders：没有课程名也照常产出（界面/通知里省略那段）', () => {
  const now = at(2026, 10, 29, 10, 0);
  const out = getHomeworkReminders(mkState([item('h1', '读书笔记', at(2026, 11, 3, 23, 59))]), now);
  assert.equal(out.length, 1);
  assert.equal(out[0].courseName, '');
});

test('getHomeworkReminders：重复条目只留一条', () => {
  const now = at(2026, 10, 29, 10, 0);
  const due = at(2026, 11, 2, 23, 59);
  const out = getHomeworkReminders(mkState([item('h1', 'A', due), item('h1', 'A', due)]), now);
  assert.equal(out.length, 1);
});

test('getHomeworkReminders：按触发时刻升序（先到期的先提醒）', () => {
  const now = at(2026, 10, 29, 10, 0);
  const out = getHomeworkReminders(
    mkState([
      item('late', '晚的', at(2026, 11, 9, 23, 59)),
      item('soon', '早的', at(2026, 11, 2, 23, 59)),
      item('mid', '中的', at(2026, 11, 5, 23, 59))
    ]),
    now
  );
  assert.deepEqual(
    out.map((p) => p.hwId),
    ['soon', 'mid', 'late']
  );
});

test('开关关掉 → 一条都不排', () => {
  const now = at(2026, 10, 29, 10, 0);
  const state = mkState([item('h1', 'A', at(2026, 11, 2, 23, 59))], { enabled: false });
  assert.deepEqual(getHomeworkReminders(state, now), []);
});

test('设置缺失 / 结构损坏 → 用默认值，不抛错', () => {
  const now = at(2026, 10, 29, 10, 0);
  const due = at(2026, 11, 2, 23, 59);
  assert.equal(getHomeworkReminders({ homework: { items: [item('h', 'A', due)] } }, now).length, 1);
  assert.equal(getHomeworkReminders({}, now).length, 0);
  assert.equal(getHomeworkReminders(null, now).length, 0);
  assert.equal(
    getHomeworkReminders({ homework: { items: [null, 'x', 3, item('h', 'A', due)] }, settings: {} }, now)
      .length,
    1
  );
});

test('改过截止时间 → key 跟着变，旧提醒不会挡住新的', () => {
  const now = at(2026, 10, 29, 10, 0);
  const a = getHomeworkReminders(mkState([item('h1', 'A', at(2026, 11, 2, 23, 59))]), now)[0];
  const b = getHomeworkReminders(mkState([item('h1', 'A', at(2026, 11, 5, 23, 59))]), now)[0];
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.triggerAt, b.triggerAt);
});
