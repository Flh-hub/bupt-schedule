/**
 * store.js — 状态容器：getState / subscribe / dispatch / 全量持久化。
 *
 * 【硬约束】
 *  - 只做「字段校验 + 写入 + 通知」，**不做任何业务判断**（周次/节假日/冲突都不在这里）。
 *  - **不得 import calendar.js**（避免循环依赖；UI 取派生数据时自己调 calendar.js）。
 *  - 单键全量写 localStorage['bupt_schedule_v1']，debounce 200ms；
 *    写入抛错（隐私模式 / 配额满）→ `storageBroken = true`，UI 顶部横幅提示。
 *  - `sessions` 只读：调课只 append/remove `adjustments`。
 */

import {
  DEFAULT_PERIODS,
  SCHEMA_VERSION,
  STORAGE_KEY,
  ADJUSTMENT_TYPES,
  defaultReminderSettings,
  defaultSettings,
  emptyState,
  isDateStr,
  isHhmm,
  mergeSameNameCourses,
  minutesOfDay,
  uid,
  validateState
} from './model.js';
import { buildHolidayIndex, listMakeupDays } from './holidays.js';

const HISTORY_LIMIT = 3;

/** 安全取得 localStorage（隐私模式 / Node 环境下返回 null）。 */
function defaultStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = `${STORAGE_KEY}__probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch (err) {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

/** 深拷贝（结构固定，JSON 足够）。 */
function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * 创建 store。
 * @param {{storage?: Storage|null, key?: string, now?: Function}} [options]
 */
export function createStore(options = {}) {
  const key = options.key || STORAGE_KEY;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const listeners = new Set();

  let state = emptyState();
  let storageBroken = storage == null;
  let persistTimer = null;

  /** 从存储加载（含 migrate）。 */
  function load() {
    if (!storage) {
      state = emptyState();
      storageBroken = true;
      return state;
    }
    let raw = null;
    try {
      raw = storage.getItem(key);
    } catch (err) {
      storageBroken = true;
      return state;
    }
    if (!raw) {
      state = emptyState();
      return state;
    }
    try {
      const parsed = JSON.parse(raw);
      const coursesBefore = JSON.stringify((parsed.courses || []).map((c) => (c && c.name) || ''));
      state = migrate(parsed);
      // 迁移里做了同名课程合并 → 立刻写回。否则存储里一直是 12 条、内存里 10 条，
      // 用户导出/备份时又是一堆同名课程。
      if (JSON.stringify(state.courses.map((c) => c.name || '')) !== coursesBefore) {
        try {
          storage.setItem(key, JSON.stringify(state));
        } catch (err) {
          // 写不进去也不影响本次运行：下次加载会再合并一遍（幂等）
        }
      }
    } catch (err) {
      // 数据损坏：保留一个可用的空状态，不清掉用户原始串（避免二次破坏）
      state = emptyState();
      storageBroken = true;
    }
    return state;
  }

  /**
   * 版本迁移。当前只有 v1，未知高版本直接回落空状态（并标记 storageBroken 让 UI 提示）。
   * @param {object} raw
   */
  function migrate(raw) {
    if (!raw || typeof raw !== 'object') return emptyState();
    const version = Number(raw.schemaVersion);
    if (Number.isFinite(version) && version > SCHEMA_VERSION) {
      storageBroken = true;
      return emptyState();
    }
    const base = emptyState();
    const merged = {
      ...base,
      ...raw,
      schemaVersion: SCHEMA_VERSION,
      settings: { ...base.settings, ...(raw.settings || {}) },
      courses: Array.isArray(raw.courses) ? raw.courses : [],
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      adjustments: Array.isArray(raw.adjustments) ? raw.adjustments : [],
      holidays: Array.isArray(raw.holidays) ? raw.holidays : [],
      importHistory: Array.isArray(raw.importHistory) ? raw.importHistory.slice(0, HISTORY_LIMIT) : []
    };
    merged.settings.reminder = {
      ...defaultReminderSettings(),
      ...(raw.settings && raw.settings.reminder ? raw.settings.reminder : {})
    };
    if (!Array.isArray(merged.settings.periods) || !merged.settings.periods.length) {
      merged.settings.periods = DEFAULT_PERIODS.map((p) => ({ ...p }));
    }
    // 同名课程合并（幂等）：库里的「数学分析(上) O / P / 基础名」合成一条
    return mergeSameNameCourses(merged);
  }

  /** 持久化（debounce 200ms）。 */
  function persist() {
    if (!storage) {
      storageBroken = true;
      return;
    }
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        storage.setItem(key, JSON.stringify(state));
        storageBroken = false;
      } catch (err) {
        storageBroken = true;
      }
      notify();
    }, 200);
  }

  /** 立即写入（导出备份等场景要确保数据已落盘）。 */
  function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!storage) {
      storageBroken = true;
      return false;
    }
    try {
      storage.setItem(key, JSON.stringify(state));
      storageBroken = false;
      return true;
    } catch (err) {
      storageBroken = true;
      return false;
    }
  }

  function notify() {
    for (const fn of listeners) {
      try {
        fn(state);
      } catch (err) {
        /* 订阅方异常不应影响其他订阅方 */
      }
    }
  }

  function getState() {
    return state;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => undefined;
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function isStorageBroken() {
    return storageBroken;
  }

  /* ------------------------------------------------------------ action 实现 */

  const fail = (...errors) => ({ ok: false, errors: errors.flat().filter(Boolean) });

  function touchContent() {
    state.settings.lastContentChangeAt = nowIso();
  }

  function findPeriod(index) {
    return state.settings.periods.find((p) => Number(p.index) === Number(index)) || null;
  }

  /** 节次时间递增校验：按 index 排序后，后一节开始不得早于前一节结束。 */
  function checkPeriodOrder(periods) {
    const sorted = periods.slice().sort((a, b) => a.index - b.index);
    let prevEnd = -1;
    for (const p of sorted) {
      if (!isHhmm(p.start) || !isHhmm(p.end)) return `第${p.index}节时间格式应为 HH:mm`;
      const s = minutesOfDay(p.start);
      const e = minutesOfDay(p.end);
      if (e > s && s < prevEnd) return `第${p.index}节（${p.start}）不得早于上一节结束时间（${prevEnd} 分钟位）`;
      if (e > s) prevEnd = e;
    }
    return null;
  }

  const handlers = {
    SET_SEMESTER(payload) {
      const { semesterStartMonday, totalWeeks, hasOddEvenWeek } = payload || {};
      if (semesterStartMonday != null && semesterStartMonday !== '' && !isDateStr(semesterStartMonday)) {
        return fail('学期起始日格式应为 YYYY-MM-DD');
      }
      const weeks = totalWeeks == null ? state.settings.totalWeeks : Number(totalWeeks);
      if (!Number.isInteger(weeks) || weeks < 1 || weeks > 30) return fail('总周数应为 1–30 的整数');
      state.settings.semesterStartMonday = semesterStartMonday || null;
      state.settings.totalWeeks = weeks;
      if (hasOddEvenWeek != null) state.settings.hasOddEvenWeek = !!hasOddEvenWeek;
      touchContent();
      return { ok: true, errors: [] };
    },

    SET_PERIOD(payload) {
      const { index, field, value } = payload || {};
      const period = findPeriod(index);
      if (!period) return fail('该节次不存在');
      if (!['start', 'end', 'label'].includes(field)) return fail('只有 start / end / label 可编辑');
      if (field === 'label') {
        if (!String(value || '').trim()) return fail('节次名称不能为空');
        period.label = String(value).trim();
      } else {
        if (!isHhmm(value)) return fail('时间格式应为 HH:mm');
        const draft = state.settings.periods.map((p) =>
          Number(p.index) === Number(index) ? { ...p, [field]: value, isCustom: true } : p
        );
        const orderError = checkPeriodOrder(draft);
        if (orderError) return fail(orderError);
        period[field] = value;
        period.isCustom = true;
      }
      touchContent();
      return { ok: true, errors: [] };
    },

    RESET_PERIODS() {
      state.settings.periods = DEFAULT_PERIODS.map((p) => ({ ...p }));
      touchContent();
      return { ok: true, errors: [] };
    },

    /**
     * 用教务页面自带的作息表替换节次表。
     * 场景：教务系统一天排到 14 节（19:20-20:05 / 20:10-20:55），而默认表只有 11 节，
     * 不换的话第 12-14 节的课在周视图里根本没有对应行（看起来像"导入后少了课"）。
     */
    ADOPT_PERIODS(payload) {
      const list = Array.isArray(payload && payload.periods) ? payload.periods : [];
      if (!list.length || list.length > 20) return fail('节次表长度应为 1–20');
      const draft = list.map((p, i) => ({
        index: i + 1,
        label: `第${i + 1}节`,
        start: String((p && p.start) || ''),
        end: String((p && p.end) || ''),
        isCustom: true
      }));
      const orderError = checkPeriodOrder(draft);
      if (orderError) return fail(orderError);
      state.settings.periods = draft;
      touchContent();
      return { ok: true, errors: [] };
    },

    ADD_PERIOD(payload) {
      const periods = state.settings.periods.slice().sort((a, b) => a.index - b.index);
      if (periods.length >= 20) return fail('最多支持 20 节');
      const last = periods[periods.length - 1];
      const startTime = (payload && payload.start) || (last ? last.end : '21:00');
      const endTime = (payload && payload.end) || addMinutes(startTime, 45);
      const index = periods.length + 1;
      const draft = [...periods, { index, label: `第${index}节`, start: startTime, end: endTime, isCustom: true }];
      const orderError = checkPeriodOrder(draft);
      if (orderError) return fail(orderError);
      state.settings.periods = draft;
      touchContent();
      return { ok: true, errors: [] };
    },

    DELETE_PERIOD(payload) {
      const index = Number(payload && payload.index);
      if (!findPeriod(index)) return fail('该节次不存在');
      if (state.settings.periods.length <= 1) return fail('至少要保留 1 节');
      const used = state.sessions.some(
        (s) => Number(s.startPeriod) <= index && Number(s.endPeriod) >= index
      );
      if (used) return fail('有课程正在使用该节次，删除会导致课表错位，请先调整课程');
      state.settings.periods = state.settings.periods
        .filter((p) => Number(p.index) !== index)
        .sort((a, b) => a.index - b.index)
        .map((p, i) => ({ ...p, index: i + 1, label: `第${i + 1}节` }));
      touchContent();
      return { ok: true, errors: [] };
    },

    SET_REMINDER_DEFAULTS(payload) {
      const { enabled, defaultAdvanceMinutes, channel, sound, vibrate } = payload || {};
      if (defaultAdvanceMinutes != null) {
        const adv = Number(defaultAdvanceMinutes);
        if (!Number.isInteger(adv) || adv < 0 || adv > 1440) return fail('提前量应为 0–1440 分钟');
        state.settings.reminder.defaultAdvanceMinutes = adv;
      }
      if (channel != null) {
        if (!['notification', 'ics', 'both'].includes(channel)) return fail('提醒通道取值非法');
        state.settings.reminder.channel = channel;
      }
      if (enabled != null) state.settings.reminder.enabled = !!enabled;
      if (sound != null) state.settings.reminder.sound = !!sound;
      if (vibrate != null) state.settings.reminder.vibrate = !!vibrate;
      return { ok: true, errors: [] };
    },

    UPSERT_RULE(payload) {
      const rule = payload && payload.rule;
      if (!rule || !rule.targetId) return fail('缺少目标课程');
      const adv = rule.advanceMinutes == null ? state.settings.reminder.defaultAdvanceMinutes : Number(rule.advanceMinutes);
      if (!Number.isInteger(adv) || adv < 0 || adv > 1440) return fail('提前量应为 0–1440 分钟');
      if (!state.courses.some((c) => c.id === rule.targetId)) return fail('该课程不存在');
      if (rule.channel != null && !['notification', 'ics', 'both'].includes(rule.channel)) {
        return fail('提醒通道取值非法');
      }
      const rules = state.settings.reminder.rules;
      const existingIndex = rules.findIndex((r) => r.targetId === rule.targetId && r.scope === 'course');
      const next = {
        id: rule.id || (existingIndex >= 0 ? rules[existingIndex].id : uid('r')),
        scope: 'course',
        targetId: rule.targetId,
        advanceMinutes: adv,
        channel: rule.channel || state.settings.reminder.channel,
        enabled: rule.enabled == null ? true : !!rule.enabled
      };
      if (existingIndex >= 0) rules[existingIndex] = next;
      else rules.push(next);
      return { ok: true, errors: [] };
    },

    DELETE_RULE(payload) {
      const id = payload && payload.id;
      if (!id) return fail('缺少规则 id');
      state.settings.reminder.rules = state.settings.reminder.rules.filter((r) => r.id !== id);
      return { ok: true, errors: [] };
    },

    TOGGLE_HOLIDAY_SKIP(payload) {
      const value = payload && payload.value;
      state.settings.skipOnHoliday = value == null ? !state.settings.skipOnHoliday : !!value;
      return { ok: true, errors: [] };
    },

    SET_MAKEUP_MODE(payload) {
      const mode = payload && payload.mode;
      if (!['followWeekday', 'skip'].includes(mode)) return fail('补班模式取值非法');
      state.settings.makeupWorkdayMode = mode;
      return { ok: true, errors: [] };
    },

    UPSERT_HOLIDAY(payload) {
      const holiday = payload && payload.holiday;
      if (!holiday || !isDateStr(holiday.date)) return fail('日期格式应为 YYYY-MM-DD');
      if (!['holiday', 'makeupWorkday'].includes(holiday.type)) return fail('类型应为放假 / 补班');
      let follow = null;
      if (holiday.type === 'makeupWorkday' && holiday.followDayOfWeek != null && holiday.followDayOfWeek !== '') {
        if (holiday.followDayOfWeek === 'none') follow = 'none';
        else {
          follow = Number(holiday.followDayOfWeek);
          if (!Number.isInteger(follow) || follow < 1 || follow > 7) {
            return fail("按周几上课应为 1–7，或 'none'（这天确实没课）");
          }
        }
      }
      const entry = {
        date: holiday.date,
        name: String(holiday.name || '自定义日期').trim() || '自定义日期',
        type: holiday.type,
        followDayOfWeek: follow,
        inferred: false,
        tentative: false,
        source: 'manual',
        note: holiday.note || null,
        updatedAt: nowIso()
      };
      const idx = state.holidays.findIndex((h) => h.date === entry.date);
      if (idx >= 0) state.holidays[idx] = entry;
      else state.holidays.push(entry);
      return { ok: true, errors: [] };
    },

    /**
     * 确认某个调休上班日「按周几上课」。
     * ★ 逐日写入，不做任何全局静默字段：`mode` 只决定排不排课，不豁免提示义务。
     * ★ 必须刷新 `updatedAt`：`.ics` 是否已过期的判定依赖它（确认补班日会增删整天的课次）。
     */
    SET_MAKEUP_FOLLOW(payload) {
      const { date, follow } = payload || {};
      if (!isDateStr(date)) return fail('日期格式应为 YYYY-MM-DD');
      const normalized = follow === 'none' ? 'none' : Number(follow);
      if (normalized !== 'none' && !(Number.isInteger(normalized) && normalized >= 1 && normalized <= 7)) {
        return fail("按周几上课应为 1–7，或 'none'（这天确实没课）");
      }
      const base = buildHolidayIndex(state.holidays).get(date);
      if (!base) return fail('该日期不是已有的节假日 / 调休上班日');
      if (base.type !== 'makeupWorkday') return fail('只有调休上班日才能指定按周几上课');

      const entry = {
        date,
        name: base.name,
        type: 'makeupWorkday',
        followDayOfWeek: normalized,
        inferred: false, // 用户明确指定 → 不再是推定值
        tentative: !!base.tentative,
        source: 'manual',
        dataRevision: base.dataRevision,
        note: base.note || null,
        updatedAt: nowIso()
      };
      const idx = state.holidays.findIndex((h) => h.date === date);
      if (idx >= 0) state.holidays[idx] = entry;
      else state.holidays.push(entry);
      touchContent();
      return { ok: true, errors: [] };
    },

    /**
     * 批量「全部未确认日都不上课」：把每个 `null` **逐日**写成 `'none'`。
     * ★ 刻意不提供全局静默开关——用全局开关批量掩掉"未知"等于把不知道改写成"确定没课"。
     */
    SET_MAKEUP_FOLLOW_BULK(payload) {
      const none = !!(payload && payload.none);
      if (!none) return fail('当前仅支持「全部未确认日都不上课」');
      const targets = listMakeupDays(state.holidays).filter((h) => h.followDayOfWeek == null);
      if (!targets.length) return fail('没有待确认的调休上班日');
      for (const base of targets) {
        const entry = {
          date: base.date,
          name: base.name,
          type: 'makeupWorkday',
          followDayOfWeek: 'none',
          inferred: false,
          tentative: !!base.tentative,
          source: 'manual',
          dataRevision: base.dataRevision,
          note: base.note || null,
          updatedAt: nowIso()
        };
        const idx = state.holidays.findIndex((h) => h.date === base.date);
        if (idx >= 0) state.holidays[idx] = entry;
        else state.holidays.push(entry);
      }
      touchContent();
      return { ok: true, errors: [], count: targets.length };
    },

    /**
     * 「稍后再问」：今天不再为这个补班日弹确认。
     * ★ 只记到"日期 → 那天问过"，不写任何"已确认"语义——明天仍会再问，
     *   和「全部未确认日都不上课」一样，绝不把"不知道"改写成"确定没课"。
     */
    SNOOZE_MAKEUP_PROMPT(payload) {
      const date = payload && payload.date;
      const until = payload && payload.until;
      if (!isDateStr(date)) return fail('日期格式应为 YYYY-MM-DD');
      if (!isDateStr(until)) return fail('稍后日期格式应为 YYYY-MM-DD');
      const map = state.settings.makeupPromptSnooze;
      const next = map && typeof map === 'object' ? { ...map } : {};
      next[date] = until;
      state.settings.makeupPromptSnooze = next;
      return { ok: true, errors: [] };
    },

    DELETE_HOLIDAY(payload) {
      const date = payload && payload.date;
      if (!isDateStr(date)) return fail('日期格式应为 YYYY-MM-DD');
      state.holidays = state.holidays.filter((h) => h.date !== date);
      return { ok: true, errors: [] };
    },

    IMPORT_COMMIT(payload) {
      const result = payload && payload.parseResult;
      if (!result || !Array.isArray(result.sessions)) return fail('导入数据不完整');
      if (!result.sessions.length) return fail('未解析到任何课程，已保留你原来的课表');
      const invalid = result.sessions.find(
        (s) => !Number.isInteger(s.startPeriod) || !Number.isInteger(s.endPeriod) || s.endPeriod < s.startPeriod
      );
      if (invalid) return fail('存在结束节次小于起始节次的课程，已阻止导入');

      const snapshot = {
        id: uid('imp'),
        at: nowIso(),
        count: result.sessions.length,
        snapshot: {
          courses: clone(state.courses),
          sessions: clone(state.sessions),
          adjustments: clone(state.adjustments),
          settings: {
            semesterStartMonday: state.settings.semesterStartMonday,
            totalWeeks: state.settings.totalWeeks
          }
        }
      };
      state.importHistory = [snapshot, ...state.importHistory].slice(0, HISTORY_LIMIT);

      state.courses = clone(result.courses || []);
      state.sessions = clone(result.sessions || []);
      const sessionIds = new Set(state.sessions.map((s) => s.id));
      state.adjustments = state.adjustments.filter(
        (a) => !a.targetSessionId || sessionIds.has(a.targetSessionId)
      );
      state.settings.lastImportAt = nowIso();
      touchContent();

      const validation = validateState(state);
      if (!validation.ok) return fail(validation.errors);
      return { ok: true, errors: [] };
    },

    IMPORT_ROLLBACK(payload) {
      const historyId = payload && payload.historyId;
      const entry = state.importHistory.find((h) => h.id === historyId);
      if (!entry) return fail('找不到该导入历史');
      state.courses = clone(entry.snapshot.courses);
      state.sessions = clone(entry.snapshot.sessions);
      state.adjustments = clone(entry.snapshot.adjustments);
      if (entry.snapshot.settings) {
        state.settings.semesterStartMonday = entry.snapshot.settings.semesterStartMonday;
        state.settings.totalWeeks = entry.snapshot.settings.totalWeeks;
      }
      state.importHistory = state.importHistory.filter((h) => h.id !== historyId);
      touchContent();
      return { ok: true, errors: [] };
    },

    ADD_ADJUSTMENT(payload) {
      const input = (payload && payload.adjustment) || payload || {};
      if (!isDateStr(input.date)) return fail('日期格式应为 YYYY-MM-DD');
      if (!ADJUSTMENT_TYPES.includes(input.type)) return fail('调整类型非法');

      const sessionById = new Map(state.sessions.map((s) => [s.id, s]));
      let courseId = input.courseId || null;
      const title = input.type === 'event' ? String(input.title || '').trim() : null;

      if (input.type === 'event') {
        // 自定义活动：没有课次、没有课程，只有一个名字（会议 / 社团 / 自习…）
        if (!title) return fail('活动需要一个名称');
        if (!Number.isInteger(Number(input.startPeriod)) || !Number.isInteger(Number(input.endPeriod))) {
          return fail('活动必须指明节次');
        }
        if (Number(input.endPeriod) < Number(input.startPeriod)) return fail('结束节次不得小于起始节次');
        // 活动可以额外带具体时间（表格按时间比例定位）；给了就必须自洽
        if (input.startTime != null || input.endTime != null) {
          if (!isHhmm(input.startTime) || !isHhmm(input.endTime)) return fail('活动时间格式应为 HH:mm');
          if (minutesOfDay(input.endTime) <= minutesOfDay(input.startTime)) {
            return fail('结束时间要晚于开始时间');
          }
        }
        courseId = null;
      } else if (input.type !== 'makeup') {
        if (!input.targetSessionId && !courseId) return fail('必须指明要调整的课次');
        if (input.targetSessionId) {
          const session = sessionById.get(input.targetSessionId);
          if (!session) return fail('该课次不存在，请重新进入课程详情');
          courseId = courseId || session.courseId;
        }
      } else {
        if (!courseId) return fail('补课必须指明课程');
        if (!state.courses.some((c) => c.id === courseId)) return fail('该课程不存在');
        if (!Number.isInteger(Number(input.startPeriod)) || !Number.isInteger(Number(input.endPeriod))) {
          return fail('补课必须指明节次');
        }
        if (Number(input.endPeriod) < Number(input.startPeriod)) return fail('结束节次不得小于起始节次');
      }
      if (input.startTime != null && input.startTime !== '' && !isHhmm(input.startTime)) {
        return fail('开始时间格式应为 HH:mm');
      }
      if (input.endTime != null && input.endTime !== '' && !isHhmm(input.endTime)) {
        return fail('结束时间格式应为 HH:mm');
      }
      if (input.startTime && input.endTime && minutesOfDay(input.endTime) < minutesOfDay(input.startTime)) {
        return fail('结束时间不得早于开始时间（跨零点晚课请只填节次）');
      }

      const adjustment = {
        id: uid('a'),
        date: input.date,
        type: input.type,
        targetSessionId: input.type === 'makeup' || input.type === 'event' ? null : input.targetSessionId || null,
        courseId,
        title,
        startPeriod: input.startPeriod == null ? null : Number(input.startPeriod),
        endPeriod: input.endPeriod == null ? null : Number(input.endPeriod),
        startTime: input.startTime || null,
        endTime: input.endTime || null,
        location: input.location == null ? null : String(input.location),
        note: input.note == null ? null : String(input.note),
        createdAt: nowIso()
      };
      state.adjustments.push(adjustment);
      touchContent();
      return { ok: true, errors: [], adjustment };
    },

    /**
     * 局部修改一条调整记录（拖拽改时段、撤销时回滚都用它）。
     * 只允许改「位置类」字段：date / startPeriod / endPeriod / location / note / title。
     * 类型和目标课次不可改——那等于换了一条记录，应该删了重建。
     */
    UPDATE_ADJUSTMENT(payload) {
      const { id, patch } = payload || {};
      const target = state.adjustments.find((a) => a.id === id);
      if (!target) return fail('该调整记录不存在');
      const next = { ...target };

      if (patch && patch.date != null) {
        if (!isDateStr(patch.date)) return fail('日期格式应为 YYYY-MM-DD');
        next.date = patch.date;
      }
      if (patch && patch.startPeriod != null) {
        if (!Number.isInteger(Number(patch.startPeriod))) return fail('节次必须是整数');
        next.startPeriod = Number(patch.startPeriod);
      }
      if (patch && patch.endPeriod != null) {
        if (!Number.isInteger(Number(patch.endPeriod))) return fail('节次必须是整数');
        next.endPeriod = Number(patch.endPeriod);
      }
      if (patch && (patch.startTime !== undefined || patch.endTime !== undefined)) {
        const st = patch.startTime === undefined ? next.startTime : patch.startTime;
        const et = patch.endTime === undefined ? next.endTime : patch.endTime;
        if (st == null && et == null) {
          next.startTime = null;
          next.endTime = null;
        } else {
          if (!isHhmm(st) || !isHhmm(et)) return fail('活动时间格式应为 HH:mm');
          if (minutesOfDay(et) <= minutesOfDay(st)) return fail('结束时间要晚于开始时间');
          next.startTime = st;
          next.endTime = et;
        }
      }
      if (patch && patch.location !== undefined) {
        next.location = patch.location == null || patch.location === '' ? null : String(patch.location);
      }
      if (patch && patch.note !== undefined) {
        next.note = patch.note == null || patch.note === '' ? null : String(patch.note);
      }
      if (patch && patch.title !== undefined && target.type === 'event') {
        const title = String(patch.title || '').trim();
        if (!title) return fail('活动需要一个名称');
        next.title = title.slice(0, 60);
      }
      if (Number.isInteger(next.startPeriod) && Number.isInteger(next.endPeriod)) {
        if (next.endPeriod < next.startPeriod) return fail('结束节次不得小于起始节次');
      }

      Object.assign(target, next);
      touchContent();
      return { ok: true, errors: [] };
    },

    DELETE_ADJUSTMENT(payload) {
      const id = payload && payload.id;
      if (!id) return fail('缺少调整记录 id');
      const before = state.adjustments.length;
      state.adjustments = state.adjustments.filter((a) => a.id !== id);
      if (state.adjustments.length === before) return fail('该调整记录不存在');
      touchContent();
      return { ok: true, errors: [] };
    },

    UPDATE_COURSE(payload) {
      const { id, patch } = payload || {};
      const course = state.courses.find((c) => c.id === id);
      if (!course) return fail('该课程不存在');
      if (patch && patch.name != null) {
        const name = String(patch.name).trim();
        if (!name) return fail('课程名不能为空');
        course.name = name.slice(0, 60);
      }
      if (patch && patch.color != null) {
        if (patch.color && !/^#[0-9a-fA-F]{6}$/.test(patch.color)) return fail('颜色应为 #RRGGBB');
        course.color = patch.color || null;
      }
      if (patch && patch.note !== undefined) course.note = patch.note ? String(patch.note) : null;
      if (patch && patch.teacher !== undefined) course.teacher = patch.teacher ? String(patch.teacher) : null;
      course.updatedAt = nowIso();
      touchContent();
      return { ok: true, errors: [] };
    },

    EXPORT_BACKUP() {
      flush();
      const data = JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION,
          exportedAt: nowIso(),
          settings: state.settings,
          courses: state.courses,
          sessions: state.sessions,
          adjustments: state.adjustments,
          holidays: state.holidays
        },
        null,
        2
      );
      state.settings.lastBackupAt = nowIso();
      persist();
      return { ok: true, errors: [], data };
    },

    RESTORE_BACKUP(payload) {
      const { payload: rawPayload, mode } = payload || {};
      let data = rawPayload;
      if (typeof rawPayload === 'string') {
        try {
          data = JSON.parse(rawPayload);
        } catch (err) {
          return fail('备份内容不是合法 JSON');
        }
      }
      if (!data || typeof data !== 'object') return fail('备份内容为空');
      const version = Number(data.schemaVersion);
      if (Number.isFinite(version) && version > SCHEMA_VERSION) {
        return fail(`数据版本 ${version}，当前支持 ${SCHEMA_VERSION}`);
      }

      if (mode === 'merge') {
        const courseMap = new Map(state.courses.map((c) => [c.name, c]));
        const incomingCourses = Array.isArray(data.courses) ? data.courses : [];
        const idRemap = new Map();
        for (const c of incomingCourses) {
          if (!c || !c.name) continue;
          const existing = courseMap.get(c.name);
          if (existing) {
            idRemap.set(c.id, existing.id);
          } else {
            const fresh = { ...c, id: uid('c'), createdAt: nowIso(), updatedAt: nowIso() };
            idRemap.set(c.id, fresh.id);
            state.courses.push(fresh);
            courseMap.set(fresh.name, fresh);
          }
        }
        const existingSessionKeys = new Set(
          state.sessions.map(
            (s) => `${s.courseId}|${s.dayOfWeek}|${s.startPeriod}-${s.endPeriod}|${s.weeks.start}-${s.weeks.end}|${s.weeks.type}`
          )
        );
        for (const s of Array.isArray(data.sessions) ? data.sessions : []) {
          const courseId = idRemap.get(s.courseId) || s.courseId;
          if (!courseId) continue;
          const key = `${courseId}|${s.dayOfWeek}|${s.startPeriod}-${s.endPeriod}|${(s.weeks || {}).start}-${(s.weeks || {}).end}|${(s.weeks || {}).type}`;
          if (existingSessionKeys.has(key)) continue;
          existingSessionKeys.add(key);
          state.sessions.push({ ...s, id: uid('s'), courseId });
        }
        if (Array.isArray(data.adjustments)) {
          const existingAdj = new Set(state.adjustments.map((a) => `${a.date}|${a.type}|${a.targetSessionId}|${a.courseId}`));
          for (const a of data.adjustments) {
            const key = `${a.date}|${a.type}|${a.targetSessionId}|${a.courseId}`;
            if (existingAdj.has(key)) continue;
            existingAdj.add(key);
            state.adjustments.push({ ...a, id: uid('a') });
          }
        }
        if (Array.isArray(data.holidays)) {
          const existingDates = new Set(state.holidays.map((h) => h.date));
          for (const h of data.holidays) {
            if (!h || !isDateStr(h.date) || existingDates.has(h.date)) continue;
            state.holidays.push({ ...h, source: 'manual' });
          }
        }
        touchContent();
        return { ok: true, errors: [] };
      }

      // overwrite
      const next = {
        ...emptyState(),
        settings: { ...defaultSettings(), ...(data.settings || {}) },
        courses: clone(data.courses || []),
        sessions: clone(data.sessions || []),
        adjustments: clone(data.adjustments || []),
        holidays: clone(data.holidays || []),
        importHistory: state.importHistory
      };
      next.settings.reminder = {
        ...defaultReminderSettings(),
        ...((data.settings && data.settings.reminder) || {})
      };
      if (!Array.isArray(next.settings.periods) || !next.settings.periods.length) {
        next.settings.periods = DEFAULT_PERIODS.map((p) => ({ ...p }));
      }
      const validation = validateState(next);
      if (!validation.ok) return fail(validation.errors);
      state = next;
      touchContent();
      return { ok: true, errors: [] };
    },

    CLEAR_ALL() {
      const history = state.importHistory;
      state = emptyState();
      state.importHistory = history;
      return { ok: true, errors: [] };
    }
  };

  /**
   * 派发 action。
   * @param {{type:string}} action
   * @returns {{ok:boolean, errors:string[], data?:string, adjustment?:object}}
   */
  function dispatch(action) {
    if (!action || typeof action.type !== 'string') return fail('action 必须包含 type');
    const handler = handlers[action.type];
    if (!handler) return fail(`未知的 action：${action.type}`);

    const result = handler(action.payload || {}) || { ok: true, errors: [] };
    if (!result.ok) return result;

    // 导入/改课之后也可能重新出现同名的多条课程，这里再合并一次（幂等）
    state = mergeSameNameCourses(state);

    persist();
    notify();
    return result;
  }

  // 初始化
  load();
  if (storageBroken && !storage) {
    // 内存兜底：不阻塞功能，仅提示
  }

  return {
    getState,
    subscribe,
    dispatch,
    persist,
    flush,
    migrate,
    reload: load,
    isStorageBroken,
    /** 供测试注入：替换整个 state（不落库）。 */
    __setState(next) {
      state = next;
      notify();
    }
  };
}

/** HH:mm + n 分钟。 */
function addMinutes(hhmm, n) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const total = (h * 60 + m + n + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export default createStore;
