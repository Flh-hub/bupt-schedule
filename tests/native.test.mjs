/**
 * native.test.mjs — Android 壳「教务系统抓取」链路的契约。
 *
 * 样本按**强智 jsxsd**（北邮 jwgl.bupt.edu.cn）课表页的真实形态构造：
 *  - 表头一行 8 列：时间 + 星期一…星期日
 *  - 行 = 大节，左列含 **两条** 时间（08:00-08:45 / 08:55-09:40）
 *  - 单元格内用 `------` 分隔「课程名 / 周次 / 教师 / 地点」
 *  - 同一格可能放多门课
 *
 * 这些形态只要有一个没被覆盖，用户看到的就是"导入成功但课表错/少一半"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNativeAlarms, pickCaptureDraft, scheduleReminders } from '../src/native.js';
import { expandWeeks } from '../src/model.js';

const SEP = '---------------------';

/** 一格课（强智 `div.kbcontent` 形态）。 */
function cell(lines) {
  return `<div class="kbcontent">${lines.join('<br/>')}</div>`;
}

const QZ_TABLE = `<table id="kbtable" class="Nsb_r_list Nsb_table" width="100%">
  <tbody>
    <tr>
      <th class="Nsb_r_title">时间</th>
      <th>星期一</th><th>星期二</th><th>星期三</th><th>星期四</th><th>星期五</th><th>星期六</th><th>星期日</th>
    </tr>
    <tr>
      <td class="Nsb_r_title"><div>第一大节</div><div>08:00-08:45</div><div>08:55-09:40</div></td>
      <td>${cell(['高等数学A', SEP, '1-16周', SEP, '张三', SEP, '教三-101'])}</td>
      <td></td>
      <td>${cell(['大学物理', SEP, '1-8周(单)', SEP, '李四', SEP, '教二-203'])}</td>
      <td></td><td></td><td></td><td></td>
    </tr>
    <tr>
      <td class="Nsb_r_title"><div>第二大节</div><div>09:55-10:40</div><div>10:45-11:30</div></td>
      <td>${cell(['数据结构', SEP, '1-16周', SEP, '王五', SEP, '教四-305'])}</td>
      <td></td><td></td><td></td><td></td><td></td><td></td>
    </tr>
    <tr>
      <td class="Nsb_r_title"><div>第三大节</div><div>13:30-14:15</div><div>14:20-15:05</div></td>
      <td>${cell(['体育（网球）', SEP, '1-16周', SEP, '赵六', SEP, '体育馆'])}</td>
      <td></td><td></td><td></td><td></td><td></td><td></td>
    </tr>
  </tbody>
</table>`;

const page = (inner) => `<!doctype html><html><head><title>课表查询</title></head><body>
<div class="Nsb_layout">${inner}</div></body></html>`;

/** 拿一份会话（按课程名找）。 */
function sessionOf(draft, name) {
  const course = draft.courses.find((c) => c.name === name);
  assert.ok(course, `缺少课程「${name}」，实际：${draft.courses.map((c) => c.name).join(' / ')}`);
  const sessions = draft.sessions.filter((s) => s.courseId === course.id);
  assert.equal(sessions.length, 1, `课程「${name}」应有 1 个课次`);
  return sessions[0];
}

test('强智大节表格：两条时间 = 两个小节，星期与节次都不串行', () => {
  const { draft } = pickCaptureDraft([{ label: 'kbtable', html: page(QZ_TABLE) }], { totalWeeks: 20 });
  assert.ok(draft, '应当解析出结果');
  assert.equal(draft.sessions.length, 4, '应有 4 个课次');
  assert.deepEqual(
    draft.courses.map((c) => c.name).sort(),
    ['体育（网球）', '大学物理', '高等数学A', '数据结构'].sort()
  );

  const math = sessionOf(draft, '高等数学A');
  assert.equal(math.dayOfWeek, 1);
  assert.equal(math.startPeriod, 1);
  assert.equal(math.endPeriod, 2, '第一大节 08:00-08:45 + 08:55-09:40 必须算 1-2 节');
  assert.equal(math.location, '教三-101');

  const dataStructure = sessionOf(draft, '数据结构');
  assert.equal(dataStructure.dayOfWeek, 1);
  assert.equal(dataStructure.startPeriod, 3);
  assert.equal(dataStructure.endPeriod, 4);

  const pe = sessionOf(draft, '体育（网球）');
  assert.equal(pe.startPeriod, 5);
  assert.equal(pe.endPeriod, 6, '第三大节 13:30 起 → 第 5-6 节');
});

test('分隔线「------」不会被当成课程名或教师', () => {
  const { draft } = pickCaptureDraft([{ label: 'kbtable', html: page(QZ_TABLE) }], { totalWeeks: 20 });
  const names = draft.courses.map((c) => c.name);
  assert.equal(names.some((n) => /^-+$/.test(n)), false, `出现了分隔线课程名：${names.join(' / ')}`);
  assert.equal(draft.unrecognized.filter((u) => /^-+$/.test(String(u.raw))).length, 0);
});

test('单元格里的教师不会被当成第二门课', () => {
  const { draft } = pickCaptureDraft([{ label: 'kbtable', html: page(QZ_TABLE) }], { totalWeeks: 20 });
  const names = draft.courses.map((c) => c.name);
  for (const teacher of ['张三', '李四', '王五', '赵六']) {
    assert.equal(names.includes(teacher), false, `「${teacher}」被当成了课程名`);
  }
  assert.equal(sessionOf(draft, '高等数学A').teacher, '张三');
});

test('单双周原样保留', () => {
  const { draft } = pickCaptureDraft([{ label: 'kbtable', html: page(QZ_TABLE) }], { totalWeeks: 20 });
  const physics = sessionOf(draft, '大学物理');
  assert.equal(physics.weeks.type, 'odd');
  assert.deepEqual(expandWeeks(physics.weeks), [1, 3, 5, 7]);
  assert.equal(physics.dayOfWeek, 3);
});

test('候选列表：跳过不含课表的表，用后面能解析的那份', () => {
  const noise = `<table class="menu"><tr><td>课表查询</td><td>星期一</td></tr></table>`;
  const picked = pickCaptureDraft(
    [
      { label: '菜单表', html: page(noise) },
      { label: '课表', html: page(QZ_TABLE) }
    ],
    { totalWeeks: 20 }
  );
  assert.equal(picked.label, '课表');
  assert.equal(picked.draft.sessions.length, 4);
});

test('全都解析不出时返回失败草稿，且不抛异常（交给 UI 提示）', () => {
  const picked = pickCaptureDraft([{ label: '空页', html: '<html><body><p>没有课表</p></body></html>' }], {
    totalWeeks: 20
  });
  assert.equal(picked.draft.sessions.length, 0);
  assert.ok(picked.draft.unrecognized.length > 0, '失败必须进未识别列表，不能静默');
  assert.equal(typeof picked.html, 'string');
});

test('没有候选时不死锁（原生返回空列表）', () => {
  for (const input of [[], null, undefined, [{ html: '' }]]) {
    const picked = pickCaptureDraft(input, { totalWeeks: 20 });
    assert.ok(picked && typeof picked.html === 'string');
  }
});

/* ---------------------------------------------------------------- 原生提醒排程 */

const NOW = Date.parse('2026-10-23T09:00:00+08:00');
const pt = (key, at, extra = {}) => ({
  key,
  triggerAt: at,
  title: '即将上课',
  body: `${key} 的正文`,
  ...extra
});

test('提醒点 → 原生闹钟：只取未来 7 天内、还没到点的', () => {
  const list = buildNativeAlarms(
    [
      pt('past', NOW - 60000), // 已过去
      pt('soon', NOW + 60000), // 1 分钟后
      pt('edge-now', NOW + 500), // 刚过 1 秒的容差内，跳过
      pt('day3', NOW + 3 * 86400000),
      pt('day8', NOW + 8 * 86400000) // 超期
    ],
    NOW,
    7
  );
  assert.deepEqual(
    list.map((a) => a.id),
    ['soon', 'day3']
  );
  assert.equal(list[0].at, Math.round(NOW + 60000));
});

test('原生闹钟按时间升序、按 id 去重', () => {
  const list = buildNativeAlarms(
    [pt('b', NOW + 300000), pt('a', NOW + 100000), pt('a', NOW + 100000), pt('c', NOW + 200000)],
    NOW
  );
  assert.deepEqual(
    list.map((a) => a.id),
    ['a', 'c', 'b']
  );
});

test('缺字段 / 脏数据不会让排程炸掉', () => {
  const list = buildNativeAlarms(
    [null, {}, { triggerAt: 'abc' }, { triggerAt: NOW + 2000, key: '' }, pt('x'.repeat(200), NOW + 5000)],
    NOW
  );
  assert.equal(list.length, 2, '只有两条有合法 triggerAt');
  assert.ok(list.every((a) => a.id.length <= 80), 'id 必须截断到 80 字符以内');
  assert.ok(list.every((a) => a.title.length > 0 && typeof a.body === 'string'));
  assert.deepEqual(buildNativeAlarms(null, NOW), []);
  assert.deepEqual(buildNativeAlarms([], NOW), []);
});

test('浏览器里没有原生桥：scheduleReminders 安全返回 0', () => {
  assert.equal(scheduleReminders([pt('a', NOW + 60000)], { now: NOW }), 0);
});

/* ---------------------------------------------- 流体云卡片的数据契约（1.17.0） */

test('闹钟里要带上课时刻：由 triggerAt + 提前分钟数反推', () => {
  // 原生侧靠 startEpoch 做两件事：系统倒计时的终点、上课那一刻自动收卡片。
  // 这里一旦算错，表现是"倒计时指向错误时间"或"胶囊永远不消失"，且不会报错。
  const list = buildNativeAlarms(
    [pt('a', NOW + 60000, { advanceMinutes: 15 })],
    NOW
  );
  assert.equal(list[0].startEpoch, NOW + 60000 + 15 * 60000, '上课时刻 = 提醒时刻 + 15 分钟');
});

test('没有提前分钟数时 startEpoch 必须为 0（退化成普通通知，而不是瞎猜）', () => {
  const list = buildNativeAlarms([pt('a', NOW + 60000)], NOW);
  assert.equal(list[0].startEpoch, 0, '猜出来的倒计时比没有更糟');
});

test('标题是课程名、正文是节次', () => {
  const list = buildNativeAlarms(
    [pt('a', NOW + 60000, { courseName: '高等数学（上）', periodText: '第3-4节', advanceMinutes: 10 })],
    NOW
  );
  assert.equal(list[0].title, '高等数学（上）');
  assert.equal(list[0].periods, '第3-4节');
  assert.equal(list[0].body, '第3-4节', '老壳只认 body，必须同步');
});

test('发给原生的一切字段都不含地点（胶囊放不下，用户明确不要）', () => {
  const list = buildNativeAlarms(
    [
      pt('a', NOW + 60000, {
        courseName: '大学物理',
        periodText: '第1-2节',
        advanceMinutes: 15,
        location: '教学实验综合楼-S215',
        teacher: '张老师'
      })
    ],
    NOW
  );
  const flat = JSON.stringify(list[0]);
  assert.ok(!flat.includes('教学实验综合楼'), `不应带地点：${flat}`);
  assert.ok(!flat.includes('S215'), `不应带教室号：${flat}`);
  assert.ok(!flat.includes('张老师'), `不应带教师：${flat}`);
});

test('缺 courseName 时退回「即将上课」，标题不能是空串', () => {
  const list = buildNativeAlarms([pt('a', NOW + 60000, { title: '' })], NOW);
  assert.ok(list[0].title.length > 0);
});

test('不下发胶囊文案：折叠态只显示剩余时间，而剩余时间必须在发通知那一刻才算得准', () => {
  const list = buildNativeAlarms(
    [pt('a', NOW + 60000, { courseName: '高等数学（上）', advanceMinutes: 5 })],
    NOW
  );
  assert.equal(list[0].chip, undefined, '排程时算出来的「剩余 N 分钟」到点就过期了，不能下发');
  assert.equal(list[0].title, '高等数学（上）', '标题仍是完整课程名，展开态要用');
});

