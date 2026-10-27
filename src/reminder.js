/**
 * reminder.js — 提醒点的调度与触发（混合层）。
 *
 * 【硬约束】
 *  - 纯逻辑部分（diffPlan / getReminders 转发）不碰 DOM，可 node --test 直测。
 *  - 所有浏览器 API（Notification / serviceWorker / document / window / setTimeout）
 *    只在函数体内、且经过 `typeof` 与安全上下文判断后使用 —— 这样：
 *      · Node 里 import 本文件不会抛错；
 *      · file:// 下打开不会白屏（交给 UI 显示提示条）。
 *
 * 【为什么定时器在页面而不是 SW（ARCHITECTURE §0.1 修正 1）】
 *   SW 约 30s 空闲即被浏览器终止，其中的 setTimeout 大概率不执行。
 *   因此：页面持有定时器 → 到点调 `registration.showNotification()` → 通知以 SW 身份弹出
 *   （能显示应用图标与名称，且不随页面切后台消失）。
 *
 * 【为什么只调度未来 6 小时（§C.3）】
 *  数据易变（用户中午改下午的课）、后台节流、跨零点、长定时精度差。
 *  短窗口 + 60s TICK + visibilitychange/focus 重排 + 5 分钟 catch-up，
 *  把误差控制在 60s 内，并在被杀后回到前台时补发。
 */

import { getReminders as getReminderPoints, getNowMarker } from './calendar.js';
import { todayStr } from './model.js';

export { getReminderPoints as getReminders };

/** 滚动调度窗口：6 小时。 */
export const HORIZON_MS = 6 * 3600 * 1000;
/** 回前台补发窗口：5 分钟。 */
export const CATCHUP_MS = 5 * 60 * 1000;
/** 每分钟做一次「窗口滑移 + 跨零点探测」。 */
export const TICK_MS = 60 * 1000;

/** 安全上下文（http/https/自定义 scheme）+ API 存在性判断。 */
export function isSecureContextLike() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  const loc = g.location;
  if (!loc) return false;
  const proto = loc.protocol;
  return proto === 'https:' || proto === 'http:' || proto === 'chrome-extension:';
}

/** 本环境是否支持通知 API（file:// 下通常仍是 undefined/被拒）。 */
export function notificationSupported() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  return typeof g.Notification !== 'undefined';
}

/** 当前通知权限：'granted' | 'denied' | 'default' | 'unsupported'。 */
export function permissionState() {
  if (!notificationSupported()) return 'unsupported';
  return globalThis.Notification.permission || 'default';
}

/**
 * 申请通知权限。
 * @returns {Promise<'granted'|'denied'|'default'|'unsupported'>}
 */
export async function requestPermission() {
  if (!notificationSupported()) return 'unsupported';
  const g = globalThis;
  if (g.Notification.permission === 'granted') return 'granted';
  try {
    const result = await g.Notification.requestPermission();
    return result || 'default';
  } catch (err) {
    return 'denied';
  }
}

/**
 * 计划差分：把「全部提醒点」按当前时刻切成三类。
 * @param {Array} points
 * @param {Set<string>} [firedKeys] 已触发的 key 集合
 * @param {number} [now]
 * @param {{catchUpMs?:number, horizonMs?:number}} [opts]
 * @returns {{due:Array, upcoming:Array, missed:Array}}
 *   due      → 已到点且仍在 catch-up 窗口内，应立即补发
 *   upcoming → 窗口内的未来点，应挂定时器
 *   missed   → 过期太久 / 超出窗口，丢弃（下次 replan 会重新出现）
 */
export function diffPlan(points, firedKeys, now = Date.now(), opts = {}) {
  const catchUpMs = opts.catchUpMs == null ? CATCHUP_MS : opts.catchUpMs;
  const horizonMs = opts.horizonMs == null ? HORIZON_MS : opts.horizonMs;
  const due = [];
  const upcoming = [];
  const missed = [];

  for (const p of Array.isArray(points) ? points : []) {
    if (!p || typeof p.triggerAt !== 'number') continue;
    if (firedKeys && firedKeys.has(p.key)) continue;
    const delta = p.triggerAt - now;
    if (delta < -catchUpMs) missed.push(p);
    else if (delta <= 0) due.push(p);
    else if (delta > horizonMs) missed.push(p);
    else upcoming.push(p);
  }
  return { due, upcoming, missed };
}

/** 当前 active 调度上下文（模块级，因为定时器是全局资源）。 */
let active = null;

/** 清空所有挂起的定时器。 */
export function clearTimers() {
  if (!active) return;
  for (const id of active.timers) clearTimeout(id);
  active.timers = [];
}

/**
 * 通知正文 + 选项（抽出便于测试与复用）。
 * @param {object} point ReminderPoint
 * @param {{sound?:boolean, vibrate?:boolean}} [prefs]
 */
export function buildNotificationOptions(point, prefs = {}) {
  const opts = {
    body: point.body,
    tag: point.key,
    renotify: false,
    requireInteraction: false,
    icon: './assets/icons/icon-192.png',
    badge: './assets/icons/icon-192.png',
    data: { url: `./index.html#/detail/${point.courseId}/${point.date}`, key: point.key }
  };
  if (prefs.sound === false) opts.silent = true;
  if (prefs.vibrate !== false) opts.vibrate = [120, 60, 120];
  return opts;
}

/**
 * 触发一条通知：优先走 SW 的 showNotification（页面切后台也在），否则降级 new Notification。
 * @param {object} point
 * @param {{prefs?:object, notify?:Function}} [ctx]
 * @returns {Promise<'sw'|'page'|'blocked'|'unsupported'>}
 */
export async function fireNotification(point, ctx = {}) {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  const notify = typeof ctx.notify === 'function' ? ctx.notify : () => undefined;

  if (!isSecureContextLike() || !notificationSupported()) {
    notify({ type: 'REMINDER_BLOCKED', point, reason: 'unsupported' });
    return 'unsupported';
  }
  if (g.Notification.permission !== 'granted') {
    notify({ type: 'REMINDER_BLOCKED', point, reason: 'permission' });
    return 'blocked';
  }

  const prefs = typeof ctx.prefs === 'function' ? ctx.prefs() || {} : ctx.prefs || {};
  const options = buildNotificationOptions(point, prefs);

  try {
    const sw = g.navigator && g.navigator.serviceWorker;
    const registration = sw ? await sw.getRegistration() : null;
    if (registration && typeof registration.showNotification === 'function') {
      await registration.showNotification(point.title, options);
      notify({ type: 'REMINDER_FIRED', point, via: 'sw' });
      return 'sw';
    }
  } catch (err) {
    /* 落到页面通知 */
  }

  try {
    // eslint-disable-next-line no-new
    new g.Notification(point.title, options);
    notify({ type: 'REMINDER_FIRED', point, via: 'page' });
    return 'page';
  } catch (err) {
    notify({ type: 'REMINDER_BLOCKED', point, reason: 'exception' });
    return 'blocked';
  }
}

/**
 * 重排定时器：清空 → 取未来 6h 的提醒点 → 到点的立即补发，未到点的挂 setTimeout。
 * @param {{getState:Function, notify?:Function, onReminder?:Function, prefs?:object,
 *          onPlan?:Function}} ctx
 */
export function replan(ctx) {
  if (!active) return { scheduled: 0, fired: 0 };
  clearTimers();
  const state = ctx.getState();
  const now = Date.now();
  const from = todayStr(now);
  const to = todayStr(now + HORIZON_MS);
  let points = [];
  let pendingDates = [];
  try {
    const plan = getReminderPoints(state, from, to); // ★ 返回 ReminderPlan，不是数组
    points = plan.points;
    pendingDates = plan.pendingDates;
  } catch (err) {
    points = [];
  }

  const plan = diffPlan(points, active.fired, now);
  let firedNow = 0;

  for (const p of plan.due) {
    active.fired.add(p.key);
    firedNow += 1;
    fireNotification(p, ctx).catch(() => undefined);
    if (typeof ctx.onReminder === 'function') ctx.onReminder(p);
  }

  const maxTimer = 2147483647; // setTimeout 上限（约 24.8 天），我们只挂 6h 内，安全
  for (const p of plan.upcoming) {
    const delay = Math.max(0, Math.min(maxTimer, p.triggerAt - Date.now()));
    const id = setTimeout(() => {
      if (!active || active.fired.has(p.key)) return;
      active.fired.add(p.key);
      fireNotification(p, ctx).catch(() => undefined);
      if (typeof ctx.onReminder === 'function') ctx.onReminder(p);
    }, delay);
    active.timers.push(id);
  }

  // pendingDates 不影响排程，但必须回传 UI（否则用户看不到"这天还没定"）
  if (typeof ctx.onPlan === 'function') {
    ctx.onPlan({ pendingDates, scheduled: plan.upcoming.length, fired: firedNow });
  }

  // 只保留今天与明天的去重键，避免内存无限增长
  if (active.fired.size > 500) {
    const keep = new Set(points.map((p) => p.key));
    active.fired = new Set([...active.fired].filter((k) => keep.has(k)));
  }

  return { scheduled: plan.upcoming.length, fired: firedNow };
}

/**
 * 启动调度器。所有浏览器监听器都包在能力判断内，Node / file:// 下安全空转。
 * @param {{getState:Function, notify?:Function, onReminder?:Function, onDayChange?:Function,
 *          prefs?:object, onTick?:Function}} ctx
 */
export function startScheduler(ctx) {
  stopScheduler();
  active = {
    ctx,
    timers: [],
    fired: new Set(),
    lastDate: todayStr(),
    ticker: null,
    handlers: []
  };

  replan(ctx);

  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  const doc = g.document;
  const onVisible = () => {
    if (!active) return;
    if (doc.visibilityState === 'visible') replan(ctx);
  };
  const onFocus = () => {
    if (active) replan(ctx);
  };

  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', onVisible);
    active.handlers.push(['visibilitychange', onVisible, doc]);
  }
  if (typeof g.addEventListener === 'function') {
    g.addEventListener('focus', onFocus);
    active.handlers.push(['focus', onFocus, g]);
  }

  const tick = () => {
    if (!active) return;
    const today = todayStr();
    if (today !== active.lastDate) {
      active.lastDate = today;
      active.fired = new Set(); // 跨零点：新的一天重新计
      if (typeof ctx.onDayChange === 'function') ctx.onDayChange(today);
    }
    replan(ctx);
    if (typeof ctx.onTick === 'function') {
      try {
        ctx.onTick(getNowMarker(ctx.getState()));
      } catch (err) {
        /* 忽略：仅用于 UI 刷新红线 */
      }
    }
  };
  active.ticker = setInterval(tick, TICK_MS);
  return active;
}

/** 停止调度器（清定时器 + 摘监听器）。 */
export function stopScheduler() {
  if (!active) return;
  clearTimers();
  if (active.ticker) clearInterval(active.ticker);
  for (const [type, handler, target] of active.handlers) {
    if (target && typeof target.removeEventListener === 'function') {
      target.removeEventListener(type, handler);
    }
  }
  active = null;
}

/** 调度器是否在运行。 */
export function isRunning() {
  return !!active;
}

/**
 * 补发：把 catch-up 窗口内错过的提醒立刻发出（回前台场景）。
 * @param {object} ctx
 */
export function catchUp(ctx) {
  if (!active) return 0;
  const state = ctx.getState();
  const now = Date.now();
  const plan0 = getReminderPoints(state, todayStr(now), todayStr(now));
  const plan = diffPlan(plan0.points, active.fired, now);
  let count = 0;
  for (const p of plan.due) {
    active.fired.add(p.key);
    count += 1;
    fireNotification(p, ctx).catch(() => undefined);
    if (typeof ctx.onReminder === 'function') ctx.onReminder(p);
  }
  return count;
}
