/**
 * semesters.js — 内置校历：学期代码 → 第 1 周（周一）的日期。
 *
 * 与 `semester.js` 的分工：本文件是**离线可用的校历表**（粘贴 HTML / 文本通道用），
 * `semester.js` 处理安卓壳抓回来的表头日期信号（更强，优先）。
 *
 * 【为什么要内置一张表】
 * 教务系统不提供任何免登录的「校历 / 学期日期」接口（实测：未登录时每条路径都只返回
 * 登录页），登录后的课表页也只有「学年学期 2026-2027-1」这种代码，没有任何日期。
 * 而「第几周」必须有一个日期锚点才能算出来。所以与 holidays.js 一样：
 * **把已确认的校历数据内置**，从页面里认出学期代码后直接命中，离线也能用。
 *
 * 【纪律】
 *  - 只放**已确认**的学期（来源写清），查不到就是查不到，绝不按"大概是九月初"去猜。
 *  - 用户手动填过的学期起始日不会被覆盖（见 ui/import.js 的 applyDetectedSemester）。
 */

/**
 * @type {Array<{code:string, firstMonday:string|null, label:string, source:string,
 *               confirmed:boolean, note?:string}>}
 */
export const SEMESTERS = [
  {
    code: '2026-2027-1',
    firstMonday: '2026-08-31',
    label: '2026-2027 学年第一学期',
    source: '北京邮电大学 2026-2027 学年校历',
    confirmed: true,
    // 校历原文：8月24日为预备周；9月14日非新生上课，9月21日新生上课
    note: '8/24 预备周 · 9/14 非新生上课 · 9/21 新生上课'
  },
  {
    code: '2026-2027-2',
    firstMonday: null,
    label: '2026-2027 学年第二学期',
    source: '教务处春季校历尚未发布',
    confirmed: false,
    note: '待确认'
  }
];

const CN_TERM = { 一: 1, 二: 2 };

/**
 * 从一段文本里嗅出学期代码（`2026-2027-1` / `2026-2027学年第一学期`）。
 * @param {string} text
 * @returns {string|null} 归一化后的 `YYYY-YYYY-N`
 */
export function detectSemester(text) {
  const s = String(text == null ? '' : text);
  // ① 2026-2027-1 / 2026-2027－1 / 2026—2027—1
  const dashed = s.match(/(20\d{2})\s*[-－—–]\s*(20\d{2})\s*[-－—–]\s*([12])(?!\d)/);
  if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
  // ② 2026-2027学年第一学期 / 2026—2027学年 第2学期
  const named = s.match(/(20\d{2})\s*[-－—–]\s*(20\d{2})\s*学年\s*第?\s*([12一二])\s*学期/);
  if (named) {
    const term = CN_TERM[named[3]] || Number(named[3]);
    if (term) return `${named[1]}-${named[2]}-${term}`;
  }
  return null;
}

/** 按代码查内置校历。 */
export function findSemester(code) {
  if (!code) return null;
  return SEMESTERS.find((s) => s.code === code) || null;
}

/** 学期代码 → 第 1 周周一（没有确认数据时返回 null）。 */
export function firstMondayOf(code) {
  const entry = findSemester(code);
  return entry && entry.confirmed ? entry.firstMonday : null;
}

/**
 * 从页面文本里的「当前周次 / 本周」反推第 1 周周一（用于内置校历没有的新学期）。
 * 只认明确的标签，不去猜裸的「第 N 周」（周次下拉框里全是这种，会误判）。
 * @param {string} text
 * @param {string} today YYYY-MM-DD
 * @returns {{firstMonday:string, week:number}|null}
 */
export function inferFromCurrentWeek(text, today) {
  const s = String(text == null ? '' : text);
  const m = s.match(/(?:当前周次|当前教学周|本周为|本周是)\s*[:：]?\s*第?\s*(\d{1,2})\s*周/);
  if (!m) return null;
  const week = Number(m[1]);
  if (!Number.isInteger(week) || week < 1 || week > 30) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return null;

  // 今天是周几 → 本周周一 → 减去 (week-1) 周
  const [y, mo, d] = today.split('-').map(Number);
  const base = Date.UTC(y, mo - 1, d);
  const dow = new Date(base).getUTCDay() || 7; // 周日 = 7
  const thisMonday = base - (dow - 1) * 86400000;
  const first = thisMonday - (week - 1) * 7 * 86400000;
  const dt = new Date(first);
  const iso = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
    dt.getUTCDate()
  ).padStart(2, '0')}`;
  return { firstMonday: iso, week };
}

/**
 * 一次问清：这段文本里能确定学期起始日吗？
 * @param {string} text 页面源码或纯文本
 * @param {string} today YYYY-MM-DD
 * @returns {{code:string|null, firstMonday:string|null, source:'calendar'|'current-week'|null,
 *            confirmed:boolean, note:string|null}}
 */
export function resolveSemester(text, today) {
  const code = detectSemester(text);
  const entry = findSemester(code);
  if (entry && entry.confirmed) {
    return {
      code,
      firstMonday: entry.firstMonday,
      source: 'calendar',
      confirmed: true,
      note: entry.note || null
    };
  }
  const inferred = inferFromCurrentWeek(text, today);
  if (inferred) {
    return {
      code,
      firstMonday: inferred.firstMonday,
      source: 'current-week',
      confirmed: false,
      note: `按页面上的「第 ${inferred.week} 周」反推`
    };
  }
  return {
    code,
    firstMonday: null,
    source: null,
    confirmed: false,
    note: entry ? entry.source : null
  };
}
