/**
 * merge-courses.test.mjs — 同名课程合并（去掉教学班后缀后同名）。
 *
 * 教务按教学班建课：「数学分析(上) O」「数学分析(上) P」「数学分析(上)」三条，
 * 对用户就是一节课。选择课程时不该让他从三个同名项里挑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeSameNameCourses } from '../src/model.js';

const course = (id, name, teacher = null) => ({
  id,
  name,
  teacher,
  color: null,
  note: null,
  credit: null
});

test('同名的三条合成一条，课次与调整记录一起改指向', () => {
  const state = {
    courses: [
      course('c1', '数学分析(上) O', '李晓莉'),
      course('c2', '数学分析(上) P'),
      course('c3', '数学分析(上)'),
      course('c4', '线性代数', '沈冲')
    ],
    sessions: [
      { id: 's1', courseId: 'c1' },
      { id: 's2', courseId: 'c2' },
      { id: 's3', courseId: 'c3' },
      { id: 's4', courseId: 'c4' }
    ],
    adjustments: [
      { id: 'a1', type: 'makeup', courseId: 'c2' },
      { id: 'a2', type: 'cancel', targetSessionId: 's4' }
    ]
  };

  const out = mergeSameNameCourses(state);

  assert.equal(out.courses.length, 2, '三条同名应合成一条');
  assert.equal(out.courses[0].id, 'c1', '保留最先出现那条的 id');
  assert.equal(out.courses[0].name, '数学分析(上)', '名称统一成基础名');
  assert.equal(out.courses[0].teacher, '李晓莉', '教师保留');
  assert.deepEqual(
    out.sessions.map((s) => s.courseId),
    ['c1', 'c1', 'c1', 'c4'],
    '课次全部改指向保留的课程'
  );
  assert.equal(out.adjustments[0].courseId, 'c1', '补课记录的 courseId 也要改');
  assert.equal(out.adjustments[1].courseId, undefined, '无关的调整记录不动');
});

test('幂等：再跑一次没有任何变化，且返回同一个对象引用', () => {
  const state = {
    courses: [course('c1', '数学分析(上) O'), course('c2', '数学分析(上) P')],
    sessions: [{ id: 's1', courseId: 'c1' }, { id: 's2', courseId: 'c2' }],
    adjustments: []
  };

  const once = mergeSameNameCourses(state);
  assert.equal(once.courses.length, 1);

  const twice = mergeSameNameCourses(once);
  assert.equal(twice, once, '没有可合并的应原样返回，避免无谓重渲染');
});

test('不该误伤：末尾数字、全角括号、无关课名都不动', () => {
  const state = {
    courses: [
      course('a', '大学生心理健康1'),
      course('b', '人工智能导论（上）'),
      course('c', '信息通信概论 A'),
      course('d', '信息通信概论'),
      course('e', '国家安全教育（下）')
    ],
    sessions: [],
    adjustments: []
  };

  const out = mergeSameNameCourses(state);
  const names = out.courses.map((c) => c.name);

  assert.ok(names.includes('大学生心理健康1'), '末尾数字不是教学班后缀');
  assert.ok(names.includes('人工智能导论（上）'), '括号内容属于课名');
  assert.ok(names.includes('国家安全教育（下）'));
  assert.equal(names.filter((n) => n === '信息通信概论').length, 1, 'A 后缀去掉后应与基础名合并');
  assert.equal(out.courses.length, 4);
});

test('没有同名的保持原样（不复制、不改引用）', () => {
  const state = {
    courses: [course('c1', '线性代数'), course('c2', '基础综合英语')],
    sessions: [{ id: 's1', courseId: 'c1' }],
    adjustments: []
  };
  assert.equal(mergeSameNameCourses(state), state);
});
