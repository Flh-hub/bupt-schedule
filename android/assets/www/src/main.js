/**
 * main.js — 启动、路由、全局事件委托、跨零点与提醒调度接线。
 *
 * 【纪律】
 *  - 本文件不得做日期/周次/节假日判断：所有结论来自 calendar.js。
 *  - 所有 navigator.serviceWorker / Notification 访问都包在
 *    `location.protocol !== 'file:'` 与能力判断里，保证 file:// 打开时
 *    给出明确提示条而不是白屏崩掉。
 */

import { createStore } from './store.js';
import {
  courseColor,
  dayOfWeekOf,
  isDateStr,
  isHhmm,
  minutesOfDay,
  normalizeCourseName,
  nowIso,
  periodRangeForTime,
  startMondayOfWeek,
  todayStr,
  WEEKDAY_SHORT
} from './model.js';
import { currentWeekOffset, getReminders, resolveDay } from './calendar.js';
import { isSecureContextLike, replan, startScheduler } from './reminder.js';
import {
  closePicker,
  closeSheet,
  confirmDialog,
  openPicker,
  copyText,
  paintSelectTrigger,
  resolveDialog,
  runUndo,
  sampleState,
  SAMPLE_TEXT,
  segmented,
  selectField,
  sheet,
  snackbar
} from './ui/components.js';
import { installBlockDrag } from './ui/dragdrop.js';
import { maybePromptMakeup, snoozeMakeupPrompt, openMakeupPrompt } from './ui/makeupPrompt.js';
import * as TT from './ui/timetable.js';
import * as IMP from './ui/import.js';
import * as REM from './ui/reminderView.js';
import * as SET from './ui/settings.js';
import { FEEDBACK_EMAIL } from './ui/settings.js';
import * as NATIVE from './native.js';
import { buildWidgetPayload } from './widget.js';
import * as SEM from './semester.js';
import { diffTimetables } from './diff.js';
import { maybeShowOnboard, refreshOnboard, showOnboard } from './ui/onboard.js';
import { dismissPrivacyGate, maybeAskPrivacy, privacyAccepted } from './ui/privacy.js';
import { closeNotifyGuide, onPermissionResult, startNotifyFlow } from './ui/notifyGuide.js';
import { armReturnCheck, runReturnCheck } from './ui/returnCheck.js';
import { applyGrabEvent, createGrab, grabErrorInfo, grabIsRunning, grabIsStalled } from './grab.js';

/* ---------------------------------------------------------------- 全局状态 */

const store = createStore();

const uiState = {
  weekOffset: 0,
  viewMode: 'week',
  dayDate: null,
  importChannel: 'text',
  importSource: 'auto',
  importText: '',
  parseDraft: null,
  openPanels: new Set(),
  restoreMode: 'overwrite',
  storageBroken: false,
  keepParseDraft: false,
  // 示例课表预览：只渲染临时 state，不写库
  samplePreview: false,
  // 「更新课表」：抓取结果 → 差异 → 用户确认后才写入
  updateDraft: null,
  updateDiff: null,
  updateError: null,
  // 「自动导入」：一次后台抓取任务的实时状态（src/grab.js 里定义形状）
  grab: null
};

let currentRoute = { name: 'timetable', sub: null, courseId: null, date: null };
let renderQueued = false;

/* ---------------------------------------------------------------- 路由 */

function parseHash() {
  const raw = (window.location.hash || '#/timetable').replace(/^#\/?/, '');
  const parts = raw.split('/').filter((p) => p !== '');
  if (parts[0] === 'detail' && parts.length >= 3) {
    return { name: 'detail', sub: null, courseId: decodeURIComponent(parts[1]), date: parts[2] };
  }
  const known = ['timetable', 'import', 'reminder', 'settings'];
  // 二级页：#/settings/periods、#/reminder/courses —— 用 hash 段表示，
  // 这样安卓返回键直接走 history，不用自己维护"返回上一级"的栈
  if (known.includes(parts[0])) {
    return {
      name: parts[0],
      sub: parts[1] ? decodeURIComponent(parts[1]) : null,
      courseId: null,
      date: null
    };
  }
  return { name: 'timetable', sub: null, courseId: null, date: null };
}

function navigate(hash) {
  if (window.location.hash === hash) {
    render();
    return;
  }
  window.location.hash = hash;
}

function syncTabs() {
  const tabbar = document.getElementById('tabbar');
  if (!tabbar) return;
  for (const tab of tabbar.querySelectorAll('[data-route]')) {
    const active = tab.dataset.route === `#/${currentRoute.name}`;
    tab.classList.toggle('is-active', active);
  }
}

/* ---------------------------------------------------------------- 渲染 */

/**
 * 渲染前记下每个开关的当前外观，渲染后据此补间。
 *
 * 【为什么需要这一步】
 * 页面是 innerHTML 整块重建的 —— 新元素插进来时 `.is-on` 已经是最终态，
 * CSS transition 根本不会触发，用户看到的就是"瞬间跳变"。
 * 所以要在覆盖 DOM 之前把旧状态（是否打开 + 当时的轨道颜色）抄下来，
 * 重建后再用 WAAPI 从旧态补到新态，视觉上才是滑过去的。
 *
 * 记 `backgroundColor` 的**计算值**而不是原始色：上一次补间还在跑时，
 * 计算值就是中间色，下一次从中间色接着补 —— 快速连点也不会闪。
 */
function captureSwitches(view) {
  const out = new Map();
  if (!view) return out;
  for (const el of view.querySelectorAll('.switch[data-switch-key]')) {
    out.set(el.dataset.switchKey, {
      on: el.classList.contains('is-on'),
      bg: getComputedStyle(el).backgroundColor
    });
  }
  return out;
}

/** 渲染后把状态变过的开关补一遍动画（位移 + 轨道颜色）。 */
function animateSwitches(view, before) {
  if (!view || !before || before.size === 0) return;
  const easing = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
  const duration = 200;
  for (const el of view.querySelectorAll('.switch[data-switch-key]')) {
    const prev = before.get(el.dataset.switchKey);
    if (!prev) continue;
    const nowOn = el.classList.contains('is-on');
    if (prev.on === nowOn) continue; // 状态没变就别动它

    const knob = el.querySelector('.knob');
    if (knob) {
      const travel =
        getComputedStyle(el).getPropertyValue('--switch-travel').trim() || '20px';
      const from = prev.on ? travel : '0px';
      const to = nowOn ? travel : '0px';
      knob.animate([{ transform: `translateX(${from})` }, { transform: `translateX(${to})` }], {
        duration,
        easing,
        fill: 'none' // 结束不残留样式，最终态由 class 决定
      });
    }
    el.animate(
      [
        { backgroundColor: prev.bg },
        { backgroundColor: getComputedStyle(el).backgroundColor }
      ],
      { duration, easing, fill: 'none' }
    );
  }
}

/** 上一次渲染时的路由指纹，用来区分「切换页面」和「同一页内重渲染」。 */
let lastRouteKey = '';

/* ------------------------------------------------------------ 路由切换时的滚动位置

   规则（用户定的）：
     · 进入新页面（点课程 / 点 Tab / 二级页）→ **从顶部开始**；
     · 返回上一页（系统返回键、弹层里的「返回」）→ **回到原来的位置**。

   旧代码两件事都没做：`render()` 只换 innerHTML，document 的滚动位置被原样带过去，
   于是"课表滚到 420px 点进详情"会停在 420（被新页高度钳制后是 21），
   详情页的顶栏被顶到视口外面 —— 用户看到的"跳转不在顶部"。

   `routeScrollMemo` 存「离开某路由时的 y」，只在**历史回退**时读它。 */
const routeScrollMemo = new Map();
/** popstate 先于 hashchange：用它区分"返回/前进"和"新的一次跳转" */
let routeFromHistory = false;

/**
 * 播一次页面进入动画。
 *
 * ★ 只在**路由变化**时调用。每次 dispatch 都播的话，用户点一个按钮整页就闪一下，
 *   反而显得卡。动画本身全在 CSS 里（`#view.is-entering …`），这里只负责挂/摘 class。
 * ★ 600ms 兜底：`animationend` 在元素被 innerHTML 换掉时不保证触发，不兜底会残留 class，
 *   下一次同页重渲染就会跟着重播动画。
 */
function playEnter(view) {
  if (!view) return;
  view.classList.remove('is-entering');
  void view.offsetWidth; // 强制回流，保证连续切换时动画能重新开始
  view.classList.add('is-entering');
  window.setTimeout(() => view.classList.remove('is-entering'), 600);
}

function render() {
  renderQueued = false;
  const realState = store.getState();
  // 示例预览只在本机还没有课表时生效，避免遮住真实数据
  const state = uiState.samplePreview && !realState.sessions.length ? sampleState() : realState;
  uiState.storageBroken = store.isStorageBroken();
  const view = document.getElementById('view');
  if (!view) return;

  currentRoute = parseHash();
  uiState.sub = currentRoute.sub || null; // 各页面据此渲染二级页
  syncTabs();

  const routeKey = `${currentRoute.name}|${currentRoute.sub || ''}|${currentRoute.courseId || ''}|${
    currentRoute.date || ''
  }`;
  const routeChanged = routeKey !== lastRouteKey;
  const prevRouteKey = lastRouteKey;
  // ★ 必须在替换 innerHTML **之前**读 scrollY：此刻 DOM 还是旧页面，值才是旧页的真实值
  if (routeChanged && prevRouteKey) routeScrollMemo.set(prevRouteKey, window.scrollY);
  const cameFromHistory = routeFromHistory;
  routeFromHistory = false;
  lastRouteKey = routeKey;

  // 必须在各 renderXxx 覆盖 innerHTML 之前抄状态
  const switchesBefore = captureSwitches(view);

  if (currentRoute.name === 'detail') {
    TT.renderDetail(view, state, currentRoute.courseId, currentRoute.date);
  } else if (currentRoute.name === 'import') {
    IMP.renderImport(view, state, uiState);
  } else if (currentRoute.name === 'reminder') {
    REM.renderReminder(view, state, uiState);
  } else if (currentRoute.name === 'settings') {
    SET.renderSettings(view, state, uiState);
  } else {
    TT.renderTimetable(view, state, uiState);
  }

  // 开关先补间（它可能在进入动画的容器里，两者不冲突：一个动 transform，一个动 opacity）
  animateSwitches(view, switchesBefore);

  // 内容落屏之后再挂进入动画（顺序反了会先闪一下无样式的内容）
  if (routeChanged) playEnter(view);

  // 换页落点：返回 → 还原；其余（进新页 / 切 Tab）→ 回顶部
  if (routeChanged) {
    const remembered = routeScrollMemo.get(routeKey);
    const targetY = cameFromHistory && remembered != null ? remembered : 0;
    applyRouteScroll(targetY);
  }
}

/**
 * 换页后把滚动落到 `y`。
 * 立即滚一次，再在下一轮补一次 —— 新内容高度刚变化时浏览器可能把 scrollTo 钳回去
 * （和 `period-edit` 改节次后保位是同一套写法）。
 * @param {number} y 目标滚动位置（px）
 */
function applyRouteScroll(y) {
  const target = Math.max(0, Number(y) || 0);
  window.scrollTo(0, target);
  if (target > 0) {
    setTimeout(() => {
      if (Math.abs(window.scrollY - target) > 1) window.scrollTo(0, target);
    }, 0);
  }
}

/**
 * 合并同一轮的多次渲染请求（批量 dispatch 时不抖）。
 * ★ 用 setTimeout 而不是 requestAnimationFrame：页面切到后台时 rAF 会被冻结，
 *   而用户刚点了「确认补班日」这类动作必须立刻落屏（否则回到前台才看到，像卡住了）。
 */
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    if (renderQueued) render();
  }, 0);
}

/* ---------------------------------------------------------------- 提示条 / SW */

function showFileProtocolWarning() {
  const el = document.getElementById('file-warning');
  if (!el) return;
  if (window.location.protocol !== 'file:') {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML =
    '<b>当前是 file:// 直接打开的</b>：通知、离线和「添加到主屏幕」都会被浏览器禁用（模块脚本也受限）。' +
    '<br>请在项目目录执行 <span class="mono">python -m http.server 8080</span>，再用 <span class="mono">localhost:8080</span> 打开。';
}

async function registerServiceWorker() {
  // file:// 下 register 必然失败（且不是安全上下文），直接跳过，避免控制台报错与白屏
  if (window.location.protocol === 'file:') return;
  // Android 壳里资源是打包在 APK 内的，没有网络请求可用缓存，SW 只会多一层麻烦
  if (NATIVE.isNativeApp()) return;
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    /* 静默：不影响主流程 */
  }
}

/* ---------------------------------------------------------------- 动作实现 */

/**
 * 预览示例课表：**只渲染一份临时 state，绝不写库**。
 *
 * 之前这里是直接把示例 dispatch 进 store（IMPORT_COMMIT + 一堆 ADD_ADJUSTMENT），
 * 结果用户点「先看示例课表」就凭空多出一份课表，返回也回不到空态。
 * 现在只在内存里渲染，退出即恢复原样。
 */
function enterSamplePreview() {
  uiState.samplePreview = true;
  uiState.weekOffset = 0;
  uiState.viewMode = 'week';
  navigate('#/timetable');
  render();
}

/** 退出示例预览：回到原来的页面（本地数据本来就一个字没动）。 */
function exitSamplePreview() {
  uiState.samplePreview = false;
  uiState.weekOffset = currentWeekOffset(store.getState());
  render();
}

/** 载入示例课表（`?demo=1` 的一次性演示用：这条路径会真的写入）。 */
function loadSample() {
  const sample = sampleState();
  store.dispatch({
    type: 'SET_SEMESTER',
    payload: {
      semesterStartMonday: sample.settings.semesterStartMonday,
      totalWeeks: sample.settings.totalWeeks
    }
  });
  const result = store.dispatch({
    type: 'IMPORT_COMMIT',
    payload: {
      parseResult: {
        courses: sample.courses,
        sessions: sample.sessions,
        warnings: [],
        unrecognized: [],
        meta: { source: 'text', detectedBy: 'sample', strategy: 'sample' }
      }
    }
  });
  if (!result.ok) {
    snackbar(result.errors[0] || '示例数据载入失败', { danger: true });
    return;
  }
  for (const a of sample.adjustments) {
    store.dispatch({
      type: 'ADD_ADJUSTMENT',
      payload: {
        adjustment: {
          date: a.date,
          type: a.type,
          targetSessionId: a.targetSessionId,
          courseId: a.courseId,
          startPeriod: a.startPeriod,
          endPeriod: a.endPeriod,
          location: a.location,
          note: a.note
        }
      }
    });
  }
  uiState.weekOffset = currentWeekOffset(store.getState());
  uiState.viewMode = 'week';
  scheduleRender();
  snackbar('已载入示例课表：8 门课 + 停课/换教室/补课各一条');
}

/**
 * 空白格 → 两件事二选一：
 *   ① 补课：把某门已有课程补到这一格；
 *   ② 活动：临时加一条不属于任何课程的事项（班会 / 组会 / 面试…）。
 * 两种都用同一条 adjustments 记录，只是 type 不同，所以删除/撤销走同一套。
 */
function openSlotSheet(date, period, mode) {
  const state = store.getState();
  const hasCourses = state.courses.length > 0;
  const active = mode === 'event' || !hasCourses ? 'event' : 'makeup';

  const periodOptions = TT.periodSelectOptions(state);
  const startValue = String(Number(period));
  // 活动默认用点开的这一格的时间；用户改成 08:20 也照样落得进去
  const tapped = state.settings.periods.find((p) => Number(p.index) === Number(period));
  const defaultStart = tapped && isHhmm(tapped.start) ? tapped.start : '09:00';
  const defaultEnd = tapped && isHhmm(tapped.end) ? tapped.end : '10:00';
  const courseOptions = state.courses.map((c) => {
    // 库里存的是教务原名（带教学班 O/P 尾巴），选择列表里显示基础名
    const shown = normalizeCourseName(c.name) || c.name;
    return {
      value: c.id,
      label: shown,
      sub: c.teacher || '',
      avatar: String(shown || '').trim().slice(0, 1) || '课',
      color: courseColor(c)
    };
  });

  sheet({
    title: `${date} 第 ${period} 节`,
    body: `${segmented(
      [
        { value: 'makeup', label: '补课', disabled: !hasCourses },
        { value: 'event', label: '活动' }
      ],
      active,
      'slot-mode'
    )}
      <div data-slot-group="makeup"${active === 'makeup' ? '' : ' hidden'}>
        ${
          hasCourses
            ? selectField({
                id: 'slot-course',
                name: 'courseId',
                label: '课程',
                title: '选择课程',
                value: courseOptions[0].value,
                options: courseOptions
              })
            : `<p class="tiny muted" style="margin:8px 0 0">还没有导入课表，先加「活动」吧。</p>`
        }
        ${selectField({
          id: 'slot-start',
          name: 'startPeriod',
          label: '开始节次',
          title: '开始节次',
          value: startValue,
          options: periodOptions,
          searchable: false,
          link: 'slot-end'
        })}
        ${selectField({
          id: 'slot-end',
          name: 'endPeriod',
          label: '结束节次',
          title: '结束节次',
          value: startValue,
          options: periodOptions,
          searchable: false
        })}
      </div>
      <div data-slot-group="event"${active === 'event' ? '' : ' hidden'}>
        <div class="field">
          <label for="slot-title">名称</label>
          <input class="input" id="slot-title" name="title" maxlength="30"
            placeholder="如 班会 / 组会 / 面试 / 自习" autocomplete="off" />
        </div>
        <div class="field-pair">
          <div class="field">
            <label for="ev-start">开始时间</label>
            <input class="input" id="ev-start" name="evStart" type="time" step="300"
              value="${escapeAttr(defaultStart)}" />
          </div>
          <div class="field">
            <label for="ev-end">结束时间</label>
            <input class="input" id="ev-end" name="evEnd" type="time" step="300"
              value="${escapeAttr(defaultEnd)}" />
          </div>
        </div>
        <p class="tiny muted" style="margin:0 0 12px">
          按时间落到格子里：08:20 就落在第 1 节偏上一点，09:30 跨到第 2 节。
        </p>
      </div>
      <div class="field">
        <label for="slot-loc">地点</label>
        <input class="input" id="slot-loc" name="location" placeholder="如 教三-101 / 线上" />
      </div>
      <div class="field">
        <label for="slot-note">备注</label>
        <input class="input" id="slot-note" name="note" placeholder="如 临时补课 / 带上笔记本" />
      </div>`,
    submitText: active === 'event' ? '添加活动' : '添加补课',
    onSubmit: (formData) => {
      const current = sheetSlotMode();
      const location = formData.get('location') || null;
      const note = formData.get('note') || null;

      if (current === 'event') {
        const title = String(formData.get('title') || '').trim();
        if (!title) {
          snackbar('先给这个活动起个名字', { danger: true });
          document.getElementById('slot-title')?.focus();
          return false;
        }

        // ★ 活动按「具体时间」录入；节次由时间反推（提醒 / 日视图 / 冲突检测仍靠节次）
        const startTime = String(formData.get('evStart') || '').trim();
        const endTime = String(formData.get('evEnd') || '').trim();
        if (!isHhmm(startTime) || !isHhmm(endTime)) {
          snackbar('把开始和结束时间都填上（如 09:00）', { danger: true });
          return false;
        }
        if (minutesOfDay(endTime) <= minutesOfDay(startTime)) {
          snackbar('结束时间要晚于开始时间', { danger: true });
          return false;
        }
        const range = periodRangeForTime(state.settings.periods, startTime, endTime);
        if (!range) {
          snackbar('先到设置里配好节次时间表，才能按时间定位', { danger: true });
          return false;
        }

        const result = store.dispatch({
          type: 'ADD_ADJUSTMENT',
          payload: {
            adjustment: {
              date,
              type: 'event',
              title,
              startTime,
              endTime,
              startPeriod: range.startPeriod,
              endPeriod: range.endPeriod,
              location,
              note
            }
          }
        });
        if (!result.ok) {
          snackbar(result.errors[0] || '添加失败', { danger: true });
          return false;
        }
        snackbar(`已把「${title}」加进 ${startTime}–${endTime}`, {
          undo: () => {
            store.dispatch({ type: 'DELETE_ADJUSTMENT', payload: { id: result.adjustment.id } });
            snackbar('已撤销');
          }
        });
        return true;
      }

      const startPeriod = Number(formData.get('startPeriod'));
      const endPeriod = Number(formData.get('endPeriod'));
      if (endPeriod < startPeriod) {
        snackbar('结束节次不得小于起始节次', { danger: true });
        return false;
      }
      const common = { date, startPeriod, endPeriod, location, note };

      const courseId = formData.get('courseId');
      if (!courseId) {
        snackbar('请先选择课程', { danger: true });
        return false;
      }
      const result = store.dispatch({
        type: 'ADD_ADJUSTMENT',
        payload: { adjustment: { ...common, type: 'makeup', courseId } }
      });
      if (!result.ok) {
        snackbar(result.errors[0] || '添加失败', { danger: true });
        return false;
      }
      snackbar('已添加补课', {
        undo: () => {
          store.dispatch({ type: 'DELETE_ADJUSTMENT', payload: { id: result.adjustment.id } });
          snackbar('已撤销');
        }
      });
      return true;
    }
  });

  if (active === 'event') {
    focusSheetField('slot-title', true);
  }
}


/**
 * 等弹层滑上来之后再把焦点交给输入框。
 *
 * 【为什么不是写死 setTimeout】滑入动画是 280ms（--dur-3）。旧代码在 260ms 就 focus，
 * 面板还在动，键盘此时弹出 → WebView adjustResize 把可视高度改小 → 贴着底边的面板
 * 被瞬间顶上去，视觉上就是"弹窗闪了一下"。
 * 现在等 transform 过渡真正结束（transitionend，兜底 360ms），并且用
 * `focus({preventScroll:true})` 阻止 Chromium 为了露出输入框去滚动整个文档
 * （那一下滚动就是"课表跟着动"的另一半原因）。
 *
 * @param {string} id 输入框 id
 * @param {boolean} [waitForSlide] 面板正在滑入时传 true
 */
function focusSheetField(id, waitForSlide = false) {
  const run = () => {
    const el = document.getElementById(id);
    if (!el || document.activeElement === el) return;
    try {
      el.focus({ preventScroll: true });
    } catch (err) {
      el.focus();
    }
  };

  if (!waitForSlide) {
    setTimeout(run, 0);
    return;
  }

  const sheetEl = document.querySelector('#sheet-host .sheet');
  let fired = false;
  const once = () => {
    if (fired) return;
    fired = true;
    run();
  };
  if (sheetEl) {
    sheetEl.addEventListener(
      'transitionend',
      (event) => {
        if (event.propertyName === 'transform') once();
      },
      { once: true }
    );
  }
  setTimeout(once, 360); // 兜底：系统动画被关掉 / 过渡没触发
}

/**
 * 当前弹层停在哪一栏（补课 / 活动）。
 * 以按钮的 aria-selected 为准：DOM 是唯一真相，不用再存一份 mode。
 */
function sheetSlotMode() {
  const btn = document.querySelector('#sheet-host .segmented [aria-selected="true"]');
  return btn && btn.dataset.value === 'event' ? 'event' : 'makeup';
}

/** 切换「补课 / 活动」：只切字段组与按钮文案，不重新渲染整张表单（否则动画重放、已填内容跳走）。 */
function switchSlotMode(mode) {
  const host = document.getElementById('sheet-host');
  if (!host) return;
  for (const group of host.querySelectorAll('[data-slot-group]')) {
    group.hidden = group.dataset.slotGroup !== mode;
  }
  const submit = host.querySelector('button[type="submit"]');
  if (submit) submit.textContent = mode === 'event' ? '添加活动' : '添加补课';
  if (mode === 'event') focusSheetField('slot-title');
}

/* ---------------------------------------------------------------- 拖动改时段 */

/** 一条调整里的「位置三件套」，撤销时用来复原。 */
function placementOf(adj) {
  return {
    date: adj.date,
    startPeriod: adj.startPeriod,
    endPeriod: adj.endPeriod,
    location: adj.location,
    note: adj.note
  };
}

/**
 * 依次执行一串调整操作，返回「反过来的那串」（供撤销）。
 * 任何一步失败就把已经做过的撤回——宁可什么都没变，也不要只改了一半。
 * @param {Array<{op:'add'|'update'|'delete', adjustment?:object, id?:string, patch?:object}>} ops
 * @returns {Array|null} 反向操作；失败返回 null（已自动回滚）
 */
function runAdjustmentOps(ops) {
  const inverse = [];
  for (const op of ops) {
    let res = { ok: true };
    if (op.op === 'add') {
      res = store.dispatch({ type: 'ADD_ADJUSTMENT', payload: { adjustment: op.adjustment } });
      if (res.ok) inverse.unshift({ op: 'delete', id: res.adjustment.id });
    } else if (op.op === 'update') {
      const before = store.getState().adjustments.find((a) => a.id === op.id);
      res = store.dispatch({ type: 'UPDATE_ADJUSTMENT', payload: { id: op.id, patch: op.patch } });
      if (res.ok && before) inverse.unshift({ op: 'update', id: op.id, patch: placementOf(before) });
    } else if (op.op === 'delete') {
      const before = store.getState().adjustments.find((a) => a.id === op.id);
      res = store.dispatch({ type: 'DELETE_ADJUSTMENT', payload: { id: op.id } });
      // 复原用新 id 重建：效果一样，只有 id 变了
      if (res.ok && before) inverse.unshift({ op: 'add', adjustment: { ...before } });
    }
    if (!res.ok) {
      for (const back of inverse) {
        if (back.op === 'add') store.dispatch({ type: 'ADD_ADJUSTMENT', payload: { adjustment: back.adjustment } });
        else if (back.op === 'update') store.dispatch({ type: 'UPDATE_ADJUSTMENT', payload: { id: back.id, patch: back.patch } });
        else if (back.op === 'delete') store.dispatch({ type: 'DELETE_ADJUSTMENT', payload: { id: back.id } });
      }
      snackbar(res.errors && res.errors[0] ? res.errors[0] : '移动失败', { danger: true });
      return null;
    }
  }
  return inverse;
}

/** `2026-10-23` → `周五`。 */
function weekdayLabel(date) {
  const dow = dayOfWeekOf(date);
  return dow >= 1 && dow <= 7 ? `周${WEEKDAY_SHORT[dow]}` : date;
}

/**
 * 拖到别的格子之后：把「这一个日期」的安排改掉，其它周次/日期一律不动。
 *
 * - 活动 / 补课：它们本身就是"这一天的临时记录"，直接改日期+节次；
 * - 同一天换时段：写一条 reschedule（原课次身份不变，详情页显示「已调课」）；
 * - 跨天：停掉原日期这一节 + 在目标日期补一节 —— 和现有「调课到另一天」是同一套语义，
 *   因为 sessions 只读、reschedule 不带日期。
 *
 * @param {object} src 拖动源（来自块上的 data-*）
 * @param {{date:string, period:number}} target
 */
function applyBlockMove(src, target) {
  const state = store.getState();
  const sorted = state.settings.periods.slice().sort((a, b) => a.index - b.index);
  const maxIndex = sorted.length ? sorted[sorted.length - 1].index : 0;
  const span = Math.max(0, Number(src.end) - Number(src.start));
  const newStart = Number(target.period);
  const newEnd = newStart + span;

  if (newEnd > maxIndex) {
    snackbar('这里放不下，已经超出最后一节了', { danger: true });
    return false;
  }
  if (target.date === src.date && newStart === Number(src.start)) return false;

  const ops = [];
  const sameDay = target.date === src.date;

  if ((src.dtype === 'event' || src.dtype === 'makeup') && src.daid) {
    const patch = { date: target.date, startPeriod: newStart, endPeriod: newEnd };
    // ★ 带具体时间的活动：不跟着改时间，块会继续画在旧时间的位置（看起来"搬了但没动"）
    const adj = state.adjustments.find((a) => a.id === src.daid);
    if (adj && isHhmm(adj.startTime) && isHhmm(adj.endTime)) {
      const pa = sorted.find((p) => Number(p.index) === newStart);
      const pb = sorted.find((p) => Number(p.index) === newEnd);
      if (pa && pb) {
        patch.startTime = pa.start;
        patch.endTime = pb.end;
      }
    }
    ops.push({ op: 'update', id: src.daid, patch });
  } else if (sameDay) {
    if (!src.sessionId) return false;
    if (src.dtype === 'reschedule' && src.daid) {
      ops.push({ op: 'update', id: src.daid, patch: { startPeriod: newStart, endPeriod: newEnd } });
    } else {
      ops.push({
        op: 'add',
        adjustment: { date: target.date, type: 'reschedule', targetSessionId: src.sessionId, startPeriod: newStart, endPeriod: newEnd }
      });
    }
  } else {
    if (!src.sessionId || !src.courseId) return false;
    if (src.dtype === 'reschedule' && src.daid) ops.push({ op: 'delete', id: src.daid });
    ops.push({ op: 'add', adjustment: { date: src.date, type: 'cancel', targetSessionId: src.sessionId } });
    ops.push({
      op: 'add',
      adjustment: {
        date: target.date,
        type: 'makeup',
        courseId: src.courseId,
        startPeriod: newStart,
        endPeriod: newEnd,
        location: src.location || null
      }
    });
  }

  const inverse = runAdjustmentOps(ops);
  if (!inverse) return false;

  const periodText = newEnd > newStart ? `第 ${newStart}-${newEnd} 节` : `第 ${newStart} 节`;
  const where = sameDay ? periodText : `${weekdayLabel(target.date)} ${periodText}`;
  snackbar(`已把「${normalizeCourseName(src.name) || src.name}」移到 ${where}`, {
    duration: 5200,
    undo: () => {
      runAdjustmentOps(inverse);
      snackbar('已撤销移动');
    }
  });
  return true;
}

/**
 * 拖动是本版新加的交互，没有固定入口，靠一次提示建立认知。
 * 只在「有课 + 停在课表页」时提示，并且装过一次就不再提（存 UI 标记，不进课表数据）。
 * @param {number} [retry] 内部用：被别的提示条占着时最多再等一轮
 */
function maybeTipDrag(retry = 1) {
  try {
    if (localStorage.getItem('bupt_drag_tip_v1')) return;
  } catch (err) {
    return; // 隐私模式读不到存储：宁可不提示，也不要每次启动都弹
  }
  setTimeout(() => {
    if (currentRoute.name !== 'timetable') return;
    if (!store.getState().sessions.length) return;
    const host = document.getElementById('snackbar-host');
    // 别把「已撤销 / 已移动」这类带操作按钮的提示条挤掉——用户可能正要按撤销
    if (host && host.childElementCount) {
      if (retry > 0) maybeTipDrag(retry - 1);
      return;
    }
    try {
      localStorage.setItem('bupt_drag_tip_v1', '1');
    } catch (err) {
      return;
    }
    snackbar('长按课程块可以拖到本周其他时段，只影响这一天', { duration: 5200 });
  }, 2600);
}

/** 点开一条自定义活动：看详情 + 删除。 */
function openEventSheet(adjustment) {
  const state = store.getState();
  const periods = state.settings.periods;
  const p1 = periods.find((p) => p.index === adjustment.startPeriod);
  const p2 = periods.find((p) => p.index === adjustment.endPeriod);
  // 有具体时间就显示具体时间（表格也按它定位）；早期没有时间的数据仍显示节次区间
  const exact = isHhmm(adjustment.startTime) && isHhmm(adjustment.endTime);
  const timeText = exact
    ? `${adjustment.startTime} – ${adjustment.endTime}`
    : p1 && p2
      ? `${p1.start} – ${p2.end}`
      : '时间待定';
  const periodText =
    adjustment.endPeriod > adjustment.startPeriod
      ? `第 ${adjustment.startPeriod}-${adjustment.endPeriod} 节`
      : `第 ${adjustment.startPeriod} 节`;

  const rows = [
    ['日期', `${adjustment.date} ${weekdayLabel(adjustment.date)}`],
    ['时间', exact ? timeText : `${periodText} · ${timeText}`],
    ['地点', adjustment.location || '未填写'],
    ['备注', adjustment.note || '未填写']
  ]
    .map(
      ([k, v]) => `<div class="kv-row"><span class="kv-k">${escapeAttr(k)}</span>
        <span class="kv-v">${escapeAttr(v)}</span></div>`
    )
    .join('');

  sheet({
    title: adjustment.title || '活动',
    hideSubmit: true,
    body: `<div class="kv-list">${rows}</div>
      <p class="tiny muted" style="margin:0 0 12px">长按课表里的这块，可以直接拖到本周其他时段。</p>
      <button type="button" class="btn btn-danger btn-block" data-action="event-delete"
        data-adjustment-id="${escapeAttr(adjustment.id)}">删除这个活动</button>
      <button type="button" class="btn btn-block" style="margin-top:8px" data-action="sheet-close">关闭</button>`
  });
}

/**
 * 选了开始节次后，把「结束节次」顶到不早于开始（连堂课直接覆盖）。
 * 不给提示：选项自己跳成合法值，比弹一句"结束不能小于开始"顺手。
 * @param {string} linkId 结束字段 id（由 selectField 的 data-pick-link 指定）
 * @param {string} value  刚选中的开始节次
 */
function bumpLinkedEnd(linkId, value) {
  const end = document.getElementById(linkId);
  if (!end) return;
  if (Number(end.value) >= Number(value)) return;
  end.value = value;
  const trigger = document.querySelector(`[data-pick-id="${linkId}"]`);
  if (!trigger) return;
  let options = [];
  try {
    options = JSON.parse(trigger.dataset.pickOptions || '[]');
  } catch (err) {
    options = [];
  }
  paintSelectTrigger(
    trigger,
    options.find((o) => String(o.value) === String(value)) || null
  );
}

function escapeAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 补录一条未识别内容。 */
function openManualFixSheet(index) {
  const draft = uiState.parseDraft;
  if (!draft || !draft.unrecognized[index]) return;
  const raw = String(draft.unrecognized[index].raw || '');
  const state = store.getState();

  sheet({
    title: '补录这一行',
    body: `<div class="field">
        <label for="fix-raw">原文</label>
        <input class="input" id="fix-raw" value="${escapeAttr(raw)}" readonly />
      </div>
      <div class="field">
        <label for="fix-name">课程名</label>
        <input class="input" id="fix-name" name="courseName" value="${escapeAttr(raw.slice(0, 40))}" required />
      </div>
      ${selectField({
        id: 'fix-dow',
        name: 'dayOfWeek',
        label: '星期',
        title: '星期',
        value: '1',
        searchable: false,
        options: [1, 2, 3, 4, 5, 6, 7].map((d) => ({
          value: String(d),
          label: `周${'一二三四五六日'[d - 1]}`,
          badge: '一二三四五六日'[d - 1],
          group: d <= 5 ? '工作日' : '周末'
        }))
      })}
      <div class="field">
        <label for="fix-sp">节次</label>
        <div class="inline-inputs">
          <input class="input" id="fix-sp" name="startPeriod" type="number" min="1" max="20" value="1" />
          <span class="muted">—</span>
          <input class="input" name="endPeriod" type="number" min="1" max="20" value="2" />
        </div>
      </div>
      <div class="field">
        <label for="fix-loc">地点</label>
        <input class="input" id="fix-loc" name="location" placeholder="如 教三-101" />
      </div>
      <div class="field">
        <label for="fix-weeks">周次</label>
        <input class="input" id="fix-weeks" name="weeksText" value="1-16周" />
      </div>`,
    submitText: '补录到预览',
    onSubmit: (formData) => {
      const rawRow = {
        courseName: String(formData.get('courseName') || '').trim(),
        dayOfWeek: Number(formData.get('dayOfWeek')),
        startPeriod: Number(formData.get('startPeriod')),
        endPeriod: Number(formData.get('endPeriod')),
        location: String(formData.get('location') || ''),
        weeksText: String(formData.get('weeksText') || '')
      };
      const ok = IMP.mergeManualRow(draft, rawRow, state.settings.totalWeeks);
      if (ok) {
        draft.unrecognized.splice(index, 1);
        snackbar('已补录');
        scheduleRender();
      }
      return ok;
    }
  });
}

/** 导入历史回滚。 */
async function rollbackImport(historyId) {
  const ok = await confirmDialog({
    title: '回滚到这次导入之前？',
    message: '当前课表会被替换为该次导入前的数据。调整记录也会一并回滚。',
    confirmText: '回滚'
  });
  if (!ok) return;
  const result = store.dispatch({ type: 'IMPORT_ROLLBACK', payload: { historyId } });
  if (!result.ok) snackbar(result.errors[0] || '回滚失败', { danger: true });
  else snackbar('已回滚');
}

/* ---------------------------------------------------------------- 事件委托：click */

/**
 * 示例预览期间允许的动作：翻周 / 切视图 / 退出 / 去别的 Tab。
 * 其余（补课、拖拽、改课、导入提交…）一律拦下，避免"看了示例却改了数据"。
 */
const PREVIEW_SAFE_ACTIONS = new Set([
  'nav',
  'toggle-view',
  'week-prev',
  'week-next',
  'week-today',
  'week-pick',
  'exit-sample',
  'load-sample',
  'panel-toggle'
]);

document.addEventListener('click', async (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
  if (!target) return;
  const action = target.dataset.action;
  // 示例预览：只允许看，不允许改
  if (uiState.samplePreview && action && !PREVIEW_SAFE_ACTIONS.has(action)) {
    snackbar('这是示例预览，导入自己的课表后才能编辑', { duration: 3200 });
    return;
  }
  if (!action) return;

  const state = () => store.getState();

  switch (action) {
    /* ---------------- 路由 / 面板 ---------------- */
    case 'nav': {
      const route = target.dataset.route;
      if (uiState.samplePreview && route && !route.startsWith('#/timetable')) {
        uiState.samplePreview = false;
      }
      const channel = target.dataset.channel;
      if (channel) {
        uiState.importChannel = channel;
        uiState.parseDraft = null;
      }
      if (route && !target.getAttribute('href')) {
        event.preventDefault();
        navigate(route);
      } else if (route && window.location.hash === route) {
        render();
      }
      return;
    }
    case 'back': {
      event.preventDefault();
      if (window.history.length > 1) window.history.back();
      else navigate('#/timetable');
      return;
    }
    case 'sheet-close':
      closeSheet();
      return;
    case 'slot-mode': {
      const wrap = target.closest('.segmented');
      if (!wrap) return;
      for (const btn of wrap.querySelectorAll('button')) {
        const on = btn === target;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', String(on));
      }
      switchSlotMode(target.dataset.value === 'event' ? 'event' : 'makeup');
      return;
    }
    case 'open-event': {
      const id = target.dataset.adjustmentId;
      const adj = store.getState().adjustments.find((a) => a.id === id);
      if (!adj) {
        snackbar('这条活动已经不存在了', { danger: true });
        return;
      }
      openEventSheet(adj);
      return;
    }
    case 'event-delete': {
      const id = target.dataset.adjustmentId;
      const adj = store.getState().adjustments.find((a) => a.id === id);
      if (!adj) {
        closeSheet();
        return;
      }
      closeSheet();
      store.dispatch({ type: 'DELETE_ADJUSTMENT', payload: { id } });
      snackbar(`已删除「${adj.title || '活动'}」`, {
        undo: () => {
          store.dispatch({ type: 'ADD_ADJUSTMENT', payload: { adjustment: { ...adj } } });
          snackbar('已恢复');
        }
      });
      return;
    }
    case 'pick-open': {
      // 选项全部在 data-pick-options 里（JSON），没有全局注册表，重绘也不会串数据
      const id = target.dataset.pickId;
      let options = [];
      try {
        options = JSON.parse(target.dataset.pickOptions || '[]');
      } catch (err) {
        options = [];
      }
      if (!id || !options.length) return;
      const hidden = document.getElementById(id);
      openPicker({
        title: target.dataset.pickTitle || '请选择',
        options,
        value: hidden ? hidden.value : '',
        searchable: target.dataset.pickSearch !== '0',
        onPick: (option) => {
          if (hidden) hidden.value = option.value;
          paintSelectTrigger(target, option);
          const link = target.dataset.pickLink;
          if (link) bumpLinkedEnd(link, option.value);
        }
      });
      return;
    }
    case 'dialog-ok':
      resolveDialog(true);
      return;
    case 'dialog-cancel':
      resolveDialog(false);
      return;
    case 'snackbar-undo':
      if (!runUndo(target.dataset.token)) snackbar('已经无法撤销了', { danger: true });
      return;
    case 'toggle-panel': {
      const panel = target.closest('.panel');
      if (!panel) return;
      const body = panel.querySelector('.panel-body');
      const open = panel.classList.toggle('is-open');
      if (body) body.hidden = !open;
      return;
    }
    case 'goto-channel': {
      // 「跳转登录」页的两个回填入口：切到对应通道，清掉旧草稿
      const value = target.dataset.value;
      if (!['text', 'html', 'json'].includes(value)) return;
      uiState.importChannel = value;
      uiState.parseDraft = null;
      navigate('#/import/manual');
      render();
      return;
    }

    /* ---------------- 课表 ---------------- */
    case 'week-prev':
      uiState.weekOffset -= 1;
      scheduleRender();
      return;
    case 'week-next':
      uiState.weekOffset += 1;
      scheduleRender();
      return;
    case 'week-today':
    case 'week-pick':
      // ★ 不是 0（那是第 1 周）：要落到真正包含今天的那一周
      uiState.weekOffset = currentWeekOffset(store.getState());
      scheduleRender();
      return;
    case 'toggle-view':
      uiState.viewMode = target.dataset.value === 'day' ? 'day' : 'week';
      scheduleRender();
      return;
    case 'day-pick':
      uiState.dayDate = target.dataset.value || null;
      scheduleRender();
      return;
    case 'open-detail': {
      const courseId = target.dataset.courseId;
      const date = target.dataset.date;
      if (!courseId || !date) return;
      navigate(`#/detail/${encodeURIComponent(courseId)}/${date}`);
      return;
    }
    case 'slot-tap':
      openSlotSheet(target.dataset.date, target.dataset.period);
      return;
    case 'load-sample':
      enterSamplePreview();
      return;
    case 'exit-sample':
      exitSamplePreview();
      return;

    /* ---------------- 课程详情 / 调整 ---------------- */
    case 'adj-open': {
      const kind = target.dataset.kind;
      const courseId = currentRoute.courseId;
      const date = currentRoute.date;
      if (!kind || !courseId || !date) return;
      const day = resolveDay(store.getState(), date);
      const cls = day.classes.find((c) => c.courseId === courseId) || null;
      TT.openAdjustSheet(
        kind,
        {
          store,
          state: store.getState(),
          courseId,
          date,
          sessionId: cls ? cls.sessionId : null
        },
        sheet
      );
      return;
    }
    case 'adj-scope': {
      const wrap = target.closest('.segmented');
      if (!wrap) return;
      for (const btn of wrap.querySelectorAll('button')) {
        const active = btn === target;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
      }
      return;
    }
    case 'adj-delete': {
      const id = target.dataset.adjId;
      if (!id) return;
      store.dispatch({ type: 'DELETE_ADJUSTMENT', payload: { id } });
      snackbar('已撤销该调整', {
        undo: () => {
          snackbar('调整已被删除，无法自动恢复', { danger: true });
        }
      });
      scheduleRender();
      return;
    }

    /* ---------------- 补班日确认（三态） ---------------- */
    case 'makeup-follow': {
      const date = target.dataset.date;
      const follow = target.dataset.follow;
      if (!date || !follow) return;
      const fromPrompt = target.dataset.from === 'prompt';
      const result = store.dispatch({ type: 'SET_MAKEUP_FOLLOW', payload: { date, follow } });
      if (!result.ok) {
        snackbar(result.errors[0] || '保存失败', { danger: true });
        return;
      }
      if (fromPrompt) closeSheet();
      snackbar(
        follow === 'none' ? `已确认 ${date} 不上课` : `已确认 ${date} 按周${'一二三四五六日'[Number(follow) - 1]}上课`,
        {
          undo: () => {
            // 撤销 = 删除用户覆盖，回到内置的「待确认」
            store.dispatch({ type: 'DELETE_HOLIDAY', payload: { date } });
            snackbar('已恢复为待确认');
          }
        }
      );
      scheduleRender();
      return;
    }
    case 'makeup-snooze': {
      // 「今天不再提醒」：只记到今天，明天照问；不写任何"已确认"语义
      snoozeMakeupPrompt(store, target.dataset.date, target.dataset.today || undefined);
      return;
    }
    case 'makeup-pick': {
      // 设置页那一行：点开自绘选择器（原生 <select> 在安卓 WebView 里是系统弹窗）
      const date = target.dataset.date;
      if (!date) return;
      const current = target.dataset.follow || '';
      openPicker({
        title: `${date} 按哪天的课表上课`,
        options: [
          { value: '', label: '待确认', sub: '不排课、不提醒，等你来定' },
          ...[1, 2, 3, 4, 5, 6, 7].map((d) => ({
            value: String(d),
            label: `按周${'一二三四五六日'[d - 1]}上课`,
            group: '按周几上课'
          })),
          { value: 'none', label: '不调休（这天没课）', group: '其他' }
        ],
        value: current,
        searchable: false,
        onPick: (option) => {
          SET.setMakeupFollow(store, store.getState(), date, option.value);
          scheduleRender();
        }
      });
      return;
    }
    case 'makeup-change': {
      const date = target.dataset.date;
      if (!date) return;
      sheet({
        title: `修改 ${date} 的上课安排`,
        body: `<p class="small muted" style="margin:0 0 12px">官方通知不指明补哪一天的课，请按北邮教务处的实际安排选择。</p>
          <div class="field">
            <label for="mk-follow">按哪天的课表上课</label>
            <select class="select" id="mk-follow" name="follow">
              <option value="">改回「待确认」</option>
              ${[1, 2, 3, 4, 5, 6, 7]
                .map((d) => `<option value="${d}">按周${'一二三四五六日'[d - 1]}上课</option>`)
                .join('')}
              <option value="none">这天确实没课</option>
            </select>
          </div>`,
        submitText: '保存',
        onSubmit: (formData) => {
          const result = SET.setMakeupFollow(store, store.getState(), date, formData.get('follow'));
          return !!result.ok;
        }
      });
      return;
    }
    case 'makeup-follow-bulk': {
      const ok = await confirmDialog({
        title: '全部未确认日都不上课？',
        message:
          '会把所有「待确认」的调休上班日逐日标记为「这天确实没课」。之后仍可在设置页逐日改回来。',
        confirmText: '全部标为不上课',
        danger: true
      });
      if (!ok) return;
      SET.setMakeupFollowBulk(store);
      scheduleRender();
      return;
    }

    /* ---------------- 导入 ---------------- */
    case 'import-channel': {
      const value = target.dataset.value;
      if (!value) return;
      // 四个通道都直接切；「跳转登录」页自己会说明为什么不收密码，
      // 不再用弹窗拦截（旧版拦截逻辑已删除，见 tests 里的 G4″ 契约）
      uiState.importChannel = value;
      uiState.parseDraft = null;
      scheduleRender();
      return;
    }
    case 'import-sample':
      uiState.importText = SAMPLE_TEXT;
      scheduleRender();
      snackbar('已填入示例文字，点「解析」试试');
      return;
    case 'semester-use-guess': {
      const g = uiState.semesterGuess;
      if (!g || !g.startMonday) return;
      const res = store.dispatch({
        type: 'SET_SEMESTER',
        payload: { semesterStartMonday: g.startMonday }
      });
      if (!res.ok) {
        snackbar(res.errors[0] || '设置失败', { danger: true });
        return;
      }
      uiState.semesterApplied = g;
      snackbar(`学期第 1 周周一已设为 ${g.startMonday}`, { duration: 4000 });
      scheduleRender();
      return;
    }
    case 'import-native-capture': {
      // 只在 Android 壳里有效；浏览器里点不到这个按钮（卡片按 isNativeApp 渲染）
      if (!NATIVE.openJwglCapture()) {
        snackbar('「App 内抓取」只在安卓 App 里可用', { danger: true });
      }
      return;
    }
    case 'import-parse': {
      const draft = IMP.runParse(store.getState(), uiState);
      scheduleRender();
      void draft;
      return;
    }
    case 'import-cancel':
      uiState.parseDraft = null;
      scheduleRender();
      return;
    case 'import-commit': {
      const draft = uiState.parseDraft;
      const result = IMP.commitDraft(store, draft);
      if (!result.ok) {
        snackbar(result.errors[0] || '导入失败', { danger: true });
        return;
      }
      // 先落课表，再按教务作息 / 学期校正设置（否则第 12 节以后的课排不进周视图、
      // 没有「第 1 周周一」就不知道今天是第几周）
      const notes = [
        IMP.adoptDetectedPeriods(store, draft),
        IMP.applyDetectedSemester(store, draft)
      ].filter(Boolean);
      if (notes.length) snackbar(notes.join('；'), { duration: 5200 });
      uiState.parseDraft = null;
      uiState.importText = '';
      uiState.weekOffset = currentWeekOffset(store.getState());
      navigate('#/timetable');
      return;
    }
    case 'import-rollback':
      rollbackImport(target.dataset.historyId);
      return;
    case 'draft-remove': {
      IMP.removeDraftRow(uiState.parseDraft, Number(target.dataset.row));
      scheduleRender();
      return;
    }
    case 'unrec-ignore': {
      const index = Number(target.dataset.index);
      if (uiState.parseDraft) {
        uiState.parseDraft.unrecognized.splice(index, 1);
        scheduleRender();
      }
      return;
    }
    case 'unrec-fix':
      openManualFixSheet(Number(target.dataset.index));
      return;
    case 'import-help':
      sheet({
        title: '导入说明',
        hideSubmit: true,
        body: `<p class="small">三条通道各有适用场景：</p>
          <ol class="steps">
            <li><b>粘贴文本</b>：最稳，任何来源都能用（群里复制的、OCR 的）。</li>
            <li><b>HTML 源码</b>：教务系统课表页「另存为」后导入，字段最全。</li>
            <li><b>JSON</b>：本 App 备份恢复，或抓包数据。</li>
          </ol>
          <p class="small muted" style="margin-top:10px">解析失败的行走「未识别的内容」，可逐条补录或忽略，不会被静默丢弃。</p>`
      });
      return;

    /* ---------------- 自动导入（后台抓取） ---------------- */
    case 'grab-cancel': {
      // 先把状态置成终态，再叫原生停：按钮点下去要立刻有反应，
      // 而且原生回的 cancelled 到时会被"终态不可覆盖"挡住，不会重复提示
      if (grabIsRunning(uiState.grab)) {
        uiState.grab = applyGrabEvent(
          uiState.grab,
          { type: 'error', id: uiState.grab.id, code: 'cancelled' },
          Date.now()
        );
        NATIVE.cancelGrab();
        syncGrabTicker();
        scheduleRender();
      }
      return;
    }
    case 'grab-retry': {
      if (grabIsRunning(uiState.grab)) return;
      // 用已保存的凭证直接重来；不再弹表单（密码留空 = 用 Keystore 里那份）
      if (!NATIVE.credHas()) {
        uiState.grab = null;
        snackbar('请重新填一次密码', { duration: 3000 });
        scheduleRender();
        return;
      }
      startGrabFlow(NATIVE.credAccount(), '');
      return;
    }
    case 'grab-restart': {
      // 「重新抓取」：回到表单（同时丢掉上一轮的抓取草稿）
      uiState.grab = null;
      uiState.parseDraft = null;
      uiState.updateDraft = null;
      uiState.updateDiff = null;
      uiState.updateError = null;
      scheduleRender();
      return;
    }

    /* ---------------- 更新课表 / 凭证 ---------------- */
    case 'update-fetch': {
      if (!NATIVE.credHas()) {
        snackbar('先保存学号密码，才能自动更新', { danger: true });
        return;
      }
      uiState.updateError = null;
      uiState.updateDiff = null;
      uiState.updateDraft = null;
      snackbar('正在自动登录并抓取课表…', { duration: 3200 });
      if (!NATIVE.autoCapture()) {
        failUpdate('unknown');
      }
      return;
    }
    case 'update-apply': {
      const draft = uiState.updateDraft;
      const diff = uiState.updateDiff;
      if (!draft) {
        snackbar('没有可应用的变更', { danger: true });
        return;
      }
      const result = store.dispatch({ type: 'IMPORT_COMMIT', payload: { parseResult: draft } });
      if (!result.ok) {
        snackbar(result.errors[0] || '应用变更失败，本地课表未改动', { danger: true });
        return;
      }
      const notes = [IMP.adoptDetectedPeriods(store, draft), IMP.applyDetectedSemester(store, draft)].filter(Boolean);
      uiState.updateDraft = null;
      uiState.updateDiff = null;
      uiState.weekOffset = currentWeekOffset(store.getState());
      navigate('#/timetable');
      const sum = diff && diff.summary ? diff.summary : { added: 0, removed: 0, changed: 0 };
      snackbar(
        `已更新：新增 ${sum.added} · 删除 ${sum.removed} · 变更 ${sum.changed}${notes.length ? `（${notes.join('；')}）` : ''}`,
        { duration: 5200 }
      );
      scheduleRender();
      return;
    }
    case 'update-discard': {
      uiState.updateDraft = null;
      uiState.updateDiff = null;
      uiState.updateError = null;
      snackbar('已保持不变，本地课表没有改动', { duration: 3200 });
      navigate('#/import');
      scheduleRender();
      return;
    }
    case 'cred-clear': {
      NATIVE.credClear();
      // 凭证没了，这次抓取如果还在跑也已经没意义（重试会直接失败）
      uiState.grab = null;
      syncGrabTicker();
      snackbar('已清除保存在本机的账号密码');
      scheduleRender();
      return;
    }

    /* ---------------- 提醒 ---------------- */
    case 'onboard-open':
      showOnboard();
      return;
    case 'copy-feedback':
      // 关于页的「复制」按钮：邮箱只在 settings.js 的 FEEDBACK_EMAIL 里定义一次
      copyText(FEEDBACK_EMAIL, `邮箱已复制：${FEEDBACK_EMAIL}`);
      return;

    case 'keepalive-app-settings':
      armReturnCheck('notify', 'exact', 'battery');
      if (!NATIVE.openAppSettings()) snackbar('只能在本机 App 内打开系统设置', { danger: true });
      return;
    case 'keepalive-battery':
      // ★ 不再直接甩系统页：先到「修改后台运行模式」讲清要选哪一项
      navigate('#/reminder/battery-mode');
      return;
    case 'battery-open-system': {
      armReturnCheck('battery');
      const r = REM.openBatteryModeSystemPage();
      snackbar(r.hint, { duration: 5200 });
      scheduleRender();
      return;
    }
    case 'battery-open-aosp': {
      armReturnCheck('battery');
      const r = REM.openAospBatteryPage();
      snackbar(r.hint, { duration: 5200 });
      scheduleRender();
      return;
    }
    case 'perm-request':
      armReturnCheck('notify');
      // ★ 不再弹系统权限对话框：直接跳到系统通知设置页，并在 App 内列出要开的几项。
      //   原因见 ui/notifyGuide.js 顶部注释（权限永久拒绝后 requestPermissions 不弹框；
      //   且横幅/锁屏/流体云无论如何都得用户自己开）。
      if (NATIVE.notifySupport()) {
        // ★ 先系统权限窗口 → 用户点完 → 回调里再跳「通知与控制中心」+ 显示清单
        startNotifyFlow();
        scheduleRender();
        return;
      }
      REM.askPermission().then(() => scheduleRender());
      return;
    case 'reminder-enabled':
      store.dispatch({
        type: 'SET_REMINDER_DEFAULTS',
        payload: { enabled: state().settings.reminder.enabled === false }
      });
      return;
    case 'reminder-sound':
      store.dispatch({
        type: 'SET_REMINDER_DEFAULTS',
        payload: { sound: state().settings.reminder.sound === false }
      });
      return;
    case 'reminder-vibrate':
      store.dispatch({
        type: 'SET_REMINDER_DEFAULTS',
        payload: { vibrate: state().settings.reminder.vibrate === false }
      });
      return;
    case 'reminder-advance':
      store.dispatch({
        type: 'SET_REMINDER_DEFAULTS',
        payload: { defaultAdvanceMinutes: Number(target.dataset.value) }
      });
      snackbar(`已设置默认提前 ${target.dataset.value} 分钟`);
      return;
    case 'reminder-advance-custom':
      REM.openAdvanceSheet(store.getState(), store);
      return;
    case 'reminder-channel':
      store.dispatch({
        type: 'SET_REMINDER_DEFAULTS',
        payload: { channel: target.dataset.value }
      });
      return;
    case 'rule-edit': {
      // 合并显示的一条可能对应多个 courseId（同名教学班），整组一起打开 / 一起保存
      const ids = (target.dataset.courseIds || target.dataset.courseId || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      REM.openRuleSheet(store.getState(), store, ids);
      return;
    }
    case 'rule-delete': {
      const ids = (target.dataset.courseIds || target.dataset.courseId || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const rules = store.getState().settings.reminder.rules || [];
      for (const courseId of ids) {
        const rule = rules.find((r) => r.targetId === courseId);
        if (rule) store.dispatch({ type: 'DELETE_RULE', payload: { id: rule.id } });
      }
      snackbar('已恢复跟随全局默认');
      return;
    }

    /* ---------------- 设置 ---------------- */
    case 'semester-oddeven': {
      const form = target.closest('form[data-action="semester-save"]');
      const hidden = form ? form.querySelector('input[name="hasOddEvenWeek"]') : null;
      if (!hidden) return;
      const next = hidden.value !== '1';
      hidden.value = next ? '1' : '0';
      target.classList.toggle('is-on', next);
      target.setAttribute('aria-checked', String(next));
      return;
    }
    case 'period-add': {
      const result = store.dispatch({ type: 'ADD_PERIOD', payload: {} });
      if (!result.ok) snackbar(result.errors[0] || '添加失败', { danger: true });
      return;
    }
    case 'period-del': {
      const result = store.dispatch({ type: 'DELETE_PERIOD', payload: { index: Number(target.dataset.index) } });
      if (!result.ok) snackbar(result.errors[0] || '删除失败', { danger: true });
      return;
    }
    case 'period-reset': {
      confirmDialog({
        title: '恢复默认节次时间？',
        message: `将恢复为参考作息（${state().settings.periods.length} 节会被替换），你手动改过的时间会丢失。`,
        confirmText: '恢复'
      }).then((ok) => {
        if (ok) SET.resetPeriods(store);
      });
      return;
    }
    case 'holiday-toggle': {
      const result = store.dispatch({ type: 'TOGGLE_HOLIDAY_SKIP', payload: {} });
      if (result.ok) {
        snackbar(state().settings.skipOnHoliday ? '节假日将跳过提醒' : '节假日不再跳过提醒');
      }
      return;
    }
    case 'makeup-mode':
      store.dispatch({ type: 'SET_MAKEUP_MODE', payload: { mode: target.dataset.value } });
      return;
    case 'holiday-add':
      // 两个入口：放假某一天 / 添加补班日（默认类型由按钮带过来）
      SET.openHolidaySheet(store, { type: target.dataset.type === 'makeupWorkday' ? 'makeupWorkday' : 'holiday' });
      return;
    case 'holiday-del': {
      const date = target.dataset.date;
      confirmDialog({
        title: '删除这个自定义日期？',
        message: `${date} 的自定义设置会被删除（内置节假日数据不受影响）。`,
        confirmText: '删除',
        danger: true
      }).then((ok) => {
        if (!ok) return;
        const result = store.dispatch({ type: 'DELETE_HOLIDAY', payload: { date } });
        if (!result.ok) snackbar(result.errors[0] || '删除失败', { danger: true });
      });
      return;
    }
    case 'backup-export':
      SET.exportBackup(store);
      return;
    case 'data-clear': {
      confirmDialog({
        title: '清空所有数据？',
        message: '课表、调整记录、提醒设置全部删除，且无法恢复。建议先导出备份。',
        confirmText: '清空',
        danger: true
      }).then((ok) => {
        if (!ok) return;
        store.dispatch({ type: 'CLEAR_ALL' });
        uiState.parseDraft = null;
        uiState.weekOffset = currentWeekOffset(store.getState());
        snackbar('已清空全部数据');
        navigate('#/timetable');
      });
      return;
    }
    case 'restore-mode': {
      uiState.restoreMode = target.dataset.value === 'merge' ? 'merge' : 'overwrite';
      const wrap = target.closest('.segmented');
      if (wrap) {
        for (const btn of wrap.querySelectorAll('button')) {
          const active = btn === target;
          btn.classList.toggle('is-active', active);
          btn.setAttribute('aria-selected', String(active));
        }
      }
      return;
    }

    default:
      return;
  }
});

/* ---------------------------------------------------------------- 事件委托：change */

document.addEventListener('change', (event) => {
  const el = event.target;
  if (!(el instanceof HTMLElement)) return;

  // 预览表单元格编辑
  if (el.dataset && el.dataset.edit) {
    IMP.applyCellEdit(
      uiState.parseDraft,
      Number(el.dataset.row),
      el.dataset.edit,
      el.value,
      store.getState().settings.totalWeeks
    );
    scheduleRender();
    return;
  }

  // 导入来源
  if (el.dataset && el.dataset.field === 'importSource') {
    uiState.importSource = el.value;
    return;
  }

  // 「今天是第几周」→ 反推学期起始日（没读到教务当前周时的兜底）
  if (el.dataset && el.dataset.field === 'semesterWeek') {
    const week = Number(el.value);
    if (!Number.isInteger(week) || week < 1 || week > 30) return;
    const start = startMondayOfWeek(week, todayStr());
    if (!start) {
      snackbar('这个周次算不出日期，请检查', { danger: true });
      return;
    }
    const res = store.dispatch({ type: 'SET_SEMESTER', payload: { semesterStartMonday: start } });
    if (!res.ok) {
      snackbar(res.errors[0] || '设置失败', { danger: true });
      return;
    }
    uiState.semesterApplied = { week, startMonday: start, source: '手动选择' };
    snackbar(`今天是第 ${week} 周 → 学期第 1 周周一 = ${start}`, { duration: 4600 });
    scheduleRender();
    return;
  }

  // 文件选择：导入内容
  if (el.dataset && el.dataset.field === 'importFile') {
    const file = el.files && el.files[0];
    IMP.readFileInto(file, (text) => {
      uiState.importText = text;
      scheduleRender();
      snackbar(`已读取 ${file.name}，点「解析」继续`);
    });
    return;
  }

  // 文件选择：恢复备份
  if (el.dataset && el.dataset.field === 'restoreFile') {
    const file = el.files && el.files[0];
    IMP.readFileInto(file, async (text) => {
      let summary = '备份内容';
      try {
        const data = JSON.parse(text);
        summary = `课程 ${(data.courses || []).length} 门 · 调整 ${(data.adjustments || []).length} 条 · 学期起始日 ${
          (data.settings && data.settings.semesterStartMonday) || '未设置'
        }`;
      } catch (err) {
        snackbar('备份文件不是合法 JSON', { danger: true });
        return;
      }
      const mode = uiState.restoreMode === 'merge' ? 'merge' : 'overwrite';
      const ok = await confirmDialog({
        title: mode === 'merge' ? '合并这份备份？' : '用这份备份覆盖当前数据？',
        message: `${summary}。模式：${mode === 'merge' ? '合并到现有数据' : '全量覆盖（当前课表会被替换）'}`,
        confirmText: mode === 'merge' ? '合并' : '覆盖',
        danger: mode !== 'merge'
      });
      if (ok) SET.restoreBackup(store, text, mode);
    });
    return;
  }

  // 节次时间编辑
  if (el.dataset && el.dataset.action === 'period-edit') {
    // 改完要整页重绘（14 行），不记住位置的话第 12 节改一下就跳回顶部
    const scrollY = window.scrollY;
    const result = store.dispatch({
      type: 'SET_PERIOD',
      payload: { index: Number(el.dataset.index), field: el.dataset.field, value: el.value }
    });
    if (!result.ok) snackbar(result.errors[0] || '保存失败', { danger: true });
    scheduleRender();
    setTimeout(() => window.scrollTo(0, scrollY), 0);
    return;
  }

  // 补班日「按周几上课」（'' = 回到待确认）
  if (el.dataset && (el.dataset.action === 'holiday-follow' || el.dataset.action === 'makeup-follow')) {
    const result = SET.setMakeupFollow(store, store.getState(), el.dataset.date, el.value);
    scheduleRender();
    if (!result.ok) snackbar(result.errors[0] || '保存失败', { danger: true });
    return;
  }
});

/* ---------------------------------------------------------------- 事件委托：键盘 */

// 可点但非 button 的行（例如 div[data-action][tabindex] 的列表行）
// 需要自己把 Enter / 空格转成 click，否则键盘用户聚焦后按了没反应
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const el = event.target instanceof Element ? event.target.closest('[data-action][tabindex="0"]') : null;
  if (!el) return;
  event.preventDefault();
  el.click();
});

/* ---------------------------------------------------------------- 事件委托：input */

document.addEventListener('input', (event) => {
  const el = event.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.dataset && el.dataset.field === 'importText') {
    uiState.importText = el.value;
  }
});

/* ---------------------------------------------------------------- 事件委托：submit */

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  /* ---------------- 自动导入：填学号密码 → 后台抓取 ---------------- */
  if (form.dataset.action === 'grab-start') {
    event.preventDefault();
    const data = new FormData(form);
    const account = String(data.get('account') || '').trim();
    const password = String(data.get('password') || '');
    const remember = data.get('remember') != null;
    const savedAccount = NATIVE.credAccount();

    if (!account) {
      snackbar('先填学号', { danger: true });
      return;
    }
    // 密码留空 = 用已保存的那份（原生从 Keystore 取，网页永远拿不到明文）
    if (!password) {
      if (!NATIVE.credHas()) {
        snackbar('请填教务系统密码', { danger: true });
        return;
      }
      if (savedAccount && savedAccount !== account) {
        snackbar('换了学号，需要重新填一次密码', { danger: true });
        return;
      }
    }

    // 明文只在这一次提交里出现：勾了就加密存本机，没勾就把旧的清掉
    if (remember && password) NATIVE.credSave(account, password);
    if (!remember) NATIVE.credClear();

    form.reset(); // 别让密码留在 DOM 里
    startGrabFlow(account, password);
    return;
  }

  if (form.dataset.action === 'cred-save') {
    event.preventDefault();
    const data = new FormData(form);
    const account = String(data.get('account') || '').trim();
    const password = String(data.get('password') || '');
    if (!account || !password) {
      snackbar('学号和密码都要填', { danger: true });
      return;
    }
    if (!NATIVE.credSave(account, password)) {
      snackbar('保存失败：这台设备不支持加密存储', { danger: true });
      return;
    }
    form.reset();
    snackbar('已加密保存（只在这台手机上），可以点「更新课程表」了', { duration: 4200 });
    scheduleRender();
    return;
  }
  if (form.dataset.action !== 'semester-save') return; // sheet 表单由 components.sheet 自己处理
  event.preventDefault();
  const data = new FormData(form);
  const result = store.dispatch({
    type: 'SET_SEMESTER',
    payload: {
      semesterStartMonday: String(data.get('semesterStartMonday') || '') || null,
      totalWeeks: Number(data.get('totalWeeks')),
      hasOddEvenWeek: data.get('hasOddEvenWeek') === '1'
    }
  });
  if (!result.ok) snackbar(result.errors[0] || '保存失败', { danger: true });
  else snackbar('学期配置已保存');
  scheduleRender();
});

/* ---------------------------------------------------------------- 启动 */

/* ---------------------------------------------------------------- 更新课表（自动抓取 → 差异 → 确认） */

/** 失败原因 → 页面文案（页面里也有一份同样的表，这里用于 snackbar 快速反馈）。 */
const UPDATE_ERROR_TEXT = {
  bad_credentials: '账号或密码可能已变更，自动登录失败；本地课表未改动',
  timeout: '自动抓取超时；本地课表未改动',
  no_form: '学校登录页结构变了，找不到登录框；本地课表未改动',
  no_timetable: '登录后没找到课表页；本地课表未改动',
  read_failed: '抓取结果读取失败；本地课表未改动',
  parse_failed: '抓到的页面解析失败；本地课表未改动',
  unknown: '自动更新失败；本地课表未改动'
};

/* ---------------------------------------------------------------- 后台自动抓取（1.15.0） */

let grabTicker = 0;

/**
 * 开始一次抓取。
 *
 * 任务号由**网页**生成并立刻用来建状态：原生可能过几秒才回第一个事件，
 * 这期间用户已经在盯着界面了；没有一个自己的 id，一条"上一次抓取"的迟到事件
 * 就能把这次的状态搞乱（进度条从 60% 跳回 10%）。
 */
function startGrabFlow(account, password) {
  // 联网读教务账号之前必须拿到明确同意：这是「个人信息收集」那条声明唯一的落点。
  // 暂缓期也照样问（force），否则就变成"点了暂不还能静默联网"。
  if (!privacyAccepted()) {
    maybeAskPrivacy({ force: true, onAccept: () => startGrabFlow(account, password) });
    return;
  }

  if (!NATIVE.grabSupported()) {
    const id = NATIVE.newGrabId();
    uiState.grab = applyGrabEvent(
      createGrab(id, Date.now()),
      { type: 'error', id, code: 'unsupported' },
      Date.now()
    );
    scheduleRender();
    return;
  }

  const id = NATIVE.newGrabId();
  uiState.grab = createGrab(id, Date.now());
  // 上一轮的东西先清掉：这次抓到的内容才是要审的
  uiState.parseDraft = null;
  uiState.updateDraft = null;
  uiState.updateDiff = null;
  uiState.updateError = null;

  if (!NATIVE.startGrab(id, account, password)) {
    uiState.grab = applyGrabEvent(
      uiState.grab,
      { type: 'error', id, code: 'unknown', detail: '原生没有接手这次任务' },
      Date.now()
    );
  }
  syncGrabTicker();
  scheduleRender();
}

/** 原生推来的进度 / 失败。三条铁律（单调、终态、id）都在 applyGrabEvent 里。 */
function onGrabEvent(event) {
  const prev = uiState.grab;
  const next = applyGrabEvent(prev, event, Date.now());
  if (next === prev) return; // 被挡掉的事件：终态之后、或不属于本次任务
  const wasRunning = grabIsRunning(prev);
  uiState.grab = next;

  if (next.status === 'failed' && wasRunning && next.error !== 'cancelled') {
    snackbar(`没抓成：${grabErrorInfo(next.error).title}`, { danger: true, duration: 4200 });
  }
  syncGrabTicker();
  scheduleRender();
}

/**
 * 抓取成功：把 HTML 解析成草稿。
 *
 * 本地已有课表 → 去「变更确认」只列差异；本地是空的 → 直接在导入页展示全量课程。
 * 两条路都不直接写 settings，用户点「确认」才落库。
 */
function onGrabResult(id, payload) {
  const grab = uiState.grab;
  // grab 为 null 说明页面刚重载过（原生还在跑），这种结果要接住，不能白抓一次
  if (grab && String(id) !== grab.id) return; // 迟到的上一次结果
  if (grab && grab.status !== 'running') return; // 已取消 / 已超时

  if (grab) {
    uiState.grab = applyGrabEvent(
      grab,
      { type: 'progress', id, step: 'parse', percent: 88, text: '正在解析课程…' },
      Date.now()
    );
    scheduleRender();
  }

  const state = store.getState();
  const picked = NATIVE.pickCaptureDraft(payload && payload.candidates, {
    totalWeeks: state.settings.totalWeeks,
    periods: state.settings.periods
  });
  const draft = picked.draft;
  if (!draft || !Array.isArray(draft.sessions) || !draft.sessions.length) {
    settleGrabFailed(id, 'parse_failed');
    return;
  }

  // 表头日期（`周一 08-31` + 第1周）比"当前第 N 周"硬，读得到就用它
  const guess = SEM.detectSemesterStart(payload);
  if (guess) {
    draft.semester = {
      code: (draft.semester && draft.semester.code) || guess.term || null,
      firstMonday: guess.startMonday,
      source: 'header',
      confirmed: true,
      note: guess.source
    };
  }

  // 原文留一份：想逐条核对、或转去手动通道时都有据可查
  uiState.importChannel = 'html';
  uiState.importSource = 'jwgl';
  uiState.importText = picked.html && picked.html.length <= NATIVE.TEXTAREA_LIMIT ? picked.html : '';
  uiState.keepParseDraft = true;
  uiState.parseDraft = draft;
  uiState.semesterApplied = null;
  // ★ 自动抓取也算"原生抓取"：置位后导入页才会显示「学期起始周」卡片
  //   （不置位的话，即便识别出来了，用户也看不到，只会觉得"没抓起始周"）
  uiState.nativeCaptureSeen = true;
  uiState.semesterGuess = semesterGuessFrom(draft.semester, guess);

  const hasLocal = Array.isArray(state.sessions) && state.sessions.length > 0;
  if (!hasLocal) {
    settleGrabDone(id);
    navigate('#/import');
    scheduleRender();
    snackbar(`已抓取 ${draft.sessions.length} 个课次，核对无误后点「确认导入」`, { duration: 4600 });
    return;
  }

  const diff = diffTimetables(state, draft);
  if (!diff.summary.total) {
    // 新课表一门课都没认出来 → 是对比失败，不是"课全被删了"
    settleGrabFailed(id, 'no_timetable');
    return;
  }
  uiState.updateDraft = draft;
  uiState.updateDiff = diff;
  uiState.updateError = null;
  settleGrabDone(id);
  navigate('#/import/update');
  scheduleRender();
}

/** 学期识别结论 → 导入页卡片用的形状（与 applyNativeCapture 保持一致）。 */
function semesterGuessFrom(sem, guess) {
  if (!sem || !sem.firstMonday) return null;
  return {
    startMonday: sem.firstMonday,
    week: guess ? guess.week : null,
    source: sem.note || (sem.source === 'calendar' ? '内置校历' : '学期代码'),
    strong: !!sem.confirmed,
    term: sem.code || null
  };
}

function settleGrabDone(id) {
  uiState.grab = applyGrabEvent(uiState.grab, { type: 'done', id }, Date.now());
  syncGrabTicker();
}

function settleGrabFailed(id, code) {
  uiState.grab = applyGrabEvent(uiState.grab, { type: 'error', id, code }, Date.now());
  syncGrabTicker();
}

function syncGrabTicker() {
  const running = grabIsRunning(uiState.grab);
  if (running && !grabTicker) {
    grabTicker = setInterval(tickGrab, 1000);
    return;
  }
  if (!running && grabTicker) {
    clearInterval(grabTicker);
    grabTicker = 0;
  }
}

/**
 * 每秒一次：让"已用 12 秒"真的在跳；顺带做前端自己的看门狗。
 *
 * 原生有 60 秒硬超时，但如果进程被杀 / 隐藏 WebView 崩了，一条事件都不会来，
 * 页面就会永远停在 40% 转圈。这里 75 秒没结果就自己判超时，并且明确告诉用户
 * "本地课表没动、可以重试或手动抓取"。
 */
function tickGrab() {
  const grab = uiState.grab;
  if (!grabIsRunning(grab)) {
    syncGrabTicker();
    return;
  }
  if (grabIsStalled(grab, Date.now())) {
    uiState.grab = applyGrabEvent(
      grab,
      { type: 'error', id: grab.id, code: 'timeout', detail: '75 秒没有收到任何结果' },
      Date.now()
    );
    NATIVE.cancelGrab();
    syncGrabTicker();
    scheduleRender();
    return;
  }
  // 只在导入页刷新秒数，别的页面不打断用户
  if (currentRoute.name === 'import') scheduleRender();
}

/** 抓取失败：只记错误并跳到确认页，**绝不动本地数据**。 */
function failUpdate(code) {
  uiState.updateDraft = null;
  uiState.updateDiff = null;
  uiState.updateError = code || 'unknown';
  navigate('#/import/update');
  render();
  snackbar(UPDATE_ERROR_TEXT[uiState.updateError] || UPDATE_ERROR_TEXT.unknown, { danger: true, duration: 5000 });
}

/**
 * 自动抓取回来的 payload → 解析 → 与本地比对 → 进确认页。
 * 任何一步不成立都走 failUpdate（本地数据保持原样）。
 */
function handleUpdatePayload(b64) {
  let payload = null;
  try {
    payload = JSON.parse(NATIVE.decodePayload(b64));
  } catch (err) {
    failUpdate('parse_failed');
    return;
  }

  const state = store.getState();
  const picked = NATIVE.pickCaptureDraft(payload && payload.candidates, {
    totalWeeks: state.settings.totalWeeks,
    periods: state.settings.periods
  });
  const draft = picked.draft;
  if (!draft || !Array.isArray(draft.sessions) || !draft.sessions.length) {
    failUpdate('parse_failed');
    return;
  }

  // 学期识别照旧挂上，但**不写 settings**（要等用户确认应用变更）
  const guess = SEM.detectSemesterStart(payload);
  if (guess) {
    draft.semester = {
      code: (draft.semester && draft.semester.code) || guess.term || null,
      firstMonday: guess.startMonday,
      source: 'header',
      confirmed: true,
      note: guess.source
    };
  }

  const diff = diffTimetables(state, draft);
  if (!diff.summary.total) {
    // 新课表里一门课都没识别出来 —— 这是"对比失败"，不是"课全删了"
    failUpdate('no_timetable');
    return;
  }

  uiState.updateDraft = draft;
  uiState.updateDiff = diff;
  uiState.updateError = null;
  navigate('#/import/update');
  render();
  if (!diff.hasChanges) snackbar('课表没有变化，已是最新', { duration: 3600 });
}

/* ---------------------------------------------------------------- 原生提醒排程 */

let nativeAlarmTimer = 0;
/** 小组件同步的防抖句柄（与提醒分开：两者的可用性判断不一样）。 */
let widgetSyncTimer = 0;

/**
 * 把未来 7 天的提醒点推给安卓原生排程（AlarmManager）。
 *
 * 为什么不能只靠页面定时器：App 一切后台或被清理，页面里的 setTimeout 就没了；
 * 原生闹钟由系统守护，锁屏、杀进程都能响——这才是 ColorOS 上"提醒真的会到"的办法。
 */
function syncNativeAlarms() {
  if (!NATIVE.notifySupport()) return 0;
  const state = store.getState();
  const now = Date.now();
  const from = todayStr(now);
  const to = todayStr(now + 7 * 86400000);
  let points = [];
  try {
    points = (getReminders(state, from, to) || {}).points || [];
  } catch (err) {
    points = [];
  }
  return NATIVE.scheduleReminders(points, { now, horizonDays: 7 });
}

/** 数据/设置一变就重排，但 800ms 内多次变更只排一次（开关连点会连发 dispatch）。 */
function scheduleNativeAlarmsSoon() {
  if (!NATIVE.notifySupport()) return;
  if (nativeAlarmTimer) clearTimeout(nativeAlarmTimer);
  nativeAlarmTimer = setTimeout(() => {
    nativeAlarmTimer = 0;
    syncNativeAlarms();
  }, 800);
}

/* ---------------------------------------------------------------- 桌面小组件 */

/**
 * 把"接下来两周每天有什么课"推给原生，桌面小组件从那里取数。
 *
 * 全部按 calendar.resolveDay 的结论走——调课、补课、放假、补班都不用在这里重复判断，
 * 否则小组件和 App 里显示的课表迟早会对不上。
 */
function syncWidgetNow() {
  if (!NATIVE.widgetSupport()) return false;
  return NATIVE.syncWidget(buildWidgetPayload(store.getState()));
}

/** 与提醒同样的防抖：改一次课表会连发好几条 dispatch，没必要每条都推一遍。 */
function syncWidgetSoon() {
  if (!NATIVE.widgetSupport()) return;
  if (widgetSyncTimer) clearTimeout(widgetSyncTimer);
  widgetSyncTimer = setTimeout(() => {
    widgetSyncTimer = 0;
    syncWidgetNow();
  }, 1000);
}

/* ---------------------------------------------------------------- 原生抓取回灌 */

/**
 * Android 壳把教务系统课表页的 HTML 带回来了 → 走与「HTML 源码」通道完全相同的解析。
 *
 * payload: { url, title, at, candidates:[{label, html}], signals:{weekAnchor} }
 *
 * 学期起始周在这里只**挂到草稿上**（draft.semester），真正写入 settings 是在
 * 「确认导入」时由 ui/import.js 的 applyDetectedSemester 完成——用户取消导入就不该改设置。
 */
function applyNativeCapture(payload) {
  const state = store.getState();
  const picked = NATIVE.pickCaptureDraft(payload && payload.candidates, {
    totalWeeks: state.settings.totalWeeks,
    periods: state.settings.periods
  });
  const draft = picked.draft;
  const ok = !!(draft && draft.sessions.length);

  // 表头日期（`周一 08-31` + `第1周`）比"当前第 N 周"文本硬，能读到就用它覆盖内置校历的结论
  const guess = SEM.detectSemesterStart(payload);
  if (guess && ok) {
    draft.semester = {
      code: (draft.semester && draft.semester.code) || guess.term || null,
      firstMonday: guess.startMonday,
      source: 'header',
      confirmed: true,
      note: guess.source
    };
  }
  const sem = draft && draft.semester ? draft.semester : null;

  uiState.importChannel = 'html';
  uiState.importSource = 'jwgl';
  uiState.keepParseDraft = true;
  uiState.parseDraft = ok ? draft : null;
  uiState.importText =
    picked.html && picked.html.length <= NATIVE.TEXTAREA_LIMIT ? picked.html : '';
  uiState.nativeCaptureSeen = true;
  uiState.semesterApplied = null;
  uiState.semesterGuess =
    sem && sem.firstMonday
      ? {
          startMonday: sem.firstMonday,
          week: guess ? guess.week : null,
          source: sem.note || (sem.source === 'calendar' ? '内置校历' : '学期代码'),
          strong: !!sem.confirmed,
          term: sem.code || null
        }
      : null;

  navigate('#/import');
  render();

  if (ok) {
    const tail = sem && sem.firstMonday ? `；学期第 1 周周一 ${sem.firstMonday}` : '';
    snackbar(`已抓取 ${draft.sessions.length} 个课次，核对无误后点「确认导入」${tail}`, {
      duration: 4600
    });
  } else {
    snackbar('没从抓取到的页面里解析出课表：源码已填在下方，可手动核对，或改用「粘贴文本」', {
      danger: true,
      duration: 5200
    });
  }
}

async function boot() {
  showFileProtocolWarning();
  registerServiceWorker();

  // Android 壳：注册抓取结果回灌出口（浏览器里是空操作）
  NATIVE.installNativeBridge(applyNativeCapture);
  // 后台自动抓取的三个出口：进度/失败走 event，结果走 result（base64）
  NATIVE.installGrabBridge({ onEvent: onGrabEvent, onResult: onGrabResult });
  // 「更新课表」的两条回传通道（原生侧调用；浏览器里没人调，挂了也无副作用）
  window.__buptUpdatePayload = (b64) => handleUpdatePayload(b64);
  window.__buptAutoCaptureError = (code) => failUpdate(code);

  store.subscribe(() => scheduleRender());

  // 长按课表块 → 拖到本周其他时段（只改被拖的那一天，不动其它周次/日期）
  installBlockDrag({ onDrop: applyBlockMove });

  /**
   * 返回手势 / 返回键：**先把最上层的弹层收掉**，而不是换页或退出应用。
   *
   * 真机反馈（2026-10-26）：弹层开着时从屏幕左边缘右滑，应用直接退了 ——
   * 因为返回被当成"没有上一页"处理。弹层是浮在页面之上的，返回语义应该是"关掉它"。
   *
   * @returns {boolean} true = 这次返回被弹层吃掉了，调用方不要再换页/退出
   */
  function dismissTopModal() {
    const dialogHost = document.getElementById('dialog-host');
    if (dialogHost && dialogHost.classList.contains('is-open')) {
      // 隐私弹层和 confirmDialog 共用 dialog-host：前者要按"暂不"收，后者要 resolve(false)
      if (dialogHost.querySelector('[data-privacy]')) dismissPrivacyGate();
      else resolveDialog(false);
      return true;
    }
    const sheetHost = document.getElementById('sheet-host');
    if (sheetHost && sheetHost.classList.contains('is-open')) {
      closeSheet();
      return true;
    }
    const pickerHost = document.getElementById('picker-host');
    if (pickerHost && pickerHost.classList.contains('is-open')) {
      closePicker();
      return true;
    }
    const guide = document.getElementById('guide-host');
    if (guide && guide.innerHTML.trim()) {
      closeNotifyGuide();
      return true;
    }
    return false;
  }

  // 原生 onBackPressed 先问这里：返回 true 就说明"这次返回被弹层用掉了"
  window.__buptDismissModal = () => dismissTopModal();

  // 系统返回键 / history.back() 会先发 popstate 再发 hashchange：借它区分"回退"与"新跳转"
  window.addEventListener('popstate', () => {
    routeFromHistory = true;
  });

  window.addEventListener('hashchange', () => {
    uiState.weekOffset = currentWeekOffset(store.getState());
    // 原生抓取回灌会先写好 parseDraft 再 navigate，这条 hashchange 不能把它清掉
    if (uiState.keepParseDraft) uiState.keepParseDraft = false;
    else uiState.parseDraft = null;
    render();
  });

  // 演示用：?demo=1 且本地无数据时自动载入示例课表（便于评审截图）
  const params = new URLSearchParams(window.location.search);
  if (params.get('demo') === '1' && !store.getState().sessions.length) {
    loadSample();
  }

  // 首屏就落在「今天所在的那一周」，而不是开学第一周
  uiState.weekOffset = currentWeekOffset(store.getState());

  render();

  // ★ 装完第一次打开：先说清数据怎么处理，再列"该开的开关"。
  //   隐私说明不阻断本机功能（选「暂不」照样能看课表），真正要拦的是联网抓取，
  //   那一步在导入页单独检查（见 startGrabFlow）。
  //
  //   ★ 三层弹层必须有先有后才不叠：隐私说明（DOM）→ 引导（DOM）→ 后台运行（原生 AlertDialog）。
  //     引导里已经包含通知 / 精确闹钟 / 电池三项，所以引导弹了就不该再弹原生那个框。
  const afterPrivacy = () => {
    if (!maybeShowOnboard()) NATIVE.askBackground();
  };
  if (!maybeAskPrivacy({ onAccept: afterPrivacy })) afterPrivacy();
  // 从系统设置返回时刷新引导里的状态
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshOnboard();
  });

  // 从系统「修改后台运行模式」页返回时，重画这一页：
  // 用户刚改完设置，豁免状态和落点提示都可能变了，不重画就等于让用户看旧结论。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (currentRoute.name === 'reminder' && currentRoute.sub === 'battery-mode') scheduleRender();
  });

  // ★ 从系统设置返回：按机型查一遍"还差哪项"，通知还没问过就直接拉系统权限框。
  //   延后 600ms 是因为 visible 触发时系统页往往还没完全退场，
  //   此刻读到的权限状态可能还是旧的（真机上踩过：刚授权完读回来还是 denied）。
  //
  //   两条触发路径都走这里：网页的 visibilitychange + 原生 onResume 回调。
  //   WebView 里前者不一定派发，后者一定有；pending 只会被消费一次，不会重复弹。
  window.__buptResume = () => {
    setTimeout(() => {
      runReturnCheck();
    }, 600);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    window.__buptResume();
  });

  // 安卓壳：提醒排进系统闹钟；权限弹窗回来后自动刷新并重排
  if (NATIVE.notifySupport()) {
    window.__buptNotifyPermissionChanged = () => {
      scheduleRender();
      syncNativeAlarms();
      // ★ 系统权限窗口关掉之后，才继续「开启通知」的第二步：跳系统设置页
      onPermissionResult();
    };
    syncNativeAlarms();
    store.subscribe(scheduleNativeAlarmsSoon);
  }

  // 安卓壳：桌面小组件（浏览器里 widgetSupport() 恒 false，这一段等于不存在）
  if (NATIVE.widgetSupport()) {
    syncWidgetNow();
    store.subscribe(syncWidgetSoon);
    // 回到前台时再推一次：用户很可能刚在别的页面改完课表又切回来加小组件
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncWidgetSoon();
    });
  }

  // 首启引导：既没课表也没学期配置时给一句提示（空态里已有主按钮）
  // ★ 弹层（隐私说明 / 对话框）开着的时候不要冒出来：snackbar 的 z-index 高于 dialog，
  //   会正好压在弹层的按钮上，看着像按钮上多了一条黑条。
  const state = store.getState();
  if (!state.sessions.length && !state.settings.semesterStartMonday) {
    const tipFirstRun = () => {
      if (store.getState().sessions.length) return;
      // 弹层不止 #dialog-host 一处：引导（#onboard-host 里的 .ob-dialog）也盖在最上面，
      // 而且它的 z-index 比 snackbar 低，所以提示条会直接糊在对话框内容上。
      const dialogOpen = document.getElementById('dialog-host');
      const onboardHost = document.getElementById('onboard-host');
      const busy =
        (dialogOpen && dialogOpen.classList.contains('is-open')) ||
        (onboardHost && onboardHost.innerHTML.trim() !== '');
      if (busy) {
        setTimeout(tipFirstRun, 1500);
        return;
      }
      snackbar('第一次用？可以先「先看示例课表」体验，或直接导入', { duration: 4200 });
    };
    setTimeout(tipFirstRun, 900);
  }

  maybeTipDrag();

  // 假期临近的「调休确认」：启动后稍等一下再问，别和首屏渲染 / 首启引导抢同一秒
  setTimeout(() => maybePromptMakeup(store), 1100);

  // 提醒调度：定时器留在页面，到点调 SW 的 showNotification
  if (isSecureContextLike()) {
    startScheduler({
      getState: store.getState,
      prefs: () => store.getState().settings.reminder,
      notify: (evt) => {
        if (evt.type === 'REMINDER_FIRED') {
          snackbar(`${evt.point.title}：${evt.point.body}`, { duration: 4000 });
          scheduleRender();
        } else if (evt.type === 'REMINDER_BLOCKED') {
          // 不打断用户：只在提醒页提示（权限卡已有状态）
          if (currentRoute.name === 'reminder') scheduleRender();
        }
      },
      onDayChange: () => {
        uiState.dayDate = null;
        // 跨零点要重新锚到"今天所在的那一周"，否则第二天还停在昨天那周
        uiState.weekOffset = currentWeekOffset(store.getState());
        scheduleRender();
      },
      onPlan: (info) => {
        uiState.pendingDates = info.pendingDates || [];
      },
      onTick: () => {
        // 每分钟只刷新课表页的红线与今日概览；弹层打开时不要打断
        const sheetHost = document.getElementById('sheet-host');
        const sheetOpen = sheetHost && sheetHost.classList.contains('is-open');
        if (!sheetOpen && (currentRoute.name === 'timetable' || currentRoute.name === 'detail')) {
          scheduleRender();
        }
      }
    });

    // 数据变化后重排提醒（例如刚导入 / 刚调课）
    let lastSignature = '';
    store.subscribe(() => {
      const s = store.getState();
      const signature = [
        s.sessions.length,
        s.adjustments.length,
        s.settings.reminder.defaultAdvanceMinutes,
        s.settings.reminder.enabled,
        s.settings.reminder.rules.length,
        s.settings.skipOnHoliday,
        s.settings.totalWeeks,
        s.settings.semesterStartMonday
      ].join('|');
      if (signature === lastSignature) return;
      lastSignature = signature;
      try {
        replan({ getState: store.getState, prefs: () => s.settings.reminder, notify: () => undefined });
      } catch (err) {
        /* 忽略 */
      }
    });
  }

  // 每 30s 一次的轻量自检：跨零点由 reminder.js 的 TICK 负责，这里只处理"夏令时无关"的兜底
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void todayStr();
  }, 30000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void boot();
  });
} else {
  void boot();
}

// 暴露少量调试入口（浏览器 Console 可用，不影响生产逻辑）
window.__buptApp = {
  store,
  uiState,
  render,
  getReminders,
  minutesOfDay,
  isDateStr,
  openSlotSheet,
  openMakeupPrompt,
  maybePromptMakeup,
  // 抓取结果的入口：截图页与手工排查会直接喂一份 payload，不必真跑一次内网抓取
  onGrabResult
};
