/**
 * ui/onboard.js — 首次启动的权限引导（一次性）。
 *
 * 装完第一次打开就弹一次，把「通知 / 精确闹钟 / 电池优化 / 流体云」列齐：
 * 每项显示**原生读到的真实状态**，缺的给一个「去开启」直接跳系统页。
 * 点「稍后再说」也算做过引导；以后想复查走「提醒 → 权限一键检查」。
 */

import {
  NOTIFY_MANUAL_ITEMS,
  buildSteps,
  landingGuideText,
  pendingCount,
  requiredPending
} from '../permissions.js';
import * as NATIVE from '../native.js';
import { jumpToNotifyPermissionPage, startNotifyFlow } from './notifyGuide.js';
import { batteryModeCardHtml, openSystemBatteryPage } from './batteryMode.js';
import { armReturnCheck } from './returnCheck.js';
import { detectBrand } from '../keepalive.js';
import { escapeHtml } from './components.js';

const DONE_KEY = 'bupt_onboard_v1';
/** 厂商那层「耗电行为控制」系统读不到，只能等用户说"我改好了"再记住。 */
const BATTERY_KEY = 'bupt_battery_confirmed_v1';

function batteryConfirmed() {
  try {
    return window.localStorage.getItem(BATTERY_KEY) === '1';
  } catch (err) {
    return false;
  }
}

function setBatteryConfirmed() {
  try {
    window.localStorage.setItem(BATTERY_KEY, '1');
  } catch (err) {
    /* 写不进去也不影响本次会话 */
  }
}

function readFlag() {
  try {
    return window.localStorage.getItem(DONE_KEY) === '1';
  } catch (err) {
    return false;
  }
}

/**
 * 必开项是否全部就绪（提醒页据此把「后台运行」那组入口收起来）。
 *
 * 复用 buildSteps + requiredPending 的判定，避免提醒页自己再写一套口径 ——
 * 两处判断不一致的话，会出现"引导说开好了、提醒页还在催"的鬼故事。
 */
export function checklistReady() {
  const steps = buildSteps(NATIVE.permissionSnapshot(), { batteryConfirmed: batteryConfirmed() });
  return requiredPending(steps).length === 0;
}

/** 引导是否已经做过（用户点过"稍后再说"或"开始用"）。 */
export function onboardDone() {
  return readFlag();
}

export function markOnboardDone() {
  try {
    window.localStorage.setItem(DONE_KEY, '1');
  } catch (err) {
    /* 隐私模式写不进去就下次再问，不影响功能 */
  }
}

/** data-ob-action → 具体动作（返回 true 表示"离开了本页"，需要关掉引导）。 */
const ACTIONS = {
  'onboard-notify': () => {
    // ★ 先弹系统权限窗口；用户在窗口里点完，回调里才跳系统设置页并展开清单
    startNotifyFlow({
      onAfter: (landing) => {
        lastLanding = landing || 'none';
        dialogKind = 'notify';
        paint();
      }
    });
    return 'handled';
  },
  'onboard-exact': () => {
    armReturnCheck('exact');
    return NATIVE.openExactAlarmSettings();
  },
  'onboard-battery': () => NATIVE.openBatterySettings(),
  'onboard-keepalive': () => {
    window.location.hash = '#/reminder/keepalive';
    // 用专门的标记表示"离开了本页"：原生接口多数返回 true 表示"已处理"，
    // 拿 true 当离开信号会把用户还没点完的引导直接关掉（踩过）。
    return 'navigate';
  }
};

let onCloseCallback = null;
let bound = false;
/** 当前打开的 App 内确认框：null | 'battery' | 'notify' | 'notify-intro' */
let dialogKind = null;
/** 一次性提示（如"已打开通知设置"），显示在卡片底部 */
let lastHint = '';
/** 上次跳通知设置的落地级别（用于确认框顶部那句话） */
let lastLanding = 'none';
/** 跳「后台运行模式」后的落点提示 */
let batteryHint = '';

function host() {
  return typeof document === 'undefined' ? null : document.getElementById('onboard-host');
}

function rowHtml(step) {
  const badge =
    step.kind === 'info'
      ? '<span class="ob-badge is-info">看路径</span>'
      : step.ok
        ? '<span class="ob-badge is-ok">已开启</span>'
        : '<span class="ob-badge is-miss">未开启</span>';
  const showBtn = !(step.ok && step.kind === 'check');
  return `<div class="ob-item${step.ok ? ' is-ok' : ''}" data-ob-key="${escapeHtml(step.key)}">
    <div class="ob-main">
      <div class="ob-title"><span>${escapeHtml(step.title)}</span>${badge}</div>
      <div class="ob-desc">${escapeHtml(step.desc)}</div>
    </div>
    ${
      showBtn
        ? `<button type="button" class="btn btn-sm ${step.ok ? 'btn-ghost' : 'btn-soft'}"
             data-ob-action="${escapeHtml(step.action || '')}">${escapeHtml(step.cta)}</button>`
        : ''
    }
  </div>`;
}

/** App 内确认框（不跳设置页，先把"会发生什么"讲清楚）。 */
function dialogHtml() {
  if (!dialogKind) return '';
  if (dialogKind === 'battery') {
    // ★ 内容与 `#/reminder/battery-mode` 页共用同一份（ui/batteryMode.js），
    //   避免"从引导进来"和"从提醒页进来"看到两套说法。
    return `<div class="ob-dmask"></div>
      <div class="ob-dialog ob-dialog-wide" role="dialog" aria-modal="true">
        <h3>修改后台运行模式</h3>
        <div class="ob-dbody">${batteryModeCardHtml({ compact: true, hint: batteryHint })}</div>
        <div class="ob-dacts">
          <button type="button" class="btn btn-primary" data-obd="battery-mode">去开耗电管理</button>
          <button type="button" class="btn btn-soft" data-obd="battery-done">我已开好</button>
        </div>
        <button type="button" class="btn btn-ghost btn-block" style="margin-top:8px" data-obd="close">稍后再说</button>
      </div>`;
  }
  if (dialogKind === 'notify-intro') {
    return `<div class="ob-dmask"></div>
      <div class="ob-dialog" role="dialog" aria-modal="true">
        <h3>要开 4 项通知，才能准时提醒</h3>
        <p>这些开关都在<b>系统设置</b>里（应用不能代你开）。点「去设置」我会把你送到
          「通知与控制中心」，在那一页底部点「应用通知设置」→「北邮课程表」，按下面几项打开即可。</p>
        <ol class="ng-list">${NOTIFY_MANUAL_ITEMS.map(
          (it, i) => `<li class="ng-item">
            <span class="ng-idx">${i + 1}</span>
            <span class="ng-main">
              <span class="ng-title">${escapeHtml(it.title)}</span>
              <span class="ng-where">${escapeHtml(it.where)}</span>
            </span>
          </li>`
        ).join('')}</ol>
        <div class="ob-dacts">
          <button type="button" class="btn btn-primary" data-obd="notify-go">去设置</button>
          <button type="button" class="btn btn-soft" data-obd="notify-cancel">以后再说</button>
        </div>
      </div>`;
  }

  if (dialogKind === 'notify') {
    return `<div class="ob-dmask"></div>
      <div class="ob-dialog" role="dialog" aria-modal="true">
        <h3>在系统设置里打开这几项</h3>
        <p>${escapeHtml(
          lastLanding === 'center'
            ? '已打开「通知与控制中心」：点页面底部「应用通知设置」→「北邮课程表」，再按下面几项打开。'
            : landingGuideText(lastLanding, detectBrand(NATIVE.deviceBrand()))
        )}</p>
        <p class="ng-tip">开关是<b>灰的</b>？先返回上一层把「允许通知」打开。</p>
        <ol class="ng-list">${NOTIFY_MANUAL_ITEMS.map(
          (it, i) => `<li class="ng-item">
            <span class="ng-idx">${i + 1}</span>
            <span class="ng-main">
              <span class="ng-title">${escapeHtml(it.title)}</span>
              <span class="ng-where">${escapeHtml(it.where)}</span>
              <span class="ng-why">${escapeHtml(it.why)}</span>
            </span>
          </li>`
        ).join('')}</ol>
        <div class="ob-dacts">
          <button type="button" class="btn btn-primary" data-obd="notify-done">我已经开好了</button>
          <button type="button" class="btn btn-soft" data-obd="notify-again">再打开一次</button>
        </div>
      </div>`;
  }

  // 只有上面几种；走到这里说明 dialogKind 是脏值，不渲染
  return '';
}

/** 重画（读最新状态）。 */
function paint() {
  const el = host();
  if (!el) return;
  const steps = buildSteps(NATIVE.permissionSnapshot(), { batteryConfirmed: batteryConfirmed() });
  const pending = pendingCount(steps);
  const mustDo = requiredPending(steps);
  const blocked = mustDo.length > 0;
  const nextStep = blocked ? mustDo[0] : null;

  el.innerHTML = `
    <div class="ob-mask"></div>
    <div class="ob-card" role="dialog" aria-modal="true" aria-label="提醒权限设置">
      <div class="ob-head">
        <h2>${blocked ? '先把这几项开好' : '都开好了 👍'}</h2>
        <p class="ob-sub">${
          blocked
            ? `还差 <b>${mustDo.length}</b> 项，点右边按钮逐项打开。`
            : '都开好了，课前会正常提醒。以后可在「提醒 → 权限一键检查」复查。'
        }</p>
      </div>
      <div class="ob-list">${steps.map(rowHtml).join('')}</div>
      <div class="ob-foot">
        ${
          blocked
            ? `<button type="button" class="btn btn-primary btn-block" data-ob-next="${escapeHtml(
                nextStep.action || ''
              )}">
                 还差 ${mustDo.length} 项 · 去开${escapeHtml(nextStep.title)}
               </button>
               <p class="tiny muted" style="margin:8px 0 0">
                 不影响看课表，只是<b>提醒可能不响</b>。这些开关只能在系统设置里开。
               </p>
               <button type="button" class="ob-skip" data-ob-skip="1">
                 先看课表
               </button>`
            : `<button type="button" class="btn btn-primary btn-block" data-ob-close="1">开始用</button>
               <p class="tiny muted" style="margin:8px 0 0">
                 以后可在「提醒 → 权限一键检查」复查。
               </p>`
        }
      </div>
      ${lastHint ? `<p class="ob-hint">${escapeHtml(lastHint)}</p>` : ''}
      ${dialogHtml()}
    </div>`;
}

function onClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  /* ---------- ① App 内确认框里的按钮 ---------- */
  const dbtn = target.closest('[data-obd]');
  if (dbtn) {
    event.preventDefault();
    const act = dbtn.dataset.obd;
    if (act === 'close') {
      dialogKind = null;
      paint();
      return;
    }
    if (act === 'app-settings') {
      NATIVE.openAppSettings();
      return;
    }
    if (act === 'battery-confirmed') {
      // 厂商那层读不到：用户说改好了就记住，清单才能归零
      setBatteryConfirmed();
      dialogKind = null;
      paint();
      return;
    }
    if (act === 'notify-cancel') {
      dialogKind = null;
      paint();
      return;
    }
    if (act === 'notify-go') {
      // ★ 只有这里会跳转，且与 notifyGuide 共用同一条链路
      lastLanding = jumpToNotifyPermissionPage();
      dialogKind = 'notify';
      paint();
      return;
    }
    if (act === 'notify-done') {
      // 不做检测：用户说开好了就收起，真没开全由真实的课前提醒暴露
      dialogKind = null;
      lastHint = '通知设置已按你的确认记下。漏开哪项，下一节课的提醒会暴露出来。';
      paint();
      return;
    }
    if (act === 'battery-mode') {
      // ★ 内容在弹层里已经讲清「必须选完全后台运行」，这里只负责跳过去
      armReturnCheck('battery');
      const r = openSystemBatteryPage();
      batteryHint = r.hint;
      paint();
      return;
    }
    if (act === 'battery-done') {
      // 不做检测：系统读不到 ColorOS 那层，用户说改好了就记下
      setBatteryConfirmed();
      dialogKind = null;
      batteryHint = '';
      lastHint = '已记录：后台运行改为「完全允许」。如果仍停在「智能优化」，课前提醒可能不响。';
      paint();
      return;
    }
    if (act === 'notify-again') {
      lastLanding = jumpToNotifyPermissionPage();
      paint();
      return;
    }
    return;
  }

  /* ---------- ② 点遮罩 / 关闭 ---------- */
  if (target.closest('[data-ob-close]')) {
    event.preventDefault();
    markOnboardDone();
    closeOnboard();
    lastHint = '';
    if (onCloseCallback) onCloseCallback();
    return;
  }
  if (target.closest('.ob-dmask')) {
    event.preventDefault();
    dialogKind = null;
    paint();
    return;
  }
  if (target.closest('.ob-mask') && !dialogKind) {
    // ★ 遮罩不关闭：必开项没齐时必须停在引导页（否则"点空白就走了"等于绕过）
    event.preventDefault();
    return;
  }

  /* ---------- ③ 行内「去设置 / 看路径」 ---------- */
  // 底部"还差 N 项 · 去开 xxx"
  const nextBtn = target.closest('[data-ob-next]');
  if (nextBtn) {
    event.preventDefault();
    const action = nextBtn.dataset.obNext;
    const handler = ACTIONS[action];
    if (handler) {
      const r = handler();
      if (r === 'navigate') {
        markOnboardDone();
        closeOnboard();
        return;
      }
      if (r === 'handled' || r === 'repaint') paint();
    }
    return;
  }

  // 逃生口：明确告知风险，二次确认才放行（否则用户可能被彻底锁在引导页）
  if (target.closest('[data-ob-skip]')) {
    event.preventDefault();
    const ok = window.confirm(
      '不开的话：课前提醒不会响，锁屏也看不到。\n\n以后可在「提醒 → 权限一键检查」补开。'
    );
    if (!ok) return;
    markOnboardDone();
    closeOnboard();
    return;
  }

  const btn = target.closest('[data-ob-action]');
  if (!btn) return;
  event.preventDefault();
  const action = btn.dataset.obAction;

  // 需要先解释清楚的两项：不跳系统页，先弹自己的确认框
  if (action === 'onboard-battery') {
    dialogKind = 'battery';
    paint();
    return;
  }

  const handler = ACTIONS[action];
  if (!handler) return;
  const leftPage = handler();
  if (leftPage === 'handled') return;
  if (leftPage === 'repaint') {
    paint();
    return;
  }
  if (leftPage === 'navigate') {
    markOnboardDone();
    closeOnboard();
    return;
  }
  // 系统设置页回来后再刷一次状态（用户可能刚点了"允许"）
  setTimeout(() => {
    if (host() && host().innerHTML.trim()) paint();
  }, 1500);
}

function bind() {
  const el = host();
  if (!el || bound) return;
  el.addEventListener('click', onClick);
  bound = true;
}

/**
 * 显示引导。
 * @param {{onClose?:Function}} [opts]
 */
export function showOnboard(opts = {}) {
  const el = host();
  if (!el) return;
  onCloseCallback = typeof opts.onClose === 'function' ? opts.onClose : null;
  bind();
  paint();
}

/** 从系统设置返回后调用：只刷新状态，不重建事件绑定。 */
export function refreshOnboard() {
  const el = host();
  if (!el || !el.innerHTML.trim()) return;
  paint();
}

export function closeOnboard() {
  const el = host();
  if (el) el.innerHTML = '';
}

/**
 * 启动时调用：没做过引导就在首屏画好之后弹一次。
 * @returns {boolean} 是否弹了
 */
export function maybeShowOnboard(opts = {}) {
  if (!NATIVE.isNativeApp()) return false;
  if (onboardDone()) return false;
  if (!NATIVE.permissionSnapshot()) return false;
  setTimeout(() => showOnboard(opts), 500);
  return true;
}
