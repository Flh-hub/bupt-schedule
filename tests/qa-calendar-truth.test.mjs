/**
 * qa-calendar-truth.test.mjs — 真相层（calendar.js / holidays.js）独立验证。
 *
 * 关注点（PRD §7.8.1 契约铁律 + TASKS §3 G15/G16）：
 *   1. 五步判定顺序的反例：学期外 > 补班三态；NaN 不得绕过学期边界；skipOnHoliday=false 走 normal；
 *      'none' 与 null 语义必须可区分。
 *   2. 调课四操作 + sessions 只读 + 多条 adjustment 叠加。
 *   3. getReminders 计划对象：pendingDates 不产点、skipped 可审计、假期为空。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyState, expandWeeks, dayOfWeekOf } from '../src/model.js';
import { resolveDay, resolveRange, getReminders, STATUS_VALUES } from '../src/calendar.js';
import { BUILTIN_2026, auditBuiltinHolidays } from '../src/holidays.js';

const WEEKS_ALL = { start: 1, end: 20, type: 'all', extra: [] };

/** 一份可控 state 工厂（默认 2026 秋季学期：2026-09-07 开学，20 周）。 */
function makeState(over = {}) {
  const st = emptyState();
  st.settings.semesterStartMonday = over.start === undefined ? '2026-09-07' : over.start;
  st.settings.totalWeeks = over.totalWeeks === undefined ? 20 : over.totalWeeks;
  if (over.mode) st.settings.makeupWorkdayMode = over.mode;
  if (over.skipOnHoliday !== undefined) st.settings.skipOnHoliday = over.skipOnHoliday;
  if (over.reminder) st.settings.reminder = { ...st.settings.reminder, ...over.reminder };
  st.holidays = over.holidays || [];
  st.courses = over.courses || [];
  st.sessions = over.sessions || [];
  st.adjustments = over.adjustments || [];
  return st;
}

/** 手工调休上班日（模拟用户在设置页新增 / 修改）。 */
const makeup = (date, follow, name = '测试调休上班') => ({
  date,
  name,
  type: 'makeupWorkday',
  followDayOfWeek: follow,
  source: 'manual'
});

const ONE_COURSE = {
  courses: [{ id: 'c1', name: '高等数学' }],
  sessions: [
    { id: 's1', courseId: 'c1', dayOfWeek: 4, startPeriod: 1, endPeriod: 2, location: '教三-201', weeks: WEEKS_ALL }
  ]
};

/* ---------------------------------------------------- 7 状态 + 判定顺序反例 */

test('7 个 status 全覆盖（用真实 state 跑出，不手写 Day）', () => {
  const cases = [
    ['normal', makeState(), '2026-09-08'],
    ['holiday_silent', makeState(), '2026-10-01'],
    ['makeup_unconfirmed', makeState(), '2026-10-10'],
    ['makeup_follow', makeState({ holidays: [makeup('2026-09-13', 5)] }), '2026-09-13'],
    ['makeup_skipped', makeState({ holidays: [makeup('2026-09-19', 'none')] }), '2026-09-19'],
    ['makeup_skipped', makeState({ mode: 'skip', holidays: [makeup('2026-09-26', 5)] }), '2026-09-26'],
    ['out_of_semester', makeState(), '2027-03-01'],
    ['unconfigured', makeState({ start: null }), '2026-09-08']
  ];
  for (const [want, st, date] of cases) {
    const day = resolveDay(st, date);
    assert.equal(day.status, want, `${date} 的 status 不符`);
    assert.ok(STATUS_VALUES.includes(day.status), `${date} 的 status 不在冻结 7 值内`);
  }
});

test('第 ② 步（学期边界）优先于第 ④ 步（补班三态）', () => {
  // 2026-02-23 起 20 周 → 2026-10-10 属于第 33 周，必然在学期外
  const st = makeState({ start: '2026-02-23' });
  const day = resolveDay(st, '2026-10-10');
  assert.equal(day.status, 'out_of_semester', '学期外的补班日不得判成 makeup_unconfirmed（否则整个寒暑假持续弹确认卡）');
  assert.equal(day.complete, true);
  assert.equal(day.weekNo, 33);

  const plan = getReminders(st, '2026-10-01', '2026-10-12');
  assert.deepEqual(plan.pendingDates, [], '学期外的补班日不得进 pendingDates');
  assert.equal(plan.points.length, 0);
});

test('totalWeeks 非法（undefined）必须落 unconfigured，不得被 NaN 比较绕过', () => {
  const st = makeState();
  st.settings.totalWeeks = undefined;
  for (const date of ['2026-10-10', '2027-05-01']) {
    const day = resolveDay(st, date);
    assert.equal(day.status, 'unconfigured', `${date}：weekNo > undefined 得 false，会静默越过学期边界`);
    assert.equal(day.complete, false);
    assert.deepEqual(day.classes, []);
  }
});

test('skipOnHoliday=false 时国庆日回到 normal 且有课', () => {
  const st = makeState({ skipOnHoliday: false, ...ONE_COURSE });
  const day = resolveDay(st, '2026-10-01');
  assert.equal(day.status, 'normal');
  assert.equal(day.complete, true);
  assert.equal(day.classes.length, 1, '关闭"节假日跳过"后必须照常排课');
  assert.equal(day.notice, null);
  assert.equal(day.holidayName, '国庆节');

  const silent = resolveDay(makeState(ONE_COURSE), '2026-10-01');
  assert.equal(silent.status, 'holiday_silent');
  assert.equal(silent.classes.length, 0);
  assert.equal(silent.complete, true, '假期是「确定没课」，complete 必须为 true');
});

test("'none'（已确认无课）与 null（未确认）在数据与结论上必须可区分", () => {
  const noneDay = resolveDay(makeState({ holidays: [makeup('2026-09-19', 'none', '国庆调休上班')] }), '2026-09-19');
  const nullDay = resolveDay(makeState({ holidays: [makeup('2026-09-19', null, '国庆调休上班')] }), '2026-09-19');

  assert.equal(noneDay.status, 'makeup_skipped');
  assert.equal(noneDay.complete, true, "'none' 是已确认无课，complete 必须为 true");
  assert.equal(noneDay.followDayOfWeek, 'none');
  assert.equal(noneDay.effectiveDayOfWeek, null);

  assert.equal(nullDay.status, 'makeup_unconfirmed');
  assert.equal(nullDay.complete, false, 'null 是未确认，complete 必须为 false');
  assert.equal(nullDay.followDayOfWeek, null);
  assert.equal(nullDay.effectiveDayOfWeek, null, '未确认态不得用真实星期兜底（G15）');

  assert.notEqual(noneDay.notice, nullDay.notice, '两种语义的文案不可合并');
  assert.ok(!String(nullDay.notice).includes('无课'), '未确认态不得输出"无课"结论');
});

test("null 与 makeupWorkdayMode 无关：mode='skip' 也不得把未确认降级为 skipped", () => {
  const st = makeState({ mode: 'skip', courses: ONE_COURSE.courses, sessions: ONE_COURSE.sessions });
  const day = resolveDay(st, '2026-10-10');
  assert.equal(day.status, 'makeup_unconfirmed', "mode='skip' 只决定排不排课，不豁免提示义务");
  assert.equal(day.complete, false);
});

test("已指定星期 + mode='skip' → makeup_skipped，且 notice 提示「本应按周X」", () => {
  const st = makeState({ mode: 'skip', holidays: [makeup('2026-09-26', 5)] });
  const day = resolveDay(st, '2026-09-26');
  assert.equal(day.status, 'makeup_skipped');
  assert.equal(day.effectiveDayOfWeek, 5);
  assert.match(day.notice, /周[一二三四五六日]/, '应提示本应按哪天的课表');
});

test('推定值 2026-01-04（周五）按第一学期起点生效并取周五课', () => {
  const st = makeState({
    start: '2025-09-01',
    courses: [{ id: 'c5', name: '周五课' }],
    sessions: [{ id: 's5', courseId: 'c5', dayOfWeek: 5, startPeriod: 5, endPeriod: 6, location: '教三-101', weeks: WEEKS_ALL }]
  });
  const day = resolveDay(st, '2026-01-04');
  assert.equal(day.weekNo, 18);
  assert.equal(day.status, 'makeup_follow');
  assert.equal(day.effectiveDayOfWeek, 5);
  assert.equal(day.classes.length, 1, '应返回周五的课');
  assert.match(day.notice, /按周五/);
});

test('resolveRange 返回 Day[]，周视图可读出每日 status', () => {
  const days = resolveRange(makeState(), '2026-10-09', '2026-10-11');
  assert.equal(days.length, 3);
  assert.deepEqual(days.map((d) => d.status), ['normal', 'makeup_unconfirmed', 'normal']);
  for (const d of days) {
    assert.equal(typeof d.complete, 'boolean');
    assert.ok(Array.isArray(d.classes));
  }
});

test('Day 九个契约字段齐全且类型正确（G16 形状）', () => {
  const need = ['date', 'weekNo', 'status', 'complete', 'notice', 'holidayName', 'followDayOfWeek', 'effectiveDayOfWeek', 'classes'];
  for (const date of ['2026-10-10', '2026-09-20', '2026-10-01', '2026-09-08']) {
    const day = resolveDay(makeState(), date);
    for (const key of need) assert.ok(key in day, `${date} 缺字段 ${key}`);
    assert.equal(day.date, date);
    assert.equal(typeof day.complete, 'boolean');
    assert.ok(Array.isArray(day.classes));
    assert.ok(day.notice === null || typeof day.notice === 'string');
  }
});

/* ------------------------------------------------------------ 调课四操作 */

test('cancel（按 sessionId）只停该次课，其他课不受影响', () => {
  const st = makeState({
    courses: [{ id: 'c1', name: '高数' }, { id: 'c2', name: '物理' }],
    sessions: [
      { id: 's1', courseId: 'c1', dayOfWeek: 4, startPeriod: 1, endPeriod: 2, location: 'a', weeks: WEEKS_ALL },
      { id: 's2', courseId: 'c2', dayOfWeek: 4, startPeriod: 3, endPeriod: 4, location: 'b', weeks: WEEKS_ALL }
    ],
    adjustments: [{ id: 'a1', date: '2026-09-10', type: 'cancel', targetSessionId: 's1', courseId: 'c1' }]
  });
  const day = resolveDay(st, '2026-09-10');
  assert.deepEqual(day.classes.map((c) => c.courseName), ['物理']);

  const other = resolveDay(st, '2026-09-17');
  assert.equal(other.classes.length, 2, '停课不得影响其他周次');
});

test('cancel（只给 courseId）停掉该课程当日全部课次', () => {
  const st = makeState({
    courses: [{ id: 'c1', name: '高数' }],
    sessions: [
      { id: 's1', courseId: 'c1', dayOfWeek: 4, startPeriod: 1, endPeriod: 2, location: 'a', weeks: WEEKS_ALL },
      { id: 's3', courseId: 'c1', dayOfWeek: 4, startPeriod: 5, endPeriod: 6, location: 'b', weeks: WEEKS_ALL }
    ],
    adjustments: [{ id: 'a2', date: '2026-09-10', type: 'cancel', courseId: 'c1' }]
  });
  assert.equal(resolveDay(st, '2026-09-10').classes.length, 0);
});

test('roomChange 改地点并保留原值供 UI 对照', () => {
  const st = makeState({
    ...ONE_COURSE,
    adjustments: [{ id: 'a3', date: '2026-09-10', type: 'roomChange', targetSessionId: 's1', courseId: 'c1', location: '教四-105' }]
  });
  const [cls] = resolveDay(st, '2026-09-10').classes;
  assert.equal(cls.location, '教四-105');
  assert.equal(cls.original.location, '教三-201');
  assert.equal(cls.origin, 'adjustment');
  assert.equal(cls.adjustmentType, 'roomChange');
});

test('reschedule：只给节次时按新节次解析时间；给自定义时间时自定义优先', () => {
  const byPeriod = makeState({
    ...ONE_COURSE,
    adjustments: [{ id: 'a4', date: '2026-09-10', type: 'reschedule', targetSessionId: 's1', courseId: 'c1', startPeriod: 7, endPeriod: 8 }]
  });
  const [c1] = resolveDay(byPeriod, '2026-09-10').classes;
  assert.equal(c1.startPeriod, 7);
  assert.equal(c1.endPeriod, 8);
  assert.equal(c1.startTime, '15:25');
  assert.equal(c1.endTime, '17:00');
  assert.equal(c1.original.startPeriod, 1);

  const byTime = makeState({
    ...ONE_COURSE,
    adjustments: [
      { id: 'a5', date: '2026-09-10', type: 'reschedule', targetSessionId: 's1', courseId: 'c1', startPeriod: 7, endPeriod: 8, startTime: '10:00', endTime: '10:45' }
    ]
  });
  const [c2] = resolveDay(byTime, '2026-09-10').classes;
  assert.equal(c2.startTime, '10:00', '自定义时间必须优先于节次解析');
  assert.equal(c2.endTime, '10:45');
});

test('makeup 在原本无课的日子新增课次（origin=adjustment）', () => {
  const st = makeState({
    ...ONE_COURSE,
    adjustments: [{ id: 'a6', date: '2026-09-12', type: 'makeup', courseId: 'c1', startPeriod: 5, endPeriod: 6, location: '教三-101' }]
  });
  const day = resolveDay(st, '2026-09-12');
  assert.equal(day.classes.length, 1);
  const [cls] = day.classes;
  assert.equal(cls.origin, 'adjustment');
  assert.equal(cls.adjustmentType, 'makeup');
  assert.equal(cls.startTime, '13:30');
  assert.equal(cls.location, '教三-101');
});

test('同节次两门不同课 → 互相标注 conflict（不合并、不丢弃）', () => {
  const st = makeState({
    courses: [{ id: 'c1', name: '高数' }, { id: 'c2', name: '物理' }],
    sessions: [
      { id: 's1', courseId: 'c1', dayOfWeek: 4, startPeriod: 1, endPeriod: 2, location: 'a', weeks: WEEKS_ALL },
      { id: 's2', courseId: 'c2', dayOfWeek: 4, startPeriod: 2, endPeriod: 3, location: 'b', weeks: WEEKS_ALL }
    ]
  });
  const { classes } = resolveDay(st, '2026-09-10');
  assert.equal(classes.length, 2, '冲突必须并列展示，不能合并');
  assert.equal(classes[0].conflict, true);
  assert.equal(classes[1].conflict, true);
  assert.ok(classes[0].conflictWith.includes(classes[1].key));
  assert.ok(classes[1].conflictWith.includes(classes[0].key));
});

test('cancel 优先于 makeup（补课不会被同日停课误删）', () => {
  const st = makeState({
    courses: [{ id: 'c1', name: '高数' }, { id: 'c2', name: '物理' }],
    sessions: [{ id: 's1', courseId: 'c1', dayOfWeek: 6, startPeriod: 1, endPeriod: 2, location: 'a', weeks: WEEKS_ALL }],
    adjustments: [
      { id: 'a7', date: '2026-09-12', type: 'cancel', targetSessionId: 's1', courseId: 'c1' },
      { id: 'a8', date: '2026-09-12', type: 'makeup', courseId: 'c2', startPeriod: 1, endPeriod: 2, location: 'b' }
    ]
  });
  const { classes } = resolveDay(st, '2026-09-12');
  assert.deepEqual(classes.map((c) => c.adjustmentType), ['makeup'], '补课被停课连带删除了');
});

test('同一天 roomChange 与 reschedule 叠加时，original 必须是「调课前」的原值', () => {
  const st = makeState({
    ...ONE_COURSE,
    adjustments: [
      { id: 'a9', date: '2026-09-10', type: 'roomChange', targetSessionId: 's1', courseId: 'c1', location: '教四-105' },
      { id: 'a10', date: '2026-09-10', type: 'reschedule', targetSessionId: 's1', courseId: 'c1', startPeriod: 7, endPeriod: 8 }
    ]
  });
  const [cls] = resolveDay(st, '2026-09-10').classes;
  assert.equal(cls.location, '教四-105');
  assert.equal(cls.startPeriod, 7);
  assert.equal(cls.original.location, '教三-201', 'PRD US-12 AC4 要求在课表上对照「原教室 → 新教室」');
  assert.equal(cls.original.startPeriod, 1);
});

test('sessions 只读：追加 adjustment 前后深度相等', () => {
  const st = makeState(ONE_COURSE);
  const before = JSON.stringify(st.sessions);
  st.adjustments = [
    { id: 'x1', date: '2026-09-10', type: 'roomChange', targetSessionId: 's1', courseId: 'c1', location: '教四-105' },
    { id: 'x2', date: '2026-09-10', type: 'reschedule', targetSessionId: 's1', courseId: 'c1', startPeriod: 7, endPeriod: 8 },
    { id: 'x3', date: '2026-09-10', type: 'cancel', targetSessionId: 's1', courseId: 'c1' }
  ];
  resolveDay(st, '2026-09-10');
  resolveRange(st, '2026-09-07', '2026-09-13');
  getReminders(st, '2026-09-07', '2026-09-13');
  assert.equal(JSON.stringify(st.sessions), before, '调课不得写回 CourseSession');
});

test('sessions 只读：SET_MAKEUP_FOLLOW 前后深度相等', () => {
  const st = makeState({ ...ONE_COURSE, holidays: [makeup('2026-10-10', null)] });
  const before = JSON.stringify(st.sessions);
  st.holidays = [makeup('2026-10-10', 4)];
  const day = resolveDay(st, '2026-10-10');
  assert.equal(day.status, 'makeup_follow');
  assert.equal(JSON.stringify(st.sessions), before);
});

test('跨零点晚课（end < start）归属开始日并标记 crossMidnight', () => {
  const st = makeState(ONE_COURSE);
  st.settings.periods = st.settings.periods.map((p) =>
    p.index === 2 ? { ...p, start: '23:30', end: '00:20', isCustom: true } : p
  );
  const st2 = makeState({
    courses: ONE_COURSE.courses,
    sessions: [{ id: 'sn', courseId: 'c1', dayOfWeek: 4, startPeriod: 2, endPeriod: 2, location: 'a', weeks: WEEKS_ALL }]
  });
  st2.settings.periods = st.settings.periods;

  const [cls] = resolveDay(st2, '2026-09-10').classes;
  assert.equal(cls.startTime, '23:30');
  assert.equal(cls.endTime, '00:20');
  assert.equal(cls.crossMidnight, true);
  assert.equal(cls.date, '2026-09-10');
});

/* ------------------------------------------------------------ 提醒计划 */

test('getReminders 返回计划对象（不是裸数组）', () => {
  const plan = getReminders(makeState(ONE_COURSE), '2026-09-07', '2026-09-13');
  assert.ok(Array.isArray(plan.points));
  assert.ok(Array.isArray(plan.pendingDates));
  assert.ok(Array.isArray(plan.skipped));
  assert.ok(Array.isArray(plan.warnings));
});

test('待确认补班日：进 pendingDates、不产任何提醒点、skipped 原因可审计', () => {
  const st = makeState({
    ...ONE_COURSE,
    sessions: [{ id: 's1', courseId: 'c1', dayOfWeek: 6, startPeriod: 1, endPeriod: 2, location: '教三-201', weeks: WEEKS_ALL }]
  });
  const plan = getReminders(st, '2026-09-19', '2026-10-12');

  assert.deepEqual(plan.pendingDates, ['2026-09-20', '2026-10-10']);
  assert.ok(plan.warnings.length >= 1, 'pendingDates 非空时必须有 warnings');
  assert.ok(
    plan.skipped.some((s) => s.reason === 'UNCONFIRMED_MAKEUP' && s.date === '2026-09-20'),
    '不产点的原因必须显式记账'
  );
  for (const date of ['2026-09-20', '2026-10-10']) {
    assert.equal(plan.points.some((p) => p.date === date), false, `${date} 未确认前不得产出提醒点`);
  }
});

test('确认后该日期从 pendingDates 消失', () => {
  const base = { ...ONE_COURSE, holidays: [makeup('2026-09-20', null), makeup('2026-10-10', null)] };
  const before = getReminders(makeState(base), '2026-09-19', '2026-10-12');
  assert.deepEqual(before.pendingDates, ['2026-09-20', '2026-10-10']);

  const after = getReminders(
    makeState({ ...base, holidays: [makeup('2026-09-20', 'none'), makeup('2026-10-10', null)] }),
    '2026-09-19',
    '2026-10-12'
  );
  assert.deepEqual(after.pendingDates, ['2026-10-10']);
});

test('节假日期间提醒为空，且 skipped 里有 HOLIDAY', () => {
  const st = makeState({
    ...ONE_COURSE,
    sessions: [{ id: 's1', courseId: 'c1', dayOfWeek: 4, startPeriod: 1, endPeriod: 2, location: 'a', weeks: WEEKS_ALL }]
  });
  const plan = getReminders(st, '2026-10-01', '2026-10-07');
  assert.equal(plan.points.length, 0);
  assert.equal(plan.skipped.filter((s) => s.reason === 'HOLIDAY').length, 7);
});

test('未配置学期时提醒为空并给出 SEMESTER_UNCONFIGURED', () => {
  const plan = getReminders(makeState({ start: null, ...ONE_COURSE }), '2026-09-07', '2026-09-13');
  assert.equal(plan.points.length, 0);
  assert.ok(plan.skipped.some((s) => s.reason === 'SEMESTER_UNCONFIGURED'));
});

test('提前量：全局 15 分钟 → 08:00 课的触发时刻为上海墙钟 07:45', () => {
  const plan = getReminders(makeState(ONE_COURSE), '2026-09-07', '2026-09-13');
  assert.equal(plan.points.length, 1);
  const [p] = plan.points;
  assert.equal(p.classStart, '08:00');
  assert.equal(p.advanceMinutes, 15);
  const shanghai = new Date(p.triggerAt + 8 * 3600 * 1000).toISOString().slice(0, 16);
  assert.equal(shanghai, '2026-09-10T07:45');
});

test('课程级 rule 覆盖全局提前量；enabled=false 的课程不产点且不影响其他课', () => {
  const courses = [{ id: 'c1', name: '高数' }, { id: 'c2', name: '物理' }];
  const sessions = [
    { id: 's1', courseId: 'c1', dayOfWeek: 4, startPeriod: 1, endPeriod: 2, location: 'a', weeks: WEEKS_ALL },
    { id: 's2', courseId: 'c2', dayOfWeek: 4, startPeriod: 3, endPeriod: 4, location: 'b', weeks: WEEKS_ALL }
  ];
  const st = makeState({
    courses,
    sessions,
    reminder: {
      rules: [
        { id: 'r1', scope: 'course', targetId: 'c1', advanceMinutes: 30, channel: 'both', enabled: true },
        { id: 'r2', scope: 'course', targetId: 'c2', advanceMinutes: 5, channel: 'both', enabled: false }
      ]
    }
  });
  const plan = getReminders(st, '2026-09-07', '2026-09-13');
  assert.equal(plan.points.length, 1, 'enabled=false 的课程不得产点');
  assert.equal(plan.points[0].courseId, 'c1');
  assert.equal(plan.points[0].advanceMinutes, 30, '课程级提前量应覆盖全局 15');
  assert.ok(plan.skipped.some((s) => s.reason === 'RULE_DISABLED'));
});


test('advanceMinutes=1440 时触发时刻落到前一天且不报错', () => {
  const st = makeState({ ...ONE_COURSE, reminder: { defaultAdvanceMinutes: 1440 } });
  const plan = getReminders(st, '2026-09-07', '2026-09-13');
  const [p] = plan.points;
  const shanghai = new Date(p.triggerAt + 8 * 3600 * 1000).toISOString().slice(0, 16);
  assert.equal(shanghai, '2026-09-09T08:00');
  assert.ok(Number.isFinite(p.triggerAt));
});

test('节次缺失的课次不产点并记 PERIOD_MISSING', () => {
  const st = makeState({
    courses: [{ id: 'c1', name: '高数' }],
    sessions: [{ id: 's1', courseId: 'c1', dayOfWeek: 4, startPeriod: 30, endPeriod: 31, location: 'a', weeks: WEEKS_ALL }]
  });
  const plan = getReminders(st, '2026-09-10', '2026-09-10');
  assert.equal(plan.points.length, 0);
  assert.ok(plan.skipped.some((s) => s.reason === 'PERIOD_MISSING'));
  const [cls] = resolveDay(st, '2026-09-10').classes;
  assert.equal(cls.invalidPeriod, true);
});

test('周次过滤：单双周课程只在对应周出现', () => {
  const st = makeState({
    courses: [{ id: 'c1', name: '单周课' }],
    sessions: [{ id: 's1', courseId: 'c1', dayOfWeek: 4, startPeriod: 1, endPeriod: 2, location: 'a', weeks: { start: 1, end: 16, type: 'odd', extra: [] } }]
  });
  // 2026-09-10 是第 1 周（奇），2026-09-17 是第 2 周（偶）
  assert.equal(resolveDay(st, '2026-09-10').classes.length, 1);
  assert.equal(resolveDay(st, '2026-09-17').classes.length, 0);
  assert.deepEqual(expandWeeks(st.sessions[0].weeks), [1, 3, 5, 7, 9, 11, 13, 15]);
});

/* ------------------------------------------------ 内置节假日数据（G11 独立复核） */

test('内置 2026 数据：33 放假日 + 6 补班日，且逐日星期与 PRD 附录 A 一致', () => {
  const holidays = BUILTIN_2026.filter((h) => h.type === 'holiday');
  const makeups = BUILTIN_2026.filter((h) => h.type === 'makeupWorkday');
  assert.equal(holidays.length, 33);
  assert.equal(makeups.length, 6);

  // 补班日的真实星期（PRD 附录 A.2）
  const expectDow = {
    '2026-01-04': 7,
    '2026-02-14': 6,
    '2026-02-28': 6,
    '2026-05-09': 6,
    '2026-09-20': 7,
    '2026-10-10': 6
  };
  for (const [date, dow] of Object.entries(expectDow)) {
    assert.ok(makeups.some((h) => h.date === date), `缺少补班日 ${date}`);
    assert.equal(dayOfWeekOf(date), dow, `${date} 的星期与 PRD 附录 A.2 不符`);
  }

  // 只有 01-04 可推定（唯一算术解），其余必须留 null
  for (const h of makeups) {
    if (h.date === '2026-01-04') {
      assert.equal(h.followDayOfWeek, 5);
      assert.equal(h.inferred, true);
    } else {
      assert.equal(h.followDayOfWeek, null, `${h.date} 的 followDayOfWeek 必须为 null（不得猜）`);
      assert.equal(h.inferred, false);
    }
  }

  // 春节 9 天、国庆 7 天、中秋与国庆不连休（09-28~09-30 是工作日）
  assert.equal(holidays.filter((h) => h.name === '春节').length, 9);
  assert.equal(holidays.filter((h) => h.name === '国庆节').length, 7);
  for (const date of ['2026-09-28', '2026-09-29', '2026-09-30']) {
    assert.equal(holidays.some((h) => h.date === date), false, `${date} 不应出现在内置假期里`);
  }

  // 每条都要带来源与修订号（PRD US-10 AC4）
  for (const h of BUILTIN_2026) {
    assert.equal(h.source, 'builtin2026');
    assert.ok(h.dataRevision, `${h.date} 缺少 dataRevision`);
    assert.ok(h.note, `${h.date} 缺少 note`);
  }
  assert.equal(auditBuiltinHolidays().ok, true);
});
