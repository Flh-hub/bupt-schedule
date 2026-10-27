/**
 * semester.js — 纯逻辑：**从抓取信号**（课表表头日期 / 当前周文本）推断「学期第 1 周周一」。
 *
 * 与 `semesters.js` 的分工（两个文件名字相近，别混）：
 *   - `semesters.js`：**内置校历表**（学期代码 → 第 1 周周一）+ 手写解析，用于「粘贴 HTML / 文本」通道；
 *   - 本文件：只吃安卓壳抓回来的 `payload.signals`（表头 `周一 08-31` + `第1周`），
 *     是更强的证据（教务自己算好的日历），能读到就覆盖内置表的结论。
 *
 * 【为什么需要】App 的所有周次判断（今天第几周、某周有哪些课、要不要提醒）都依赖
 * `settings.semesterStartMonday`。以前只能让用户自己去设置页填一个日期，
 * 而教务系统其实**知道今天是第几教学周**——抓到它就能反推出开学日。
 *
 * 【纪律】本文件不碰 DOM、不发请求：信号由原生抓取侧采集后作为普通对象传进来，
 * 这里只做正则匹配与日期换算，因此可以直接在 Node 里测。
 */

import { addDays, diffDays, isDateStr, startMondayOfWeek, todayStr, weekNoOf } from './model.js';

/**
 * 强信号：教务页面/标题里明说「当前第 N 周」。
 * 顺序即优先级（越具体越靠前）。注意每条都要求出现「当前 / 本周 / 今天」这类词，
 * 否则课表单元格里的「4-7(周)」「第1-2节」会被误当成当前周。
 */
const STRONG_PATTERNS = [
  { re: /当前\s*周次\s*[:：]?\s*第?\s*(\d{1,2})\s*周/, source: '当前周次' },
  { re: /当前\s*(?:正在|已)?\s*(?:是)?\s*第\s*(\d{1,2})\s*(?:教学)?周/, source: '当前第N周' },
  { re: /(?:现在|目前|如今)\s*是\s*第\s*(\d{1,2})\s*(?:教学)?周/, source: '现在是第N周' },
  { re: /本周\s*(?:是|为)?\s*第?\s*(\d{1,2})\s*(?:教学)?周/, source: '本周第N周' },
  { re: /今天[^\n]{0,16}?第\s*(\d{1,2})\s*(?:教学)?周/, source: '今天→第N周' },
  { re: /第\s*(\d{1,2})\s*(?:教学)?周[^\n]{0,8}(?:今天|本周|当前)/, source: '第N周(近)' },
  // ★ 强智学生首页的真实写法：`2026-2027-1 第8周`（学期代码紧挨周次，最硬的信号之一）
  {
    re: /20\d{2}\s*[-－—]\s*20\d{2}\s*[-－—]\s*[12][^0-9]{0,12}第\s*(\d{1,2})\s*周/,
    source: '首页「学期代码 + 第N周」'
  },
  // ★ 不要加"第N周 后面跟学期代码"这种反向规则：周次下拉的文本长这样
  //   「(全部) 第1周 第2周 … 第30周 2028-2029-2」，会配出「第30周 @ 2028-2029-2」
  //   这种完全离谱的结论（实测把起始日算成了 2026-03-30）。
];

/** 弱信号：只是「周次」下拉里的选中项，只能作为候选让用户确认。 */
const WEAK_PATTERNS = [{ re: /^\s*第?\s*(\d{1,2})\s*周\s*$/, source: '周次下拉选中项' }];

function pick(list, patterns) {
  const texts = (Array.isArray(list) ? list : []).map((t) => String(t == null ? '' : t));
  for (const p of patterns) {
    for (const text of texts) {
      const m = text.match(p.re);
      if (!m) continue;
      const week = Number(m[1]);
      // ★ 上限 26：国内学期最多二十几周。放宽到 30 会让周次下拉里的「第30周」混进来
      if (Number.isInteger(week) && week >= 1 && week <= 26) return { week, source: p.source };
    }
  }
  return null;
}

/**
 * 从一组文本里提取「当前第几教学周」。
 * @param {string[]} texts 页面顶部文本 / 标题
 * @param {string[]} [weakTexts] 下拉选中项等弱信号
 * @returns {{week:number, source:string, strong:boolean}|null}
 */
export function extractCurrentWeek(texts, weakTexts = []) {
  const strong = pick(texts, STRONG_PATTERNS);
  if (strong) return { ...strong, strong: true };
  const weak = pick(weakTexts, WEAK_PATTERNS);
  if (weak) return { ...weak, strong: false };
  return null;
}

/**
 * 课表表头的日期（MM-DD）→ 该表头那一周的周一。
 *
 * 表头写的是 `周一 08-31 … 周日 09-06`，**不带年份**，所以年份要推断：
 * 依次试 今年 / 去年 / 明年，取「离今天最近且落在合理范围（表头不至于比今天晚一周以上，
 * 也不至于早 25 周）」的那个。学期跨年很常见（1 月看的是去年 12 月的课表），
 * 只按今年补会把 12-28 算到明年 12 月。
 *
 * @param {string[]} dates MM-DD 列表
 * @param {string|null} picker 日期选择器的值（YYYY-MM-DD，若页面有）
 * @param {string} today
 * @returns {string|null} YYYY-MM-DD
 */
export function mondayOfHeaderDates(dates, picker, today = todayStr()) {
  if (isDateStr(picker)) return picker;
  const list = (Array.isArray(dates) ? dates : [])
    .filter((d) => typeof d === 'string' && /^\d{2}-\d{2}$/.test(d))
    .sort();
  if (!list.length) return null;
  const [mm, dd] = list[0].split('-');
  const m = Number(mm);
  const d = Number(dd);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  const year = Number(today.slice(0, 4));
  let best = null;
  for (const offset of [0, -1, 1]) {
    const candidate = `${year + offset}-${mm}-${dd}`;
    if (!isDateStr(candidate)) continue;
    const delta = diffDays(today, candidate); // 候选日期 - 今天
    if (delta > 7 || delta < -7 * 25) continue; // 表头不该在未来，也不该是半年前
    if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { candidate, delta };
  }
  return best ? best.candidate : null;
}



/**
 * 学期代码 → 该学期允许的起始日区间（用来兜住离谱结论）。
 *
 * `2026-2027-1` 的第一周不可能在 2026 年 3 月；`2026-2027-2` 也不可能在 9 月。
 * 只要解析出的起始日越界，就判定这条证据不可信。
 *
 * @param {string|null} term
 * @returns {{from:string,to:string}|null}
 */
export function termWindow(term) {
  const m = /(20\d{2})\s*[-－—]\s*(20\d{2})\s*[-－—]\s*([12])/.exec(String(term || ''));
  if (!m) return null;
  const y1 = Number(m[1]);
  const half = m[3];
  // 第 1 学期：8 月中 ~ 次年 3 月底；第 2 学期：1 月中 ~ 9 月底
  return half === '1'
    ? { from: `${y1}-07-15`, to: `${y1 + 1}-03-31` }
    : { from: `${y1}-12-15`, to: `${y2Safe(y1)}-09-30` };
}

function y2Safe(y1) {
  return y1 + 1;
}

/** 结论是否与该学期代码自洽（没给 term 就放行）。 */
export function insideTermWindow(startMonday, term) {
  const w = termWindow(term);
  if (!w) return true;
  if (!isDateStr(startMonday)) return false;
  return startMonday >= w.from && startMonday <= w.to;
}

/**
 * 教务「周历」月历 → 学期起始日（**目前最稳的来源**）。
 *
 * 学生首页右上角点时间会打开 `/jsxsd/framework/xsjsdPerson_zlxx.jsp`，它是一个月历：
 *
 *   教学第8周
 *   2026年10月  一 二 三 四 五 六 日
 *   第七周  12 13 14 15 16 17 18
 *   第八周  19 20 21 22 23 24 25     ← 当前周那一行带 class="currentMoth"
 *
 * 这等于教务亲口告诉你「第 8 周 = 10-19 ~ 10-25」，于是
 *   第 1 周周一 = 该行周一(10-19) − (8−1)×7 = 08-31
 * 不需要猜年份、不依赖"今天是第几周"的文本措辞，只要页面还在就能算出来。
 *
 * @param {{year:number, month:number, firstDay:number, week:number, term?:string|null}} cal
 * @param {string} [today]
 */
export function startMondayFromMonthCalendar(cal, today = todayStr()) {
  if (!cal) return null;
  const year = Number(cal.year);
  const month = Number(cal.month);
  const day = Number(cal.firstDay);
  const week = Number(cal.week);
  if (![year, month, day, week].every((v) => Number.isInteger(v))) return null;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (week < 1 || week > 26) return null;

  const pad = (v) => String(v).padStart(2, '0');
  const monday = `${year}-${pad(month)}-${pad(day)}`;
  if (!isDateStr(monday)) return null;
  // 周历的第一列是周一：不是周一说明解析错了，宁可不用
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() !== 1) return null;

  const startMonday = addDays(monday, -(week - 1) * 7);
  if (!isDateStr(startMonday) || startMonday > today) return null;
  // ★ 自检：周历上标出的那一行必须是"本周"，即今天要落在 [周一, 周日] 里。
  //   不能用 weekNoOf(today, startMonday) === week 来自检——startMonday 本来就是从
  //   week 反推的，那样是循环论证，任何 (week, 周一) 组合都能"自洽"通过。
  const delta = diffDays(monday, today); // diffDays(from, to) = to - from，正数表示今天晚于该周一
  if (!Number.isInteger(delta) || delta < 0 || delta > 6) return null;

  if (!insideTermWindow(startMonday, cal.term)) return null;

  return {
    startMonday,
    week,
    source: `周历「第${week}周 · ${monday}」`,
    strong: true,
    today,
    term: cal.term || null,
    anchorMonday: monday
  };
}

/**
 * 表头证据 → 学期起始日（最强信号）。
 *
 * 用户截图里的课表页就是这种形态：表头 `周一 08-31`，周次下拉 `第1周`。
 * 公式：第 1 周周一 = 表头周一 - (N-1) * 7。
 *
 * @param {{week?:number|null, dates?:string[], picker?:string|null, term?:string|null}} anchor
 * @param {string} [today]
 */
export function detectWeekAnchor(anchor, today = todayStr()) {
  if (!anchor) return null;
  const week = Number(anchor.week);
  if (!Number.isInteger(week) || week < 1 || week > 30) return null;
  const monday = mondayOfHeaderDates(anchor.dates, anchor.picker, today);
  if (!monday) return null;

  const startMonday = addDays(monday, -(week - 1) * 7);
  if (!isDateStr(startMonday) || startMonday > today) return null;
  // 自检：起始日必须落在「今天的前 30 周内」，否则说明年份或周次错位了
  const weekNow = weekNoOf(today, startMonday);
  if (!Number.isInteger(weekNow) || weekNow < 1 || weekNow > 30) return null;
  if (!insideTermWindow(startMonday, anchor.term)) return null;

  return {
    startMonday,
    week,
    source: `课表表头 ${monday} · ${week === 1 ? '第1周' : `第${week}周`}`,
    strong: true,
    today,
    term: anchor.term || null,
    anchorMonday: monday
  };
}

/**
 * 抓取结果 → 学期起始日建议。
 *
 * 优先级：**表头日期**（最硬，教务页面自己算好的日历） > 页面明说「当前第 N 周」 > 周次下拉选中项（弱）。
 *
 * @param {{signals?:object}} payload 原生回灌的抓取包
 * @param {{today?:string}} [opts]
 * @returns {{startMonday:string, week:number, source:string, strong:boolean, today:string, term:string|null}|null}
 */
export function detectSemesterStart(payload, opts = {}) {
  const today = isDateStr(opts.today) ? opts.today : todayStr();
  const sig = (payload && payload.signals) || {};

  const anchor = detectWeekAnchor(sig.weekAnchor, today);
  if (anchor) return anchor;

  // 周历（月历）里有「第 N 周 = 哪天到哪天」，比"当前第 N 周"的文本措辞稳得多
  const byCalendar = startMondayFromMonthCalendar(sig.calendar, today);
  if (byCalendar) return byCalendar;

  const texts = [].concat(sig.titles || [], sig.weekTexts || []);
  const hit = extractCurrentWeek(texts, sig.weakTexts || []);
  if (!hit) return null;

  const startMonday = startMondayOfWeek(hit.week, today);
  if (!startMonday || !isDateStr(startMonday)) return null;
  if (startMonday > today) return null;
  // 自检：反推回去必须还是同一周（防止 today 与 week 组合越界后算出奇怪的日期）
  if (weekNoOf(today, startMonday) !== hit.week) return null;
  // 再兜一层：结论必须与该学期代码自洽，否则宁可不给（例如「第30周 @ 2028-2029-2」）
  if (!insideTermWindow(startMonday, (sig.weekAnchor && sig.weekAnchor.term) || null)) return null;

  return {
    startMonday,
    week: hit.week,
    source: hit.source,
    strong: hit.strong,
    today,
    term: (sig.weekAnchor && sig.weekAnchor.term) || null
  };
}
