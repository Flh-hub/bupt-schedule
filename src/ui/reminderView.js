/**
 * ui/reminderView.js — 提醒 Tab：通知权限 / 提醒方式 / 提前量 / 单课程覆盖 / 今日时间轴。
 *
 * 【纪律】
 *  1. 今日时间轴必须直接用 `getReminders(today, today).points` 渲染，不另算，
 *     保证「时间轴条数 === 真正会响的条数」。
 *  2. ★ `getReminders` 返回**计划对象**（`{points, pendingDates, skipped, warnings}`），
 *     必须解构使用（G12：禁止把它的返回值直接当数组遍历）。
 *  3. 日历(.ics) 导出已移除：提醒只走「原生系统闹钟 + 通知」，不再有第二条通道。
 */

import {
  addDays,
  courseColor,
  epochToDateStr,
  epochToWall,
  formatIsoCn,
  normalizeCourseName,
  todayStr
} from '../model.js';

// 兼容既有调用方与测试：规范化逻辑本身在 model.js（课表页也要用同一份）
export { normalizeCourseName };
import { getReminders } from '../calendar.js';
import { formatDue, getHomeworkReminders } from '../homeworkReminder.js';
import { permissionState, requestPermission } from '../reminder.js';
import * as NATIVE from '../native.js';
import { courseAvatar, entryRow, subTopbar } from './components.js';
import { CORE_CHECKLIST, WIDGET_NOTES, orderedBrands } from '../keepalive.js';
import { batteryModeCardHtml, openAospBatteryListPage, openSystemBatteryPage } from './batteryMode.js';
import { checklistReady } from './onboard.js';
import {
  ICONS,
  banner,
  chips,
  confirmDialog,
  escapeHtml,
  panel,
  segmented,
  sheet,
  snackbar,
  toggleSwitch
} from './components.js';

const ADVANCE_CHOICES = [0, 5, 10, 15, 20, 30, 45, 60];

const PERMISSION_TEXT = {
  granted: '通知权限已开启',
  denied: '通知权限被拒绝',
  default: '尚未授权通知',
  unsupported: '当前环境不支持网页通知'
};

/** 安卓壳里用**系统通知**，浏览器里用 Notification API——不要混着说。 */
const NATIVE_PERMISSION_TEXT = {
  granted: '系统通知已开启：到点由系统闹钟提醒，App 被杀掉也会响',
  denied: '系统通知被拒绝，请到「设置 → 应用 → 北邮课程表 → 通知」打开',
  default: '还没授权系统通知，点下面按钮开启'
};

/**
 * 当前通知权限。
 * 安卓壳：问原生（POST_NOTIFICATIONS）；浏览器：问 Notification.permission。
 */
function currentPermission() {
  return NATIVE.notifySupport() ? NATIVE.notifyPermission() : permissionState();
}

/** 权限状态卡。 */
function permissionCard() {
  const native = NATIVE.notifySupport();
  const perm = currentPermission();
  const badgeHtml =
    perm === 'granted'
      ? '<span class="badge">已授予</span>'
      : perm === 'denied'
        ? '<span class="badge badge-danger">已拒绝</span>'
        : perm === 'unsupported'
          ? '<span class="badge badge-gray">不可用</span>'
          : '<span class="badge badge-warn">未询问</span>';

  // 已授予时不放任何按钮：发演示通知是开发期手段，正式版不该出现在用户面前
  const action =
    perm === 'granted'
      ? ''
      : `<button type="button" class="btn btn-primary btn-block" data-action="perm-request">${
          native ? '开启系统通知' : '申请通知权限'
        }</button>`;

  const remedy = native
    ? perm === 'denied'
      ? `<div class="divider"></div>
         <p class="small muted" style="margin:0 0 6px">被拒后系统不再弹窗，需要手动开：</p>
         <ol class="steps">
           <li>手机「设置 → 应用管理 → 北邮课程表」</li>
           <li>进入「通知」→ 允许通知（并打开「提醒」类别）</li>
           <li>ColorOS 再到「电池 → 允许后台活动」</li>
         </ol>`
      : ''
    : perm === 'denied'
      ? `<div class="divider"></div>
         <p class="small muted" style="margin:0 0 6px">被拒后浏览器不再弹窗，需要手动开启：</p>
         <ol class="steps">
           <li>打开手机「设置 → 应用管理 → Chrome」</li>
           <li>进入「通知」→ 允许通知</li>
           <li>ColorOS 还需「电池 → 允许后台活动」</li>
           <li>回到本应用，下拉刷新即可</li>
         </ol>`
      : '';

  const desc = native
    ? NATIVE_PERMISSION_TEXT[perm] || ''
    : `${PERMISSION_TEXT[perm] || ''}${perm === 'granted' ? '，应用在前台或后台存活期间会按时提醒。' : '。'}`;

  return `<div class="card">
    <h2 class="card-title"><span class="dot"></span>${native ? '系统通知' : '通知权限'} ${badgeHtml}</h2>
    <p class="small muted" style="margin:0 0 10px">${escapeHtml(desc)}</p>
    ${action}
    ${remedy}
  </div>`;
}

/** 今日提醒时间轴（含"待确认"提示）。 */
function timelineCard(state, now) {
  const today = todayStr(now);
  const plan = getReminders(state, today, today);
  const { points, pendingDates } = plan;

  const pendingBanner = pendingDates.length
    ? banner(
        'warn',
        `今天是<b>调休上班日但尚未确认</b>，因此没有生成提醒。请到课表页点选"按周几上课"。`
      )
    : '';

  if (!points.length) {
    return `<div class="card">
      <h2 class="card-title"><span class="dot"></span>今日提醒</h2>
      ${pendingBanner}
      <p class="small muted" style="margin:0">今天没有提醒点。可能是当天无课、已停课，或命中法定节假日（自动静默）。</p>
    </div>`;
  }

  const items = points
    .map((p) => {
      const past = p.triggerAt <= now;
      return `<div class="tl-item ${past ? 'is-past' : ''}">
        <div class="tl-time">${escapeHtml(epochToWall(p.triggerAt))} ${past ? '✓ 已提醒' : '将提醒'}</div>
        <div class="tl-title">${escapeHtml(normalizeCourseName(p.courseName))}</div>
        <div class="tl-sub">${escapeHtml(p.classStart)} 上课 · ${escapeHtml(p.location || '地点待定')} · 提前 ${
          p.advanceMinutes
        } 分钟</div>
      </div>`;
    })
    .join('');

  return `<div class="card">
    <h2 class="card-title"><span class="dot"></span>今日提醒（${points.length} 次）</h2>
    ${pendingBanner}
    <div class="timeline">${items}</div>
    <p class="tiny muted" style="margin:10px 0 0">法定节假日与「已停课」的课次不会出现在这里。</p>
  </div>`;
}

/**
 * 把课程按规范化名字分组。
 *
 * 只有真的出现 2 条以上同名课程才合并；单条一律保留原名，
 * 免得把「高等数学 A」（真的只有一个 A 班）的班级信息吃掉。
 *
 * @param {Array<{id:string,name:string,color?:string}>} courses
 * @returns {Array<{key:string,name:string,ids:string[],courses:Array<object>}>}
 */
export function groupCourses(courses) {
  const list = Array.isArray(courses) ? courses.filter(Boolean) : [];
  const map = new Map();
  for (const c of list) {
    const key = normalizeCourseName(c.name);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return [...map.entries()].map(([key, group]) => ({
    key,
    name: group.length > 1 ? key : group[0].name,
    ids: group.map((c) => c.id),
    courses: group
  }));
}

/** 课程级覆盖列表。 */
function rulesCard(state) {
  if (!state.courses.length) {
    return `<div class="card"><p class="small muted" style="margin:0">还没有课程，导入课表后可在这里做单课程提醒覆盖。</p></div>`;
  }
  const ruleByCourse = new Map(state.settings.reminder.rules.map((r) => [r.targetId, r]));
  const rows = groupCourses(state.courses)
    .map((g) => {
      const first = g.courses[0];
      // 合并组里只要有一条设过，就当作这组设过（设置时是整组一起写的）
      const rule = g.ids.map((id) => ruleByCourse.get(id)).find(Boolean) || null;
      const off = rule && rule.enabled === false;
      const idsAttr = escapeHtml(g.ids.join(','));
      const merged = g.ids.length;
      // 没设过就不写「跟随全局默认」——多行重复同一句话只是噪音（顶栏已说明）
      const sub = rule
        ? off
          ? '已关闭提醒'
          : `提前 ${rule.advanceMinutes} 分钟`
        : merged > 1
          ? `合并 ${merged} 个教学班`
          : '';
      return `<div class="pick-row" data-action="rule-edit" data-course-ids="${idsAttr}" data-course-id="${escapeHtml(
        first.id
      )}" role="button" tabindex="0">
        ${courseAvatar(g.name, courseColor(first))}
        <div class="pick-main">
          <div class="pick-title">${escapeHtml(g.name)}</div>
          ${sub ? `<div class="pick-sub ${rule ? 'is-set' : ''}">${escapeHtml(sub)}</div>` : ''}
        </div>
        ${
          rule
            ? `<button type="button" class="pick-reset" data-action="rule-delete" data-course-ids="${idsAttr}"
                 aria-label="「${escapeHtml(g.name)}」恢复跟随全局默认">${ICONS.undo}</button>`
            : ''
        }
        <span class="pick-chev" aria-hidden="true">›</span>
      </div>`;
    })
    .join('');
  return `<div class="card pick-card">${rows}</div>`;
}

/**
 * 「下一条提醒」卡片：把**真正排进系统闹钟**的那一条显示出来。
 *
 * 【为什么要有这一块】
 * 删掉那个「一键弹一条演示提醒」的入口之后，用户失去了「我的提醒到底排上了没有」的可见入口。
 * 这里读的是 `getReminders` 的同一份 points（`main.js syncNativeAlarms` 也用它
 * 推给 AlarmManager），所以**显示的时间就是真会响的时间**，不是另算一份，
 * 也不需要伪造任何通知。精确闹钟被收回、后台被系统掐，这里的时间就会停在原地
 * 或者干脆不出现——这是唯一诚实的「验证方式」。
 *
 * 【时间口径】
 * 大字写的是**发出时间**（课前 N 分钟），副行才是上课时间。两者不能混：
 * 曾经把触发时间拼进标题，被当成了上课时间。
 *
 * 只列一条：今日全量已在下面的「今日提醒」时间轴里，这里重复铺开会变成噪音。
 */
const ALARM_HORIZON_DAYS = 7; // 与 main.js syncNativeAlarms 的 7 天一致，多了就是"显示但没排"

function whenLabel(epoch, now) {
  const dateStr = epochToDateStr(epoch);
  if (dateStr === todayStr(now)) return '今天';
  if (dateStr === todayStr(now + 86400000)) return '明天';
  if (dateStr === todayStr(now + 2 * 86400000)) return '后天';
  const d = new Date(epoch);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`;
}

function nextReminderCard(plan, now) {
  const horizon = now + ALARM_HORIZON_DAYS * 86400000;
  const upcoming = ((plan && plan.points) || []).filter((p) => p.triggerAt > now && p.triggerAt <= horizon);

  if (!upcoming.length) {
    return `<div class="card">
      <h2 class="card-title"><span class="dot"></span>下一条提醒</h2>
      <p class="small muted" style="margin:0">未来 ${ALARM_HORIZON_DAYS} 天没有排上的提醒。可能是没课、已停课，或整段落在假期里。</p>
    </div>`;
  }

  const next = upcoming[0];
  return `<div class="card">
    <h2 class="card-title"><span class="dot"></span>下一条提醒</h2>
    <div class="tl-item">
      <div class="tl-time">${escapeHtml(whenLabel(next.triggerAt, now))} ${escapeHtml(
        epochToWall(next.triggerAt)
      )} 发出</div>
      <div class="tl-title">${escapeHtml(normalizeCourseName(next.courseName))}</div>
      <div class="tl-sub">${escapeHtml(next.classStart)} 上课 · ${escapeHtml(
        next.location || '地点待定'
      )} · ${escapeHtml(next.periodText)} · 提前 ${next.advanceMinutes} 分钟</div>
    </div>
    <p class="tiny muted" style="margin:10px 0 0">已交给系统闹钟，App 没打开也会响。未来 ${ALARM_HORIZON_DAYS} 天共 ${
      upcoming.length
    } 次；到点没响，先看通知权限和后台运行。</p>
  </div>`;
}

/** 主渲染。 */
/**
 * 作业截止提醒卡片。
 *
 * 说明必须写清「什么时候会响」——用户看不见闹钟，只能靠这行字判断要不要开。
 * 也把「没有截止时间的不提醒」讲明白，否则会以为是漏了。
 */
function homeworkReminderCard(state, now) {
  const cfg = (state.settings && state.settings.homeworkReminder) || {};
  const on = cfg.enabled !== false;
  const hour = Number.isInteger(Number(cfg.hour)) ? Number(cfg.hour) : 20;
  let next = null;
  try {
    next = getHomeworkReminders(state, now)[0] || null;
  } catch (err) {
    next = null;
  }
  const count = Array.isArray(state.homework && state.homework.items)
    ? state.homework.items.length
    : 0;

  let sub = `截止日前一天 ${hour}:00 提醒一次`;
  if (on && next) {
    const remain = next.courseName ? `${next.courseName} · ${next.title}` : next.title;
    sub = `下次 ${formatDue(next.triggerAt)} · ${remain}`;
  } else if (count === 0) {
    sub = '还没有作业数据，抓取一次后生效';
  } else if (!next) {
    sub = '当前没有需要提醒的作业（无截止时间或已过期）';
  }

  return `
    <div class="section-label">作业截止提醒</div>
    <div class="card">
      <div class="list-row">
        <div class="grow">
          <div class="lr-title">作业要交了，提前一天说一声</div>
          <div class="lr-sub">${escapeHtml(sub)}</div>
        </div>
        ${toggleSwitch(on, 'homework-reminder-enabled', '作业截止提醒')}
      </div>
      <div class="list-row">
        <div class="grow">
          <div class="lr-sub">没有截止时间的作业不会提醒；已截止的不再打扰。</div>
        </div>
      </div>
    </div>`;
}

export function renderReminder(container, state, uiState) {
  const now = Date.now();
  const sub = uiState && uiState.sub ? uiState.sub : null;
  const native = NATIVE.notifySupport();

  // 二级页：后台保活设置（按机型给操作路径）
  if (sub === 'keepalive') {
    container.innerHTML = keepalivePage();
    return;
  }

  // 二级页：修改后台运行模式（所有"电池优化"入口的落点）
  if (sub === 'battery-mode') {
    container.innerHTML = batteryModePage();
    return;
  }

  // 二级页：单课程覆盖（以前十几门课平铺在主页面，滚到底都找不到东西）
  if (sub === 'courses') {
    const rules = Array.isArray(state.settings.reminder.rules) ? state.settings.reminder.rules.length : 0;
    container.innerHTML = `${subTopbar(
      '单课程提醒',
      '#/reminder',
      `${groupCourses(state.courses).length} 门课${rules ? ` · 已单独设置 ${rules} 门` : ' · 默认跟随全局'}`
    )}
      <div class="page">${rulesCard(state)}</div>`;
    return;
  }
  const perm = currentPermission();
  // 必开项都开好了 → 「后台运行」那组入口收进一个折叠项，别一直占着屏幕
  const backendReady = checklistReady();
  const backendEntries = () => `
        ${entryRow(
          '#/reminder/keepalive',
          '后台保活设置',
          NATIVE.deviceBrand() || '按机型看',
          '不设也能用；设了之后闹钟更准、后台更新不会被掐断'
        )}
        ${entryRow(
          '#/reminder/battery-mode',
          '修改后台运行模式',
          NATIVE.batteryExempt() === true ? 'AOSP 已豁免' : '要选「完全后台运行」',
          '别停在「智能优化」：省电时它会清掉已排的闹钟'
        )}
        <button type="button" class="entry-row" data-action="onboard-open"
          style="width:100%;background:none;border:0;border-bottom:0;text-align:left;font:inherit">
          <span class="entry-main">
            <span class="entry-label">权限一键检查</span>
            <span class="entry-desc">通知 / 精确闹钟 / 电池优化 是否都开了</span>
          </span>
          <span class="entry-value">检查<i class="entry-chev">›</i></span>
        </button>`;
  const reminder = state.settings.reminder;
  const rulesCount = Array.isArray(reminder.rules) ? reminder.rules.length : 0;

  // 待确认补班日：顶部常驻告警（不依赖"今天"是否有课）。
  // 区间 = 整个学期（没配学期时看未来 4 周），由 calendar 算真实日期，UI 不自己推。
  const totalWeeks = Math.max(1, Number(state.settings.totalWeeks) || 20);
  const semStart = state.settings.semesterStartMonday;
  const from = semStart || todayStr(now);
  const to = semStart ? addDays(from, totalWeeks * 7 - 1) : addDays(from, 27);
  const plan = getReminders(state, from, to);
  const pendingBanner = plan.pendingDates.length
    ? banner(
        'warn',
        `<b>${plan.pendingDates.length} 个调休上班日待确认</b>（${plan.pendingDates
          .map((d) => escapeHtml(d))
          .join('、')}）：确认前不会生成提醒，也不会写进日历。`,
        `<button class="btn btn-sm btn-soft" data-action="nav" data-route="#/timetable">去确认</button>`
      )
    : '';

  // 安卓壳里走系统通知，不存在"浏览器不支持"这回事——那条提示只在网页版显示
  const downgrade = native
    ? ''
    : perm === 'granted'
      ? ''
      : banner(
          perm === 'unsupported' ? 'warn' : 'danger',
          perm === 'unsupported'
            ? '当前访问方式不支持网页通知（例如直接用 file:// 打开）。请用 http(s) 访问，或直接使用系统日历通道。'
            : '应用内通知不可用/未授权，<b>建议使用系统日历通道</b>，它不依赖浏览器是否存活。'
        );

  const customAdvance = ADVANCE_CHOICES.includes(reminder.defaultAdvanceMinutes)
    ? ''
    : `<span class="badge">自定义 ${reminder.defaultAdvanceMinutes} 分钟</span>`;

  container.innerHTML = `<div class="topbar">
      <div class="topbar-row">
        <div class="grow"><h1>提醒</h1><p class="sub">提前量与通道可自定义 · 节假日自动静默</p></div>
      </div>
    </div>
    <div class="page">
      ${pendingBanner}
      ${downgrade}
      ${permissionCard()}
      ${nextReminderCard(plan, now)}

      <div class="section-label">提醒方式</div>
      <div class="card">
        <div class="list-row">
          <div class="grow">
            <div class="lr-title">应用内通知</div>
            <div class="lr-sub">关闭后不产生应用内提醒（日历通道仍可用）</div>
          </div>
          ${toggleSwitch(reminder.enabled !== false, 'reminder-enabled', '应用内通知')}
        </div>
        <div class="list-row">
          <div class="grow">
            <div class="lr-title">提醒声音</div>
            <div class="lr-sub">系统静音模式下仍可能无声</div>
          </div>
          ${toggleSwitch(reminder.sound !== false, 'reminder-sound', '提醒声音')}
        </div>
        <div class="list-row">
          <div class="grow">
            <div class="lr-title">震动</div>
            <div class="lr-sub">部分机型需在系统设置中允许震动</div>
          </div>
          ${toggleSwitch(reminder.vibrate !== false, 'reminder-vibrate', '震动')}
        </div>
      </div>

      ${homeworkReminderCard(state, now)}

      <div class="section-label">默认提前量 ${customAdvance}</div>
      <div class="card">
        ${chips(
          ADVANCE_CHOICES.map((m) => ({ value: m, label: m === 0 ? '准时' : `${m} 分钟` })),
          reminder.defaultAdvanceMinutes,
          'reminder-advance'
        )}
        <button type="button" class="btn btn-sm btn-ghost" style="margin-top:10px" data-action="reminder-advance-custom">
          自定义分钟数
        </button>
      </div>

      <div class="section-label">单课程</div>
      <div class="entry-list">
        ${entryRow(
          '#/reminder/courses',
          '单课程提醒',
          `${groupCourses(state.courses).length} 门${rulesCount ? ` · 已设 ${rulesCount}` : ''}`,
          '默认跟随全局；某门课想提前更多或不想提醒，单独改这里'
        )}
      </div>

      ${
        backendReady
          ? panel(
              '后台运行 · 已就绪',
              `<div class="entry-list" style="margin:0">${backendEntries()}</div>`,
              false
            )
          : `<div class="section-label">后台运行</div>
             <div class="entry-list">${backendEntries()}</div>`
      }

      <div class="section-label">今天</div>
      ${timelineCard(state, now)}

      <div class="section-label">提醒是怎么发出来的</div>
      ${panel(
        native ? 'App 内通知与日历有什么区别？' : '为什么网页通知不保证送达？',
        native
          ? `<ol>
               <li><b>App 内通知</b>：网页算好未来 7 天的提醒点交给系统闹钟（AlarmManager），到点由系统发通知——锁屏、清后台、App 被杀都会响。</li>
               <li><b>不需要常驻后台</b>：闹钟交给系统，App 没打开也会响。</li>
               <li><b>改了课会自动重排</b>：数据变更后 800ms 内重新排程。</li>
             </ol>
             <p style="margin:8px 0 0">要让通知真的响，还需两步：授予通知权限；ColorOS 里允许「自启动」和「电池 → 允许后台活动」。</p>`
          : `<p style="margin:0 0 8px">浏览器会冻结后台页面，页面里的定时器随之停止，所以网页版通知只有在页面存活期间才可靠。</p>
             <ol>
               <li><b>装成 App 最稳</b>：安卓 App 用系统闹钟发通知，锁屏、清后台也会响。</li>
               <li><b>回到前台补发</b>：每次切回页面会重算当天剩余课程，并补发 5 分钟内错过的提醒。</li>
               <li><b>诚实告知</b>：网页版不承诺「一定送达」。</li>
             </ol>`,
        (uiState.openPanels || new Set()).has('limit'),
        ICONS.alert
      )}
    </div>`;
}

/**
 * 「后台保活设置」页：按当前机型给出**具体设置路径**。
 *
 * 为什么需要单独一页：Android 各厂商都自带一层「自启动 / 后台活动」限制，
 * 系统级别的电池优化白名单管不到它。这些开关决定闹钟会不会被清、后台更新能否跑完。
 *
 * 【信息分层】
 * 这一页以前把所有东西平铺出来（三件事 + 五步 + 小组件 + 验证 + 其它系统），
 * 一屏根本看不完，而且"三件事"和下面的分步操作是同一批内容的两种说法。
 * 现在只留"做什么"和"在哪做"两段；逐步操作 / 小组件 / 验证全部折起来 ——
 * 想看细节的人点开，不想看的人直接滑过去。
 */
function keepalivePage() {
  const native = NATIVE.notifySupport() || NATIVE.deviceBrand() !== '';
  const { current, others } = orderedBrands(NATIVE.deviceBrand());
  const exempt = NATIVE.batteryExempt();
  const model = NATIVE.deviceModel();

  const bold = (text) => escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const steps = (list) => `<ol class="steps">${list.map((x) => `<li>${bold(x)}</li>`).join('')}</ol>`;

  const statusLine =
    exempt === null
      ? '<p class="tiny muted" style="margin:0 0 8px">浏览器里读不到系统状态；下面的按钮只在 App 内有效。</p>'
      : exempt
        ? '<p class="small" style="margin:0 0 8px">电池优化：<b style="color:#1a7f5a">已豁免</b></p>'
        : '<p class="small" style="margin:0 0 8px">电池优化：<b style="color:#b7791f">未豁免</b>（省电时闹钟会被推迟）</p>';

  return `${subTopbar('后台保活设置', '#/reminder', `${current.name}${model ? ` · ${model}` : ''}`)}
    <div class="page">
      <div class="card">
        <div class="card-title"><span class="dot"></span>只做三件事</div>
        ${statusLine}
        ${steps(CORE_CHECKLIST)}
        ${
          native
            ? `<div class="btn-row" style="margin-top:12px">
                 <button type="button" class="btn btn-soft grow" data-action="keepalive-app-settings">应用设置</button>
                 <button type="button" class="btn btn-primary grow" data-action="nav" data-route="#/reminder/battery-mode">耗电管理</button>
               </div>`
            : ''
        }
        <p class="tiny muted" style="margin:10px 0 0">不做也能看课表，只是提醒可能不响。</p>
      </div>

      <div class="section-label">你的机型：${escapeHtml(current.name)}</div>
      <div class="card">
        <p class="small" style="margin:0 0 6px"><b>入口</b>：${current.path
          .map((x) => `<span class="mono">${escapeHtml(x)}</span>`)
          .join('；')}</p>
        <p class="small muted" style="margin:0"><b>不设会怎样</b>：${escapeHtml(current.impact)}</p>
      </div>
      ${panel('逐步操作', steps(current.steps))}
      ${panel(
        '桌面小组件',
        `<p class="small muted" style="margin:0 0 8px">${escapeHtml(current.widget || '')}</p>${steps(WIDGET_NOTES)}`
      )}
      ${panel(
        '怎么验证有没有生效',
        `<ol class="steps">
           <li>锁屏放 10 分钟再回来，打开 App 课表还在、提醒页状态正常，说明没被系统清掉。</li>
           <li>下一节课开始前 N 分钟，通知栏是否准时出现「N分后上课」。</li>
           <li>如果只在亮屏时准、锁屏就不准，基本就是「后台活动 / 自启动」没放开。</li>
         </ol>`
      )}

      <div class="section-label">其它系统</div>
      ${others
        .map((b) =>
          panel(
            b.name,
            `<p class="tiny muted" style="margin:0 0 8px">入口：${b.path.map((x) => `<span class="mono">${escapeHtml(x)}</span>`).join('；')}</p>
             ${steps(b.steps)}
             <p class="small muted" style="margin:8px 0 0"><b>影响：</b>${escapeHtml(b.impact)}</p>`,
            false
          )
        )
        .join('')}

      <p class="tiny muted" style="margin:16px 4px 0;text-align:center">
        这些开关只能在系统设置里开，本应用不会替你关省电。
      </p>
    </div>`;
}

/**
 * 「修改后台运行模式」页 —— 所有"电池优化"入口的统一落点。
 *
 * 【为什么单独一页，而不是点了直接甩系统设置】
 * 见 `ui/batteryMode.js` 顶部：AOSP 那层（忽略电池优化）管不到 ColorOS 那层
 * （耗电行为控制），用户跳到 AOSP 页面改完，回来后台照样被杀。
 * 所以必须先在这一页把"要选完全后台运行"讲清楚，再跳过去。
 *
 * 页面状态（上次落点提示 / 上次检测结论）存在模块级变量里，
 * 因为整页是 innerHTML 重建的，组件内 state 会被冲掉。
 */
let batteryPageHint = '';
function batteryModePage() {
  const model = NATIVE.deviceModel();
  const brand = NATIVE.deviceBrand();

  return `${subTopbar(
    '修改后台运行模式',
    '#/reminder',
    `${brand || '当前机型'}${model ? ` · ${model}` : ''}`
  )}
    <div class="page">
      ${batteryModeCardHtml({ hint: batteryPageHint })}
      <div class="btn-row" style="margin-top:12px">
        <button type="button" class="btn btn-primary grow" data-action="battery-open-system">
          打开「耗电管理」页
        </button>
      </div>
      <p class="tiny muted" style="margin:8px 4px 0;line-height:1.7">
        会直接跳到<b>「耗电行为控制」</b>那三个选项。找不到时退回「设置 › 应用 › 北邮课程表」，
        点这一页的「耗电管理」即可。
      </p>
      <button type="button" class="btn btn-ghost btn-block" style="margin-top:8px" data-action="battery-open-aosp">
        另外打开「电池优化」列表（AOSP 层，两层都要开）
      </button>
      <p class="tiny muted" style="margin:12px 4px 0;line-height:1.7">
        检测只能读到 AOSP 那层的豁免状态；ColorOS 的「耗电管理」系统不提供查询，
        需要你自己确认那一页选的是「完全允许后台行为」。<br />
        做完这一项，课前的「N分后上课」才会连续跳动、提醒才不会被系统掐掉。
      </p>
    </div>`;
}

/** 「打开系统页」：跳过去并记住落点，回来时页面还在这一页。 */
export function openBatteryModeSystemPage() {
  const r = openSystemBatteryPage();
  batteryPageHint = r.hint;
  // 没直达耗电页 → 自动展开诊断，用户随手截图就能反馈
  return r;
}


/** 「另外打开电池优化列表」：AOSP 那层，和厂商的耗电管理是两件事。 */
export function openAospBatteryPage() {
  const r = openAospBatteryListPage();
  batteryPageHint = r.hint;
  return r;
}

/* ---------------------------------------------------------------- 动作实现 */

/** 打开自定义提前量表单。 */
export function openAdvanceSheet(state, store) {
  const current = state.settings.reminder.defaultAdvanceMinutes;
  sheet({
    title: '自定义默认提前量',
    body: `<div class="field">
        <label for="adv-input">提前分钟数（0–1440）</label>
        <input class="input" id="adv-input" name="minutes" type="number" min="0" max="1440" step="5" value="${current}" />
        <p class="tiny muted" style="margin:6px 0 0">填 1440 表示提前一天提醒。</p>
      </div>`,
    submitText: '保存',
    onSubmit: (formData) => {
      const minutes = Number(formData.get('minutes'));
      const result = store.dispatch({
        type: 'SET_REMINDER_DEFAULTS',
        payload: { defaultAdvanceMinutes: minutes }
      });
      if (!result.ok) {
        snackbar(result.errors[0] || '保存失败', { danger: true });
        return false;
      }
      snackbar(`已设置为提前 ${minutes} 分钟`);
      return true;
    }
  });
}

/**
 * 打开单课程覆盖表单。
 *
 * @param {string|string[]} courseIds 合并组里可能有多个 courseId ——
 *   同名的「数学分析(上) O / P」是同一门课，一次设置要落到整组，
 *   否则用户改完发现只生效了一条。
 */
export function openRuleSheet(state, store, courseIds) {
  const ids = (Array.isArray(courseIds) ? courseIds : [courseIds]).filter(Boolean);
  const courses = ids.map((id) => state.courses.find((c) => c.id === id)).filter(Boolean);
  if (!courses.length) return;
  const course = courses[0];
  const name = courses.length > 1 ? normalizeCourseName(course.name) : course.name;
  const existing = state.settings.reminder.rules.find((r) => r.targetId === ids[0]);
  const advance = existing ? existing.advanceMinutes : state.settings.reminder.defaultAdvanceMinutes;
  sheet({
    title: `「${name}」提醒${ids.length > 1 ? `（${ids.length} 个教学班）` : ''}`,
    body: `<div class="field">
        <label for="rule-adv">提前分钟数</label>
        <input class="input" id="rule-adv" name="advanceMinutes" type="number" min="0" max="1440" step="5" value="${advance}" />
      </div>
      <div class="field">
        <label>开关</label>
        <select class="select" name="enabled">
          <option value="1" ${!existing || existing.enabled !== false ? 'selected' : ''}>启用</option>
          <option value="0" ${existing && existing.enabled === false ? 'selected' : ''}>关闭该课提醒</option>
        </select>
      </div>`,
    submitText: '保存',
    onSubmit: (formData) => {
      const advanceMinutes = Number(formData.get('advanceMinutes'));
      const enabled = formData.get('enabled') === '1';
      // 整组一起写：合并显示的那一条，背后可能是好几个 courseId
      let firstError = '';
      for (const targetId of ids) {
        const result = store.dispatch({
          type: 'UPSERT_RULE',
          payload: { rule: { targetId, advanceMinutes, enabled } }
        });
        if (!result.ok && !firstError) firstError = result.errors[0] || '保存失败';
      }
      if (firstError) {
        snackbar(firstError, { danger: true });
        return false;
      }
      snackbar(ids.length > 1 ? `已保存（${ids.length} 个教学班）` : '已保存课程级提醒');
      return true;
    }
  });
}

/** 申请权限。 */
export async function askPermission() {
  const result = await requestPermission();
  if (result === 'granted') snackbar('通知权限已开启');
  else if (result === 'denied') snackbar('通知被拒绝，可按下方步骤手动开启', { danger: true });
  else if (result === 'unsupported') snackbar('当前环境不支持通知，请使用日历通道', { danger: true });
  else snackbar('未做选择，可稍后再试');
  return result;
}
