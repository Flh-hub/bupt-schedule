/**
 * tests/course-merge.test.mjs — 「单课程提醒」列表里的同名课程合并。
 *
 * 教务系统按教学班分记录：同一门课会导入成 `数学分析(上) O` / `数学分析(上) P` /
 * `数学分析(上)` 三四条。对单个学生来说这是同一门课，列表里平铺多行纯属噪音。
 * 这里守两件事：
 *  1. 规范化只砍「空格 + 单个大写字母」的教学班后缀，别把课程名本身砍坏；
 *  2. 只有真的出现 ≥2 条同名才合并 —— 单条的保留原名，不吃掉班级信息。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { groupCourses, normalizeCourseName } from '../src/ui/reminderView.js';

/* ---------------------------------------------------------------- 名称规范化 */

test('规范化：去掉教学班后缀（空格 + 单个大写字母）', () => {
  assert.equal(normalizeCourseName('数学分析(上) O'), '数学分析(上)');
  assert.equal(normalizeCourseName('数学分析(上) P'), '数学分析(上)');
  assert.equal(normalizeCourseName('线性代数 A'), '线性代数');
});

test('规范化：多空格、前后空格一并收拾', () => {
  assert.equal(normalizeCourseName('  数学分析(上)   P  '), '数学分析(上)');
});

test('规范化：不动课程名本身', () => {
  // 末尾是数字 —— 是课程名的一部分（不同课程），不能当后缀砍
  assert.equal(normalizeCourseName('大学生心理健康1'), '大学生心理健康1');
  // 没有后缀
  assert.equal(normalizeCourseName('线性代数'), '线性代数');
  // 括号里的 (上)/(下) 是不同课程，必须保留
  assert.equal(normalizeCourseName('数学分析(上)'), '数学分析(上)');
  assert.equal(normalizeCourseName('国家安全教育（下）'), '国家安全教育（下）');
  // 空值安全
  assert.equal(normalizeCourseName(''), '');
  assert.equal(normalizeCourseName(null), '');
});

/* ---------------------------------------------------------------- 分组 */

test('分组：三门数学分析合并成一组，名字取规范化结果', () => {
  const courses = [
    { id: 'c1', name: '数学分析(上) O' },
    { id: 'c2', name: '数学分析(上) P' },
    { id: 'c3', name: '数学分析(上)' }
  ];
  const groups = groupCourses(courses);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, '数学分析(上)');
  assert.deepEqual(groups[0].ids, ['c1', 'c2', 'c3']);
  assert.equal(groups[0].courses.length, 3);
});

test('分组：只出现一条时保留原名（不吃掉班级信息）', () => {
  const groups = groupCourses([{ id: 'c1', name: '线性代数 A' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, '线性代数 A'); // 没合并就不改名
  assert.deepEqual(groups[0].ids, ['c1']);
});

test('分组：不同课程不会被误合并', () => {
  const courses = [
    { id: 'c1', name: '数学分析(上)' },
    { id: 'c2', name: '数学分析(下)' },
    { id: 'c3', name: '线性代数' },
    { id: 'c4', name: '大学生心理健康1' }
  ];
  assert.equal(groupCourses(courses).length, 4);
});

test('分组：保持首次出现的顺序，空输入安全', () => {
  const groups = groupCourses([
    { id: 'a', name: '线性代数' },
    { id: 'b', name: '数学分析(上) O' },
    { id: 'c', name: '数学分析(上) P' }
  ]);
  assert.deepEqual(
    groups.map((g) => g.name),
    ['线性代数', '数学分析(上)']
  );
  assert.deepEqual(groupCourses([]), []);
  assert.deepEqual(groupCourses(null), []);
});

test('分组：组内 ids 与 courses 一一对应（保存规则时按 ids 批量写）', () => {
  const groups = groupCourses([
    { id: 'x1', name: '概率论 A' },
    { id: 'x2', name: '概率论 B' }
  ]);
  assert.equal(groups[0].ids.length, groups[0].courses.length);
  groups[0].ids.forEach((id, i) => assert.equal(groups[0].courses[i].id, id));
});

/* ---------------------------------------------------------------- 通用性 */

// 合并规则只看课名形状，不认具体是哪门课 —— 换一门课、换个学期同样生效。
// 下面这两条就是钉住"不是给数学分析写死的"。

test('通用：换成完全不同的课程，同样的后缀模式照样自动合并', () => {
  const groups = groupCourses([
    { id: 'p1', name: '大学物理(下) A' },
    { id: 'p2', name: '大学物理(下) B' },
    { id: 'p3', name: '数据结构 C' }
  ]);
  const names = groups.map((g) => g.name);
  assert.deepEqual(names, ['大学物理(下)', '数据结构 C']); // 单条的数据结构保留原名
  assert.equal(groups[0].ids.length, 2);
});

test('通用：多组同时存在时各自归组，不会串到一起', () => {
  const groups = groupCourses([
    { id: 'a1', name: '线性代数(上) O' },
    { id: 'a2', name: '线性代数(上) P' },
    { id: 'b1', name: '概率论 A' },
    { id: 'b2', name: '概率论 B' },
    { id: 'c1', name: '体育' }
  ]);
  assert.deepEqual(
    groups.map((g) => [g.name, g.ids.length]),
    [
      ['线性代数(上)', 2],
      ['概率论', 2],
      ['体育', 1]
    ]
  );
});

test('边界：只有一条同名时不合并，名字原样保留', () => {
  const groups = groupCourses([{ id: 'x', name: '马克思主义基本原理 X' }]);
  assert.equal(groups[0].name, '马克思主义基本原理 X');
});
