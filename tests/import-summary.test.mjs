/**
 * import-summary.test.mjs — 「按课程聚合」列表的契约。
 *
 * 抓取结果是课次列表，用户要确认的是课程列表：一门课一块，时间和周次各一行。
 * 聚合错了会直接误导确认（比如把两个时段合并成一条、丢周次）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCourseSummary } from '../src/ui/import.js';

const draft = {
  courses: [
    { id: 'c1', name: '数学分析', teacher: '李晓莉' },
    { id: 'c2', name: '基础综合英语', teacher: '' },
    { id: 'c3', name: '没排课的课', teacher: '某人' }
  ],
  sessions: [
    {
      courseId: 'c1',
      dayOfWeek: 2,
      startPeriod: 2,
      endPeriod: 4,
      rawWeeksText: '4-19(周)',
      location: '教学实验综合楼-S210'
    },
    {
      courseId: 'c1',
      dayOfWeek: 5,
      startPeriod: 8,
      endPeriod: 10,
      rawWeeksText: '4-7,9-19(周)',
      location: '教学实验综合楼-N209'
    },
    {
      courseId: 'c2',
      dayOfWeek: 2,
      startPeriod: 6,
      endPeriod: 7,
      rawWeeksText: '4-19(周)',
      teacher: '宋媛',
      location: '智慧教学楼-413'
    }
  ]
};

test('一门课聚合成一块，多个时段各自一行', () => {
  const items = buildCourseSummary(draft);
  assert.equal(items.length, 2, '没有课次的课程不应出现');
  const math = items.find((i) => i.id === 'c1');
  assert.equal(math.meetings.length, 2);
  assert.equal(math.meetings[0].day, 2, '时段按星期升序');
  assert.equal(math.meetings[1].day, 5);
  assert.equal(math.weeksText, '4-19(周) / 4-7,9-19(周)', '两个时段的周次都要保留');
});

test('教师缺失时从课次里补', () => {
  const items = buildCourseSummary(draft);
  const eng = items.find((i) => i.id === 'c2');
  assert.equal(eng.teacher, '宋媛', '课程没教师时用课次里的教师');
});

test('按课程名排序、空输入安全', () => {
  const names = buildCourseSummary(draft).map((i) => i.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
  assert.deepEqual(buildCourseSummary(null), []);
  assert.deepEqual(buildCourseSummary({}), []);
  assert.deepEqual(buildCourseSummary({ courses: [{ id: 'x', name: 'x' }] }), [], '没有课次的课程不出现');
});

test('节次区间原样带出（含三连节）', () => {
  const items = buildCourseSummary(draft);
  const math = items.find((i) => i.id === 'c1');
  assert.deepEqual(
    math.meetings.map((m) => [m.start, m.end]),
    [
      [2, 4],
      [8, 10]
    ]
  );
});
