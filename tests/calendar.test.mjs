import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyState,
  expandWeeks,
  parseWeeksText,
  todayStr,
  weeksToText,
  weekNoOf
} from '../src/model.js';
import {
  NOTICE,
  STATUS_VALUES,
  classifyDay,
  describeDate,
  getNextClass,
  getNowMarker,
  getPeriods,
  getReminders,
  getWeekView,
  resolveClasses,
  resolveCourseDates,
  resolveDay,
  resolveRange
} from '../src/calendar.js';
import { listMakeupDays } from '../src/holidays.js';
import { createStore } from '../src/store.js';

/* ---------------------------------------------------------------- fixtures */

const COURSE = (id, name, teacher) => ({
  id,
  name,
  teacher: teacher || null,
  color: null,
  note: null,
  credit: null,
  createdAt: '2026-01-01T00:00:00+08:00',
  updatedAt: '2026-01-01T00:00:00+08:00'
});

const ALL = { start: 1, end: 20, type: 'all', extra: [] };

const SESSION = (id, courseId, dayOfWeek, startPeriod, endPeriod, weeks, location) => ({
  id,
  courseId,
  dayOfWeek,
  startPeriod,
  endPeriod,
  location: location || '教三-201',
  weeks: weeks || ALL,
  rawWeeksText: weeksToText(weeks || ALL),
  teacher: null,
  sourceRef: 'test'
});

/**
 * 通用 fixture。
 * @param {{start?:string, totalWeeks?:number, sessions?:Array, settings?:object, courses?:Array}} [opts]
 */
function makeState(opts = {}) {
  const state = emptyState();
  state.settings.semesterStartMonday = opts.start === undefined ? '2026-02-23' : opts.start;
  state.settings.totalWeeks = opts.totalWeeks === undefined ? 20 : opts.totalWeeks;
  state.courses = opts.courses || [
    COURSE('c1', '高等数学(上)', '王老师'),
    COURSE('c2', '大学物理', '李老师'),
    COURSE('c3', '数据结构', '赵老师')
  ];
  state.sessions =
    opts.sessions ||
    [
      SESSION('s1', 'c1', 1, 1, 2, { start: 1, end: 16, type: 'all', extra: [] }),
      SESSION('s2', 'c2', 4, 3, 4, { start: 1, end: 16, type: 'all', extra: [] }),
      SESSION('s3', 'c1', 4, 6, 7, { start: 1, end: 20, type: 'all', extra: [] })
    ];
  if (opts.settings) Object.assign(state.settings, opts.settings);
  return state;
}

/** 秋季学期：2026-09-07（周一）开学，用于国庆/补班三态（10-10 是第 5 周、09-20 第 2 周、10-01 第 4 周）。 */
function autumnState(extra = {}) {
  return makeState({
    start: '2026-09-07',
    totalWeeks: 20,
    // 周四 1-2 节、周五 5-6 节、周日 1-2 节，覆盖三种补班映射
    sessions: [
      SESSION('t1', 'c1', 4, 1, 2),
      SESSION('t2', 'c3', 5, 5, 6),
      SESSION('t3', 'c2', 7, 1, 2)
    ],
    ...extra
  });
}

/** 上一学期：2025-09-01（周一）开学，2026-01-04 是第 18 周（推定按周五）。 */
function lastTermState(extra = {}) {
  return makeState({
    start: '2025-09-01',
    totalWeeks: 20,
    sessions: [
      SESSION('t1', 'c1', 4, 1, 2), // 周四
      SESSION('t2', 'c3', 5, 5, 6), // 周五（推定补班要取它）
      SESSION('t3', 'c2', 7, 1, 2) // 周日
    ],
    ...extra
  });
}

const day = (state, date) => resolveDay(state, date);

/* ---------------------------------------------------------------- 1. 周次 */

test('1. weekNoOf：开学周一为第 1 周，+7 天为第 2 周', () => {
  assert.equal(weekNoOf('2026-02-23', '2026-02-23'), 1);
  assert.equal(weekNoOf('2026-03-02', '2026-02-23'), 2);
  assert.equal(weekNoOf('2026-03-05', '2026-02-23'), 2);
});

test('2. 学期前 → out_of_semester，notice=本学期尚未开始，classes 为空', () => {
  const state = makeState();
  assert.equal(weekNoOf('2026-02-16', '2026-02-23'), 0);
  const d = day(state, '2026-02-16');
  assert.deepEqual(d.classes, []);
  assert.equal(d.status, 'out_of_semester');
  assert.equal(d.notice, '本学期尚未开始');
  assert.equal(d.complete, true);
});

test('3. 单周 {type:odd}：第 3 周命中、第 4 周不命中', () => {
  const state = makeState({
    sessions: [SESSION('o1', 'c2', 4, 3, 4, { start: 1, end: 16, type: 'odd', extra: [] })]
  });
  assert.equal(day(state, '2026-03-12').classes.length, 1); // 第 3 周周四
  assert.equal(day(state, '2026-03-19').classes.length, 0); // 第 4 周周四
});

test('4. 离散周次 {5-9 + extra[1,3]}：1/3/5/9 命中，2 不命中', () => {
  const state = makeState({
    sessions: [SESSION('d1', 'c2', 4, 5, 6, { start: 5, end: 9, type: 'all', extra: [1, 3] })]
  });
  for (const date of ['2026-02-26', '2026-03-12', '2026-03-26', '2026-04-23']) {
    assert.equal(day(state, date).classes.length, 1, `${date} 应命中`);
  }
  assert.equal(day(state, '2026-03-05').classes.length, 0);
  assert.deepEqual(expandWeeks({ start: 5, end: 9, type: 'all', extra: [1, 3] }), [1, 3, 5, 6, 7, 8, 9]);
});

/* ---------------------------------------------------------------- 5-13 假日与补班三态 */

test('5. 国庆 2026-10-01 → holiday_silent / classes 空 / complete=true', () => {
  const state = autumnState();
  const d = day(state, '2026-10-01');
  assert.equal(d.status, 'holiday_silent');
  assert.equal(d.classes.length, 0);
  assert.equal(d.complete, true);
  assert.equal(d.holidayName, '国庆节');
  assert.equal(d.notice, '国庆节 · 今日无课');
});

test('6. 补班日未确认（2026-10-10 周六）→ makeup_unconfirmed，effectiveDayOfWeek 为 null', () => {
  const state = autumnState();
  assert.equal(weekNoOf('2026-10-10', '2026-09-07'), 5);
  const d = day(state, '2026-10-10');
  assert.equal(d.status, 'makeup_unconfirmed');
  assert.equal(d.complete, false);
  assert.deepEqual(d.classes, []);
  assert.equal(d.effectiveDayOfWeek, null, '★ 不得用真实星期 6 兜底');
  assert.equal(d.followDayOfWeek, null);
  assert.match(d.notice, /请确认/);
});

test('7. 周日补班未确认（2026-09-20）→ 同样 makeup_unconfirmed', () => {
  const state = autumnState();
  assert.equal(weekNoOf('2026-09-20', '2026-09-07'), 2);
  const d = day(state, '2026-09-20');
  assert.equal(d.status, 'makeup_unconfirmed');
  assert.equal(d.complete, false);
  assert.equal(d.effectiveDayOfWeek, null);
  assert.match(d.notice, /（周日）/);
});

test('8. 推定值：2026-01-04（上一学期第 18 周）→ makeup_follow，按周五课表', () => {
  const state = lastTermState();
  assert.equal(weekNoOf('2026-01-04', '2025-09-01'), 18);
  const d = day(state, '2026-01-04');
  assert.equal(d.status, 'makeup_follow');
  assert.equal(d.effectiveDayOfWeek, 5);
  assert.equal(d.complete, true);
  assert.equal(d.classes.length, 1);
  assert.equal(d.classes[0].courseId, 'c3', '应返回周五的数据结构');
  assert.match(d.notice, /按周五/);
});

test('9. 确认 2026-09-20 按周四 → makeup_follow 并返回周四课程', () => {
  const state = autumnState();
  const store = createStore({ storage: null });
  store.__setState(state);
  const res = store.dispatch({
    type: 'SET_MAKEUP_FOLLOW',
    payload: { date: '2026-09-20', follow: 4 }
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const d = day(store.getState(), '2026-09-20');
  assert.equal(d.status, 'makeup_follow');
  assert.equal(d.effectiveDayOfWeek, 4);
  assert.equal(d.classes.length, 1);
  assert.equal(d.classes[0].courseId, 'c1');
});

test("10. 显式 'none' → makeup_skipped / complete=true / 允许说无课", () => {
  const state = autumnState();
  const store = createStore({ storage: null });
  store.__setState(state);
  store.dispatch({ type: 'SET_MAKEUP_FOLLOW', payload: { date: '2026-10-10', follow: 'none' } });
  const d = day(store.getState(), '2026-10-10');
  assert.equal(d.status, 'makeup_skipped');
  assert.equal(d.classes.length, 0);
  assert.equal(d.complete, true);
  assert.equal(d.effectiveDayOfWeek, null);
  assert.match(d.notice, /今日无课/);
});

test('10b. 批量确认：逐日写 none，pendingDates 清空，且不存在全局静默字段', () => {
  const state = autumnState();
  const store = createStore({ storage: null });
  store.__setState(state);
  const before = listMakeupDays(store.getState().holidays).filter((h) => h.followDayOfWeek == null);
  assert.equal(before.length, 5);

  const res = store.dispatch({ type: 'SET_MAKEUP_FOLLOW_BULK', payload: { none: true } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));

  const after = listMakeupDays(store.getState().holidays);
  assert.equal(after.filter((h) => h.followDayOfWeek == null).length, 0);
  // 01-04 的推定值保留，其余 5 条逐日写成 'none'
  assert.equal(after.find((h) => h.date === '2026-01-04').followDayOfWeek, 5);
  for (const date of ['2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']) {
    const entry = store.getState().holidays.find((h) => h.date === date);
    assert.ok(entry, `${date} 应有独立的用户记录`);
    assert.equal(entry.followDayOfWeek, 'none');
  }
  assert.equal('silenceAllMakeup' in store.getState().settings, false, '不允许全局静默开关');
  const plan = getReminders(store.getState(), '2026-09-01', '2026-10-31');
  assert.deepEqual(plan.pendingDates, []);
});

test("11. null + mode='skip' 仍是 makeup_unconfirmed（mode 不豁免提示义务）", () => {
  const state = autumnState({ settings: { makeupWorkdayMode: 'skip' } });
  const d = day(state, '2026-10-10');
  assert.equal(d.status, 'makeup_unconfirmed');
  assert.equal(d.complete, false);
});

test("12. follow=5 + mode='skip' → makeup_skipped 且 effectiveDayOfWeek=5", () => {
  const state = lastTermState({ settings: { makeupWorkdayMode: 'skip' } });
  const d = day(state, '2026-01-04');
  assert.equal(d.status, 'makeup_skipped');
  assert.equal(d.effectiveDayOfWeek, 5);
  assert.equal(d.complete, true);
  assert.deepEqual(d.classes, []);
  assert.match(d.notice, /本应按周五/);
});

test('13. skipOnHoliday=false → 国庆日 status=normal 且正常排课', () => {
  const state = autumnState({ settings: { skipOnHoliday: false } });
  const d = day(state, '2026-10-01');
  assert.equal(d.status, 'normal');
  assert.equal(d.complete, true);
  assert.equal(d.classes.length, 1);
  assert.equal(d.notice, null);
});

/* ---------------------------------------------------------------- 14-23 调课与边界 */

test('14. cancel 带 targetSessionId → 只停该课次', () => {
  const state = makeState();
  state.adjustments = [
    { id: 'a1', date: '2026-03-05', type: 'cancel', targetSessionId: 's2', courseId: 'c2', createdAt: 'x' }
  ];
  const classes = day(state, '2026-03-05').classes;
  assert.equal(classes.length, 1);
  assert.equal(classes[0].sessionId, 's3');
});

test('15. cancel 只带 courseId → 该课程当日全部课次消失', () => {
  const state = makeState();
  state.sessions.push(SESSION('s4', 'c1', 4, 8, 9));
  assert.equal(day(state, '2026-03-05').classes.filter((c) => c.courseId === 'c1').length, 2);
  state.adjustments = [
    { id: 'a2', date: '2026-03-05', type: 'cancel', targetSessionId: null, courseId: 'c1', createdAt: 'x' }
  ];
  assert.equal(day(state, '2026-03-05').classes.filter((c) => c.courseId === 'c1').length, 0);
});

test('16. roomChange → location 新值 / original.location 旧值 / origin=adjustment', () => {
  const state = makeState();
  state.adjustments = [
    {
      id: 'a3',
      date: '2026-03-05',
      type: 'roomChange',
      targetSessionId: 's2',
      location: '教四-210',
      createdAt: 'x'
    }
  ];
  const cls = day(state, '2026-03-05').classes.find((c) => c.sessionId === 's2');
  assert.equal(cls.location, '教四-210');
  assert.equal(cls.original.location, '教三-201');
  assert.equal(cls.origin, 'adjustment');
  assert.equal(cls.adjustmentType, 'roomChange');
});

test('17. reschedule 只给节次 → 时间按新节次解析', () => {
  const state = makeState();
  state.adjustments = [
    {
      id: 'a4',
      date: '2026-03-05',
      type: 'reschedule',
      targetSessionId: 's2',
      startPeriod: 1,
      endPeriod: 2,
      createdAt: 'x'
    }
  ];
  const cls = day(state, '2026-03-05').classes.find((c) => c.sessionId === 's2');
  assert.equal(cls.startPeriod, 1);
  assert.equal(cls.startTime, '08:00');
  assert.equal(cls.endTime, '09:35');
});

test('18. reschedule 给自定义时间 → 自定义时间优先', () => {
  const state = makeState();
  state.adjustments = [
    {
      id: 'a5',
      date: '2026-03-05',
      type: 'reschedule',
      targetSessionId: 's2',
      startPeriod: 3,
      endPeriod: 4,
      startTime: '15:00',
      endTime: '16:35',
      createdAt: 'x'
    }
  ];
  const cls = day(state, '2026-03-05').classes.find((c) => c.sessionId === 's2');
  assert.equal(cls.startTime, '15:00');
  assert.equal(cls.endTime, '16:35');
});

test('19. makeup 在无周期课的日子 → 新增 1 条 origin=adjustment', () => {
  const state = makeState();
  state.adjustments = [
    {
      id: 'a6',
      date: '2026-03-08',
      type: 'makeup',
      courseId: 'c2',
      startPeriod: 3,
      endPeriod: 4,
      location: '教四-105',
      createdAt: 'x'
    }
  ];
  const classes = day(state, '2026-03-08').classes;
  assert.equal(classes.length, 1);
  assert.equal(classes[0].origin, 'adjustment');
  assert.equal(classes[0].adjustmentType, 'makeup');
  assert.equal(classes[0].startTime, '09:55');
});

test('20. 同节次两门不同课 → conflict + conflictWith 互指', () => {
  const state = makeState();
  state.sessions.push(SESSION('s9', 'c3', 1, 1, 2));
  const classes = day(state, '2026-03-02').classes;
  assert.equal(classes.length, 2);
  assert.equal(classes[0].conflict, true);
  assert.equal(classes[1].conflict, true);
  assert.ok(classes[0].conflictWith.includes(classes[1].key));
  assert.ok(classes[1].conflictWith.includes(classes[0].key));
});

test('21. G6：ADD_ADJUSTMENT / SET_MAKEUP_FOLLOW 前后 sessions 完全不变', () => {
  const state = autumnState();
  const store = createStore({ storage: null });
  store.__setState(state);
  const before = JSON.stringify(store.getState().sessions);

  const added = store.dispatch({
    type: 'ADD_ADJUSTMENT',
    payload: {
      adjustment: { date: '2026-10-08', type: 'roomChange', targetSessionId: 't1', location: '教四-999' }
    }
  });
  assert.equal(added.ok, true, JSON.stringify(added.errors));
  assert.equal(JSON.stringify(store.getState().sessions), before);

  const followed = store.dispatch({
    type: 'SET_MAKEUP_FOLLOW',
    payload: { date: '2026-10-10', follow: 4 }
  });
  assert.equal(followed.ok, true, JSON.stringify(followed.errors));
  assert.equal(JSON.stringify(store.getState().sessions), before);
});

test('22. 跨零点课 → crossMidnight=true，仍归属开始日', () => {
  const state = makeState({
    sessions: [SESSION('x1', 'c1', 1, 12, 12)],
    settings: {}
  });
  state.settings.periods.push({ index: 12, label: '第12节', start: '23:30', end: '00:20', isCustom: true });
  const classes = day(state, '2026-03-02').classes;
  assert.equal(classes.length, 1);
  assert.equal(classes[0].crossMidnight, true);
  assert.equal(classes[0].startTime, '23:30');
  assert.equal(classes[0].endTime, '00:20');
  assert.equal(classes[0].date, '2026-03-02');
});

test('23. 未配置学期 → unconfigured / complete=false / 不抛错', () => {
  const state = makeState();
  state.settings.semesterStartMonday = null;
  assert.doesNotThrow(() => day(state, '2026-03-02'));
  const d = day(state, '2026-03-02');
  assert.equal(d.status, 'unconfigured');
  assert.equal(d.complete, false);
  assert.deepEqual(d.classes, []);
  assert.equal(d.effectiveDayOfWeek, null);
});

/* ---------------------------------------------------------------- 24-29 ReminderPlan */

test('24. getReminders 返回计划对象；pendingDates / warnings / skipped 齐全', () => {
  const state = autumnState();
  const plan = getReminders(state, '2026-09-19', '2026-10-12');
  assert.ok(Array.isArray(plan.points));
  assert.ok(Array.isArray(plan.skipped));
  assert.ok(plan.pendingDates.includes('2026-09-20'));
  assert.ok(plan.pendingDates.includes('2026-10-10'));
  assert.ok(plan.warnings.length >= 1);
  assert.ok(plan.skipped.some((s) => s.reason === 'UNCONFIRMED_MAKEUP'));

  // 确认 09-20 后它从 pendingDates 消失
  const store = createStore({ storage: null });
  store.__setState(state);
  store.dispatch({ type: 'SET_MAKEUP_FOLLOW', payload: { date: '2026-09-20', follow: 4 } });
  const after = getReminders(store.getState(), '2026-09-19', '2026-10-12');
  assert.equal(after.pendingDates.includes('2026-09-20'), false);
  assert.equal(after.pendingDates.includes('2026-10-10'), true);
});

test('25. plan.points 提前量：08:00 课 + 15 分钟 → 07:45', () => {
  const state = autumnState();
  const plan = getReminders(state, '2026-09-17', '2026-09-17'); // 第 2 周周四
  assert.equal(plan.points.length, 1);
  const p = plan.points[0];
  assert.equal(p.classStart, '08:00');
  const minutes = ((p.triggerAt + 8 * 3600 * 1000) % 86400000) / 60000;
  assert.equal(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`, '07:45');
});

test('26. 课程级 rule：advance 30 覆盖全局；enabled=false 只影响该课', () => {
  const state = autumnState();
  state.settings.reminder.rules = [
    { id: 'r1', scope: 'course', targetId: 'c1', advanceMinutes: 30, channel: 'both', enabled: true }
  ];
  const plan = getReminders(state, '2026-09-17', '2026-09-17');
  const p = plan.points.find((x) => x.courseId === 'c1');
  assert.equal(p.advanceMinutes, 30);

  state.settings.reminder.rules = [
    { id: 'r1', scope: 'course', targetId: 'c1', advanceMinutes: 15, channel: 'both', enabled: false }
  ];
  const plan2 = getReminders(state, '2026-09-17', '2026-09-17');
  assert.equal(plan2.points.some((x) => x.courseId === 'c1'), false);
  assert.ok(plan2.skipped.some((s) => s.reason === 'RULE_DISABLED'));
});

test('27. makeup_unconfirmed 日 → 0 points（即使有 makeup adjustment），并进 pendingDates', () => {
  const state = autumnState();
  state.adjustments = [
    {
      id: 'a8',
      date: '2026-10-10',
      type: 'makeup',
      courseId: 'c1',
      startPeriod: 1,
      endPeriod: 2,
      location: '教三-201',
      createdAt: 'x'
    }
  ];
  const plan = getReminders(state, '2026-10-10', '2026-10-10');
  assert.equal(plan.points.length, 0);
  assert.deepEqual(plan.pendingDates, ['2026-10-10']);
});

test('28. 法定假期 → 0 points 且 skipped 含 HOLIDAY；假期里的显式补课仍有 1 点', () => {
  const state = autumnState();
  const plan = getReminders(state, '2026-10-01', '2026-10-01');
  assert.equal(plan.points.length, 0);
  assert.ok(plan.skipped.some((s) => s.reason === 'HOLIDAY'));

  state.adjustments = [
    {
      id: 'a9',
      date: '2026-10-01',
      type: 'makeup',
      courseId: 'c2',
      startPeriod: 3,
      endPeriod: 4,
      location: '教四-105',
      createdAt: 'x'
    }
  ];
  const plan2 = getReminders(state, '2026-10-01', '2026-10-01');
  assert.equal(plan2.points.length, 1, '假期显式补课应照常提醒');
});

test('29. cancel 后 0 点且 skipped 含 CANCELLED；advance 1440 落到前一天', () => {
  const state = autumnState();
  state.adjustments = [
    { id: 'a10', date: '2026-09-17', type: 'cancel', targetSessionId: 't1', courseId: 'c1', createdAt: 'x' }
  ];
  const plan = getReminders(state, '2026-09-17', '2026-09-17');
  assert.equal(plan.points.length, 0);
  assert.ok(plan.skipped.some((s) => s.reason === 'CANCELLED'));

  const state2 = autumnState();
  state2.settings.reminder.defaultAdvanceMinutes = 1440;
  const plan2 = getReminders(state2, '2026-09-17', '2026-09-17');
  assert.equal(plan2.points.length, 1);
  assert.equal(todayStr(plan2.points[0].triggerAt), '2026-09-16');
});

/* ---------------------------------------------------------------- 30-31 优先级防线 */

test('30. 学期外 > 补班三态：10-10 在 20 周学期后 → out_of_semester，不进 pendingDates', () => {
  const state = autumnState({ start: '2026-02-23' }); // 10-10 变成第 33 周
  const d = day(state, '2026-10-10');
  assert.equal(d.status, 'out_of_semester');
  assert.equal(d.complete, true);
  const plan = getReminders(state, '2026-10-08', '2026-10-12');
  assert.deepEqual(plan.pendingDates, []);
});

test('31. totalWeeks 非法（undefined）→ unconfigured，不得越过学期边界', () => {
  const state = autumnState();
  state.settings.totalWeeks = undefined;
  const d = day(state, '2026-10-10');
  assert.equal(d.status, 'unconfigured');
  assert.equal(d.complete, false);
});

/* ---------------------------------------------------------------- 门禁辅助断言 */

test('G14：NOTICE 键集合与 7 值枚举完全相等，且每个值都是函数', () => {
  assert.deepEqual(Object.keys(NOTICE).sort(), [...STATUS_VALUES].sort());
  for (const key of Object.keys(NOTICE)) {
    assert.equal(typeof NOTICE[key], 'function', `${key} 必须是函数`);
  }
  assert.equal(NOTICE.normal(), null, 'normal 的 notice 必须是 null（不是空串）');
});

test('G16：resolveDay 运行时形状（9 字段 + 枚举 + 数组/布尔类型）', () => {
  const state = autumnState();
  const need = [
    'date',
    'weekNo',
    'status',
    'complete',
    'holidayName',
    'followDayOfWeek',
    'effectiveDayOfWeek',
    'notice',
    'classes'
  ];
  for (const date of ['2026-10-10', '2026-09-20', '2026-10-01', '2026-09-17']) {
    const d = day(state, date);
    const miss = need.filter((k) => !(k in d));
    assert.deepEqual(miss, [], `${date} 缺字段`);
    assert.ok(STATUS_VALUES.includes(d.status), `${date} status 非法`);
    assert.ok(Array.isArray(d.classes));
    assert.equal(typeof d.complete, 'boolean');
  }
  const unconfirmed = day(state, '2026-10-10');
  assert.equal(unconfirmed.complete, false);
  assert.equal(unconfirmed.effectiveDayOfWeek, null);
});

test('classifyDay 与 resolveClasses 只做分层职责（分类 / 投影）', () => {
  const state = autumnState();
  const cls = classifyDay(state, '2026-10-10');
  assert.equal(cls.status, 'makeup_unconfirmed');
  assert.equal(cls.skipAll, true);
  assert.equal(cls.effectiveDow, null);
  assert.deepEqual(resolveClasses(state, '2026-10-10'), []);
});

/* ---------------------------------------------------------------- 其它视图 */

test('resolveRange 返回 Day[]，getWeekView 每格带 status/complete/notice', () => {
  const state = autumnState();
  const range = resolveRange(state, '2026-09-14', '2026-09-20');
  assert.equal(range.length, 7);
  assert.ok(range.every((d) => typeof d.status === 'string' && 'complete' in d));

  const view = getWeekView(state, 1, '2026-09-20');
  assert.equal(view.days.length, 7);
  for (const d of view.days) {
    assert.ok('status' in d && 'complete' in d && 'notice' in d);
  }
  assert.ok(view.pendingDates.includes('2026-09-20'), '周视图应汇总本周待确认日');
});

test('resolveCourseDates：包含已停课；describeDate 给星期与周次', () => {
  const state = autumnState();
  state.adjustments = [
    { id: 'a11', date: '2026-09-24', type: 'cancel', targetSessionId: 't1', courseId: 'c1', createdAt: 'x' }
  ];
  const dates = resolveCourseDates(state, 'c1');
  const cancelled = dates.find((d) => d.date === '2026-09-24');
  assert.ok(cancelled);
  assert.equal(cancelled.status, '已停课');

  const info = describeDate(state, '2026-09-17');
  assert.equal(info.weekday, '周四');
  assert.equal(info.weekNo, 2);
});

test('getNextClass / getNowMarker / getPeriods 基本可用', () => {
  const state = autumnState();
  const now = Date.UTC(2026, 8, 17, 0, 0); // 上海 2026-09-17 08:00
  const next = getNextClass(state, now);
  assert.ok(next.cls);
  assert.equal(next.cls.startTime, '08:00');
  const marker = getNowMarker(state, Date.UTC(2026, 8, 17, 0, 20));
  assert.equal(marker.inClass, true);
  assert.equal(marker.rowIndex, 0);
  assert.equal(getPeriods(state).length, 11);
});

test('parseWeeksText / weeksToText 往返一致', () => {
  assert.equal(weeksToText({ start: 1, end: 16, type: 'odd', extra: [] }), '1-16周(单)');
  assert.deepEqual(parseWeeksText('1-16周(双)', 20), { start: 1, end: 16, type: 'even', extra: [] });
});

/* ---------------------------------------------------------------- 同一门大课内部换节 */

// 「线性代数 第3-5节」在教务系统里可能是一整条，也可能被拆成 3-4 节 + 5 节两条。
// 拆开时两条之间的间隔就是普通课间（5~15 分钟），只看时间会误判成"又要上新课"。
// 判据必须是「课程相同 + 紧接着上」，两者同时成立才不提醒。

// 2026-03-02 是第 2 周周一（第 1 周周一 02-23 正好是春节假期最后一天，不能用）
const ONE_DAY = ['2026-03-02', '2026-03-02'];

test('同课内部换节（拆成两条）→ 只提醒第一条', () => {
  const state = makeState({
    sessions: [
      SESSION('a1', 'c1', 1, 2, 2), // 08:50-09:35
      SESSION('a2', 'c1', 1, 3, 3) // 09:50-10:35，课间 15 分钟
    ]
  });
  const plan = getReminders(state, ONE_DAY[0], ONE_DAY[1]);
  assert.equal(plan.points.length, 1);
  assert.equal(plan.points[0].classStart, '08:50');
  assert.ok(plan.skipped.some((s) => s.reason === 'SAME_COURSE_BREAK'));
});

test('连堂拆成三条 → 只提醒最前面那条', () => {
  const state = makeState({
    sessions: [
      SESSION('e1', 'c1', 1, 2, 2), // 08:50-09:35
      SESSION('e2', 'c1', 1, 3, 3), // 09:50-10:35
      SESSION('e3', 'c1', 1, 4, 4) // 10:40-11:25
    ]
  });
  const plan = getReminders(state, ONE_DAY[0], ONE_DAY[1]);
  assert.equal(plan.points.length, 1);
});

test('换另一门课 → 两节都提醒（按课程归属，不是按间隔）', () => {
  const state = makeState({
    sessions: [
      SESSION('b1', 'c1', 1, 2, 2), // 08:50-09:35 c1
      SESSION('b2', 'c2', 1, 3, 3) // 09:50-10:35 c2，间隔与上一条完全相同
    ]
  });
  const plan = getReminders(state, ONE_DAY[0], ONE_DAY[1]);
  assert.equal(plan.points.length, 2);
});

test('同一门课但隔了好几小时 → 仍提醒（超过课间上限）', () => {
  const state = makeState({
    sessions: [
      SESSION('c1a', 'c1', 1, 2, 2), // 08:50-09:35
      SESSION('c1b', 'c1', 1, 6, 6) // 13:00，中间空 3.5 小时
    ]
  });
  const plan = getReminders(state, ONE_DAY[0], ONE_DAY[1]);
  assert.equal(plan.points.length, 2);
});

test('同一时段两门课并排 → 都提醒（时间重叠不算课间）', () => {
  const state = makeState({
    sessions: [
      SESSION('d1', 'c1', 1, 6, 7),
      SESSION('d2', 'c2', 1, 6, 7)
    ]
  });
  const plan = getReminders(state, ONE_DAY[0], ONE_DAY[1]);
  assert.equal(plan.points.length, 2);
});
