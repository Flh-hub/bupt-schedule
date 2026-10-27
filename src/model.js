/**
 * model.js — 纯逻辑：常量、枚举、时间/周次工具、默认预设、状态校验。
 *
 * 【硬约束】本文件不得出现 document / window / localStorage / navigator / fetch，
 * 必须能被 `node --test` 直接 import（见 docs/ARCHITECTURE.md §1.3）。
 *
 * 【时间约定】
 *  - 一切业务时间用「墙钟字面量」：`YYYY-MM-DD` / `HH:mm`，时区固定 Asia/Shanghai（UTC+8，无 DST）。
 *  - 只有调度与 ICS 的 DTSTAMP 用 epoch。
 *  - ★ 禁止 `new Date('2026-03-05T08:00')`（依赖设备时区），一律走 `wallToEpoch()`。
 *  - ★ dayOfWeek 一律 1=周一 … 7=周日，绝不用 JS getDay() 的 0-6 直接比较。
 */

export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'bupt_schedule_v1';
export const TIMEZONE = 'Asia/Shanghai';

/** 课程色板：course.color 为空时按 courseId 哈希稳定取色。 */
/**
 * 课程可用的色板（10 色）。
 *
 * 首色是北邮蓝，与整体品牌色一致；其余按色相均匀铺开，保证任意两门课在淡色底上
 * 都能一眼分开（课表里一块挨一块，区分度比"好看"更重要）。
 * ★ 顺序即哈希取模的顺序，改动会让所有课程换色 —— 这是有意的，配色方案变了就该整体重排。
 * ★ 刻意不用很浅的颜色：`blockStyle` 会把它按 12% 透明度铺成底色，
 *   太浅的底色配上深色文字会显得脏。
 */
export const PALETTE = [
  '#013A89', // 北邮蓝（品牌色）
  '#0E7490', // 深青
  '#7C3AED', // 紫
  '#BE123C', // 玫红
  '#047857', // 墨绿
  '#C2410C', // 砖橙
  '#1D4ED8', // 亮蓝（比首色更亮，两者并排仍能分开）
  '#9D174D', // 酒红
  '#475569', // 石板灰
  '#A16207' // 深金
];

export const WEEKDAY_FULL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const WEEKDAY_SHORT = ['', '一', '二', '三', '四', '五', '六', '日'];

export const ADJUSTMENT_TYPES = ['cancel', 'reschedule', 'roomChange', 'makeup', 'event'];
export const ADJUSTMENT_LABEL = {
  cancel: '停课',
  reschedule: '改时间',
  roomChange: '改教室',
  makeup: '补课',
  event: '活动'
};

/**
 * 自定义活动（会议 / 社团 / 自习…）的固定色。
 * 刻意不用 PALETTE 里的课表绿系：一眼要能分辨「这是我自己加的，不是教务课」。
 */
export const EVENT_COLOR = '#B7791F';

export const CHANNEL_LABEL = {
  notification: '应用内通知',
  ics: '系统日历',
  both: '通知 + 日历'
};

/** ---------------------------------------------------------------- 基础工具 */

/** 补零到两位。 */
export function pad(n) {
  return String(n).padStart(2, '0');
}

/** 生成不会与既有数据冲突的本地 id。 */
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 上海时区的「今天」。
 * @param {number} [now] epoch ms，默认 Date.now()，便于测试注入。
 * @returns {string} YYYY-MM-DD
 */
export function todayStr(now = Date.now()) {
  const t = new Date(now + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * epoch → 上海墙钟日期串。
 * @param {number} epoch
 * @returns {string} YYYY-MM-DD
 */
export function epochToDateStr(epoch) {
  return todayStr(epoch);
}

/**
 * epoch → 上海墙钟 HH:mm。
 * @param {number} epoch
 * @returns {string}
 */
export function epochToWall(epoch) {
  const t = new Date(epoch + 8 * 3600 * 1000);
  return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

/**
 * 墙钟（日期 + HH:mm，Asia/Shanghai）→ epoch ms。
 * 实现为 Date.UTC(...) - 8h，避免任何设备时区依赖。
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} hhmm HH:mm
 * @returns {number}
 */
export function wallToEpoch(dateStr, hhmm) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(hhmm || '00:00').split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh || 0, mm || 0) - 8 * 3600 * 1000;
}

/**
 * 真实星期（1=周一 … 7=周日）。
 * @param {string} dateStr YYYY-MM-DD
 * @returns {number} 1..7
 */
export function dayOfWeekOf(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=周日
  return dow === 0 ? 7 : dow;
}

/**
 * 相差整数天（b - a）。
 * @param {string} a YYYY-MM-DD
 * @param {string} b YYYY-MM-DD
 * @returns {number}
 */
export function diffDays(a, b) {
  const toUtc = (s) => {
    const [y, m, d] = String(s).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  // ★ Math.round 防浮点误差（夏令时/历史时区会让差值出现 86399999 之类）
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

/**
 * 日期加天数。
 * @param {string} dateStr YYYY-MM-DD
 * @param {number} n
 * @returns {string} YYYY-MM-DD
 */
export function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * 该日期属于第几教学周（1 起）。未配置学期起始日时返回 null。
 * ★ weekNo 永远基于 dateStr 与 semesterStartMonday 的天数差，
 *   绝不受 effectiveDayOfWeek（调休补班映射）影响。
 * @param {string} dateStr
 * @param {string|null} startMonday
 * @returns {number|null}
 */
export function weekNoOf(dateStr, startMonday) {
  if (!startMonday) return null;
  return Math.floor(diffDays(startMonday, dateStr) / 7) + 1;
}

/**
 * 第 N 教学周 → 该周周一（`weekNoOf` 的逆运算）。
 *
 * 用途：教务页面能读到「今天是第 N 周」时，反推学期起始日（第 1 周周一）。
 * 取**今天所在周的周一**再往前退 (N-1) 周——不能直接用今天减 (N-1)*7 天，
 * 否则同一周里不同星期几会算出不同的起始日（周一算对、周五差 4 天）。
 *
 * @param {number} week 1..30
 * @param {string} [today] 默认今天（上海墙钟）
 * @returns {string|null} YYYY-MM-DD
 */
export function startMondayOfWeek(week, today = todayStr()) {
  const n = Number(week);
  if (!Number.isInteger(n) || n < 1 || n > 30) return null;
  if (!isDateStr(today)) return null;
  const monday = addDays(today, 1 - dayOfWeekOf(today));
  return addDays(monday, -(n - 1) * 7);
}

/** HH:mm → 当天分钟数。 */
export function minutesOfDay(hhmm) {
  const [hh, mm] = String(hhmm || '00:00').split(':').map(Number);
  return (hh || 0) * 60 + (mm || 0);
}

/** 当天分钟数 → HH:mm。 */
export function hhmmOfMinutes(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** 校验 HH:mm 字面量。 */
export function isHhmm(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** 当前时刻的 ISO 字符串（审计字段用）。 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * ISO 字符串 → 上海时区的展示文案（`YYYY-MM-DD HH:mm`）。
 * 放在纯逻辑层，避免 UI 出现任何 `new Date(...)`（G3 门禁）。
 * @param {string} iso
 * @param {boolean} [withTime]
 * @returns {string}
 */
export function formatIsoCn(iso, withTime = true) {
  const ms = Date.parse(String(iso == null ? '' : iso));
  if (!Number.isFinite(ms)) return '';
  const t = new Date(ms + 8 * 3600 * 1000);
  const date = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  return withTime ? `${date} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` : date;
}

/** 校验 YYYY-MM-DD 字面量（含真实存在性检查，如 2026-02-30 为非法）。 */
export function isDateStr(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** ---------------------------------------------------------------- 周次工具 */

/**
 * 周次展开 —— 全系统唯一的 WeekSpec 展开点（见 ARCHITECTURE §0.1 修正 2）。
 * @param {{start:number,end:number,type?:string,extra?:number[]}} spec
 * @returns {number[]} 升序去重
 */
export function expandWeeks(spec) {
  const out = [];
  if (!spec) return out;
  const start = Number(spec.start) || 1;
  const end = Number(spec.end) || start;
  const type = spec.type || 'all';
  for (let w = start; w <= end; w += 1) {
    if (type === 'all') out.push(w);
    else if (type === 'odd' && w % 2 === 1) out.push(w);
    else if (type === 'even' && w % 2 === 0) out.push(w);
  }
  const extra = Array.isArray(spec.extra) ? spec.extra : [];
  for (const w of extra) {
    const n = Number(w);
    // extra 语义是「补充周次」，即使落在 start..end 内但被单双周过滤掉也应保留
    if (Number.isFinite(n) && n >= 1 && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** 周次文案归一：全角/半角括号、四种连字符、中文逗号顿号统一。 */
function normalizeWeeksText(text) {
  return String(text == null ? '' : text)
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[－–—~〜]/g, '-')
    .replace(/[，、；;]/g, ',')
    .replace(/第/g, '')
    .replace(/\s+/g, '');
}

/**
 * 解析周次文案 → WeekSpec。
 * 支持：`1-16周`、`第1-16周`、`1~16周`、`1-16周(单)`、`1-16周(双)`、`2-16双周`、
 *       `单周`、`双周`、`1,3,5-9周`、`1-8,10-16周`、`3-15周(单),17周`。
 * 不连续周次归一规则：`start..end` 取**最长连续包含段**，其余离散周次落入 `extra`。
 * @param {string} text
 * @param {number} [totalWeeks]
 * @returns {{start:number,end:number,type:'all'|'odd'|'even',extra:number[]}}
 */
export function parseWeeksText(text, totalWeeks = 20) {
  const total = Math.max(1, Number(totalWeeks) || 20);
  let s = normalizeWeeksText(text);
  const fallback = { start: 1, end: total, type: 'all', extra: [] };
  if (!s) return fallback;

  // 「单双周」混写视为歧义 → 按全周处理（调用方可另外给 warning）
  s = s.replace(/单双周/g, '');

  const segments = [];
  for (const rawSeg of s.split(',').filter(Boolean)) {
    const hasOdd = /\(单周?\)|单周/.test(rawSeg);
    const hasEven = /\(双周?\)|双周/.test(rawSeg);
    let type = 'all';
    if (hasOdd && !hasEven) type = 'odd';
    else if (hasEven && !hasOdd) type = 'even';

    let t = rawSeg.replace(/\(单周?\)|\(双周?\)|单周|双周/g, '').replace(/周/g, '');
    const ranges = [];
    const re = /(\d{1,2})(?:\s*-\s*(\d{1,2}))?/g;
    let m = re.exec(t);
    while (m !== null) {
      const a = Number(m[1]);
      const b = m[2] == null ? a : Number(m[2]);
      if (Number.isFinite(a) && a >= 1) {
        ranges.push({ from: Math.min(a, b), to: Math.max(a, b) });
      }
      if (re.lastIndex === m.index) re.lastIndex += 1; // 防零宽死循环
      m = re.exec(t);
    }
    if (!ranges.length) ranges.push({ from: 1, to: total });
    for (const r of ranges) {
      const from = Math.max(1, Math.min(r.from, total));
      const to = Math.max(1, Math.min(r.to, total));
      if (to >= 1) segments.push({ from, to, type });
    }
  }
  if (!segments.length) return fallback;

  // 最长连续段作为 start/end；等长取靠前的
  let main = segments[0];
  for (const seg of segments) {
    if (seg.to - seg.from > main.to - main.from) main = seg;
  }

  const covered = expandWeeks({ start: main.from, end: main.to, type: main.type, extra: [] });
  const coveredSet = new Set(covered);
  const allSet = new Set();
  for (const seg of segments) {
    for (const w of expandWeeks({ start: seg.from, end: seg.to, type: seg.type, extra: [] })) {
      allSet.add(w);
    }
  }
  const extra = [...allSet].filter((w) => !coveredSet.has(w)).sort((a, b) => a - b);

  return { start: main.from, end: main.to, type: main.type, extra };
}

/** 把连续周次压成区间文案。 */
function groupRanges(weeks) {
  const out = [];
  const sorted = weeks.slice().sort((a, b) => a - b);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out;
}

/**
 * WeekSpec → 人话文案（用于展示）。
 * @param {{start:number,end:number,type:string,extra:number[]}} spec
 * @returns {string}
 */
export function weeksToText(spec) {
  if (!spec) return '';
  const suffix = spec.type === 'odd' ? '(单)' : spec.type === 'even' ? '(双)' : '';
  let out = `${spec.start}-${spec.end}周${suffix}`;
  const extra = Array.isArray(spec.extra) ? spec.extra : [];
  if (extra.length) out += `,${groupRanges(extra)}周`;
  return out;
}

/** ---------------------------------------------------------------- 默认预设 */

/**
 * 北邮常见 11 节制参考预设。
 * ★ 各校区（西土城 / 沙河 / 宏福）作息略有差异，设置页要求用户核对（PRD Q1）。
 */
export const DEFAULT_PERIODS = [
  { index: 1, label: '第1节', start: '08:00', end: '08:45', isCustom: false },
  { index: 2, label: '第2节', start: '08:50', end: '09:35', isCustom: false },
  { index: 3, label: '第3节', start: '09:55', end: '10:40', isCustom: false },
  { index: 4, label: '第4节', start: '10:45', end: '11:30', isCustom: false },
  { index: 5, label: '第5节', start: '13:30', end: '14:15', isCustom: false },
  { index: 6, label: '第6节', start: '14:20', end: '15:05', isCustom: false },
  { index: 7, label: '第7节', start: '15:25', end: '16:10', isCustom: false },
  { index: 8, label: '第8节', start: '16:15', end: '17:00', isCustom: false },
  { index: 9, label: '第9节', start: '18:30', end: '19:15', isCustom: false },
  { index: 10, label: '第10节', start: '19:20', end: '20:05', isCustom: false },
  { index: 11, label: '第11节', start: '20:10', end: '20:55', isCustom: false }
];

/** 默认提醒设置。 */
export function defaultReminderSettings() {
  return {
    enabled: true,
    defaultAdvanceMinutes: 15,
    channel: 'both',
    sound: true,
    vibrate: true,
    rules: []
  };
}

/** 默认 Settings（单例）。 */
export function defaultSettings() {
  return {
    schemaVersion: SCHEMA_VERSION,
    semesterStartMonday: null,
    totalWeeks: 20,
    hasOddEvenWeek: false,
    skipOnHoliday: true,
    makeupWorkdayMode: 'followWeekday',
    timezone: TIMEZONE,
    lastImportAt: null,
    lastBackupAt: null,
    lastContentChangeAt: null,
    reminder: defaultReminderSettings(),
    periods: DEFAULT_PERIODS.map((p) => ({ ...p }))
  };
}

/**
 * 空状态（首次启动 / 清空数据后）。
 * @returns {object}
 */
export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: defaultSettings(),
    courses: [],
    sessions: [],
    adjustments: [],
    holidays: [],
    importHistory: []
  };
}

/** 稳定课程色（无 course.color 时按 id 哈希取色板）。 */
/**
 * 课程名规范化：抹掉教务系统给的**教学班后缀**。
 *
 * 同一门课常常因为分班被导入成多条：`数学分析(上) O` / `数学分析(上) P` / `数学分析(上)`。
 * 对单个学生来说这就是同一门课，课表和提醒列表里带上 `O`/`P` 只是噪音。
 *
 * ★ 只去掉「空格 + 单个大写字母」这种后缀：
 *   - `数学分析(上) O` → `数学分析(上)` ✓
 *   - `大学生心理健康1` → 原样（末尾是数字，是课程名的一部分，不能砍）
 *   - `线性代数` → 原样
 * 括号里的 (上)/(下) 一律保留 —— 那是不同的课，合并就错了。
 */
export function normalizeCourseName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+[A-Z]$/, '')
    .trim();
}

/**
 * 把「去掉教学班后缀之后同名」的课程合成一条。
 *
 * 教务按教学班建课（数学分析(上) O / 数学分析(上) P），对用户来说这就是一节课 ——
 * 补课、加活动时让他从三个「数学分析(上)」里挑一个是没有意义的。
 *
 * 规则：
 *  - 保留先出现的那条的 id（颜色由 courseColor(id) 派生，合并后自然统一）；
 *  - 其余课程的 **sessions.courseId** 和 **adjustments.courseId**（补课/改时间会带）
 *    全部改指向保留的那条，否则 validateState 会报"指向不存在的课程"；
 *  - 名称统一成规范化后的基础名（数学分析(上)）；
 *  - 教师/备注/学分只补空字段，不覆盖已有的。
 *
 * **幂等**：已经合并过的再跑一遍不产生任何变化，且返回同一个对象引用
 * （避免 dispatch 后无谓的重渲染）。
 */
export function mergeSameNameCourses(state) {
  const courses = Array.isArray(state && state.courses) ? state.courses : [];
  if (courses.length < 2) return state;

  const byKey = new Map();
  const remap = new Map();
  const kept = [];

  for (const c of courses) {
    if (!c || typeof c.name !== 'string') {
      kept.push(c);
      continue;
    }
    const key = normalizeCourseName(c.name) || c.name;
    const keep = byKey.get(key);
    if (!keep) {
      const first = c.name === key ? c : { ...c, name: key };
      byKey.set(key, first);
      kept.push(first);
      continue;
    }
    remap.set(c.id, keep.id);
    if (!keep.teacher && c.teacher) keep.teacher = c.teacher;
    if (!keep.note && c.note) keep.note = c.note;
    if (!keep.credit && c.credit) keep.credit = c.credit;
    if (!keep.color && c.color) keep.color = c.color;
  }

  if (!remap.size) return state;

  const sessions = (state.sessions || []).map((s) =>
    s && remap.has(s.courseId) ? { ...s, courseId: remap.get(s.courseId) } : s
  );
  const adjustments = (state.adjustments || []).map((a) =>
    a && remap.has(a.courseId) ? { ...a, courseId: remap.get(a.courseId) } : a
  );

  return { ...state, courses: kept, sessions, adjustments };
}

export function courseColor(courseOrId) {
  const explicit = courseOrId && typeof courseOrId === 'object' ? courseOrId.color : null;
  if (explicit) return explicit;
  const id = courseOrId && typeof courseOrId === 'object' ? courseOrId.id : String(courseOrId || '');
  let hash = 0;
  for (let i = 0; i < String(id).length; i += 1) {
    hash = (hash * 31 + String(id).charCodeAt(i)) % 100000;
  }
  return PALETTE[hash % PALETTE.length];
}

/** ---------------------------------------------------------------- 校验 */

/**
 * 全量状态校验（结构 + 交叉约束）。
 * 只在「恢复备份 / 导入提交」等边界调用，返回可读错误列表。
 * @param {object} state
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateState(state) {
  const errors = [];
  if (!state || typeof state !== 'object') {
    return { ok: false, errors: ['数据不是有效对象'] };
  }
  if (Number(state.schemaVersion) !== SCHEMA_VERSION) {
    errors.push(`数据版本 ${state.schemaVersion}，当前支持 ${SCHEMA_VERSION}`);
  }

  const s = state.settings || {};
  if (s.semesterStartMonday != null && !isDateStr(s.semesterStartMonday)) {
    errors.push('学期起始日格式应为 YYYY-MM-DD');
  }
  const totalWeeks = Number(s.totalWeeks);
  if (!Number.isInteger(totalWeeks) || totalWeeks < 1 || totalWeeks > 30) {
    errors.push('总周数应为 1–30 的整数');
  }
  if (!Array.isArray(s.periods) || s.periods.length < 1) {
    errors.push('节次时间表至少需要 1 节');
  } else {
    let prevEnd = -1;
    for (const p of s.periods) {
      if (!Number.isInteger(p.index) || p.index < 1) errors.push('节次序号应为正整数');
      if (!isHhmm(p.start) || !isHhmm(p.end)) {
        errors.push(`第${p.index}节时间格式应为 HH:mm`);
        continue;
      }
      const startMin = minutesOfDay(p.start);
      const endMin = minutesOfDay(p.end);
      // 允许结束早于开始（跨零点晚课），但同一节次不能与前一节倒序
      if (endMin > startMin && startMin < prevEnd) {
        errors.push(`第${p.index}节开始时间不得早于上一节结束时间`);
      }
      if (endMin > startMin) prevEnd = endMin;
    }
  }

  const r = s.reminder || {};
  if (!Number.isInteger(Number(r.defaultAdvanceMinutes)) || Number(r.defaultAdvanceMinutes) < 0 || Number(r.defaultAdvanceMinutes) > 1440) {
    errors.push('默认提前量应为 0–1440 分钟');
  }
  if (r.channel && !['notification', 'ics', 'both'].includes(r.channel)) {
    errors.push('提醒通道取值非法');
  }
  if (Array.isArray(r.rules)) {
    for (const rule of r.rules) {
      const adv = Number(rule.advanceMinutes);
      if (!Number.isInteger(adv) || adv < 0 || adv > 1440) {
        errors.push('课程级提前量应为 0–1440 分钟');
      }
    }
  }

  const courseIds = new Set();
  if (!Array.isArray(state.courses)) errors.push('courses 必须是数组');
  else {
    for (const c of state.courses) {
      if (!c || typeof c.id !== 'string' || !c.id) errors.push('课程缺少 id');
      else if (courseIds.has(c.id)) errors.push(`课程 id 重复：${c.id}`);
      else courseIds.add(c.id);
      if (!c || typeof c.name !== 'string' || !c.name.trim()) errors.push('课程缺少名称');
    }
  }

  const sessionIds = new Set();
  if (!Array.isArray(state.sessions)) errors.push('sessions 必须是数组');
  else {
    for (const se of state.sessions) {
      if (!se || typeof se.id !== 'string' || !se.id) errors.push('课次缺少 id');
      else if (sessionIds.has(se.id)) errors.push(`课次 id 重复：${se.id}`);
      else sessionIds.add(se.id);
      if (!courseIds.has(se.courseId)) errors.push(`课次 ${se.id} 指向不存在的课程`);
      if (!Number.isInteger(se.dayOfWeek) || se.dayOfWeek < 1 || se.dayOfWeek > 7) {
        errors.push(`课次 ${se.id} 的星期应为 1–7`);
      }
      if (!Number.isInteger(se.startPeriod) || se.startPeriod < 1) {
        errors.push(`课次 ${se.id} 的起始节次非法`);
      }
      if (!Number.isInteger(se.endPeriod) || se.endPeriod < se.startPeriod) {
        errors.push(`课次 ${se.id} 的结束节次必须 ≥ 起始节次`);
      }
      if (!se.weeks || typeof se.weeks !== 'object') errors.push(`课次 ${se.id} 缺少周次`);
    }
  }

  if (!Array.isArray(state.adjustments)) errors.push('adjustments 必须是数组');
  else {
    for (const a of state.adjustments) {
      if (!a || typeof a.id !== 'string' || !a.id) errors.push('调整记录缺少 id');
      if (!isDateStr(a.date)) errors.push(`调整记录 ${a && a.id} 日期格式非法`);
      if (!ADJUSTMENT_TYPES.includes(a.type)) errors.push(`调整记录 ${a && a.id} 类型非法`);
      if (a.type === 'makeup') {
        if (!a.courseId) errors.push(`补课记录 ${a.id} 必须指明课程`);
        if (!Number.isInteger(a.startPeriod) || !Number.isInteger(a.endPeriod)) {
          errors.push(`补课记录 ${a.id} 必须指明节次`);
        }
      } else if (a.type === 'event') {
        if (!a.title || typeof a.title !== 'string') errors.push(`活动记录 ${a.id} 必须有名称`);
        if (!Number.isInteger(a.startPeriod) || !Number.isInteger(a.endPeriod)) {
          errors.push(`活动记录 ${a.id} 必须指明节次`);
        }
      } else if (!a.targetSessionId && !a.courseId) {
        errors.push(`调整记录 ${a.id} 必须指明目标课次或课程`);
      }
      if (a.startTime != null && !isHhmm(a.startTime)) errors.push(`调整记录 ${a.id} 开始时间非法`);
      if (a.endTime != null && !isHhmm(a.endTime)) errors.push(`调整记录 ${a.id} 结束时间非法`);
    }
  }

  if (state.holidays != null && !Array.isArray(state.holidays)) errors.push('holidays 必须是数组');
  if (state.importHistory != null && !Array.isArray(state.importHistory)) errors.push('importHistory 必须是数组');

  return { ok: errors.length === 0, errors };
}

/**
 * 把周次裁剪进 1..totalWeeks，返回 {spec, changed}。
 * 导入时用于「第 18 周超出总周数 16」这类数据。
 */
export function clampWeekSpec(spec, totalWeeks) {
  const total = Math.max(1, Number(totalWeeks) || 20);
  if (!spec) return { spec: { start: 1, end: total, type: 'all', extra: [] }, changed: true };
  const start = Math.max(1, Math.min(Number(spec.start) || 1, total));
  const end = Math.max(start, Math.min(Number(spec.end) || start, total));
  const extra = (Array.isArray(spec.extra) ? spec.extra : [])
    .map(Number)
    .filter((w) => Number.isFinite(w) && w >= 1 && w <= total);
  const changed = start !== spec.start || end !== spec.end || extra.length !== (spec.extra || []).length;
  return { spec: { start, end, type: spec.type || 'all', extra }, changed };
}

/* ---------------------------------------------------------------- 按具体时间定位（活动） */

/**
 * 节次表 → 按 index 升序、只保留起止合法的副本。
 * @param {Array<{index:number,start:string,end:string}>} periods
 */
function sortedPeriods(periods) {
  return (Array.isArray(periods) ? periods : [])
    .filter((p) => p && Number.isInteger(Number(p.index)) && isHhmm(p.start) && isHhmm(p.end))
    .slice()
    .sort((a, b) => Number(a.index) - Number(b.index));
}

/**
 * 时间 → 「行坐标」：0 = 第 1 节顶部，1 = 第 1 节底部，2.5 = 第 3 节中间。
 *
 * 每节固定占 1.0 个行单位（表格里每行等高），所以**行内位移**就是
 * `(t - 本节开始) / 本节时长`；节与节之间的空档（午休）压成 0 高度 ——
 * 表格行本来就是连续的，空档没有对应的像素。
 *
 * @returns {number|null} 超出一节表返回 null
 */
export function timeToRowUnits(periods, hhmm) {
  if (!isHhmm(hhmm)) return null;
  const list = sortedPeriods(periods);
  if (!list.length) return null;
  const t = minutesOfDay(hhmm);
  for (let i = 0; i < list.length; i += 1) {
    const start = minutesOfDay(list[i].start);
    const end = minutesOfDay(list[i].end);
    if (t < start) return i <= 0 ? 0 : i; // 空档里：贴上一节底部
    if (t <= end) return end > start ? i + (t - start) / (end - start) : i;
  }
  // 晚于最后一节：按最后一节的「分钟 → 行」比例继续往后续。
  // ★ 以前这里一律返回 list.length，于是 21:00 和 23:00 都被算成"第 14 行结束"，
  //   活动的 height 塌成 0 或者顶到网格底被裁掉 —— 表现是"活动超过最后一节课就不显示了"。
  const lastStart = minutesOfDay(list[list.length - 1].start);
  const lastEnd = minutesOfDay(list[list.length - 1].end);
  if (lastEnd > lastStart) return list.length + (t - lastEnd) / (lastEnd - lastStart);
  return list.length;
}

/**
 * 具体时间 → 覆盖到哪几节（活动记录仍要落 startPeriod/endPeriod：
 * 提醒、日视图、小组件、冲突检测都靠它们）。
 *
 * @returns {{startPeriod:number,endPeriod:number}|null}
 */
export function periodRangeForTime(periods, startTime, endTime) {
  const list = sortedPeriods(periods);
  if (!list.length || !isHhmm(startTime) || !isHhmm(endTime)) return null;
  if (minutesOfDay(endTime) <= minutesOfDay(startTime)) return null;

  const indexAt = (t, edge) => {
    for (let i = 0; i < list.length; i += 1) {
      const ps = minutesOfDay(list[i].start);
      const pe = minutesOfDay(list[i].end);
      if (t < ps) {
        // 开始时刻落在空档 → 归到下一节；结束时刻落在空档 → 归到上一节
        return edge === 'start' ? Number(list[i].index) : Number(list[Math.max(0, i - 1)].index);
      }
      if (t <= pe) return Number(list[i].index);
    }
    return Number(list[list.length - 1].index);
  };

  const startPeriod = indexAt(minutesOfDay(startTime), 'start');
  const endPeriod = Math.max(startPeriod, indexAt(minutesOfDay(endTime), 'end'));
  return { startPeriod, endPeriod };
}

/**
 * 具体时间 → 表格里的几何位置（渲染用）。
 *
 * @returns {{rowIndex:number, offset:number, height:number, topUnits:number, bottomUnits:number}|null}
 *   rowIndex 从 0 起（第 1 节 = 0）；offset / height 的单位都是「行」。
 */
export function timePlacement(periods, startTime, endTime) {
  if (!isHhmm(startTime) || !isHhmm(endTime)) return null;
  if (minutesOfDay(endTime) <= minutesOfDay(startTime)) return null;
  const top = timeToRowUnits(periods, startTime);
  const bottom = timeToRowUnits(periods, endTime);
  if (top == null || bottom == null) return null;
  const height = bottom - top;
  if (!(height > 0)) return null;

  // ★ 不要再把 rowIndex 夹进 rows-1：结束时间晚于最后一节课的活动必须能落到网格**下方**。
  //   夹住它只会让块挤在最后一行里、高度对不上（真机表现就是"活动不显示"）。
  //   网格由调用方（timetable.js）按 bottomUnits 撑高来容纳这几行。
  const rowIndex = Math.max(0, Math.floor(top));
  const offset = top - rowIndex;
  return { rowIndex, offset, height, topUnits: top, bottomUnits: bottom };
}
