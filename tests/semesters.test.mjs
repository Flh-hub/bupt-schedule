/**
 * semesters.test.mjs — 学期起始日自动识别的契约。
 *
 * 背景：教务系统没有任何免登录的校历接口（实测每条路径都只返回登录页），课表页里
 * 只有一个学期代码 `2026-2027-1`。所以策略是「认代码 → 查内置校历 → 命中就用，
 * 查不到就按页面上的『第 N 周』反推，再不行就明确告诉用户去手填」——绝不猜日期。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEMESTERS,
  detectSemester,
  findSemester,
  firstMondayOf,
  inferFromCurrentWeek,
  resolveSemester
} from '../src/semesters.js';

test('内置校历：2026-2027 第一学期第 1 周周一 = 2026-08-31', () => {
  const entry = findSemester('2026-2027-1');
  assert.ok(entry, '缺少 2026-2027-1');
  assert.equal(entry.confirmed, true);
  assert.equal(entry.firstMonday, '2026-08-31');
  assert.equal(firstMondayOf('2026-2027-1'), '2026-08-31');
});

test('内置校历的每一项都要能自证（来源 + confirmed + 有日期或明确待确认）', () => {
  assert.ok(SEMESTERS.length >= 1);
  for (const s of SEMESTERS) {
    assert.match(s.code, /^20\d{2}-20\d{2}-[12]$/, `学期代码不规范：${s.code}`);
    assert.ok(String(s.source || '').length > 4, `${s.code} 缺少来源`);
    if (s.confirmed) assert.match(s.firstMonday, /^\d{4}-\d{2}-\d{2}$/, `${s.code} 日期不合法`);
    else assert.equal(s.firstMonday, null, `${s.code} 未确认却给了日期`);
  }
});

test('学期代码识别：横线 / 全角 / 学年+第X学期 都能认', () => {
  assert.equal(detectSemester('学年学期: 2026-2027-1'), '2026-2027-1');
  assert.equal(detectSemester('学年学期: 2026—2027—1'), '2026-2027-1');
  assert.equal(detectSemester('2026－2027－2'), '2026-2027-2');
  assert.equal(detectSemester('2026-2027学年第一学期'), '2026-2027-1');
  assert.equal(detectSemester('2026-2027学年 第2学期'), '2026-2027-2');
  assert.equal(detectSemester('没有学期信息'), null);
});

test('不能把课程周次里的数字当学期（4-19周 之类）', () => {
  assert.equal(detectSemester('4-19(周)[06-07节]'), null);
  assert.equal(detectSemester('第1节 08:00-08:45'), null);
});

test('resolveSemester：命中内置校历 → confirmed', () => {
  const r = resolveSemester('<div>学年学期：2026-2027-1</div>', '2026-10-23');
  assert.equal(r.code, '2026-2027-1');
  assert.equal(r.firstMonday, '2026-08-31');
  assert.equal(r.source, 'calendar');
  assert.equal(r.confirmed, true);
});

test('内置校历没有的学期 → 按「当前第 N 周」反推', () => {
  // 2026-10-23 是周五；第 8 周的周一 = 10-19，第 1 周周一 = 10-19 - 7*7 = 08-31
  const r = resolveSemester('学年学期：2026-2027-1 当前周次：第8周', '2026-10-23');
  assert.equal(r.firstMonday, '2026-08-31');

  const r2 = resolveSemester('2027-2028-1 当前周次：第3周', '2027-09-15');
  assert.equal(r2.code, '2027-2028-1');
  assert.equal(r2.source, 'current-week');
  assert.equal(r2.confirmed, false);
  assert.equal(r2.firstMonday, '2027-08-30', '2027-09-15(周三) 第3周 → 第1周周一 2027-08-30');
});

test('反推只认明确标签，不认下拉框里的「第1周…第22周」', () => {
  const dropdown = '<option>第1周</option><option>第2周</option><option>第3周</option>';
  assert.equal(inferFromCurrentWeek(dropdown, '2026-10-23'), null);
  assert.equal(inferFromCurrentWeek('本周为第 5 周', '2026-10-23').week, 5);
});

test('什么都没有 → 不猜，返回空并给出可解释的 note', () => {
  const r = resolveSemester('<div>课表</div>', '2026-10-23');
  assert.equal(r.firstMonday, null);
  assert.equal(r.source, null);
  assert.equal(r.confirmed, false);
});

test('日期越界保护：周次 0 / 40 不接受', () => {
  assert.equal(inferFromCurrentWeek('当前周次：第0周', '2026-10-23'), null);
  assert.equal(inferFromCurrentWeek('当前周次：第40周', '2026-10-23'), null);
});

/* -------------------------------------------------- 周视图锚点（第 8 周不能显示成第 1 周） */

import { currentWeekOffset, getWeekView } from '../src/calendar.js';
import { emptyState } from '../src/model.js';

const stateWith = (start, totalWeeks = 20) => {
  const st = emptyState();
  st.settings.semesterStartMonday = start;
  st.settings.totalWeeks = totalWeeks;
  return st;
};

test('currentWeekOffset：今天在 2026-10-23 → 第 8 周（offset 7）', () => {
  const st = stateWith('2026-08-31');
  assert.equal(currentWeekOffset(st, '2026-10-23'), 7);
});

test('currentWeekOffset：开学前 / 未配置 / 超出总周数都被夹住', () => {
  const st = stateWith('2026-08-31', 20);
  assert.equal(currentWeekOffset(st, '2026-08-01'), 0, '开学前应停在第 1 周');
  assert.equal(currentWeekOffset(stateWith(null), '2026-10-23'), 0, '未配置学期应回落到 0');
  assert.equal(currentWeekOffset(st, '2027-06-01'), 19, '超出总周数应夹到最大值');
});

test('周视图：offset=7 才是本周，offset=0 不是本周', () => {
  const st = stateWith('2026-08-31');
  const current = getWeekView(st, 7, '2026-10-23');
  assert.equal(current.weekNo, 8);
  assert.equal(current.isCurrentWeek, true);
  assert.equal(current.monday, '2026-10-19');

  const first = getWeekView(st, 0, '2026-10-23');
  assert.equal(first.weekNo, 1);
  assert.equal(first.isCurrentWeek, false, '第 1 周不能自称「本周」');
});
