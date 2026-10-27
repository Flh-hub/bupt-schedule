/**
 * diff.js — 课表差异比对（纯逻辑，无 DOM / 无网络）。
 *
 * 【为什么需要】「更新课程表」要能回答一句话：这次抓取跟本地比，**到底变了什么**？
 * 直接把新课表盖上去最省事，但用户根本不知道自己被改了什么——尤其教务调课/换教室这种小事。
 *
 * 比对以**课程名**为锚（教务每次抓取的内部 id 都会变，不能用作 key）：
 *   - 新课表有、本地没有 → 新增
 *   - 本地有、新课表没有 → 删除
 *   - 都有 → 逐项比 时间（星期+节次）/ 地点 / 周次，列出变了哪几项
 *
 * 输出里不带任何 HTML，文案由 UI 自己拼。
 */

import { expandWeeks } from './model.js';

const DAY_LABEL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 课程名归一化：去空白、全角空格，用于跨次抓取匹配。 */
export function normalizeName(name) {
  return String(name == null ? '' : name)
    .replace(/[\s\u3000]+/g, '')
    .trim();
}

/** 节次文本：`第 1-2 节` / `第 3 节`。 */
export function periodText(start, end) {
  const a = Number(start) || 0;
  const b = Number(end) || 0;
  if (!a) return '节次未知';
  return b && b !== a ? `第 ${a}-${b} 节` : `第 ${a} 节`;
}

/** 周次列表 → 稳定字符串（用于比较；展示仍用 rawWeeksText）。 */
function weeksKeyOf(session) {
  try {
    const list = expandWeeks(session && session.weeks);
    return Array.isArray(list) ? list.join(',') : '';
  } catch (err) {
    return '';
  }
}

/**
 * 把「课程 + 课次」聚合成 { name → { meetings } }。
 * 同一门课的多个时间段保持有序，便于稳定比较。
 */
export function indexByName(courses, sessions) {
  const byId = new Map();
  const out = new Map();
  for (const c of Array.isArray(courses) ? courses : []) {
    byId.set(c.id, normalizeName(c.name));
    if (!out.has(normalizeName(c.name))) {
      out.set(normalizeName(c.name), { name: String(c.name || '').trim(), teacher: c.teacher || '', meetings: [] });
    }
  }
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const name = byId.get(s.courseId);
    if (!name) continue;
    const item = out.get(name);
    if (!item) continue;
    item.meetings.push({
      day: Number(s.dayOfWeek) || 0,
      start: Number(s.startPeriod) || 0,
      end: Number(s.endPeriod) || 0,
      location: String(s.location || '').trim(),
      weeksKey: weeksKeyOf(s),
      weeksText: String(s.rawWeeksText || '').trim()
    });
  }
  for (const [key, item] of [...out]) {
    if (!item.meetings.length) {
      out.delete(key); // 没有课次的课程不进索引：否则会凭空多出"被删除"的幽灵条目
      continue;
    }
    item.meetings.sort((a, b) => a.day - b.day || a.start - b.start || a.end - b.end);
  }
  return out;
}

/** 时段签名（星期 + 节次），用来判断「上课时间」有没有变。 */
function slotKeys(meetings) {
  return meetings.map((m) => `${m.day}-${m.start}-${m.end}`).sort();
}

/** 地点集合（忽略空地点）。 */
function locationSet(meetings) {
  return [...new Set(meetings.map((m) => m.location).filter(Boolean))].sort();
}

/** 每个时段的周次签名，形如 `3-1-2=1,2,3...`。 */
function weeksByTitle(meetings) {
  const map = new Map();
  for (const m of meetings) map.set(`${m.day}-${m.start}-${m.end}`, m.weeksKey);
  return map;
}

function sameArray(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 周次是否变化：**只比两侧都存在的时段**。
 * 否则「上课时间从第 1-2 节挪到 3-4 节」会顺带把周次也报成变更（键都变了），
 * 用户看到一条课程同时标「时间 / 周次」会以为改了两件事。
 */
function weeksChangedBetween(prev, next) {
  const a = weeksByTitle(prev.meetings);
  const b = weeksByTitle(next.meetings);
  for (const [key, value] of a) {
    if (b.has(key) && b.get(key) !== value) return true;
  }
  return false;
}

/** 展示用：把 meetings 变成「周三 第 1-2 节 · 教三-101」这样的行。 */
export function meetingLines(meetings) {
  return (Array.isArray(meetings) ? meetings : []).map((m) => ({
    day: DAY_LABEL[m.day] || '周?',
    period: periodText(m.start, m.end),
    location: m.location || '',
    weeks: m.weeksText || ''
  }));
}

/**
 * 比对本地课表与刚抓到的草稿。
 *
 * @param {{courses?:Array, sessions?:Array}} state 本地状态（store.getState()）
 * @param {{courses?:Array, sessions?:Array}} draft 抓取草稿
 * @returns {{added:Array, removed:Array, changed:Array, unchanged:number,
 *            hasChanges:boolean, summary:{added:number,removed:number,changed:number,total:number}}}
 */
export function diffTimetables(state, draft) {
  const before = indexByName(state && state.courses, state && state.sessions);
  const after = indexByName(draft && draft.courses, draft && draft.sessions);

  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;

  for (const [name, next] of after) {
    const prev = before.get(name);
    if (!prev) {
      added.push({ name: next.name, teacher: next.teacher, meetings: next.meetings });
      continue;
    }

    const fields = [];
    if (!sameArray(slotKeys(prev.meetings), slotKeys(next.meetings))) fields.push('时间');
    if (!sameArray(locationSet(prev.meetings), locationSet(next.meetings))) fields.push('地点');
    if (weeksChangedBetween(prev, next)) fields.push('周次');

    if (!fields.length) {
      unchanged += 1;
      continue;
    }
    changed.push({
      name: next.name,
      fields,
      before: { meetings: prev.meetings, teacher: prev.teacher },
      after: { meetings: next.meetings, teacher: next.teacher }
    });
  }

  for (const [name, prev] of before) {
    if (!after.has(name)) removed.push({ name: prev.name, teacher: prev.teacher, meetings: prev.meetings });
  }

  const summary = { added: added.length, removed: removed.length, changed: changed.length, total: after.size };
  return {
    added,
    removed,
    changed,
    unchanged,
    hasChanges: summary.added + summary.removed + summary.changed > 0,
    summary
  };
}
