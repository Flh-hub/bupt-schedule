/**
 * ui/settings.js — 设置 Tab：学期 / 节次时间表 / 节假日 / 数据管理 / 关于。
 *
 * 【纪律】本文件不做日期/周次判断：星期文案取 `calendar.describeDate()`，
 * 补班日列表取 `holidays.listMakeupDays()`；只做表单读写与状态派发（校验在 store + model）。
 */

import { DEFAULT_PERIODS, WEEKDAY_FULL, formatIsoCn, isDateStr, nowIso, todayStr } from '../model.js';
import {
  OFFICIAL_SOURCE,
  auditBuiltinHolidays,
  getBuiltinHolidays,
  getTentativeHolidays,
  listMakeupDays
} from '../holidays.js';
import { describeDate } from '../calendar.js';
import {
  ICONS,
  banner,
  entryRow,
  escapeHtml,
  segmented,
  selectField,
  sheet,
  snackbar,
  subTopbar,
  toggleSwitch
} from './components.js';
import { privacyPageHtml } from './privacy.js';

/* ---------------------------------------------------------------- 学期 */

function semesterCard(state) {
  const s = state.settings;
  return `<form class="card" data-action="semester-save">
    <h2 class="card-title"><span class="dot"></span>学期配置</h2>
    <div class="field">
      <label for="sem-start">第 1 周的周一</label>
      <input class="input" id="sem-start" name="semesterStartMonday" type="date"
        value="${escapeHtml(s.semesterStartMonday || '')}" />
      <p class="tiny muted" style="margin:6px 0 0">周次 = （日期 − 该周一）÷ 7 + 1。未配置时周次显示为「?」。</p>
    </div>
    <div class="field">
      <label for="sem-weeks">总周数</label>
      <input class="input" id="sem-weeks" name="totalWeeks" type="number" min="1" max="30" value="${s.totalWeeks}" />
    </div>
    <div class="list-row">
      <div class="grow">
        <div class="lr-title">有单双周课程</div>
        <div class="lr-sub">仅作为提示，导入时按每门课自己的单双周解析</div>
      </div>
      ${toggleSwitch(!!s.hasOddEvenWeek, 'semester-oddeven', '单双周')}
    </div>
    <input type="hidden" name="hasOddEvenWeek" value="${s.hasOddEvenWeek ? '1' : '0'}" />
    <button type="submit" class="btn btn-primary btn-block" style="margin-top:10px">保存学期配置</button>
  </form>`;
}

/* ---------------------------------------------------------------- 节次 */

/** 按上课时间把节次归到上午 / 下午 / 晚上（不写死节号，作息改了也对）。 */
function periodBlockOf(p) {
  const hour = Number(String(p.start || '').split(':')[0]);
  if (!Number.isFinite(hour)) return '其他';
  if (hour < 12) return '上午';
  if (hour < 18) return '下午';
  return '晚上';
}

function periodsCard(state) {
  const periods = state.settings.periods.slice().sort((a, b) => a.index - b.index);

  // 按时间段切块，保持原有顺序
  const groups = [];
  for (const p of periods) {
    const name = periodBlockOf(p);
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push(p);
    else groups.push({ name, items: [p] });
  }

  const rowHtml = (p) => `<div class="period-row">
      <span class="p-badge">${p.index}</span>
      <div class="p-main">
        <div class="p-top">
          <input class="p-label" value="${escapeHtml(p.label)}" data-action="period-edit"
            data-index="${p.index}" data-field="label" aria-label="第 ${p.index} 节名称" />
          <button type="button" class="p-del" data-action="period-del" data-index="${p.index}"
            aria-label="删除第 ${p.index} 节">${ICONS.trash}</button>
        </div>
        <div class="p-time">
          <input type="time" value="${escapeHtml(p.start)}" data-action="period-edit"
            data-index="${p.index}" data-field="start" aria-label="第 ${p.index} 节上课时间" />
          <span class="p-dash" aria-hidden="true">–</span>
          <input type="time" value="${escapeHtml(p.end)}" data-action="period-edit"
            data-index="${p.index}" data-field="end" aria-label="第 ${p.index} 节下课时间" />
        </div>
      </div>
    </div>`;

  const body = groups
    .map(
      (g) =>
        `<div class="pick-group-title">${g.name}<span>${g.items.length} 节</span></div>${g.items
          .map(rowHtml)
          .join('')}`
    )
    .join('');

  const anyCustom = periods.some((p) => p.isCustom);

  return `<div class="card pick-card">
    <h2 class="card-title"><span class="dot"></span>节次时间表</h2>
    ${banner('warn', '以下为<b>参考值</b>，请按本校区（西土城 / 沙河 / 宏福）实际作息核对修改。')}
    <div class="pick-list">${body}</div>
    <div class="btn-row" style="margin-top:12px">
      <button type="button" class="btn btn-sm" data-action="period-add">${ICONS.plus} 增加一节</button>
      <button type="button" class="btn btn-sm ${anyCustom ? 'btn-soft' : ''}" data-action="period-reset">恢复默认</button>
    </div>
    <p class="tiny muted" style="margin:10px 0 0">后一节的开始时间不得早于前一节结束时间；修改后所有提醒立即按新时间重算。</p>
  </div>`;
}

/* ---------------------------------------------------------------- 节假日 */

/** 2026 法定放假分组（按节日聚合，用于紧凑展示）。 */
function groupBuiltin() {
  const groups = new Map();
  for (const h of getBuiltinHolidays()) {
    if (h.type !== 'holiday') continue;
    if (!groups.has(h.name)) groups.set(h.name, []);
    groups.get(h.name).push(h);
  }
  return groups;
}

/**
 * 节假日与调休：6 行补班日选择器（初始"待确认"）+ 放假列表 + 自定义日期。
 * ★ 选择器写回走 `SET_MAKEUP_FOLLOW`（逐日），不存在任何全局静默开关。
 */
function holidaysCard(state) {
  const audit = auditBuiltinHolidays();
  const groups = groupBuiltin();
  const makeups = listMakeupDays(state.holidays);
  const tentative = getTentativeHolidays();

  const holidayRows = [...groups.entries()]
    .map(([name, days]) => {
      const first = days[0].date;
      const last = days[days.length - 1].date;
      return `<div class="list-row">
        <div class="grow">
          <div class="lr-title">${escapeHtml(name)}</div>
          <div class="lr-sub">${escapeHtml(first)} 至 ${escapeHtml(last)} · ${days.length} 天</div>
        </div>
      </div>`;
    })
    .join('');

  const makeupRows = makeups
    .map((h) => {
      const f = h.followDayOfWeek;
      const pending = f == null;
      const info = describeDate(state, h.date);
      return `<div class="list-row">
        <div class="grow">
          <div class="lr-title">
            ${escapeHtml(h.date)} <span class="small muted">${escapeHtml(info.weekday)}</span>
            ${pending ? '<span class="badge badge-warn">待确认</span>' : ''}
            ${h.inferred ? '<span class="badge badge-gray">推定，请核对</span>' : ''}
          </div>
          <div class="lr-sub">${escapeHtml(h.name)}${
            f === 'none' ? ' · 已确认不上课' : typeof f === 'number' ? ` · 已确认按${WEEKDAY_FULL[f]}上课` : ' · 需要你确认按周几上课'
          }</div>
        </div>
        <button type="button" class="select-trigger is-compact" data-action="makeup-pick"
          data-date="${escapeHtml(h.date)}" data-follow="${f == null ? '' : f}"
          aria-label="修改 ${escapeHtml(h.date)} 按哪天的课表上课">
          <span class="st-main">
            <span class="st-v">${
              pending ? '待确认' : f === 'none' ? '不上课' : `按${WEEKDAY_FULL[f]}`
            }</span>
          </span>
          ${ICONS.chevronDown}
        </button>
      </div>`;
    })
    .join('');

  const customRows = state.holidays.length
    ? state.holidays
        .map(
          (h) => `<div class="list-row">
            <div class="grow">
              <div class="lr-title">${escapeHtml(h.name)}</div>
              <div class="lr-sub">${escapeHtml(h.date)} · ${
            h.type === 'makeupWorkday'
              ? `补班${
                  h.followDayOfWeek === 'none'
                    ? '（不上课）'
                    : h.followDayOfWeek
                      ? `（按${WEEKDAY_FULL[h.followDayOfWeek]}）`
                      : '（待确认）'
                }`
              : '放假'
          }</div>
            </div>
            <button type="button" class="btn btn-sm btn-danger" data-action="holiday-del" data-date="${escapeHtml(h.date)}">删除</button>
          </div>`
        )
        .join('')
    : `<p class="small muted" style="margin:8px 0 0">还没有自定义日期。校运会、临时放假用「放假某一天」，周末补课用「补班日」。</p>`;

  const pendingCount = makeups.filter((h) => h.followDayOfWeek == null).length;

  return `<div class="card">
    <h2 class="card-title"><span class="dot"></span>节假日与调休</h2>
    <div class="list-row">
      <div class="grow">
        <div class="lr-title">节假日跳过提醒</div>
        <div class="lr-sub">关闭后法定节假日也照常出课与提醒（状态会变成「正常日」）</div>
      </div>
      ${toggleSwitch(state.settings.skipOnHoliday !== false, 'holiday-toggle', '节假日跳过提醒')}
    </div>
    <div class="field" style="margin-top:10px">
      <span class="field-label">补班日上不上课</span>
      ${segmented(
        [
          { value: 'followWeekday', label: '要上课' },
          { value: 'skip', label: '不上课' }
        ],
        state.settings.makeupWorkdayMode,
        'makeup-mode'
      )}
      <p class="tiny muted" style="margin:6px 0 0">
        选「要上课」的日子，按你指定的周几来排课；还没指定周几的日子，两种都一样：不排课、不提醒。
      </p>
    </div>
    ${banner(
      'warn',
      `内置数据来源：<b>${escapeHtml(OFFICIAL_SOURCE)}</b>（放假日 ${audit.holidayCount} 天 / 调休上班日 ${audit.makeupCount} 天）。国务院通知只规定放假与上班日期，<b>不指明补哪一天的课</b>，所以除「元旦 01-04」外都保持未确认，请按学校通知逐日指定。`
    )}
    ${pendingCount ? banner('warn', `还有 <b>${pendingCount}</b> 个调休上班日未确认——确认前该日不排课也不提醒。`) : ''}
    ${
      audit.ok ? '' : banner('danger', `内置数据自检异常：${escapeHtml(audit.errors.slice(0, 3).join('；'))}`)
    }
    <div class="section-label">调休上班日（${makeups.length} 天）</div>
    ${makeupRows}
    <button type="button" class="btn btn-sm btn-ghost" style="margin-top:8px;padding-left:0"
      data-action="makeup-follow-bulk">全部未确认日都不上课 →</button>
    ${
      tentative.length
        ? `<div class="section-label">预留（官方未发布）</div>
           <div class="list-row">
             <div class="grow">
               <div class="lr-title">${escapeHtml(tentative[0].name)} <span class="badge badge-warn">待确认</span></div>
               <div class="lr-sub">${escapeHtml(tentative[0].date)} 至 ${escapeHtml(
            tentative[tentative.length - 1].date
          )} · 按惯例预留，可在此增删</div>
             </div>
           </div>`
        : ''
    }
    <div class="section-label">2026 法定放假（${audit.holidayCount} 天）</div>
    ${holidayRows}
    <div class="section-label">自定义日期</div>
    ${customRows}
    <div class="btn-row" style="margin-top:10px">
      <button type="button" class="btn btn-soft" data-action="holiday-add" data-type="holiday">${ICONS.plus} 放假某一天</button>
      <button type="button" class="btn btn-ghost" data-action="holiday-add" data-type="makeupWorkday">${ICONS.plus} 补班日</button>
    </div>
    <p class="tiny muted" style="margin:8px 0 0">
      放假某一天：这天整天不排课、不发提醒（校运会、临时放假都行）。补班日：周末要上课，按你指定的星期排课。
    </p>
  </div>`;
}


/* ---------------------------------------------------------------- 数据 */

function dataCard(state) {
  const lastBackup = state.settings.lastBackupAt;
  return `<div class="card">
    <h2 class="card-title"><span class="dot"></span>数据管理</h2>
    <p class="small muted" style="margin:0 0 10px">
      所有数据只存在本机 <span class="mono">localStorage</span>，不上传任何服务器。
      ${lastBackup ? `上次备份：${escapeHtml(formatIsoCn(lastBackup))}` : '建议定期导出备份，清理缓存会丢数据。'}
    </p>
    <button type="button" class="btn btn-soft btn-block" style="margin-bottom:10px" data-action="backup-export">
      ${ICONS.download} 导出备份（JSON）
    </button>
    <div class="field">
      <label for="restore-file">从备份恢复</label>
      <input class="input" id="restore-file" type="file" accept=".json,application/json" data-field="restoreFile" />
      <div style="margin-top:8px">
        ${segmented(
          [
            { value: 'overwrite', label: '全量覆盖' },
            { value: 'merge', label: '合并到现有' }
          ],
          state.__restoreMode || 'overwrite',
          'restore-mode'
        )}
      </div>
    </div>
    <button type="button" class="btn btn-danger btn-block" data-action="data-clear" style="margin-top:14px">清空所有数据</button>
  </div>`;
}

/**
 * 反馈邮箱：全项目只在这一处定义，改地址只改这里。
 *
 * ★ 开源仓库里留占位：原先填的是作者本人的学号邮箱，公开后会连带暴露学号。
 *   自己部署时把下面这行换成真实地址即可，其余代码不用动。
 */
export const FEEDBACK_EMAIL = 'feedback@example.com';

function aboutCard() {
  // 版本号从 index.html 的 <meta name="app-version"> 读，避免"关于页永远停在 1.0.0"
  const version =
    (document.querySelector('meta[name="app-version"]') || {}).content || '';
  const versionText = version ? `${version}（零构建原生 PWA）` : '零构建原生 PWA';
  return `<div class="card">
    <h2 class="card-title"><span class="dot"></span>关于</h2>
    <div class="list-row"><span class="muted" style="width:76px">版本</span><span class="grow">${versionText}</span></div>
    <div class="list-row"><span class="muted" style="width:76px">数据</span><span class="grow">全部保存在本机，无账号、无后端、不上传</span></div>
    <div class="list-row"><span class="muted" style="width:76px">时区</span><span class="grow">固定 Asia/Shanghai，不做夏令时换算</span></div>
    <div class="list-row"><span class="muted" style="width:76px">限制</span><span class="grow">网页通知在系统清理后台后不保证送达，可靠提醒请导出系统日历</span></div>
    <div class="list-row">
      <span class="muted" style="width:76px">反馈</span>
      <span class="grow mono">${escapeHtml(FEEDBACK_EMAIL)}</span>
      <button type="button" class="btn btn-soft btn-sm" data-action="copy-feedback">复制</button>
    </div>
    <p class="tiny muted" style="margin:10px 0 0">
      用着有问题，或者有想加的功能，发邮件到上面这个地址就行。
    </p>
  </div>`;
}

/** 主渲染。 */
/**
 * 设置主页面：只放最常用的「学期配置」+ 四个入口。
 *
 * 节次表（14 行）、节假日（几十行）以前全摊在这一页，滚半天找不到东西；
 * 现在长内容一律进二级页 `#/settings/periods|holidays|data|about`。
 */
export function renderSettings(container, state, uiState) {
  const sub = uiState && uiState.sub ? uiState.sub : null;
  const storageBanner =
    state.storageBroken === true || (uiState && uiState.storageBroken === true)
      ? banner('danger', '<b>数据无法写入本机</b>（可能是隐私模式或存储已满），本次修改可能不会被保存，请尽快导出备份。')
      : '';

  if (sub === 'privacy') {
    container.innerHTML = `${subTopbar('隐私说明', '#/settings', '不收集 · 不出本机')}${privacyPageHtml()}`;
    return;
  }

  if (sub === 'periods' || sub === 'holidays' || sub === 'data' || sub === 'about') {
    const page =
      sub === 'periods'
        ? {
            title: '节次时间表',
            desc: `${state.settings.periods.length} 节 · 影响提醒与日历`,
            body: periodsCard(state)
          }
        : sub === 'holidays'
          ? { title: '节假日与调休', desc: '法定假期静默 · 调休补班', body: holidaysCard(state) }
          : sub === 'data'
            ? { title: '数据与备份', desc: '换手机 / 清缓存前先导出', body: dataCard(state) }
            : { title: '关于', desc: '版本与数据来源', body: aboutCard() };

    container.innerHTML = `${subTopbar(page.title, '#/settings', page.desc)}
      <div class="page">
        ${storageBanner}
        ${page.body}
      </div>`;
    return;
  }

  const makeups = listMakeupDays(state.holidays).length;
  container.innerHTML = `<div class="topbar">
      <div class="topbar-row">
        <div class="grow"><h1>设置</h1><p class="sub">学期 · 节次 · 节假日 · 数据</p></div>
      </div>
    </div>
    <div class="page">
      ${storageBanner}
      ${semesterCard(state)}
      <div class="section-label">更多</div>
      <div class="entry-list">
        ${entryRow('#/settings/periods', '节次时间表', `${state.settings.periods.length} 节`, '上课 / 下课时间，改完提醒与日历一起生效')}
        ${entryRow('#/settings/holidays', '节假日与调休', makeups ? `${makeups} 天待确认` : '已确认', '法定假期静默、调休补班按周几上课')}
        ${entryRow('#/settings/data', '数据与备份', '', '导出 JSON、恢复备份、重置')}
        ${entryRow('#/settings/privacy', '隐私说明', '不收集', '数据存在哪、账号密码怎么处理、权限用在哪')}
        ${entryRow('#/settings/about', '关于', '', '版本、内置数据来源、限制说明')}
      </div>
      <p class="tiny muted" style="margin:16px 4px 24px;text-align:center">
        ${escapeHtml(UI_FOOTER)}
      </p>
    </div>`;
}

const UI_FOOTER = '北邮课程表 · 数据只在本机 · 换手机请先导出备份';

/* ---------------------------------------------------------------- 动作实现 */

/** 添加自定义节假日。 */
/**
 * 添加一个自定义日期：放假某一天 / 补班日。
 * @param {object} store
 * @param {{type?:'holiday'|'makeupWorkday', date?:string}} [opts] 入口按钮带过来的预设类型
 */
export function openHolidaySheet(store, opts = {}) {
  const type = opts.type === 'makeupWorkday' ? 'makeupWorkday' : 'holiday';
  const isMakeup = type === 'makeupWorkday';
  const today = opts.date || todayStr();

  const followField = isMakeup
    ? selectField({
        id: 'hol-follow',
        name: 'followDayOfWeek',
        label: '这天按哪天的课表上课',
        value: '',
        title: '按哪天的课表上课',
        searchable: false,
        hint: '不确定就先放着，课表里会显示「待确认」，假期临近时也会再问你一次。',
        options: [
          { value: '', label: '待确认', sub: '不排课、不提醒，等你来定' },
          ...[1, 2, 3, 4, 5, 6, 7].map((d) => ({
            value: String(d),
            label: `按${WEEKDAY_FULL[d]}上课`,
            group: '按周几上课'
          })),
          { value: 'none', label: '不调休（这天没课）', group: '其他' }
        ]
      })
    : `<p class="small muted" style="margin:0 0 4px">这天整天都不排课、不发提醒，课表和日视图会标成「假期」。</p>`;

  sheet({
    title: isMakeup ? '添加补班日' : '放假某一天',
    body: `<input type="hidden" name="type" value="${type}" />
      <div class="field">
        <label for="hol-date">日期</label>
        <input class="input" id="hol-date" name="date" type="date" value="${today}" required />
      </div>
      <div class="field">
        <label for="hol-name">名称</label>
        <input class="input" id="hol-name" name="name"
          placeholder="${isMakeup ? '如 校庆补班' : '如 校运动会 / 临时放假'}" required />
      </div>
      ${followField}`,
    submitText: isMakeup ? '添加补班日' : '设为放假',
    onSubmit: (formData) => {
      const date = String(formData.get('date') || '');
      if (!isDateStr(date)) {
        snackbar('请选择合法日期', { danger: true });
        return false;
      }
      const kind = String(formData.get('type') || 'holiday');
      const result = store.dispatch({
        type: 'UPSERT_HOLIDAY',
        payload: {
          holiday: {
            date,
            name: String(formData.get('name') || '').trim() || (kind === 'holiday' ? '放假' : '补班'),
            type: kind,
            followDayOfWeek: kind === 'makeupWorkday' ? formData.get('followDayOfWeek') || null : null
          }
        }
      });
      if (!result.ok) {
        snackbar(result.errors[0] || '保存失败', { danger: true });
        return false;
      }
      snackbar(kind === 'holiday' ? `已把 ${date} 设为放假` : `已添加补班日 ${date}`);
      return true;
    }
  });
}

/** 为内置补班日指定「按周几上课」。 */
export function setMakeupFollow(store, state, date, followValue) {
  // 空值 = 回到"待确认"：删除用户覆盖，内置的 null 重新生效
  if (followValue === '' || followValue == null) {
    const result = store.dispatch({ type: 'DELETE_HOLIDAY', payload: { date } });
    if (!result.ok) snackbar(result.errors[0] || '保存失败', { danger: true });
    else snackbar('已改回「待确认」');
    return result;
  }

  const follow = followValue === 'none' ? 'none' : Number(followValue);
  const result = store.dispatch({ type: 'SET_MAKEUP_FOLLOW', payload: { date, follow } });
  if (!result.ok) snackbar(result.errors[0] || '保存失败', { danger: true });
  else if (follow === 'none') snackbar('已确认当天不上课');
  else snackbar(`已确认按${WEEKDAY_FULL[follow]}上课`);
  return result;
}

/** 批量「全部未确认日都不上课」（逐日写 'none'，不是全局开关）。 */
export function setMakeupFollowBulk(store) {
  const result = store.dispatch({ type: 'SET_MAKEUP_FOLLOW_BULK', payload: { none: true } });
  if (!result.ok) snackbar(result.errors[0] || '操作失败', { danger: true });
  else snackbar(`已把 ${result.count} 个未确认的调休上班日标为「不上课」`);
  return result;
}

/** 导出备份（返回 JSON 字符串）。 */
export function exportBackup(store) {
  const result = store.dispatch({ type: 'EXPORT_BACKUP' });
  if (!result.ok || !result.data) {
    snackbar('备份生成失败', { danger: true });
    return;
  }
  const stamp = formatIsoCn(nowIso(), false);
  const blob = new Blob([result.data], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `bupt-schedule-backup-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  snackbar('已导出备份文件');
}

/** 恢复备份。 */
export function restoreBackup(store, text, mode) {
  const result = store.dispatch({ type: 'RESTORE_BACKUP', payload: { payload: text, mode } });
  if (!result.ok) {
    snackbar(result.errors[0] || '恢复失败', { danger: true });
    return result;
  }
  snackbar(mode === 'merge' ? '已合并备份数据' : '已用备份覆盖当前数据');
  return result;
}

/** 恢复默认节次（带提示）。 */
export function resetPeriods(store) {
  const result = store.dispatch({ type: 'RESET_PERIODS' });
  if (result.ok) snackbar(`已恢复默认 ${DEFAULT_PERIODS.length} 节作息`);
  return result;
}
