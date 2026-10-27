/**
 * .gate-shape.mjs — G16 / G14 运行时契约门禁（docs/TASKS.md §3）。
 *
 * 用法：`node .gate-shape.mjs`，看**退出码**：
 *   0  PASS     契约符合
 *   1  FAIL     字段缺失 / 状态不对 / 被测实现抛错（含抛错位置）
 *   2  BROKEN   模块根本加载不进来（门禁失去被测对象）
 *
 * 为什么要有这个脚本：`resolveDay` 返回数组还是对象、`notice` 里字段名是 `effectiveDow`
 * 还是 `effectiveDayOfWeek`，这些差异**都不抛错**——只是静默渲染错的东西。
 * 只有把形状钉死，才能让"未知 vs 确定没课"这件事在 CI 里可验证。
 */

const ROWS = [
  { date: '2026-10-10', start: '2026-09-07', label: '周六补班未确认' },
  { date: '2026-09-20', start: '2026-09-07', label: '周日补班未确认' },
  { date: '2026-10-01', start: '2026-09-07', label: '国庆假期' },
  { date: '2026-01-04', start: '2025-09-01', label: '推定按周五' }
];

let C;
let M;
try {
  [C, M] = await Promise.all([import('./src/calendar.js'), import('./src/model.js')]);
} catch (err) {
  console.log('GATE16: BROKEN 模块加载失败 →', err && err.message);
  process.exit(2);
}

const FIELDS = [
  'date',
  'weekNo',
  'status',
  'complete',
  'notice',
  'holidayName',
  'followDayOfWeek',
  'effectiveDayOfWeek',
  'classes'
];
const STATUS_ENUM = [
  'normal',
  'holiday_silent',
  'makeup_unconfirmed',
  'makeup_skipped',
  'makeup_follow',
  'out_of_semester',
  'unconfigured'
];

/** 造一份最小可判定 state（周四 1-2 节 + 周五 5-6 节，覆盖"按周五"分支）。 */
function makeState(start) {
  const state = M.emptyState();
  state.settings.semesterStartMonday = start;
  state.settings.totalWeeks = 20;
  state.courses = [{ id: 'c1', name: '高等数学', teacher: '王老师', createdAt: 'x', updatedAt: 'x' }];
  state.sessions = [
    {
      id: 's1',
      courseId: 'c1',
      dayOfWeek: 4,
      startPeriod: 1,
      endPeriod: 2,
      location: '教三-201',
      weeks: { start: 1, end: 20, type: 'all', extra: [] },
      rawWeeksText: '1-20周',
      teacher: null,
      sourceRef: 'gate'
    },
    {
      id: 's2',
      courseId: 'c1',
      dayOfWeek: 5,
      startPeriod: 5,
      endPeriod: 6,
      location: '教三-101',
      weeks: { start: 1, end: 20, type: 'all', extra: [] },
      rawWeeksText: '1-20周',
      teacher: null,
      sourceRef: 'gate'
    }
  ];
  return state;
}

const failures = [];
const fail = (msg) => failures.push(msg);

// ---------- 1. 逐日形状 + 状态 ----------
const days = {};
for (const row of ROWS) {
  const state = makeState(row.start);
  try {
    days[row.date] = C.resolveDay(state, row.date);
  } catch (err) {
    console.log(`GATE16: FAIL resolveDay(${row.date}) 抛错 → ${err && err.message}`);
    console.log('  抛错位置见上方 stack；NOTICE 只应读 Day 的契约字段名（date/effectiveDayOfWeek/…）。');
    process.exit(1);
  }
}

for (const row of ROWS) {
  const d = days[row.date];
  const miss = FIELDS.filter((k) => !(k in Object(d)));
  if (miss.length) fail(`${row.date}（${row.label}）缺字段：${miss.join(',')}`);
  if (!STATUS_ENUM.includes(d.status)) fail(`${row.date} status 非法：${d.status}`);
  if (!Array.isArray(d.classes)) fail(`${row.date} classes 不是数组`);
  if (typeof d.complete !== 'boolean') fail(`${row.date} complete 不是布尔`);
  if (typeof d.notice !== 'string' && d.notice !== null) fail(`${row.date} notice 类型非法`);
  if (typeof d.notice === 'string' && /undefined|NaN/.test(d.notice)) {
    fail(`${row.date} notice 文案含 undefined/NaN：「${d.notice}」`);
  }
}

// ---------- 2. 四个样本的语义断言 ----------
const d10 = days['2026-10-10'];
const d20 = days['2026-09-20'];
const d01 = days['2026-10-01'];
const d04 = days['2026-01-04'];

if (d10.status !== 'makeup_unconfirmed') fail(`10-10 应为 makeup_unconfirmed，实际 ${d10.status}`);
if (d10.complete !== false) fail('10-10 的 complete 必须为 false');
if (d10.effectiveDayOfWeek !== null) fail('10-10 的 effectiveDayOfWeek 必须为 null（不得用真实星期兜底）');
if (!Array.isArray(d10.classes) || d10.classes.length !== 0) fail('10-10 的 classes 必须为 []');
if (String(d10.notice || '').includes('无课')) fail('10-10 的 notice 不得出现"无课"');
if (!String(d10.notice || '').includes('请确认')) fail('10-10 的 notice 应提示"请确认"');

if (d20.status !== 'makeup_unconfirmed') fail(`09-20 应为 makeup_unconfirmed，实际 ${d20.status}`);
if (d20.complete !== false) fail('09-20 的 complete 必须为 false');
if (d20.effectiveDayOfWeek !== null) fail('09-20 的 effectiveDayOfWeek 必须为 null');
if (String(d20.notice || '').includes('无课')) fail('09-20 的 notice 不得出现"无课"');

if (d01.status !== 'holiday_silent') fail(`10-01 应为 holiday_silent，实际 ${d01.status}`);
if (d01.complete !== true) fail('10-01 的 complete 必须为 true（允许说"无课"）');
if (!Array.isArray(d01.classes) || d01.classes.length !== 0) fail('10-01 的 classes 必须为 []');
if (!String(d01.notice || '').includes('今日无课')) fail('10-01 的 notice 应含"今日无课"');

if (d04.status !== 'makeup_follow') fail(`01-04 应为 makeup_follow，实际 ${d04.status}`);
if (d04.effectiveDayOfWeek !== 5) fail(`01-04 的 effectiveDayOfWeek 应为 5，实际 ${d04.effectiveDayOfWeek}`);
if (d04.complete !== true) fail('01-04 的 complete 必须为 true');
if (!String(d04.notice || '').includes('按周五')) fail(`01-04 的 notice 应按周五：「${d04.notice}」`);

// ---------- 3. NOTICE 键集与值类型（G14） ----------
const noticeKeys = Object.keys(C.NOTICE || {}).sort();
const expectedKeys = [...STATUS_ENUM].sort();
if (JSON.stringify(noticeKeys) !== JSON.stringify(expectedKeys)) {
  fail(`NOTICE 键集合不一致：${noticeKeys.join(',')} vs ${expectedKeys.join(',')}`);
}
for (const key of noticeKeys) {
  if (typeof C.NOTICE[key] !== 'function') fail(`NOTICE.${key} 必须是函数`);
}

// ---------- 4. makeup_skipped 两条来源文案必须不同 ----------
const skippedNone = C.NOTICE.makeup_skipped
  ? C.NOTICE.makeup_skipped({
      date: '2026-10-10',
      status: 'makeup_skipped',
      effectiveDayOfWeek: null,
      holidayName: '国庆调休上班'
    })
  : '';
const skippedHint = C.NOTICE.makeup_skipped
  ? C.NOTICE.makeup_skipped({
      date: '2026-01-04',
      status: 'makeup_skipped',
      effectiveDayOfWeek: 5,
      holidayName: '元旦调休上班'
    })
  : '';
if (skippedNone === skippedHint) fail('makeup_skipped 的两种来源文案相同（应为"今日无课" vs "本应按周X"）');
if (String(skippedNone).includes('按周')) fail(`'none' 分支不得拼"按周X"：「${skippedNone}」`);
if (!String(skippedHint).includes('按周五')) fail(`1..7+skip 分支应含"按周五"：「${skippedHint}」`);

// ---------- 5. getReminders 计划对象 ----------
try {
  const plan = C.getReminders(makeState('2026-09-07'), '2026-09-19', '2026-10-12');
  for (const key of ['points', 'pendingDates', 'skipped', 'warnings']) {
    if (!(key in plan)) fail(`getReminders 缺少 ${key}`);
  }
  if (!Array.isArray(plan.points)) fail('plan.points 不是数组');
  if (!plan.pendingDates.includes('2026-09-20') || !plan.pendingDates.includes('2026-10-10')) {
    fail(`plan.pendingDates 应含 09-20 与 10-10，实际 ${JSON.stringify(plan.pendingDates)}`);
  }
  if (!plan.warnings.length) fail('plan.warnings 应非空');
  if (plan.points.some((p) => p.date === '2026-10-10' || p.date === '2026-09-20')) {
    fail('待确认补班日不得产生提醒点');
  }
} catch (err) {
  fail(`getReminders 抛错：${err && err.message}`);
}

// ---------- 收尾 ----------
if (failures.length) {
  console.log('GATE16: FAIL');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
console.log('GATE16: PASS');
console.log('  9 字段齐全 / status ∈ 7 值 / 4 个样本语义正确 / NOTICE 7 键全函数 / plan 对象齐全');
process.exit(0);
