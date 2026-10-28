/**
 * native.js — Android 壳（`android/`）与网页层之间**唯一的**桥。
 *
 * 【纪律】
 *  - 本文件不做任何日期 / 周次 / 节假日判断：抓取回来的 HTML 一律交给 parsers 解析。
 *  - 原生侧只负责「打开教务系统 → 用户自己登录 → 把课表页 HTML 带回来」，
 *    不接收、不保存、不转发账号密码（密码只进学校页面自己的表单）。
 *  - 浏览器里打开时本文件全部是空操作，PWA 行为不变。
 */

import { parseHtml } from './parsers/index.js';
import { resolveSemester } from './semesters.js';
import { normalizeCourseName, todayStr } from './model.js';

/** 单次抓取最多塞进 textarea 的字符数（再大就只留解析结果，避免输入框卡顿）。 */
export const TEXTAREA_LIMIT = 200000;

/** 原生注入的对象（Android WebView.addJavascriptInterface）。 */
export function nativeBridge() {
  const b = typeof window === 'undefined' ? null : window.BuptNative;
  return b && typeof b === 'object' ? b : null;
}

/** 是否跑在 Android 壳里。 */
export function isNativeApp() {
  return nativeBridge() !== null;
}

/** 原生信息（平台 / 版本 / SDK）。 */
export function nativeInfo() {
  const b = nativeBridge();
  if (!b || typeof b.getInfo !== 'function') return {};
  try {
    return JSON.parse(String(b.getInfo() || '{}')) || {};
  } catch (err) {
    return {};
  }
}

/** 打开 App 内的教务系统 WebView（登录 + 抓取）。返回是否已交给原生。 */
export function openJwglCapture() {
  const b = nativeBridge();
  if (!b || typeof b.openJwgl !== 'function') return false;
  try {
    b.openJwgl();
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 从原生抓取的候选 HTML 里挑出第一份**能解析出课次**的。纯函数，Node 可直接测。
 *
 * 为什么要候选列表：教务系统不同版本（强智 jsxsd 各校定制）课表可能在不同 table，
 * 甚至藏在 frameset 的子 frame 里。原生侧按「像课表的程度」排序后整批带回来，
 * 这里逐份试解析，谁的 sessions 非空就用谁——比猜一个选择器稳。
 *
 * @param {Array<{label?:string,html:string}>} candidates
 * @param {{totalWeeks?:number, periods?:Array}} [opts]
 * @returns {{draft:object|null, html:string, label:string}}
 */
export function pickCaptureDraft(candidates, opts = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(
    (c) => c && typeof c.html === 'string' && c.html.trim()
  );
  const base = { totalWeeks: opts.totalWeeks, periods: opts.periods };
  const today = opts.today || todayStr();
  let firstFail = null;

  for (const c of list) {
    const forced = parseHtml(c.html, { ...base, source: 'jwgl', forceSource: true });
    if (forced.sessions.length) {
      return {
        draft: withSemester(forced, c.html, today),
        html: c.html,
        label: c.label || ''
      };
    }
    if (!firstFail) firstFail = forced;

    const auto = parseHtml(c.html, { ...base, source: 'auto' });
    if (auto.sessions.length) {
      return { draft: withSemester(auto, c.html, today), html: c.html, label: c.label || '' };
    }
  }

  return {
    draft: firstFail ? withSemester(firstFail, list.length ? list[0].html : '', today) : firstFail,
    html: list.length ? list[0].html : '',
    label: ''
  };
}

/**
 * 给草稿挂上学期的识别结果（学期代码 → 内置校历 → 第 1 周周一）。
 * 挂成 `draft.semester`，导入时由 ui/import.js 决定要不要落到 settings。
 */
function withSemester(draft, html, today) {
  if (!draft) return draft;
  try {
    const sem = resolveSemester(String(html || ''), today);
    if (sem && (sem.code || sem.firstMonday)) draft.semester = sem;
  } catch (err) {
    /* 识别失败不影响导入本身 */
  }
  return draft;
}

/** base64 → UTF-8 文本（原生侧用 base64 传 JSON，绕开引号 / 换行转义炸点）。 */
export function decodePayload(b64) {
  const bin = atob(String(b64 == null ? '' : b64));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 注册原生回调。handler(payload) 由 main.js 提供：
 * payload = { url, title, at, candidates:[{label, html}] }
 */
export function installNativeBridge(handler) {
  if (!isNativeApp()) return false;
  window.__buptNativeImportPayload = (b64) => {
    let payload = null;
    try {
      payload = JSON.parse(decodePayload(b64));
    } catch (err) {
      return;
    }
    try {
      handler(payload);
    } catch (err) {
      /* 回调异常不能抛回原生，否则 WebView 会静默吞掉 */
    }
  };
  document.documentElement.classList.add('is-native-app');
  return true;
}

/* ---------------------------------------------------------------- 原生通知 */

/** 安卓壳里是否有原生通知能力（浏览器里一律 false）。 */
export function notifySupport() {
  const b = nativeBridge();
  return !!(b && typeof b.scheduleReminders === 'function');
}

/** 原生通知权限：'granted' | 'denied' | 'default' | 'unsupported'。 */
export function notifyPermission() {
  const b = nativeBridge();
  if (!b || typeof b.getNotifyPermission !== 'function') return 'unsupported';
  try {
    const value = String(b.getNotifyPermission() || 'default');
    return ['granted', 'denied', 'default'].includes(value) ? value : 'default';
  } catch (err) {
    return 'unsupported';
  }
}

/** 拉起系统权限弹窗（Android 13+）。 */
export function requestNotifyPermission() {
  const b = nativeBridge();
  if (!b || typeof b.requestNotifyPermission !== 'function') return false;
  try {
    b.requestNotifyPermission();
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 问一次「后台运行模式」（原生 AlertDialog）。
 *
 * 【为什么时机由 JS 决定】
 * 原生以前是启动后自己 postDelayed 1.2 秒弹。加了隐私说明之后，这个原生框会
 * 正好压在第一屏的隐私弹层上，真机上就是两层框叠在一起，点哪个都不对。
 * 所以原生不再自己弹，改成由页面在「隐私说明处理完」之后调这一下。
 * 原生侧带 `askedBefore` 标记，重复调用不会重复打扰。
 */
export function askBackground() {
  const b = nativeBridge();
  if (!b || typeof b.askBackground !== 'function') return false;
  try {
    b.askBackground();
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 提醒点 → 原生闹钟列表。**纯函数**，Node 可直接测。
 *
 * 只取「未来 horizonDays 天内、还没到点」的点：原生排程要跨过 App 被杀，
 * 但不能把整个学期几千条都丢给 AlarmManager（系统对每个 App 的闹钟数有限制）。
 *
 * 发给原生的四件事，各有明确用途，不要合并：
 *  - `title`   课程名 → 通知标题（流体云胶囊展开后的主标题）
 *  - `periods` 「第3-4节」→ 通知正文
 *  - `at`      提醒时刻 → 闹钟触发点
 *  - `startEpoch` 上课时刻 → 系统倒计时的终点，也是「到点自动收起」的闹钟点。
 *    它由 `at + 提前分钟数` 反推，不另算日期，避免两套时间线对不上。
 *
 * 刻意不发地点：胶囊只有一行字，地点放进去必然被截断，截图里用户也明确不需要。
 *
 * 刻意不发「胶囊文案」：折叠态只显示剩余时间（用户明确要的这个，不要课程名），
 * 而剩余时间依赖**发通知那一刻**的时钟，这里排程时算出来的必然是错的。
 *
 * @param {Array} points calendar.getReminders() 的 points
 * @param {number} [now] epoch ms
 * @param {number} [horizonDays]
 * @returns {Array<{id:string, at:number, title:string, periods:string, startEpoch:number}>}
 */
export function buildNativeAlarms(points, now = Date.now(), horizonDays = 7) {
  const list = Array.isArray(points) ? points : [];
  const until = now + Math.max(1, Number(horizonDays) || 7) * 86400000;
  const out = [];
  const seen = new Set();
  for (const p of list) {
    const at = Number(p && p.triggerAt);
    if (!Number.isFinite(at) || at <= now + 1000 || at > until) continue;
    const raw = String((p && p.key) || at);
    const id = raw.length > 80 ? raw.slice(0, 80) : raw;
    if (seen.has(id)) continue;
    seen.add(id);
    const periods = String((p && p.periodText) || '');
    const advance = Number(p && p.advanceMinutes);
    const startEpoch = Number.isFinite(advance) ? Math.round(at + advance * 60000) : 0;
    // 活动没有课程名时退回「即将开始」，与 calendar.getReminders 的 title 一致
    // ★ 通知标题也用规范化课名：锁屏上是「数学分析(上)」，不该带教学班的 O/P 尾巴
    const title = normalizeCourseName(
      String((p && p.courseName) || (p && p.title) || '即将上课')
    );
    out.push({
      id,
      at: Math.round(at),
      title,
      periods,
      startEpoch,
      // 老壳只认 body；留着它，装回旧 APK 时通知内容也不会退化成空白
      body: periods
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 把提醒点交给原生排程（返回实际排了几条）。 */
export function scheduleReminders(points, opts = {}) {
  const b = nativeBridge();
  if (!b || typeof b.scheduleReminders !== 'function') return 0;
  const list = buildNativeAlarms(points, opts.now == null ? Date.now() : opts.now, opts.horizonDays || 7);
  try {
    b.scheduleReminders(JSON.stringify(list));
  } catch (err) {
    return 0;
  }
  return list.length;
}

/* ---------------------------------------------------------------- 桌面小组件 */

/**
 * 安卓壳里是否有桌面小组件能力（浏览器里一律 false）。
 *
 * 注意它与 {@link notifySupport} **不是**同一件事：用户可能装了 1.16.0 之前的壳，
 * 那时有通知但没小组件。两者必须各自判断，不能共用一个开关。
 */
export function widgetSupport() {
  const b = nativeBridge();
  return !!(b && typeof b.syncWidget === 'function');
}

/**
 * 把小组件数据交给原生存盘 + 重绘。
 *
 * payload 必须来自 `widget.buildWidgetPayload()`——这里刻意不做任何加工，
 * 免得"某个字段在这里被顺手改掉"导致线上和单测跑的不是同一份逻辑。
 *
 * @param {object} payload
 * @returns {boolean} 是否已交给原生
 */
export function syncWidget(payload) {
  const b = nativeBridge();
  if (!b || typeof b.syncWidget !== 'function') return false;
  if (!payload || !Array.isArray(payload.days)) return false;
  try {
    b.syncWidget(JSON.stringify(payload));
    return true;
  } catch (err) {
    return false;
  }
}

/* ---------------------------------------------------------------- 凭证（更新课表用） */

/**
 * 保存学号密码。**只在原生侧加密落盘**（Android Keystore AES/GCM + SharedPreferences），
 * 网页层（localStorage）里永远没有明文，也读不回来。
 * @returns {boolean} 是否保存成功
 */
export function credSave(account, password) {
  const b = nativeBridge();
  if (!b || typeof b.saveCredentials !== 'function') return false;
  try {
    return !!b.saveCredentials(String(account || ''), String(password || ''));
  } catch (err) {
    return false;
  }
}

export function credHas() {
  const b = nativeBridge();
  if (!b || typeof b.hasCredentials !== 'function') return false;
  try {
    return !!b.hasCredentials();
  } catch (err) {
    return false;
  }
}

/** 已保存的学号（只用于界面回显；密码不会回传）。 */
export function credAccount() {
  const b = nativeBridge();
  if (!b || typeof b.credentialsAccount !== 'function') return '';
  try {
    return String(b.credentialsAccount() || '');
  } catch (err) {
    return '';
  }
}

export function credClear() {
  const b = nativeBridge();
  if (!b || typeof b.clearCredentials !== 'function') return false;
  try {
    b.clearCredentials();
    return true;
  } catch (err) {
    return false;
  }
}

/** 触发「自动登录 + 抓取」；结果通过 __buptUpdatePayload / __buptAutoCaptureError 回到网页。 */
export function autoCapture() {
  const b = nativeBridge();
  if (!b || typeof b.autoCapture !== 'function') return false;
  try {
    b.autoCapture();
    return true;
  } catch (err) {
    return false;
  }
}

/* ---------------------------------------------------------------- 后台自动抓取（1.15.0） */

/**
 * 壳里是否有"后台自动抓取"能力（1.15.0 起）。
 *
 * 老版本壳只有 {@link autoCapture}（会跳一个看得见的登录窗口），
 * 网页据此决定主按钮走哪条路，而不是硬点一个不存在的方法。
 */
export function grabSupported() {
  const b = nativeBridge();
  return !!(b && typeof b.startGrab === 'function');
}

/** 任务号：由**网页**生成，原生原样带回，用来丢弃上一次抓取迟到的事件。 */
export function newGrabId(now = Date.now()) {
  return 'g' + now + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * 开始后台抓取。
 *
 * `password` 传空串表示「用已保存的那份」——原生会从 Android Keystore 里取，
 * 网页层永远拿不到明文，也就不存在"密码在 JS 里停留"的时间窗。
 *
 * @returns {boolean} 是否已把任务交给原生（失败原因会异步回到 __buptGrabEvent）
 */
export function startGrab(id, account, password) {
  const b = nativeBridge();
  if (!b || typeof b.startGrab !== 'function') return false;
  try {
    b.startGrab(String(id || ''), String(account || ''), String(password || ''));
    return true;
  } catch (err) {
    return false;
  }
}

/** 取消正在跑的抓取（原生会回一个 cancelled 终态）。 */
export function cancelGrab() {
  const b = nativeBridge();
  if (!b || typeof b.cancelGrab !== 'function') return false;
  try {
    b.cancelGrab();
    return true;
  } catch (err) {
    return false;
  }
}

/** 原生侧是否还有抓取在跑（页面刷新回来时用来恢复进度显示）。 */
export function grabRunning() {
  const b = nativeBridge();
  if (!b || typeof b.grabRunning !== 'function') return false;
  try {
    return !!b.grabRunning();
  } catch (err) {
    return false;
  }
}

/**
 * 注册抓取事件回调。
 *
 * 原生注入的进度/失败是**对象字面量**（JSONObject.toString 拼进 JS），不是字符串，
 * 这里两种都接；结果走 base64（几 MB 的 HTML 直接拼字符串必炸）。
 *
 * @param {{onEvent?:Function, onResult?:Function}} handlers
 *   onEvent({type:'progress'|'error', id, step?, percent?, text?, code?, detail?})
 *   onResult(id, payload) — payload 已解码成对象
 */
/**
 * 作业抓取的事件桥。原生通过 `window.__buptHomeworkEvent(json)` 推事件：
 *   { type:'progress', text } / { type:'result', json } / { type:'error', code }
 *
 * 和课表抓取分开是因为两者生命周期不同：课表抓完要进「变更确认」，
 * 作业抓完直接落缓存，不需要审批流程。
 */
export function installHomeworkBridge(handlers = {}) {
  if (!isNativeApp()) return false;
  const onEvent = typeof handlers.onEvent === 'function' ? handlers.onEvent : null;
  window.__buptHomeworkEvent = (raw) => {
    let evt = null;
    try {
      evt = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      return;
    }
    if (!evt || typeof evt !== 'object') return;
    // 回调异常不能抛回原生，否则 WebView 会静默吞掉
    try {
      if (onEvent) onEvent(evt);
    } catch (err) {
      /* 忽略 */
    }
  };
  return true;
}

export function installGrabBridge(handlers = {}) {
  if (!isNativeApp()) return false;
  const onEvent = typeof handlers.onEvent === 'function' ? handlers.onEvent : null;
  const onResult = typeof handlers.onResult === 'function' ? handlers.onResult : null;

  window.__buptGrabEvent = (raw) => {
    let event = null;
    try {
      event = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      return;
    }
    if (!event || typeof event !== 'object') return;
    // 回调异常不能抛回原生，否则 WebView 会静默吞掉
    try {
      if (onEvent) onEvent(event);
    } catch (err) {
      /* 忽略 */
    }
  };

  window.__buptGrabResult = (id, b64) => {
    let payload = null;
    try {
      payload = JSON.parse(decodePayload(b64));
    } catch (err) {
      try {
        if (onEvent) onEvent({ type: 'error', id: String(id || ''), code: 'read_failed', detail: 'payload 解码失败' });
      } catch (e) {
        /* 忽略 */
      }
      return;
    }
    try {
      if (onResult) onResult(String(id || ''), payload);
    } catch (err) {
      /* 忽略 */
    }
  };

  return true;
}


/* ---------------------------------------------------------------- 保活相关（品牌 + 系统设置） */

/** 厂商串（如 Xiaomi / HUAWEI / OPPO），浏览器里返回空串。 */
export function deviceBrand() {
  const info = nativeInfo();
  return String((info && info.brand) || '');
}

/** 机型串（仅用于界面显示"你的机型"）。 */
export function deviceModel() {
  const info = nativeInfo();
  return String((info && info.model) || '');
}

/** 是否已加入「忽略电池优化」白名单；非原生环境返回 null（未知）。 */
export function batteryExempt() {
  const b = nativeBridge();
  if (!b || typeof b.batteryExempt !== 'function') return null;
  try {
    return !!b.batteryExempt();
  } catch (err) {
    return null;
  }
}

/** 打开本应用的系统详情页（通知权限、后台限制都在里面）。 */
export function openAppSettings() {
  const b = nativeBridge();
  if (!b || typeof b.openAppSettings !== 'function') return false;
  try {
    b.openAppSettings();
    return true;
  } catch (err) {
    return false;
  }
}

/** 打开系统「忽略电池优化」页。 */
export function openBatterySettings() {
  const b = nativeBridge();
  if (!b || typeof b.openBatterySettings !== 'function') return false;
  try {
    b.openBatterySettings();
    return true;
  } catch (err) {
    return false;
  }
}

/* ---------------------------------------------------------------- 一次读全部权限（首次引导用） */

/**
 * 原生把所有"要用户点一下"的状态一次报回来。
 * @returns {{sdk:number, notify:string, batteryExempt:boolean, exactAlarm:boolean,
 *            promoted:boolean|null}|null}
 */
export function permissionSnapshot() {
  const b = nativeBridge();
  if (!b || typeof b.permissionSnapshot !== 'function') return null;
  try {
    return JSON.parse(String(b.permissionSnapshot() || '{}')) || null;
  } catch (err) {
    return null;
  }
}

/**
 * 系统是否把本应用限制在后台。
 *
 * ★ 只在小米上是"厂商那层"的真实状态（官方文档 pId=1628 第 6 条：
 *   被限制时 `isBackgroundRestricted()` 返回 true）。
 *   其它 ROM 上它只反映标准的后台限制开关，可能 false 但其实仍被限 ——
 *   所以**只当正向证据用**：true 才提示，false 一律当"读不到"。
 *
 * @returns {boolean|null} null = 读不到
 */
export function batteryRestricted() {
  const snap = permissionSnapshot();
  if (!snap || typeof snap.bgRestricted !== 'boolean') return null;
  return snap.bgRestricted;
}

/* ---------------- 作业的凭证（与教务分开存，两边密码不一样） ---------------- */

export function hwCredSave(account, password) {
  const b = nativeBridge();
  if (!b || typeof b.saveHomeworkCredentials !== 'function') return false;
  try {
    return !!b.saveHomeworkCredentials(String(account || ''), String(password || ''));
  } catch (err) {
    return false;
  }
}

export function hwCredHas() {
  const b = nativeBridge();
  if (!b || typeof b.hasHomeworkCredentials !== 'function') return false;
  try {
    return !!b.hasHomeworkCredentials();
  } catch (err) {
    return false;
  }
}

export function hwCredAccount() {
  const b = nativeBridge();
  if (!b || typeof b.homeworkAccount !== 'function') return '';
  try {
    return String(b.homeworkAccount() || '');
  } catch (err) {
    return '';
  }
}

export function hwCredClear() {
  const b = nativeBridge();
  if (!b || typeof b.clearHomeworkCredentials !== 'function') return false;
  try {
    b.clearHomeworkCredentials();
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 抓作业：让原生在隐藏 WebView 里登录云邮教学空间，把待办 + 详情取回来。
 *
 * 结果不从这里返回（要跑十几秒），而是走 `window.__buptHomeworkEvent(event)`：
 *   { type:'progress'|'result'|'error', ... }
 *
 * @param {string} account 学号；空串表示用本机已保存的
 * @param {string} password 密码；空串表示用本机已保存的
 * @returns {boolean} 原生是否接手
 */
export function grabHomework(account, password) {
  const b = nativeBridge();
  if (!b || typeof b.grabHomework !== 'function') return false;
  try {
    return !!b.grabHomework(String(account || ''), String(password || ''));
  } catch (err) {
    return false;
  }
}

/** 精确闹钟（Android 12+ 特殊权限）设置页。 */
export function openExactAlarmSettings() {
  const b = nativeBridge();
  if (!b || typeof b.openExactAlarmSettings !== 'function') return false;
  try {
    b.openExactAlarmSettings();
    return true;
  } catch (err) {
    return false;
  }
}

/** 提升通知 / 流体云设置页。 */
export function openPromotedSettings() {
  const b = nativeBridge();
  if (!b || typeof b.openPromotedSettings !== 'function') return false;
  try {
    b.openPromotedSettings();
    return true;
  } catch (err) {
    return false;
  }
}

/** 本应用的通知设置页（渠道开关都在这）。 */
export function openNotificationSettings() {
  const b = nativeBridge();
  if (!b || typeof b.openNotificationSettings !== 'function') return false;
  try {
    b.openNotificationSettings();
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 目标页：「设置 → 应用 → 北邮课程表 → 权限管理 → 通知」。
 * @returns {'perm'|'notify'|'detail'|'none'} 实际落在哪一级
 */
export function openNotificationPermissionPage() {
  const b = nativeBridge();
  if (!b || typeof b.openNotificationPermissionPage !== 'function') return 'none';
  try {
    return String(b.openNotificationPermissionPage() || 'none');
  } catch (err) {
    return 'none';
  }
}

/**
 * 直接打开「通知与控制中心」（ColorOS 上底部有「应用通知设置」入口的那一页）。
 * @returns {boolean} 是否已打开
 */
export function openNotificationCenter() {
  const b = nativeBridge();
  if (!b || typeof b.openNotificationCenter !== 'function') return false;
  try {
    return !!b.openNotificationCenter();
  } catch (err) {
    return false;
  }
}

/**
 * 打开通知设置，并返回**落在哪一级**（用于给准确提示）。
 * @returns {'vendor_new'|'vendor_old'|'channel'|'list'|'app'|'detail'|'none'}
 */
export function openNotificationSettingsEx() {
  const b = nativeBridge();
  if (!b || typeof b.openNotificationSettingsEx !== 'function') return 'none';
  try {
    return String(b.openNotificationSettingsEx() || 'none');
  } catch (err) {
    return 'none';
  }
}

/** 落地级别 → 给用户看的一句话。 */
export const NOTIFY_LANDING_HINT = {
  vendor_new: '已打开通知设置，把「上课提醒」打开即可',
  vendor_old: '已打开通知设置，把「上课提醒」打开即可',
  channel: '已打开「上课提醒」渠道，勾上横幅和锁屏',
  app: '已打开通知设置，把「上课提醒」打开即可',
  list: '已打开通知列表，点一下「北邮课程表」就是了',
  detail: '系统没给直达通知页，请点「通知管理」再开',
  none: '无法打开系统设置，请手动到 设置 › 通知 里允许'
};

/**
 * 通知体检：系统到底允许到什么程度。
 *
 * @returns {{granted:boolean, appEnabled:boolean, importance:number,
 *            importanceLabel:string, channelExists:boolean,
 *            bannerLikely:boolean, dndActive:boolean,
 *            promoted:boolean|null}|null}
 *          null = 当前环境读不到（浏览器 / 旧版 APK）
 */
export function notificationAudit() {
  const b = nativeBridge();
  if (!b || typeof b.notificationAudit !== 'function') return null;
  try {
    return JSON.parse(String(b.notificationAudit() || '{}')) || null;
  } catch (err) {
    return null;
  }
}

/**
 * 打开「设置 › 应用 › 北邮课程表」（耗电管理就在这一页里）。
 *
 * @returns {'appDetail'|'ignoreList'|'requestIgnore'|'none'}
 */
export function openBatteryModePage() {
  const b = nativeBridge();
  if (!b || typeof b.openBatteryModePage !== 'function') return 'none';
  try {
    return String(b.openBatteryModePage() || 'none');
  } catch (err) {
    return 'none';
  }
}

/**
 * 只打开 AOSP 那层「电池优化」列表（Doze 白名单）。
 *
 * 它和厂商的「耗电管理」是**两件事**：前者是 AOSP 的 Doze 豁免，
 * 后者是 ColorOS 自己的省电策略。两层都要开，所以页面上给两个入口。
 *
 * @returns {'ignoreList'|'requestIgnore'|'none'}
 */
export function openAospBatteryList() {
  const b = nativeBridge();
  if (!b || typeof b.openAospBatteryList !== 'function') return 'none';
  try {
    return String(b.openAospBatteryList() || 'none');
  } catch (err) {
    return 'none';
  }
}

/**
 * 电池页落点 → 提示语。
 *
 * ★ 文案只说"这一页该点什么"，**不承诺"已经生效"** ——
 *   ColorOS 那层系统不提供查询，是否真的放开只能靠行为验证。
 */
export const BATTERY_LANDING_HINT = {
  powerPage:
    '已打开「耗电管理」：把「耗电行为控制」选成「完全允许后台行为」。若看到的是应用列表，点一下「北邮课程表」即可',
  appDetail: '已打开「设置 › 应用 › 北邮课程表」：点这一页里的「耗电管理」→ 选「完全允许后台行为」',
  ignoreList: '已打开「电池优化」列表：这是 AOSP 那层，和「耗电管理」是两件事，两层都要开',
  requestIgnore: '已弹出「忽略电池优化」确认框：这是 AOSP 那层，厂商的「耗电管理」还要单独改',
  none: '没能打开系统页：请到 设置 › 应用 › 北邮课程表 › 耗电管理 → 允许完全后台行为'
};
