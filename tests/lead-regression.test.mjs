/**
 * Lead 回归用例（交付总监验收时补）。
 *
 * 来历：QA 第 1 轮报的 P0 修复完成后，我手工复核示例文本时发现一个**QA 用例没覆盖**的残留：
 *   `周四 1-2节 计算机网络 教三-101 周宏 1-16周`
 * 被解析成 课程名=计算机网络 / 教师=宏 / 地点=教三-1 / 周次=1-1。
 *
 * 根因：周次正则没有左边界，`教三-101 周宏` 里的 `01 周` 被当成周次吃掉（"周"既是周次单位、
 * 也是常见姓氏）。这类错误不抛异常、不产 warning，只会在课表上显示成"第 1 周只有课"。
 *
 * 修复：WEEK_EXPR_RE 加左边界 `(?<![\dA-Za-z])` 与右边界 `(?![\u4e00-\u9fa5])`。
 * 本文件锁住该行为，防止回退。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { weeksTextFromString, parseOneLine } from '../src/parsers/html.js';
import { parseText, parseJwgl } from '../src/parsers/index.js';
import { SAMPLE_TEXT } from '../src/ui/components.js';

/** 取出「周次」覆盖的周列表，便于断言离散段。 */
function weeksOf(session) {
  const w = session.weeks || {};
  const out = [];
  if (Number.isInteger(w.start) && Number.isInteger(w.end)) {
    for (let i = w.start; i <= w.end; i += 1) {
      if (w.type === 'odd' && i % 2 === 0) continue;
      if (w.type === 'even' && i % 2 === 1) continue;
      out.push(i);
    }
  }
  for (const n of Array.isArray(w.extra) ? w.extra : []) if (!out.includes(n)) out.push(n);
  return out.sort((a, b) => a - b);
}

test('教师姓氏为「周」时不得被当成周次/星期吞掉', () => {
  const line = '周四 1-2节 计算机网络 教三-101 周宏 1-16周';
  assert.equal(weeksTextFromString(line), '1-16周');

  const rec = parseOneLine(line);
  assert.equal(rec.name, '计算机网络');
  assert.equal(rec.teacher, '周宏', '「周宏」被截成「宏」→ 周次正则缺左边界');
  assert.equal(rec.location, '教三-101', '「教三-101」被截成「教三-1」→ 同上');
  assert.equal(rec.weeksText, '1-16周');
});

test('地点以数字结尾 + 教师姓周：地点与周次都要完整', () => {
  const rec = parseOneLine('周五 1-2节 马原 主楼-410 周敏 2-16双周');
  assert.equal(rec.teacher, '周敏');
  assert.equal(rec.location, '主楼-410');
  assert.equal(rec.weeksText, '2-16双周');
});

test('SAMPLE_TEXT 端到端：8 门课，课程名/教师/地点/周次逐项正确', () => {
  const result = parseText(SAMPLE_TEXT, {});
  assert.equal(result.sessions.length, 8, '示例文本应解析出 8 条课次');
  assert.equal(result.unrecognized.length, 0);

  const byName = new Map();
  for (const s of result.sessions) {
    const course = result.courses.find((c) => c.id === s.courseId);
    byName.set(course.name, { session: s, course });
  }

  const expected = [
    ['高等数学(上)', '王建民', '教三-201', 1, 1, 2],
    ['大学物理(下)', '李明', '教四-105', 1, 3, 4],
    ['数据结构', '赵晓', '教三-305', 2, 1, 2],
    ['大学英语', 'Sarah', '主楼-410', 2, 3, 4],
    ['概率论与数理统计', '孙涛', '教二-208', 3, 5, 6],
    ['计算机网络', '周宏', '教三-101', 4, 1, 2],
    ['体育(羽毛球)', '刘磊', '体育馆-2F', 4, 7, 8],
    ['毛概', '陈静', '教二-101', 5, 3, 4]
  ];

  for (const [name, teacher, location, dow, sp, ep] of expected) {
    const hit = byName.get(name);
    assert.ok(hit, `课程名丢失或被改名：${name}（实际：${[...byName.keys()].join('/')}）`);
    assert.equal(hit.course.teacher, teacher, `${name} 的教师不对`);
    assert.equal(hit.session.location, location, `${name} 的地点不对`);
    assert.equal(hit.session.dayOfWeek, dow, `${name} 的星期不对`);
    assert.equal(hit.session.startPeriod, sp, `${name} 的起始节次不对`);
    assert.equal(hit.session.endPeriod, ep, `${name} 的结束节次不对`);
  }
});

test('离散周次 `1-8,10-16周` 必须整段保留（不能只剩后半段）', () => {
  const result = parseText(SAMPLE_TEXT, {});
  const badminton = result.sessions.find((s) => {
    const c = result.courses.find((x) => x.id === s.courseId);
    return c && c.name === '体育(羽毛球)';
  });
  assert.ok(badminton, '示例文本里应有「体育(羽毛球)」');
  assert.deepEqual(
    weeksOf(badminton),
    [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16],
    '第 1–8 周被截断 → 这门课在前 8 周会从课表消失且不报错'
  );
});

test('周次表达式不得把「周一/周宏/周三」当周次', () => {
  assert.equal(weeksTextFromString('周一 1-2节 高数 教三-101 王老师'), null);
  assert.equal(weeksTextFromString('周三 第1-2节 体育 操场 刘磊'), null);
  assert.equal(weeksTextFromString('周宏 1-16周'), '1-16周');
});

/* ---------------------------------------------------------------- 单元格两处残留 */

/** 构造一张「节次 × 星期」两列课表，用于单元格解析探针。 */
function gridCell(cellHtml) {
  return `<table><tr><th>节次</th><th>周一</th><th>周二</th></tr>
    <tr><td>第1-2节</td><td>${cellHtml}</td><td></td></tr></table>`;
}

test('课程名里的「实验」不得让整格被判成地点（QA-REPORT §3.9）', () => {
  const r = parseJwgl(gridCell('大学物理实验<br>1-16周<br>实验楼A101<br>李明'), {});
  assert.equal(r.sessions.length, 1, '「大学物理实验」不应整格进未识别行');
  assert.equal(r.sessions[0].name, '大学物理实验');
  assert.equal(r.sessions[0].location, '实验楼A101');

  const r2 = parseJwgl(gridCell('数据结构实验(上)<br>1-8周<br>教三-305<br>赵晓'), {});
  assert.equal(r2.sessions.length, 1);
  assert.equal(r2.sessions[0].name, '数据结构实验(上)');
});

test('单元格末行的纯中文人名是教师，不是第二门课（幽灵课程）', () => {
  for (const [cell, teacher] of [
    ['高等数学(上)<br>1-16周<br>教三-101<br>王建民', '王建民'],
    ['大学英语<br>1-16周<br>主楼-410<br>Sarah', 'Sarah'],
    ['大学物理<br>1-16周<br>教四-105<br>王老师', '王老师']
  ]) {
    const r = parseJwgl(gridCell(cell), {});
    assert.equal(r.sessions.length, 1, `多出了幽灵课程：${JSON.stringify(r.sessions.map((s) => s.name))}`);
    assert.equal(r.sessions[0].teacher, teacher, `${teacher} 未被识别为教师`);
  }
});

test('一格两门课仍要拆成两条（教师行修复不得把真课程合并掉）', () => {
  const r = parseJwgl(gridCell('高数<br>1-2节<br>1-16周<br>教三-101<br>物理<br>3-4节<br>1-8周<br>教四-201'), {});
  assert.equal(r.sessions.length, 2);
  assert.deepEqual(r.sessions.map((s) => s.name), ['高数', '物理']);
  assert.deepEqual(r.sessions.map((s) => s.location), ['教三-101', '教四-201']);
});
