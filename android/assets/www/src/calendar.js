/**
 * calendar.js — 唯一真相层（纯逻辑，零 DOM，可 node --test 直测）。
 *
 * 三层一条流水线（ARCHITECTURE §C.1，team-lead 2026-10 拍板）：
 *   1. `classifyDay(state, date)`  → 分类结果（含 status）。**全系统只有这里判断"今天是什么日子"。**
 *   2. `resolveClasses(state, date)` → ResolvedClass[]。内部投影，**外部禁止调用**（G9 门禁）。
 *   3. `resolveDay(state, date)` → Day（对象）。**UI / 调度器 / 导出唯一入口。**
 *
 * 【铁律】`complete` 的语义是"`classes` 是否权威"：
 *   `classes.length === 0` 只有在 `complete === true` 时才代表"确实没课"；
 *   `complete === false`（`unconfigured` / `makeup_unconfirmed`）时它只意味着"我不知道"。
 *
 * 【判定顺序不可调换】
 *   ① 学期配置可用？ → ② 学期边界 → ③ 法定假日 → ④ 补班三态 → ⑤ 普通日
 *   把 effectiveDow 提前到 holiday 之前：补班日会被二次映射，错。
 *   把 out_of_semester 放到补班之后：整个寒暑假会持续弹"请确认 10 月 10 日按哪天上课"。
 *   把 Adjustment 提前到周次过滤之前：cancel 会去过滤一个还不存在的列表。
 *   把冲突检测提前到时间解析之前：跨零点课程区间判定失真。
 *   把 makeup_unconfirmed 合并进 holiday_silent（"跳过=无课"）：学生当天直接缺课。
 *
 * 【sessions 只读】调课只 append/remove `adjustments`，本文件每次现算投影。
 */

import {
  addDays,
  dayOfWeekOf,
  diffDays,
  EVENT_COLOR,
  expandWeeks,
  minutesOfDay,
  normalizeCourseName,
  todayStr,
  timeToRowUnits,
  wallToEpoch,
  WEEKDAY_FULL,
  WEEKDAY_SHORT,
  weekNoOf
} from './model.js';
import { buildHolidayIndex, effectiveDayOfWeek, getHoliday } from './holidays.js';

export { weekNoOf };

/** 冻结的 7 值 status 枚举（禁止改名；未来只能追加第 8 个值）。 */
export const STATUS = {
  NORMAL: 'normal',
  HOLIDAY_SILENT: 'holiday_silent',
  MAKEUP_UNCONFIRMED: 'makeup_unconfirmed',
  MAKEUP_SKIPPED: 'makeup_skipped',
  MAKEUP_FOLLOW: 'makeup_follow',
  OUT_OF_SEMESTER: 'out_of_semester',
  UNCONFIGURED: 'unconfigured'
};

export const STATUS_VALUES = [
  'normal',
  'holiday_silent',
  'makeup_unconfirmed',
  'makeup_skipped',
  'makeup_follow',
  'out_of_semester',
  'unconfigured'
];

/** Adjustment 应用优先级：cancel 必须先于 makeup，否则补课会被误停。 */
const ADJ_PRIORITY = { cancel: 0, roomChange: 1, reschedule: 2, makeup: 3, event: 3 };

/**
 * 同上 —— 判定「同一门大课内部换节」时允许的最大课间（分钟）。
 *
 * 作息表里正常课间是 5~10 分钟；取 30 分钟是为了容下个别学校的"大课间"。
 * 超过这个间隔就当作两段独立上课（比如上午一节、下午一节同一门课），照常提醒。
 */
const SAME_COURSE_BREAK_MAX = 30;

/**
 * 找出「同一门大课内部换节」的那些 class —— 它们**不该单独提醒**。
 *
 * 【为什么要按课程归属判断，而不是只看时间间隔】
 * 「线性代数 第3-5节」在教务系统里可能存成一整条，也可能拆成 3-4 节和 5 节两条。
 * 拆开时这两条的间隔就是普通课间（5~10 分钟），只看间隔会误以为"又要上新课了"而提醒。
 * 而真正的换课（第2节数学分析 → 第3节线性代数）间隔同样是 5~10 分钟，光看间隔分不开。
 * 所以判据必须是 **课程相同 + 紧接**，两者同时成立才跳过。
 *
 * `classes` 已由 resolveClasses 按上课时间稳定排序，这里直接顺序扫一遍即可。
 * 返回 class.key 的集合；调用方据此跳过对应提醒点。
 */
function sameCourseBreakKeys(classes) {
  const out = new Set();
  for (let i = 1; i < classes.length; i += 1) {
    const prev = classes[i - 1];
    const cur = classes[i];
    if (!prev.courseId || !cur.courseId) continue; // 活动没有 courseId，不参与
    if (prev.courseId !== cur.courseId) continue; // 换了门课 → 该提醒
    if (!prev.endTime || !cur.startTime) continue;
    if (prev.crossMidnight || cur.crossMidnight) continue;
    const gap = minutesOfDay(cur.startTime) - minutesOfDay(prev.endTime);
    // gap < 0 说明时间重叠（同段两门课并排），不是课间
    if (gap < 0 || gap > SAME_COURSE_BREAK_MAX) continue;
    out.add(cur.key);
  }
  return out;
}

const WD = '一二三四五六日';

/**
 * 星期数字 → 中文字（越界一律 `?`）。
 * ★ 宁可显示 `?` 也不把 `undefined` 端给用户：字段名写错/数据脏时不会抛错，只会静默出错文案。
 */
function wd(n) {
  const idx = Number(n);
  return Number.isInteger(idx) && idx >= 1 && idx <= 7 ? WD[idx - 1] : '?';
}

/**
 * 横幅文案映射表 —— **UI 唯一文案来源**，禁止各页面各写一套。
 * ★ 7 个键必须与 STATUS_VALUES 集合完全相等（G14：漏一个键 ⇒ `NOTICE[status]` 为 undefined ⇒ 崩页）。
 * `normal` 返回 `null`（不是空串），UI 用 `if (day.notice)` 判断。
 */
export const NOTICE = {
  normal: () => null,
  holiday_silent: (c) => `${c.holidayName || '法定假期'} · 今日无课`,
  // ★ 本表只读 `Day` 的**契约字段名**（date / effectiveDayOfWeek / weekNo / holidayName），
  //   不要读 classifyDay 的内部名（realDow / effectiveDow）——两套名并存会静默输出
  //   "按周undefined课表"，不抛错，最难查。
  makeup_unconfirmed: (c) =>
    `${String(c.date || '').slice(5)}（周${wd(dayOfWeekOf(c.date))}）是${
      c.holidayName || '调休上班日'
    }，请确认按周几的课表上课`,
  // 两种来源靠 effectiveDayOfWeek 是否为 null 区分：
  //   'none'（用户确认无课）→ null → "今日无课"分支（不拼"按周X"）
  //   1..7 + mode='skip'    → 1..7 → 拼"本应按周X"
  makeup_skipped: (c) =>
    c.effectiveDayOfWeek
      ? `调休上班日 · 已按设置不排课（本应按周${wd(c.effectiveDayOfWeek)}课表，如需上课请切换）`
      : `调休上班日（${c.holidayName || '调休'}）· 今日无课`,
  makeup_follow: (c) => `调休补班 · 按周${wd(c.effectiveDayOfWeek)}课表`,
  out_of_semester: (c) => (c.weekNo < 1 ? '本学期尚未开始' : '本学期已结束'),
  unconfigured: () => '未设置学期起始日，周次可能不准'
};

/* ============================================================ 分类（唯一判断点） */

/**
 * 单日分类 —— 全系统"这一天是什么日子"的唯一判断点。
 * @param {object} state
 * @param {string} dateStr YYYY-MM-DD
 * @returns {{weekNo:number|null, realDow:number, effectiveDow:number|null,
 *            status:string, skipAll:boolean, holidayName:string|null,
 *            followDayOfWeek:number|'none'|null}}
 */
export function classifyDay(state, dateStr) {
  const settings = (state && state.settings) || {};
  const holIndex = buildHolidayIndex(state && state.holidays);
  const hol = getHoliday(dateStr, holIndex);
  const realDow = dayOfWeekOf(dateStr);
  const weekNo = weekNoOf(dateStr, settings.semesterStartMonday || null);
  const base = {
    weekNo,
    realDow,
    effectiveDow: realDow,
    status: STATUS.NORMAL,
    skipAll: false,
    holidayName: hol ? hol.name : null,
    followDayOfWeek: hol ? hol.followDayOfWeek : null
  };

  // ① 学期配置是否可用
  //    NaN 陷阱：`weekNo > undefined` → false，会静默越过第 ② 步把学期外日期当成学期内，
  //    与"null 被当成已知"是同一类病，只是换了字段。
  const tw = Number(settings.totalWeeks);
  if (!settings.semesterStartMonday || !Number.isFinite(tw) || tw <= 0) {
    // ★ effectiveDow 置 null：周次都算不出，"按哪天"无意义（fail-closed）
    return { ...base, status: STATUS.UNCONFIGURED, skipAll: true, effectiveDow: null };
  }

  // ② 学期边界（优先于补班三态）
  if (weekNo < 1 || weekNo > tw) {
    return { ...base, status: STATUS.OUT_OF_SEMESTER, skipAll: true };
  }

  // ③ 法定放假日（skipOnHoliday=false 时走 normal：假日照常上课）
  if (hol && hol.type === 'holiday') {
    return settings.skipOnHoliday === false
      ? { ...base, status: STATUS.NORMAL }
      : { ...base, status: STATUS.HOLIDAY_SILENT, skipAll: true };
  }

  // ④ 调休上班日三态（翻译交给 holidays.effectiveDayOfWeek，status 在这里组装）
  if (hol && hol.type === 'makeupWorkday') {
    const { dow, kind } = effectiveDayOfWeek(hol, realDow, settings.makeupWorkdayMode);
    if (kind === 'follow') {
      return { ...base, status: STATUS.MAKEUP_FOLLOW, effectiveDow: dow };
    }
    if (kind === 'skip' || kind === 'skipWithHint') {
      // dow=null → 用户显式 'none'；dow=1..7 → 本应按周X 但用户设了不排课（notice 带提示）
      return { ...base, status: STATUS.MAKEUP_SKIPPED, skipAll: true, effectiveDow: dow };
    }
    // ★ 未确认：effectiveDow 显式置 null（fail-closed），UI 拿到 null 只能出选择器
    return { ...base, status: STATUS.MAKEUP_UNCONFIRMED, effectiveDow: null, skipAll: true };
  }

  // ⑤ 普通日
  return base;
}

/* ============================================================ 投影（内部） */

/** 节次索引 Map<index, Period>。 */
export function indexPeriods(periods) {
  const map = new Map();
  for (const p of Array.isArray(periods) ? periods : []) {
    if (!p || !Number.isFinite(Number(p.index))) continue;
    map.set(Number(p.index), {
      index: Number(p.index),
      label: p.label || `第${p.index}节`,
      start: p.start,
      end: p.end,
      isCustom: !!p.isCustom
    });
  }
  return map;
}

/** 节次列表（升序副本，供 UI 时间轴渲染）。 */
export function getPeriods(state) {
  const map = indexPeriods(state && state.settings && state.settings.periods);
  return [...map.values()].sort((a, b) => a.index - b.index);
}

/** 冲突检测：同日期同节次重叠的两门不同课互标（不合并、不丢弃）。 */
export function detectConflicts(classes) {
  for (let i = 0; i < classes.length; i += 1) {
    for (let j = i + 1; j < classes.length; j += 1) {
      const a = classes[i];
      const b = classes[j];
      // 同课重叠 = 重复排课，另由导入校验处理。
      // ★ 活动（courseId 为 null）没有"同一门课"的概念，必须按 id 比，
      //   否则两个活动会被当成同一门课而漏报冲突。
      if (a.courseId && a.courseId === b.courseId) continue;
      if (a.startPeriod <= b.endPeriod && b.startPeriod <= a.endPeriod) {
        a.conflict = true;
        b.conflict = true;
        if (!a.conflictWith.includes(b.key)) a.conflictWith.push(b.key);
        if (!b.conflictWith.includes(a.key)) b.conflictWith.push(a.key);
      }
    }
  }
}

/** 周期课次 → ResolvedClass 骨架。 */
function baseClass(session, course, dateStr, weekNo) {
  return {
    key: `s:${session.id}|${dateStr}|P${session.startPeriod}-${session.endPeriod}`,
    date: dateStr,
    weekNo,
    courseId: course.id,
    courseName: normalizeCourseName(course.name),
    teacher: session.teacher || course.teacher || null,
    note: course.note || null,
    color: course.color || null,
    startPeriod: session.startPeriod,
    endPeriod: session.endPeriod,
    startTime: null,
    endTime: null,
    crossMidnight: false,
    location: session.location || '',
    origin: 'session',
    adjustmentType: null,
    adjustmentId: null,
    sessionId: session.id,
    original: { location: null, startTime: null, endTime: null, startPeriod: null, endPeriod: null },
    conflict: false,
    conflictWith: [],
    forcedOnHoliday: false,
    invalidPeriod: false
  };
}

/**
 * 投影：把 classifyDay 的结论翻译成 ResolvedClass[]。
 * ★ 内部函数（G9：UI / 其余模块禁止直接调用，一律走 resolveDay）。
 * @param {object} state
 * @param {string} dateStr
 * @returns {Array<object>}
 */
export function resolveClasses(state, dateStr) {
  if (!state || !state.settings) return [];
  const settings = state.settings;
  const cls = classifyDay(state, dateStr);
  const { weekNo, effectiveDow, skipAll } = cls;

  const periods = indexPeriods(settings.periods);
  const courseMap = new Map((state.courses || []).map((c) => [c.id, c]));
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const totalWeeks = Number(settings.totalWeeks);

  // ---------- 步骤 3：周次过滤（用 effectiveDow，不是 realDow） ----------
  let classes = [];
  const inSemester = weekNo >= 1 && weekNo <= totalWeeks;
  if (!skipAll && inSemester && effectiveDow != null) {
    for (const s of sessions) {
      if (Number(s.dayOfWeek) !== effectiveDow) continue;
      if (!expandWeeks(s.weeks).includes(weekNo)) continue;
      const course = courseMap.get(s.courseId);
      if (!course) continue; // 悬空外键：导入校验应已拦住，静默跳过避免白屏
      classes.push(baseClass(s, course, dateStr, weekNo));
    }
  }

  // ---------- 步骤 4：Adjustment 覆盖（append-only 投影，绝不改 sessions） ----------
  const todays = (Array.isArray(state.adjustments) ? state.adjustments : [])
    .filter((a) => a && a.date === dateStr)
    .slice()
    .sort((x, y) => (ADJ_PRIORITY[x.type] ?? 9) - (ADJ_PRIORITY[y.type] ?? 9));

  for (const a of todays) {
    switch (a.type) {
      case 'cancel': {
        classes = classes.filter((c) =>
          a.targetSessionId ? c.sessionId !== a.targetSessionId : c.courseId !== a.courseId
        );
        break;
      }
      case 'roomChange': {
        const target = classes.find((c) => c.sessionId === a.targetSessionId);
        if (target) {
          // ★ 只在「尚未记录原值」时写入：同日若还有 reschedule（优先级更高/更低都可能），
          //   绝不能把已被前一条改过的中间值当成"原值"，否则 UI 会渲染成"新值 → 新值"。
          if (target.original.location == null) target.original.location = target.location;
          target.location = a.location != null && a.location !== '' ? a.location : target.location;
          target.origin = 'adjustment';
          target.adjustmentType = 'roomChange';
          target.adjustmentId = a.id;
          target.key = `a:${a.id}|${dateStr}`;
        }
        break;
      }
      case 'reschedule': {
        const target = classes.find((c) => c.sessionId === a.targetSessionId);
        if (target) {
          // ★ 同理：原值只记一次（取"调课前"的权威值），后续叠加调整不得覆盖
          if (target.original.startPeriod == null) target.original.startPeriod = target.startPeriod;
          if (target.original.endPeriod == null) target.original.endPeriod = target.endPeriod;
          if (target.original.startTime == null && target.startTime != null) {
            target.original.startTime = target.startTime;
          }
          if (target.original.endTime == null && target.endTime != null) {
            target.original.endTime = target.endTime;
          }
          if (target.original.location == null) target.original.location = target.location;
          if (Number.isInteger(a.startPeriod)) target.startPeriod = a.startPeriod;
          if (Number.isInteger(a.endPeriod)) target.endPeriod = a.endPeriod;
          target.startTime = a.startTime || null; // 自定义时间优先于节次解析
          target.endTime = a.endTime || null;
          if (a.location) target.location = a.location;
          target.origin = 'adjustment';
          target.adjustmentType = 'reschedule';
          target.adjustmentId = a.id;
          target.key = `a:${a.id}|${dateStr}`;
        }
        break;
      }
      case 'makeup': {
        const course = courseMap.get(a.courseId);
        if (!course) break;
        const startPeriod = Number.isInteger(a.startPeriod) ? a.startPeriod : 1;
        const endPeriod = Number.isInteger(a.endPeriod) ? a.endPeriod : startPeriod;
        classes.push({
          key: `a:${a.id}|${dateStr}`,
          date: dateStr,
          weekNo,
          courseId: course.id,
          courseName: normalizeCourseName(course.name),
          teacher: course.teacher || null,
          note: a.note || course.note || null,
          color: course.color || null,
          startPeriod,
          endPeriod,
          startTime: a.startTime || null,
          endTime: a.endTime || null,
          crossMidnight: false,
          location: a.location || '',
          origin: 'adjustment',
          adjustmentType: 'makeup',
          adjustmentId: a.id,
          sessionId: null,
          original: { location: null, startTime: null, endTime: null, startPeriod: null, endPeriod: null },
          conflict: false,
          conflictWith: [],
          // 假期里用户显式补课 → 展示并提醒（假期优先 + 显式意图不丢的折中）
          forcedOnHoliday: skipAll,
          invalidPeriod: false
        });
        break;
      }
      case 'event': {
        // 自定义活动：不挂课程、不挂课次，名称就是全部身份
        const startPeriod = Number.isInteger(a.startPeriod) ? a.startPeriod : 1;
        const endPeriod = Number.isInteger(a.endPeriod) ? a.endPeriod : startPeriod;
        classes.push({
          key: `a:${a.id}|${dateStr}`,
          date: dateStr,
          weekNo,
          courseId: null,
          courseName: String(a.title || '活动'),
          teacher: null,
          note: a.note || null,
          color: EVENT_COLOR,
          startPeriod,
          endPeriod,
          startTime: a.startTime || null,
          endTime: a.endTime || null,
          crossMidnight: false,
          location: a.location || '',
          origin: 'adjustment',
          adjustmentType: 'event',
          adjustmentId: a.id,
          eventId: a.id,
          isEvent: true,
          sessionId: null,
          original: { location: null, startTime: null, endTime: null, startPeriod: null, endPeriod: null },
          conflict: false,
          conflictWith: [],
          forcedOnHoliday: skipAll,
          invalidPeriod: false
        });
        break;
      }
      default:
        break;
    }
  }

  // ---------- 步骤 5：时间解析（节次 → 时刻；自定义时间优先） ----------
  for (const c of classes) {
    if (c.startTime && c.endTime) {
      c.crossMidnight = minutesOfDay(c.endTime) < minutesOfDay(c.startTime);
      continue;
    }
    const p1 = periods.get(c.startPeriod);
    const p2 = periods.get(c.endPeriod);
    if (!p1 || !p2 || !p1.start || !p2.end) {
      c.invalidPeriod = true;
      continue;
    }
    c.startTime = p1.start;
    c.endTime = p2.end;
    c.crossMidnight = minutesOfDay(p2.end) < minutesOfDay(p1.start);
  }

  // ---------- 步骤 6：冲突检测 ----------
  detectConflicts(classes);

  // ---------- 步骤 7：稳定排序 ----------
  return classes.sort(
    (x, y) =>
      (x.startTime || '99:99').localeCompare(y.startTime || '99:99') ||
      x.startPeriod - y.startPeriod ||
      String(x.courseName).localeCompare(String(y.courseName))
  );
}

/* ============================================================ 对外唯一入口 */

/**
 * 某日完整结论（UI / 调度器 / 导出唯一入口）。
 * @param {object} state
 * @param {string} dateStr YYYY-MM-DD
 * @returns {{date:string, weekNo:number|null, status:string, complete:boolean,
 *            holidayName:string|null, followDayOfWeek:number|'none'|null,
 *            effectiveDayOfWeek:number|null, notice:string|null, classes:Array<object>}}
 */
export function resolveDay(state, dateStr) {
  const cls = classifyDay(state, dateStr);
  const classes = resolveClasses(state, dateStr);
  const complete = cls.status !== STATUS.MAKEUP_UNCONFIRMED && cls.status !== STATUS.UNCONFIGURED;

  // ★ 先组装 Day（对外只有契约名），再算 notice —— NOTICE 拿到的是完整 Day，
  //   避免"classifyDay 没有 date 却让 NOTICE 读 c.date"这类只在特定状态下才崩的 bug。
  const day = {
    date: dateStr,
    weekNo: cls.weekNo,
    status: cls.status,
    complete,
    holidayName: cls.holidayName,
    followDayOfWeek: cls.followDayOfWeek,
    effectiveDayOfWeek: cls.effectiveDow,
    notice: null,
    classes
  };
  day.notice = (NOTICE[day.status] || NOTICE.normal)(day);
  return day;
}

/**
 * 区间内逐日结论（闭区间）。
 * @returns {Array<object>} Day[]
 */
export function resolveRange(state, fromDate, toDate) {
  return eachDate(fromDate, toDate).map((date) => resolveDay(state, date));
}

/** 逐日迭代（闭区间）。 */
export function eachDate(fromDate, toDate) {
  const days = Math.max(0, diffDays(fromDate, toDate));
  const out = [];
  for (let i = 0; i <= days; i += 1) out.push(addDays(fromDate, i));
  return out;
}

/** 某日期所在自然周的周一。 */
function mondayOf(dateStr) {
  const dow = dayOfWeekOf(dateStr);
  return addDays(dateStr, 1 - dow);
}

/**
 * 「现在」位于第几周 → 可直接喂给 getWeekView 的 weekOffset（0 = 第 1 周）。
 *
 * ★ 这个换算必须在 calendar 里做：UI 不许自己算日期。
 *   之前 main.js 里「回到本周」写的是 `weekOffset = 0`，等于**第 1 周**——
 *   第 8 周打开 App 会看到开学第一周的空白课表，看起来像"导入失败"。
 * @param {object} state
 * @param {string} [today]
 * @returns {number}
 */
export function currentWeekOffset(state, today = todayStr()) {
  const settings = (state && state.settings) || {};
  const start = settings.semesterStartMonday;
  if (!start) return 0;
  const totalWeeks = Math.max(1, Number(settings.totalWeeks) || 20);
  const monday = addDays(today, -(dayOfWeekOf(today) - 1));
  const weekNo = weekNoOf(monday, start);
  if (!Number.isFinite(weekNo)) return 0;
  return Math.min(Math.max(weekNo - 1, 0), totalWeeks - 1);
}

/**
 * 周视图数据 —— UI 只消费本函数输出，不再做任何日期运算。
 * @param {object} state
 * @param {number} [weekOffset] 相对学期第 1 周的偏移
 * @param {string} [today]
 */
export function getWeekView(state, weekOffset = 0, today = todayStr()) {
  const settings = (state && state.settings) || {};
  const configured = !!settings.semesterStartMonday;
  const baseMonday = configured ? settings.semesterStartMonday : mondayOf(today);
  const monday = addDays(baseMonday, weekOffset * 7);
  const sunday = addDays(monday, 6);
  const weekNo = configured ? weekNoOf(monday, settings.semesterStartMonday) : null;
  const totalWeeks = Math.max(1, Number(settings.totalWeeks) || 20);

  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(monday, i);
    const day = resolveDay(state, date);
    days.push({
      date,
      dayOfWeek: i + 1,
      label: WEEKDAY_FULL[i + 1],
      shortLabel: WEEKDAY_SHORT[i + 1],
      dayOfMonth: Number(date.slice(8, 10)),
      isToday: date === today,
      weekNo: day.weekNo,
      status: day.status,
      complete: day.complete,
      notice: day.notice,
      holidayName: day.holidayName,
      followDayOfWeek: day.followDayOfWeek,
      effectiveDayOfWeek: day.effectiveDayOfWeek,
      classes: day.classes
    });
  }

  const pendingDates = days
    .filter((d) => d.status === STATUS.MAKEUP_UNCONFIRMED)
    .map((d) => d.date);
  const unconfigured = days.every((d) => d.status === STATUS.UNCONFIGURED);

  return {
    monday,
    sunday,
    weekOffset,
    weekNo,
    configured,
    totalWeeks,
    // 「本周」= 这一周真的包含今天，而不是"偏移量为 0"
    isCurrentWeek: configured && weekNo === weekNoOf(today, settings.semesterStartMonday),
    todayIndex: days.findIndex((d) => d.isToday),
    unconfigured,
    pendingDates,
    days,
    periods: getPeriods(state)
  };
}

/**
 * 「现在」在课表网格中的位置（供 UI 画红线，避免 UI 自己算时间）。
 * @param {object} state
 * @param {number} [now] epoch ms
 */
/**
 * 「现在」这条红线落在表格的哪一行。
 *
 * @param {object} state
 * @param {number} [now]
 * @param {number|null} [maxRow] 表格实际有多少个内容行。
 *   课表网格可能因为活动开到很晚而延长（见 `timetable.js` 的延长行），
 *   这时红线要能在延长区里继续往下走；不传就按节次表行数封顶（旧行为）。
 */
export function getNowMarker(state, now = Date.now(), maxRow = null) {
  const date = todayStr(now);
  const minutes = Math.round(((now + 8 * 3600 * 1000) % 86400000) / 60000);
  const periods = getPeriods(state);
  const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  if (!periods.length) {
    return { date, minutes, hhmm, rowIndex: 0, fraction: 0, inClass: false, periodIndex: null, visible: false };
  }

  for (let i = 0; i < periods.length; i += 1) {
    const p = periods[i];
    const s = minutesOfDay(p.start);
    let e = minutesOfDay(p.end);
    if (e < s) e = s; // 跨零点节次不在红线逻辑内展开
    if (minutes >= s && minutes < e) {
      const span = Math.max(1, e - s);
      return {
        date,
        minutes,
        hhmm,
        rowIndex: i,
        fraction: Math.min(1, Math.max(0, (minutes - s) / span)),
        inClass: true,
        periodIndex: p.index,
        visible: true
      };
    }
  }

  const firstStart = minutesOfDay(periods[0].start);
  if (minutes < firstStart) {
    return { date, minutes, hhmm, rowIndex: 0, fraction: 0, inClass: false, periodIndex: null, visible: false };
  }
  // ★ 晚于最后一节：用行坐标继续外推，再按网格实际行数封顶。
  //   以前这里直接返回「最后一节 + fraction 1」，红线就钉死在表格底部不动 ——
  //   网格已经因为活动延长到 23:55 了，红线却停在 20:55，看起来像时间没走。
  const rowUnits = timeToRowUnits(periods, hhmm);
  if (rowUnits != null) {
    // 封顶到网格实际行数：没有延长行时钉在最后一节课的底边（旧行为），
    // 有延长行时红线可以继续往下走。
    const cap = maxRow == null ? periods.length : Math.max(periods.length, maxRow);
    const capped = Math.min(rowUnits, cap);
    const rowIndex = Math.max(0, Math.min(cap - 1, Math.floor(capped)));
    return {
      date,
      minutes,
      hhmm,
      rowIndex,
      fraction: Math.max(0, Math.min(1, capped - rowIndex)),
      inClass: false,
      periodIndex: null,
      visible: true
    };
  }
  return { date, minutes, hhmm, rowIndex: 0, fraction: 0, inClass: false, periodIndex: null, visible: false };
}

/** 判断某个周期课次是否在指定日期发生（详情页「已停课」回溯用）。 */
function sessionOccursOn(state, session, dateStr) {
  const cls = classifyDay(state, dateStr);
  if (cls.status === STATUS.UNCONFIGURED || cls.status === STATUS.OUT_OF_SEMESTER) return false;
  if (cls.skipAll || cls.effectiveDow == null) return false;
  if (Number(session.dayOfWeek) !== cls.effectiveDow) return false;
  return expandWeeks(session.weeks).includes(cls.weekNo);
}

/** ResolvedClass → 展示状态文案。 */
function statusOf(cls) {
  switch (cls.adjustmentType) {
    case 'makeup':
      return '补课';
    case 'reschedule':
      return '已调课';
    case 'roomChange':
      return '已改教室';
    case 'event':
      return '活动';
    default:
      return '正常';
  }
}

/**
 * 某课程在整学期的全部发生日期与状态（详情页用）。
 * 包含被停课的日期（状态「已停课」），让用户看到"本来该上但停了"。
 * @param {object} state
 * @param {string} courseId
 */
export function resolveCourseDates(state, courseId) {
  const settings = (state && state.settings) || {};
  if (!courseId || !settings.semesterStartMonday) return [];
  const total = Math.max(1, Number(settings.totalWeeks) || 20);
  const days = total * 7;
  const sessionById = new Map((state.sessions || []).map((s) => [s.id, s]));
  const cancels = (state.adjustments || []).filter((a) => a && a.type === 'cancel');
  const out = [];
  const seen = new Set();

  for (let i = 0; i < days; i += 1) {
    const date = addDays(settings.semesterStartMonday, i);
    const day = resolveDay(state, date);
    const classes = day.classes.filter((c) => c.courseId === courseId);

    for (const cls of classes) {
      out.push({
        date,
        weekNo: day.weekNo,
        dayOfWeek: dayOfWeekOf(date),
        sessionId: cls.sessionId,
        status: statusOf(cls),
        cls
      });
      seen.add(date);
    }
    if (seen.has(date)) continue;

    // 该日有停课记录且本应发生 → 记一条「已停课」
    for (const a of cancels) {
      if (a.date !== date) continue;
      let shouldOccur = false;
      let matchedSessionId = null;
      if (a.targetSessionId) {
        const s = sessionById.get(a.targetSessionId);
        shouldOccur = !!s && s.courseId === courseId && sessionOccursOn(state, s, date);
        matchedSessionId = a.targetSessionId;
      } else if (a.courseId === courseId) {
        const hit = (state.sessions || []).find(
          (s) => s.courseId === courseId && sessionOccursOn(state, s, date)
        );
        shouldOccur = !!hit;
        matchedSessionId = hit ? hit.id : null;
      }
      if (shouldOccur) {
        out.push({
          date,
          weekNo: day.weekNo,
          dayOfWeek: dayOfWeekOf(date),
          sessionId: matchedSessionId,
          status: '已停课',
          cls: null
        });
        seen.add(date);
        break;
      }
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/* ============================================================ 提醒计划 */

/**
 * 提醒点 —— 唯一生产者，返回**计划对象**（不是裸数组）。
 *
 * 只产 `points`（应用内通知用）。日历(.ics) 导出已移除，不再有第二份点位；
 * 旧数据里残留的 `reminder.channel` 字段一律忽略——所有课程都会产出提醒点。
 *
 * @param {object} state
 * @param {string} fromDate
 * @param {string} toDate
 * @returns {{points:Array, pendingDates:string[],
 *            skipped:Array<{date:string,reason:string,detail?:string}>, warnings:string[]}}
 */
export function getReminders(state, fromDate, toDate) {
  const settings = (state && state.settings) || {};
  const reminder = settings.reminder || {};
  const appEnabled = reminder.enabled !== false;
  const ruleByCourse = new Map(
    (Array.isArray(reminder.rules) ? reminder.rules : []).map((r) => [r.targetId, r])
  );
  const defaultAdvance = Number.isInteger(Number(reminder.defaultAdvanceMinutes))
    ? Number(reminder.defaultAdvanceMinutes)
    : 15;
  const points = [];
  const pendingDates = [];
  const skipped = [];
  const seen = new Set();
  let unconfiguredReported = false;

  for (const date of eachDate(fromDate, toDate)) {
    const day = resolveDay(state, date);

    // ---- 不产点的原因必须显式记账，绝不"静默少一天" ----
    if (day.status === STATUS.UNCONFIGURED) {
      if (!unconfiguredReported) {
        skipped.push({ date, reason: 'SEMESTER_UNCONFIGURED', detail: '未设置学期起始日' });
        unconfiguredReported = true;
      }
      continue;
    }
    if (day.status === STATUS.MAKEUP_UNCONFIRMED) {
      pendingDates.push(date);
      skipped.push({
        date,
        reason: 'UNCONFIRMED_MAKEUP',
        detail: `${day.holidayName || '调休上班日'} 未确认按周几上课`
      });
      continue; // 该日不产任何提醒点（即使有 makeup adjustment）
    }
    if (!day.complete) continue; // 学期外等

    if (day.status === STATUS.HOLIDAY_SILENT && day.classes.length === 0) {
      skipped.push({ date, reason: 'HOLIDAY', detail: day.holidayName || '法定假期' });
      continue;
    }

    // 「已停课」也要留痕（cancel 后该课次已不在 classes 里，故从 adjustments 侧取）
    for (const a of Array.isArray(state.adjustments) ? state.adjustments : []) {
      if (a && a.date === date && a.type === 'cancel') {
        skipped.push({ date, reason: 'CANCELLED', detail: a.courseId || a.targetSessionId || '' });
      }
    }

    // 同一门大课内部换节（上一节同课、且紧接着上）→ 不单独提醒
    const internalBreaks = sameCourseBreakKeys(day.classes);

    for (const c of day.classes) {
      if (c.invalidPeriod || !c.startTime || !c.endTime) {
        skipped.push({ date, reason: 'PERIOD_MISSING', detail: c.courseName });
        continue;
      }

      if (internalBreaks.has(c.key)) {
        // 显式记账：这一节确实存在，只是"同一门课的下一小节"，不该单独提醒
        skipped.push({ date, reason: 'SAME_COURSE_BREAK', detail: c.courseName });
        continue;
      }

      const rule = ruleByCourse.get(c.courseId);
      if (rule && rule.enabled === false) {
        skipped.push({ date, reason: 'RULE_DISABLED', detail: c.courseId });
        continue;
      }
      const advance = Number.isInteger(Number(rule && rule.advanceMinutes))
        ? Number(rule.advanceMinutes)
        : defaultAdvance;
      // 活动没有 courseId，不能拿 null 拼 key（同日同时段两个活动会互相去重掉）
      const who = c.eventId || c.courseId || c.courseName;
      const key = `${who}|${date}|P${c.startPeriod}-${c.endPeriod}|${advance}`;
      if (seen.has(key)) continue; // 去重：同课同日同节次同提前量只留一条
      seen.add(key);

      const periodText =
        c.endPeriod > c.startPeriod ? `第${c.startPeriod}-${c.endPeriod}节` : `第${c.startPeriod}节`;

      const point = {
        key,
        classKey: c.key,
        date,
        weekNo: c.weekNo,
        courseId: c.courseId,
        courseName: c.courseName,
        teacher: c.teacher || null,
        note: c.note || null,
        startPeriod: c.startPeriod,
        endPeriod: c.endPeriod,
        periodText,
        classStart: c.startTime,
        classEnd: c.endTime,
        crossMidnight: !!c.crossMidnight,
        location: c.location || '',
        advanceMinutes: advance,
        triggerAt: wallToEpoch(date, c.startTime) - advance * 60000,
        title: c.eventId ? '即将开始' : '即将上课',
        body: `${c.startTime} ${c.courseName} · ${c.location || '地点待定'} · ${periodText}`
      };

      points.push(point);
    }
  }

  return {
    points: points.sort((a, b) => a.triggerAt - b.triggerAt || a.key.localeCompare(b.key)),
    pendingDates,
    skipped,
    warnings: pendingDates.length
      ? [`${pendingDates.length} 个调休上班日待确认，未生成提醒：${pendingDates.join('、')}`]
      : []
  };
}

/* ============================================================ 其它只读视图 */

/**
 * 下一节课（今日剩余里最早的一节），供课表页倒计时。
 * @param {object} state
 * @param {number} [now]
 */
export function getNextClass(state, now = Date.now()) {
  const date = todayStr(now);
  const day = resolveDay(state, date);
  if (!day.complete) return { cls: null, startAt: null, minutesLeft: null, pending: true };
  const classes = day.classes.filter((c) => c.startTime && !c.invalidPeriod);
  for (const c of classes) {
    const startAt = wallToEpoch(date, c.startTime);
    if (startAt >= now) return { cls: c, startAt, minutesLeft: Math.round((startAt - now) / 60000), pending: false };
  }
  return { cls: null, startAt: null, minutesLeft: null, pending: false };
}

/**
 * 日期展示信息（供 UI 显示"10月19日 · 周一 · 第 1 周"，避免 UI 自己算星期/周次）。
 * @param {object} state
 * @param {string} dateStr
 */
export function describeDate(state, dateStr) {
  const dow = dayOfWeekOf(dateStr);
  return {
    date: dateStr,
    dayOfWeek: dow,
    weekday: WEEKDAY_FULL[dow] || '',
    weekNo: weekNoOf(dateStr, (state && state.settings && state.settings.semesterStartMonday) || null)
  };
}

/** 今天的完整结论（便捷出口）。 */
export function getTodaySummary(state) {
  return resolveDay(state, todayStr());
}
