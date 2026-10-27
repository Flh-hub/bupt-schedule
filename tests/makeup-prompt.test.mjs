/**
 * tests/makeup-prompt.test.mjs — 「假期临近 → 确认调休」与「某天放假」的纯逻辑落库规则。
 *
 * 弹层本身是 UI，由 .probe-makeup-prompt.mjs 端到端覆盖；
 * 这里只测：谁该被问、问了之后状态怎么变、"放假"是否真的让那天静音。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyState, weeksToText } from '../src/model.js';
import { createStore } from '../src/store.js';
import { classifyDay, resolveDay } from '../src/calendar.js';
import {
  findMakeupAlert,
  holidaySpans,
  listMakeupDays,
  relatedHolidaySpan
} from '../src/holidays.js';

const ALL = { start: 1, end: 20, type: 'all', extra: [] };

function makeState(extra = {}) {
  const state = emptyState();
  state.settings.semesterStartMonday = '2026-09-07';
  state.settings.totalWeeks = 20;
  state.courses = [
    { id: 'c1', name: '高等数学', teacher: null, color: null, note: null, credit: null,
      createdAt: '2026-01-01T00:00:00+08:00', updatedAt: '2026-01-01T00:00:00+08:00' }
  ];
  state.sessions = [
    {
      id: 's1', courseId: 'c1', dayOfWeek: 4, startPeriod: 1, endPeriod: 2,
      location: '教三-201', weeks: ALL, rawWeeksText: weeksToText(ALL),
      teacher: null, sourceRef: 'test'
    }
  ];
  Object.assign(state, extra);
  return state;
}

function storeWith(state) {
  const store = createStore({ storage: null });
  store.__setState(state);
  return store;
}

/* ------------------------------------------------ 假期区间与归属 */

test('holidaySpans：按「同名 + 连续」聚段，春节 9 天一段、清明 3 天一段', () => {
  const spans = holidaySpans([]);
  const spring = spans.find((s) => s.name === '春节');
  assert.deepEqual(
    { from: spring.from, to: spring.to, days: spring.days },
    { from: '2026-02-15', to: '2026-02-23', days: 9 }
  );
  const qingming = spans.find((s) => s.name === '清明节');
  assert.equal(qingming.days, 3);
  // 内置 8 段（含 2027 元旦预留）
  assert.equal(spans.length, 8);
});

test('relatedHolidaySpan：09-20 是国庆的补班日，不能因为离中秋更近就认成中秋', () => {
  const span = relatedHolidaySpan([], '2026-09-20', '国庆调休上班');
  assert.equal(span.name, '国庆节');
});

test('relatedHolidaySpan：认不出名字时退回「时间上最近的假期」', () => {
  const span = relatedHolidaySpan([], '2026-05-09', '自定义补班');
  assert.equal(span.name, '劳动节');
});

/* ------------------------------------------------ 谁该被问 */

test('findMakeupAlert：补班日 7 天内 → 提醒（09-13 → 09-20）', () => {
  const alert = findMakeupAlert([], '2026-09-13');
  assert.equal(alert.date, '2026-09-20');
  assert.equal(alert.daysUntil, 7);
  assert.equal(alert.span.name, '国庆节');
});

test('findMakeupAlert：假期 7 天内也算临近（09-24 → 10-10，而不是已过去的 09-20）', () => {
  const alert = findMakeupAlert([], '2026-09-24');
  assert.equal(alert.date, '2026-10-10');
  assert.ok(alert.daysUntil > 7, '补班日其实还很远，是假期把它带进来的');
});

test('findMakeupAlert：补班当天仍然提醒（0 天）', () => {
  assert.equal(findMakeupAlert([], '2026-10-10').date, '2026-10-10');
});

test('findMakeupAlert：补班日过去以后不再纠缠（10-11 → null）', () => {
  assert.equal(findMakeupAlert([], '2026-10-11'), null);
});

test('findMakeupAlert：两个调休都过去了的月份不打扰（12-01 → null）', () => {
  assert.equal(findMakeupAlert([], '2026-12-01'), null);
});

test('findMakeupAlert：已确认「按周X」或「不调休」的补班日不再问', () => {
  const byFollow = [{ date: '2026-09-20', name: '国庆调休上班', type: 'makeupWorkday', followDayOfWeek: 4 }];
  assert.equal(findMakeupAlert(byFollow, '2026-09-13'), null);

  const byNone = [{ date: '2026-09-20', name: '国庆调休上班', type: 'makeupWorkday', followDayOfWeek: 'none' }];
  assert.equal(findMakeupAlert(byNone, '2026-09-13'), null);
});

test('findMakeupAlert：用户新增的补班日同样会被问', () => {
  const custom = [
    { date: '2026-11-07', name: '校庆补班', type: 'makeupWorkday', followDayOfWeek: null }
  ];
  const alert = findMakeupAlert(custom, '2026-11-03', { windowDays: 7 });
  assert.equal(alert.date, '2026-11-07');
  assert.equal(alert.daysUntil, 4);
});

test('findMakeupAlert：「今天不再提醒」只压住当天，明天还会问', () => {
  const snoozed = { '2026-09-20': '2026-09-13' };
  assert.equal(findMakeupAlert([], '2026-09-13', { snoozed }), null);
  assert.equal(findMakeupAlert([], '2026-09-14', { snoozed }).date, '2026-09-20');
});

test('findMakeupAlert：窗口天数可调，0 天时只问当天', () => {
  assert.equal(findMakeupAlert([], '2026-09-13', { windowDays: 0 }), null);
  assert.equal(findMakeupAlert([], '2026-09-20', { windowDays: 0 }).date, '2026-09-20');
});

/* ------------------------------------------------ 点了之后状态怎么变 */

test('「不调休」= 写这一天为 none：当天静音，其它补班日照旧待确认', () => {
  const store = storeWith(makeState());
  const res = store.dispatch({
    type: 'SET_MAKEUP_FOLLOW',
    payload: { date: '2026-09-20', follow: 'none' }
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors));

  const day = classifyDay(store.getState(), '2026-09-20');
  assert.equal(day.status, 'makeup_skipped');
  assert.equal(resolveDay(store.getState(), '2026-09-20').classes.length, 0);

  const rest = listMakeupDays(store.getState().holidays).filter((h) => h.followDayOfWeek == null);
  assert.equal(rest.length, 4, '其余 4 条仍待确认（原本 5 条未确认）');
});

test('SNOOZE_MAKEUP_PROMPT：按日期记账，非法日期拒绝', () => {
  const store = storeWith(makeState());
  const res = store.dispatch({
    type: 'SNOOZE_MAKEUP_PROMPT',
    payload: { date: '2026-09-20', until: '2026-09-13' }
  });
  assert.equal(res.ok, true);
  assert.deepEqual(store.getState().settings.makeupPromptSnooze, { '2026-09-20': '2026-09-13' });

  const bad = store.dispatch({ type: 'SNOOZE_MAKEUP_PROMPT', payload: { date: '9/20', until: '2026-09-13' } });
  assert.equal(bad.ok, false);

  const badUntil = store.dispatch({ type: 'SNOOZE_MAKEUP_PROMPT', payload: { date: '2026-09-20', until: 'x' } });
  assert.equal(badUntil.ok, false);
});

test('「某天放假」：加一条自定义放假 → 当天 status=holiday_silent 且不排课', () => {
  const store = storeWith(makeState());
  const res = store.dispatch({
    type: 'UPSERT_HOLIDAY',
    payload: { holiday: { date: '2026-09-10', name: '校运动会', type: 'holiday' } }
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors));

  const day = classifyDay(store.getState(), '2026-09-10');
  assert.equal(day.status, 'holiday_silent');
  assert.equal(day.holidayName, '校运动会');
  assert.equal(resolveDay(store.getState(), '2026-09-10').classes.length, 0);

  // 只影响这一天：下一周同一门课照旧
  const nextWeek = resolveDay(store.getState(), '2026-09-17');
  assert.equal(nextWeek.classes.length, 1);
  assert.equal(nextWeek.classes[0].courseName, '高等数学');
});

test('「某天放假」可撤销：删除自定义记录后当天恢复上课', () => {
  const store = storeWith(makeState());
  store.dispatch({
    type: 'UPSERT_HOLIDAY',
    payload: { holiday: { date: '2026-09-10', name: '校运动会', type: 'holiday' } }
  });
  const del = store.dispatch({ type: 'DELETE_HOLIDAY', payload: { date: '2026-09-10' } });
  assert.equal(del.ok, true);

  const day = classifyDay(store.getState(), '2026-09-10');
  assert.equal(day.status, 'normal');
  assert.equal(resolveDay(store.getState(), '2026-09-10').classes.length, 1);
});

test('「某天放假」用 UPSERT 覆盖同一天：不会留下两条冲突记录', () => {
  const store = storeWith(makeState());
  store.dispatch({
    type: 'UPSERT_HOLIDAY',
    payload: { holiday: { date: '2026-09-10', name: '运动会', type: 'holiday' } }
  });
  store.dispatch({
    type: 'UPSERT_HOLIDAY',
    payload: { holiday: { date: '2026-09-10', name: '临时调整', type: 'holiday' } }
  });
  const same = store.getState().holidays.filter((h) => h.date === '2026-09-10');
  assert.equal(same.length, 1);
  assert.equal(classifyDay(store.getState(), '2026-09-10').holidayName, '临时调整');
});
