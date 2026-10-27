/**
 * .probe-onboard.mjs — 首次启动的权限引导（jsdom + 假原生桥）。
 *
 * 要验的是"装完第一次打开"的真实行为：
 *   ① 没做过引导 → 自动弹出，且按真实状态标出未开启项
 *   ② 点「去开启」→ 真的调用了对应的原生入口
 *   ③ 点「稍后再说」→ 关掉并落标记（之后不再弹）
 *   ④ 全部开启时不再显示"未开启"，按钮变成「开始用」
 *
 *   node .probe-onboard.mjs
 */

import fs from 'node:fs';

const jsdomMod = await import(
  'file:///C:/Users/20976/.workbuddy/binaries/node/workspace/node_modules/jsdom/lib/api.js'
);
const JSDOM = (jsdomMod.default || jsdomMod).JSDOM;

const html = fs.readFileSync('index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8080/#/timetable', pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;
window.matchMedia =
  window.matchMedia ||
  ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));

// 假原生桥：一开始什么权限都没给（模拟"刚装完、什么都没开"）
let snapshot = { sdk: 34, notify: 'default', batteryExempt: false, exactAlarm: false, promoted: null };
const calls = { notify: 0, battery: 0, exact: 0, promoted: 0 };

window.BuptNative = {
  getInfo() {
    return JSON.stringify({ platform: 'android', appVersion: '1.56.0', sdk: 34, brand: 'Xiaomi', model: 'X' });
  },
  permissionSnapshot() {
    return JSON.stringify(snapshot);
  },
  getNotifyPermission() {
    return snapshot.notify;
  },
  requestNotifyPermission() {
    calls.notify += 1;
  },
  notificationAudit() {
    return JSON.stringify({
      granted: snapshot.notify === 'granted',
      importance: 4,
      importanceLabel: '高（有声音、横幅）',
      promoted: snapshot.promoted
    });
  },
  openBatteryModePage() {
    calls.batteryMode = (calls.batteryMode || 0) + 1;
    return 'ignoreList';
  },
  openBatterySettings() {
    calls.battery += 1;
  },
  openExactAlarmSettings() {
    calls.exact += 1;
  },
  openPromotedSettings() {
    calls.promoted += 1;
  },
  openNotificationSettings() {
    calls.notifySettings = (calls.notifySettings || 0) + 1;
  },
  openNotificationPermissionPage() {
    calls.permPage = (calls.permPage || 0) + 1;
    calls.notifyCenter = (calls.notifyCenter || 0) + 1;
    return 'notify';
  },
  openNotificationCenter() {
    calls.notifyCenter = (calls.notifyCenter || 0) + 1;
    return true;
  },
  openNotificationSettingsEx() {
    calls.notifySettingsEx = (calls.notifySettingsEx || 0) + 1;
    return 'channel';
  },
  openAppSettings() {
    calls.appSettings = (calls.appSettings || 0) + 1;
  },
  promoteDemo() {
    calls.promote = (calls.promote || 0) + 1;
    return JSON.stringify({ posted: true, promoted: false, missing: '系统里「流体云」总开关没开', verdict: '未提升' });
  },
  batteryExempt() {
    return snapshot.batteryExempt;
  },
  scheduleReminders() {},
  syncWidget() {},
  notifyTest() {},
  credentialsAccount() {
    return '';
  },
  hasCredentials() {
    return false;
  }
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

await import('./src/main.js');
await new Promise((r) => setTimeout(r, 900)); // 引导是 500ms 后弹的

const checks = [];
const mod = await import('./src/ui/onboard.js');
const host = () => document.getElementById('onboard-host');
const obText = () => (host() ? host().textContent : '');

/* ① 自动弹出 + 状态 */
checks.push(['首次打开自动弹出引导', Boolean(host().querySelector('.ob-card'))]);
checks.push(['按真实状态标出未开启', obText().includes('未开启')]);
checks.push(['列出通知权限', obText().includes('通知权限')]);
checks.push(['列出精确闹钟', obText().includes('精确闹钟')]);
checks.push(['列出后台运行（电池）项', obText().includes('后台运行') || obText().includes('耗电')]);
checks.push(['没有流体云项（API 34 没这个概念）', !obText().includes('流体云')]);
checks.push(['给了自启动的"看路径"说明', obText().includes('自启动')]);
checks.push(['提示还差 3 项必开权限', obText().includes('还差 3 项') || obText().includes('还有 3 项必开权限')]);
checks.push(['底部按钮是「去开某一项」而不是「稍后再说」', Boolean(host().querySelector('[data-ob-next]')) && !obText().includes('稍后再说')]);
checks.push([
  '说明"不开会怎样"',
  obText().includes('逐项打开') || obText().includes('提醒可能不响')
]);
// 点遮罩不应关闭
const mask = host().querySelector('.ob-mask');
if (mask) mask.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
checks.push(['点遮罩不会关掉引导（必须开完）', Boolean(host().querySelector('.ob-card'))]);
// 逃生口需二次确认：先拒绝
window.confirm = () => false;
const skipBtn = host().querySelector('[data-ob-skip]');
if (skipBtn) skipBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
checks.push(['逃生口点"取消"后仍留在引导页', Boolean(host().querySelector('.ob-card'))]);

/* ② 点「去开启」真的调用原生 */
const notifyBtn = host().querySelector('[data-ob-action="onboard-notify"]');
checks.push(['通知项有「去开启」按钮', Boolean(notifyBtn)]);
if (notifyBtn) notifyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
checks.push(['点通知项先弹系统权限窗口', calls.notify === 1]);
checks.push([
  '窗口弹出时**还没跳转**（先窗口后页面）',
  (calls.notifyCenter || 0) === 0 && (calls.notifySettingsEx || 0) === 0
]);

// 模拟用户在系统窗口里点了「允许」→ 原生回调 → 这时才跳
snapshot = { ...snapshot, notify: 'granted' };
window.__buptNotifyPermissionChanged();
await new Promise((r) => setTimeout(r, 80));
checks.push(['窗口关闭后才跳系统设置页', (calls.notifyCenter || 0) === 1]);
checks.push([
  '跳转后展开要开的清单',
  host().querySelectorAll('.ng-item').length === 4 &&
    obText().includes('横幅') &&
    obText().includes('锁屏')
]);
checks.push([
  '清单里说明落地页怎么走',
  obText().includes('已打开') && obText().includes('通知')
]);
const notifyDone = host().querySelector('[data-obd="notify-done"]');
if (notifyDone) notifyDone.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));

const exBtn = host().querySelector('[data-ob-action="onboard-exact"]');
if (exBtn) exBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
checks.push(['点精确闹钟调用了系统设置', calls.exact === 1]);

const batBtn = host().querySelector('[data-ob-action="onboard-battery"]');
if (batBtn) batBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
checks.push(['点电池优化**不再**直接跳系统页', calls.battery === 0]);
checks.push(['点电池优化先弹 App 内确认框', obText().includes('完全允许') || obText().includes('后台运行模式')]);
const openInfo = host().querySelector('[data-obd="battery-mode"]');
checks.push(['确认框里能跳到「后台运行模式」页', Boolean(openInfo)]);
if (openInfo) openInfo.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
checks.push(['点了会调原生打开后台模式页', calls.batteryMode === 1]);
checks.push([
  '跳转后说明下一步该去哪',
  obText().includes('耗电') || obText().includes('电池优化')
]);

// 不做检测（1.66.4 起）：用户点「我已开好」就记下来，不再读系统
const doneBtn = host().querySelector('[data-obd="battery-done"]');
checks.push(['有「我已开好」而不是"检测一下"', Boolean(doneBtn) && !host().querySelector('[data-obd="battery-check"]')]);
if (doneBtn) doneBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
checks.push(['确认后确认框关闭', !host().querySelector('.ob-dialog')]);
const batteryRow = host().querySelector('[data-ob-key="battery"]');
checks.push(['检测通过后该项显示已开启', Boolean(batteryRow && batteryRow.textContent.includes('已开启'))]);

/* 永久拒绝：再点"去开启"必须直接进通知设置页，而不是再弹一次不会出现的系统框 */
snapshot = { ...snapshot, notify: 'denied' };
mod.refreshOnboard();
await new Promise((r) => setTimeout(r, 60));
const deniedBtn = host().querySelector('[data-ob-action="onboard-notify"]');
if (deniedBtn) deniedBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
checks.push([
  '已被永久拒绝时不再弹窗，直接跳设置页',
  (calls.notifyCenter || 0) === 2 && calls.notify === 1
]);
const closeDenied = host().querySelector('[data-obd="notify-done"]');
if (closeDenied) closeDenied.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
snapshot = { ...snapshot, notify: 'default' };
checks.push(['跳转后给出落地提示', obText().includes('上课提醒') || obText().includes('通知设置')]);
snapshot = { ...snapshot, notify: 'default' };


/* 流体云试发已从正式版移除：引导里不该再出现"试一张" */
snapshot = { sdk: 36, notify: 'granted', batteryExempt: true, exactAlarm: true, promoted: false };
mod.refreshOnboard();
await new Promise((r) => setTimeout(r, 60));
checks.push(['不再出现「试一张」按钮', !host().querySelector('[data-pm="try"]')]);
checks.push(['引导文案不再提试发', !obText().includes('试一张')]);
checks.push(['没有调用过试发接口', !calls.promote]);

/* ③ 状态刷新：原生说都开了 → 界面跟着变 */
snapshot = { sdk: 36, notify: 'granted', batteryExempt: true, exactAlarm: true, promoted: true };
mod.refreshOnboard();
await new Promise((r) => setTimeout(r, 60));
checks.push(['刷新后不再有"未开启"', !obText().includes('未开启')]);
checks.push(['刷新后显示"都开好了"', obText().includes('都开好了')]);
checks.push(['全部满足时按钮变成「开始用」', obText().includes('开始用')]);

/* ④ 稍后再说 → 落标记并关闭 */
const closeBtn = host().querySelector('[data-ob-close]');
if (closeBtn) closeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 80));
checks.push(['关闭后宿主清空', !host().querySelector('.ob-card')]);

const flag = (() => {
  try {
    return window.localStorage.getItem('bupt_onboard_v1');
  } catch (e) {
    return null;
  }
})();
checks.push(['点过后写了"已引导"标记', flag === '1']);

/* 提醒页「开启系统通知」走的那条路径：先系统窗口 → 回调后跳页面 + 清单 */
const guide = await import('./src/ui/notifyGuide.js');
snapshot = { ...snapshot, notify: 'default' };
const baseCenter = calls.notifyCenter || 0;
const baseReq = calls.notify || 0;

guide.startNotifyFlow();
await new Promise((r) => setTimeout(r, 60));
const gh = document.getElementById('guide-host');
checks.push(['窗口阶段：只弹系统框，不渲染页面清单', !gh.querySelector('.ng-card')]);
checks.push([
  '窗口阶段：没有发生页面跳转',
  (calls.notifyCenter || 0) === baseCenter && (calls.notify || 0) === baseReq + 1
]);

// 模拟用户在系统窗口点完（原生回调）
window.__buptNotifyPermissionChanged();
await new Promise((r) => setTimeout(r, 80));
const gText = gh.textContent;
checks.push(['回调后才跳转', (calls.notifyCenter || 0) === baseCenter + 1]);
checks.push(['跳转后弹出清单', Boolean(gh.querySelector('.ng-card'))]);
checks.push(['列出 4 项要开的开关', gh.querySelectorAll('.ng-item').length === 4]);
checks.push(['清单含锁屏与横幅', gText.includes('锁屏') && gText.includes('横幅')]);
checks.push(['说明落地页怎么走', gText.includes('已打开') && gText.includes('通知')]);
checks.push(['解释"开关灰掉"是怎么回事', gText.includes('灰色') || gText.includes('灰的')]);

const again = gh.querySelector('[data-ng="again"]');
if (again) again.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
checks.push(['「再打开一次」会再跳一次设置', (calls.notifyCenter || 0) === baseCenter + 2]);

// 「我已经开好了」= 收起弹层（1.66.4 起不做检测）
const guideDoneBtn = gh.querySelector('[data-ng="done"]');
checks.push(['落地页有「我已经开好了」', Boolean(guideDoneBtn) && !gh.querySelector('[data-ng="check"]')]);
if (guideDoneBtn) guideDoneBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 200));
checks.push(['点确认后弹层关闭', !document.getElementById('guide-host').querySelector('.ng-card')]);

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\nfailed=${failed}`);
process.exit(failed ? 1 : 0);
