/**
 * qa-week-boundary.test.mjs — 第 2 轮回归补充：「周」既是周次单位也是姓氏的边界用例。
 *
 * 背景：`教三-101 周宏` 曾被解析成 周次=`101 周`（教师姓氏被吃进周次），
 * 修复方式是给周次正则加左边界 + `周(?!汉字)`。本文件把该边界的正反两面都钉死，
 * 防止后续为了修别的用例把左右边界再放宽回去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PERIODS, expandWeeks } from '../src/model.js';
import { parseText } from '../src/parsers/index.js';
import { parseJwgl, periodsFromTimes } from '../src/parsers/html.js';
import { emptyState } from '../src/ui/components.js';

/** 单行解析后取第一条课次的关键字段。 */
function parseLine(line) {
  const parsed = parseText(line);
  const course = parsed.courses[0] || {};
  const session = parsed.sessions[0] || {};
  return {
    parsed,
    name: course.name,
    teacher: session.teacher,
    location: session.location,
    rawWeeks: session.rawWeeksText,
    weeks: session.weeks ? expandWeeks(session.weeks) : null,
    startPeriod: session.startPeriod,
    endPeriod: session.endPeriod
  };
}

function range(from, to) {
  const out = [];
  for (let w = from; w <= to; w += 1) out.push(w);
  return out;
}

test('教师姓「周」：周宏 / 周敏 / 周老师 不得被吃进周次', () => {
  const cases = [
    ['周四 1-2节 计算机网络 教三-101 周宏 1-16周', '周宏', '计算机网络', '教三-101', '1-16周', range(1, 16)],
    ['周五 3-4节 操作系统 教二-208 周敏 1-16周', '周敏', '操作系统', '教二-208', '1-16周', range(1, 16)],
    ['周一 1-2节 高等数学 教三-101 周老师 1-8周', '周老师', '高等数学', '教三-101', '1-8周', range(1, 8)]
  ];
  for (const [line, teacher, name, location, rawWeeks, weeks] of cases) {
    const got = parseLine(line);
    assert.equal(got.parsed.sessions.length, 1, `${line} 应解析出 1 条课次`);
    assert.equal(got.name, name, `${line} 的课程名不符`);
    assert.equal(got.teacher, teacher, `${line} 的教师被改写成 ${got.teacher}`);
    assert.equal(got.location, location, `${line} 的地点不符`);
    assert.equal(got.rawWeeks, rawWeeks, `${line} 的周次原文被改写为 ${got.rawWeeks}`);
    assert.deepEqual(got.weeks, weeks, `${line} 的周次被改写：${JSON.stringify(got.weeks)}`);
  }
});

test('地点以数字结尾且紧跟周姓教师（原缺陷现场：教三-101 周宏）', () => {
  const got = parseLine('周四 1-2节 计算机网络 教三-101 周宏 1-16周');
  assert.equal(got.location, '教三-101', '地点不得被周次正则吃掉末位数字（曾解析成 教三-1）');
  assert.equal(got.teacher, '周宏', '教师不得只剩「宏」（曾解析成 宏）');
  assert.equal(got.weeks.length, 16, '周次不得退化成 1-1');
  assert.equal(got.weeks.includes(101), false, '周次里出现 101 说明把地点数字当成了周次');
});

test('无周次的行：回退整学期，绝不凭空造出一个窄周次区间', () => {
  for (const line of [
    '周一 1-2节 高数 教三-101 王老师',
    '周一 1-2节 高数 教三-101 周宏',
    '周一 1-2节 高数 主楼-410 王老师'
  ]) {
    const got = parseLine(line);
    assert.equal(got.parsed.sessions.length, 1, `${line} 应能解析（周次缺失不是致命错误）`);
    assert.deepEqual(got.weeks, range(1, 20), `${line} 应回退为整学期 1-20 周，实际 ${JSON.stringify(got.weeks)}`);
  }
});

test('周次出现在句子中段（含「周次:」显式键、「第N周」写法）', () => {
  const mid = parseLine('周四 1-16周 7-8节 体育 体育馆-2F 刘磊');
  assert.deepEqual(mid.weeks, range(1, 16));
  assert.equal(mid.location, '体育馆-2F');

  const keyed = parseLine('周一 1-2节 高数 周次:1-16 教三-101 王老师');
  assert.deepEqual(keyed.weeks, range(1, 16));
  assert.equal(keyed.name, '高数');

  const single = parseLine('周一 1-2节 高数 教三-101 王老师 第3周');
  assert.deepEqual(single.weeks, [3]);
});

test('括号属于课程名，不得被当分隔符吞掉（否则同名不同课会被合并）', () => {
  assert.equal(parseLine('周一 1-2节 高等数学(上) 教三-201 王建民 1-16周').name, '高等数学(上)');
  const pe = parseLine('周四 7-8节 体育(羽毛球) 体育馆-2F 刘磊 1-8,10-16周');
  assert.equal(pe.name, '体育(羽毛球)');
  assert.equal(pe.location, '体育馆-2F');
  assert.deepEqual(pe.weeks, [...range(1, 8), ...range(10, 16)]);
});

test('周次 8 种写法回归（含离散两段与单双周混排）', () => {
  const cases = [
    ['1-16周', range(1, 16)],
    ['1-16周(单)', [1, 3, 5, 7, 9, 11, 13, 15]],
    ['1-16周（双）', [2, 4, 6, 8, 10, 12, 14, 16]],
    ['1,3,5-9周', [1, 3, 5, 6, 7, 8, 9]],
    ['第1-16周', range(1, 16)],
    ['1~16周', range(1, 16)],
    ['2-16双周', [2, 4, 6, 8, 10, 12, 14, 16]],
    ['1-8,10-16周', [...range(1, 8), ...range(10, 16)]],
    ['3-15周(单),17周', [3, 5, 7, 9, 11, 13, 15, 17]]
  ];
  for (const [text, weeks] of cases) {
    assert.deepEqual(parseLine(`周一 1-2节 高数 教三-101 ${text}`).weeks, weeks, `「${text}」的周次被改写`);
  }
});

test('periodsFromTimes 支持结束时间：08:00-09:35 反查为第 1-2 节', () => {
  assert.deepEqual(periodsFromTimes('08:00', DEFAULT_PERIODS, '09:35'), { startPeriod: 1, endPeriod: 2 });
  assert.deepEqual(periodsFromTimes('08:00', DEFAULT_PERIODS, '08:45'), { startPeriod: 1, endPeriod: 1 });
  assert.deepEqual(periodsFromTimes('13:30', DEFAULT_PERIODS, '15:05'), { startPeriod: 5, endPeriod: 6 });
  assert.deepEqual(periodsFromTimes('20:10', DEFAULT_PERIODS, '20:55'), { startPeriod: 11, endPeriod: 11 });
  // 两参调用向后兼容
  assert.deepEqual(periodsFromTimes('09:55', DEFAULT_PERIODS), { startPeriod: 3, endPeriod: 3 });
});

test('只给时间制的行走三参反查，连堂课不再被压成一节', () => {
  const got = parseLine('周一 08:00-09:35 线性代数 教三-102 张老师 1-16周');
  assert.equal(got.startPeriod, 1);
  assert.equal(got.endPeriod, 2, `08:00-09:35 应按 1-2 节处理，实际 ${got.startPeriod}-${got.endPeriod}`);
});

test('表头只有 2 个星期列也能识别（短学期 / 实验课表）', () => {
  const html = `<table>
    <tr><th>节次</th><th>周四</th><th>周五</th></tr>
    <tr><td>第1-2节</td><td>英语听说<br>1-16周</td><td>讲座<br>1-8周</td></tr>
  </table>`;
  const result = parseJwgl(html);
  assert.equal(result.sessions.length, 2, '2 列星期表头不应被判为「未找到课表」');
  assert.deepEqual(result.sessions.map((s) => s.dayOfWeek).sort(), [4, 5]);
});

test('emptyState 的 title 与 desc 都必须转义', () => {
  const html = emptyState('<script>alert(1)</script>', '<img onerror="x">');
  assert.equal(/<script/i.test(html), false);
  assert.equal(/<img/i.test(html), false);
  assert.match(html, /&lt;script&gt;/);
});
