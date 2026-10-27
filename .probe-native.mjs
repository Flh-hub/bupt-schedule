/**
 * .probe-native.mjs — 开发期探针：用 jsdom 模拟 Android 壳，跑通
 * 「抓取 → 解析 → 自动定学期起始周 → 预览 → 导入 → 节次表校正」。
 *
 * 样本照抄 2026-10-23 手机截图里的真实教务页面：
 *   表头 `周一 08-31 … 周日 09-06`、周次下拉 `第1周`、格子 `4-7(周)[01-02节]`、14 小节。
 *
 * 只是探针，不参与交付门禁（依赖托管 node_modules 里的 jsdom）：
 *   node .probe-native.mjs
 */

import fs from 'node:fs';

import { startMondayOfWeek, todayStr } from './src/model.js';

const jsdomMod = await import(
  'file:///C:/Users/20976/.workbuddy/binaries/node/workspace/node_modules/jsdom/lib/api.js'
);
const JSDOM = (jsdomMod.default || jsdomMod).JSDOM;

const html = fs.readFileSync('index.html', 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost:8080/#/import',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const { window } = dom;

window.matchMedia =
  window.matchMedia ||
  ((query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {}
  }));

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));

let opened = 0;
let alarmPushes = 0;
let lastAlarms = '[]';
let notifyReqs = 0;
let notifySettings = 0;
let notifyCenter = 0;
let notifyTests = 0;
let permState = 'default';
let appSettingsCalls = 0;
let batteryCalls = 0;

window.BuptNative = {
  getInfo() {
    return JSON.stringify({ platform: 'android', appVersion: '1.47.0', sdk: 34, brand: 'Xiaomi', model: 'M2012K11AC' });
  },
  batteryExempt() {
    return false;
  },
  openAppSettings() {
    appSettingsCalls += 1;
  },
  notificationAudit() {
    return JSON.stringify({ granted: true, importance: 4, importanceLabel: '高（有声音、横幅）', promoted: null });
  },
  openBatteryModePage() {
    return 'ignoreList';
  },
  openBatterySettings() {
    batteryCalls += 1;
  },
  openJwgl() {
    opened += 1;
  },
  // 原生通知（1.5.0）：启动时应收到一次排程推送
  scheduleReminders(json) {
    alarmPushes += 1;
    lastAlarms = String(json || '[]');
  },
  permissionSnapshot() {
    return JSON.stringify({
      sdk: 34,
      notify: typeof permState === 'string' ? permState : 'default',
      batteryExempt: true,
      exactAlarm: true,
      promoted: null
    });
  },
  getNotifyPermission() {
    return permState;
  },
  openNotificationPermissionPage() {
    notifyCenter += 1;
    return 'notify';
  },
  openNotificationCenter() {
    notifyCenter += 1;
    return true;
  },
  openNotificationSettingsEx() {
    notifySettings += 1;
    return 'channel';
  },
  requestNotifyPermission() {
    notifyReqs += 1;
  },
  notifyTest() {
    notifyTests += 1;
  },
  toast() {}
};

globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.FormData = window.FormData;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
window.confirm = () => true;

await import('./src/main.js');
await new Promise((r) => setTimeout(r, 400));

const checks = [];
const view = () => document.getElementById('view');
const text = () => (view() && view().textContent) || '';
const state0 = () => window.__buptApp.store.getState();
const TODAY = todayStr();
const THIS_MONDAY = startMondayOfWeek(1, TODAY);

/* ---------------------------------------------------------------- 真实教务表 */

const TIMES = [
  '08:00-08:45',
  '08:50-09:35',
  '09:50-10:35',
  '10:40-11:25',
  '11:30-12:15',
  '13:00-13:45',
  '13:50-14:35',
  '14:45-15:30',
  '15:40-16:25',
  '16:35-17:20',
  '17:25-18:10',
  '18:30-19:15',
  '19:20-20:05',
  '20:10-20:55'
];

const blk = (lines) => `<div class="kbcontent">${lines.join('<br/>')}</div>`;

// 星期 → { 从第几行开始, 跨几行, 内容 }
const PLACEMENT = {
  3: { row: 1, span: 2, lines: ['大学生心理健康1', '王培', '4-7(周)[01-02节]', '教学实验综合楼-S215'] },
  2: { row: 2, span: 2, lines: ['数学分析(上) O', '李晓莉', '4-19(周)[02-03-04节]', '教学实验综合楼-S210'] },
  5: { row: 6, span: 2, lines: ['基础综合英语', '(B14)', '宋媛', '4-19(周)[06-07节]', '智慧教学楼-413'] },
  4: { row: 13, span: 2, lines: ['人工智能原理及应用', '赵文义', '3-18(周)[13-14节]', '教学实验综合楼-S104'] }
};

/** 表头带日期：周一 08-31 … 周日 09-06（真实页面就是这个样子）。 */
function headerCells() {
  const labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return labels
    .map((label, i) => {
      const md = startMondayOfWeek(1, addDaysStr(THIS_MONDAY, i)).slice(5);
      return `<th>${label}<br/>${md}</th>`;
    })
    .join('');
}

function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  const pad = (x) => (x < 10 ? '0' + x : '' + x);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function buildTable() {
  const trs = [];
  const covered = new Map();
  for (let i = 1; i <= 14; i += 1) {
    const tds = [`<td class="rq">${i}<br/>${TIMES[i - 1]}</td>`];
    for (let dow = 1; dow <= 7; dow += 1) {
      const left = covered.get(dow) || 0;
      if (left > 0) {
        covered.set(dow, left - 1);
        continue;
      }
      const p = PLACEMENT[dow];
      if (p && p.row === i) {
        covered.set(dow, p.span - 1);
        tds.push(`<td rowspan="${p.span}">${blk(p.lines)}</td>`);
      } else {
        tds.push('<td></td>');
      }
    }
    trs.push(`<tr>${tds.join('')}</tr>`);
  }
  return `<table id="kbtable"><tbody>
    <tr><th>节次</th>${headerCells()}</tr>
    ${trs.join('')}
  </tbody></table>`;
}

const tableHtml = `<html><body>${buildTable()}</body></html>`;

/** 构造抓取包：weekAnchor 就是「表头日期 + 周次下拉」。 */
function payload(anchorWeek, opts = {}) {
  const base = {
    url: 'https://jwgl.bupt.edu.cn/jsxsd/kbcx/kbxx_xskb',
    title: '我的课表/考表',
    candidates: [{ label: '表格 #kbtable', html: tableHtml }]
  };
  if (anchorWeek == null) {
    base.signals = { weekTexts: [], weakTexts: [], titles: ['教务系统欢迎您！'] };
    return base;
  }
  // 教务页面正停在「第 anchorWeek 周」，表头日期就是**本周**的周一到周日
  // → 反推：第 1 周周一 = 本周一 - (anchorWeek-1)*7
  const anchorMonday = THIS_MONDAY;
  const dates = [];
  for (let i = 0; i < 7; i += 1) dates.push(addDaysStr(anchorMonday, i).slice(5));
  base.signals = {
    weekTexts: [],
    weakTexts: [`第${anchorWeek}周`],
    titles: ['我的课表/考表'],
    weekAnchor: { week: anchorWeek, dates, picker: anchorMonday, term: opts.term || '2026-2027-1' }
  };
  return base;
}

function deliver(p) {
  window.__buptNativeImportPayload(Buffer.from(JSON.stringify(p), 'utf8').toString('base64'));
}

/* ---------------------------------------------------------------- 1. 抓取入口 */

// 主页面：只有一个入口（不再有四个通道标签）
window.__buptApp.uiState.parseDraft = null;
window.location.hash = '#/import';
await new Promise((r) => setTimeout(r, 80));

checks.push(['导入页只有一个抓取入口', Boolean(view().querySelector('[data-action="import-native-capture"]'))]);
checks.push(['主页面不再有通道分段', view().querySelectorAll('[data-action="import-channel"]').length === 0]);
checks.push(['文案说明学号密码的去向', text().includes('学号密码') || text().includes('密码')]);
checks.push(['备用通道藏在二级页入口里', Boolean(view().querySelector('a[href="#/import/manual"]'))]);

// 备用导入页：按钮行排版（这一步的 3 个动作仍要齐整）
window.location.hash = '#/import/manual';
await new Promise((r) => setTimeout(r, 80));
const actRow = view().querySelector('.import-actions');
const noteEl = view().querySelector('.import-note');
checks.push(['按钮行用 .import-actions 包起来', Boolean(actRow)]);
checks.push(['三个动作在同一行容器里', Boolean(actRow) && actRow.querySelectorAll('.btn').length === 3]);
checks.push(['说明文字不在按钮行里（不会挤压错位）', Boolean(noteEl) && Boolean(actRow) && !actRow.contains(noteEl)]);

window.location.hash = '#/import';
await new Promise((r) => setTimeout(r, 80));


const btn = view().querySelector('[data-action="import-native-capture"]');
btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
checks.push(['点击后调用了原生 openJwgl', opened === 1]);

/* ---------------------------------------------------------------- 2. 回灌：课表 + 学期起始周 */

// 教务页面停在「第 3 周」，表头 09-14 左右
deliver(payload(3));
await new Promise((r) => setTimeout(r, 150));

const draft = window.__buptApp.uiState.parseDraft;
const weeksWarnings = draft ? draft.warnings.filter((w) => w.includes('未识别到周次')) : ['no-draft'];
const expect3 = startMondayOfWeek(3, TODAY);
checks.push(['回灌后生成了草稿', Boolean(draft)]);
checks.push(['解析出 4 个课次', Boolean(draft) && draft.sessions.length === 4]);
checks.push(['没有「未识别到周次」告警', weeksWarnings.length === 0]);
checks.push(['「宋媛」没有被当成课程', Boolean(draft) && !draft.courses.some((c) => c.name === '宋媛')]);
checks.push(['带回 14 节作息表', Boolean(draft) && Boolean(draft.periodsHint) && draft.periodsHint.length === 14]);
checks.push([
  '周次是真周次（4-7 周，不是整学期）',
  Boolean(draft) &&
    draft.sessions.some((s) => s.weeks.start === 4 && s.weeks.end === 7) &&
    !draft.sessions.some((s) => s.weeks.start === 1 && s.weeks.end === 20)
]);
checks.push(['晚间课是第 13-14 节', Boolean(draft) && draft.sessions.some((s) => s.endPeriod === 14)]);

const guess = window.__buptApp.uiState.semesterGuess;
checks.push(['从表头日期推出学期起始周', Boolean(guess) && guess.startMonday === expect3 && guess.week === 3]);
checks.push([
  '学期识别挂在草稿上（确认导入时才写设置）',
  Boolean(draft && draft.semester && draft.semester.firstMonday === expect3 && draft.semester.source === 'header')
]);
checks.push(['此刻还没改设置', !state0().settings.semesterStartMonday]);
checks.push([`卡片显示教务学期 2026-2027-1`, text().includes('2026-2027-1')]);
checks.push([
  '抓取后展示课程列表（4 门课）',
  view().querySelectorAll('.course-item').length === 4
]);
checks.push(['课程列表里能看到课程名', text().includes('基础综合英语') && text().includes('人工智能原理及应用')]);
checks.push(['课程列表带出周次', text().includes('4-7') && text().includes('3-18')]);
checks.push(['课程列表带出上课时间', text().includes('周三') && text().includes('第 1-2 节')]);
checks.push(['有「确认导入」按钮', Boolean(view().querySelector('[data-action="import-commit"]'))]);
checks.push(['有「逐条核对」入口', Boolean(view().querySelector('a[href="#/import/detail"]'))]);
checks.push([
  '抓到的源码已存进备用通道（可回看）',
  String(window.__buptApp.uiState.importText || '').includes('kbtable')
]);

/* ---------------------------------------------------------------- 3. 读不到周次 → 一键选择 */

window.__buptApp.store.dispatch({ type: 'SET_SEMESTER', payload: { semesterStartMonday: null } });
window.__buptApp.uiState.semesterApplied = null;
window.__buptApp.uiState.semesterGuess = null;
deliver(payload(null));
await new Promise((r) => setTimeout(r, 150));

checks.push(['没信号时给出快捷选择', Boolean(view().querySelector('#semester-week'))]);
const weekSelect = view().querySelector('#semester-week');
if (weekSelect) {
  weekSelect.value = '5';
  weekSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
}
const expect5 = startMondayOfWeek(5, TODAY);
checks.push([`选「第 5 周」→ 起始日 ${expect5}`, state0().settings.semesterStartMonday === expect5]);

/* ---------------------------------------------------------------- 4. 与已有设置冲突 → 采用 */

deliver(payload(7));
await new Promise((r) => setTimeout(r, 150));
const expect7 = startMondayOfWeek(7, TODAY);
checks.push(['已配置时不擅自覆盖', state0().settings.semesterStartMonday === expect5]);
checks.push(['冲突时给出「采用」按钮', Boolean(view().querySelector('[data-action="semester-use-guess"]'))]);
const useGuess = view().querySelector('[data-action="semester-use-guess"]');
if (useGuess) useGuess.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 120));
checks.push([`点「采用」后起始日改为 ${expect7}`, state0().settings.semesterStartMonday === expect7]);

/* ---------------------------------------------------------------- 5. 导入 + 节次表 */

const commit = view().querySelector('[data-action="import-commit"]');
commit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 220));

const state = state0();
checks.push(['确认导入后课表有 4 个课次', state.sessions.length === 4]);
checks.push(['跳到课表页', window.location.hash === '#/timetable']);
checks.push(['节次表已按教务作息扩到 14 节', state.settings.periods.length === 14]);
checks.push([
  '第 14 节时间是 20:10-20:55',
  state.settings.periods.length === 14 &&
    state.settings.periods[13].start === '20:10' &&
    state.settings.periods[13].end === '20:55'
]);
checks.push([
  '课表页认出了今天是第 7 周',
  new RegExp(`第\\s*7\\s*周`).test(document.body.textContent || '') ||
    document.body.textContent.includes(expect7)
]);

/* ---------------------------------------------------------------- 6. 未配置时，确认导入自动写入 */

window.__buptApp.store.dispatch({ type: 'SET_SEMESTER', payload: { semesterStartMonday: null } });
deliver(payload(4));
await new Promise((r) => setTimeout(r, 150));
const expect4 = startMondayOfWeek(4, TODAY);
checks.push(['重新抓取到「第 4 周」', Boolean(window.__buptApp.uiState.semesterGuess) && window.__buptApp.uiState.semesterGuess.startMonday === expect4]);
const commit2 = view().querySelector('[data-action="import-commit"]');
if (commit2) commit2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 220));
checks.push([`确认导入后写入起始日 ${expect4}`, state0().settings.semesterStartMonday === expect4]);

/* ---------------------------------------------------------------- 7. 原生通知 */

checks.push(['启动时把提醒推给原生排程', alarmPushes >= 1]);
checks.push(['推送的是合法 JSON 数组', Array.isArray(JSON.parse(lastAlarms))]);

window.__buptApp.uiState.importChannel = 'text';
window.location.hash = '#/reminder';
window.__buptApp.render();
await new Promise((r) => setTimeout(r, 80));

checks.push(['提醒页用「系统通知」而不是网页通知', text().includes('系统通知')]);
checks.push(['不再出现「不支持网页通知」的误导文案', !text().includes('不支持网页通知')]);
const askBtn = view().querySelector('[data-action="perm-request"]');
checks.push(['未授权时给出开启按钮', Boolean(askBtn)]);
if (askBtn) askBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 80));
checks.push(['点按钮先弹系统权限窗口', notifyReqs === 1]);
checks.push(['窗口弹出时还没跳转（先窗口后页面）', notifyCenter === 0 && notifySettings === 0]);

// 模拟系统窗口关闭（原生回调）→ 这时才跳页面并给清单
window.__buptNotifyPermissionChanged();
await new Promise((r) => setTimeout(r, 80));
checks.push(['回调后才跳系统设置页', notifyCenter === 1]);
checks.push([
  '跳转后给出「要开哪几项」清单',
  Boolean(document.querySelector('#guide-host .ng-item')) &&
    document.getElementById('guide-host').textContent.includes('锁屏')
]);
const gClose = document.querySelector('#guide-host [data-ng="done"]');
if (gClose) gClose.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
checks.push(['关闭后弹层移除', !document.querySelector('#guide-host .ng-card')]);

permState = 'granted';
window.__buptApp.render();
await new Promise((r) => setTimeout(r, 80));
checks.push(['授权后显示「系统通知已开启」', text().includes('系统通知已开启')]);
// 测试通知已从正式版移除：授权后不该再出现任何"发一条测试"入口
checks.push(['授权后不再出现测试通知按钮', !view().querySelector('[data-action="notify-test"]')]);
checks.push(['页面文案不再提「测试通知」', !text().includes('测试通知')]);

/* ---- 日历(.ics) 导出已整体移除 ---- */
window.location.hash = '#/reminder';
await new Promise((r) => setTimeout(r, 80));
checks.push(['提醒页不再有日历导出卡片', !text().includes('导出到系统日历') && !text().includes('生成并下载 .ics')]);
checks.push(['不再有「提醒通道」三选一', !text().includes('仅日历') && !text().includes('通知 + 日历')]);
checks.push(['通知方式仍然可见', text().includes('提醒方式') && text().includes('默认提前量')]);
checks.push(['限制说明讲的是系统闹钟', text().includes('AlarmManager') || text().includes('系统闹钟')]);

/* ---------------------------------------------------------------- 7.5 后台保活设置 */

window.location.hash = '#/reminder/keepalive';
await new Promise((r) => setTimeout(r, 120));
checks.push(['保活页标题正确', text().includes('后台保活设置')]);
checks.push(['按机型识别到小米分支', text().includes('小米') && text().includes('无限制') && text().includes('自启动管理')]);
checks.push(['显示电池优化未豁免', text().includes('未豁免')]);
checks.push(['列出其它系统入口', ['OPPO', 'vivo', '华为', '三星'].every((x) => text().includes(x))]);
checks.push(['说明不设的影响', text().includes('不设会怎样')]);
const appBtn = view().querySelector('[data-action="keepalive-app-settings"]');
const batEntry = view().querySelector('[data-route="#/reminder/battery-mode"]');
checks.push(['「应用设置」与「耗电管理」两个入口都在', Boolean(appBtn) && Boolean(batEntry)]);
if (appBtn) appBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
checks.push(['「应用设置」调用原生', appSettingsCalls === 1]);
checks.push(['提醒页有保活入口', true]);
checks.push(['保活页含「桌面小组件」说明', text().includes('桌面小组件') && text().includes('长按桌面空白处')]);
checks.push(['小组件说明包含刷新间隔限制', text().includes('30 分钟')]);

/* ---------------------------------------------------------------- 8. 垃圾输入 */

deliver({ candidates: [{ html: '<html><body>空</body></html>' }] });
await new Promise((r) => setTimeout(r, 150));
checks.push(['垃圾回灌不崩', errors.length === 0]);

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
if (errors.length) console.log('errors:', errors);
if (weeksWarnings.length) console.log('warnings:', weeksWarnings);
console.log(`\nfailed=${failed}`);
process.exit(failed ? 1 : 0);
