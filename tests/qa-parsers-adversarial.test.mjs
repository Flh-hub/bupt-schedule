/**
 * qa-parsers-adversarial.test.mjs — 解析器对抗测试（QA 独立编写，不复用工程师断言）。
 *
 * 立场：PRD US-1 AC2/AC4、US-2 AC3、US-3 AC1/AC2、§8 E2/E14 要求
 *   「解析失败不得静默丢弃」「周次必须支持 1-8,10-16周 等离散写法」。
 * 这里全部按 PRD 行为写断言，不按实现写法写断言。
 *
 * 运行：node --test "tests/(glob)/.test.mjs"（实际命令见 docs/QA-REPORT.md，勿在注释里写星号斜杠）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { expandWeeks, parseWeeksText, DEFAULT_PERIODS } from '../src/model.js';
import { parseHtmlLite, parseJwgl, splitMultiCourse } from '../src/parsers/html.js';
import { parseText } from '../src/parsers/index.js';
import { SAMPLE_TEXT } from '../src/ui/components.js';

/** 造一张「节次 × 周一~周日」表。 */
function gridTable(bodyRows, headerCols = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']) {
  const head = `<tr><th>节次</th>${headerCols.map((c) => `<th>${c}</th>`).join('')}</tr>`;
  return `<table>${head}${bodyRows.join('')}</table>`;
}

/**
 * 把课次上的周次展开成数组，便于按行为断言（不依赖 start/end/extra 的具体打包方式）。
 * 适配器输出 `weeksText`（原文），normalize 之后输出 `weeks`（WeekSpec）+ `rawWeeksText`。
 */
const weeksOf = (session, totalWeeks = 20) => {
  const spec =
    session && session.weeks && typeof session.weeks === 'object'
      ? session.weeks
      : parseWeeksText((session && (session.weeksText || session.rawWeeksText)) || '', totalWeeks);
  return expandWeeks(spec);
};

/** 期望的周次数组。 */
function range(from, to) {
  const out = [];
  for (let w = from; w <= to; w += 1) out.push(w);
  return out;
}

/* ------------------------------------------------------------------ 周次文案 */

test('周次文案 8 种写法 → WeekSpec 与展开结果一致', () => {
  const cases = [
    ['1-16周', { start: 1, end: 16, type: 'all', extra: [] }, range(1, 16)],
    ['1-16周(单)', { start: 1, end: 16, type: 'odd', extra: [] }, [1, 3, 5, 7, 9, 11, 13, 15]],
    ['1-16周（双）', { start: 1, end: 16, type: 'even', extra: [] }, [2, 4, 6, 8, 10, 12, 14, 16]],
    ['1,3,5-9周', { start: 5, end: 9, type: 'all', extra: [1, 3] }, [1, 3, 5, 6, 7, 8, 9]],
    ['第1-16周', { start: 1, end: 16, type: 'all', extra: [] }, range(1, 16)],
    ['1~16周', { start: 1, end: 16, type: 'all', extra: [] }, range(1, 16)],
    ['2-16双周', { start: 2, end: 16, type: 'even', extra: [] }, [2, 4, 6, 8, 10, 12, 14, 16]],
    // 离散两段：1-8 与 10-16（第 9 周不上）
    ['1-8,10-16周', { start: 1, end: 8, type: 'all', extra: [10, 11, 12, 13, 14, 15, 16] }, [...range(1, 8), ...range(10, 16)]]
  ];

  for (const [text, spec, weeks] of cases) {
    assert.deepEqual(parseWeeksText(text, 20), spec, `「${text}」→ WeekSpec 不符`);
    assert.deepEqual(expandWeeks(parseWeeksText(text, 20)), weeks, `「${text}」→ 展开周次不符`);
  }
});

test('周次写法经 HTML 单元格解析后不丢失任何周', () => {
  const cases = [
    ['1-16周', range(1, 16)],
    ['1-16周(单)', [1, 3, 5, 7, 9, 11, 13, 15]],
    ['1-16周（双）', [2, 4, 6, 8, 10, 12, 14, 16]],
    ['1,3,5-9周', [1, 3, 5, 6, 7, 8, 9]],
    ['第1-16周', range(1, 16)],
    ['1~16周', range(1, 16)],
    ['2-16双周', [2, 4, 6, 8, 10, 12, 14, 16]],
    ['1-8,10-16周', [...range(1, 8), ...range(10, 16)]]
  ];

  for (const [text, weeks] of cases) {
    const html = gridTable([`<tr><td>第1-2节</td><td>高等数学<br>${text}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`]);
    const result = parseJwgl(html);
    assert.equal(result.sessions.length, 1, `「${text}」应解析出 1 条课次`);
    assert.deepEqual(weeksOf(result.sessions[0]), weeks, `「${text}」的周次被改写`);
  }
});

/* ------------------------------------------------------- rowspan / colspan 网格 */

test('rowspan 占位记账：后续行不左移，星期全部正确', () => {
  // 第 2 行「大物」占 2 行 → 第 3 行该列必须留空，否则第 3 行整行左移、星期全错。
  const html = gridTable(
    [
      '<tr><td>1</td><td>高数<br>1-16周</td><td>物理<br>1-16周</td><td>英语<br>1-16周</td><td>化学<br>1-16周</td></tr>',
      '<tr><td>2</td><td rowspan="2">大物<br>1-16周</td><td>线代<br>1-16周</td><td>概率<br>1-16周</td><td>体育<br>1-16周</td></tr>',
      '<tr><td>3</td><td>数据结构<br>1-16周</td><td>网络<br>1-16周</td><td>毛概<br>1-16周</td></tr>'
    ],
    ['周一', '周二', '周三', '周四']
  );

  const { sessions } = parseJwgl(html);
  const got = sessions.map((s) => `${s.name}@${s.dayOfWeek}`).sort();
  assert.deepEqual(
    got,
    ['数据结构@2', '大物@1', '体育@4', '化学@4', '概率@3', '毛概@4', '线代@2', '网络@3', '英语@3', '物理@2', '高数@1'].sort(),
    'rowspan 未记账会导致第 3 行整列左移（静默错位）'
  );

  const big = sessions.find((s) => s.name === '大物');
  assert.equal(big.startPeriod, 2);
  assert.ok(big.endPeriod >= 3, `rowspan=2 的连堂课应覆盖第 3 节，实际 endPeriod=${big.endPeriod}`);
});

test('colspan 表头把同一星期映射到多列（不串到下一星期）', () => {
  const html = `<table>
    <tr><th>节次</th><th colspan="2">周一</th><th>周二</th><th>周三</th></tr>
    <tr><td>第1节</td><td>高数<br>1-16周</td><td>物理<br>1-16周</td><td>英语<br>1-16周</td><td></td></tr>
  </table>`;
  const { sessions } = parseJwgl(html);
  const byName = Object.fromEntries(sessions.map((s) => [s.name, s.dayOfWeek]));
  assert.equal(byName['高数'], 1);
  assert.equal(byName['物理'], 1, 'colspan=2 的周一列，第二列仍应属于周一');
  assert.equal(byName['英语'], 2, 'colspan 之后的第一列应回到周二');
});

test('嵌套 table 不应导致整表课程静默丢失（PRD E2/E14）', () => {
  const html = `<table>
    <tr><th>节次</th><th>周一</th><th>周二</th><th>周三</th></tr>
    <tr>
      <td>第1节</td>
      <td><table><tr><td>内层高等数学 1-16周</td></tr></table></td>
      <td>大学物理<br>1-16周</td>
      <td>大学英语<br>1-16周</td>
    </tr>
  </table>`;

  const lite = parseHtmlLite(html);
  assert.equal(lite.tables.length >= 1, true);

  const result = parseJwgl(html);
  const names = result.sessions.map((s) => s.name);
  assert.ok(names.includes('大学物理'), `外层表格的兄弟单元格被静默丢弃，实际解析到：${JSON.stringify(names)}`);
  assert.ok(names.includes('大学英语'), `外层表格的兄弟单元格被静默丢弃，实际解析到：${JSON.stringify(names)}`);

  // 丢掉的课必须至少出现在「未识别行」里，不允许无声消失
  const recognized = names.length;
  const reported = result.unrecognized.length;
  const text = JSON.stringify(result.unrecognized);
  assert.ok(
    recognized + reported >= 3 || text.includes('内层高等数学'),
    '嵌套表格里的课程既没解析出来也没进未识别行 → 静默丢弃'
  );
});

/* ---------------------------------------------------------- 单元格内容对抗 */

test('同一单元格两门课 → 拆成两条课次，各自周次/地点独立', () => {
  const html = gridTable([
    '<tr><td>第1-2节</td><td>高数<br>1-2节<br>1-16周<br>教三-101<br>物理<br>3-4节<br>1-8周<br>教四-201</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>'
  ]);
  const { sessions } = parseJwgl(html);
  assert.equal(sessions.length, 2, '一格两门课应产出 2 条课次');
  const [a, b] = sessions;
  assert.equal(a.name, '高数');
  assert.equal(a.location, '教三-101');
  assert.deepEqual(weeksOf(a), range(1, 16));
  assert.equal(b.name, '物理');
  assert.equal(b.location, '教四-201');
  assert.deepEqual(weeksOf(b), range(1, 8));
});

test('单元格内 <br> 分隔的「课程名/教师/地点/周次」乱序仍可还原', () => {
  const cell = ['1-16周', '教三-201', '王老师', '高等数学'];
  const records = splitMultiCourse(cell);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, '高等数学');
  assert.equal(records[0].teacher, '王老师');
  assert.equal(records[0].location, '教三-201');
  assert.equal(records[0].weeksText, '1-16周');

  const reversed = splitMultiCourse(['教三-201', '高等数学', '1-16周', '王老师']);
  assert.equal(reversed.length, 1);
  assert.equal(reversed[0].name, '高等数学');
  assert.equal(reversed[0].location, '教三-201');
});

test('无课标记（无 / - / — / /）不产课次，但整体失败必须显式上报', () => {
  const html = gridTable(['<tr><td>第1-2节</td><td>无</td><td>-</td><td>—</td><td>/</td><td></td><td></td><td></td></tr>']);
  const result = parseJwgl(html);
  assert.equal(result.sessions.length, 0);
  assert.ok(result.unrecognized.length >= 1, '解析出 0 门课必须进未识别清单（PRD E14），不得静默返回空');
});

test('单元格只有周次、没有课名 → 进未识别行，不产出半条课次', () => {
  const html = gridTable(['<tr><td>第1-2节</td><td>1-16周</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>']);
  const result = parseJwgl(html);
  assert.equal(result.sessions.length, 0);
  assert.ok(
    result.unrecognized.some((u) => u.reason === 'MISSING_NAME'),
    `未识别行应标出缺失字段，实际：${JSON.stringify(result.unrecognized)}`
  );
});

/* ------------------------------------------------------------ 文本通道（P0-1 兜底） */

test('文本通道：教师名不得抢占课程名（PRD US-3 AC1）', () => {
  const parsed = parseText('周一 1-2节 高数 教三-101 王老师 1-16周(单)');
  assert.deepEqual(parsed.courses.map((c) => c.name), ['高数'], '"王老师"被当成了课程名');
  assert.equal(parsed.sessions[0].teacher, '王老师');
  assert.equal(parsed.sessions[0].location, '教三-101');
});

test('文本通道：英文教师名不得抢占中文课程名', () => {
  const parsed = parseText('周一 1-2节 大学英语 主楼-410 Sarah 1-16周');
  assert.deepEqual(parsed.courses.map((c) => c.name), ['大学英语'], '"Sarah"被当成了课程名');
  assert.equal(parsed.sessions[0].teacher, 'Sarah');
  assert.equal(parsed.sessions[0].location, '主楼-410');
});

test('文本通道：离散周次 1-8,10-16周 不得被截断成 10-16周', () => {
  const parsed = parseText('周一 1-2节 高数 教三-101 1-8,10-16周');
  assert.equal(parsed.sessions.length, 1);
  assert.deepEqual(
    weeksOf(parsed.sessions[0]),
    [...range(1, 8), ...range(10, 16)],
    '周次被截断 → 该课在 1-8 周直接从课表消失（学生缺课且无任何警告）'
  );
  assert.deepEqual(parsed.courses.map((c) => c.name), ['高数'], '被截断的周次残余「1-8」被当成了课程名');
});

test('文本通道：地点不含「教/楼」时不得与课程名错位', () => {
  const parsed = parseText('周四 7-8节 体育(羽毛球) 体育馆-2F 刘磊 1-8,10-16周');
  assert.equal(parsed.sessions.length, 1);
  const [course] = parsed.courses;
  assert.ok(course.name.includes('体育'), `课程名被识别成地点：${course.name}`);
  assert.equal(parsed.sessions[0].location, '体育馆-2F', '体育馆-2F 未被识别为地点');
  assert.equal(parsed.sessions[0].teacher, '刘磊');
  assert.deepEqual(weeksOf(parsed.sessions[0]), [...range(1, 8), ...range(10, 16)]);
});

test('文本通道：带校区前缀的地点（沙河校区-教学楼A101）不得把残片当课程名', () => {
  const parsed = parseText('周一 3-4节 大学物理 沙河校区-教学楼A101 李明 1-16周');
  assert.deepEqual(parsed.courses.map((c) => c.name), ['大学物理'], '地点残片「沙河校区-」被当成了课程名');
  assert.ok(
    parsed.sessions[0].location.includes('沙河') || parsed.sessions[0].location.includes('教学楼'),
    `地点识别不全：${parsed.sessions[0].location}`
  );
});

test('文本通道：应用自带示例数据（SAMPLE_TEXT）导入后课程名必须与示例一致', () => {
  const expected = ['高等数学(上)', '大学物理(下)', '数据结构', '大学英语', '概率论与数理统计', '计算机网络', '体育(羽毛球)', '毛概'];
  const parsed = parseText(SAMPLE_TEXT);
  const names = parsed.courses.map((c) => c.name);
  assert.equal(parsed.unrecognized.length, 0, `示例数据不应有未识别行：${JSON.stringify(parsed.unrecognized)}`);
  const matches = (want) => names.some((n) => n === want || want.startsWith(n) || n.startsWith(want));
  for (const want of expected) {
    assert.ok(matches(want), `示例中的「${want}」未能正确识别，实际课程名：${JSON.stringify(names)}`);
  }
  // 体育课是 1-8,10-16 周 + 体育馆-2F，重点回归离散周次与地点
  const pe = parsed.sessions.find((s) => {
    const c = parsed.courses.find((x) => x.id === s.courseId);
    return c && c.name.includes('体育');
  });
  assert.ok(pe, '体育课丢失');
  assert.deepEqual(weeksOf(pe), [...range(1, 8), ...range(10, 16)], '示例里体育课的离散周次被截断');
  assert.ok(pe.location.includes('体育馆'), `示例里体育课的地点丢失：${JSON.stringify(pe.location)}`);
});

test('文本通道：无法解析的行必须给出原因（不得静默跳过）', () => {
  const parsed = parseText('周一 体育');
  assert.equal(parsed.sessions.length, 0);
  assert.equal(parsed.unrecognized.length, 1);
  assert.equal(parsed.unrecognized[0].reason, 'MISSING_PERIOD');
});

test('默认节次预设可用于时间制反查（08:00 属于第 1 节）', () => {
  const p1 = DEFAULT_PERIODS.find((p) => p.index === 1);
  assert.equal(p1.start, '08:00');
  const parsed = parseText('周一 08:00-09:35 线性代数 教三-102 张老师 1-16周');
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0].startPeriod, 1);
});
