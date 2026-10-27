/**
 * tests/event-drag.test.mjs — 自定义活动（adjustment type = 'event'）与「拖动改时段」的落库规则。
 *
 * 拖动本身是 UI 手势，由 .probe-event-drag.mjs 端到端覆盖；
 * 这里只测「写进 store 的那几条记录」是不是合法的、投影对不对。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyState, validateState, weeksToText } from '../src/model.js';
import { createStore } from '../src/store.js';
import { detectConflicts, getReminders, resolveDay } from '../src/calendar.js';

const ALL = { start: 1, end: 20, type: 'all', extra: [] };

const COURSE = (id, name) => ({
  id,
  name,
  teacher: null,
  color: null,
  note: null,
  credit: null,
  createdAt: '2026-01-01T00:00:00+08:00',
  updatedAt: '2026-01-01T00:00:00+08:00'
});

const SESSION = (id, courseId, dayOfWeek, startPeriod, endPeriod, weeks) => ({
  id,
  courseId,
  dayOfWeek,
  startPeriod,
  endPeriod,
  location: '教三-201',
  weeks: weeks || ALL,
  rawWeeksText: weeksToText(weeks || ALL),
  teacher: null,
  sourceRef: 'test'
});

function makeState(extra = {}) {
  const state = emptyState();
  state.settings.semesterStartMonday = '2026-09-07'; // 周一
  state.settings.totalWeeks = 20;
  state.courses = [COURSE('c1', '高等数学'), COURSE('c2', '大学物理')];
  state.sessions = [
    SESSION('s1', 'c1', 4, 1, 2), // 周四 1-2 节
    SESSION('s2', 'c2', 4, 6, 7) // 周四 6-7 节
  ];
  Object.assign(state, extra);
  return state;
}

/** 2026-09-10 是第 1 周周四。 */
const THU = '2026-09-10';

function storeWith(state) {
  const store = createStore({ storage: null });
  store.__setState(state);
  return store;
}

/* ---------------------------------------------------------------- 活动 */

test('活动：加一条自定义活动 → 当天投影里多一节课，但不挂课程', () => {
  const store = storeWith(makeState());
  const res = store.dispatch({
    type: 'ADD_ADJUSTMENT',
    payload: { adjustment: { date: '2026-09-08', type: 'event', title: '班会', startPeriod: 5, endPeriod: 6, location: '教三-101' } }
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors));

  const day = resolveDay(store.getState(), '2026-09-08');
  const ev = day.classes.find((c) => c.isEvent);
  assert.ok(ev, '投影里应有活动');
  assert.equal(ev.courseName, '班会');
  assert.equal(ev.courseId, null);
  assert.equal(ev.eventId, res.adjustment.id);
  assert.equal(ev.adjustmentType, 'event');
  assert.equal(ev.location, '教三-101');
  assert.equal(ev.startTime, '13:30'); // 由第 5 节解析而来
  assert.equal(ev.endTime, '15:05');
});

test('活动：没有名称 / 没有节次一律拒绝', () => {
  const store = storeWith(makeState());
  const noTitle = store.dispatch({
    type: 'ADD_ADJUSTMENT',
    payload: { adjustment: { date: '2026-09-08', type: 'event', startPeriod: 1, endPeriod: 2 } }
  });
  assert.equal(noTitle.ok, false);

  const noPeriod = store.dispatch({
    type: 'ADD_ADJUSTMENT',
    payload: { adjustment: { date: '2026-09-08', type: 'event', title: '班会' } }
  });
  assert.equal(noPeriod.ok, false);

  const reversed = store.dispatch({
    type: 'ADD_ADJUSTMENT',
    payload: { adjustment: { date: '2026-09-08', type: 'event', title: '班会', startPeriod: 5, endPeriod: 4 } }
  });
  assert.equal(reversed.ok, false);
});

test('活动：只影响那一天，不污染同星期几的其它周', () => {
  const store = storeWith(makeState());
  store.dispatch({
    type: 'ADD_ADJUSTMENT',
    payload: { adjustment: { date: THU, type: 'event', title: '组会', startPeriod: 3, endPeriod: 4 } }
  });
  assert.equal(resolveDay(store.getState(), THU).classes.filter((c) => c.isEvent).length, 1);
  assert.equal(resolveDay(store.getState(), '2026-09-17').classes.filter((c) => c.isEvent).length, 0);
});

test('活动：和课程撞时段会标冲突（不能因为都"没有课程"就当同一门课）', () => {
  const store = storeWith(makeState());
  store.dispatch({
    type: 'ADD_ADJUSTMENT',
    payload: { adjustment: { date: THU, type: 'event', title: '组会', startPeriod: 1, endPeriod: 2 } }
  });
  const day = resolveDay(store.getState(), THU);
  const clash = day.classes.filter((c) => c.conflict);
  assert.equal(clash.length, 2, '课程和活动应当互相标记冲突');
});

test('活动：两条活动撞在一起也要各标一次冲突', () => {
  const classes = [
    { key: 'a', courseId: null, startPeriod: 1, endPeriod: 2, conflict: false, conflictWith: [] },
    { key: 'b', courseId: null, startPeriod: 2, endPeriod: 3, conflict: false, conflictWith: [] }
  ];
  detectConflicts(classes);
  assert.equal(classes[0].conflict, true);
  assert.equal(classes[1].conflict, true);
});

test('活动：validateState 认识这种记录，且缺字段会被点名', () => {
  const state = makeState();
  state.adjustments = [{ id: 'a1', date: THU, type: 'event', title: '班会', startPeriod: 1, endPeriod: 2 }];
  assert.equal(validateState(state).ok, true, JSON.stringify(validateState(state).errors));

  state.adjustments = [{ id: 'a2', date: THU, type: 'event', startPeriod: 1, endPeriod: 2 }];
  const bad = validateState(state);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('名称')));
});

/* ---------------------------------------------------------------- 拖动落库 */

test('拖动（同一天）：写一条 reschedule，其它周次不动', () => {
  const store = storeWith(makeState());
  const res = store.dispatch({
    type: 'ADD_ADJUSTMENT',
    payload: { adjustment: { date: THU, type: 'reschedule', targetSessionId: 's1', startPeriod: 3, endPeriod: 4 } }
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors));

  const thu = resolveDay(store.getState(), THU).classes.find((c) => c.sessionId === 's1');
  assert.equal(thu.startPeriod, 3);
  assert.equal(thu.endPeriod, 4);
  assert.equal(thu.original.startPeriod, 1);

  const nextThu = resolveDay(store.getState(), '2026-09-17').classes.find((c) => c.sessionId === 's1');
  assert.equal(nextThu.startPeriod, 1, '下一周必须还是原节次');
});

test('拖动（跨天）：停掉原日期 + 在目标日期补一节', () => {
  const store = storeWith(makeState());
  const cancel = store.dispatch({
    type: 'ADD_ADJUSTMENT',
    payload: { adjustment: { date: THU, type: 'cancel', targetSessionId: 's1' } }
  });
  const makeup = store.dispatch({
    type: 'ADD_ADJUSTMENT',
    payload: {
      adjustment: { date: '2026-09-11', type: 'makeup', courseId: 'c1', startPeriod: 3, endPeriod: 4, location: '教三-201' }
    }
  });
  assert.equal(cancel.ok, true, JSON.stringify(cancel.errors));
  assert.equal(makeup.ok, true, JSON.stringify(makeup.errors));

  assert.equal(resolveDay(store.getState(), THU).classes.filter((c) => c.sessionId === 's1').length, 0);
  const fri = resolveDay(store.getState(), '2026-09-11').classes;
  assert.equal(fri.length, 1);
  assert.equal(fri[0].courseId, 'c1');
  assert.equal(fri[0].startPeriod, 3);
});

test('UPDATE_ADJUSTMENT：只改位置字段，能改日期/节次并拒绝非法节次', () => {
  const store = storeWith(makeState());
  const added = store.dispatch({
    type: 'ADD_ADJUSTMENT',
    payload: { adjustment: { date: THU, type: 'event', title: '班会', startPeriod: 1, endPeriod: 2 } }
  });
  const id = added.adjustment.id;

  const moved = store.dispatch({
    type: 'UPDATE_ADJUSTMENT',
    payload: { id, patch: { date: '2026-09-11', startPeriod: 5, endPeriod: 6, location: '线上' } }
  });
  assert.equal(moved.ok, true, JSON.stringify(moved.errors));

  const adj = store.getState().adjustments.find((a) => a.id === id);
  assert.equal(adj.date, '2026-09-11');
  assert.equal(adj.startPeriod, 5);
  assert.equal(adj.endPeriod, 6);
  assert.equal(adj.location, '线上');
  assert.equal(adj.title, '班会', '标题不该被顺手清掉');

  const bad = store.dispatch({ type: 'UPDATE_ADJUSTMENT', payload: { id, patch: { startPeriod: 9 } } });
  assert.equal(bad.ok, false, '结束节次 6 < 起始 9，应拒绝');

  const missing = store.dispatch({ type: 'UPDATE_ADJUSTMENT', payload: { id: 'nope', patch: { startPeriod: 1 } } });
  assert.equal(missing.ok, false);
});

test('UPDATE_ADJUSTMENT：活动的标题可以被改，但不能改成空', () => {
  const store = storeWith(makeState());
  const added = store.dispatch({
    type: 'ADD_ADJUSTMENT',
    payload: { adjustment: { date: THU, type: 'event', title: '班会', startPeriod: 1, endPeriod: 2 } }
  });
  const id = added.adjustment.id;

  assert.equal(store.dispatch({ type: 'UPDATE_ADJUSTMENT', payload: { id, patch: { title: '  新生班会 ' } } }).ok, true);
  assert.equal(store.getState().adjustments.find((a) => a.id === id).title, '新生班会');
  assert.equal(store.dispatch({ type: 'UPDATE_ADJUSTMENT', payload: { id, patch: { title: '   ' } } }).ok, false);
});

test('活动也能进提醒队列（标题用「即将开始」而不是「即将上课」）', () => {
  const state = makeState();
  state.adjustments = [
    { id: 'a1', date: '2026-09-08', type: 'event', title: '面试', startPeriod: 5, endPeriod: 5, location: '线上' },
    { id: 'a2', date: '2026-09-08', type: 'event', title: '组会', startPeriod: 5, endPeriod: 5, location: '线上' }
  ];
  const store = storeWith(state);

  // 投影：时间由节次解析出来
  const ev = resolveDay(store.getState(), '2026-09-08').classes.find((c) => c.isEvent);
  assert.ok(ev && ev.startTime === '13:30');

  const points = getReminders(store.getState(), '2026-09-08', '2026-09-08').points;
  const mine = points.filter((p) => p.courseName === '面试' || p.courseName === '组会');
  assert.equal(mine.length, 2, '同日同时段的两条活动不能被当成同一条去重');
  for (const p of mine) assert.equal(p.title, '即将开始');
});
