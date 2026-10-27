/**
 * ui/notifyGuide.js — 「开启系统通知」的"确认 → 跳转"两段式。
 *
 * 交互（2026-10-25 第二轮定稿）——**先系统窗口、后页面**：
 *   ① 点「开启系统通知」→ 先弹**系统权限窗口**（"允许…发送通知？"）；
 *   ② 用户在该窗口点完「允许 / 不允许」后，`onRequestPermissionsResult` 会回调
 *      `window.__buptNotifyPermissionChanged` → 这时**才**跳「通知与控制中心」；
 *   ③ 同一条弹层随之切换成"你已经在设置页"的样子：4 项清单 + 「再打开一次」+「我已经开好了」。
 *
 * 【1.66.4 起不做检测】
 * 「我已经开好了」就是收起弹层，不再读系统状态。理由：
 * 横幅/锁屏没有查询 API，读到的开关状态和"到底会不会弹"并不等价，
 * 与其给一个半真半假的结论，不如让真实的课前提醒去暴露问题。
 *
 * 顺序是硬约束：**request 之后不许立刻跳**，只挂在权限回调上（否则页面一弹就把系统框顶掉）。
 * 已经授权 / 已被永久拒绝时系统不再弹窗 → 直接跳页面（此时"窗口"这一步客观上不存在）。
 *
 * 为什么不能点了就跳：直接甩到系统页，用户会懵（"我点了什么？这是哪？"）；
 * 先说明 + 征求确认，再跳，才是一次清楚的交接。
 * 为什么不用系统权限对话框：权限被永久拒绝后 `requestPermissions` 不再弹框；
 * 而且就算授了总权限，横幅/锁屏/流体云仍然默认关着，还是得去设置页手动开。
 */

import { NOTIFY_MANUAL_ITEMS, landingGuideText } from '../permissions.js';
import { detectBrand } from '../keepalive.js';
import * as NATIVE from '../native.js';
import { armReturnCheck } from './returnCheck.js';
import { escapeHtml } from './components.js';

let bound = false;
/** 'intro' = 只弹确认框；'landing' = 已跳转，显示落地指引 */
let phase = 'intro';
/** 系统权限窗口弹出后要执行的动作（等回调） */
let pendingAfterDialog = null;
/** 跳转落点（失败时给手动路径） */
let jumpOk = 'none';

function host() {
  return typeof document === 'undefined' ? null : document.getElementById('guide-host');
}

function listHtml() {
  return NOTIFY_MANUAL_ITEMS.map(
    (it, i) => `<li class="ng-item">
      <span class="ng-idx">${i + 1}</span>
      <span class="ng-main">
        <span class="ng-title">${escapeHtml(it.title)}</span>
        <span class="ng-where">${escapeHtml(it.where)}</span>
        <span class="ng-why">${escapeHtml(it.why)}</span>
      </span>
    </li>`
  ).join('');
}

/**
 * 跳到「设置 › 应用 › 北邮课程表 › 权限管理 › 通知」—— **所有按钮都走这一个函数**。
 *
 * 【落点是权限管理 → 通知，不是渠道页】
 * 这是用户明确要的那一页。渠道页（上课提醒）虽然开关更多，
 * 但它是"通知管理"里再点一层才到的，不属于这个入口。
 *
 * 【为什么以前会"跳错"】
 * 两个按钮走了两条不同的链路：
 *   「去设置」→ openNotificationPermissionPage() → 权限管理 / 通知
 *   「再打开一次」→ openNotificationSettingsEx() → 渠道页
 * 于是同一张卡片里，两次点击落到两个不同的页面，用户当然觉得跳错了。
 * 现在两个按钮共用这一个函数，落点恒定。
 *
 * 原生链路（见 MainActivity#openNotificationPermissionChain）：
 *   ① ColorOS 权限管理器（直达权限列表，通知就在里面）
 *   ② 标准「应用通知设置」页
 *   ③ 应用详情（ColorOS 在这里放「权限管理」入口）
 *
 * @returns {'perm'|'notify'|'detail'|'none'|'center'}
 */
function jumpToSettings() {
  // 回来时要复查通知权限（见 ui/returnCheck.js）
  armReturnCheck('notify');
  const landing = NATIVE.openNotificationPermissionPage();
  if (landing !== 'none') return landing;
  // 权限页链路全失败时，退回"通知与控制中心"至少给个能用的通知入口
  return NATIVE.openNotificationCenter() ? 'center' : 'none';
}

/**
 * 供其它入口复用：跳到「权限管理 › 通知」，把落点原样返回。
 *
 * ★ 引导弹层（onboard）里也有「去设置 / 再打开一次」两个按钮。
 *   它们以前各写一条链路（openNotificationCenter / openNotificationSettingsEx），
 *   结果同一件事跳三个不同的页面。现在全部改成调用这里，
 *   **整个 App 只有一条通知跳转链路**。
 */
export function jumpToNotifyPermissionPage() {
  return jumpToSettings();
}

function paint() {
  const el = host();
  if (!el) return;

  if (phase === 'intro') {
    el.innerHTML = `
      <div class="ob-mask"></div>
      <div class="ob-card ng-card" role="dialog" aria-modal="true" aria-label="开启通知">
        <div class="ob-head">
          <h2>开 4 项通知，提醒才会响</h2>
          <p class="ob-sub">
            开关都在系统设置里，应用不能代你开。点「去设置」直接到「权限管理 › 通知」。
          </p>
        </div>
        <ol class="ng-list">${listHtml()}</ol>
        <div class="ob-foot">
          <div class="ob-dacts">
            <button type="button" class="btn btn-primary" data-ng="go">去设置</button>
            <button type="button" class="btn btn-soft" data-ng="close">以后再说</button>
          </div>
          <p class="tiny muted" style="margin:8px 0 0">
            不去也能正常看课表，只是课前不会响铃、锁屏上也看不到提醒。
          </p>
        </div>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="ob-mask"></div>
    <div class="ob-card ng-card" role="dialog" aria-modal="true" aria-label="在系统设置里打开通知">
      <div class="ob-head">
        <h2>${jumpOk === 'none' ? '没能自动跳转' : '已打开系统设置'}</h2>
        <p class="ob-sub">${escapeHtml(landingGuideText(jumpOk, detectBrand(NATIVE.deviceBrand())))}</p>
        <p class="ob-sub ng-tip">开关是<b>灰的</b>？先返回上一层把「允许通知」打开。</p>
      </div>
      <ol class="ng-list">${listHtml()}</ol>
      <div class="ob-foot">
        <div class="ob-dacts">
          <button type="button" class="btn btn-primary" data-ng="done">我已经开好了</button>
          <button type="button" class="btn btn-soft" data-ng="again">再打开一次设置</button>
        </div>
        <p class="tiny muted" style="margin:8px 0 0">
          开完回来点「我已经开好了」。漏了哪项，下一节课的提醒会暴露出来。
        </p>
      </div>
    </div>`;
}

function onClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const btn = target.closest('[data-ng]');
  const act = btn ? btn.dataset.ng : null;

  // 关闭：遮罩一律不关（避免"点空白就当开好了"）
  if (target.closest('.ob-mask')) {
    event.preventDefault();
    return;
  }
  if (act === 'close') {
    event.preventDefault();
    closeNotifyGuide();
    return;
  }

  // ★ 全流程唯一会跳转的地方：用户明确点了「去设置」
  if (act === 'go') {
    event.preventDefault();
    jumpOk = jumpToSettings();
    phase = 'landing';
    paint();
    return;
  }

  // 「再打开一次」和「去设置」走同一个函数，落点保证一致
  if (act === 'again') {
    event.preventDefault();
    jumpOk = jumpToSettings();
    paint();
    return;
  }

  // 不做检测：用户说开好了就是开好了，直接收起。
  // 真有没有开全，靠真实课前提醒暴露，比读几个开关更接近事实。
  if (act === 'done') {
    event.preventDefault();
    closeNotifyGuide();
    return;
  }

}

function bind() {
  const el = host();
  if (!el || bound) return;
  el.addEventListener('click', onClick);
  bound = true;
}

/**
 * 「开启系统通知」的正式入口：**先系统窗口，再跳页面**。
 *
 * @param {{onAfter?:(ok:boolean)=>void}} [opts] onAfter 给了就由调用方接管"跳完"的 UI
 * @returns {'dialog'|'jump'} 走了哪一段（给测试/埋点看）
 */
export function startNotifyFlow(opts = {}) {
  const after = () => {
    const landing = jumpToSettings();
    if (typeof opts.onAfter === 'function') {
      opts.onAfter(landing);
      return;
    }
    jumpOk = landing;
    phase = 'landing';
    bind();
    paint();
  };

  const snap = NATIVE.permissionSnapshot();
  const willShowDialog = Boolean(snap && snap.notify === 'default');

  if (!willShowDialog) {
    // 已授权 / 已永久拒绝：系统不会再弹，直接进页面
    after();
    return 'jump';
  }

  pendingAfterDialog = after;
  if (!NATIVE.requestNotifyPermission()) {
    // 连系统框都起不来（极少数环境）：别卡住，直接进页面
    pendingAfterDialog = null;
    after();
    return 'jump';
  }
  return 'dialog';
}

/**
 * 系统权限窗口关闭后的回调（由 main.js 的 `__buptNotifyPermissionChanged` 调用）。
 * 只有"刚点过开启、正在等结果"时才跳转。
 * @returns {boolean} 是否消费了这次回调
 */
export function onPermissionResult() {
  const fn = pendingAfterDialog;
  pendingAfterDialog = null;
  if (!fn) return false;
  fn();
  return true;
}

/**
 * 只打开确认框（**不跳转**）。用户点「去设置」后才跳。
 */
export function openNotifyGuide() {
  const el = host();
  if (!el) return 'intro';
  bind();
  phase = 'intro';
  jumpOk = 'none';
  paint();
  return 'intro';
}

export function closeNotifyGuide() {
  const el = host();
  if (el) el.innerHTML = '';
  phase = 'intro';
}
