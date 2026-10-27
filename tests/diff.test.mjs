/**
 * diff.test.mjs — 「更新课表」差异比对的契约。
 *
 * 错判的代价很高：
 *   - 把没变的课报成"变更" → 用户不敢点更新；
 *   - 把变了的课漏掉 → 用户以为更新成功，实际还在按旧课表上课。
 * 所以这里既测"该抓到的变化"，也测"不该报的噪声"（同课不同次抓取 id 变化、地点空格差异）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { diffTimetables, indexByName, normalizeName } from '../src/diff.js';

/** 造一份「课程 + 课次」的数据。 */
function build(rows) {
  const courses = [];
  const sessions = [];
  rows.forEach((row, i) => {
    const id = `c${i + 1}`;
    courses.push({ id, name: row.name, teacher: row.teacher || '' });
    row.times.forEach((t, j) => {
      sessions.push({
        id: `s${i + 1}-${j + 1}`,
        courseId: id,
        dayOfWeek: t.day,
        startPeriod: t.start,
        endPeriod: t.end,
        location: t.location || '',
        rawWeeksText: t.weeks || '',
        weeks: { start: t.w1 || 1, end: t.w2 || 16, type: 'all', extra: [] }
      });
    });
  });
  return { courses, sessions };
}

const LOCAL = build([
  { name: '高等数学', teacher: '王', times: [{ day: 1, start: 1, end: 2, location: '教三-101', weeks: '1-16周' }] },
  { name: '大学物理', teacher: '李', times: [{ day: 2, start: 3, end: 4, location: '教四-202', weeks: '1-16周' }] },
  { name: '体育', teacher: '赵', times: [{ day: 3, start: 5, end: 6, location: '操场', weeks: '1-16周' }] }
]);

test('完全一致 → 不算有变化（同课不同注 id 也不能误报）', () => {
  const fresh = build([
    // 故意换 id 与顺序，模拟"又抓了一次"
    { name: '体育', teacher: '赵', times: [{ day: 3, start: 5, end: 6, location: '操场', weeks: '1-16周' }] },
    { name: '大学物理', teacher: '李', times: [{ day: 2, start: 3, end: 4, location: '教四-202', weeks: '1-16周' }] },
    { name: '高等数学', teacher: '王', times: [{ day: 1, start: 1, end: 2, location: '教三-101', weeks: '1-16周' }] }
  ]);
  const d = diffTimetables(LOCAL, fresh);
  assert.equal(d.hasChanges, false);
  assert.equal(d.unchanged, 3);
  assert.deepEqual(d.summary, { added: 0, removed: 0, changed: 0, total: 3 });
});

test('新增 / 删除 / 三类变更都能分别识别', () => {
  const fresh = build([
    // 时间变了：1-2 节 → 3-4 节
    { name: '高等数学', teacher: '王', times: [{ day: 1, start: 3, end: 4, location: '教三-101', weeks: '1-16周' }] },
    // 地点变了
    { name: '大学物理', teacher: '李', times: [{ day: 2, start: 3, end: 4, location: '教五-303', weeks: '1-16周' }] },
    // 体育被删；新增一门课
    { name: '程序设计', teacher: '何', times: [{ day: 4, start: 7, end: 8, location: '机房', weeks: '2-15周' }] }
  ]);
  const d = diffTimetables(LOCAL, fresh);
  assert.equal(d.summary.added, 1);
  assert.equal(d.summary.removed, 1);
  assert.equal(d.summary.changed, 2);
  assert.equal(d.added[0].name, '程序设计');
  assert.equal(d.removed[0].name, '体育');

  const byName = Object.fromEntries(d.changed.map((c) => [c.name, c]));
  assert.deepEqual(byName['高等数学'].fields, ['时间']);
  assert.deepEqual(byName['大学物理'].fields, ['地点']);
});

test('周次变化单独识别（节次地点都没动）', () => {
  const fresh = build([
    { name: '高等数学', teacher: '王', times: [{ day: 1, start: 1, end: 2, location: '教三-101', weeks: '1-8周', w1: 1, w2: 8 }] },
    { name: '大学物理', teacher: '李', times: [{ day: 2, start: 3, end: 4, location: '教四-202', weeks: '1-16周' }] },
    { name: '体育', teacher: '赵', times: [{ day: 3, start: 5, end: 6, location: '操场', weeks: '1-16周' }] }
  ]);
  const d = diffTimetables(LOCAL, fresh);
  assert.equal(d.summary.changed, 1);
  assert.equal(d.changed[0].name, '高等数学');
  assert.deepEqual(d.changed[0].fields, ['周次']);
});

test('多时段课程：加了一个时间段算时间变更', () => {
  const local = build([
    { name: '英语', teacher: '宋', times: [{ day: 2, start: 6, end: 7, location: '教二-101', weeks: '1-16周' }] }
  ]);
  const fresh = build([
    {
      name: '英语',
      teacher: '宋',
      times: [
        { day: 2, start: 6, end: 7, location: '教二-101', weeks: '1-16周' },
        { day: 4, start: 6, end: 7, location: '教二-101', weeks: '1-16周' }
      ]
    }
  ]);
  const d = diffTimetables(local, fresh);
  assert.equal(d.summary.changed, 1);
  assert.ok(d.changed[0].fields.includes('时间'));
  assert.equal(d.changed[0].after.meetings.length, 2);
});

test('首次使用（本地为空）→ 全是新增，不算"对比失败"', () => {
  const d = diffTimetables({ courses: [], sessions: [] }, LOCAL);
  assert.equal(d.summary.added, 3);
  assert.equal(d.summary.removed, 0);
  assert.equal(d.hasChanges, true);
});

test('空草稿 → 不能把本地全判成删除（调用方据此判定失败）', () => {
  const d = diffTimetables(LOCAL, { courses: [], sessions: [] });
  assert.equal(d.summary.added, 0);
  assert.equal(d.summary.removed, 3);
  assert.equal(d.summary.total, 0, 'total=0 说明新课表为空，UI 必须当成对比失败而不是"全部删除"');
});

test('课程名归一化：空格 / 全角空格不影响匹配', () => {
  assert.equal(normalizeName(' 高等 数学　'), '高等数学');
  const local = build([{ name: '高等数学', times: [{ day: 1, start: 1, end: 2, location: 'A', weeks: '1-16周' }] }]);
  const fresh = build([{ name: '高等 数学', times: [{ day: 1, start: 1, end: 2, location: 'A', weeks: '1-16周' }] }]);
  const d = diffTimetables(local, fresh);
  assert.equal(d.hasChanges, false, '名字里多空格不该算新课程');
});

test('indexByName：没有课次的课程不进索引（避免幽灵条目）', () => {
  const idx = indexByName([{ id: 'x', name: '空课' }], []);
  assert.equal(idx.size, 0);
});
