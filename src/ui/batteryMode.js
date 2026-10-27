/**
 * ui/batteryMode.js — 「修改后台运行模式」页面的共用内容。
 *
 * 【为什么要有这一页，而不是直接甩系统设置】
 * Android 保后台有**两层**，很多人只改了其中一层就以为好了：
 *
 *   ① AOSP 那层：`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`（"忽略电池优化" / Doze 白名单）
 *   ② 厂商那层：ColorOS 的「耗电管理 › 耗电行为控制」（智能优化 / 完全允许 / 限制）
 *
 * ★ 关键事实：**第 ① 层管不到第 ② 层**。把应用加进 AOSP 白名单，
 *   ColorOS 仍然会按"智能优化"在省电时清掉它 —— 已排的闹钟随之被撤销。
 *
 * 【跳到哪一页（1.66.1 真机修正）】
 * 目标不是「电池」那几页，而是 **设置 › 应用 › 北邮课程表** 这一页 ——
 * 「耗电管理」和权限、存储、流量并列挂在应用信息页里，点进去才是三选项页。
 * 之前跳到 `com.oplus.battery/...PowerUsageModelActivity`，真机上落到了
 * 「应用的电池使用情况」列表（所有应用混在一起），用户还得自己找本应用。
 *
 * 【能检测到什么，必须如实分层】
 * `batteryExempt()` 只反映**第 ① 层**。ColorOS 那层没有任何查询 API，
 * 所以我们永远不能宣称"已经完全放开了"，只能说"AOSP 层已豁免，
 * ColorOS 那层请你自己确认"。这一点写死在文案里，不许后人简化。
 */

import * as NATIVE from '../native.js';
import { powerTerms } from '../keepalive.js';
import { escapeHtml } from './components.js';

/**
 * 三个选项的对照表。
 *
 * ★ 「好的那一档」在每家叫法不同（小米「无限制」/ 华为「允许后台活动」/
 *   三星「不受限制」/ OPPO「允许完全后台行为」），所以**不能写死**，
 *   由 `batteryOptions()` 按当前机型替换名字。
 */
export const BATTERY_OPTIONS = [
  {
    name: '智能优化',
    alias: '（默认）',
    verdict: 'bad',
    what: '省电时清掉后台，已排的闹钟会被撤销'
  },
  {
    name: '允许完全后台行为',
    alias: '也叫「完全后台运行」',
    verdict: 'good',
    what: '后台不被清理，闹钟和胶囊都照常'
  },
  {
    name: '限制后台行为',
    alias: '也叫「限制后台运行」',
    verdict: 'bad',
    what: '退到后台立刻冻结，闹钟排不进去'
  }
];

/**
 * 当前状态（**只针对 AOSP 那层**，文案里必须写明）。
 * @returns {{state:'exempt'|'notExempt'|'unknown', text:string, tone:'ok'|'warn'|'muted'}}
 */
export function batteryStatus() {
  const t = powerTerms(NATIVE.deviceBrand());
  // ★ 系统明确说"限制在后台"时优先报这个 —— 比"电池优化未豁免"更贴近真实原因。
  //   反过来的 false 不能当"没被限制"用（其它 ROM 上读不准），所以只判 true。
  if (NATIVE.batteryRestricted() === true) {
    return {
      state: 'notExempt',
      tone: 'warn',
      text: `系统把本应用限制在后台，请到「${t.page}」改成「${t.option}」。`
    };
  }
  const exempt = NATIVE.batteryExempt();
  if (exempt === true) {
    return {
      state: 'exempt',
      tone: 'ok',
      // ★ 「厂商那层读不到」这半句不能删：AOSP 豁免 ≠ 厂商放行，说成"已完全放开"就是骗人
      text: `电池优化已豁免；「${t.page}」读不到，需你自己确认。`
    };
  }
  if (exempt === false) {
    return {
      state: 'notExempt',
      tone: 'warn',
      text: `电池优化未豁免，请在「${t.page}」改成「${t.option}」，并在电池优化列表里放行。`
    };
  }
  return {
    state: 'unknown',
    tone: 'muted',
    text: '读不到系统状态，请按下面的路径手动确认。'
  };
}

/** 按当前机型把「好的那一档」换成它真正的名字。 */
export function batteryOptions() {
  const t = powerTerms(NATIVE.deviceBrand());
  return BATTERY_OPTIONS.map((o) =>
    o.verdict === 'good' ? { ...o, name: t.option } : o
  );
}

/** 三选项对照表。 */
function optionsHtml() {
  const rows = batteryOptions().map((o) => {
    const mark = o.verdict === 'good' ? '✅ 选这个' : '❌ 别选';
    return `<tr class="${o.verdict === 'good' ? 'is-good' : 'is-bad'}">
      <td>
        <b>${escapeHtml(o.name)}</b>
        <span class="bm-alias">${escapeHtml(o.alias)}</span>
      </td>
      <td>
        <span class="bm-what">${escapeHtml(o.what)}</span>
        ${o.impact ? `<span class="bm-impact">${escapeHtml(o.impact)}</span>` : ''}
      </td>
      <td class="bm-mark">${mark}</td>
    </tr>`;
  }).join('');
  return `<table class="bm-table">
    <thead><tr><th>选项</th><th>会怎样</th><th>怎么选</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * 页面主体。
 *
 * @param {{compact?:boolean, hint?:string}} [opts]
 *        compact = 塞在引导弹层里用的窄版；hint = 上次跳转的落地提示
 */
export function batteryModeCardHtml(opts = {}) {
  const status = batteryStatus();
  const t = powerTerms(NATIVE.deviceBrand());
  // 路径前缀各家不同（有的在「应用信息」里，有的在「电池」里），给一句够用的即可
  const pathText = `设置 › 应用 › 北邮课程表 › ${t.page}`;
  const hint = opts.hint ? `<p class="bm-hint">${escapeHtml(opts.hint)}</p>` : '';
  const compact = Boolean(opts.compact);

  return `<div class="bm-card${compact ? ' is-compact' : ''}">
    <div class="bm-alert">
      <p class="bm-alert-title">必须选「${escapeHtml(t.option)}」</p>
      <p class="bm-alert-body">默认那档会在省电时清掉闹钟，<b>课前提醒可能不响</b>。</p>
    </div>
    <p class="bm-status is-${status.tone}">${escapeHtml(status.text)}</p>
    ${optionsHtml()}
    ${hint}
    <p class="bm-path">
      入口路径：<span class="mono">${escapeHtml(pathText)}</span>
    </p>
  </div>`;
}

/**
 * 跳到 **设置 › 应用 › 北邮课程表**（「耗电管理」就在这一页里）。
 * @returns {{landing:string, hint:string}} 落点 + 对应提示
 */
export function openSystemBatteryPage() {
  const landing = NATIVE.openBatteryModePage();
  const hint = NATIVE.BATTERY_LANDING_HINT[landing] || NATIVE.BATTERY_LANDING_HINT.none;
  return { landing, hint };
}

/**
 * 跳到 AOSP 那层「电池优化」列表（Doze 白名单，和厂商的耗电管理是两件事）。
 * @returns {{landing:string, hint:string}}
 */
export function openAospBatteryListPage() {
  const landing = NATIVE.openAospBatteryList();
  const hint = NATIVE.BATTERY_LANDING_HINT[landing] || NATIVE.BATTERY_LANDING_HINT.none;
  return { landing, hint };
}
