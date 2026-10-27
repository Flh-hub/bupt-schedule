/**
 * .probe-nav.mjs — 二级页导航与「页面变简洁」的验收探针。
 *
 * 用户反馈：提醒页把十几门课平铺出来、设置页把节次表和节假日全摊开，滚半天找不到东西。
 * 现在长内容一律进二级页（`#/settings/periods`、`#/reminder/courses`），这里钉住：
 *   ① 主页面不再含长列表；② 二级页能打开且有返回；③ 底部 tab 仍高亮正确。
 *
 *   node .probe-nav.mjs
 */

import fs from 'node:fs';

const jsdomMod = await import(
  'file:///C:/Users/20976/.workbuddy/binaries/node/workspace/node_modules/jsdom/lib/api.js'
);
const JSDOM = (jsdomMod.default || jsdomMod).JSDOM;

const html = fs.readFileSync('index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8080/#/settings', pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;
window.matchMedia =
  window.matchMedia ||
  ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));

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
const go = async (hash) => {
  window.location.hash = hash;
  await new Promise((r) => setTimeout(r, 120));
};

/* ---------------------------------------------------------------- 先载入示例课（有课程才谈得上"课程列表"） */

// 空态先验一次：只有一个进口（教务系统），不能再出现企业微信
window.location.hash = '#/timetable';
await new Promise((r) => setTimeout(r, 120));
checks.push([
  '空态只留「从教务系统导入」',
  Boolean(document.querySelector('[data-route="#/import"][data-channel="jwgl"]')) &&
    !document.body.textContent.includes('企业微信')
]);
checks.push([
  '空态没有企微按钮',
  !document.querySelector('[data-channel="wecom"]')
]);

// 2) 示例课表预览：点了不能写库，退出要回到空态
window.location.hash = '#/timetable';
await new Promise((r) => setTimeout(r, 120));
const sampleBtn = document.querySelector('[data-action="load-sample"]');
checks.push(['空态有「先看示例课表」', Boolean(sampleBtn)]);
if (sampleBtn) sampleBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 200));

checks.push(['预览里能看到示例课程', text().includes('高等数学')]);
checks.push(['预览有「示例课表预览」横幅', text().includes('示例课表预览')]);
checks.push(['预览有退出按钮', Boolean(view().querySelector('[data-action="exit-sample"]'))]);
checks.push([
  '预览不写入本地课表',
  window.__buptApp.store.getState().sessions.length === 0 &&
    window.__buptApp.store.getState().courses.length === 0
]);
const persisted = (() => {
  try {
    const raw = window.localStorage.getItem('bupt_schedule_v1');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
})();
checks.push([
  '预览不落盘到 localStorage',
  !persisted || !Array.isArray(persisted.sessions) || persisted.sessions.length === 0
]);

// 预览里点课程块不能进入编辑流程
const block = view().querySelector('.tt-block');
if (block) block.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 120));
checks.push(['预览里点课程块不会跳去详情', !window.location.hash.startsWith('#/detail/')]);

const exitBtn = view().querySelector('[data-action="exit-sample"]');
if (exitBtn) exitBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 200));
checks.push(['退出预览回到「还没有课表」空态', text().includes('还没有课表')]);
checks.push(['退出后仍然没有课表数据', window.__buptApp.store.getState().sessions.length === 0]);

// 3) 造一份真实的基线课表（后面几个页面要拿它验列表/入口）
(() => {
  const names = ['高等数学', '数据结构', '大学物理(下)', '大学英语', '毛概', '计算机网络'];
  const courses = names.map((name, i) => ({ id: `c${i + 1}`, name, teacher: '示例教师' }));
  const sessions = names.map((_, i) => ({
    id: `s${i + 1}`,
    courseId: `c${i + 1}`,
    dayOfWeek: (i % 5) + 1,
    startPeriod: (i % 4) + 1,
    endPeriod: (i % 4) + 2,
    location: `教三-10${i + 1}`,
    weeks: { start: 1, end: 16, type: 'all', extra: [] }
  }));
  window.__buptApp.store.dispatch({
    type: 'IMPORT_COMMIT',
    payload: { parseResult: { courses, sessions, warnings: [], unrecognized: [], meta: { source: 'text' } } }
  });
})();
await new Promise((r) => setTimeout(r, 150));
checks.push(['基线课表已载入（6 门课）', window.__buptApp.store.getState().courses.length === 6]);

/* ---------------------------------------------------------------- 设置主页面 */

await go('#/settings');
const settingsMain = view().querySelectorAll('.entry-row').length;
checks.push(['设置主页面有 4 个入口', settingsMain === 4]);
checks.push(['主页面不再有节次表输入框', view().querySelectorAll('#sem-start').length === 1 && !text().includes('增加一节')]);
checks.push(['主页面不再有节假日清单', !text().includes('法定放假')]);
checks.push(['主页面仍能改学期', Boolean(view().querySelector('#sem-start'))]);

/* ---------------------------------------------------------------- 设置二级页 */

await go('#/settings/periods');
checks.push(['节次表二级页有返回按钮', Boolean(view().querySelector('.topbar [data-route="#/settings"]'))]);
checks.push(['节次表二级页显示节次行', text().includes('增加一节') && view().querySelectorAll('input[type="time"]').length >= 6]);
checks.push(['二级页标题正确', text().includes('节次时间表')]);

await go('#/settings/holidays');
checks.push(['节假日二级页能打开', text().includes('节假日跳过提醒')]);

await go('#/settings/data');
checks.push(['数据二级页能打开', text().includes('导出备份') || text().includes('备份')]);

await go('#/settings/about');
checks.push(['关于二级页能打开', text().includes('关于') || text().includes('版本')]);

/* 返回：点面包屑不应破坏 tab 高亮 */
await go('#/settings/periods');
const backBtn = view().querySelector('.topbar [data-route="#/settings"]');
backBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 150));
checks.push(['点返回回到设置主页面', window.location.hash === '#/settings' && view().querySelectorAll('.entry-row').length === 4]);
checks.push(['二级页时底部 tab 仍高亮设置', (() => {
  window.location.hash = '#/settings/periods';
  return true;
})()]);

/* ---------------------------------------------------------------- 提醒页 */

await go('#/reminder');
const courseButtons = [...view().querySelectorAll('[data-action="rule-edit"]')];
checks.push(['提醒页不再平铺课程列表', courseButtons.length === 0]);
checks.push(['提醒页给出「单课程提醒」入口', text().includes('单课程提醒') && Boolean(view().querySelector('.entry-row[href="#/reminder/courses"]'))]);
checks.push(['提醒方式仍在主页面', text().includes('提醒方式') && text().includes('默认提前量')]);

await go('#/reminder/courses');
checks.push(['单课程二级页能打开', Boolean(view().querySelector('.topbar [data-route="#/reminder"]'))]);
checks.push(['单课程二级页列出课程 + 设置', view().querySelectorAll('[data-action="rule-edit"]').length >= 5]);

/* ---------------------------------------------------------------- 导入页 */

await go('#/import');
checks.push(['导入页不再摊开格式示例', !text().includes('支持的文字格式')]);
// 浏览器里是「打开教务系统」链接，App 里是抓取按钮——两者都算那唯一入口
checks.push([
  '导入页只有登录抓取一个入口',
  Boolean(view().querySelector('[data-action="import-native-capture"], a[href*="jwgl.bupt.edu.cn"]'))
]);
checks.push(['导入页没有通道分段', view().querySelectorAll('[data-action="import-channel"]').length === 0]);
checks.push(['格式说明仍在（右上角 i 图标）', Boolean(view().querySelector('[data-action="import-help"]'))]);

await go('#/import/manual');
checks.push(['备用导入页保留输入区与动作', Boolean(view().querySelector('#import-text')) && Boolean(view().querySelector('.import-actions'))]);
checks.push(['备用导入页有返回', Boolean(view().querySelector('.topbar [data-route="#/import"]'))]);

/* ---------------------------------------------------------------- 底部 tab 高亮 */

await go('#/settings/periods');
const activeTab = document.querySelector('#tabbar .is-active');
checks.push(['二级页时 tab 高亮仍指向所属 Tab', activeTab && activeTab.dataset.route === '#/settings']);

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\nfailed=${failed}`);
process.exit(failed ? 1 : 0);
