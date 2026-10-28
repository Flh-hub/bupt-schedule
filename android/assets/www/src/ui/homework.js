/**
 * ui/homework.js — 「作业」Tab：待办列表 + 详情。
 *
 * 【数据从哪来】
 * 不是本地算的，是原生 HomeworkGrabber 在隐藏 WebView 里登录云邮教学空间后
 * 抓回来的（见 src/homework.js 顶部的说明）。所以这一页**永远只读**：
 * 界面上不提供"新建作业""勾完成"这类写操作 —— 改了也传不回学校，
 * 反而会让用户以为自己的勾选被老师看到了。
 *
 * 【为什么抓取时连详情一起拿】
 * 详情接口要带 token，token 只在登录态里有效（约 2 小时）。
 * 如果点开一条就重新登录一次，体验是灾难。所以抓取时把列表里前 N 条的正文
 * 一起取回来存本地 —— 之后断网、token 过期都还能看。
 */

import * as NATIVE from '../native.js';
import { dueLabel, isUrgent } from '../homework.js';
import { escapeHtml, emptyState, subTopbar, snackbar } from './components.js';

/** 列表一次最多抓多少条详情（正文是 HTML，多了会让抓取变慢、存储变大）。 */
export const DETAIL_LIMIT = 20;

function fmtStamp(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一条待办卡片。 */
function itemRow(item, now, detail) {
  const urgent = isUrgent(item, now);
  const overdue = item.dueMs > 0 && item.dueMs <= now;
  const tone = overdue ? 'is-overdue' : urgent ? 'is-urgent' : '';
  const meta = [];
  if (item.due) meta.push(`${escapeHtml(item.due)} 截止`);
  else meta.push('没有截止时间');
  if (detail && detail.fullMark) meta.push(`满分 ${detail.fullMark}`);

  // 课程名单独一行放在标题上方：学生看待办第一个要判断的就是"这是哪门课的"
  const course = item.courseName
    ? `<div class="hw-course" title="${escapeHtml(item.courseName)}">${escapeHtml(item.courseName)}</div>`
    : '';

  return `<a class="hw-row ${tone}" href="#/homework/${encodeURIComponent(item.id)}"
             data-action="nav" role="button" tabindex="0">
    <div class="hw-row-main">
      ${course}
      <div class="hw-title">${escapeHtml(item.title)}</div>
      <div class="hw-meta">${meta.join(' · ')}</div>
    </div>
    <div class="hw-left">${escapeHtml(dueLabel(item, now))}</div>
  </a>`;
}

/**
 * 作业列表页。
 *
 * @param {HTMLElement} container
 * @param {object} state
 * @param {object} uiState
 */
export function renderHomework(container, state, uiState) {
  const sub = uiState && uiState.sub ? String(uiState.sub) : null;
  if (sub) {
    renderDetail(container, state, sub);
    return;
  }

  const hw = state.homework;
  const busy = Boolean(uiState && uiState.hwBusy);
  const now = Date.now();
  const hasCred = NATIVE.hwCredHas();
  const savedAccount = hasCred ? NATIVE.hwCredAccount() : '';

  if (!hw || !Array.isArray(hw.items) || !hw.items.length) {
    // 已经存过学号密码（可能是在课表导入时存的，同一套校园账号）→ 不必再输一遍
    if (hasCred) {
      container.innerHTML = `${subTopbar('作业', null, '从云邮教学空间读取')}
        <div class="page">
          <div class="card">
            <div class="card-title"><span class="dot"></span>还没有作业数据</div>
            <p class="small muted" style="margin:0 0 14px">
              用已保存的账号（${escapeHtml(savedAccount)}）读一次，之后点「刷新」更新。
              只在校园网内可用。这里的密码和教务系统的<strong>不一样</strong>，是分开存的。
            </p>
            <button type="button" class="btn btn-primary btn-block" data-action="homework-refresh"
                    ${busy ? 'disabled' : ''}>${busy ? '正在读取…' : '获取作业'}</button>
            <button type="button" class="btn btn-ghost btn-block" data-action="homework-change-account"
                    style="margin-top:8px">换个账号</button>
            <p class="tiny muted" style="margin:12px 2px 0">
              想换账号密码？点下面「换个账号」。
            </p>
          </div>
        </div>`;
      return;
    }
    const form = `<div class="hw-form">
        <label class="hw-field">
          <span>学号</span>
          <input class="input" id="hw-account" inputmode="numeric" autocomplete="username"
                 placeholder="例如 2026212247" value="${escapeHtml((uiState && uiState.hwAccount) || '')}" />
        </label>
        <label class="hw-field">
          <span>密码</span>
          <input class="input" id="hw-password" type="password" autocomplete="current-password"
                 placeholder="统一身份认证密码" />
        </label>
        <p class="tiny muted" style="margin:8px 2px 0">
          密码只存在本机（系统密钥库加密），不上传、不写进备份。
        </p>
      </div>
      <button type="button" class="btn btn-primary btn-block" data-action="homework-fetch"
              style="margin-top:12px" ${busy ? 'disabled' : ''}>${busy ? '正在读取…' : '获取作业'}</button>`;

    container.innerHTML = `${subTopbar('作业', null, '从云邮教学空间读取')}
      <div class="page">
        <div class="card">
          <div class="card-title"><span class="dot"></span>还没有作业数据</div>
          <p class="small muted" style="margin:0 0 12px">
            填一次学号密码，之后点「刷新」就能更新。只在校园网内可用。
          </p>
          ${form}
        </div>
      </div>`;
    return;
  }

  const items = hw.items.slice();
  const urgentCount = items.filter((i) => isUrgent(i, now)).length;

  const summary = [
    `${items.length} 条未完成`,
    urgentCount ? `${urgentCount} 条 7 天内到期` : '',
    hw.at ? `${fmtStamp(hw.at)} 更新` : ''
  ]
    .filter(Boolean)
    .join(' · ');

  const rows = items
    .map((it) => itemRow(it, now, hw.details && hw.details[it.id]))
    .join('');

  container.innerHTML = `${subTopbar('作业', null, summary)}
    <div class="page">
      ${busy ? '<p class="hw-busy">正在从云邮教学空间读取，大约十几秒…</p>' : ''}
      <div class="hw-toolbar">
        <button type="button" class="btn btn-soft btn-sm" data-action="homework-refresh"
                ${busy ? 'disabled' : ''}>${busy ? '读取中…' : '刷新'}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="homework-clear">清除缓存</button>
      </div>
      ${urgentCount ? `<p class="hw-hint">有 ${urgentCount} 条 7 天内到期，已标红。</p>` : ''}
      <div class="hw-list">${rows}</div>
      <p class="tiny muted" style="margin:16px 4px 0;text-align:center;line-height:1.7">
        数据来自云邮教学空间，只读。以学校页面为准。
      </p>
    </div>`;
}

/** 作业详情。正文已在数据层过白名单，这里直接插入。 */
function renderDetail(container, state, id) {
  const hw = state.homework || {};
  const item = (hw.items || []).find((i) => i.id === id);
  const detail = (hw.details || {})[id];
  const now = Date.now();

  if (!item) {
    container.innerHTML = `${subTopbar('作业详情', '#/homework')}
      <div class="page">
        <div class="card"><p class="small muted" style="margin:0">
          这条作业已经不在列表里了，可能已提交或被老师撤回。
        </p></div>
      </div>`;
    return;
  }

  const meta = [];
  if (item.due) meta.push(`${escapeHtml(item.due)} 截止`);
  meta.push(escapeHtml(dueLabel(item, now)));
  if (detail && detail.fullMark) meta.push(`满分 ${detail.fullMark}`);
  if (detail && detail.allowLate) meta.push('允许逾期补交');

  const body = detail && detail.contentHtml
    ? `<div class="hw-body">${detail.contentHtml}</div>`
    : `<p class="small muted" style="margin:0">
         正文还没取回来。点右上角「刷新」重新获取一次。
       </p>`;

  container.innerHTML = `${subTopbar('作业详情', '#/homework', item.courseName || '')}
    <div class="page">
      <div class="card">
        ${
          item.courseName
            ? `<div class="hw-course" title="${escapeHtml(item.courseName)}">${escapeHtml(item.courseName)}</div>`
            : ''
        }
        <h2 class="hw-detail-title">${escapeHtml(item.title)}</h2>
        <p class="hw-detail-meta">${meta.join(' · ')}</p>
        ${body}
      </div>
    </div>`;
}

/** 抓取失败时给一句人话（原生回的是错误码）。 */
export const HOMEWORK_ERRORS = {
  no_network: '连不上云邮教学空间，确认连的是校园网。',
  bad_credentials: '学号或密码不对，检查一下再试。',
  captcha: '学校要求输验证码，请到网页里手动登录一次。',
  session_stuck: '登录过了，但云邮页面没准备好。稍后再试；一直这样就去网页登录一次。',
  no_form: '登录页结构变了，暂时抓不到。',
  timeout: '等太久了，可能网络慢，稍后再试。',
  cancelled: '',
  busy: '上一次还在跑，稍等。',
  unknown: '没抓成，稍后再试。'
};

export function homeworkErrorText(code) {
  return HOMEWORK_ERRORS[code] || HOMEWORK_ERRORS.unknown;
}
