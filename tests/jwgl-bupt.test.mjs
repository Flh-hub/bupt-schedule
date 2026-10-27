/**
 * jwgl-bupt.test.mjs — 北邮教务（强智 jsxsd）**真实页面**形态的解析契约。
 *
 * 样本逐字照抄 2026-10-23 手机截图里的课表（14 小节、括号周次、三连节次、教学班代码）：
 *   `1 / 08:00-08:45 … 14 / 20:10-20:55`
 *   单元格：
 *     大学生心理健康1
 *     王培
 *     4-7(周)[01-02节]
 *     教学实验综合楼-S215
 *
 * 这些格式只要有一处不认，用户看到的就是：整张课表"未识别到周次，已按整学期处理"，
 * 教师被拆成一门课（截图里真的出现了「宋媛」这门课），晚间课程排不进周视图。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHtml } from '../src/parsers/index.js';
import { expandWeeks } from '../src/model.js';

const blk = (lines) => `<div class="kbcontent">${lines.join('<br/>')}</div>`;

/** 按 rowspan 记账生成课表：cells 用 1..7 表示星期，spans 表示跨行数。 */
function buildTable(rows) {
  const open = new Map();
  const trs = [];
  for (const row of rows) {
    const tds = [`<td class="rq">${row.index}<br/>${row.time}</td>`];
    for (let dow = 1; dow <= 7; dow += 1) {
      if (open.has(dow)) {
        const left = open.get(dow) - 1;
        if (left <= 0) open.delete(dow);
        else open.set(dow, left);
        continue;
      }
      const content = (row.cells && row.cells[dow]) || '';
      const span = row.spans && row.spans[dow];
      if (span) {
        open.set(dow, span - 1);
        tds.push(`<td rowspan="${span}">${content}</td>`);
      } else {
        tds.push(`<td>${content}</td>`);
      }
    }
    trs.push(`<tr>${tds.join('')}</tr>`);
  }
  return `<table id="kbtable" class="Nsb_r_list Nsb_table"><tbody>
    <tr><th>时间</th><th>星期一</th><th>星期二</th><th>星期三</th><th>星期四</th><th>星期五</th><th>星期六</th><th>星期日</th></tr>
    ${trs.join('\n    ')}
  </tbody></table>`;
}

const TIMES = [
  ['08:00-08:45', '08:50-09:35', '09:50-10:35', '10:40-11:25', '11:30-12:15', '13:00-13:45', '13:50-14:35'],
  ['14:45-15:30', '15:40-16:25', '16:35-17:20', '17:25-18:10', '18:30-19:15', '19:20-20:05', '20:10-20:55']
];

const ROWS = [
  {
    index: 1,
    time: TIMES[0][0],
    cells: { 3: blk(['大学生心理健康1', '王培', '4-7(周)[01-02节]', '教学实验综合楼-S215']) },
    spans: { 3: 2 }
  },
  {
    index: 2,
    time: TIMES[0][1],
    cells: {
      2: blk(['数学分析(上) O', '李晓莉', '4-19(周)[02-03-04节]', '教学实验综合楼-S210']),
      4: blk(['数学分析(上) P', '李晓莉', '8(周)[02-03-04节]', '教学实验综合楼-S103'])
    }
  },
  { index: 3, time: TIMES[0][2], cells: {} },
  { index: 4, time: TIMES[0][3], cells: {} },
  { index: 5, time: TIMES[0][4], cells: {} },
  {
    index: 6,
    time: TIMES[0][5],
    cells: {
      1: blk(['程序设计与编程方法', '何大中', '4-19(周)[06-07节]', '智慧教学楼-117']),
      // ★ 第三行 (B14) 是教学班代码，不是地点；教师在这之后
      2: blk(['基础综合英语', '(B14)', '宋媛', '4-19(周)[06-07节]', '智慧教学楼-413']),
      4: blk(['习近平新时代中国特色社会主义思想概论', '宋林泽', '4-19(周)[06-07-08节]', '教学实验综合楼-S211']),
      5: blk(['人工智能导论（上）', '刘刚', '4-19(周)[06-07节]', '教学实验综合楼-S507'])
    },
    spans: { 1: 2, 2: 2, 4: 2, 5: 2 }
  },
  { index: 7, time: TIMES[0][6], cells: {} },
  {
    index: 8,
    time: TIMES[1][0],
    cells: {
      3: blk(['国家安全教育（下）', '管晓琦', '4-7(周)[08-09节]', '教学实验综合楼-N110']),
      4: blk(['习近平新时代中国特色社会主义思想概论', '宋林泽', '4-19(周)[06-07-08节]', '教学实验综合楼-S211']),
      5: blk(['数学分析(上)', '李晓莉', '4-7,9-19(周)[08-09-10节]', '教学实验综合楼-N209'])
    },
    spans: { 3: 2, 4: 2, 5: 2 }
  },
  { index: 9, time: TIMES[1][1], cells: {} },
  { index: 10, time: TIMES[1][2], cells: {} },
  { index: 11, time: TIMES[1][3], cells: {} },
  { index: 12, time: TIMES[1][4], cells: {} },
  {
    index: 13,
    time: TIMES[1][5],
    cells: { 2: blk(['人工智能原理及应用', '赵文义', '3-18(周)[13-14节]', '教学实验综合楼-S104']) },
    spans: { 2: 2 }
  },
  { index: 14, time: TIMES[1][6], cells: {} }
];

const HTML = `<!doctype html><html><head><title>学期理论课表</title></head><body>
  <div class="Nsb_layout"><div class="Nsb_r_list">${buildTable(ROWS)}</div></div>
  <div class="bz">备 注：大学生心理健康1[2026218606-2026218607]班 4-19周;国家安全教育（上）4-7周</div>
</body></html>`;

// 走完整通道（含 normalize），这样拿到的是最终入库形态：weeks spec / rawWeeksText
const parsed = parseHtml(HTML, { source: 'jwgl', forceSource: true, totalWeeks: 20 });
const courseOf = (id) => parsed.courses.find((c) => c.id === id) || {};
const byName = (name) => parsed.sessions.filter((s) => courseOf(s.courseId).name === name);
const namesOf = () => parsed.courses.map((c) => c.name);

test('14 小节课表：周次写成 4-19(周) 也要认（不能整学期兜底）', () => {
  assert.ok(parsed.sessions.length >= 8, `课次太少：${parsed.sessions.length}`);
  const warnings = parsed.warnings.filter((w) => w.includes('未识别到周次'));
  assert.deepEqual(warnings, [], `不应再有"未识别到周次"：${warnings.join(' | ')}`);

  const [eng] = byName('基础综合英语');
  assert.ok(eng, '缺少「基础综合英语」');
  assert.ok(eng.rawWeeksText.includes('4-19'), `周次原文不对：${eng.rawWeeksText}`);
  const weeks = expandWeeks(eng.weeks);
  assert.equal(weeks[0], 4);
  assert.equal(weeks[weeks.length - 1], 19);
  assert.equal(weeks.length, 16);
});

test('三连节次 [06-07-08节] → 第 6-8 节，不是"第 8 节"', () => {
  const [x] = byName('习近平新时代中国特色社会主义思想概论');
  assert.ok(x);
  assert.equal(x.startPeriod, 6);
  assert.equal(x.endPeriod, 8);

  const [ma] = byName('数学分析(上) O');
  assert.equal(ma.startPeriod, 2);
  assert.equal(ma.endPeriod, 4);
});

test('教学班代码 (B14) 不是地点，教师不会被拆成一门课', () => {
  const names = namesOf();
  assert.equal(names.includes('宋媛'), false, '「宋媛」被当成了课程名');
  const [eng] = byName('基础综合英语');
  assert.equal(eng.teacher, '宋媛');
  assert.equal(eng.location, '智慧教学楼-413');
});

test('离散周次 4-7,9-19(周) 一段不丢', () => {
  const [ma] = byName('数学分析(上)');
  const weeks = expandWeeks(ma.weeks);
  assert.equal(weeks.includes(4), true);
  assert.equal(weeks.includes(7), true);
  assert.equal(weeks.includes(8), false, '第 8 周不该有课');
  assert.equal(weeks.includes(9), true);
  assert.equal(weeks.includes(19), true);
  assert.equal(weeks.length, 15, `应为 4+11=15 周，实际 ${weeks.join(',')}`);
});

test('晚间课程：节次 13-14 与星期都正确', () => {
  const [ai] = byName('人工智能原理及应用');
  assert.ok(ai);
  assert.equal(ai.dayOfWeek, 2);
  assert.equal(ai.startPeriod, 13);
  assert.equal(ai.endPeriod, 14);
  assert.deepEqual(expandWeeks(ai.weeks), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test('把页面自带的作息表带回来（1..14 节 + 起止时间）', () => {
  assert.ok(Array.isArray(parsed.periodsHint), '没有 periodsHint');
  assert.equal(parsed.periodsHint.length, 14);
  assert.deepEqual(parsed.periodsHint[0], { index: 1, start: '08:00', end: '08:45' });
  assert.deepEqual(parsed.periodsHint[13], { index: 14, start: '20:10', end: '20:55' });
});

test('跨两行的单元格（rowspan=2）不会把节次算成一节', () => {
  const [psy] = byName('大学生心理健康1');
  assert.equal(psy.startPeriod, 1);
  assert.equal(psy.endPeriod, 2);
  assert.equal(psy.dayOfWeek, 3);
});

/* ---------------------------------------------------------------- 真机结构：周次独立成行 */

/**
 * ★ 2026-10-23 真机复现：教务页把「周次」和「节次」**拆成两行**（甚至两个 div），
 *   形如 `4-7(周)` 单独一行、`[01-02节]` 另一行。此时 `4-7(周)` 这一行若不被认成
 *   "周次"，该课就退化成"整学期 1-20 周"——用户看到的就是"明明是 4-7 周，抓取显示 1-20 周"。
 */
const SPLIT_TABLE = buildTable([
  {
    index: 1,
    time: '08:00-08:45',
    cells: {
      3: blk(['大学生心理健康1', '王培', '4-7(周)', '[01-02节]', '教学实验综合楼-S215'])
    },
    spans: { 3: 2 }
  },
  {
    index: 2,
    time: '08:50-09:35',
    cells: {
      2: blk(['数学分析(上) O', '李晓莉', '4-19(周)', '[02-03-04节]', '教学实验综合楼-S210']),
      4: blk(['数学分析(上) P', '李晓莉', '8(周)', '[02-03-04节]', '教学实验综合楼-S103'])
    }
  }
]);

const splitParsed = parseHtml(SPLIT_TABLE, { source: 'jwgl', forceSource: true, totalWeeks: 20 });
const splitCourseOf = (id) => splitParsed.courses.find((c) => c.id === id) || {};
const splitByName = (name) => splitParsed.sessions.filter((s) => splitCourseOf(s.courseId).name === name);

test('周次单独一行（4-7(周)）也要认，不能退化成 1-20 周', () => {
  const [psy] = splitByName('大学生心理健康1');
  assert.ok(psy, '缺少「大学生心理健康1」');
  assert.deepEqual(expandWeeks(psy.weeks), [4, 5, 6, 7], `周次错：${JSON.stringify(psy.weeks)}`);
  assert.equal(psy.startPeriod, 1);
  assert.equal(psy.endPeriod, 2);
  assert.equal(psy.teacher, '王培');
  assert.equal(splitParsed.warnings.filter((w) => w.includes('未识别到周次')).length, 0);
});

test('周次单独一行 + 三连节次：4-19 周 / 第 2-4 节', () => {
  const [ma] = splitByName('数学分析(上) O');
  const weeks = expandWeeks(ma.weeks);
  assert.equal(weeks[0], 4);
  assert.equal(weeks[weeks.length - 1], 19);
  assert.equal(weeks.length, 16);
  assert.equal(ma.startPeriod, 2);
  assert.equal(ma.endPeriod, 4);
});

test('单个周次 8(周) 不会被当成"第 8 周之后全上"', () => {
  const [mp] = splitByName('数学分析(上) P');
  assert.deepEqual(expandWeeks(mp.weeks), [8]);
});

test('周次行不会被误判成新课名或地点', () => {
  const names = splitParsed.courses.map((c) => c.name);
  assert.equal(names.some((n) => /周/.test(n) && /\d/.test(n)), false, `多出课程：${names.join(' / ')}`);
  assert.equal(splitParsed.sessions.length, 3);
});
