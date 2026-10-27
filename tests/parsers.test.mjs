import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PERIODS, parseWeeksText, weeksToText } from '../src/model.js';
import {
  detectSource,
  guessKind,
  normalize,
  parse,
  parseHtml,
  parseText
} from '../src/parsers/index.js';
import { decodeEntities, parseHtmlLite, parseJwgl, parseTableInner, tagLine } from '../src/parsers/html.js';
import { parseJson } from '../src/parsers/json.js';

/* ------------------------------------------------------------ 周次文案 */

test('parseWeeksText 覆盖 9 种写法', () => {
  assert.deepEqual(parseWeeksText('1-16周', 20), { start: 1, end: 16, type: 'all', extra: [] });
  assert.deepEqual(parseWeeksText('第1-16周', 20), { start: 1, end: 16, type: 'all', extra: [] });
  assert.deepEqual(parseWeeksText('1~16周', 20), { start: 1, end: 16, type: 'all', extra: [] });
  assert.deepEqual(parseWeeksText('1—16周', 20), { start: 1, end: 16, type: 'all', extra: [] });
  assert.deepEqual(parseWeeksText('1-16周(单)', 20), { start: 1, end: 16, type: 'odd', extra: [] });
  assert.deepEqual(parseWeeksText('1-16周（单周）', 20), { start: 1, end: 16, type: 'odd', extra: [] });
  assert.deepEqual(parseWeeksText('1-16周(双)', 20), { start: 1, end: 16, type: 'even', extra: [] });
  assert.deepEqual(parseWeeksText('2-16双周', 20), { start: 2, end: 16, type: 'even', extra: [] });
  assert.deepEqual(parseWeeksText('单周', 20), { start: 1, end: 20, type: 'odd', extra: [] });
  assert.deepEqual(parseWeeksText('双周', 16), { start: 1, end: 16, type: 'even', extra: [] });
  assert.deepEqual(parseWeeksText('1,3,5-9周', 20), { start: 5, end: 9, type: 'all', extra: [1, 3] });
  assert.deepEqual(parseWeeksText('1-8,10-16周', 20), {
    start: 1,
    end: 8,
    type: 'all',
    extra: [10, 11, 12, 13, 14, 15, 16]
  });
  assert.deepEqual(parseWeeksText('3-15周(单),17周', 20), {
    start: 3,
    end: 15,
    type: 'odd',
    extra: [17]
  });
  // 单双周歧义 → 按全周
  assert.deepEqual(parseWeeksText('1-16周 单双周', 20), { start: 1, end: 16, type: 'all', extra: [] });
  // 空值 → 整学期
  assert.deepEqual(parseWeeksText('', 20), { start: 1, end: 20, type: 'all', extra: [] });
});

test('weeksToText 把离散周次压缩成区间', () => {
  assert.equal(weeksToText({ start: 5, end: 9, type: 'all', extra: [1, 3] }), '5-9周,1,3周');
});

/* ------------------------------------------------------------ 表格压平（rowspan 记账） */

const JWGL_HTML = `<!doctype html>
<html><head><title>本科生院 教务系统 课表查询</title></head>
<body>
<div class="jwgl-meta">北京邮电大学 教务管理系统 kbcx</div>
<table class="kb-table">
  <tr><th>节次</th><th>星期一</th><th>星期二</th><th>星期三</th><th>星期四</th><th>星期五</th><th>星期六</th><th>星期日</th></tr>
  <tr>
    <td>第1节</td>
    <td rowspan="2">高等数学(上)<br>王老师<br>1-16周<br>教三-101</td>
    <td>大学英语<br>1-16周<br>教四-201</td>
    <td>-</td>
    <td>线性代数<br>1-16周<br>教三-301</td>
    <td>A<br>王老师<br>1-16周<br>教三-101<br>B<br>李老师<br>1-8周<br>教四-201</td>
    <td></td><td></td>
  </tr>
  <tr>
    <td>第2节</td>
    <td>体育<br>1-8周<br>操场</td>
    <td></td><td></td><td></td><td></td><td></td>
  </tr>
  <tr>
    <td>第3节</td>
    <td></td><td></td><td></td>
    <td>大学物理<br>2-16周(双)<br>教四-105</td>
    <td></td><td></td><td></td>
  </tr>
</table>
</body></html>`;

test('parseTableInner 正确处理 rowspan/colspan 占位记账', () => {
  const lite = parseHtmlLite(JWGL_HTML);
  assert.equal(lite.tables.length, 1);
  const rows = parseTableInner(JWGL_HTML.match(/<table[^>]*>([\s\S]*?)<\/table>/)[1]);
  assert.equal(rows.length, 4);
  // 第 2 行第 2 列应是 rowspan 的占位（origin=false）
  assert.equal(rows[2][1].origin, false);
  assert.equal(rows[2][2].origin, true);
  assert.equal(rows[2][2].text.startsWith('体育'), true);
});

test('教务网格 fixture：星期不错位（rowspan 连堂课 → 第 1-2 节）', () => {
  const result = parseHtml(JWGL_HTML, { source: 'jwgl' });
  assert.equal(result.meta.strategy, 'jwgl:table');
  assert.equal(result.unrecognized.length, 0, JSON.stringify(result.unrecognized));

  const byName = new Map();
  for (const s of result.sessions) {
    const course = result.courses.find((c) => c.id === s.courseId);
    const list = byName.get(course.name) || [];
    list.push(s);
    byName.set(course.name, list);
  }

  const math = byName.get('高等数学(上)')[0];
  assert.equal(math.dayOfWeek, 1);
  assert.equal(math.startPeriod, 1);
  assert.equal(math.endPeriod, 2);
  assert.equal(math.location, '教三-101');

  const pe = byName.get('体育')[0];
  assert.equal(pe.dayOfWeek, 2, '体育应在星期二（若 rowspan 未记账会错到星期一）');
  assert.equal(pe.startPeriod, 2);
  assert.equal(pe.endPeriod, 2);

  const physics = byName.get('大学物理')[0];
  assert.equal(physics.dayOfWeek, 4);
  assert.equal(physics.startPeriod, 3);
  assert.deepEqual(physics.weeks, { start: 2, end: 16, type: 'even', extra: [] });

  const english = byName.get('大学英语')[0];
  assert.equal(english.dayOfWeek, 2);
  assert.equal(english.startPeriod, 1);
});

test('单元格内两门课 → 拆成 2 条 session', () => {
  const result = parseHtml(JWGL_HTML, { source: 'jwgl' });
  const a = result.courses.find((c) => c.name === 'A');
  const b = result.courses.find((c) => c.name === 'B');
  assert.ok(a, '应解析出课程 A');
  assert.ok(b, '应解析出课程 B');
  const sa = result.sessions.filter((s) => s.courseId === a.id);
  const sb = result.sessions.filter((s) => s.courseId === b.id);
  assert.equal(sa.length, 1);
  assert.equal(sb.length, 1);
  assert.equal(sa[0].dayOfWeek, 5);
  assert.equal(sa[0].location, '教三-101');
  assert.equal(sb[0].location, '教四-201');
  assert.deepEqual(sb[0].weeks, { start: 1, end: 8, type: 'all', extra: [] });
  assert.equal(a.teacher, '王老师');
  assert.equal(b.teacher, '李老师');
});

/* ------------------------------------------------------------ 企微 */

const WECOM_CARD_HTML = `<!doctype html>
<html><head><title>企业微信 · 北邮课程表</title></head>
<body>
<div class="page">
  <div class="course-card">
    <div class="course-name">高等数学(上)</div>
    <div class="course-line">王老师</div>
    <div class="course-line">周一 第1-2节</div>
    <div class="course-line">教三-201</div>
    <div class="course-line">1-16周</div>
  </div>
  <div class="course-card">
    <div class="course-name">大学物理</div>
    <div class="course-line">李老师</div>
    <div class="course-line">周四 第3-4节</div>
    <div class="course-line">教四-105</div>
    <div class="course-line">1-16周</div>
  </div>
  <div class="course-card">
    <div class="course-name">形势与政策</div>
    <div class="course-line">陈老师</div>
    <div class="course-line">周三 第5-6节</div>
    <div class="course-line">主楼-202</div>
    <div class="course-line">3-15周(单)</div>
  </div>
</div>
</body></html>`;

test('企微卡片 fixture → strategy=wecom:card 且字段齐全', () => {
  const result = parse(JSON.stringify({}).slice(0, 0) + WECOM_CARD_HTML, { kind: 'html' });
  assert.equal(result.meta.source, 'wecom');
  assert.equal(result.meta.strategy, 'wecom:card');
  assert.equal(result.courses.length, 3);
  assert.equal(result.sessions.length, 3);
  const math = result.courses.find((c) => c.name === '高等数学(上)');
  const s = result.sessions.find((x) => x.courseId === math.id);
  assert.equal(s.dayOfWeek, 1);
  assert.equal(s.startPeriod, 1);
  assert.equal(s.endPeriod, 2);
  assert.equal(s.location, '教三-201');
  assert.deepEqual(s.weeks, { start: 1, end: 16, type: 'all', extra: [] });
});

const WECOM_JSON_HTML = `<!doctype html>
<html><head><title>企业微信 课表</title></head>
<body><div id="app"></div>
<script>window.__INITIAL_STATE__ = {"kcb":[{"kcmc":"大学物理","xq":2,"jc":"3-4","cdmc":"教四-105","zc":"1-16周","jsxm":"李老师"},{"kcmc":"数据结构","xq":4,"jc":"1-2","cdmc":"教三-201","zc":"1-8,10-16周","jsxm":"赵老师"}]};</script>
</body></html>`;

test('企微内联 JSON fixture → strategy=wecom:json', () => {
  const result = parseHtml(WECOM_JSON_HTML);
  assert.equal(result.meta.source, 'wecom');
  assert.equal(result.meta.strategy, 'wecom:json');
  assert.equal(result.sessions.length, 2);
  const ds = result.sessions.find((s) => {
    const c = result.courses.find((x) => x.id === s.courseId);
    return c.name === '数据结构';
  });
  assert.equal(ds.dayOfWeek, 4);
  assert.equal(ds.startPeriod, 1);
  assert.equal(ds.endPeriod, 2);
  assert.deepEqual(ds.weeks, { start: 1, end: 8, type: 'all', extra: [10, 11, 12, 13, 14, 15, 16] });
});

/* ------------------------------------------------------------ 来源判别 */

test('detectSource 三种页面', () => {
  assert.equal(detectSource(JWGL_HTML), 'jwgl');
  assert.equal(detectSource(WECOM_CARD_HTML), 'wecom');
  assert.equal(detectSource('<html><body><p>hello</p></body></html>'), 'unknown');
});

test('guessKind 判别 text / html / json', () => {
  assert.equal(guessKind('周一 1-2节 高等数学 1-16周'), 'text');
  assert.equal(guessKind(JWGL_HTML), 'html');
  assert.equal(guessKind('{"schemaVersion":1,"sessions":[]}'), 'json');
});

/* ------------------------------------------------------------ 文本通道 */

test('F1：周X + 节次 + 课程 + 地点 + 教师 + 周次', () => {
  const result = parseText('周一 1-2节 高等数学 教三-101 王老师 1-16周');
  assert.equal(result.sessions.length, 1);
  const s = result.sessions[0];
  const c = result.courses[0];
  assert.equal(c.name, '高等数学');
  assert.equal(c.teacher, '王老师');
  assert.equal(s.dayOfWeek, 1);
  assert.equal(s.startPeriod, 1);
  assert.equal(s.endPeriod, 2);
  assert.equal(s.location, '教三-101');
  assert.deepEqual(s.weeks, { start: 1, end: 16, type: 'all', extra: [] });
});

test('F2：分隔符表格', () => {
  const result = parseText('高等数学|周一|1-2|教三-101|王老师|1-16周');
  assert.equal(result.sessions.length, 1);
  assert.equal(result.courses[0].name, '高等数学');
  assert.equal(result.sessions[0].dayOfWeek, 1);
  assert.equal(result.sessions[0].location, '教三-101');
});

test('F3：只给时间 → 反查节次（结束时间参与，保住连堂）', () => {
  const result = parseText('周一 08:00-09:35 高等数学 教三-101 1-16周', { periods: DEFAULT_PERIODS });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].startPeriod, 1);
  // 08:00 落在第 1 节，09:35 正好是第 2 节下课 → 第 1-2 节（连堂不再被压成单节）
  assert.equal(result.sessions[0].endPeriod, 2);
});

test('缺字段行进 unrecognized（reason=MISSING_PERIOD），且不进 sessions', () => {
  const result = parseText('周一 体育');
  assert.equal(result.sessions.length, 0);
  assert.equal(result.unrecognized.length, 1);
  assert.equal(result.unrecognized[0].reason, 'MISSING_PERIOD');
});

test('缺星期 → MISSING_DOW', () => {
  const result = parseText('1-2节 高等数学 教三-101 1-16周');
  assert.equal(result.unrecognized[0].reason, 'MISSING_DOW');
});

test('空输入 → NO_COURSE_FOUND，不抛错', () => {
  const result = parse('', { kind: 'text' });
  assert.equal(result.sessions.length, 0);
  assert.equal(result.unrecognized[0].reason, 'NO_COURSE_FOUND');
});

test('无课表表格的 HTML（指定来源） → NO_COURSE_FOUND', () => {
  const result = parseHtml('<html><body><p>你好</p></body></html>', { source: 'jwgl', forceSource: true });
  assert.equal(result.sessions.length, 0);
  assert.equal(result.unrecognized[0].reason, 'NO_COURSE_FOUND');
});

test('来源判别失败且未强制 → SOURCE_UNDETECTED', () => {
  const result = parseHtml('<html><body><div id="x">无特征页面</div></body></html>');
  assert.equal(result.unrecognized[0].reason, 'SOURCE_UNDETECTED');
});

test('同名课程出现两次（不同节次）→ 1 个 Course + 2 个 CourseSession', () => {
  const result = parseText('周一 1-2节 高等数学 教三-101 1-16周\n周四 3-4节 高等数学 教三-101 1-16周');
  assert.equal(result.courses.length, 1);
  assert.equal(result.sessions.length, 2);
});

test('endPeriod < startPeriod → PERIOD_ORDER', () => {
  const raw = {
    courses: [],
    sessions: [
      {
        courseName: '错误课程',
        dayOfWeek: 1,
        startPeriod: 4,
        endPeriod: 2,
        location: '',
        weeksText: '1-16周'
      }
    ],
    warnings: [],
    unrecognized: [],
    meta: { source: 'text', detectedBy: 'x', strategy: 'x' }
  };
  const result = normalize(raw, { totalWeeks: 20 });
  assert.equal(result.sessions.length, 0);
  assert.equal(result.unrecognized[0].reason, 'PERIOD_ORDER');
});

test('周次越界 → 裁剪并给 warning', () => {
  const raw = {
    courses: [],
    sessions: [
      {
        courseName: '超纲课',
        dayOfWeek: 1,
        startPeriod: 1,
        endPeriod: 2,
        location: '',
        weeksText: '1-30周'
      }
    ],
    warnings: [],
    unrecognized: [],
    meta: { source: 'text', detectedBy: 'x', strategy: 'x' }
  };
  const result = normalize(raw, { totalWeeks: 16 });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].weeks.end, 16);
  assert.ok(result.warnings.some((w) => w.includes('裁剪')));
});

/* ------------------------------------------------------------ JSON 通道 */

test('JSON schemaVersion:99 → 拒绝并给可读原因', () => {
  const result = parseJson(JSON.stringify({ schemaVersion: 99, sessions: [] }));
  assert.equal(result.sessions.length, 0);
  assert.equal(result.unrecognized[0].reason, 'SCHEMA_UNSUPPORTED');
  assert.ok(result.warnings.some((w) => w.includes('99')));
});

test('JSON 非法 → INVALID_JSON', () => {
  const result = parseJson('{oops');
  assert.equal(result.unrecognized[0].reason, 'INVALID_JSON');
});

test('JSON 自身备份格式 → 解引用课程名', () => {
  const payload = JSON.stringify({
    schemaVersion: 1,
    settings: { semesterStartMonday: '2026-02-23', totalWeeks: 20 },
    courses: [{ id: 'c1', name: '高等数学(上)', teacher: '王老师' }],
    sessions: [
      {
        id: 's1',
        courseId: 'c1',
        dayOfWeek: 1,
        startPeriod: 1,
        endPeriod: 2,
        location: '教三-101',
        weeks: { start: 1, end: 16, type: 'all', extra: [] },
        rawWeeksText: '1-16周'
      }
    ],
    adjustments: [{ id: 'a1' }],
    holidays: []
  });
  const result = parse(payload, { kind: 'json' });
  assert.equal(result.meta.strategy, 'json:backup');
  assert.equal(result.sessions.length, 1);
  assert.equal(result.courses[0].name, '高等数学(上)');
  assert.equal(result.detected.semesterStartMonday, '2026-02-23');
  assert.equal(result.detected.adjustmentCount, 1);
});

test('JSON 第三方抓包格式 → 字段模糊映射', () => {
  const payload = JSON.stringify({
    data: {
      kbcx: [
        { kcmc: '概率论', xq: '周三', jc: '5-6', cdmc: '教三-401', zc: '1-16周', jsxm: '孙老师' }
      ]
    }
  });
  const result = parse(payload, { kind: 'json' });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.courses[0].name, '概率论');
  assert.equal(result.sessions[0].dayOfWeek, 3);
  assert.equal(result.sessions[0].startPeriod, 5);
  assert.equal(result.sessions[0].endPeriod, 6);
  assert.equal(result.sessions[0].location, '教三-401');
});

/* ------------------------------------------------------------ 杂项 */

test('tagLine 类型标注', () => {
  assert.equal(tagLine('周一 第1-2节').kind, 'weekday');
  assert.equal(tagLine('第3-4节').kind, 'period');
  assert.equal(tagLine('1-16周(单)').kind, 'weeks');
  assert.equal(tagLine('教三-101').kind, 'location');
  assert.equal(tagLine('王老师').kind, 'teacher');
  assert.equal(tagLine('高等数学(上)').kind, 'text');
  assert.equal(tagLine('   ').kind, 'empty');
});

test('缺分号的 &nbsp（强智真实写法）要被解码，课名不能带一串 &nbspO', () => {
  // 真实页面：<font color='red'>&nbspO</font> —— 注意没有分号
  assert.equal(decodeEntities('数学分析(上)&nbspO'), '数学分析(上) O');
  assert.equal(decodeEntities('a&nbsp;b'), 'a b');
});
