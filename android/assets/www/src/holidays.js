/**
 * holidays.js — 纯逻辑：内置节假日 / 调休补班数据 + 索引 + 三态翻译。
 *
 * 【硬约束】零 DOM（无 document/window/localStorage/navigator/fetch），可 node --test 直测。
 *
 * 【数据来源】国务院办公厅《关于 2026 年部分节假日安排的通知》（2025-11-04，
 * dataRevision = 'gb-2025-11-04'）。33 个放假日 + 6 个调休上班日，与通知原文逐条核对。
 *
 * 【`followDayOfWeek` 三态契约】（ARCHITECTURE §0.1 修正 4）
 *   `1..7`  → 已确认按周 X 的课表上课
 *   `'none'`→ 用户显式确认"这天确实没课"
 *   `null`  → **未确认**（"不知道这天有没有课"），绝不等于"没课"
 *
 *   ★ 除 `2026-01-04` 外，其余 5 个补班日一律 `null`：
 *     元旦只借用 01-02（周五）一个工作日，而补班日只有 01-04 一个 → 1:1 唯一解 → 5（inferred）。
 *     春节（借 3 天 vs 补 2 天）、劳动节、国庆（借用数 > 补班数）映射**不唯一**，
 *     猜错学生会按错课表上课 → 必须留 `null`，由用户在学校发通知后点选。
 *
 * 【本文件只做三态翻译，不产出 status】status 由 calendar.classifyDay 组装。
 */

import { dayOfWeekOf, isDateStr, diffDays } from './model.js';

export const OFFICIAL_SOURCE = '国务院办公厅《关于 2026 年部分节假日安排的通知》（2025-11-04）';
export const DATA_REVISION = 'gb-2025-11-04';
export const TENTATIVE_SOURCE = '国务院尚未发布 2027 年安排，按惯例预留';

/** 逐日展开：起止日期 → 'YYYY-MM-DD' 数组。 */
function range(from, to) {
  const out = [];
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  const start = Date.UTC(y1, m1 - 1, d1);
  const end = Date.UTC(y2, m2 - 1, d2);
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t);
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    out.push(`${d.getUTCFullYear()}-${mm}-${dd}`);
  }
  return out;
}

/** 放假条目（type='holiday'）。 */
function holidayDays(name, from, to, note) {
  return range(from, to).map((date) => ({
    date,
    name,
    type: 'holiday',
    followDayOfWeek: null,
    inferred: false,
    tentative: false,
    source: 'builtin2026',
    dataRevision: DATA_REVISION,
    note: note || OFFICIAL_SOURCE,
    updatedAt: null
  }));
}

/** 调休上班条目（type='makeupWorkday'）。 */
function makeupDay(date, name, followDayOfWeek, note) {
  const inferred = typeof followDayOfWeek === 'number';
  return {
    date,
    name,
    type: 'makeupWorkday',
    followDayOfWeek: followDayOfWeek == null ? null : followDayOfWeek,
    inferred,
    tentative: false,
    source: 'builtin2026',
    dataRevision: DATA_REVISION,
    note: note || OFFICIAL_SOURCE,
    updatedAt: null
  };
}

/**
 * 2026 年内置数据：33 个放假日 + 6 个调休上班日。
 * ★ 顺序与 TASKS.md T2「已核实的 BUILTIN_2026 数据」一致，不要自行增删。
 */
export const BUILTIN_2026 = [
  // ---------- 元旦：01-01(四) 01-02(五) 01-03(六) 放假 3 天 ----------
  ...holidayDays('元旦', '2026-01-01', '2026-01-03', '2026 年元旦放假 3 天'),
  // 2026-01-04(日) 上班：唯一能推定的补班日（1:1 唯一解 → 补 01-02 周五）
  makeupDay('2026-01-04', '元旦调休上班', 5, '推定补 01-02（周五）的课，请按北邮校历核对'),

  // ---------- 春节：02-15(日) ~ 02-23(一) 放假 9 天 ----------
  ...holidayDays('春节', '2026-02-15', '2026-02-23', '2026 年春节放假 9 天'),
  makeupDay('2026-02-14', '春节调休上班', null, '借用 3 个工作日 vs 补班 2 天，映射不唯一，需按校历确认'),
  makeupDay('2026-02-28', '春节调休上班', null, '借用 3 个工作日 vs 补班 2 天，映射不唯一，需按校历确认'),

  // ---------- 清明节：04-04(六) ~ 04-06(一) 放假 3 天（无补班） ----------
  ...holidayDays('清明节', '2026-04-04', '2026-04-06', '2026 年清明放假 3 天，无调休上班'),

  // ---------- 劳动节：05-01(五) ~ 05-05(二) 放假 5 天 ----------
  ...holidayDays('劳动节', '2026-05-01', '2026-05-05', '2026 年劳动节放假 5 天'),
  makeupDay('2026-05-09', '劳动节调休上班', null, '补班日与被借用工作日非 1:1，需按校历确认'),

  // ---------- 端午节：06-19(五) ~ 06-21(日) 放假 3 天（无补班） ----------
  ...holidayDays('端午节', '2026-06-19', '2026-06-21', '2026 年端午放假 3 天，无调休上班'),

  // ---------- 中秋节：09-25(五) ~ 09-27(日) 放假 3 天（无补班） ----------
  ...holidayDays('中秋节', '2026-09-25', '2026-09-27', '2026 年中秋放假 3 天，无调休上班'),

  // ---------- 国庆节：10-01(四) ~ 10-07(三) 放假 7 天 ----------
  ...holidayDays('国庆节', '2026-10-01', '2026-10-07', '2026 年国庆放假 7 天'),
  makeupDay('2026-09-20', '国庆调休上班', null, '借用工作日多于补班日，映射不唯一，需按校历确认'),
  makeupDay('2026-10-10', '国庆调休上班', null, '借用工作日多于补班日，映射不唯一，需按校历确认')
];

/**
 * 2027 元旦预留（国务院尚未发布安排）。
 * ★ 单独成表，**不计入** `BUILTIN_2026`（G11 断言 33 + 6 不受污染），但会进索引参与判定。
 */
export const BUILTIN_2027_TENTATIVE = range('2027-01-01', '2027-01-03').map((date) => ({
  date,
  name: '元旦（待确认）',
  type: 'holiday',
  followDayOfWeek: null,
  inferred: false,
  tentative: true,
  source: 'builtin2026',
  dataRevision: DATA_REVISION,
  note: TENTATIVE_SOURCE,
  updatedAt: null
}));

const ALL_BUILTIN = [...BUILTIN_2026, ...BUILTIN_2027_TENTATIVE];

/** 2026 内置数据副本（供 UI 列表与测试，防止调用方误改常量）。 */
export function getBuiltinHolidays() {
  return BUILTIN_2026.map((h) => ({ ...h }));
}

/** 内置数据全集（含 2027 预留），建索引用。 */
export function getAllBuiltinHolidays() {
  return ALL_BUILTIN.map((h) => ({ ...h }));
}

/** 仅 2027 预留条目。 */
export function getTentativeHolidays() {
  return BUILTIN_2027_TENTATIVE.map((h) => ({ ...h }));
}

/** 内置数据覆盖的年份（用于「数据可能已过时」提示）。 */
export function getBuiltinYears() {
  return [...new Set(ALL_BUILTIN.map((h) => Number(h.date.slice(0, 4))))].sort((a, b) => a - b);
}

/**
 * 统一规范化一条 Holiday（内置/用户/备份恢复都可能进来）。
 * @param {object} h
 * @param {'builtin2026'|'manual'} fallbackSource
 */
function normalizeHoliday(h, fallbackSource) {
  if (!h || !isDateStr(h.date)) return null;
  const type = h.type === 'makeupWorkday' ? 'makeupWorkday' : 'holiday';
  let follow = null;
  if (type === 'makeupWorkday') {
    if (h.followDayOfWeek === 'none') follow = 'none';
    else if (typeof h.followDayOfWeek === 'number' && h.followDayOfWeek >= 1 && h.followDayOfWeek <= 7) {
      follow = Math.round(h.followDayOfWeek);
    } else if (typeof h.followDayOfWeek === 'string' && /^[1-7]$/.test(h.followDayOfWeek)) {
      follow = Number(h.followDayOfWeek);
    } else follow = null;
  }
  return {
    date: h.date,
    name: h.name || '自定义日期',
    type,
    followDayOfWeek: follow,
    inferred: !!h.inferred,
    tentative: !!h.tentative,
    source: h.source === 'builtin2026' ? 'builtin2026' : fallbackSource,
    dataRevision: h.dataRevision || DATA_REVISION,
    note: h.note || null,
    updatedAt: h.updatedAt || null
  };
}

/**
 * 构建日期索引：内置（含 2027 预留）∪ 用户（用户同日覆盖内置）。
 * @param {Array} userHolidays state.holidays（source:'manual' 的记录）
 * @returns {Map<string, object>}
 */
export function buildHolidayIndex(userHolidays = []) {
  const index = new Map();
  for (const h of ALL_BUILTIN) {
    const normalized = normalizeHoliday(h, 'builtin2026');
    if (normalized) index.set(normalized.date, normalized);
  }
  for (const h of Array.isArray(userHolidays) ? userHolidays : []) {
    const normalized = normalizeHoliday(h, 'manual');
    if (!normalized) continue;
    // 用户覆盖：保留内置的 inferred/tentative 语义仅当用户条目未表态
    index.set(normalized.date, normalized);
  }
  return index;
}

/**
 * 查询某日的节假日信息。
 * @param {string} date YYYY-MM-DD
 * @param {Map<string,object>} index
 * @returns {object|null}
 */
export function getHoliday(date, index) {
  if (!index || typeof index.get !== 'function') return null;
  return index.get(date) || null;
}

/**
 * 6 个内置调休上班日（已合并用户覆盖），设置页要渲染 6 行选择器。
 * @param {Array} [userHolidays]
 * @returns {Array<object>}
 */
export function listMakeupDays(userHolidays = []) {
  const index = buildHolidayIndex(userHolidays);
  return BUILTIN_2026.filter((h) => h.type === 'makeupWorkday')
    .map((h) => index.get(h.date) || normalizeHoliday(h, 'builtin2026'))
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 三态翻译（唯一实现；calendar.classifyDay 不得再写一遍 if）。
 *
 * `null` **无条件**判 `unconfirmed`：`makeupWorkdayMode` 只决定"已指定 1..7 时排不排课"，
 * 绝不能把"不知道上什么课"改写为"确定没课"——否则学生当天直接缺课。
 *
 * @param {{followDayOfWeek: number|'none'|null}} holiday
 * @param {number} realDow 真实星期 1..7（当前未参与判定，保留以兼容调用点与未来扩展）
 * @param {'followWeekday'|'skip'} mode
 * @returns {{dow: number|null, kind: 'follow'|'skip'|'skipWithHint'|'unconfirmed'}}
 */
export function effectiveDayOfWeek(holiday, realDow, mode = 'followWeekday') {
  const f = holiday ? holiday.followDayOfWeek : null;
  if (f === 'none') return { dow: null, kind: 'skip' };
  if (typeof f === 'number' && f >= 1 && f <= 7) {
    return mode === 'skip' ? { dow: f, kind: 'skipWithHint' } : { dow: f, kind: 'follow' };
  }
  // f === null（或任何非法值）→ 未确认。★ 任何 mode 都不降级为 skip。
  return { dow: null, kind: 'unconfirmed' };
}

/** 该日是否「调休上班日且未确认」。 */
export function isMakeupUnconfirmed(date, index, mode = 'followWeekday') {
  const hol = getHoliday(date, index);
  if (!hol || hol.type !== 'makeupWorkday') return false;
  return effectiveDayOfWeek(hol, dayOfWeekOf(date), mode).kind === 'unconfirmed';
}

/* ------------------------------------------------------ 临近提醒（假期 → 调休确认） */

/**
 * 把放假条目聚成"假期区间"（同名 + 日期连续算一段）。
 * @param {Array} userHolidays state.holidays
 * @returns {Array<{name:string, from:string, to:string, days:number}>}
 */
export function holidaySpans(userHolidays = []) {
  const index = buildHolidayIndex(userHolidays);
  const days = [...index.values()]
    .filter((h) => h.type === 'holiday')
    .sort((a, b) => a.date.localeCompare(b.date));

  const spans = [];
  for (const h of days) {
    const last = spans[spans.length - 1];
    // 同一天只可能有一条（index 已按日期去重）；相邻 = 上一条的次日
    if (last && last.name === h.name && diffDays(last.to, h.date) === 1) {
      last.to = h.date;
      last.days += 1;
    } else {
      spans.push({ name: h.name, from: h.date, to: h.date, days: 1 });
    }
  }
  return spans;
}

/**
 * 离某天最近的假期区间（前后 31 天内），用来把补班日和它所属的假期对上。
 * ★ 刻意按"时间邻近"而不是按名字匹配：内置条目叫「国庆调休上班」、假期叫「国庆节」，
 *   字符串对齐很脆（改个名就失配），而补班日与它所属假期在日历上总是挨着。
 */
export function nearestHolidaySpan(userHolidays, date, maxGap = 31) {
  let best = null;
  for (const span of holidaySpans(userHolidays)) {
    const gap = Math.min(Math.abs(diffDays(span.to, date)), Math.abs(diffDays(span.from, date)));
    if (gap > maxGap) continue;
    if (!best || gap < best.gap) best = { ...span, gap };
  }
  return best;
}

/**
 * 补班日 → 它所属的假期区间。
 *
 * 先按**名字**认（「国庆调休上班」→「国庆节」），认不出来再退回"时间上最近的一段"。
 * ★ 不能只用时间邻近：2026-09-20 是国庆补班，但它离中秋（09-25）比离国庆（10-01）更近，
 *   纯按距离会认成中秋的补班日，弹窗文案就错了。
 */
export function relatedHolidaySpan(userHolidays, makeupDate, makeupName) {
  const spans = holidaySpans(userHolidays);
  if (!spans.length) return null;

  const base = String(makeupName || '')
    .replace(/调休.*$/, '')
    .replace(/[（(].*?[）)]/g, '')
    .trim();
  if (base) {
    const named = spans.filter(
      (s) => s.name === base || s.name.startsWith(base) || base.startsWith(s.name)
    );
    if (named.length) {
      // 同名假期可能有多段（比如元旦跨年），取离补班日最近的那段
      return named.sort(
        (a, b) => Math.abs(diffDays(a.from, makeupDate)) - Math.abs(diffDays(b.from, makeupDate))
      )[0];
    }
  }
  return nearestHolidaySpan(userHolidays, makeupDate);
}

/**
 * 「假期临近但调休还没确认」的那一条，用于启动时的确认弹窗。
 *
 * 触发条件（两者满足其一，都按 windowDays 计）：
 *   ① 补班日本身在 N 天内；② 它所属假期的**开始日**在 N 天内。
 * ② 是必要的：国庆 10-01 开始、补班在 10-10，学生是在假期前就该知道要不要补课，
 * 等到补班日前 7 天才问就太晚了。
 *
 * @param {Array} userHolidays state.holidays
 * @param {string} today YYYY-MM-DD
 * @param {{windowDays?:number, snoozed?:object, mode?:string}} [opts]
 *        snoozed: { 'YYYY-MM-DD': 'YYYY-MM-DD' }（该补班日被"稍后再问"的日期）
 * @returns {null|{date:string, name:string, daysUntil:number, span:object|null}}
 */
export function findMakeupAlert(userHolidays, today, opts = {}) {
  if (!isDateStr(today)) return null;
  const windowDays = Number.isFinite(Number(opts.windowDays)) ? Number(opts.windowDays) : 7;
  const snoozed = opts.snoozed && typeof opts.snoozed === 'object' ? opts.snoozed : {};
  const mode = opts.mode || 'followWeekday';

  // 从索引取：内置 6 天 + 用户新增的补班日 + 用户对内置日的覆盖，一次覆盖全
  const makeups = [...buildHolidayIndex(userHolidays).values()].filter(
    (h) => h.type === 'makeupWorkday'
  );

  let best = null;
  for (const h of makeups) {
    if (effectiveDayOfWeek(h, dayOfWeekOf(h.date), mode).kind !== 'unconfirmed') continue;
    if (snoozed[h.date] === today) continue;

    const toMakeup = diffDays(today, h.date);
    if (toMakeup < 0) continue; // 已经过去的补班日没什么可确认的了
    const span = relatedHolidaySpan(userHolidays, h.date, h.name);
    const toHoliday = span ? diffDays(today, span.from) : null;

    // 补班当天（0 天）仍然提醒，那天正是要按周几上课的时候
    const near =
      toMakeup <= windowDays || (toHoliday != null && toHoliday >= 0 && toHoliday <= windowDays);
    if (!near) continue;

    if (!best || toMakeup < best.daysUntil) {
      best = { date: h.date, name: h.name || '调休上班', daysUntil: toMakeup, span };
    }
  }
  return best;
}

/**
 * 内置数据自检（测试与设置页复用）。
 * @returns {{ok:boolean, errors:string[], holidayCount:number, makeupCount:number}}
 */
export function auditBuiltinHolidays() {
  const errors = [];
  const seen = new Set();
  let holidayCount = 0;
  let makeupCount = 0;

  for (const h of BUILTIN_2026) {
    if (!isDateStr(h.date)) errors.push(`日期格式非法：${h.date}`);
    if (seen.has(h.date)) errors.push(`日期重复：${h.date}`);
    seen.add(h.date);
    if (h.type === 'holiday') {
      holidayCount += 1;
      if (h.followDayOfWeek !== null) errors.push(`${h.date} 是放假日，followDayOfWeek 必须为 null`);
    } else if (h.type === 'makeupWorkday') {
      makeupCount += 1;
      const f = h.followDayOfWeek;
      if (!(f === null || f === 'none' || (typeof f === 'number' && f >= 1 && f <= 7))) {
        errors.push(`${h.date} 的 followDayOfWeek 必须是 1..7 / 'none' / null`);
      }
      if (typeof f === 'number' && f === dayOfWeekOf(h.date)) {
        errors.push(`${h.date} 的 followDayOfWeek 与其真实星期相同，属无效映射`);
      }
      if (typeof f === 'number' && h.inferred !== true) {
        errors.push(`${h.date} 有推定映射但未标 inferred:true`);
      }
    } else {
      errors.push(`${h.date} 类型非法`);
    }
    if (!h.source) errors.push(`${h.date} 缺少 source`);
    if (h.dataRevision !== DATA_REVISION) errors.push(`${h.date} 的 dataRevision 不一致`);
    if (!h.note) errors.push(`${h.date} 缺少 note`);
  }

  if (holidayCount !== 33) errors.push(`放假日应为 33 天，实际 ${holidayCount}`);
  if (makeupCount !== 6) errors.push(`调休上班日应为 6 天，实际 ${makeupCount}`);

  const inferred = BUILTIN_2026.filter((h) => h.type === 'makeupWorkday' && h.inferred);
  if (inferred.length !== 1 || inferred[0].date !== '2026-01-04' || inferred[0].followDayOfWeek !== 5) {
    errors.push('应仅 2026-01-04 有推定映射 5');
  }
  const nullMakeups = BUILTIN_2026.filter(
    (h) => h.type === 'makeupWorkday' && h.followDayOfWeek === null
  );
  if (nullMakeups.length !== 5) errors.push(`应为 5 条未确认补班日，实际 ${nullMakeups.length}`);

  return { ok: errors.length === 0, errors, holidayCount, makeupCount };
}
