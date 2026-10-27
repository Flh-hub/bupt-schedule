/**
 * parsers/index.js — 纯逻辑：解析器统一入口 + 来源嗅探 + 归一化。
 *
 * 三通道共同契约（ARCHITECTURE §D.1）：
 *  1. 绝不返回「0 课且 0 未识别」—— 解析不到时必须把输入塞进 unrecognized（reason:NO_COURSE_FOUND）。
 *  2. 绝不自造 Course：适配器只产出课程名，id 由 normalize() 统一分配，同名课程合并。
 *  3. dayOfWeek 一律 1–7（周日 = 7）。
 *  4. endPeriod < startPeriod 的行不进 sessions，进 unrecognized（reason:PERIOD_ORDER）。
 *  5. weeks 必须是 WeekSpec；原文保留到 rawWeeksText。
 *  6. sourceRef 必须填，便于用户在预览页定位原文行。
 */

import { DEFAULT_PERIODS, clampWeekSpec, expandWeeks, todayStr, uid, weeksToText } from '../model.js';
import { parseJwgl, parseTextLines, parseWecom } from './html.js';
import { parseJson, toWeekSpec } from './json.js';

export { parseJson, toWeekSpec };
export {
  parseHtmlLite,
  parseJwgl,
  parseWecom,
  parseTextLines,
  splitMultiCourse,
  tagLine,
  timeRangesFromText
} from './html.js';

/** 页面来源嗅探。 */
export function detectSource(html) {
  const text = String(html == null ? '' : html);
  if (
    /jwglxt|教务|本科生院|xsd\/xsgrxx|kbcx|jwgl|教学管理/i.test(text) &&
    /<table/i.test(text)
  ) {
    return 'jwgl';
  }
  if (/企业微信|wxwork|work\.weixin|qy\.weixin|wecom|课程卡片/i.test(text)) return 'wecom';
  if (/<table/i.test(text)) return 'jwgl'; // 有表格无特征串 → 按教务兜底
  return 'unknown';
}

/** 猜测输入类型。 */
export function guessKind(input) {
  const text = String(input == null ? '' : input).trim();
  if (!text) return 'text';
  if (/^[[{]/.test(text) && /[}\]][\s;]*$/.test(text)) {
    try {
      JSON.parse(text);
      return 'json';
    } catch (err) {
      /* 落到后面判断 */
    }
  }
  if (/<(?:!doctype|html|head|body|table|div|tr|td|span|p|ul|li)\b/i.test(text)) return 'html';
  return 'text';
}

function emptyParseResult(source, detectedBy, strategy) {
  return {
    courses: [],
    sessions: [],
    warnings: [],
    unrecognized: [],
    meta: { source, detectedBy, strategy },
    detected: null,
    rawState: null
  };
}

/** 去重字符串数组，保持顺序。 */
function dedupeStrings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = String(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 判断原始周次输入里是否出现了超出 totalWeeks 的显式数字（用于给出裁剪提示）。 */
function weeksOverflowed(weeksInput, totalWeeks) {
  const nums = [];
  if (weeksInput == null) return false;
  if (typeof weeksInput === 'string') {
    nums.push(...(weeksInput.match(/\d{1,3}/g) || []).map(Number));
  } else if (Array.isArray(weeksInput)) {
    nums.push(...weeksInput.map(Number));
  } else if (typeof weeksInput === 'object') {
    nums.push(Number(weeksInput.end));
    if (Array.isArray(weeksInput.extra)) nums.push(...weeksInput.extra.map(Number));
  }
  return nums.some((n) => Number.isFinite(n) && n > totalWeeks);
}

/**
 * 归一化：预归一化记录 → 正式 ParseResult。
 * @param {object} parsed 适配器输出
 * @param {{totalWeeks?:number, now?:string}} [opts]
 * @returns {object} ParseResult
 */
export function normalize(parsed, opts = {}) {
  const totalWeeks = Math.max(1, Number(opts.totalWeeks) || 20);
  const now = opts.now || new Date().toISOString();
  const warnings = [];
  const unrecognized = [];
  const courses = [];
  const byName = new Map();
  const sessions = [];
  const seen = new Set();

  for (const w of parsed.warnings || []) warnings.push(w);
  for (const u of parsed.unrecognized || []) unrecognized.push(u);

  (parsed.sessions || []).forEach((raw, index) => {
    const name = String(raw.courseName || raw.name || '').trim();
    const fail = (reason) =>
      unrecognized.push({
        raw: raw.raw || String(raw.courseName || raw.name || JSON.stringify(raw)).slice(0, 300),
        reason,
        index
      });

    if (!name) return fail('MISSING_NAME');

    const dow = Number(raw.dayOfWeek);
    if (!Number.isInteger(dow) || dow < 1 || dow > 7) return fail('MISSING_DOW');

    const startPeriod = Number(raw.startPeriod);
    const endPeriod = Number(raw.endPeriod);
    if (!Number.isInteger(startPeriod) || startPeriod < 1) return fail('MISSING_PERIOD');
    if (!Number.isInteger(endPeriod) || endPeriod < startPeriod) return fail('PERIOD_ORDER');

    let course = byName.get(name);
    if (!course) {
      course = {
        id: uid('c'),
        name,
        teacher: raw.teacher ? String(raw.teacher) : null,
        color: null,
        note: null,
        credit: null,
        createdAt: now,
        updatedAt: now
      };
      byName.set(name, course);
      courses.push(course);
    } else if (!course.teacher && raw.teacher) {
      course.teacher = String(raw.teacher);
    }

    const weeksInput =
      raw.weeksSource != null
        ? raw.weeksSource
        : raw.weeks != null
          ? raw.weeks
          : raw.rawWeeksText != null
            ? raw.rawWeeksText
            : raw.weeksText != null
              ? raw.weeksText
              : null;
    let spec = toWeekSpec(weeksInput, totalWeeks);
    const clamped = clampWeekSpec(spec, totalWeeks);
    if (weeksOverflowed(weeksInput, totalWeeks)) {
      warnings.push(`「${name}」周次超出 1-${totalWeeks} 周，已裁剪`);
    }
    spec = clamped.spec;

    const rawWeeksText =
      raw.rawWeeksText != null
        ? String(raw.rawWeeksText)
        : typeof raw.weeksText === 'string'
          ? raw.weeksText
          : weeksToText(spec);

    const dedupeKey = `${course.id}|${dow}|${startPeriod}-${endPeriod}|${spec.start}-${spec.end}|${spec.type}|${(spec.extra || []).join(',')}`;
    if (seen.has(dedupeKey)) {
      warnings.push(`「${name}」有重复排课（第${dow}天 第${startPeriod}-${endPeriod}节），已跳过重复行`);
      return undefined;
    }
    seen.add(dedupeKey);

    sessions.push({
      id: uid('s'),
      courseId: course.id,
      dayOfWeek: dow,
      startPeriod,
      endPeriod,
      location: raw.location == null ? '' : String(raw.location),
      weeks: spec,
      rawWeeksText,
      teacher: raw.teacher ? String(raw.teacher) : null,
      sourceRef: raw.sourceRef || `row${index}`
    });
    return undefined;
  });

  if (!sessions.length && !unrecognized.length) {
    unrecognized.push({ raw: '', reason: 'NO_COURSE_FOUND', index: 0 });
  }

  return {
    courses,
    sessions,
    warnings: dedupeStrings(warnings),
    unrecognized,
    meta: parsed.meta || { source: 'unknown', detectedBy: 'none', strategy: 'none' },
    detected: parsed.detected || null,
    // 教务页面自带的作息表（1..N 节 + 起止时间）：供导入时校正「节次表」
    periodsHint: Array.isArray(parsed.periodsHint) ? parsed.periodsHint : null,
    rawState: parsed.rawState || null
  };
}

/**
 * 文本通道：逐行解析（F1 类型识别 / F2 分隔符 / F3 时间制），逐行容错。
 * @param {string} text
 * @param {{periods?:Array, totalWeeks?:number}} [opts]
 */
export function parseText(text, opts = {}) {
  const periodList = Array.isArray(opts.periods) && opts.periods.length ? opts.periods : DEFAULT_PERIODS;
  const { records, unrecognized } = parseTextLines(text, { periods: periodList });
  const parsed = {
    ...emptyParseResult('text', 'manual:text', 'text:lines'),
    sessions: records.map((r) => ({
      courseName: r.name,
      teacher: r.teacher,
      dayOfWeek: r.dayOfWeek,
      startPeriod: r.periods ? r.periods.startPeriod : null,
      endPeriod: r.periods ? r.periods.endPeriod : null,
      location: r.location || '',
      weeksText: r.weeksText,
      raw: r.raw,
      sourceRef: `text:line${(r.index == null ? 0 : r.index) + 1}`
    })),
    unrecognized
  };
  if (!records.length && !unrecognized.length) {
    parsed.unrecognized = [
      { raw: String(text || '').slice(0, 400), reason: 'NO_COURSE_FOUND', index: 0 }
    ];
    parsed.warnings.push('没有解析到任何课程，请检查每行是否包含「星期 + 节次」');
  }
  return normalize(parsed, opts);
}

/**
 * HTML 通道：自动/手动判别来源 → 对应适配器 → 归一。
 * @param {string} html
 * @param {{source?:string, forceSource?:boolean, periods?:Array, totalWeeks?:number}} [opts]
 */
export function parseHtml(html, opts = {}) {
  const text = String(html == null ? '' : html);
  if (!text.trim()) {
    return normalize(
      {
        ...emptyParseResult('unknown', 'none', 'none'),
        unrecognized: [{ raw: '', reason: 'EMPTY_INPUT', index: 0 }]
      },
      opts
    );
  }

  const detected = detectSource(text);
  const source = opts.source && opts.source !== 'auto' ? opts.source : detected;

  if (source === 'unknown' && !opts.forceSource) {
    return normalize(
      {
        ...emptyParseResult('unknown', 'none', 'none'),
        unrecognized: [{ raw: text.slice(0, 400), reason: 'SOURCE_UNDETECTED', index: 0 }],
        warnings: ['未能识别页面来源，请在上方手动选择「来源 = 教务系统」或改用「粘贴文本」通道后重试']
      },
      opts
    );
  }

  const adapterOpts = {
    periods: Array.isArray(opts.periods) && opts.periods.length ? opts.periods : DEFAULT_PERIODS,
    totalWeeks: opts.totalWeeks
  };
  const raw = source === 'wecom' ? parseWecom(text, adapterOpts) : parseJwgl(text, adapterOpts);

  const merged = { ...raw };
  if (!merged.sessions.length && source === 'wecom') {
    // 企微通道失败时，兜一层教务网格（有些页面只是带企微水印）
    const jwgl = parseJwgl(text, adapterOpts);
    if (jwgl.sessions.length) {
      merged.sessions = jwgl.sessions;
      merged.unrecognized = [...merged.unrecognized, ...jwgl.unrecognized];
      merged.warnings = [...merged.warnings, ...jwgl.warnings, '企微适配器未命中，已改用教务表格适配器'];
      merged.periodsHint = jwgl.periodsHint || null;
      merged.meta = { ...jwgl.meta, source: 'wecom' };
    }
  }
  merged.meta = { ...merged.meta, detectedBy: `auto:${detected}` };
  return normalize(merged, opts);
}

/**
 * 统一入口。
 * @param {string} input
 * @param {{kind?:'text'|'html'|'json', source?:string, forceSource?:boolean,
 *          periods?:Array, totalWeeks?:number}} [opts]
 * @returns {object} ParseResult
 */
export function parse(input, opts = {}) {
  const kind = opts.kind || guessKind(input);
  if (kind === 'json') {
    const raw = parseJson(input);
    return normalize(raw, opts);
  }
  if (kind === 'html') return parseHtml(input, opts);
  return parseText(input, opts);
}

/**
 * 一次性汇总统计（预览页顶部摘要用）。
 * @param {object} parseResult
 */
export function summarize(parseResult) {
  const sessions = parseResult.sessions || [];
  const courses = parseResult.courses || [];
  return {
    courseCount: courses.length,
    sessionCount: sessions.length,
    warningCount: (parseResult.warnings || []).length,
    unrecognizedCount: (parseResult.unrecognized || []).length,
    weekRange: (() => {
      const weeks = [];
      for (const s of sessions) weeks.push(...expandWeeks(s.weeks));
      if (!weeks.length) return null;
      return { min: Math.min(...weeks), max: Math.max(...weeks) };
    })(),
    generatedAt: todayStr()
  };
}
