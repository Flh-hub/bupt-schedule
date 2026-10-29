/**
 * homeworkReminder.js — 作业截止提醒的「什么时候响」（纯逻辑）。
 *
 * 【边界只在这一个文件里】
 *   触发时刻的全部判断（无截止、已过期、临近截止、夜间）都收在这里，
 *   不碰 DOM、不碰原生，`node --test` 可以直接测。排程与发通知在别处。
 *
 * 【为什么锚点是「截止日前一天 20:00」而不是「截止 − 24h」】
 *   教务的截止时间九成是 23:59。减 24 小时正好落在前一天 23:59 —— 半夜响铃，
 *   第二天还要上课。固定 20:00 既在「前一天」这个语义内，又不会吵到人。
 *
 * 【为什么还要有 fallback】
 *   作业经常在今天下午才布置、明天早上截止，前一天 20:00 早就过了。
 *   这时退到「截止前 1 小时」：宁可晚一点，也不静默漏掉。
 *   若连这个点也过了（截止就在眼前），就不排 —— 列表里已经红着"今天截止"。
 */

const HOUR_MS = 3600 * 1000;

/** 默认提醒时刻：截止日前一天的 20:00。 */
export const DEFAULT_REMIND_HOUR = 20;

/** 「前一天」已过时，退到截止前的这个提前量。 */
export const DEFAULT_LEAD_MS = HOUR_MS;

/**
 * 距离现在不足这么久就不排：排完立刻响，用户会当成 bug。
 * 30 秒留给「data 刚写进 store → 800ms 防抖 → 原生排程」这条链路。
 */
export const MIN_GAP_MS = 30 * 1000;

/** 允许的提醒整点范围（0–23）。配置非法时用默认值，不抛错。 */
function normalizeHour(hour) {
  const n = Number(hour);
  if (!Number.isInteger(n) || n < 0 || n > 23) return DEFAULT_REMIND_HOUR;
  return n;
}

/**
 * 取「dueMs 所在日期的前一天」的某个整点。
 *
 * ★ 用 Date 的 setDate(-1) 而不是 `ms - 86400000`：跨月、跨年由它自己处理，
 *   也不会在有夏令时的时区被 23/25 小时的那一天带偏。
 */
export function prevDayAt(dueMs, hour = DEFAULT_REMIND_HOUR) {
  const d = new Date(dueMs);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - 1);
  d.setHours(normalizeHour(hour), 0, 0, 0);
  return d.getTime();
}

/**
 * 单项作业的提醒时刻。返回 null 表示「这条不该排」。
 *
 * @param {number} dueMs 截止时间（epoch ms）
 * @param {number} [now]
 * @param {{hour?:number, leadMs?:number, minGapMs?:number}} [opts]
 * @returns {number|null}
 */
export function remindAtFor(dueMs, now = Date.now(), opts = {}) {
  const due = Number(dueMs);
  // 无截止时间 / 脏数据：一律不排。绝不拿"抓取时间"或"今天"去凑一个出来。
  if (!Number.isFinite(due) || due <= 0) return null;
  // 已经过期：不排（也不要"补一条已过期"的提醒）
  if (due <= now) return null;

  const minGap = Number.isFinite(Number(opts.minGapMs)) ? Number(opts.minGapMs) : MIN_GAP_MS;
  const lead = Number.isFinite(Number(opts.leadMs)) ? Number(opts.leadMs) : DEFAULT_LEAD_MS;
  const hour = normalizeHour(opts.hour == null ? DEFAULT_REMIND_HOUR : opts.hour);

  let at = prevDayAt(due, hour);
  if (at == null) return null;

  // 前一天的那个整点已经过了（或近在 30 秒内）→ 退到截止前 1 小时
  if (at <= now + minGap) at = due - lead;

  // 退完还是不够远，或者退到了截止之后 → 不排
  if (at <= now + minGap) return null;
  if (at >= due) return null;
  return Math.round(at);
}

/** 截止时刻的展示串：`11-02 23:59`。 */
export function formatDue(dueMs) {
  const d = new Date(Number(dueMs));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 把整份待办列表变成提醒点。
 *
 * 产出结构沿用 calendar.getReminders 的 points 约定（`key` / `triggerAt` / `title`），
 * 额外带 `kind:'homework'` 让原生走普通通知而不是课程胶囊。
 *
 * @param {object} state
 * @param {number} [now]
 * @returns {Array<object>}
 */
export function getHomeworkReminders(state, now = Date.now()) {
  const settings = (state && state.settings) || {};
  const cfg = settings.homeworkReminder || {};
  if (cfg.enabled === false) return [];

  const items = Array.isArray(state && state.homework && state.homework.items)
    ? state.homework.items
    : [];
  const hour = cfg.hour == null ? DEFAULT_REMIND_HOUR : cfg.hour;
  const lead = Number.isFinite(Number(cfg.leadMinutes))
    ? Number(cfg.leadMinutes) * 60 * 1000
    : DEFAULT_LEAD_MS;

  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const dueMs = Number(item.dueMs);
    const at = remindAtFor(dueMs, now, { hour, leadMs: lead });
    if (at == null) continue;

    const hwId = String(item.id == null ? '' : item.id).trim();
    // ★ key 里带 at：用户在别处把截止时间改了，提醒点必须跟着变，
    //   否则旧的 key 会一直占着 fired 集合，新时刻排不进去。
    const key = `hw:${hwId || dueMs}@${at}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      key,
      kind: 'homework',
      hwId,
      triggerAt: at,
      title: String(item.title || '作业'),
      courseName: String(item.courseName || ''),
      dueMs: Math.round(dueMs),
      dueText: formatDue(dueMs)
    });
  }
  return out.sort((a, b) => a.triggerAt - b.triggerAt);
}
