/**
 * .probe-grab.mjs — 「填学号密码 → 后台抓取 → 进度 → 结果/失败」端到端探针（jsdom + 假原生桥）。
 *
 * 真的抓取只能在内网 + 真机上跑，这里用假桥把原生那一侧替换掉，
 * 验证**网页层**该做的事：
 *   ① 只有一个入口，学号密码提交后立刻进"正在抓取"（不等原生回话）
 *   ② 进度事件能把步骤条与百分比推着走；倒退/串台的脏事件不生效
 *   ③ 取消立刻有结论，且迟到的进度不会让它复活
 *   ④ 失败分原因给建议，本地数据一个字不动
 *   ⑤ 结果落库：没有课表 → 全量预览；已有课表 → 只列差异
 *
 *   node .probe-grab.mjs
 */

import fs from 'node:fs';

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
  ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));

/* ---------------------------------------------------------------- 假原生桥 */

let savedAccount = '';
let savedPwd = '';
let grabCalls = [];
let cancelCalls = 0;
let credsCleared = 0;

window.BuptNative = {
  getInfo() {
    return JSON.stringify({ platform: 'android', appVersion: '1.15.0', sdk: 34 });
  },
  openJwgl() {},
  toast() {},
  saveCredentials(account, password) {
    savedAccount = String(account || '');
    savedPwd = String(password || '');
    return savedAccount !== '' && savedPwd !== '';
  },
  hasCredentials() {
    return savedAccount !== '' && savedPwd !== '';
  },
  credentialsAccount() {
    return savedAccount;
  },
  clearCredentials() {
    savedAccount = '';
    savedPwd = '';
    credsCleared += 1;
  },
  // ★ 1.15.0 的后台抓取
  startGrab(id, account, password) {
    grabCalls.push({ id: String(id || ''), account: String(account || ''), password: String(password || '') });
  },
  cancelGrab() {
    cancelCalls += 1;
  },
  grabRunning() {
    return false;
  },
  // 旧通道（手动抓取）仍要能用
  autoCapture() {},
  scheduleReminders() {},
  getNotifyPermission() {
    return 'granted';
  },
  requestNotifyPermission() {},
  notifyTest() {}
};

globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.HTMLFormElement = window.HTMLFormElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.FormData = window.FormData;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
window.confirm = () => true;

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));

window.localStorage.clear();
await import('./src/main.js');
await new Promise((r) => setTimeout(r, 400));

/* ---------------------------------------------------------------- 工具 */

const checks = [];
const ok = (name, value) => checks.push([name, !!value]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = () => document.getElementById('view');
const text = () => (view() && view().textContent) || '';
const state = () => window.__buptApp.store.getState();
const grab = () => window.__buptApp.uiState.grab;
const go = async (hash) => {
  window.location.hash = hash;
  await sleep(150);
};
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const b64 = (payload) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

/* ---------------------------------------------------------------- 课表 HTML */

const TIMES = ['08:00-08:45', '08:50-09:35', '10:40-11:25', '11:30-12:15', '13:00-13:45', '13:50-14:35'];

function buildTable(blocks) {
  const trs = [];
  for (let i = 1; i <= 6; i += 1) {
    const tds = [`<td>${i}<br/>${TIMES[i - 1]}</td>`];
    for (let dow = 1; dow <= 7; dow += 1) {
      const hit = blocks.find((b) => b.day === dow && b.row === i);
      if (hit) tds.push(`<td rowspan="${hit.span || 1}"><div>${hit.lines.join('<br/>')}</div></td>`);
      else if (blocks.some((b) => b.day === dow && b.row < i && b.row + (b.span || 1) > i)) tds.push('');
      else tds.push('<td></td>');
    }
    trs.push(`<tr>${tds.join('')}</tr>`);
  }
  return `<html><body><table id="kbtable"><tr><th>节次</th><th>周一</th><th>周二</th><th>周三</th><th>周四</th><th>周五</th><th>周六</th><th>周日</th></tr>${trs.join('')}</table></body></html>`;
}

const BASE_BLOCKS = [
  { day: 3, row: 1, span: 2, lines: ['大学生心理健康1', '王培', '4-7(周)[01-02节]', '教学实验综合楼-S215'] },
  { day: 2, row: 2, span: 2, lines: ['数学分析(上)', '李晓莉', '4-19(周)[02-03节]', '教学实验综合楼-S210'] },
  { day: 5, row: 5, span: 2, lines: ['基础综合英语', '宋媛', '4-19(周)[05-06节]', '智慧教学楼-413'] }
];

const CHANGED_BLOCKS = [
  { day: 4, row: 1, span: 2, lines: ['大学生心理健康1', '王培', '4-7(周)[01-02节]', '教学实验综合楼-S215'] },
  { day: 2, row: 2, span: 2, lines: ['数学分析(上)', '李晓莉', '4-19(周)[02-03节]', '教学实验综合楼-S220'] },
  { day: 5, row: 5, span: 2, lines: ['程序设计与编程方法', '何大中', '4-19(周)[05-06节]', '智慧教学楼-117'] }
];

/** 表头日期：第 1 周是 2026-08-31（周一）… 09-06（周日）。 */
const DATES_W1 = ['08-31', '09-01', '09-02', '09-03', '09-04', '09-05', '09-06'];

const payloadOf = (blocks, week = 1, dates = DATES_W1) => ({
  url: 'https://jwgl.bupt.edu.cn/jsxsd/kbcx/kbxx_xskb',
  title: '我的课表/考表',
  candidates: [{ label: '表格 #kbtable', html: buildTable(blocks) }],
  signals: {
    weekTexts: [],
    weakTexts: [`第${week}周`],
    titles: ['我的课表/考表'],
    // ★ 起始周全靠这个锚点：week + 表头日期。原生那边漏传就识别不出来（见 tests/capture-signals）
    weekAnchor: { week, dates, picker: null, term: '2026-2027-1' }
  }
});

/** 投递结果：id 默认取当前任务，可显式指定（用来构造"迟到的上一次结果"）。 */
const deliverResult = (payload, id) => {
  const g = grab();
  window.__buptGrabResult(id == null ? (g ? g.id : '') : id, b64(payload));
};
const pushEvent = (event) => window.__buptGrabEvent(event);

/** 提交学号密码表单。pwd 传空 = 用已保存的。 */
async function submitForm(account, pwd) {
  const form = view().querySelector('form[data-action="grab-start"]');
  if (!form) return false;
  form.querySelector('#grab-acc').value = account;
  form.querySelector('#grab-pwd').value = pwd;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(90);
  return true;
}

/** 无论当前在抓取中、失败卡还是结果页，都回到"学号密码表单"。 */
async function backToForm() {
  await go('#/import');
  if (grab() && grab().status === 'running') {
    pushEvent({ type: 'error', id: grab().id, code: 'cancelled' });
    await sleep(130);
  }
  if (click(view().querySelector('[data-action="grab-restart"]'))) await sleep(140);
  return Boolean(view().querySelector('form[data-action="grab-start"]'));
}

/* ---------------------------------------------------------------- 1. 入口只有一个 */

await go('#/import');
ok('导入页出现自动导入卡', text().includes('从教务系统导入'));
ok('有学号输入框', Boolean(view().querySelector('#grab-acc')));
ok('有密码输入框', Boolean(view().querySelector('#grab-pwd')));
ok('主按钮是「自动导入课程」', text().includes('自动导入课程'));
ok('没有并列的「更新课表」卡', !text().includes('更新课表'));
ok('首次使用时没有「清除账号」入口', !view().querySelector('[data-action="cred-clear"]'));
ok('备用通道仍在（折叠到二级页）', Boolean(view().querySelector('a[href="#/import/manual"]')));
ok('手动抓取作为兜底入口保留', Boolean(view().querySelector('[data-action="import-native-capture"]')));

/* ---------------------------------------------------------------- 2. 必填校验 */

await submitForm('', 'secret');
ok('学号为空时拦住并提示', document.getElementById('snackbar-host').textContent.includes('学号'));
ok('学号为空时没有把任务交给原生', grabCalls.length === 0);

await submitForm('2021001', '');
ok('首次使用密码为空时拦住', grabCalls.length === 0 && document.getElementById('snackbar-host').textContent.includes('密码'));

/* ---------------------------------------------------------------- 3. 提交 → 立即进入抓取中 */

await submitForm('2021001', 'my-secret');
ok('任务交给了原生', grabCalls.length === 1);
ok('传给原生的学号正确', grabCalls[0].account === '2021001');
ok('传给原生的密码正确', grabCalls[0].password === 'my-secret');
ok('网页自己生成了任务号', Boolean(grab() && grab().id) && grabCalls[0].id === grab().id);
ok('勾了「记住密码」就加密存下来', savedAccount === '2021001' && savedPwd === 'my-secret');
ok('页面立刻进入「正在抓取」', text().includes('正在抓取'));
ok('进度条出现', Boolean(view().querySelector('.grab-bar')));
ok('五步清单都在', view().querySelectorAll('.grab-steps > li').length === 5);
ok('有取消按钮', Boolean(view().querySelector('[data-action="grab-cancel"]')));
ok('密码框已清空，不留在 DOM 里', !view().querySelector('#grab-pwd'));

const taskId = grab().id;

/* ---------------------------------------------------------------- 4. 进度推进 */

pushEvent({ type: 'progress', id: taskId, step: 'connect', percent: 6, text: '正在连接教务系统…' });
pushEvent({ type: 'progress', id: taskId, step: 'login', percent: 22, text: '正在登录…' });
await sleep(60);
ok('进度事件推进了百分比', grab().percent === 22 && grab().step === 'login');
ok('界面显示当前步骤', text().includes('正在登录'));
ok('当前步骤被高亮', Boolean(view().querySelector('.grab-steps > li.is-active')));
ok('前面的步骤已打勾', view().querySelectorAll('.grab-steps > li.is-done').length === 1);

pushEvent({ type: 'progress', id: taskId, step: 'connect', percent: 2 });
await sleep(50);
ok('倒退的进度事件被丢掉', grab().percent === 22 && grab().step === 'login');

pushEvent({ type: 'progress', id: 'stale-id', step: 'read', percent: 70 });
await sleep(50);
ok('别的任务的事件被忽略', grab().percent === 22);

/* ---------------------------------------------------------------- 5. 取消 */

click(view().querySelector('[data-action="grab-cancel"]'));
await sleep(120);
ok('取消后状态是 failed/cancelled', grab().status === 'failed' && grab().error === 'cancelled');
ok('取消时通知了原生', cancelCalls === 1);
ok('取消后按钮消失', !view().querySelector('[data-action="grab-cancel"]'));

pushEvent({ type: 'progress', id: taskId, step: 'read', percent: 70 });
pushEvent({ type: 'done', id: taskId });
await sleep(80);
ok('取消后迟到事件不能让它复活', grab().status === 'failed');
ok('取消后本地课表还是空的', state().sessions.length === 0);

/* ---------------------------------------------------------------- 6. 失败：验证码 */

click(view().querySelector('[data-action="grab-retry"]'));
await sleep(120);
ok('「重试」直接复用已保存的凭证', grabCalls.length === 2 && grabCalls[1].password === '');
ok('重试后又进入抓取中', grab().status === 'running');

pushEvent({ type: 'error', id: grab().id, code: 'captcha', detail: '登录页含验证码元素' });
await sleep(150);
ok('失败卡说明是验证码', text().includes('验证码'));
ok('失败卡明确本地没动', text().includes('本地课表没有任何改动'));
ok('失败卡给了重试', Boolean(view().querySelector('[data-action="grab-retry"]')));
ok('失败卡给了手动兜底', Boolean(view().querySelector('[data-action="import-native-capture"]')));
ok('失败后仍然是空课表', state().sessions.length === 0);

/* 内网不可达：最需要"改手动"的一种 */
click(view().querySelector('[data-action="grab-retry"]'));
await sleep(100);
pushEvent({ type: 'error', id: grab().id, code: 'no_network' });
await sleep(120);
ok('内网不可达时提示校园网/VPN', text().includes('校园网') || text().includes('VPN'));

/* ---------------------------------------------------------------- 7. 成功（本地没有课表）→ 全量预览 */

click(view().querySelector('[data-action="grab-retry"]'));
await sleep(100);
deliverResult(payloadOf(BASE_BLOCKS, 1));
await sleep(250);
ok('抓取成功后清掉失败卡', !text().includes('没有抓成'));
ok('出现课程列表', text().includes('大学生心理健康1') && text().includes('数学分析(上)'));
ok('显示抓到的课次数', text().includes('个课次'));
ok('有「确认导入」按钮', Boolean(view().querySelector('[data-action="import-commit"]')));
ok('列表里能看到周次', text().includes('4-19') || text().includes('4-7'));
ok('抓取状态标记为完成', grab().status === 'done');
ok('结果页有「重新抓取」入口', Boolean(view().querySelector('[data-action="grab-restart"]')));
ok(
  '自动导入识别出了学期起始周（08-31）',
  text().includes('08-31') || text().includes('第 1 周周一')
);

click(view().querySelector('[data-action="import-commit"]'));
await sleep(250);
ok('确认后写入 3 门课', state().courses.length === 3);
ok('写入 3 个课次', state().sessions.length === 3);
ok(
  '自动导入把起始周写进了设置（2026-08-31）',
  state().settings.semesterStartMonday === '2026-08-31'
);

/* ---------------------------------------------------------------- 8. 成功（已有课表）→ 只列差异 */

ok('确认导入后能回到表单', await backToForm());
ok('已保存账号时学号被预填', view().querySelector('#grab-acc').value === '2021001');

await submitForm('2021001', '');
ok('密码留空时提交的密码是空串（不递明文）', grabCalls[grabCalls.length - 1].password === '');

deliverResult(payloadOf(CHANGED_BLOCKS, 3));
await sleep(280);
ok('已有课表时跳到变更确认页', window.location.hash === '#/import/update');
ok('变更页列出新增课程', text().includes('程序设计与编程方法'));
ok('变更页列出删除课程', text().includes('基础综合英语'));
ok('变更页标出地点变化', text().includes('S220'));
ok('变更页有「应用变更」', Boolean(view().querySelector('[data-action="update-apply"]')));
ok('未确认前数据没被改', state().sessions.some((s) => String(s.location).includes('S210')));

/* ---------------------------------------------------------------- 9. 解析失败 → 明确的结论 */

ok('解析失败后能回到表单', await backToForm());
await submitForm('2021001', '');
deliverResult({ url: 'x', candidates: [{ label: '空', html: '<html><body>登录失败</body></html>' }] });
await sleep(250);
ok('抓到但没有课程时判解析失败', grab().status === 'failed' && grab().error === 'parse_failed');
ok('解析失败也说明本地没动', text().includes('本地课表没有任何改动'));
ok('解析失败建议改手动', Boolean(view().querySelector('[data-action="import-native-capture"]')));
ok('失败卡能换账号（否则密码错了永远出不去）', Boolean(view().querySelector('[data-action="grab-restart"]')));

/* ---------------------------------------------------------------- 10. 迟到的上一次结果 */

ok('能再次回到表单', await backToForm());
await submitForm('2021001', '');
const freshId = grab().id;
deliverResult(payloadOf(BASE_BLOCKS, 2), 'old-stale-id');
await sleep(220);
ok('别的任务的迟到结果不会被当成这次的成果', grab().status === 'running' && grab().id === freshId);
ok('迟到结果也没有改动课表', state().courses.length === 3);

/* ---------------------------------------------------------------- 11. 清除账号 */

ok('收尾前能回到表单', await backToForm());
click(view().querySelector('[data-action="cred-clear"]'));
await sleep(160);
ok('清除后回到表单', Boolean(view().querySelector('form[data-action="grab-start"]')));
ok('清除后没有「清除」入口了', !view().querySelector('[data-action="cred-clear"]'));
ok('确实调用了原生清除', credsCleared === 1);

await submitForm('2021001', '');
ok('清除后不填密码会被拦住', document.getElementById('snackbar-host').textContent.includes('密码'));

/* ---------------------------------------------------------------- 收尾 */

await sleep(200);
ok('没有 JS 报错', errors.length === 0);

let failed = 0;
for (const [name, value] of checks) {
  if (!value) failed += 1;
  console.log(`${value ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n${checks.length} 条断言，failed=${failed}${errors.length ? `\n错误：${errors.join(' | ')}` : ''}`);
process.exit(failed ? 1 : 0);
