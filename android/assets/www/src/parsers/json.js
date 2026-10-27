/**
 * parsers/json.js — 纯逻辑：JSON 适配器。
 *
 * 支持两类输入：
 *  1. 本 App 自身的备份 / 导出格式（`{schemaVersion,settings,courses,sessions,...}`）→ 复用同一套 schema，
 *     并把 sessions 解引用成「课程名 + 周次」，交给 parsers/index.js 的 normalize() 统一归一。
 *  2. 第三方抓包 JSON（字段名模糊映射：kcmc→name、xq→dayOfWeek、jc→startPeriod、cdmc→location …）。
 *
 * schemaVersion 高于当前支持版本 → 明确拒绝并给出可读原因（PRD US-4 AC3）。
 */

import { SCHEMA_VERSION, expandWeeks, parseWeeksText, weeksToText } from '../model.js';

/** 常见第三方字段名映射（顺序即优先级）。 */
const FIELD_KEYS = {
  name: ['courseName', 'kcmc', 'kcname', 'kcmcMc', 'name', 'title', 'course', 'course_title'],
  teacher: ['teacher', 'teacherName', 'jsxm', 'skls', 'instructor', 'xm', 'jsmc'],
  dayOfWeek: ['dayOfWeek', 'xq', 'xingqi', 'weekday', 'xqj', 'day', 'weekDay', 'xqmc'],
  startPeriod: ['startPeriod', 'jc', 'startSection', 'section', 'jcs', 'start', 'jc1', 'qsjc'],
  endPeriod: ['endPeriod', 'jc2', 'endSection', 'sectionEnd', 'zzjc'],
  location: ['location', 'cdmc', 'classroom', 'room', 'place', 'cd', 'classRoom', 'jxdd'],
  weeks: ['weeks', 'zc', 'zcd', 'weekText', 'zcmc', 'weekDesc', 'zcs'],
  periods: ['periods', 'periodText', 'jcs', 'sections'],
  dayText: ['dayText', 'xqText', 'weekDayText']
};

const DOW_MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

function pick(obj, keys) {
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== '') return obj[key];
  }
  return null;
}

function dowFromValue(value) {
  if (value == null) return null;
  const text = String(value);
  const cn = text.match(/[一二三四五六日天]/);
  if (cn) return DOW_MAP[cn[0]] || null;
  const num = Number(text.replace(/[^\d]/g, ''));
  if (!Number.isFinite(num)) return null;
  if (num === 0) return 7;
  if (num >= 1 && num <= 7) return num;
  return null;
}

function periodRangeFrom(obj) {
  const rawPeriods = pick(obj, ['periods', 'periodText', 'jcs', 'sections', 'jc', 'jcText']);
  if (rawPeriods != null) {
    const m = String(rawPeriods).match(/(\d{1,2})\s*[-~—－至]\s*(\d{1,2})/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a >= 1 && b >= 1) return { startPeriod: Math.min(a, b), endPeriod: Math.max(a, b) };
    }
    const single = String(rawPeriods).match(/(\d{1,2})/);
    if (single) {
      const a = Number(single[1]);
      if (a >= 1) return { startPeriod: a, endPeriod: a };
    }
  }
  const startRaw = pick(obj, FIELD_KEYS.startPeriod);
  if (startRaw == null) return null;
  // startRaw 可能本身就是 "3-4" 这种区间写法
  const startRange = String(startRaw).match(/(\d{1,2})\s*[-~—－至]\s*(\d{1,2})/);
  if (startRange) {
    const a = Number(startRange[1]);
    const b = Number(startRange[2]);
    if (a >= 1 && b >= 1) return { startPeriod: Math.min(a, b), endPeriod: Math.max(a, b) };
  }
  const start = Number(String(startRaw).replace(/[^\d]/g, ''));
  const endRaw = pick(obj, FIELD_KEYS.endPeriod);
  const end = endRaw == null ? start : Number(String(endRaw).replace(/[^\d]/g, ''));
  if (!Number.isFinite(start) || start < 1) return null;
  return {
    startPeriod: Math.min(start, Number.isFinite(end) ? end : start),
    endPeriod: Math.max(start, Number.isFinite(end) ? end : start)
  };
}

function weeksFromValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const nums = value.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n >= 1);
    if (!nums.length) return null;
    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    // 连续段作为 start..end，其余入 extra
    let bestStart = sorted[0];
    let bestEnd = sorted[0];
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
      if (sorted[j] - sorted[i] > bestEnd - bestStart) {
        bestStart = sorted[i];
        bestEnd = sorted[j];
      }
      i = j + 1;
    }
    const extra = sorted.filter((w) => w < bestStart || w > bestEnd);
    return { start: bestStart, end: bestEnd, type: 'all', extra };
  }
  return String(value);
}

/** 单条第三方对象 → 预归一化记录。 */
function recordFromObject(obj) {
  const name = pick(obj, FIELD_KEYS.name);
  const periods = periodRangeFrom(obj);
  const dow = dowFromValue(pick(obj, FIELD_KEYS.dayOfWeek) || pick(obj, FIELD_KEYS.dayText));
  const weeksRaw = weeksFromValue(pick(obj, FIELD_KEYS.weeks));
  return {
    courseName: name == null ? null : String(name).trim(),
    teacher: (() => {
      const t = pick(obj, FIELD_KEYS.teacher);
      return t == null ? null : String(t).trim();
    })(),
    dayOfWeek: dow,
    startPeriod: periods ? periods.startPeriod : null,
    endPeriod: periods ? periods.endPeriod : null,
    location: (() => {
      const l = pick(obj, FIELD_KEYS.location);
      return l == null ? '' : String(l).trim();
    })(),
    weeksSource: weeksRaw
  };
}

/** 深搜「像课表条目」的数组。 */
function findCourseArrays(node, out, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    const sample = node.find((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (sample) {
      const keys = Object.keys(sample);
      const hasName = keys.some((k) => /^(courseName|kcmc|kcname|name|title)$/i.test(k));
      const hasTime = keys.some((k) => /^(dayOfWeek|xq|xingqi|jc|jcs|section|weeks|zc)$/i.test(k));
      if (hasName && hasTime) {
        out.push(node);
        return;
      }
    }
    for (const item of node) findCourseArrays(item, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) findCourseArrays(node[key], out, depth + 1);
  }
}

function result(source, strategy) {
  return {
    courses: [],
    sessions: [],
    warnings: [],
    unrecognized: [],
    meta: { source, detectedBy: 'json', strategy },
    detected: null,
    rawState: null
  };
}

/**
 * 解析 JSON 通道。
 * @param {string|object} raw
 * @returns {object} 预归一化 ParseResult（含 detected / rawState）
 */
export function parseJson(raw) {
  const out = result('json', 'json:auto');

  let data = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) {
      out.unrecognized.push({ raw: '', reason: 'EMPTY_INPUT', index: 0 });
      return out;
    }
    try {
      data = JSON.parse(text);
    } catch (err) {
      out.unrecognized.push({
        raw: text.slice(0, 400),
        reason: 'INVALID_JSON',
        index: 0
      });
      out.warnings.push('JSON 格式不合法，请检查是否复制完整（常见原因：首尾被截断）');
      return out;
    }
  }

  if (!data || typeof data !== 'object') {
    out.unrecognized.push({ raw: String(data).slice(0, 400), reason: 'NO_COURSE_FOUND', index: 0 });
    return out;
  }

  // ---------- A. 本 App 自身格式 ----------
  if (data.schemaVersion != null) {
    const version = Number(data.schemaVersion);
    if (Number.isFinite(version) && version > SCHEMA_VERSION) {
      out.unrecognized.push({
        raw: JSON.stringify({ schemaVersion: data.schemaVersion }).slice(0, 200),
        reason: 'SCHEMA_UNSUPPORTED',
        index: 0
      });
      out.warnings.push(
        `数据版本 ${data.schemaVersion}，当前支持 ${SCHEMA_VERSION}。请升级应用后再导入，或手工降级数据文件。`
      );
      return out;
    }
    if (!Array.isArray(data.sessions)) {
      out.unrecognized.push({ raw: '', reason: 'NO_COURSE_FOUND', index: 0 });
      out.warnings.push('该 JSON 未包含 sessions 字段，可能不是课表数据');
      return out;
    }

    const courseById = new Map(
      (Array.isArray(data.courses) ? data.courses : []).map((c) => [c.id, c])
    );
    out.meta.strategy = 'json:backup';
    out.rawState = data;
    out.detected = {
      semesterStartMonday:
        data.settings && data.settings.semesterStartMonday
          ? data.settings.semesterStartMonday
          : null,
      totalWeeks:
        data.settings && Number.isFinite(Number(data.settings.totalWeeks))
          ? Number(data.settings.totalWeeks)
          : null,
      courseCount: Array.isArray(data.courses) ? data.courses.length : 0,
      sessionCount: data.sessions.length,
      adjustmentCount: Array.isArray(data.adjustments) ? data.adjustments.length : 0,
      holidayCount: Array.isArray(data.holidays) ? data.holidays.length : 0
    };

    for (const s of data.sessions) {
      const course = courseById.get(s.courseId);
      if (!course) {
        out.unrecognized.push({
          raw: JSON.stringify(s).slice(0, 300),
          reason: 'DANGLING_COURSE',
          index: out.unrecognized.length
        });
        continue;
      }
      out.sessions.push({
        courseName: course.name,
        teacher: s.teacher || course.teacher || null,
        dayOfWeek: Number(s.dayOfWeek),
        startPeriod: Number(s.startPeriod),
        endPeriod: Number(s.endPeriod),
        location: s.location || '',
        weeksSource: s.weeks || null,
        rawWeeksText: s.rawWeeksText || (s.weeks ? weeksToText(s.weeks) : null),
        sourceRef: s.sourceRef || `json:${s.id || 'session'}`
      });
    }
    return out;
  }

  // ---------- B. 第三方抓包格式 ----------
  const arrays = [];
  findCourseArrays(data, arrays);
  if (!arrays.length) {
    out.unrecognized.push({
      raw: JSON.stringify(data).slice(0, 400),
      reason: 'NO_COURSE_FOUND',
      index: 0
    });
    out.warnings.push('未在 JSON 中找到课表数组（需要同时含课程名与星期/节次字段）');
    return out;
  }

  out.meta.strategy = 'json:thirdparty';
  let idx = 0;
  for (const arr of arrays) {
    for (const item of arr) {
      idx += 1;
      const rec = recordFromObject(item);
      if (!rec.courseName) {
        out.unrecognized.push({ raw: JSON.stringify(item).slice(0, 300), reason: 'MISSING_NAME', index: idx });
        continue;
      }
      if (!rec.dayOfWeek) {
        out.unrecognized.push({ raw: JSON.stringify(item).slice(0, 300), reason: 'MISSING_DOW', index: idx });
        continue;
      }
      if (!rec.startPeriod) {
        out.unrecognized.push({ raw: JSON.stringify(item).slice(0, 300), reason: 'MISSING_PERIOD', index: idx });
        continue;
      }
      out.sessions.push({
        courseName: rec.courseName,
        teacher: rec.teacher,
        dayOfWeek: rec.dayOfWeek,
        startPeriod: rec.startPeriod,
        endPeriod: rec.endPeriod || rec.startPeriod,
        location: rec.location,
        weeksSource: rec.weeksSource,
        rawWeeksText: typeof rec.weeksSource === 'string' ? rec.weeksSource : null,
        sourceRef: `json:item${idx}`
      });
    }
  }

  if (!out.sessions.length && !out.unrecognized.length) {
    out.unrecognized.push({ raw: '', reason: 'NO_COURSE_FOUND', index: 0 });
  }
  return out;
}

/**
 * weeksSource 可能是 WeekSpec、周次数组或「1-16周」文本 → 统一成 WeekSpec。
 * @param {any} source
 * @param {number} totalWeeks
 */
export function toWeekSpec(source, totalWeeks = 20) {
  if (!source) return parseWeeksText('', totalWeeks);
  if (typeof source === 'string') return parseWeeksText(source, totalWeeks);
  if (Array.isArray(source)) {
    const nums = source.map(Number).filter((n) => Number.isFinite(n) && n >= 1);
    if (!nums.length) return parseWeeksText('', totalWeeks);
    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    const expanded = expandWeeks({ start: sorted[0], end: sorted[sorted.length - 1], type: 'all', extra: [] });
    const full = sorted.length === expanded.length;
    if (full) return { start: sorted[0], end: sorted[sorted.length - 1], type: 'all', extra: [] };
    return parseWeeksText(sorted.join(','), totalWeeks);
  }
  if (typeof source === 'object' && source.start != null) {
    return {
      start: Number(source.start) || 1,
      end: Number(source.end) || Number(source.start) || 1,
      type: ['all', 'odd', 'even'].includes(source.type) ? source.type : 'all',
      extra: Array.isArray(source.extra) ? source.extra.map(Number).filter((n) => n >= 1) : []
    };
  }
  return parseWeeksText(String(source), totalWeeks);
}
