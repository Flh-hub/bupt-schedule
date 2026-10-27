/**
 * ui/timetable.js — 课表 Tab（周视图 / 日视图） + 课程详情 / 调课二级页。
 *
 * 【纪律】
 *  1. 本文件不做任何日期 / 周次 / 节假日判断：一切结论来自 calendar.js 的
 *     `resolveDay()`（对象，带 status/complete/notice）/ `getWeekView()` / `getNextClass()` /
 *     `getNowMarker()` / `resolveCourseDates()`。
 *  2. 横幅文案一律取 `day.notice`，**不得自行拼文案**。
 *  3. ★ G10：`classes.length === 0` 只有在 `day.complete === true` 时才代表"确实没课"。
 *     `makeup_unconfirmed` / `unconfigured` 两态必须走专属 UI，**任何位置都不许出现"今日无课"**。
 */

import {
  ADJUSTMENT_LABEL,
  WEEKDAY_FULL,
  WEEKDAY_SHORT,
  courseColor,
  epochToWall,
  minutesOfDay,
  normalizeCourseName,
  timePlacement,
  weeksToText
} from '../model.js';
import {
  describeDate,
  getNextClass,
  getNowMarker,
  getPeriods,
  getWeekView,
  resolveCourseDates,
  resolveDay
} from '../calendar.js';
import { listMakeupDays } from '../holidays.js';
import {
  ICONS,
  badge,
  banner,
  blockStyle,
  dateCn,
  emptyState,
  escapeHtml,
  segmented,
  selectField,
  snackbar
} from './components.js';

/* ---------------------------------------------------------------- 公共片段 */

function topbarHtml(title, sub, rightHtml = '') {
  return `<div class="topbar">
    <div class="topbar-row">
      <div class="grow">
        <h1>${escapeHtml(title)}</h1>
        ${sub ? `<p class="sub">${sub}</p>` : ''}
      </div>
      ${rightHtml}
    </div>
  </div>`;
}

const STATUS_BADGE = {
  normal: null,
  holiday_silent: ['假期静默', 'holiday'],
  makeup_unconfirmed: ['待确认', 'warn'],
  makeup_skipped: ['不排课', 'gray'],
  makeup_follow: ['补班', ''],
  out_of_semester: ['学期外', 'gray'],
  unconfigured: ['未配置学期', 'warn']
};

/** 该补班日是否为"推定值"（如 2026-01-04 → 按周五，需用户核对）。 */
function isInferred(state, date) {
  const entry = listMakeupDays(state.holidays).find((h) => h.date === date);
  return !!(entry && entry.inferred);
}

/* ---------------------------------------------------------------- 待确认卡片 */

/**
 * `makeup_unconfirmed` 的专属占位卡（★ 主区域、不可折叠，PRD E15 / ARCHITECTURE §E.2）。
 * 8 选 1：周一…周日 / 不上课；另给"全部未确认日都不上课"批量出口。
 * @param {object} day
 * @param {{compact?:boolean}} [opts]
 */
function pendingCardHtml(day) {
  const options = [1, 2, 3, 4, 5, 6, 7]
    .map(
      (d) => `<button type="button" data-action="makeup-follow" data-date="${day.date}" data-follow="${d}">
        周${WEEKDAY_SHORT[d]}</button>`
    )
    .join('');
  return `<div class="card makeup-card">
    <h2 class="card-title"><span class="dot" style="background:#B7791F"></span>调休上班日 · 待确认</h2>
    <p class="small" style="margin:0 0 12px;color:#8a5a10;line-height:1.55">
      ${escapeHtml(day.notice || '')}
    </p>
    <div class="opt-grid">
      ${options}
      <button type="button" class="is-none" data-action="makeup-follow" data-date="${day.date}" data-follow="none">
        不上课</button>
    </div>
    <p class="tiny muted" style="margin:10px 0 0">
      官方通知只规定「哪几天放假、哪几天上班」，不指明补哪一天的课，所以这里不替你猜。
      确认前<b>不生成提醒、不导出日历</b>。
    </p>
    <button type="button" class="btn btn-sm btn-ghost" style="margin-top:6px;padding-left:0"
      data-action="makeup-follow-bulk">全部未确认日都不上课 →</button>
  </div>`;
}

/* ---------------------------------------------------------------- 横幅（只读 status） */

function dayBannersHtml(state, day) {
  if (!day) return '';
  switch (day.status) {
    case 'holiday_silent':
      return banner('holiday', `<b>${escapeHtml(day.notice || '法定假期')}</b>`);
    case 'makeup_follow': {
      const inferred = isInferred(state, day.date);
      return banner(
        'makeup',
        `<b>${escapeHtml(day.notice || '调休补班')}</b>${
          inferred ? '<br><span class="small">「按周五上课」为推定值（元旦只借用 01-02 一个工作日），请按北邮校历核对</span>' : ''
        }`,
        `<button class="btn btn-sm btn-soft" data-action="makeup-change" data-date="${day.date}">修改</button>`
      );
    }
    case 'makeup_skipped':
      return banner(
        'makeup',
        `<b>${escapeHtml(day.notice || '调休上班日 · 不排课')}</b>`,
        `<button class="btn btn-sm btn-soft" data-action="makeup-change" data-date="${day.date}">修改</button>`
      );
    case 'out_of_semester':
      return banner('info', `<b>${escapeHtml(day.notice || '学期外')}</b>`);
    case 'unconfigured':
      return banner(
        'warn',
        `<b>${escapeHtml(day.notice || '未设置学期起始日')}</b>`,
        `<button class="btn btn-sm btn-soft" data-action="nav" data-route="#/settings">去设置</button>`
      );
    default:
      return '';
  }
}

/**
 * 本周提示：压成一行细条，不抢课表的视觉。
 *
 * 假期静默 / 调休待确认都会让某些整列空着——必须说一句（否则像课表不全），
 * 但大色块 banner + 按钮太吵；这里一行小字，点击去设置。
 */
function weekNoteHtml(view, skipDate) {
  const bits = [];
  const holidays = (view.days || []).filter((d) => d.status === 'holiday_silent');
  if (holidays.length) {
    const names = [...new Set(holidays.map((d) => d.holidayName).filter(Boolean))];
    const label = names.length === 1 ? `${names[0]}假期` : '法定假期';
    bits.push(`${label} ${holidays.length} 天，不排课、不提醒`);
  }
  const pending = (view.pendingDates || []).filter((d) => d !== skipDate);
  if (pending.length) bits.push(`${pending.length} 个调休上班日待确认`);
  if (!bits.length) return '';
  return `<button type="button" class="tt-note" data-action="nav" data-route="#/settings">
    <span>${escapeHtml(bits.join(' · '))}</span><span class="tt-note-go">设置 ›</span>
  </button>`;
}

/**
 * 这一天的标记（角标 + 列底色）。
 *
 * 假期静默 / 调休待确认的日子**本来就没有课**，但如果列上什么都不显示，
 * 用户看到的就是"课表不全"（2026 国庆 10-01~10-07 横跨第 5、6 周，最典型）。
 */
function dayMarkOf(day) {
  if (day.status === 'holiday_silent') {
    return { col: 'is-holiday-col', tag: '假', tagCls: 'is-holiday', head: 'is-holiday-head' };
  }
  if (day.status === 'makeup_unconfirmed') {
    return { col: 'is-pending-col', tag: '待确认', tagCls: 'is-pending', head: 'is-pending-head' };
  }
  if (day.status === 'makeup_skipped') {
    return { col: 'is-pending-col', tag: '无课', tagCls: 'is-pending', head: '' };
  }
  if (day.status === 'makeup_follow') {
    return { col: '', tag: '补课', tagCls: 'is-makeup', head: '' };
  }
  return { col: '', tag: '', tagCls: '', head: '' };
}

/**
 * 拖动需要的上下文全塞进 data-*：重绘后元素换了新对象，
 * 拖一半遇到重绘（比如别处 dispatch）也不会丢「拖的是哪条」。
 */
function dragAttrs(cls) {
  const attrs = {
    'data-drag': '1',
    'data-dname': cls.courseName || '',
    'data-gs': String(cls.startPeriod),
    'data-ge': String(cls.endPeriod),
    'data-sid': cls.sessionId || '',
    'data-cid': cls.courseId || '',
    'data-dtype': cls.adjustmentType || '',
    'data-daid': cls.adjustmentId || '',
    'data-dloc': cls.location || ''
  };
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join('');
}

/** 地点短格式：`教学实验综合楼-S215` → `S215`，`智慧教学楼-413` → `413`。块里只放房间号。 */
/**
 * 地点 → {building, room}。
 *
 * 教务系统的写法五花八门：`教三-201` / `教三201` / `主楼 A101` / `教三 301`。
 * 课表块要同时看到**楼栋和教室**（只给「201」根本不知道该去哪个楼），
 * 所以这里尽力拆成两段；拆不开就整串当教室。
 */
export function splitLocation(location) {
  const raw = String(location || '').trim();
  if (!raw) return { building: '', room: '' };

  // ① 有明确分隔符：教三-201 / 教三 301 / 主楼－A101
  const sep = raw.match(/^(.*?)\s*[-－—\s]\s*(.+)$/);
  if (sep && sep[1].trim() && sep[2].trim()) {
    return { building: sep[1].trim(), room: sep[2].trim() };
  }

  // ② 没有分隔符，但末尾是房间号：教三201 / 教学楼A305 / 主楼B101
  //   房间号 = 2~4 位数字，两侧可各带一个大写字母（A305 / 305B）
  const tail = raw.match(/^(.*?)(\d{2,4}[A-Za-z]?)$/);
  if (tail && tail[1].trim()) {
    return { building: tail[1].trim(), room: tail[2] };
  }

  // ③ 兜底：整串当教室（如「体育馆二层」这种没有房间号的写法）
  return { building: '', room: raw };
}

/** 一行式地点：`教三 201`；没有楼栋时就只有教室；完全没填就「地点待定」。 */
export function locationText(location) {
  const { building, room } = splitLocation(location);
  if (!room) return '地点待定';
  return building ? `${building} ${room}` : room;
}

/**
 * 课表块里的地点：**楼栋、教室各占一行**。
 *
 * 【为什么不用一行】格子只有 40 多像素宽，`教学楼A 305` 一行放不下，
 * 老样式又写了 `white-space:nowrap + ellipsis`，于是被截成「教学…」——
 * 楼栋名字直接没了，比不显示还糟（2026-10-25 真机反馈）。
 * 拆成两行后每行都短，能完整显示；真的超长也只会截那一行，不会连累另一行。
 *
 * @param {string} location
 * @returns {string} HTML 片段
 */
export function locationHtml(location) {
  const { building, room } = splitLocation(location);
  if (!room) return '<span class="b-loc">地点待定</span>';
  // 楼栋与教室用空格连排，交给 CSS 自然折行 —— 宽度够就一行，
  // 不够就从空格处断成两行，比强行分行更省高度。
  const parts = [];
  if (building) parts.push(`<b class="b-bld">${escapeHtml(building)}</b>`);
  parts.push(`<span class="b-room">${escapeHtml(room)}</span>`);
  return `<span class="b-loc">${parts.join(' ')}</span>`;
}

/**
 * 课程块的主色。
 *
 * ★ 必须走 `courseColor(courseId)` 派生：`resolveClasses` 返回的 `color` 直接取
 *   `course.color`，而导入的课程这个字段几乎都是 null —— 只读 color 会让**所有课同一个颜色**，
 *   课表就成了一片同色块，完全分不出哪门是哪门。
 */
function blockColor(cls) {
  if (!cls) return undefined;
  return cls.color || courseColor(cls.courseId || cls.courseName || '');
}

/**
 * 同一格子里按课程去重。
 *
 * 一门课可能因为「单双周各一条 session」「导入重复」「换教室调课」被拆成多条记录，
 * 全部画出来就会把「高等数学」在同一个格子印两遍。按 `courseId` 合并
 * （活动没有 courseId，回退到课程名），保留最先出现的那条。
 *
 * @param {Array<object>} list 同一时段、同起止的多条课次
 * @returns {Array<object>} 去重后的课次，保持原顺序
 */
export function dedupeCourses(list) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c) continue;
    const cid = c.courseId || `name:${c.courseName}`;
    if (seen.has(cid)) continue;
    seen.add(cid);
    out.push(c);
  }
  return out;
}

/* ---------------------------------------------------------------- 周视图网格 */

/**
 * 最后一节之后的「延长行」时间刻度。
 *
 * 【为什么需要】
 * 活动可以开到最后一节课以后（21:00 的会）。那几行没有对应节次，但它占据了真实时间，
 * 左侧如果空着，用户看到的就是"一个没有刻度的色块" —— 不知道它到底到几点。
 *
 * 【怎么算】
 * 按**最后一节的时长**继续往下排（保持课表的节奏），而不是固定 45 分钟 ——
 * 有的学校最后一节是 40 分钟，有的是 55 分钟。
 * 过 24:00 就按次日 00:xx 显示，不出现 "25:10" 这种字符串。
 *
 * 不编造节次号：课程表只有 N 节，第 N+1 节不存在，所以这些行只给时间。
 */
function extendedTimeSlots(periods, from, count) {
  if (!periods.length || count <= 0) return [];
  const last = periods[periods.length - 1];
  const endMin = minutesOfDay(last.end);
  const dur = Math.max(5, minutesOfDay(last.end) - minutesOfDay(last.start));
  const fmt = (m) => {
    const v = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  };
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const s = endMin + i * dur;
    out.push({ row: from + i, start: fmt(s), end: fmt(s + dur) });
  }
  return out;
}

function gridHtml(view, uiState) {
  const periods = view.periods;
  if (!periods.length) {
    return `<div class="card"><p class="muted">还没有节次时间表，请到设置页恢复默认预设。</p></div>`;
  }
  const rowOf = new Map(periods.map((p, i) => [p.index, i]));
  const parts = [];

  parts.push(`<div class="tt-corner" style="grid-column:1;grid-row:1">节次</div>`);
  view.days.forEach((day, i) => {
    const mark = dayMarkOf(day);
    parts.push(`<div class="tt-dayname ${day.isToday ? 'is-today' : ''} ${mark.head}" style="grid-column:${
      i + 2
    };grid-row:1">
      <b>周${escapeHtml(day.shortLabel)}</b><span>${day.dayOfMonth}</span>
      ${mark.tag ? `<i class="tt-tag ${mark.tagCls}">${escapeHtml(mark.tag)}</i>` : ''}
    </div>`);
  });

  periods.forEach((p, i) => {
    parts.push(`<div class="tt-time" style="grid-column:1;grid-row:${i + 2}">
      <b>${p.index}</b><span>${escapeHtml(p.start)}</span><span>${escapeHtml(p.end)}</span>
    </div>`);
  });

  // 背景格（空白格可点 → 补课）
  view.days.forEach((day, i) => {
    periods.forEach((p, j) => {
      parts.push(
        `<div class="tt-slot ${day.isToday ? 'is-today-col' : ''} ${dayMarkOf(day).col}" style="grid-column:${
          i + 2
        };grid-row:${
          j + 2
        }" data-action="slot-tap" data-date="${day.date}" data-period="${p.index}"
          aria-label="${escapeHtml(`周${day.shortLabel} 第${p.index}节`)}"></div>`
      );
    });
  });

  // 课程块（同起点同终点的多门课合并成一个块内并列，标注冲突）
  view.days.forEach((day, i) => {
    const groups = new Map();
    for (const cls of day.classes) {
      if (cls.invalidPeriod) continue;
      const s = rowOf.get(cls.startPeriod);
      const e = rowOf.has(cls.endPeriod) ? rowOf.get(cls.endPeriod) : s;
      if (s == null) continue;
      // ★ 带具体时间的（活动）按时间比例定位：同一对节次里 08:30 与 09:00 是两个位置，
      //   不能按「第 N 节」合并成一块。
      // ★ 只有「活动」按具体时间定位：课程的 startTime 是从节次反解出来的，
      //   走时间插值只会把整节块画歪，还会打乱合并键。
      const place = cls.isEvent ? timePlacement(view.periods, cls.startTime, cls.endTime) : null;
      const key = place
        ? `t|${place.topUnits.toFixed(3)}|${place.height.toFixed(3)}`
        : `${s}|${e == null ? s : e}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cls);
    }
    for (const [key, list] of groups.entries()) {
      const timed = key.startsWith('t|');
      const place = timed ? timePlacement(view.periods, list[0].startTime, list[0].endTime) : null;
      if (timed && !place) continue;
      const [s, e] = timed ? [place.rowIndex, place.rowIndex] : key.split('|').map(Number);
      const span = Math.max(1, e - s + 1);

      const uniq = dedupeCourses(list);

      const first = uniq[0];
      const allEvents = uniq.every((c) => c.isEvent);
      const flags = [];
      if (uniq.length > 1) flags.push('冲');
      if (uniq.some((c) => c.adjustmentType === 'makeup')) flags.push('补');
      if (uniq.some((c) => c.adjustmentType === 'reschedule')) flags.push('调');
      if (uniq.some((c) => c.adjustmentType === 'roomChange')) flags.push('改');
      if (allEvents) flags.push('活');
      const flagTitle = flags
        .map((f) => ({ 冲: '冲突', 补: '补课', 调: '改时间', 改: '换教室', 活: '自己添加的活动' }[f] || f))
        .join(' / ');

      // ★ 展示用规范化课名：教务系统按教学班存成「数学分析(上) O / P」，
      //   课表上带 O/P 纯属噪音（同一个学生只会上一门）。
      const names = uniq
        .map((c) => `<span class="b-name">${escapeHtml(normalizeCourseName(c.courseName))}</span>`)
        .join('');
      const detail =
        uniq.length === 1
          ? locationHtml(first.location)
          : `<span class="b-loc">${uniq.length} 门同时段</span>`;

      // 点开的目标：纯活动 → 活动详情；否则一律进课程详情
      const actionAttr = allEvents
        ? `data-action="open-event" data-adjustment-id="${escapeHtml(first.adjustmentId)}"`
        : `data-action="open-detail" data-course-id="${escapeHtml(first.courseId)}"`;

      // 只有「单条」的块可拖动：合并块里的多门课拖到哪儿都说不清
      const dragAttr = uniq.length === 1 ? dragAttrs(first) : '';

      // ★ 带具体时间的活动：按时间比例落到行内（半格 / 跨行都行），
      //   用 align-self:start + margin-top + 显式高度，绕开 grid 只能整格对齐的限制。
      const geoStyle = timed
        ? `grid-column:${i + 2};grid-row:${place.rowIndex + 2};align-self:start;` +
          `margin-top:calc(var(--row-h) * ${place.offset.toFixed(3)});` +
          `height:calc(var(--row-h) * ${place.height.toFixed(3)} - 4px)`
        : `grid-column:${i + 2};grid-row:${s + 2}/span ${span}`;
      const tiny = timed ? place.height < 0.92 : span === 1;

      parts.push(`<button type="button" class="tt-block ${tiny ? 'is-tiny' : ''} ${
        allEvents ? 'is-event' : ''
      } ${timed ? 'is-timed' : ''}"
        style="${blockStyle(blockColor(first))}${geoStyle}"
        ${actionAttr} data-date="${day.date}"${dragAttr}
        aria-label="${escapeHtml(
          `${normalizeCourseName(first.courseName)} ${day.date}${timed ? ` ${first.startTime}-${first.endTime}` : ''}`
        )}">
        ${flags.length ? `<i class="b-flag" title="${escapeHtml(flagTitle)}">${escapeHtml(flags.join(''))}</i>` : ''}
        ${names}${detail}
      </button>`);
    }
  });

  // ★ 网格要补几行：活动结束得比最后一节课晚时，网格必须跟着长，否则块的下半截没地方放。
  //
  //   只有「起点已经超出最后一节」（rowIndex ≥ 节数）那种情况才会由 CSS Grid 自动补隐式行；
  //   更常见的是**起点还在最后一节里、高度溢出**（19:20 开始、22:30 结束）——
  //   这时 grid-row 没越界，浏览器不会多给行，块的下半截直接被裁掉。
  //   所以按最晚的 bottomUnits 算出还要补几行；这几行同时决定红线能走到哪。
  let maxBottom = periods.length;
  for (const day of view.days) {
    for (const cls of day.classes) {
      if (!cls.isEvent) continue;
      const place = timePlacement(view.periods, cls.startTime, cls.endTime);
      if (place && place.bottomUnits > maxBottom) maxBottom = place.bottomUnits;
    }
  }
  const needRows = Math.max(0, Math.ceil(maxBottom) - periods.length);

  // 现在红线（位置由 calendar.getNowMarker 给出）
  // ★ 把网格的实际行数传进去：活动把表格延长之后，红线要能继续往下走，
  //   否则它会钉在最后一节课的底边，看着像"时间没走"。
  if (view.todayIndex >= 0) {
    const marker = getNowMarker(uiState.stateRef, uiState.nowRef, periods.length + needRows);
    if (marker.visible) {
      const frac = Math.min(0.94, Math.max(0, marker.fraction));
      parts.push(`<div class="now-line" style="grid-row:${marker.rowIndex + 2};margin-top:calc(var(--row-h) * ${frac.toFixed(
        3
      )})"><span class="today-line-label">现在 ${escapeHtml(marker.hhmm)}</span></div>`);
    }
  }

  // 延长行的左侧时间刻度（刻度元素本身就是撑高网格的那几个，不需要额外空占位）
  for (const slot of extendedTimeSlots(periods, periods.length, needRows)) {
    parts.push(`<div class="tt-time is-extended" style="grid-column:1;grid-row:${slot.row + 2}"
      aria-label="${escapeHtml(`延长时段 ${slot.start} 到 ${slot.end}`)}">
      <span>${slot.start}</span><span>${slot.end}</span>
    </div>`);
  }

  return `<div class="tt-scroll"><div class="tt-grid">${parts.join('')}</div></div>`;
}

/* ---------------------------------------------------------------- 日视图 */

function dayViewHtml(view, uiState) {
  const activeDate =
    uiState.dayDate && view.days.some((d) => d.date === uiState.dayDate)
      ? uiState.dayDate
      : view.days.find((d) => d.isToday)?.date || view.monday;
  const day = view.days.find((d) => d.date === activeDate) || view.days[0];

  const picker = `<div class="chips" style="margin-bottom:10px">${view.days
    .map(
      (d) => `<button type="button" class="chip ${d.date === activeDate ? 'is-active' : ''}"
        data-action="day-pick" data-value="${d.date}">周${escapeHtml(d.shortLabel)} ${d.dayOfMonth}</button>`
    )
    .join('')}</div>`;

  // ★ G10：先判 complete，再谈"有没有课"
  if (!day.complete) {
    if (day.status === 'makeup_unconfirmed') return `${picker}${pendingCardHtml(day)}`;
    if (day.status === 'unconfigured') {
      return `${picker}${banner(
        'warn',
        `<b>${escapeHtml(day.notice || '未设置学期起始日')}</b>`,
        `<button class="btn btn-sm btn-soft" data-action="nav" data-route="#/settings">去设置</button>`
      )}`;
    }
  }

  if (day.complete && day.classes.length === 0) {
    return `${picker}${banner(
      day.status === 'holiday_silent' ? 'holiday' : 'info',
      day.status === 'holiday_silent'
        ? `<b>${escapeHtml(day.notice || '今日无课')}</b>`
        : day.status === 'makeup_skipped'
          ? `<b>${escapeHtml(day.notice || '调休上班日 · 不排课')}</b>`
          : '这一天没有安排课程 🙂'
    )}`;
  }

  const items = day.classes
    .map(
      (c) => `<div class="day-item ${c.isEvent ? 'is-event' : ''}" style="${blockStyle(blockColor(c))}"
        ${c.isEvent ? 'data-action="open-event"' : 'data-action="open-detail"'}
        ${c.isEvent ? `data-adjustment-id="${escapeHtml(c.adjustmentId)}"` : `data-course-id="${escapeHtml(c.courseId)}"`}
        data-date="${day.date}">
        <div class="d-time"><b>${escapeHtml(c.startTime || '--:--')}</b>${escapeHtml(c.endTime || '')}<br>第${c.startPeriod}${
        c.endPeriod > c.startPeriod ? `-${c.endPeriod}` : ''
      }节</div>
        <div class="d-body grow">
          <div class="d-name">${escapeHtml(normalizeCourseName(c.courseName))}</div>
          <div class="small muted">${escapeHtml(c.location || '地点待定')}${
        c.teacher ? ` · ${escapeHtml(c.teacher)}` : ''
      }</div>
          ${c.adjustmentType ? `<div style="margin-top:4px">${badge(ADJUSTMENT_LABEL[c.adjustmentType] || '已调整', 'warn')}</div>` : ''}
          ${c.conflict ? `<div style="margin-top:4px">${badge('时间冲突', 'danger')}</div>` : ''}
        </div>
      </div>`
    )
    .join('');

  return `${picker}<div class="day-list">${items}</div>`;
}

/* ---------------------------------------------------------------- 今日概览 */

/**
 * 今天的课是不是**全都上完了**。
 *
 * 不能只看「有没有下一节」：`getNextClass` 只找还没**开始**的课，所以
 * 9:00–9:45 的课在 9:20 时它也返回 null —— 那种时候说「每日委托已完成」是错的。
 * 这里按「最晚的结束时间已经过去」判断。
 *
 * 跨午夜的课（endTime 比 startTime 小）一律算没完：它真正结束是在第二天。
 */
function dayAllDone(day, now) {
  const hhmm = epochToWall(now);
  let last = '';
  for (const c of day.classes) {
    if (!c.startTime || !c.endTime) return false;
    if (c.endTime < c.startTime) return false;
    if (c.endTime > last) last = c.endTime;
  }
  return last !== '' && hhmm >= last;
}

function todayBarHtml(state, view, now) {
  if (view.todayIndex < 0) return '';
  const day = view.days[view.todayIndex];

  // ★ 未确认：绝不给"今日课数"结论（更不许说无课）
  if (!day.complete) {
    return `<div class="today-bar today-bar-pending">
      <div><div class="t-count">?</div><div class="t-label">待确认</div></div>
      <div class="grow t-next"><b>调休上班日</b><br>请先确认这天按周几的课表上课</div>
    </div>`;
  }

  if (day.status === 'holiday_silent') {
    return `<div class="today-bar today-bar-holiday">
      <div><div class="t-count">0</div><div class="t-label">今日课</div></div>
      <div class="grow t-next"><b>${escapeHtml(day.holidayName || '法定假期')}</b><br>假期静默，不发送上课提醒</div>
    </div>`;
  }

  // day.complete 为真才允许把 classes.length 当"今天有几节课"的结论
  const count = day.complete ? day.classes.length : 0;
  const next = getNextClass(state, now);
  let nextHtml = '今天没有更多课了';
  if (next.cls) {
    nextHtml = `下一节 <b>${escapeHtml(next.cls.startTime || '')}</b> ${escapeHtml(
      normalizeCourseName(next.cls.courseName)
    )}<br>
      <span class="countdown">还有 ${next.minutesLeft} 分钟</span> · ${escapeHtml(next.cls.location || '地点待定')}`;
  } else if (count === 0) {
    nextHtml = '今天没有安排课程 🙂';
  } else if (dayAllDone(day, now)) {
    // 今天的课全上完了：这里以前只写「今天没有更多课了」，读起来像被掐断，
    // 现在给一句收工的彩蛋（对北邮人来说「每日委托」比「课程」更贴切）
    nextHtml = 'bupter 你的每日委托已完成<br><span class="countdown">请自由探索世界 😊</span>';
  }
  return `<div class="today-bar">
    <div><div class="t-count">${count}</div><div class="t-label">今日课</div></div>
    <div class="grow t-next">${nextHtml}</div>
  </div>`;
}

/* ---------------------------------------------------------------- 课表主渲染 */

/**
 * @param {HTMLElement} container
 * @param {object} state
 * @param {{weekOffset:number, viewMode:'week'|'day', dayDate?:string}} uiState
 */
export function renderTimetable(container, state, uiState) {
  const view = getWeekView(state, uiState.weekOffset || 0);
  const now = Date.now();
  const localUi = { ...uiState, stateRef: state, nowRef: now };
  const today = view.todayIndex >= 0 ? view.days[view.todayIndex] : null;

  // 周次已经在切换器里，这里只留日期范围（09-28 – 10-04），避免同一信息出现两次
  const range = `${escapeHtml(view.monday.slice(5))} – ${escapeHtml(view.sunday.slice(5))}`;
  const sub = view.configured ? range : `${range} · 未配置学期`;

  const switcher = `<div class="tt-head">
    <div class="week-switch">
      <button type="button" data-action="week-prev" aria-label="上一周">${ICONS.chevronLeft}</button>
      <button type="button" class="week-label" data-action="week-pick">
        ${view.configured ? `第 ${view.weekNo} 周` : '第 ? 周'}
      </button>
      <button type="button" data-action="week-next" aria-label="下一周">${ICONS.chevronRight}</button>
      ${
        view.isCurrentWeek
          ? ''
          : `<button type="button" class="week-now" data-action="week-today">本周</button>`
      }
    </div>
    <span class="spacer"></span>
    <div class="tt-view-toggle">${segmented(
      [
        { value: 'week', label: '周' },
        { value: 'day', label: '日' }
      ],
      uiState.viewMode || 'week',
      'toggle-view'
    )}</div>
  </div>`;

  const body =
    state.sessions.length === 0
      ? emptyState(
          '还没有课表',
          '从教务系统导入课表：App 内登录抓取，或把网页课表另存后粘贴。数据只保存在这台手机上。',
          `<button type="button" class="btn btn-primary btn-block" style="margin-bottom:10px"
             data-action="nav" data-route="#/import" data-channel="jwgl">从教务系统导入</button>
           <button type="button" class="btn btn-soft btn-block" style="margin-bottom:10px"
             data-action="nav" data-route="#/import/manual" data-channel="text">粘贴课表文字</button>
           <button type="button" class="btn btn-ghost btn-block" data-action="load-sample">先看示例课表 →</button>`
        )
      : `<div class="tt-wrap ${(uiState.viewMode || 'week') === 'week' ? 'is-bleed' : ''}">${switcher}${
          (uiState.viewMode || 'week') === 'week'
            ? gridHtml(view, localUi)
            : `<div style="padding:12px">${dayViewHtml(view, uiState)}</div>`
        }</div>`;

  container.innerHTML = `${topbarHtml('课表', sub)}
    <div class="page">
      ${
        view.unconfigured
          ? dayBannersHtml(state, view.days[0])
          : today
            ? dayBannersHtml(state, today)
            : ''
      }
      ${
        uiState.samplePreview
          ? banner(
              'info',
              '<b>示例课表预览</b>：只是看看长什么样，<b>不会保存</b>，也不会改动你的任何数据。',
              '<button type="button" class="btn btn-sm btn-soft" data-action="exit-sample">退出预览</button>'
            )
          : ''
      }
      ${today && today.status === 'makeup_unconfirmed' ? pendingCardHtml(today) : ''}
      ${weekNoteHtml(view, today ? today.date : null)}
      ${state.sessions.length ? todayBarHtml(state, view, now) : ''}
      ${body}
      ${
        state.sessions.length && !uiState.samplePreview
          ? `<p class="tiny muted" style="text-align:center;margin:14px 0 0">点课程块可改课</p>`
          : ''
      }
    </div>`;
}

/* ---------------------------------------------------------------- 详情页 */

/**
 * 节次选择项（按上课时间自动分上午 / 下午 / 晚上）。
 * 导出给 main.js 的「空白格补课」复用，避免两处各拼一份。
 */
export function periodSelectOptions(state) {
  return getPeriods(state).map((p) => ({
    value: String(p.index),
    label: `第 ${p.index} 节`,
    sub: `${p.start} – ${p.end}`,
    badge: String(p.index),
    group: p.start < '12:00' ? '上午' : p.start < '18:00' ? '下午' : '晚上'
  }));
}

/** 一个节次下拉字段（隐藏 input + 选择器，表单字段名仍是 name）。 */
function periodSelect(state, id, name, label, value, link) {
  return selectField({
    id,
    name,
    label,
    title: label,
    value: value == null ? '' : String(value),
    options: periodSelectOptions(state),
    searchable: false,
    link
  });
}

function locationOptions(state) {
  const set = new Set();
  for (const s of state.sessions) if (s.location) set.add(s.location);
  for (const a of state.adjustments) if (a.location) set.add(a.location);
  return [...set].map((l) => `<option value="${escapeHtml(l)}"></option>`).join('');
}

function scopeSegmented(kind) {
  if (kind === 'makeup') return '';
  return `<div class="field">
    <span class="field-label">生效范围</span>
    ${segmented(
      [
        { value: 'once', label: '仅本次' },
        { value: 'rest', label: '该课程后续全部' }
      ],
      'once',
      'adj-scope'
    )}
    <p class="tiny muted" style="margin:6px 0 0">「后续全部」会按日生成多条单日覆盖记录，随时可逐条撤销。</p>
  </div>`;
}

/** 四个操作的表单体（sheet body）。 */
export function adjustmentFormHtml(state, kind, date) {
  if (kind === 'cancel') {
    return `${scopeSegmented(kind)}
      ${banner('info', '停课只覆盖所选日期，不会修改学期课表，可随时撤销。')}`;
  }
  if (kind === 'roomChange') {
    return `${scopeSegmented(kind)}
      <div class="field">
        <label for="adj-loc">新教室</label>
        <input class="input" id="adj-loc" name="location" list="loc-list" placeholder="如 教四-105" value="" required />
        <datalist id="loc-list">${locationOptions(state)}</datalist>
      </div>`;
  }
  if (kind === 'reschedule') {
    return `${scopeSegmented(kind)}
      ${periodSelect(state, 'adj-sp', 'startPeriod', '开始节次', 1, 'adj-ep')}
      ${periodSelect(state, 'adj-ep', 'endPeriod', '结束节次', 1)}
      <div class="field">
        <label>自定义时间（可选，优先于节次）</label>
        <div class="inline-inputs">
          <input class="input" type="time" name="startTime" aria-label="开始时间" />
          <span class="muted">—</span>
          <input class="input" type="time" name="endTime" aria-label="结束时间" />
        </div>
      </div>
      <div class="field">
        <label for="adj-loc2">教室（可选，不填则不变）</label>
        <input class="input" id="adj-loc2" name="location" list="loc-list2" placeholder="保持原教室" />
        <datalist id="loc-list2">${locationOptions(state)}</datalist>
      </div>`;
  }
  return `<div class="field">
      <label for="adj-date">补课日期</label>
      <input class="input" type="date" id="adj-date" name="date" value="${escapeHtml(date)}" required />
    </div>
    ${periodSelect(state, 'adj-sp2', 'startPeriod', '开始节次', 1, 'adj-ep2')}
    ${periodSelect(state, 'adj-ep2', 'endPeriod', '结束节次', 1)}
    <div class="field">
      <label for="adj-loc3">教室</label>
      <input class="input" id="adj-loc3" name="location" list="loc-list3" placeholder="如 教三-101" />
      <datalist id="loc-list3">${locationOptions(state)}</datalist>
    </div>
    <div class="field">
      <label for="adj-note">备注（可选）</label>
      <input class="input" id="adj-note" name="note" placeholder="如：补周四停掉的课" />
    </div>`;
}

/**
 * 提交调整：单条或批量（后续全部）。
 * @returns {{ok:boolean, errors:string[], ids:string[], message:string}}
 */
export function submitAdjustment(ctx, kind, payload) {
  const { store, state, courseId, date, sessionId } = ctx;
  const targets = [];

  if (kind === 'makeup') {
    targets.push({
      date: payload.date || date,
      type: 'makeup',
      courseId,
      startPeriod: Number(payload.startPeriod),
      endPeriod: Number(payload.endPeriod),
      location: payload.location || null,
      note: payload.note || null
    });
  } else if (payload.scope === 'rest') {
    // 后续全部：按日生成多条单日覆盖（sessions 只读，绝不改周期课表）
    const upcoming = resolveCourseDates(state, courseId).filter((d) => d.date >= date);
    const seenDates = new Set();
    for (const entry of upcoming) {
      if (seenDates.has(entry.date)) continue;
      seenDates.add(entry.date);
      targets.push({
        date: entry.date,
        type: kind,
        targetSessionId: entry.sessionId || sessionId,
        courseId,
        startPeriod: kind === 'reschedule' ? Number(payload.startPeriod) : null,
        endPeriod: kind === 'reschedule' ? Number(payload.endPeriod) : null,
        startTime: kind === 'reschedule' ? payload.startTime || null : null,
        endTime: kind === 'reschedule' ? payload.endTime || null : null,
        location: kind === 'roomChange' ? payload.location : kind === 'reschedule' ? payload.location || null : null
      });
    }
    if (!targets.length) return { ok: false, errors: ['该课程没有后续课次可调整'], ids: [], message: '' };
  } else {
    targets.push({
      date,
      type: kind,
      targetSessionId: sessionId,
      courseId,
      startPeriod: kind === 'reschedule' ? Number(payload.startPeriod) : null,
      endPeriod: kind === 'reschedule' ? Number(payload.endPeriod) : null,
      startTime: kind === 'reschedule' ? payload.startTime || null : null,
      endTime: kind === 'reschedule' ? payload.endTime || null : null,
      location: kind === 'roomChange' ? payload.location : kind === 'reschedule' ? payload.location || null : null
    });
  }

  const ids = [];
  const errors = [];
  for (const adjustment of targets) {
    const result = store.dispatch({ type: 'ADD_ADJUSTMENT', payload: { adjustment } });
    if (result.ok && result.adjustment) ids.push(result.adjustment.id);
    else errors.push(...(result.errors || ['操作失败']));
  }

  if (!ids.length) return { ok: false, errors, ids: [], message: '' };

  const label = ADJUSTMENT_LABEL[kind] || '调整';
  const message = ids.length > 1 ? `已${label} ${ids.length} 个课次` : `已${label}`;

  snackbar(`${message}。系统日历需重新导出以同步`, {
    undo: () => {
      for (const id of ids) store.dispatch({ type: 'DELETE_ADJUSTMENT', payload: { id } });
      snackbar('已撤销');
    }
  });

  return { ok: true, errors: [], ids, message };
}

/** 详情页渲染。 */
export function renderDetail(container, state, courseId, date) {
  const course = state.courses.find((c) => c.id === courseId);
  const day = resolveDay(state, date);
  const cls = day.classes.find((c) => c.courseId === courseId) || null;
  const dates = course ? resolveCourseDates(state, courseId) : [];
  const todayEntry = dates.find((d) => d.date === date) || null;
  const session = cls && cls.sessionId ? state.sessions.find((s) => s.id === cls.sessionId) : null;

  const relatedAdjustments = state.adjustments
    .filter((a) => a.courseId === courseId || (cls && a.targetSessionId === cls.sessionId))
    .sort((a, b) => a.date.localeCompare(b.date));

  const backBtn = `<button type="button" class="icon-btn" data-action="back" aria-label="返回">${ICONS.chevronLeft}</button>`;

  if (!course) {
    container.innerHTML = `${topbarHtml('课程详情', '', backBtn)}
      <div class="page">${banner('warn', '该课程不存在，可能已被重新导入覆盖。')}
      <button type="button" class="btn btn-primary btn-block" data-action="back">返回课表</button></div>`;
    return;
  }

  const label = describeDate(state, date);
  const headerSub = `${dateCn(date)} · ${label.weekday}${label.weekNo ? ` · 第 ${label.weekNo} 周` : ''}`;

  const infoRows = [];
  if (cls) {
    const periodText =
      cls.endPeriod > cls.startPeriod ? `第 ${cls.startPeriod}-${cls.endPeriod} 节` : `第 ${cls.startPeriod} 节`;
    infoRows.push(
      `<div class="list-row"><span class="muted" style="width:64px">时间</span>
        <span class="grow">${periodText} · ${escapeHtml(cls.startTime || '--:--')}–${escapeHtml(cls.endTime || '--:--')}
        ${cls.crossMidnight ? '<span class="badge badge-warn">跨零点</span>' : ''}</span></div>`
    );
    const locText =
      cls.original && cls.original.location && cls.original.location !== cls.location
        ? `<span class="muted" style="text-decoration:line-through">${escapeHtml(cls.original.location)}</span> → <b>${escapeHtml(
            cls.location || '地点待定'
          )}</b>`
        : escapeHtml(cls.location || '地点待定');
    infoRows.push(
      `<div class="list-row"><span class="muted" style="width:64px">地点</span><span class="grow">${locText}</span></div>`
    );
    infoRows.push(
      `<div class="list-row"><span class="muted" style="width:64px">教师</span><span class="grow">${escapeHtml(
        cls.teacher || '未填写'
      )}</span></div>`
    );
    const weeksText = session ? session.rawWeeksText || weeksToText(session.weeks) : todayEntry && todayEntry.status;
    infoRows.push(
      `<div class="list-row"><span class="muted" style="width:64px">周次</span><span class="grow">${escapeHtml(
        weeksText || '—'
      )}</span></div>`
    );
    if (course.note) {
      infoRows.push(
        `<div class="list-row"><span class="muted" style="width:64px">备注</span><span class="grow">${escapeHtml(
          course.note
        )}</span></div>`
      );
    }
    if (cls.adjustmentType) {
      infoRows.push(
        `<div class="list-row"><span class="muted" style="width:64px">状态</span><span class="grow">
          ${badge(ADJUSTMENT_LABEL[cls.adjustmentType] || '已调整', 'warn')}
          <span class="small muted">本节课为单日覆盖，学期周期课表未改动</span></span></div>`
      );
    }
    if (cls.conflict) {
      infoRows.push(
        `<div class="list-row"><span class="muted" style="width:64px">冲突</span><span class="grow">
          ${badge('与另一门课时间重叠', 'danger')}</span></div>`
      );
    }
  } else if (!day.complete) {
    // ★ 未确认 / 未配置：不能说"找不到这门课"，只能说"这天还没定"
    infoRows.push(
      `<div class="list-row"><span class="muted" style="width:64px">状态</span><span class="grow">${badge(
        day.status === 'makeup_unconfirmed' ? '该日课表待确认' : '学期未配置',
        'warn'
      )}</span></div>`
    );
  } else {
    const status = todayEntry ? todayEntry.status : '当天没有这门课';
    infoRows.push(
      `<div class="list-row"><span class="muted" style="width:64px">状态</span><span class="grow">${badge(
        status,
        status === '已停课' ? 'danger' : 'gray'
      )}</span></div>`
    );
  }

  const actionButtons = cls
    ? `<div class="btn-row" style="margin-bottom:8px">
         <button type="button" class="btn btn-soft" data-action="adj-open" data-kind="cancel">停课</button>
         <button type="button" class="btn btn-soft" data-action="adj-open" data-kind="reschedule">改时间</button>
       </div>
       <div class="btn-row">
         <button type="button" class="btn btn-soft" data-action="adj-open" data-kind="roomChange">改教室</button>
         <button type="button" class="btn btn-soft" data-action="adj-open" data-kind="makeup">补课</button>
       </div>`
    : `<div class="btn-row">
         <button type="button" class="btn btn-primary" data-action="adj-open" data-kind="makeup">给这门课补一节</button>
       </div>`;

  const cancelAdjustment = relatedAdjustments.find(
    (a) => a.type === 'cancel' && a.date === date && (!cls || a.targetSessionId === cls.sessionId)
  );

  const adjustmentsHtml = relatedAdjustments.length
    ? relatedAdjustments
        .map(
          (a) => `<div class="list-row">
            <div class="grow">
              <div class="lr-title">${escapeHtml(ADJUSTMENT_LABEL[a.type] || a.type)}
                <span class="small muted">· ${escapeHtml(a.date)}</span></div>
              <div class="lr-sub">${
                a.type === 'roomChange'
                  ? `教室 → ${escapeHtml(a.location || '')}`
                  : a.type === 'reschedule'
                    ? `第${a.startPeriod}-${a.endPeriod}节${a.startTime ? ` ${escapeHtml(a.startTime)}-${escapeHtml(a.endTime || '')}` : ''}`
                    : a.type === 'makeup'
                      ? `第${a.startPeriod}-${a.endPeriod}节 · ${escapeHtml(a.location || '地点待定')}`
                      : '本次停课'
              }${a.note ? ` · ${escapeHtml(a.note)}` : ''}</div>
            </div>
            <button type="button" class="btn btn-sm btn-danger" data-action="adj-delete" data-adj-id="${escapeHtml(
              a.id
            )}">撤销</button>
          </div>`
        )
        .join('')
    : `<p class="small muted" style="margin:8px 0 0">还没有调整记录。</p>`;

  const datesHtml = dates.length
    ? dates
        .map(
          (d) => `<div class="list-row">
            <div class="grow">
              <div class="lr-title">${escapeHtml(d.date)} <span class="small muted">周${
            WEEKDAY_SHORT[d.dayOfWeek] || ''
          }${d.weekNo ? ` · 第 ${d.weekNo} 周` : ''}</span></div>
              ${d.cls ? `<div class="lr-sub">${escapeHtml(d.cls.startTime || '')} · ${escapeHtml(d.cls.location || '地点待定')}</div>` : ''}
            </div>
            ${badge(d.status, d.status === '已停课' ? 'danger' : d.status === '正常' ? '' : 'warn')}
            <button type="button" class="btn btn-sm btn-ghost" data-action="open-detail"
              data-course-id="${escapeHtml(courseId)}" data-date="${d.date}">查看</button>
          </div>`
        )
        .join('')
    : `<p class="small muted" style="margin:8px 0 0">这门课还没有排到具体日期（请先配置学期起始日）。</p>`;

  container.innerHTML = `<div class="topbar">
      <div class="topbar-row">
        ${backBtn}
        <div class="grow"><h1>${escapeHtml(normalizeCourseName(course.name) || course.name)}</h1><p class="sub">${escapeHtml(headerSub)}</p></div>
      </div>
    </div>
    <div class="page">
      ${!day.complete && day.status === 'makeup_unconfirmed' ? banner('warn', `<b>该日课表待确认</b> · ${escapeHtml(day.notice || '')}`) : ''}
      ${!day.complete && day.status === 'unconfigured' ? banner('warn', `<b>${escapeHtml(day.notice || '')}</b>`) : ''}
      ${dayBannersHtml(state, day)}
      ${
        cancelAdjustment
          ? banner(
              'danger',
              '<b>本节课已停课</b>',
              `<button type="button" class="btn btn-sm btn-soft" data-action="adj-delete" data-adj-id="${escapeHtml(
                cancelAdjustment.id
              )}">撤销停课</button>`
            )
          : ''
      }
      <div class="card">
        <h2 class="card-title"><span class="dot"></span>${escapeHtml(
          normalizeCourseName(course.name) || course.name
        )}</h2>
        ${infoRows.join('')}
      </div>

      <div class="section-label">单次调整（不影响学期课表）</div>
      <div class="section">${actionButtons}</div>

      <div class="section-label">调整记录</div>
      <div class="card">${adjustmentsHtml}</div>

      <div class="section-label">这门课的全部上课日期（${dates.length} 次）</div>
      <div class="card" style="max-height:340px;overflow-y:auto">${datesHtml}</div>

      <p class="tiny muted" style="margin:14px 4px 0">
        调整后如已导出过系统日历，旧事件不会自动更新，需要重新导出 .ics。
      </p>
    </div>`;
}

/** 供 main.js 组装 sheet 时使用。 */
export function openAdjustSheet(kind, ctx, openSheet) {
  const titles = {
    cancel: '本次停课',
    reschedule: '调整上课时间',
    roomChange: '更换教室',
    makeup: '安排补课'
  };
  const state = ctx.store.getState();
  openSheet({
    title: titles[kind] || '单次调整',
    body: adjustmentFormHtml(state, kind, ctx.date),
    submitText: '确认',
    onSubmit: (formData) => {
      const payload = {
        scope: 'once',
        date: formData.get('date') || ctx.date,
        startPeriod: formData.get('startPeriod'),
        endPeriod: formData.get('endPeriod'),
        startTime: formData.get('startTime'),
        endTime: formData.get('endTime'),
        location: formData.get('location'),
        note: formData.get('note')
      };
      const scopeBtn = document.querySelector('#sheet-host .segmented [aria-selected="true"]');
      if (scopeBtn) payload.scope = scopeBtn.dataset.value || 'once';

      const result = submitAdjustment(ctx, kind, payload);
      if (!result.ok) {
        snackbar(result.errors[0] || '操作失败', { danger: true });
        return false;
      }
      return true;
    }
  });
}
