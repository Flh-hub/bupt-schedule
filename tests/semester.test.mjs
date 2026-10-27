/**
 * semester.test.mjs — 「自动找学期起始周」的契约。
 *
 * 逻辑很轻但错不起：算错一周，整张课表、提醒、节假日静默全部错位一周。
 * 所以这里既测正向（各种页面写法都能认），也测**反向**（课表格子里的 `4-7(周)`
 * 绝不能被当成"当前第 7 周"）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startMondayOfWeek, weekNoOf } from '../src/model.js';
import {
  detectSemesterStart,
  detectWeekAnchor,
  extractCurrentWeek,
  insideTermWindow,
  mondayOfHeaderDates,
  startMondayFromMonthCalendar
} from '../src/semester.js';

const TODAY = '2026-10-23'; // 周五，所在周周一 = 2026-10-19

test('第 N 周 → 第 1 周周一（以今天为锚，按周一对齐）', () => {
  assert.equal(startMondayOfWeek(1, TODAY), '2026-10-19');
  assert.equal(startMondayOfWeek(7, TODAY), '2026-09-07');
  assert.equal(startMondayOfWeek(8, TODAY), '2026-08-31');
  assert.equal(startMondayOfWeek(0, TODAY), null);
  assert.equal(startMondayOfWeek(31, TODAY), null);
});

test('反推结果与原函数互相一致（绕一圈回到同一周）', () => {
  for (let w = 1; w <= 20; w += 1) {
    const start = startMondayOfWeek(w, TODAY);
    assert.ok(start, `第 ${w} 周应有结果`);
    assert.equal(weekNoOf(TODAY, start), w, `第 ${w} 周反推后再正算不一致`);
    // 起始日必须是周一
    assert.equal(startMondayOfWeek(1, start), start);
  }
});

test('周日也要算在同一周（不能差 7 天）', () => {
  // 2026-10-25 是周日，属于 10-19 那一周
  assert.equal(startMondayOfWeek(1, '2026-10-25'), '2026-10-19');
  assert.equal(startMondayOfWeek(7, '2026-10-25'), '2026-09-07');
});

test('认得教务页面里的「当前第 N 周」各种写法', () => {
  const cases = [
    ['当前第7周', 7],
    ['当前周次：第 7 周', 7],
    ['当前 周次: 7 周', 7],
    ['本周是第7周', 7],
    ['今天是第 7 教学周', 7],
    ['第7周 今天 星期三', 7],
    ['欢迎你，现在是第12周', 12]
  ];
  for (const [text, week] of cases) {
    const hit = extractCurrentWeek([text]);
    assert.ok(hit, `没认出：${text}`);
    assert.equal(hit.week, week, `认错周次：${text}`);
    assert.equal(hit.strong, true, `${text} 应为强信号`);
  }
});

test('课表格子里的「4-7(周)」「第1-2节」不能被当成当前周', () => {
  const cells = [
    '大学生心理健康1\n王培\n4-7(周)[01-02节]\n教学实验综合楼-S215',
    '数学分析(上) P\n李晓莉\n8(周)[02-03-04节]',
    '第1-2节 高等数学',
    '周次：4-19(周)'
  ];
  for (const text of cells) {
    assert.equal(extractCurrentWeek([text]), null, `误判成当前周：${text}`);
  }
});

test('周次下拉的选中项只能算弱信号（不自动写，交给用户点）', () => {
  const hit = extractCurrentWeek(['课程表'], ['第 7 周']);
  assert.ok(hit);
  assert.equal(hit.week, 7);
  assert.equal(hit.strong, false);
});

test('detectSemesterStart：强信号 → 给出起始日并标记 strong', () => {
  const payload = {
    signals: {
      titles: ['学生主页'],
      weekTexts: ['欢迎你，今天是第 7 周', '2026-2027 学年第一学期'],
      weakTexts: ['全部']
    }
  };
  const guess = detectSemesterStart(payload, { today: TODAY });
  assert.ok(guess);
  assert.equal(guess.week, 7);
  assert.equal(guess.startMonday, '2026-09-07');
  assert.equal(guess.strong, true);
  assert.equal(guess.today, TODAY);
});

test('detectSemesterStart：没信号 / 信号无效 → null（不能瞎猜）', () => {
  assert.equal(detectSemesterStart({}, { today: TODAY }), null);
  assert.equal(detectSemesterStart({ signals: { weekTexts: [] } }, { today: TODAY }), null);
  assert.equal(
    detectSemesterStart({ signals: { weekTexts: ['当前第 99 周'] } }, { today: TODAY }),
    null,
    '周次越界必须拒绝'
  );
  assert.equal(
    detectSemesterStart({ signals: { weekTexts: ['4-7(周)[01-02节]'] } }, { today: TODAY }),
    null,
    '课表格子不能触发自动设置'
  );
});

test('detectSemesterStart：今天在第 1 周时起始日就是本周一', () => {
  const guess = detectSemesterStart({ signals: { weekTexts: ['当前第1周'] } }, { today: TODAY });
  assert.equal(guess.startMonday, '2026-10-19');
});

/* ---------------------------------------------------------------- 表头日期（最硬信号） */

test('表头「周一 08-31 … 周日 09-06」+ 第1周 → 起始日 2026-08-31', () => {
  // 用户截图里的真实形态
  const anchor = {
    week: 1,
    dates: ['08-31', '09-01', '09-02', '09-03', '09-04', '09-05', '09-06'],
    picker: '2026-08-31',
    term: '2026-2027-1'
  };
  const guess = detectWeekAnchor(anchor, TODAY);
  assert.ok(guess);
  assert.equal(guess.startMonday, '2026-08-31');
  assert.equal(guess.week, 1);
  assert.equal(guess.term, '2026-2027-1');
  assert.equal(guess.strong, true);
  // 今天 2026-10-23 应落在第 8 周
  assert.equal(weekNoOf(TODAY, guess.startMonday), 8);
});

test('表头日期没有年份时按今天补，跨年不会算到明年', () => {
  assert.equal(mondayOfHeaderDates(['08-31', '09-01'], null, TODAY), '2026-08-31');
  // 1 月看的课表，表头是 12-28 → 应补成去年
  assert.equal(mondayOfHeaderDates(['12-28', '12-29'], null, '2027-01-10'), '2026-12-28');
  // 有日期选择器时以它为准确值
  assert.equal(mondayOfHeaderDates(['08-31'], '2026-09-07', TODAY), '2026-09-07');
  assert.equal(mondayOfHeaderDates([], null, TODAY), null);
});

test('看的是第 3 周（表头 09-14）也能倒推到第 1 周', () => {
  const guess = detectWeekAnchor({ week: 3, dates: ['09-14', '09-15'], picker: null }, TODAY);
  assert.equal(guess.startMonday, '2026-08-31');
});

test('表头信号优先于文本信号（页面上两处不一致时以日历为准）', () => {
  const payload = {
    signals: {
      weekAnchor: { week: 1, dates: ['08-31'], picker: '2026-08-31', term: '2026-2027-1' },
      weekTexts: ['欢迎你，现在是第 10 周']
    }
  };
  const guess = detectSemesterStart(payload, { today: TODAY });
  assert.equal(guess.startMonday, '2026-08-31');
  assert.equal(guess.source.includes('课表表头'), true);
});

test('表头只有日期没有周次 → 不用（会差好几周）', () => {
  assert.equal(detectWeekAnchor({ week: null, dates: ['08-31'] }, TODAY), null);
  assert.equal(detectWeekAnchor({ week: 0, dates: ['08-31'] }, TODAY), null);
});

/* ------------------------------------------------------------ 真实教务首页的写法（2026-10-25 实测） */

test('首页「2026-2027-1 第8周」→ 第 1 周周一 = 2026-08-31', () => {
  // 这是从 jwgl.bupt.edu.cn 登录后 xsMain 里抓到的真实文本：
  //   <span style="width: 190px;">2026-2027-1 第8周</span>
  const week = extractCurrentWeek(['2026-2027-1 第8周']);
  assert.equal(week && week.week, 8);
  assert.equal(week && week.strong, true);

  const out = detectSemesterStart(
    { signals: { weekTexts: ['2026-2027-1 第8周'], titles: [''], weakTexts: [] } },
    { today: '2026-10-25' }
  );
  assert.ok(out, '应识别出起始日');
  assert.equal(out.startMonday, '2026-08-31', '与学校校历一致');
  assert.equal(out.week, 8);
});

test('反序写法「第8周 2026-2027-1」**不再**当强信号（它和下拉罗列长得一样）', () => {
  // 2026-10-25 真机踩过：周次下拉的文本是「第1周 … 第30周 2028-2029-2」，
  // 反序规则会配出「第30周 @ 2028-2029-2」→ 起始日算成 2026-03-30。
  // 教务首页的真实写法是「学期代码 在前」：`2026-2027-1 第8周`，所以只认这个方向。
  const out = detectSemesterStart(
    { signals: { weekTexts: ['第8周（2026-2027-1）'], titles: [''], weakTexts: [] } },
    { today: '2026-10-25' }
  );
  assert.equal(out, null, '反序文本不可信，宁愿让用户手选');
});

test('没有学期代码的裸「第8周」不当成强信号（避免课上到一半被误判）', () => {
  const week = extractCurrentWeek(['第8周']);
  assert.equal(week, null, '裸第N周只能走弱信号/下拉，不能直接定起始日');
});

/* ------------------------------------------------------------ 周历（月历）推算（2026-10-25 实测） */

test('周历「第8周 = 10-19 起」→ 第 1 周周一 = 2026-08-31', () => {
  const out = startMondayFromMonthCalendar(
    { year: 2026, month: 10, firstDay: 19, week: 8, term: '2026-2027-1' },
    '2026-10-25'
  );
  assert.ok(out);
  assert.equal(out.startMonday, '2026-08-31');
  assert.equal(out.week, 8);
  assert.equal(out.term, '2026-2027-1');
});

test('周历自检：给的日期不是周一 → 不用（防止解析错位）', () => {
  assert.equal(
    startMondayFromMonthCalendar({ year: 2026, month: 10, firstDay: 20, week: 8 }, '2026-10-25'),
    null
  );
});

test('周历自检：标出的那一行不是"本周" → 不用（防止抓到别人的行）', () => {
  // 10-12 那一周（10-12 ~ 10-18）不包含今天 10-25，说明拿错了行
  assert.equal(
    startMondayFromMonthCalendar({ year: 2026, month: 10, firstDay: 12, week: 7 }, '2026-10-25'),
    null
  );
  // 换成包含今天的那一行就正常
  assert.equal(
    startMondayFromMonthCalendar({ year: 2026, month: 10, firstDay: 19, week: 8 }, '2026-10-25').startMonday,
    '2026-08-31'
  );
});

test('周历跨月也成立（12 月看第 1 周）', () => {
  const out = startMondayFromMonthCalendar({ year: 2026, month: 12, firstDay: 7, week: 1 }, '2026-12-07');
  assert.equal(out && out.startMonday, '2026-12-07', '第 1 周就是 12-07 那周');
});

test('detectSemesterStart 会优先用周历（即使没有 weekAnchor）', () => {
  const out = detectSemesterStart(
    { signals: { calendar: { year: 2026, month: 10, firstDay: 19, week: 8 } } },
    { today: '2026-10-25' }
  );
  assert.equal(out && out.startMonday, '2026-08-31');
});

/* ------------------------------------------------------------ 误判回归（2026-10-25 真机截图） */

test('周次下拉的罗列文本不能被当成"当前第 30 周"', () => {
  // 真实页面文本形如：(全部) 第1周 第2周 … 第30周 2028-2029-2 2027-2028-2 …
  const dump = '(全部) 第1周 第2周 第3周 第30周 2028-2029-2 2027-2028-2';
  assert.equal(extractCurrentWeek([dump]), null, '下拉罗列不是强信号');
  const out = detectSemesterStart({ signals: { weekTexts: [dump] } }, { today: '2026-10-25' });
  assert.equal(out, null, '宁可识别不出，也不能给出 2026-03-30 这种结论');
});

test('学期代码一致性：2028-2029-2 的起始日不能是 2026-03-30', () => {
  assert.equal(insideTermWindow('2026-03-30', '2028-2029-2'), false);
  assert.equal(insideTermWindow('2028-08-31', '2028-2029-1'), true);
  assert.equal(insideTermWindow('2029-02-26', '2028-2029-2'), true);
  assert.equal(insideTermWindow('2026-08-31', '2026-2027-1'), true);
  // 没有学期代码时放行（不阻断其他证据）
  assert.equal(insideTermWindow('2026-03-30', null), true);
});

test('周历给的 term 与日期不自洽 → 整条结论作废', () => {
  // 第 8 周 + 10-19（2026 秋），却标成 2028-2029-2 → 拒绝
  assert.equal(
    startMondayFromMonthCalendar(
      { year: 2026, month: 10, firstDay: 19, week: 8, term: '2028-2029-2' },
      '2026-10-25'
    ),
    null
  );
});
