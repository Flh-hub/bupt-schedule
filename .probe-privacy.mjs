/**
 * .probe-privacy.mjs — 隐私说明 + 「下一条提醒」卡片的端到端探针。
 *
 * 这两块都是"给用户看的话"，最怕的是渲染出 undefined / 时间口径写错。
 * 所以这里不看函数返回值，直接把 DOM 渲染出来，检查真实文本。
 */
import fs from 'node:fs';

// jsdom 装在托管 node 的 workspace 里，项目本身不是 npm 项目
const jsdomMod = await import(
  'file:///C:/Users/20976/.workbuddy/binaries/node/workspace/node_modules/jsdom/lib/api.js'
);
const JSDOM = (jsdomMod.default || jsdomMod).JSDOM;

const dom = new JSDOM(fs.readFileSync('index.html', 'utf8'), {
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

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const { sampleState } = await import('./src/ui/components.js');
const { renderReminder } = await import('./src/ui/reminderView.js');
const { renderSettings } = await import('./src/ui/settings.js');
const { maybeAskPrivacy, privacyAccepted, acceptPrivacy } = await import('./src/ui/privacy.js');

const checks = [];
const check = (name, pass, extra = '') => checks.push({ name, pass, extra });
const view = document.getElementById('view');
const dialogHost = document.getElementById('dialog-host');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const state = sampleState();

/* ---------------- 隐私页 ---------------- */

renderSettings(view, state, { sub: 'privacy' });
const privacyHtml = view.innerHTML;
const privacyText = norm(view.textContent);

check('隐私页能渲染出正文', privacyText.includes('不收集你的个人信息'));
check('说清了唯一联网地址', privacyText.includes('jwgl.bupt.edu.cn'));
check('说清了密码怎么存', privacyText.includes('Keystore'));
check('列了权限用途', privacyText.includes('精确闹钟'));
check('说清了没做的采集', privacyText.includes('OAID'));
check('没有渲染出 undefined', !privacyHtml.includes('undefined'));
check('隐私页有返回设置的路由', privacyHtml.includes('#/settings'));

/* ---------------- 首次启动弹层 ---------------- */

check('初始状态是未同意', privacyAccepted() === false);
const shown = maybeAskPrivacy();
check('未同意时会弹', shown === true);
check(
  '弹层有两个出口',
  dialogHost.querySelector('[data-privacy="accept"]') && dialogHost.querySelector('[data-privacy="later"]')
);
check('弹层文案含关键信息', norm(dialogHost.textContent).includes('不收集你的个人信息'));
check('弹层有全文链接', !!dialogHost.querySelector('a[href="#/settings/privacy"]'));

// 点「同意并继续」→ 标记落盘、弹层收起
let accepted = false;
dialogHost.querySelector('[data-privacy="accept"]').click();
check('点同意后标记已写入', privacyAccepted() === true);
check('点同意后弹层收起', !dialogHost.classList.contains('is-open') || dialogHost.innerHTML === '');
check('同意不会再弹', maybeAskPrivacy() === false);
void accepted;

/* ---------------- 下一条提醒 ---------------- */

renderReminder(view, state, { openPanels: new Set() });
const reminderHtml = view.innerHTML;
const reminderText = norm(view.textContent);

check('提醒页出现「下一条提醒」', reminderText.includes('下一条提醒'));
check('写明了是「发出」时间', /发出/.test(reminderText));
check('副行给的是上课时间', reminderText.includes('上课 ·'));
check('写明已交给系统闹钟', reminderText.includes('已交给系统闹钟'));
check('没有 undefined', !reminderHtml.includes('undefined'));
check('没有 null 字面量', !/>null</.test(reminderHtml));
check('不再出现「测试通知」', !reminderText.includes('测试通知'));

// 空排期：学期往前挪 10 周、课次只留第 1 周 → 今天这一周整周没课
const emptyState = sampleState();
const back = new Date();
back.setDate(back.getDate() - 70);
const backIso = `${back.getFullYear()}-${String(back.getMonth() + 1).padStart(2, '0')}-${String(
  back.getDate()
).padStart(2, '0')}`;
emptyState.settings.semesterStartMonday = backIso;
emptyState.sessions = emptyState.sessions.map((s) => ({
  ...s,
  weeks: { start: 1, end: 1, type: 'all', extra: [] },
  rawWeeksText: '1周'
}));
emptyState.adjustments = [];
renderReminder(view, emptyState, { openPanels: new Set() });
const emptyText = norm(view.textContent);
check('没课时给空状态而不是空白', emptyText.includes('没有排上的提醒'));

/* ---------------- 输出 ---------------- */

let pass = 0;
for (const c of checks) {
  if (c.pass) {
    pass += 1;
    console.log(`ok   ${c.name}`);
  } else {
    console.log(`FAIL ${c.name}${c.extra ? `  → ${c.extra}` : ''}`);
  }
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
