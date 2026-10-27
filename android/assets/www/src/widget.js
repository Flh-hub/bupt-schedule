/**
 * widget.js — 桌面小组件的**数据契约**（网页 → 原生）。
 *
 * 【为什么要有这一层】
 * 小组件是原生渲染的（RemoteViews），它跑不起来任何 JS，也读不到 localStorage。
 * 所以网页必须把"接下来这些天每天有什么课"算好、序列化成 JSON 交给原生存盘。
 * 而这个"算"的过程必须只用 calendar.resolveDay —— 调课 / 补课 / 放假 / 补班
 * 的判定逻辑全在那边，小组件绝不能自己再实现一遍（一定会有出入）。
 *
 * 【为什么不只给"今天"】
 * 小组件最长可能 30 分钟才被系统唤醒一次，而用户可能三天不开 App。
 * 只存今天，第二天小组件就会显示昨天的课。所以一次给足 WIDGET_DAYS 天，
 * 由原生按"今天"自己挑；超出窗口才提示"数据有点旧，打开应用同步一下"。
 *
 * 【纯逻辑】不碰 DOM / 不碰 localStorage / 不碰原生桥，Node 可直接测。
 */

import { resolveDay } from './calendar.js';
import { addDays, courseColor, dayOfWeekOf, todayStr, WEEKDAY_FULL } from './model.js';

/** 一次同步覆盖多少天（含今天）。14 天足以撑过"一个月不开 App"之外的所有情况。 */
export const WIDGET_DAYS = 14;

/** 单日最多带几门（防止某天异常数据把 JSON 撑爆；正常一天不会超过 8 门）。 */
export const WIDGET_MAX_COURSES = 12;

/** 课程名 / 地点截断长度：小组件一行放不下更多，超了原生还得自己截。 */
const MAX_TEXT = 24;

/** 课程色非法时的兜底（与网页端默认色一致；小写，保证交出去的颜色格式统一）。 */
const FALLBACK_COLOR = '#4c6ef5';

/**
 * 只接受 `#rrggbb`。
 *
 * ★ 这个值会被原样塞进 `setBackgroundColor` / `setTextColor`，非法字符串在 Java 里
 *   会抛 IllegalArgumentException —— 一个坏的配色能直接把小组件刷成一片空白。
 */
function safeColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value.toLowerCase()
    : FALLBACK_COLOR;
}

function clip(value, max = MAX_TEXT) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function hhmm(value) {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : '';
}

/**
 * 节次文本：`第1-2节` / `第3节`。
 *
 * 时间解析失败的课（invalidPeriod）没有 startTime，就靠这个让小组件仍然有信息可展示。
 */
function periodText(c) {
  const a = Number(c.startPeriod);
  const b = Number(c.endPeriod);
  if (!Number.isInteger(a) || a < 1) return '';
  if (!Number.isInteger(b) || b < a) return `第${a}节`;
  return a === b ? `第${a}节` : `第${a}-${b}节`;
}

/** 单门课 → 小组件最小字段集。刻意不放 teacher/note：小组件一行也放不下。 */
function toWidgetCourse(c) {
  return {
    name: clip(c.courseName || '未命名'),
    room: clip(c.location),
    start: hhmm(c.startTime),
    end: hhmm(c.endTime),
    periods: periodText(c),
    // ★ 解析出来的课**不带颜色**（calendar 里 color 直接取 course.color，通常是 null），
    //   网页 UI 一律靠 model.courseColor() 按 id 推导。小组件这边必须走同一个函数，
    //   否则所有色条会退化成同一个兜底色，用户看不出哪节是哪门课。
    color: safeColor(c.color || courseColor(c.courseId || c.courseName || '')),
    isEvent: !!c.isEvent
  };
}

/** 单日 → 小组件字段。`complete === false` 表示"这天要不要上课还没定"。 */
function toWidgetDay(state, date) {
  const day = resolveDay(state, date);
  const dow = dayOfWeekOf(date);
  const classes = Array.isArray(day.classes) ? day.classes : [];
  return {
    date,
    weekday: WEEKDAY_FULL[dow] || '',
    monthDay: `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`,
    weekNo: Number.isInteger(day.weekNo) ? day.weekNo : null,
    status: String(day.status || ''),
    complete: !!day.complete,
    holidayName: day.holidayName ? clip(day.holidayName) : null,
    courses: classes.slice(0, WIDGET_MAX_COURSES).map(toWidgetCourse)
  };
}

/**
 * 组装交给原生的整份数据。
 *
 * @param {object} state store 的完整状态
 * @param {number} [now] epoch ms
 * @param {{days?:number}} [opts]
 * @returns {{version:number, updatedAt:number, today:string, days:Array<object>}}
 */
export function buildWidgetPayload(state, now = Date.now(), opts = {}) {
  const count = Math.max(1, Math.min(31, Number(opts.days) || WIDGET_DAYS));
  const today = todayStr(now);
  const days = [];
  for (let i = 0; i < count; i += 1) {
    days.push(toWidgetDay(state, addDays(today, i)));
  }
  return { version: 1, updatedAt: now, today, days };
}

/**
 * 给小组件挑选"今天要显示哪几行"。
 *
 * 这个函数只用于测试与文档说明：真正的渲染在 Java 里，但取舍规则必须写下来，
 * 否则两边很容易各自演化出不一样的行为。
 *
 * 规则：
 *  1. 已结束的课排在后面（保留可见但淡化，用户一眼能看出"上午已经上完了"）；
 *  2. 行数不够时优先丢掉已结束的；
 *  3. 全天上完 → 仍然显示全部，由原生在标题栏给一句"今天的课上完了"。
 *
 * @param {Array<object>} courses payload 里某一天的 courses
 * @param {number} maxRows
 * @param {number} nowMinutes 当前时刻的分钟数（0-1439）
 */
export function pickWidgetCourses(courses, maxRows, nowMinutes = 0) {
  const list = Array.isArray(courses) ? courses : [];
  const limit = Math.max(1, Number(maxRows) || 1);
  const scored = list.map((c, index) => {
    const end = c && /^\d{2}:\d{2}$/.test(c.end || '') ? c.end : '';
    const ended = end ? Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5)) <= nowMinutes : false;
    return { c, index, ended };
  });
  if (scored.length <= limit) return scored.map((s) => s.c);
  const live = scored.filter((s) => !s.ended).map((s) => s.c);
  const gone = scored.filter((s) => s.ended).map((s) => s.c);
  return live.slice(0, limit).concat(gone.slice(0, Math.max(0, limit - live.length)));
}
