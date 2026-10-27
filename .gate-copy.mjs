/**
 * .gate-copy.mjs — G18：文案可读性（运行时，7 状态全覆盖）。
 * 退出码：0 PASS / 1 文案或状态不符 / 2 门禁自身故障。
 * 规范来源：docs/TASKS.md §3 G18 参考脚本（样本用真实 state 跑出，不手写假 Day）。
 */
let C, M;
try {
  [C, M] = await Promise.all([import('./src/calendar.js'), import('./src/model.js')]);
} catch (e) {
  console.log('GATE18: BROKEN');
  console.log('  load-failed: ' + (e && e.message));
  process.exit(2);
}

const base = (over = {}) => {
  const st = M.emptyState();
  st.settings.semesterStartMonday = over.start === undefined ? '2026-09-07' : over.start;
  st.settings.totalWeeks = 20;
  st.settings.makeupWorkdayMode = over.mode || 'followWeekday';
  st.holidays = over.holidays || [];
  return st;
};
const makeup = (date, follow) => ({ date, name: '测试调休上班', type: 'makeupWorkday', followDayOfWeek: follow, source: 'manual' });

const cases = [
  ['normal', base(), '2026-09-08'],
  ['holiday_silent', base(), '2026-10-01'],
  ['makeup_unconfirmed', base(), '2026-10-10'],
  ['makeup_follow', base({ holidays: [makeup('2026-09-13', 5)] }), '2026-09-13'],
  ['makeup_skipped', base({ holidays: [makeup('2026-09-19', 'none')] }), '2026-09-19'],
  ['makeup_skipped', base({ mode: 'skip', holidays: [makeup('2026-09-26', 5)] }), '2026-09-26'],
  ['out_of_semester', base(), '2027-03-01'],
  ['unconfigured', base({ start: null }), '2026-09-08']
];

const DROSS = /undefined|null|NaN|\[object/;
const bad = [];
for (const [wantStatus, st, date] of cases) {
  const day = C.resolveDay(st, date);
  const tag = wantStatus + '@' + date;
  if (day.status !== wantStatus) {
    bad.push(tag + ' → status=' + day.status + '（样本没走到目标分支，断言会平凡通过）');
    continue;
  }

  const n = day.notice;
  if (wantStatus === 'normal') {
    if (n !== null) bad.push(tag + ' → notice 应为严格 null，得到 ' + JSON.stringify(n));
    continue;
  }
  if (typeof n !== 'string') {
    bad.push(tag + ' → notice 不是 string 也不是 null：' + typeof n);
    continue;
  }
  if (DROSS.test(n)) bad.push(tag + ' → 文案含脏值：' + n);
  if (/\s{2,}/.test(n)) bad.push(tag + ' → 文案含连续空白：' + JSON.stringify(n));

  if (wantStatus === 'makeup_unconfirmed' && !(/\d{1,2}/.test(n) && /（周[一二三四五六日]）/.test(n)))
    bad.push(tag + ' → 文案缺少"日期+星期"，可能是忘了把 date 传进 NOTICE：' + n);
  if (wantStatus === 'makeup_follow' && !/周[一二三四五六日]/.test(n)) bad.push(tag + ' → 文案缺少"周X"，effectiveDayOfWeek 可能没传到：' + n);
  if (wantStatus === 'makeup_skipped' && !/调休上班日/.test(n)) bad.push(tag + ' → 文案缺少主语：' + n);
}

console.log(bad.length ? 'GATE18: FAIL' : 'GATE18: PASS');
console.log(bad.length ? '  ' + bad.join('\n  ') : '  ' + cases.length + ' 样本，文案与状态全部符合');
process.exitCode = bad.length ? 1 : 0;
