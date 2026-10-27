/**
 * tests/timetable-display.test.mjs — 课表格子的「展示层」纯函数。
 *
 * 这里不测渲染（那要 DOM），只测三件容易悄悄退化的事：
 *  1. 地点拆「楼栋 + 教室」：只给房间号用户不知道该进哪个楼；
 *  2. 同格同名课程去重：一门课被拆成多条 session 时不能印两遍；
 *  3. 课程配色派生：导入课的 `color` 是 null，必须靠 courseColor 兜住，
 *     否则整张课表会变成同一个颜色。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { dedupeCourses, locationHtml, locationText, splitLocation } from '../src/ui/timetable.js';
import { PALETTE, courseColor } from '../src/model.js';

/* ---------------------------------------------------------------- 地点拆分 */

test('地点：横杠分隔 → 楼栋 + 教室', () => {
  assert.deepEqual(splitLocation('教三-201'), { building: '教三', room: '201' });
  assert.deepEqual(splitLocation('主楼-A101'), { building: '主楼', room: 'A101' });
  assert.deepEqual(splitLocation('教四－105'), { building: '教四', room: '105' }); // 全角横杠
});

test('地点：空格分隔 → 楼栋 + 教室', () => {
  assert.deepEqual(splitLocation('教三 301'), { building: '教三', room: '301' });
});

test('地点：没有分隔符也能拆（末尾房间号前就是楼栋）', () => {
  // 教务系统经常不带横杠：教三201 / 教学楼A305
  assert.deepEqual(splitLocation('教三201'), { building: '教三', room: '201' });
  assert.deepEqual(splitLocation('教学楼A305'), { building: '教学楼A', room: '305' });
  assert.deepEqual(splitLocation('主楼B101'), { building: '主楼B', room: '101' });
});

test('地点：没有房间号时整串当教室（不硬拆）', () => {
  // 「体育馆二层」没有数字房间号，硬拆只会拆错
  assert.deepEqual(splitLocation('体育馆二层'), { building: '', room: '体育馆二层' });
});

test('地点：空值 → 地点待定', () => {
  assert.deepEqual(splitLocation(''), { building: '', room: '' });
  assert.deepEqual(splitLocation(null), { building: '', room: '' });
  assert.equal(locationText(''), '地点待定');
  assert.equal(locationText(null), '地点待定');
});

test('地点文案：楼栋与教室都在，中间一个空格', () => {
  assert.equal(locationText('教三-201'), '教三 201');
  assert.equal(locationText('主楼 A101'), '主楼 A101');
  assert.equal(locationText('教三201'), '教三 201');
  // ★ 老实现只取横杠后半段，`教三-201` 会退化成 `201`（不知道该进哪个楼）
  assert.notEqual(locationText('教三-201'), '201');
});

test('地点 HTML：楼栋与教室各占一行，都要出现', () => {
  const html = locationHtml('教学楼A305');
  assert.ok(html.includes('教学楼A'), '楼栋必须出现');
  assert.ok(html.includes('305'), '教室必须出现');
  // 两个独立元素才能各占一行（CSS 用 flex-column 排）
  assert.ok(html.includes('b-bld') && html.includes('b-room'));
});

test('地点 HTML：空地点给「地点待定」', () => {
  assert.equal(locationHtml(''), '<span class="b-loc">地点待定</span>');
});

/* ---------------------------------------------------------------- 同格去重 */

test('同格同名课程（不同 session）→ 只保留一条', () => {
  const list = [
    { courseId: 'c1', courseName: '高等数学(上)', startPeriod: 3 },
    { courseId: 'c1', courseName: '高等数学(上)', startPeriod: 3 }
  ];
  const out = dedupeCourses(list);
  assert.equal(out.length, 1);
  assert.equal(out[0].courseName, '高等数学(上)');
});

test('同格不同课程 → 全部保留（真冲突要看得见）', () => {
  const list = [
    { courseId: 'c1', courseName: '程序设计' },
    { courseId: 'c2', courseName: '基础英语' }
  ];
  assert.equal(dedupeCourses(list).length, 2);
});

test('活动没有 courseId → 按课程名去重', () => {
  const list = [
    { courseId: null, courseName: '班会' },
    { courseId: null, courseName: '班会' },
    { courseId: null, courseName: '社团例会' }
  ];
  assert.equal(dedupeCourses(list).length, 2);
});

test('去重保持原顺序，空输入安全', () => {
  const list = [{ courseId: 'c2', courseName: 'B' }, { courseId: 'c1', courseName: 'A' }];
  assert.deepEqual(dedupeCourses(list).map((c) => c.courseId), ['c2', 'c1']);
  assert.deepEqual(dedupeCourses(null), []);
  assert.deepEqual(dedupeCourses([]), []);
});

/* ---------------------------------------------------------------- 课程配色 */

test('导入课 color 为 null 时，仍由 courseColor 派生出调色板里的颜色', () => {
  // 模拟 resolveClasses 的产物：color 直接取 course.color，通常是 null
  const cls = { courseId: 'c-math', courseName: '高等数学(上)', color: null };
  const color = cls.color || courseColor(cls.courseId);
  assert.ok(PALETTE.includes(color), `派生色应在调色板内，实得 ${color}`);
});

test('不同课程拿到不同颜色（至少不会全撞成一个）', () => {
  const ids = ['c-math', 'c-prog', 'c-english', 'c-linalg'];
  const colors = new Set(ids.map((id) => courseColor(id)));
  assert.ok(colors.size >= 3, `4 门课应至少有 3 种颜色，实得 ${colors.size}`);
});

test('色板首色就是北邮蓝，且色板里没有重复色', () => {
  assert.equal(PALETTE[0], '#013A89');
  assert.equal(new Set(PALETTE).size, PALETTE.length);
  assert.ok(PALETTE.every((c) => /^#[0-9A-F]{6}$/i.test(c)), '色板必须是 6 位十六进制');
});
