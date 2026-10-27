/**
 * .probe-perm-fix.mjs — 1.66.4 的行为验证（jsdom + 假原生桥）。
 *
 * 这一版只验两件事，都是用户真机上撞到的：
 *
 *  ① **不再做检测**：「我已经开好了」就是收起弹层，不读系统状态、不发探针通知。
 *  ② **跳转必须一致**：「去设置」和「再打开一次」走同一个函数，
 *     落点都是「上课提醒」渠道页（允许通知 / 静默 / 锁屏 / 横幅 全在这一页）。
 *
 *   node .probe-perm-fix.mjs
 */

import fs from 'node:fs';

const jsdomMod = await import(
  'file:///C:/Users/20976/.workbuddy/binaries/node/workspace/node_modules/jsdom/lib/api.js'
);
const JSDOM = (jsdomMod.default || jsdomMod).JSDOM;

const html = fs.readFileSync('index.html', 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost:8080/#/timetable',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const { window } = dom;
window.matchMedia =
  window.matchMedia ||
  ((q) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {}
  }));

/* ---------------- 假原生桥 ---------------- */

let snapshot = { sdk: 34, notify: 'default', batteryExempt: false, exactAlarm: true, promoted: null };
let batteryLanding = 'powerPage';
const calls = {
  notifyPerm: 0,
  settingsEx: 0,
  permPage: 0,
  batteryMode: 0,
  aospList: 0,
  legacyBattery: 0,
  audit: 0
};

window.BuptNative = {
  getInfo() {
    return JSON.stringify({
      platform: 'android',
      appVersion: '1.66.4',
      sdk: 34,
      brand: 'OPPO',
      model: 'PHK110'
    });
  },
  permissionSnapshot() {
    return JSON.stringify(snapshot);
  },
  getNotifyPermission() {
    return snapshot.notify;
  },
  requestNotifyPermission() {
    calls.notifyPerm += 1;
  },
  // 状态读取接口仍然存在，但 UI 不该再调用它
  notificationAudit() {
    calls.audit += 1;
    return JSON.stringify({ granted: true, appEnabled: true, importance: 4 });
  },
  openNotificationSettingsEx() {
    calls.settingsEx += 1;
    return 'channel';
  },
  openNotificationPermissionPage() {
    calls.permPage += 1;
    return 'perm';
  },
  openNotificationCenter() {
    calls.notifyCenter = (calls.notifyCenter || 0) + 1;
    return true;
  },
  openNotificationSettings() {},
  openBatteryModePage() {
    calls.batteryMode += 1;
    return batteryLanding;
  },
  openAospBatteryList() {
    calls.aospList += 1;
    return 'ignoreList';
  },
  batteryActivities() {
    return JSON.stringify({
      packages: [
        {
          pkg: 'com.oplus.battery',
          visible: true,
          items: [{ n: 'com.oplus.powermanager.fuelgaue.PowerUsageModelActivity', e: true }]
        },
        { pkg: 'com.oplus.appdetail', visible: false, items: [] }
      ]
    });
  },
  batteryExempt() {
    return snapshot.batteryExempt;
  },
  openExactAlarmSettings() {},
  openPromotedSettings() {},
  openAppSettings() {},
  promoteDemo() {
    calls.promote = (calls.promote || 0) + 1;
    return JSON.stringify({ posted: true, promoted: false, missing: '', verdict: '' });
  },
  notifyTest() {},
  scheduleReminders() {},
  syncWidget() {},
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
// 让 visibilitychange 处理器认为页面是可见的
Object.defineProperty(window.document, 'hidden', { value: false, configurable: true });
Object.defineProperty(window.document, 'visibilityState', { value: 'visible', configurable: true });

// 隐私说明是独立的一次性弹层，会抢在引导前面。这个探针只测权限链路，
// 所以先标成「已同意」——否则后面 14 条全挂在"引导没弹出来"上。
window.localStorage.setItem('privacy-accepted', '2026-10');

await import('./src/main.js');
await new Promise((r) => setTimeout(r, 900)); // 引导是 500ms 后弹的

/* ---------------- 工具 ---------------- */

const checks = [];
const check = (name, pass, extra = '') => checks.push({ name, pass, extra });
const host = () => document.getElementById('onboard-host');
const text = () => (host() ? host().textContent : '');
const q = (sel) => (host() ? host().querySelector(sel) : null);
const norm = (s) => s.replace(/\s+/g, ' ');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (sel) => {
  const el = q(sel);
  if (!el) return false;
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
};
const clickDoc = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
};

/* ---------------- 1. 引导弹出 ---------------- */
check('引导弹出', norm(text()).includes('先把这几项开好'), norm(text()).slice(0, 50));
check('清单里不再有独立的「课前流体云卡片」行', !norm(text()).includes('课前流体云卡片'), norm(text()).slice(0, 80));
check('通知那一项说明了胶囊也归它管', norm(text()).includes('胶囊'), norm(text()).slice(0, 120));

/* ---------------- 2. 进通知流程 ---------------- */
click('[data-ob-action="onboard-notify"]');
snapshot.notify = 'granted';
window.__buptNotifyPermissionChanged();
const landingText = norm(text());
check('进入通知设置指引', landingText.includes('我已经开好了'), landingText.slice(0, 60));
check('跳转落点是「权限管理 › 通知」', landingText.includes('权限管理'), landingText.slice(0, 90));

/* ---------------- 2b. 试发类入口已下线（正式版不给"发一条演示通知"） ---------------- */
check('通知弹层里没有流体云试发区块', !q('.pm-block'), '不应再有 .pm-block');
check('没有「试一张」按钮', !q('[data-pm="try"]'));
check('没有调用试发接口', !calls.promote, `promote=${calls.promote || 0}`);

/* ---------------- 3. 弹层里不该再有"检测" ---------------- */
const doneBtn = q('[data-obd="notify-done"]');
check('没有「检测」按钮', Boolean(doneBtn) && !doneBtn.textContent.includes('检测'), doneBtn ? doneBtn.textContent : '按钮不存在');
check('没有检测结果区块', !q('.pc-ok') && !q('.pc-bad') && !q('.pc-ask'));
check('点开好了之前没读系统状态', calls.audit === 0, `audit=${calls.audit}`);

/* ---------------- 4. 两个按钮跳同一处（权限管理 › 通知） ---------------- */
const beforeAgain = calls.permPage;
click('[data-obd="notify-again"]');
check('「再打开一次」走权限页链路', calls.permPage === beforeAgain + 1, `permPage=${calls.permPage}`);
check('没有偷偷改跳到渠道页', calls.settingsEx === 0, `settingsEx=${calls.settingsEx}`);

/* ---------------- 5. 「我已经开好了」= 直接收起 ---------------- */
click('[data-obd="notify-done"]');
const afterDone = norm(text());
check('点「我已经开好了」后弹层收起', !afterDone.includes('我已经开好了'), afterDone.slice(0, 60));
check('全程没有触发状态读取（说明真的不检测了）', calls.audit === 0, `audit=${calls.audit}`);
check('首次跳转就走权限页（不是渠道页）', calls.permPage >= 1, `permPage=${calls.permPage}`);

/* ---------------- 6. 电池：仍是"说明 + 跳转"，但不检测 ---------------- */
click('[data-ob-action="onboard-battery"]');
const bm = norm(text());
check('出现「修改后台运行模式」', bm.includes('修改后台运行模式'), bm.slice(0, 60));
check('明确要求「必须选完全后台运行」', bm.includes('必须选「完全后台运行」'));
check('列出三个选项', bm.includes('智能优化') && bm.includes('允许完全后台行为') && bm.includes('限制后台行为'));
check('标出正确路径', bm.includes('设置 › 应用 › 北邮课程表 › 耗电管理'));
const bDone = q('[data-obd="battery-done"]');
check('电池弹层没有「检测」按钮', Boolean(bDone) && !bDone.textContent.includes('检测'), bDone ? bDone.textContent : '按钮不存在');

const beforeMode = calls.batteryMode;
click('[data-obd="battery-mode"]');
check('调用了 openBatteryModePage', calls.batteryMode === beforeMode + 1, `calls=${calls.batteryMode}`);
check('没有再走老的 openBatterySettings', calls.legacyBattery === 0);

const beforeAudit = calls.audit;
click('[data-obd="battery-done"]');
check('电池也只记确认、不检测', calls.audit === beforeAudit, `audit=${calls.audit}`);
check('电池弹层收起', !norm(text()).includes('修改后台运行模式'));

/* ---------------- 7. 提醒页的电池页仍可渲染 ---------------- */
window.location.hash = '#/reminder/battery-mode';
await new Promise((r) => setTimeout(r, 400));
const view = norm(document.getElementById('view').textContent);
check('battery-mode 路由渲染成功', view.includes('修改后台运行模式'), view.slice(0, 60));
check('页面强调「必须选完全后台运行」', view.includes('必须选「完全后台运行」'));
check('页面有「打开「耗电管理」页」', Boolean(document.querySelector('[data-action="battery-open-system"]')));
check('页面有 AOSP 列表入口', Boolean(document.querySelector('[data-action="battery-open-aosp"]')));
check('页面不再有「检测」按钮', !document.querySelector('[data-action="battery-verify"]'));

/* ---------------- 8. 诊断块已下线：没直达时也只给"下一步做什么" ---------------- */
batteryLanding = 'appDetail';
clickDoc('[data-action="battery-open-system"]');
await new Promise((r) => setTimeout(r, 200));
const diagText = norm(document.getElementById('view').textContent);
check('页面不再出现诊断信息', !diagText.includes('诊断'), diagText.slice(0, 60));
check('没有诊断开关', !document.querySelector('[data-action="battery-diag"]'));
check('仍然给出落点提示', diagText.includes('耗电管理') || diagText.includes('应用'), diagText.slice(0, 80));

/* ---------------- 9. 后台保活设置页：信息分层，默认只看两段 ---------------- */
// 先关掉引导弹层：它开着时 returnCheck 会主动跳过（弹层自己会重画状态）
const OB = await import('./src/ui/onboard.js');
OB.closeOnboard();
window.location.hash = '#/reminder/keepalive';
await new Promise((r) => setTimeout(r, 400));
const keep = norm(document.getElementById('view').textContent);
check('标题改成「只做三件事」', keep.includes('只做三件事'), keep.slice(0, 60));
check('旧标题已去掉', !keep.includes('必做的三件事'));
check('不再有那段"入口都收敛到这一页"的解释', !keep.includes('类入口都收敛到这一页'));
check('按钮文案缩短', keep.includes('应用设置') && keep.includes('耗电管理'));
const panels = [...document.querySelectorAll('#view .panel')];
const openPanels = panels.filter((el) => el.classList.contains('is-open'));
check('逐步操作/小组件/验证 默认收起', openPanels.length === 0, `open=${openPanels.length}/${panels.length}`);
check('折叠面板至少有 3 个', panels.length >= 3, `panels=${panels.length}`);
check('页面不再重复列出五步长文案', !keep.includes('关闭「睡眠待机优化」（它会降低通知频率）'));

/* ---------------- 10. 从系统设置返回 → 自动复查（按机型提示） ---------------- */

// 10a 通知还是「未询问」→ 直接拉系统权限弹窗（真正意义上的"自动询问"）
snapshot.notify = 'default';
const beforeReq = calls.notifyPerm;
clickDoc('[data-action="keepalive-app-settings"]');
window.document.dispatchEvent(new window.Event('visibilitychange'));
await wait(800);
check('通知未询问 → 自动拉起系统权限弹窗', calls.notifyPerm === beforeReq + 1, `req=${calls.notifyPerm}`);
check('拉系统框时不再叠 App 内提示', !document.querySelector('#dialog-host .dialog'));

// 10b 通知已给、后台未豁免 → 弹机型提示
snapshot.notify = 'granted';
snapshot.exactAlarm = true;
snapshot.batteryExempt = false;
clickDoc('[data-action="keepalive-app-settings"]');
window.document.dispatchEvent(new window.Event('visibilitychange'));
await wait(800);
const rdlg = document.querySelector('#dialog-host .dialog');
check('缺后台运行 → 弹提示', Boolean(rdlg), '没有出现对话框');
const rtext = rdlg ? norm(rdlg.textContent) : '';
check('标题说明还差几项', rtext.includes('1 项还没开好'), rtext.slice(0, 60));
check('按机型说清路径', rtext.includes('耗电管理'), rtext);
check('带上机型名', rtext.includes('OPPO'), rtext.slice(0, 80));

// 10c 点「知道了」收起，不再重复弹
if (rdlg) {
  const cancel = document.querySelector('[data-action="dialog-cancel"]');
  if (cancel) cancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
await wait(100);
check('点「知道了」后对话框收起', !document.querySelector('#dialog-host .dialog'));
window.document.dispatchEvent(new window.Event('visibilitychange'));
await wait(800);
check('没有重新点入口 → 不再打扰', !document.querySelector('#dialog-host .dialog'));

/* ---------------- 11. 原生 onResume 回调这条路 + 全开着时的反馈 ---------------- */
// 三项全开 → 不再弹框，但要给一句"已复查"（否则用户以为没生效）
snapshot.notify = 'granted';
snapshot.exactAlarm = true;
snapshot.batteryExempt = true;
clickDoc('[data-action="keepalive-app-settings"]');
check('原生 onResume 回调已挂到 window', typeof window.__buptResume === 'function');
window.__buptResume(); // 模拟原生 onResume → evaluateJavascript
await wait(800);
const snack = document.getElementById('snackbar-host');
const snackText = snack ? norm(snack.textContent) : '';
check('三项都开着 → 不弹对话框', !document.querySelector('#dialog-host .dialog'));
check('三项都开着 → 给一句已复查', snackText.includes('已复查'), snackText);

// 再触发一次：pending 已消费，不该重复提示
snack.innerHTML = '';
window.__buptResume();
await wait(800);
check('没重新点入口 → 不重复提示', !norm(snack.textContent).includes('已复查'), norm(snack.textContent));

/* ---------------- 12. 必开项都开好后，「后台运行」入口自动收起 ---------------- */
// 12a 还有没开的 → 三条入口照常平铺
//     注意：电池项"用户确认过"也算满足（localStorage 里已写过），
//     所以这里用通知未授权来构造"没开全"。
snapshot.notify = 'default';
snapshot.exactAlarm = true;
snapshot.batteryExempt = false;
window.location.hash = '#/reminder';
await wait(400);
let viewText = norm(document.getElementById('view').textContent);
check('没开全 → 后台运行入口照常显示', viewText.includes('权限一键检查') && viewText.includes('后台保活设置'), viewText.slice(0, 80));
check('没开全 → 没有「已就绪」折叠项', !viewText.includes('后台运行 · 已就绪'));

// 12b 全开 → 收进一个折叠项（默认关闭）
snapshot.notify = 'granted';
snapshot.batteryExempt = true;
window.location.hash = '#/timetable';
await wait(150);
window.location.hash = '#/reminder';
await wait(400);
viewText = norm(document.getElementById('view').textContent);
check('全开 → 出现「后台运行 · 已就绪」', viewText.includes('后台运行 · 已就绪'), viewText.slice(0, 100));
const readyPanel = [...document.querySelectorAll('#view .panel')].find((el) =>
  norm(el.querySelector('.panel-head') ? el.querySelector('.panel-head').textContent : '').includes('已就绪')
);
check('已就绪项存在', Boolean(readyPanel));
check('已就绪默认是关闭的', readyPanel ? readyPanel.querySelector('.panel-body').hasAttribute('hidden') : false);
check(
  '三条入口被收进这个折叠项里',
  readyPanel ? norm(readyPanel.textContent).includes('权限一键检查') && norm(readyPanel.textContent).includes('后台保活设置') : false
);

/* ---------------- 汇总 ---------------- */
let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.pass ? '' : `\n       → ${c.extra}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
