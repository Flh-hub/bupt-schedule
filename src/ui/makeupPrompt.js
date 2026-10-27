/**
 * ui/makeupPrompt.js — 假期临近时的「调休确认」弹层。
 *
 * 【为什么要有这个东西】
 * 国务院通知只说"哪几天放假、哪几天上班"，**不指明补哪一天的课**。
 * 所以补班日默认是 `followDayOfWeek: null`（待确认），而待确认期间
 * `calendar` 既不排课也不生成提醒——学生很可能就这么错过一节。
 * 等他自己翻到设置页去点，已经太晚了；所以在假期临近时主动问一次。
 *
 * 【为什么不给"全局静默"按钮】
 * 点「不调休」= 把这**一天**写成 `'none'`（这天确实没课），逐日生效；
 * 点「今天不再提醒」= 只记"今天问过了"，明天还会问。
 * 任何一键操作都不能把"不知道"改写成"确定没课"（ARCHITECTURE §0.1 修正 4）。
 */

import { sheet, closeSheet, banner, snackbar } from './components.js';
import { todayStr, dayOfWeekOf, addDays } from '../model.js';
import { findMakeupAlert } from '../holidays.js';

/** 假期开始 / 补班日距今多少天内开始问。 */
export const PROMPT_WINDOW_DAYS = 7;

const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 同一次启动只主动问一次，避免每次重绘都弹。 */
let askedThisLaunch = false;

/** 仅测试/探针用：重置「这次启动已经问过」。 */
export function resetMakeupPromptState() {
  askedThisLaunch = false;
}

function weekdayShort(date) {
  return WEEKDAY_CN[dayOfWeekOf(date)] || '';
}

function gapText(days) {
  if (days === 0) return '就是今天';
  if (days === 1) return '明天';
  if (days === 2) return '后天';
  return `${days} 天后`;
}

/**
 * 打开确认弹层。
 * @param {object} store
 * @param {{date:string, name:string, daysUntil:number, span:object|null}} alert
 * @param {string} [today]
 */
export function openMakeupPrompt(store, alert, today = todayStr()) {
  if (!alert || !alert.date) return null;
  const realDow = dayOfWeekOf(alert.date);
  const span = alert.span;

  const facts = [
    `<b>${alert.date} ${weekdayShort(alert.date)}</b> · ${gapText(alert.daysUntil)}`,
    span ? `${span.name}放假 ${span.from} 至 ${span.to}` : ''
  ].filter(Boolean);

  const options = [1, 2, 3, 4, 5, 6, 7]
    .map(
      (d) =>
        `<button type="button" data-action="makeup-follow" data-date="${alert.date}" data-follow="${d}" data-from="prompt"${
          d === realDow ? ' title="与这天真实星期相同"' : ''
        }>${WEEKDAY_CN[d]}</button>`
    )
    .join('');

  const handle = sheet({
    title: '调休确认',
    hideSubmit: true,
    body: `
      ${banner('makeup', `${facts.join('<br>')}`)}
      <p class="small" style="margin:12px 0 10px;line-height:1.55">
        这天是<b>调休上班日</b>，按哪一天的课表上课？<br>
        <span class="muted">官方通知只规定放假与上班日期，不指明补哪一天的课，所以不替你猜。</span>
      </p>
      <div class="opt-grid">
        ${options}
        <button type="button" class="is-none" data-action="makeup-follow" data-date="${alert.date}" data-follow="none" data-from="prompt">
          不调休（这天没课）
        </button>
      </div>
      <div class="sheet-inline-actions">
        <button type="button" class="btn btn-sm btn-ghost" data-action="makeup-snooze" data-date="${alert.date}" data-today="${today}">
          今天不再提醒
        </button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="sheet-close">稍后</button>
      </div>
      <p class="tiny muted" style="margin:8px 0 0">
        也可以随时在「设置 › 节假日与调休」里改。确认前这天不排课、也不发提醒。
      </p>`
  });
  return handle;
}

/**
 * 启动时调用：有临近且未确认的调休上班日就问一次。
 * @param {object} store
 * @param {{today?:string, force?:boolean}} [opts]
 * @returns {object|null} 打开时返回 sheet 句柄，否则 null
 */
export function maybePromptMakeup(store, opts = {}) {
  if (!store || typeof store.getState !== 'function') return null;
  if (askedThisLaunch && !opts.force) return null;
  // 已经有别的弹层开着（比如用户一进来就点了空格子）就别抢，下次启动再说
  const host = typeof document === 'undefined' ? null : document.getElementById('sheet-host');
  if (host && host.classList.contains('is-open')) return null;

  const state = store.getState();
  // 还没导入课表就先别问：先有课，才有"按哪天的课表上课"这回事
  if (!state.sessions || !state.sessions.length) return null;

  const today = opts.today || todayStr();
  const alert = findMakeupAlert(state.holidays, today, {
    windowDays: PROMPT_WINDOW_DAYS,
    snoozed: state.settings && state.settings.makeupPromptSnooze,
    mode: state.settings && state.settings.makeupWorkdayMode
  });
  if (!alert) return null;

  askedThisLaunch = true;
  return openMakeupPrompt(store, alert, today);
}

/** 「今天不再提醒」：只记到今天，明天照问。 */
export function snoozeMakeupPrompt(store, date, today = todayStr()) {
  if (!date) return false;
  const result = store.dispatch({ type: 'SNOOZE_MAKEUP_PROMPT', payload: { date, until: today } });
  if (!result.ok) {
    snackbar(result.errors[0] || '保存失败', { danger: true });
    return false;
  }
  closeSheet();
  snackbar(`今天不再提醒 ${date} 的调休，明天再说`, {
    undo: () => {
      store.dispatch({ type: 'SNOOZE_MAKEUP_PROMPT', payload: { date, until: addDays(today, -1) } });
      snackbar('已撤销');
    }
  });
  return true;
}
