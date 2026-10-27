/**
 * ui/import.js — 导入 Tab：四通道 + 解析预览（可逐行编辑）+ 未识别行 + 历史回滚。
 *
 * 【纪律】本文件不 import calendar.js，不做任何日期/周次判断；
 * 周次文案解析交给 parsers/normalize（model.parseWeeksText 的唯一展开点）。
 */

import { WEEKDAY_FULL, expandWeeks, formatIsoCn, parseWeeksText, todayStr, weeksToText } from '../model.js';
import { normalize, parse, parseHtml } from '../parsers/index.js';
import { isNativeApp } from '../native.js';
import * as NATIVE from '../native.js';
import { diffTimetables, meetingLines } from '../diff.js';
import { resolveSemester } from '../semesters.js';
import {
  grabErrorInfo,
  grabHeadline,
  grabIsRunning,
  grabStepList
} from '../grab.js';
import {
  ICONS,
  SAMPLE_TEXT,
  banner,
  escapeHtml,
  panel,
  segmented,
  snackbar,
  subTopbar
} from './components.js';

const REASON_TEXT = {
  SOURCE_UNDETECTED: '未能识别页面来源',
  NO_COURSE_FOUND: '没有解析到课程',
  MISSING_DOW: '缺少星期',
  MISSING_PERIOD: '缺少节次',
  MISSING_NAME: '缺少课程名',
  MISSING_WEEKS: '缺少周次',
  MISSING_FIELD: '字段缺失',
  PERIOD_ORDER: '结束节次小于起始节次',
  INVALID_JSON: 'JSON 格式不合法',
  SCHEMA_UNSUPPORTED: '数据版本不兼容',
  EMPTY_INPUT: '内容为空',
  NO_WEEKDAY_HEADER: '表格里没有星期表头',
  DANGLING_COURSE: '课次指向了不存在的课程'
};

export function reasonText(reason) {
  return REASON_TEXT[reason] || reason || '未知原因';
}

/** 备用导入通道（只在「备用导入」二级页出现，主页面不暴露这些标签）。 */
const MANUAL_CHANNELS = [
  { value: 'text', label: '粘贴文本' },
  { value: 'html', label: 'HTML 源码' },
  { value: 'json', label: 'JSON' }
];

/** 通道说明文案。 */
function channelHint(channel) {
  if (channel === 'text') {
    return '从教务系统或其他网页课表复制文字，一行一节课。支持「周X + 节次/时间」多种写法。';
  }
  if (channel === 'html') {
    return '把教务系统课表页「另存为 HTML」后粘贴源码（或选择文件）。解析器会自动判别来源。';
  }
  return '粘贴本 App 导出的备份 JSON，或抓包得到的课表 JSON。支持版本校验。';
}

/**
 * 「App 内直接抓取」卡片：只在 Android 壳（`android/`）里出现。
 *
 * 登录发生在学校自己的页面里（App 内置 WebView 打开 jwgl.bupt.edu.cn），
 * 密码只提交给那个页面，本 App 不接收、不保存、不转发。
 */
function nativeCaptureCard() {
  return `<div class="card">
    <div class="card-title"><span class="dot"></span>从教务系统直接抓取（App 内）</div>
    <p class="tiny muted" style="line-height:1.7;margin:2px 0 12px">
      在 App 里打开教务系统，用学号密码自己登录，进到课表页点右上角「抓取课表」，
      就会自动回来生成预览。密码只提交给学校的页面，App 不接收也不保存。
      需要校园网或学校 VPN。
    </p>
    <button type="button" class="btn btn-primary btn-block" data-action="import-native-capture">
      ${ICONS.download} 打开教务系统并抓取
    </button>
  </div>`;
}

function sourceSelectHtml(uiState) {
  const options = [
    { value: 'auto', label: '自动判别' },
    { value: 'jwgl', label: '教务系统' }
  ];
  return `<div class="field">
    <label for="import-source">来源</label>
    <select class="select" id="import-source" data-field="importSource">
      ${options
        .map((o) => `<option value="${o.value}" ${uiState.importSource === o.value ? 'selected' : ''}>${o.label}</option>`)
        .join('')}
    </select>
    <p class="tiny muted" style="margin:6px 0 0">判别失败时请手动选择来源后重新解析。</p>
  </div>`;
}

/**
 * 「学期起始周」卡片（仅在原生抓取之后出现）。
 *
 * 三种状态：① 已按教务「当前第 N 周」自动设好；② 已手动设过、与识别值不同 → 让用户选；
 * ③ 没读到当前周 → 用户点一下"今天是第几周"即可反推开学日。
 */
function semesterAutoCard(uiState, state) {
  if (!uiState.nativeCaptureSeen) return '';
  const current = state.settings.semesterStartMonday || '';
  const guess = uiState.semesterGuess;
  const applied = uiState.semesterApplied;

  const head = `<div class="card-title"><span class="dot"></span>学期起始周</div>`;

  if (applied) {
    return `<div class="card">${head}
      <p class="small" style="margin:2px 0 0;line-height:1.7">
        已按教务页面「${escapeHtml(applied.source)} · 第 ${applied.week} 周」自动设置：
        第 1 周周一 = <b>${escapeHtml(applied.startMonday)}</b>
      </p>
      ${applied.term ? `<p class="tiny muted" style="margin:4px 0 0">教务学期：${escapeHtml(applied.term)}</p>` : ''}
      <p class="tiny muted" style="margin:6px 0 0">可在「设置 → 学期」修改；改完会按新日期重算周次。</p>
    </div>`;
  }

  if (current) {
    const conflict = guess && guess.startMonday !== current
      ? `<p class="small" style="margin:8px 0 0;line-height:1.7">
           ${guess.week ? `教务显示今天是第 <b>${guess.week}</b> 周（推得 ` : '按页面识别到第 1 周周一 '}
           <b>${escapeHtml(guess.startMonday)}</b>${guess.week ? '）' : ''}，
           与你当前的 <b>${escapeHtml(current)}</b> 不一致，已保持不动。
         </p>
         <button type="button" class="btn btn-sm btn-soft" style="margin-top:8px" data-action="semester-use-guess">
           采用 ${escapeHtml(guess.startMonday)}
         </button>`
      : `<p class="small" style="margin:2px 0 0">当前学期起始日：<b>${escapeHtml(current)}</b>（未改动）。</p>`;
    return `<div class="card">${head}${conflict}
      ${guess && guess.term ? `<p class="tiny muted" style="margin:6px 0 0">教务学期：${escapeHtml(guess.term)}</p>` : ''}
      <p class="tiny muted" style="margin:6px 0 0">要改可以去「设置 → 学期」。</p>
    </div>`;
  }

  if (guess && guess.startMonday && guess.strong) {
    return `<div class="card">${head}
      <p class="small" style="margin:2px 0 0;line-height:1.7">
        已识别学期：第 1 周周一 = <b>${escapeHtml(guess.startMonday)}</b>
        <span class="tiny muted">（${escapeHtml(guess.source || '页面识别')}${
          guess.term ? ` · ${escapeHtml(guess.term)}` : ''
        }${guess.week ? ` · 第 ${guess.week} 周` : ''}）</span>
      </p>
      <p class="tiny muted" style="margin:6px 0 0">点「确认导入」后会写入「设置 → 学期」；不对就去那里改。</p>
    </div>`;
  }

  const selected = guess && guess.week ? guess.week : '';
  const options = Array.from({ length: 20 }, (_, i) => i + 1)
    .map((w) => `<option value="${w}" ${Number(selected) === w ? 'selected' : ''}>第 ${w} 周</option>`)
    .join('');

  return `<div class="card">${head}
    <p class="small" style="margin:2px 0 10px;line-height:1.7">
      ${guess
        ? `教务的周次下拉停在「第 ${guess.week} 周」，如果那正是你这周，选一下就能定下来：`
        : '没读到教务的「当前第几周」。<b>今天是本学期第几周？</b>选一次即可反推出开学日：'}
    </p>
    <select class="select" data-field="semesterWeek" id="semester-week" aria-label="今天是第几周">
      <option value="">今天是第几周…</option>
      ${options}
    </select>
    <p class="tiny muted" style="margin:6px 0 0">会写入「设置 → 学期 → 第 1 周周一」，之后周次、提醒、节假日静默都按它算。</p>
  </div>`;
}

/* ---------------------------------------------------------------- 预览表 */

function previewHtml(draft, state) {
  if (!draft) return '';
  const courseById = new Map(draft.courses.map((c) => [c.id, c]));
  const rows = draft.sessions
    .map((s, index) => {
      const course = courseById.get(s.courseId) || { name: '' };
      return `<tr data-row="${index}">
        <td>
          <input value="${escapeHtml(course.name)}" data-edit="name" data-row="${index}" aria-label="课程名" />
        </td>
        <td>
          <select data-edit="dayOfWeek" data-row="${index}" aria-label="星期" title="星期">
            ${[1, 2, 3, 4, 5, 6, 7]
              .map((d) => `<option value="${d}" ${s.dayOfWeek === d ? 'selected' : ''}>周${'一二三四五六日'[d - 1]}</option>`)
              .join('')}
          </select>
        </td>
        <td>
          <input type="number" min="1" max="20" value="${s.startPeriod}" data-edit="startPeriod" data-row="${index}" aria-label="起始节次" />
        </td>
        <td>
          <input type="number" min="1" max="20" value="${s.endPeriod}" data-edit="endPeriod" data-row="${index}" aria-label="结束节次" />
        </td>
        <td>
          <input value="${escapeHtml(s.location || '')}" data-edit="location" data-row="${index}" aria-label="地点" />
        </td>
        <td>
          <input value="${escapeHtml(s.rawWeeksText || weeksToText(s.weeks))}" data-edit="weeks" data-row="${index}" aria-label="周次" />
        </td>
        <td>
          <button type="button" class="btn btn-sm btn-ghost" data-action="draft-remove" data-row="${index}" aria-label="删除该行">${ICONS.trash}</button>
        </td>
      </tr>`;
    })
    .join('');

  if (!draft.sessions.length) {
    return `<div class="card">${banner('warn', '没有可导入的课次，请检查内容或换一个通道。')}</div>`;
  }

  const warnings = draft.warnings.length
    ? `<div class="card" style="margin-bottom:10px">${draft.warnings
        .map((w) => banner('warn', escapeHtml(w)))
        .join('')}</div>`
    : '';

  const unrecognized = draft.unrecognized.length
    ? `<div class="section-label">未识别的内容（${draft.unrecognized.length} 条，不会静默丢弃）</div>
       <div class="card">
         ${draft.unrecognized
           .map(
             (u, i) => `<div class="list-row">
               <div class="grow">
                 <div class="lr-title" style="font-weight:500">${escapeHtml(
                   String(u.raw || '').slice(0, 120) || '（空）'
                 )}</div>
                 <div class="lr-sub">${escapeHtml(reasonText(u.reason))}</div>
               </div>
               <button type="button" class="btn btn-sm btn-soft" data-action="unrec-fix" data-index="${i}">补录</button>
               <button type="button" class="btn btn-sm btn-ghost" data-action="unrec-ignore" data-index="${i}">忽略</button>
             </div>`
           )
           .join('')}
       </div>`
    : '';

  const metaLine = `来源：${escapeHtml(
    { text: '通用文本', jwgl: '教务系统', wecom: '网页课表', json: 'JSON', unknown: '未识别' }[draft.meta.source] ||
      draft.meta.source
  )} · 策略 ${escapeHtml(draft.meta.strategy)} · ${draft.courses.length} 门课 / ${draft.sessions.length} 个课次`;

  const sem = draft.semester || null;
  const semLine =
    sem && (sem.code || sem.firstMonday)
      ? `<p class="tiny muted" style="margin:8px 0 0">学期：${escapeHtml(sem.code || '未识别')}${
          sem.firstMonday
            ? ` · 第 1 周周一 ${escapeHtml(sem.firstMonday)}${
                sem.source === 'calendar' ? '（内置校历）' : '（按页面周次推定，请核对）'
              }`
            : ' · 内置校历没有这一学期，导入后请在「设置 → 学期」填第 1 周周一'
        }</p>`
      : '';

  return `<div class="section-label">解析结果预览（可直接修改）</div>
    ${warnings}
    <div class="card">
      <p class="small muted" style="margin:0 0 8px">${metaLine}</p>
      ${semLine}
      <div class="table-scroll">
        <table class="preview-table">
          <colgroup>
            <col style="width:26%" /><col style="width:16%" /><col style="width:9%" />
            <col style="width:9%" /><col style="width:17%" /><col style="width:18%" /><col style="width:30px" />
          </colgroup>
          <thead><tr><th>课程名</th><th>星期</th><th>起</th><th>止</th><th>地点</th><th>周次</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
    ${unrecognized}
    <div class="btn-row" style="margin-top:14px">
      <button type="button" class="btn" data-action="import-cancel">取消</button>
      <button type="button" class="btn btn-primary" data-action="import-commit">确认导入 ${draft.sessions.length} 个课次</button>
    </div>`;
}

/* ---------------------------------------------------------------- 主渲染 */

/**
 * 按「课程」聚合草稿里的课次，供确认列表展示。
 *
 * 抓取结果是「课次」（一门课可能有多个时间段），用户要确认的是「课程」：
 * 每门课的时间（周几第几节 / 地点）与周次各一行。纯函数，可直接单测。
 *
 * @param {object} draft parseHtml/normalize 的产物
 * @returns {Array<{id:string,name:string,teacher:string,weeksText:string,meetings:Array}>}
 */
export function buildCourseSummary(draft) {
  if (!draft || !Array.isArray(draft.courses)) return [];
  const byId = new Map();
  for (const c of draft.courses) {
    byId.set(c.id, {
      id: c.id,
      name: String(c.name || ''),
      teacher: String(c.teacher || ''),
      weeks: [],
      meetings: []
    });
  }

  for (const s of Array.isArray(draft.sessions) ? draft.sessions : []) {
    const item = byId.get(s.courseId);
    if (!item) continue;
    const weeksText = String(s.rawWeeksText || weeksToText(s.weeks) || '').trim();
    if (weeksText && !item.weeks.includes(weeksText)) item.weeks.push(weeksText);
    item.meetings.push({
      day: Number(s.dayOfWeek) || 0,
      start: Number(s.startPeriod) || 0,
      end: Number(s.endPeriod) || 0,
      location: String(s.location || ''),
      teacher: String(s.teacher || '')
    });
  }

  const items = [...byId.values()].filter((it) => it.meetings.length > 0);
  for (const it of items) {
    it.meetings.sort((a, b) => a.day - b.day || a.start - b.start);
    it.weeksText = it.weeks.join(' / ');
    if (!it.teacher) it.teacher = it.meetings.find((m) => m.teacher)?.teacher || '';
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 主入口卡：App 里一个按钮抓取；浏览器里给跳转链接 + 去粘贴。 */
function entryCard(native) {
  if (native) {
    return `<div class="card">
      <div class="card-title"><span class="dot"></span>从教务系统导入</div>
      <p class="small muted" style="margin:2px 0 12px;line-height:1.7">
        在 App 里打开教务系统，用学号密码自己登录（密码只提交给学校页面，App 不接收也不保存）。
        进到课表页后抓取，回到这里核对课程列表再确认导入。需要校园网或学校 VPN。
      </p>
      <button type="button" class="btn btn-primary btn-block" data-action="import-native-capture">
        ${ICONS.download} 登录教务系统并抓取
      </button>
    </div>`;
  }
  return `<div class="card">
    <div class="card-title"><span class="dot"></span>从教务系统导入</div>
    <p class="small muted" style="margin:2px 0 12px;line-height:1.7">
      登录教务系统后，把课表页「另存为 HTML」或复制文字，回来粘贴解析。
      账号密码不经过这个页面——浏览器的同源策略也读不到别的域名。
    </p>
    <a class="btn btn-primary btn-block" href="https://jwgl.bupt.edu.cn/jsxsd/framework/xsMain_bjyddx.jsp"
       target="_blank" rel="noopener noreferrer" style="text-decoration:none">
      ${ICONS.upload} 打开教务系统登录页
    </a>
    <a class="btn btn-soft btn-block" href="#/import/manual" style="margin-top:8px;text-decoration:none">
      ${ICONS.copy} 我已拿到课表，去粘贴
    </a>
  </div>`;
}

/** 抓取后的「课程列表」确认卡：一门课一行，时间与周次都在这里。 */
function summaryCard(draft) {
  const items = buildCourseSummary(draft);
  const warnings = Array.isArray(draft.warnings) ? draft.warnings : [];
  const unrecognized = Array.isArray(draft.unrecognized) ? draft.unrecognized : [];

  const rows = items
    .map((it) => {
      const times = it.meetings
        .map((m) => {
          const day = WEEKDAY_FULL[m.day] || `周${m.day || '?'}`;
          const period = m.start === m.end ? `第 ${m.start} 节` : `第 ${m.start}-${m.end} 节`;
          return `<div class="ci-meta">${escapeHtml(day)} ${escapeHtml(period)}${
            m.location ? ` · ${escapeHtml(m.location)}` : ''
          }</div>`;
        })
        .join('');
      return `<div class="course-item">
        <div class="ci-head">
          <span class="ci-name">${escapeHtml(it.name)}</span>
          <span class="ci-weeks">${escapeHtml(it.weeksText || '周次未识别')}</span>
        </div>
        ${it.teacher ? `<div class="ci-meta ci-teacher">${escapeHtml(it.teacher)}</div>` : ''}
        ${times}
      </div>`;
    })
    .join('');

  const warnBox =
    warnings.length || unrecognized.length
      ? `<div class="divider"></div>
         <p class="small" style="margin:0 0 6px">有 <b>${warnings.length + unrecognized.length}</b> 处需要留意：</p>
         <ul class="steps" style="margin:0">
           ${warnings.slice(0, 4).map((w) => `<li>${escapeHtml(w)}</li>`).join('')}
           ${unrecognized
             .slice(0, 3)
             .map((u) => `<li>未能识别：<span class="mono">${escapeHtml(String(u.raw || '').slice(0, 40))}</span></li>`)
             .join('')}
         </ul>`
      : '';

  return `<div class="card">
    <div class="card-title"><span class="dot"></span>抓取到 ${items.length} 门课 · ${
      Array.isArray(draft.sessions) ? draft.sessions.length : 0
    } 个课次</div>
    <p class="tiny muted" style="margin:2px 0 10px">核对课程、上课时间与周次，没问题再确认导入。</p>
    <div class="course-list">${rows}</div>
    ${warnBox}
    <div class="btn-row" style="margin-top:12px">
      <button type="button" class="btn btn-primary grow" data-action="import-commit">确认导入</button>
      <a class="btn btn-soft" href="#/import/detail" style="text-decoration:none">逐条核对</a>
    </div>
    <button type="button" class="btn btn-ghost btn-block" style="margin-top:8px" data-action="grab-restart">
      ${ICONS.download} 重新抓取
    </button>
  </div>`;
}

/**
 * 导入主卡：**一个入口** —— 填学号密码，后台自动抓取，进度就在这张卡里长出来。
 *
 * 原来这里是两张卡：「从教务系统导入」要用户自己去学校页面点抓取，
 * 「更新课表（自动）」又要先存一次凭证再点更新。对用户来说这本就是一件事：
 * 我给你学号密码，你把课表拿回来。所以合成一张，按三态切换：
 *
 *   idle   → 表单
 *   run    → 进度条 + 步骤清单（可取消）
 *   failed → 原因 + 重试 + 手动兜底
 *
 * 浏览器里没有内置浏览器可用，保持原来的引导（去粘贴 / 下载 HTML）。
 */
function grabCard(state, uiState) {
  if (!isNativeApp()) return entryCard(false);
  const grab = uiState && uiState.grab ? uiState.grab : null;
  if (grabIsRunning(grab)) return grabRunningCard(grab);
  if (grab && grab.status === 'failed') return grabFailedCard(grab);
  return grabFormCard(state);
}

/** 待输入的形态：学号 + 密码（有已保存凭证时密码可留空）。 */
function grabFormCard(state) {
  const auto = NATIVE.grabSupported();
  const has = NATIVE.credHas();
  const account = has ? NATIVE.credAccount() : '';

  if (!auto) {
    // 老版本壳：没有后台抓取能力，别假装有——直接给手动路径
    return `<div class="card">
      <div class="card-title"><span class="dot"></span>从教务系统导入</div>
      <p class="tiny muted" style="margin:2px 0 12px;line-height:1.7">
        进入 App 内的教务系统，用学号密码自己登录，看到整周课表后点「抓取课表」，回来核对再导入。
      </p>
      <button type="button" class="btn btn-primary btn-block" data-action="import-native-capture">
        ${ICONS.download} 登录教务系统并抓取
      </button>
    </div>`;
  }

  const pwdPlaceholder = has ? '已保存，可留空' : '教务系统登录密码';
  return `<div class="card">
    <div class="card-title"><span class="dot"></span>从教务系统导入</div>
    <p class="tiny muted" style="margin:2px 0 12px;line-height:1.7">
      填好学号密码点一下就行：App 会在后台自动登录、打开课表、把课程读回来，你只管等进度跑完。
    </p>
    <form data-action="grab-start">
      <div class="field">
        <label for="grab-acc">学号</label>
        <input class="input" id="grab-acc" name="account" inputmode="numeric"
          autocomplete="username" value="${escapeHtml(account)}" placeholder="如 2021211001" required />
      </div>
      <div class="field">
        <label for="grab-pwd">教务系统密码</label>
        <input class="input" id="grab-pwd" name="password" type="password"
          autocomplete="current-password" placeholder="${pwdPlaceholder}" />
      </div>
      <label class="check-row">
        <input type="checkbox" name="remember" checked />
        <span>记住密码（系统密钥加密，只存在这台手机上，可随时清除）</span>
      </label>
      <button type="submit" class="btn btn-primary btn-block">自动导入课程</button>
    </form>
    <p class="tiny muted" style="margin:10px 0 0">
      教务系统只在校内网能访问，请连校园网或学校 VPN。
    </p>
    <button type="button" class="btn btn-ghost btn-block" style="margin-top:8px" data-action="import-native-capture">
      改用手动抓取（要验证码时用）
    </button>
    ${
      has
        ? `<button type="button" class="btn btn-ghost btn-block" style="margin-top:8px" data-action="cred-clear">清除已保存的账号</button>`
        : ''
    }
  </div>`;
}

/** 抓取中：进度条 + 五步清单。用户看的是"走到哪一步了"，不是一句干等。 */
function grabRunningCard(grab) {
  const steps = grabStepList(grab)
    .map((s) => `<li class="is-${s.state}">${escapeHtml(s.label)}</li>`)
    .join('');
  return `<div class="card">
    <div class="card-title"><span class="dot"></span>正在抓取课程</div>
    <div class="grab-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${grab.percent}">
      <i style="width:${grab.percent}%"></i>
    </div>
    <div class="grab-head">
      <b>${escapeHtml(grabHeadline(grab, Date.now()))}</b>
      <span class="mono">${grab.percent}%</span>
    </div>
    <ul class="grab-steps">${steps}</ul>
    <p class="tiny muted" style="margin:12px 0 0">
      全程在后台完成，不用你操作学校页面。第一次会慢一些（大约 10～30 秒）。
    </p>
    <button type="button" class="btn btn-ghost btn-block" style="margin-top:10px" data-action="grab-cancel">取消</button>
  </div>`;
}

/** 失败：说清是什么原因、本地数据没动、以及下一步怎么走。 */
function grabFailedCard(grab) {
  const info = grabErrorInfo(grab.error);
  const detail = grab.detail
    ? `<p class="tiny muted" style="margin:8px 0 0">技术细节：<span class="mono">${escapeHtml(grab.detail)}</span></p>`
    : '';
  return `<div class="card">
    <div class="card-title"><span class="dot"></span>没有抓成</div>
    ${banner('danger', `<b>${escapeHtml(info.title)}</b>`)}
    <p class="small" style="margin:8px 0 0;line-height:1.7">${escapeHtml(info.hint)}</p>
    ${detail}
    <p class="tiny muted" style="margin:8px 0 0">本地课表没有任何改动。</p>
    <div class="btn-row" style="margin-top:12px">
      <button type="button" class="btn btn-primary grow" data-action="grab-retry">重试</button>
      ${
        info.manual
          ? `<button type="button" class="btn btn-soft" data-action="import-native-capture">手动抓取</button>`
          : ''
      }
    </div>
    <button type="button" class="btn btn-ghost btn-block" style="margin-top:8px" data-action="grab-restart">换个学号密码</button>
  </div>`;
}

const UPDATE_ERROR_TEXT = {
  bad_credentials: '账号或密码可能已变更：自动登录没成功。本地课表没有被改动，请清除后重新保存，或手动抓取一次。',
  timeout: '自动抓取超时（校园网或教务系统较慢）。本地课表没有被改动，可以稍后重试。',
  no_form: '学校登录页结构变了，找不到登录框。请手动抓取一次（数据不会丢）。',
  no_timetable: '登录后没找到课表页。本地课表没有被改动，可以手动抓取一次。',
  read_failed: '抓取结果读取失败，本地课表没有被改动。',
  parse_failed: '抓到的页面解析失败，本地课表没有被改动。',
  unknown: '自动更新失败，本地课表没有被改动。'
};

function updateErrorText(code) {
  return UPDATE_ERROR_TEXT[code] || UPDATE_ERROR_TEXT.unknown;
}

/** 变更行：新增 / 删除 / 变更（时间·地点·周次）。 */
function diffItemHtml(kind, item) {
  if (kind === 'changed') {
    const before = meetingLines(item.before.meetings);
    const after = meetingLines(item.after.meetings);
    const line = (m) => `${m.day} ${m.period}${m.location ? ` · ${m.location}` : ''}`;
    return `<div class="diff-item is-changed">
      <div class="diff-head">
        <span class="diff-tag is-changed">变更</span>
        <span class="ci-name">${escapeHtml(item.name)}</span>
        <span class="diff-fields">${escapeHtml(item.fields.join(' / '))}</span>
      </div>
      <div class="ci-meta">原：${escapeHtml(before.map(line).join('；') || '—')}</div>
      <div class="ci-meta">新：${escapeHtml(after.map(line).join('；') || '—')}</div>
    </div>`;
  }
  const lines = meetingLines(item.meetings).map(
    (m) => `${m.day} ${m.period}${m.location ? ` · ${m.location}` : ''}${m.weeks ? ` · ${m.weeks}` : ''}`
  );
  return `<div class="diff-item ${kind === 'added' ? 'is-added' : 'is-removed'}">
    <div class="diff-head">
      <span class="diff-tag ${kind === 'added' ? 'is-added' : 'is-removed'}">${kind === 'added' ? '新增' : '删除'}</span>
      <span class="ci-name">${escapeHtml(item.name)}</span>
    </div>
    ${lines.map((l) => `<div class="ci-meta">${escapeHtml(l)}</div>`).join('')}
  </div>`;
}

/**
 * 变更确认页（`#/import/update`）。三态：
 *   ① 抓取失败 → 说明原因，明确"本地未改动"；
 *   ② 没有变化 → 已是最新；
 *   ③ 有变化 → 只列变化的课程 + 应用 / 保持不变。
 */
function updatePage(state, uiState) {
  const error = uiState.updateError;
  const diff = uiState.updateDiff;

  if (error || !diff) {
    return `${subTopbar('更新课表', '#/import', '没有应用任何改动')}
      <div class="page">
        ${banner('danger', `<b>${escapeHtml(updateErrorText(error))}</b>`)}
        <div class="btn-row">
          <a class="btn btn-soft" href="#/import" style="text-decoration:none">返回</a>
          <button type="button" class="btn btn-primary" data-action="update-fetch">再试一次</button>
        </div>
      </div>`;
  }

  if (!diff.hasChanges) {
    return `${subTopbar('更新课表', '#/import', '已是最新')}
      <div class="page">
        ${banner('info', `<b>课表没有变化</b>：本地 ${diff.unchanged} 门课与教务系统完全一致，不需要更新。`)}
        <div class="btn-row">
          <a class="btn btn-soft" href="#/import" style="text-decoration:none">返回</a>
          <button type="button" class="btn btn-primary" data-action="update-fetch">再查一次</button>
        </div>
      </div>`;
  }

  const { summary } = diff;
  const rows = [
    ...diff.added.map((it) => diffItemHtml('added', it)),
    ...diff.removed.map((it) => diffItemHtml('removed', it)),
    ...diff.changed.map((it) => diffItemHtml('changed', it))
  ].join('');

  return `${subTopbar('更新课表', '#/import', `共 ${summary.added + summary.removed + summary.changed} 处变化`)}
    <div class="page">
      <div class="card">
        <div class="card-title"><span class="dot"></span>这次抓取和本地比，变了这些</div>
        <p class="tiny muted" style="margin:2px 0 10px">
          新增 ${summary.added} · 删除 ${summary.removed} · 变更 ${summary.changed}
          ${diff.unchanged ? ` · 未变 ${diff.unchanged}` : ''}。
          <b>点「应用变更」之前，本地课表一个字都不会改。</b>
        </p>
        <div class="diff-list">${rows}</div>
        <div class="btn-row" style="margin-top:12px">
          <button type="button" class="btn btn-primary grow" data-action="update-apply">应用变更</button>
          <button type="button" class="btn btn-soft" data-action="update-discard">保持不变</button>
        </div>
        <p class="tiny muted" style="margin:8px 0 0">
          应用后会整份替换课程数据，并在「导入历史」里留一个可回滚的快照。
        </p>
      </div>
    </div>`;
}

/** 备用导入的输入区（只出现在「备用导入」二级页）。 */
function inputAreaHtml(channel, native, uiState) {
  return `<div class="card">
      <div class="field" style="margin-bottom:8px">
        <label for="import-text">${
          channel === 'html' ? 'HTML 源码' : channel === 'json' ? 'JSON 内容' : '课表文字'
        }</label>
        <textarea class="input ${channel === 'json' || channel === 'html' ? 'code' : ''}" id="import-text"
          data-field="importText" placeholder="${escapeHtml(channelHint(channel))}">${escapeHtml(
            uiState.importText || ''
          )}</textarea>
      </div>
      <div class="import-actions">
        <label class="btn btn-sm btn-soft" style="cursor:pointer">
          ${ICONS.upload} 选择文件
          <input type="file" accept=".html,.htm,.json,.txt,text/html,application/json,text/plain"
            data-field="importFile" style="display:none" />
        </label>
        ${
          channel === 'text'
            ? `<button type="button" class="btn btn-sm btn-ghost" data-action="import-sample">填充示例</button>`
            : ''
        }
        ${
          native
            ? `<button type="button" class="btn btn-sm btn-soft" data-action="import-native-capture">${ICONS.download} App 内抓取</button>`
            : ''
        }
      </div>
      <p class="tiny muted import-note">内容只在本机解析，不会上传</p>
      ${channel === 'html' ? sourceSelectHtml(uiState) : ''}
      <button type="button" class="btn btn-primary btn-block" data-action="import-parse">解析</button>
    </div>`;
}

/** 导入历史（可回滚），最多列 5 条。 */
function importHistoryHtml(state) {
  const list = Array.isArray(state.importHistory) ? state.importHistory : [];
  if (!list.length) return '';
  const rows = list
    .slice(0, 5)
    .map(
      (h) => `<div class="list-row">
        <div class="grow">
          <div class="lr-title">${Number(h.count) || 0} 个课次</div>
          <div class="lr-sub">${escapeHtml(formatIsoCn(h.at))}</div>
        </div>
        <button type="button" class="btn btn-sm btn-soft" data-action="import-rollback"
          data-history-id="${escapeHtml(String(h.id || ''))}">回滚到此版本</button>
      </div>`
    )
    .join('');
  return `<div class="section-label">导入历史（可回滚）</div><div class="card">${rows}</div>`;
}

export function renderImport(container, state, uiState) {
  const native = isNativeApp();
  const sub = uiState && uiState.sub ? uiState.sub : null;
  const draft = uiState.parseDraft || null;
  const rightBtn = `<button type="button" class="icon-btn" data-action="import-help" aria-label="格式说明">${ICONS.info}</button>`;

  /* ---- 二级页：逐条核对（原有可编辑表格） ---- */
  if (sub === 'detail') {
    container.innerHTML = `${subTopbar(
      '逐条核对',
      '#/import',
      draft ? `${draft.sessions.length} 个课次 · 可直接改单元格` : '还没有抓取结果'
    )}
      <div class="page">${draft ? previewHtml(draft, state) : '<div class="card"><p class="small muted" style="margin:0">还没有抓取结果，先回上一页抓取。</p></div>'}</div>`;
    return;
  }

  /* ---- 二级页：备用导入（粘贴文本 / HTML / JSON） ---- */
  if (sub === 'manual') {
    const channel = uiState.importChannel || 'text';
    container.innerHTML = `${subTopbar('备用导入', '#/import', '粘贴文本 / HTML 源码 / JSON')}
      <div class="page">
        <div class="section">${segmented(MANUAL_CHANNELS, channel, 'import-channel')}</div>
        ${inputAreaHtml(channel, native, uiState)}
        ${semesterAutoCard(uiState, state)}
        ${previewHtml(draft, state)}
      </div>`;
    return;
  }

  /* ---- 二级页：更新课表的变更确认 ---- */
  if (sub === 'update') {
    container.innerHTML = updatePage(state, uiState);
    return;
  }

  /* ---- 主页面：一个入口（表单/进度/失败三态）+ 抓取后的课程列表 ---- */
  const history = importHistoryHtml(state);
  container.innerHTML = `<div class="topbar">
      <div class="topbar-row">
        <div class="grow"><h1>导入</h1><p class="sub">填学号密码自动抓取 · 核对课程列表后导入</p></div>
        ${rightBtn}
      </div>
    </div>
    <div class="page">
      ${draft ? summaryCard(draft) : grabCard(state, uiState)}
      ${semesterAutoCard(uiState, state)}
      ${history}
      <p class="tiny muted" style="margin:16px 4px 0;text-align:center">
        其它方式：<a href="#/import/manual" style="color:inherit;text-decoration:underline">粘贴文本 / HTML / JSON</a>
      </p>
    </div>`;
}

/* ---------------------------------------------------------------- 动作实现 */

/** 执行解析，写入 uiState.parseDraft。 */
export function runParse(state, uiState) {
  const channel = uiState.importChannel || 'text';
  const text = uiState.importText || '';
  if (!text.trim()) {
    snackbar('请先粘贴或选择文件内容', { danger: true });
    return null;
  }
  const opts = {
    totalWeeks: state.settings.totalWeeks,
    periods: state.settings.periods
  };
  let draft;
  if (channel === 'html') {
    draft = parseHtml(text, {
      ...opts,
      source: uiState.importSource && uiState.importSource !== 'auto' ? uiState.importSource : 'auto',
      forceSource: uiState.importSource && uiState.importSource !== 'auto'
    });
  } else if (channel === 'json') {
    draft = parse(text, { ...opts, kind: 'json' });
  } else {
    draft = parse(text, { ...opts, kind: 'text' });
  }

  uiState.parseDraft = draft;
  // 顺手认一下学期：页面里有「2026-2027-1」就按内置校历推出第 1 周周一
  try {
    const sem = resolveSemester(text, todayStr());
    if (sem && (sem.code || sem.firstMonday)) draft.semester = sem;
  } catch (err) {
    /* 识别失败不影响解析 */
  }
  if (!draft.sessions.length) {
    snackbar('没有解析到课程，请查看下方未识别内容', { danger: true });
  } else {
    snackbar(`解析到 ${draft.sessions.length} 个课次，请核对后导入`);
  }
  return draft;
}

/** 预览表单元格编辑。 */
export function applyCellEdit(draft, rowIndex, field, value, totalWeeks = 20) {
  if (!draft || !draft.sessions[rowIndex]) return;
  const session = draft.sessions[rowIndex];
  const course = draft.courses.find((c) => c.id === session.courseId);

  if (field === 'name') {
    if (course) course.name = String(value).trim() || course.name;
    return;
  }
  if (field === 'dayOfWeek') {
    session.dayOfWeek = Number(value) || session.dayOfWeek;
    return;
  }
  if (field === 'startPeriod') {
    session.startPeriod = Math.max(1, Number(value) || 1);
    if (session.endPeriod < session.startPeriod) session.endPeriod = session.startPeriod;
    return;
  }
  if (field === 'endPeriod') {
    session.endPeriod = Math.max(session.startPeriod, Number(value) || session.startPeriod);
    return;
  }
  if (field === 'location') {
    session.location = String(value);
    return;
  }
  if (field === 'weeks') {
    session.weeks = parseWeeksText(value, totalWeeks);
    session.rawWeeksText = String(value);
  }
}

/** 删除预览表的一行。 */
export function removeDraftRow(draft, rowIndex) {
  if (!draft) return;
  draft.sessions.splice(rowIndex, 1);
}

/** 把一条「未识别」内容补录成课次（借 normalize 保证 id / 周次规则一致）。 */
export function mergeManualRow(draft, raw, totalWeeks) {
  const result = normalize(
    {
      courses: [],
      sessions: [raw],
      warnings: [],
      unrecognized: [],
      meta: { source: 'manual', detectedBy: 'manual', strategy: 'manual:row' }
    },
    { totalWeeks }
  );
  if (!result.sessions.length) {
    snackbar(result.unrecognized[0] ? reasonText(result.unrecognized[0].reason) : '补录失败', { danger: true });
    return false;
  }
  const newCourse = result.courses[0];
  const existing = draft.courses.find((c) => c.name === newCourse.name);
  let courseId = newCourse.id;
  if (existing) courseId = existing.id;
  else {
    draft.courses.push(newCourse);
  }
  draft.sessions.push({ ...result.sessions[0], courseId });
  return true;
}

/** 提交导入。 */
export function commitDraft(store, draft) {  if (!draft) return { ok: false, errors: ['没有可导入的内容'] };
  const result = store.dispatch({ type: 'IMPORT_COMMIT', payload: { parseResult: draft } });
  if (result.ok) {
    snackbar(`已导入 ${draft.sessions.length} 个课次`, {
      undo: () => {
        const history = store.getState().importHistory[0];
        if (history) store.dispatch({ type: 'IMPORT_ROLLBACK', payload: { historyId: history.id } });
        snackbar('已回滚到导入前的课表');
      }
    });
  }
  return result;
}

/**
 * 导入后校正节次表。
 *
 * 教务页面左列自带「第几节 + 起止时间」（北邮排到第 14 节：19:20-20:05 / 20:10-20:55），
 * 而 App 默认节次表只有 11 节。不校正的话，第 12-14 节的课在周视图里没有对应行——
 * 用户会以为"导入后晚上的课丢了"。所以：
 *   ① 课上到了表外 → 必须改用学校作息；
 *   ② 用户没手动改过节次表 → 顺手对齐（改过的表不覆盖）。
 */
export function adoptDetectedPeriods(store, draft) {
  const hint = draft && Array.isArray(draft.periodsHint) ? draft.periodsHint : null;
  if (!hint || hint.length < 6) return null;

  const current = (store.getState().settings.periods || []).slice().sort((a, b) => a.index - b.index);
  const same =
    current.length === hint.length &&
    current.every((p, i) => p.start === hint[i].start && p.end === hint[i].end);
  if (same) return null;

  const maxUsed = (draft.sessions || []).reduce((m, s) => Math.max(m, Number(s.endPeriod) || 0), 0);
  const overflow = maxUsed > current.length;
  const customized = current.some((p) => p.isCustom);
  if (customized && !overflow) return null;

  const result = store.dispatch({ type: 'ADOPT_PERIODS', payload: { periods: hint } });
  if (!result.ok) return null;
  return `节次表已按教务作息更新为 ${hint.length} 节`;
}

/**
 * 导入后自动设好学期：第 1 周周一 + 总周数。
 *
 * 依据是抓到的页面里那个学期代码（`2026-2027-1`）→ 内置校历（src/semesters.js）；
 * 内置没有的学期，退一步用页面上的「第 N 周」反推（标注为推定，用户可改）。
 * ★ 用户自己填过的学期起始日一律不覆盖。
 */
export function applyDetectedSemester(store, draft) {
  if (!draft) return null;
  const state = store.getState();
  const sem = draft.semester || null;
  const current = state.settings.semesterStartMonday;

  // 课程排到第 19 周而总周数只有 20 时不用动；排到表外就得抬上去，否则会被裁掉
  const maxWeek = (draft.sessions || []).reduce((m, s) => {
    const ws = expandWeeks(s.weeks);
    return ws.length ? Math.max(m, ws[ws.length - 1]) : m;
  }, 0);

  const needStart = !current && sem && sem.firstMonday;
  const needWeeks = maxWeek > (Number(state.settings.totalWeeks) || 0);

  if (!needStart && !needWeeks) {
    if (sem && sem.code && !sem.firstMonday && !current) {
      return `识别到学期 ${sem.code}，但内置校历没有这一学期，请到「设置 → 学期」填第 1 周周一`;
    }
    return null;
  }

  const result = store.dispatch({
    type: 'SET_SEMESTER',
    payload: {
      semesterStartMonday: needStart ? sem.firstMonday : current,
      totalWeeks: needWeeks ? maxWeek : state.settings.totalWeeks
    }
  });
  if (!result.ok) return null;

  const parts = [];
  if (needStart) {
    parts.push(`第 1 周周一 ${sem.firstMonday}${sem.source === 'calendar' ? '（内置校历）' : '（按页面周次推定）'}`);
  }
  if (needWeeks) parts.push(`总周数 ${maxWeek}`);
  return `学期已自动设好：${parts.join('，')}`;
}

/** 文件读取（FileReader 只在浏览器可用）。 */
export function readFileInto(file, callback) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => callback(String(reader.result || ''));
  reader.onerror = () => snackbar('文件读取失败', { danger: true });
  reader.readAsText(file, 'utf-8');
}

export { SAMPLE_TEXT };
