/**
 * .probe-event-time.mjs — 「添加活动」改成按**具体时间**录入后，块在表格里的位置。
 *
 * 验的是渲染侧：同样的时间，落到哪一行、行内下移多少、块有多高，
 * 必须等于 model.timePlacement() 的结论（数学部分由 tests/time-placement.test.mjs 钉住）。
 *
 *   node .probe-event-time.mjs
 */

import fs from 'node:fs';

const jsdomMod = await import(
  'file:///C:/Users/20976/.workbuddy/binaries/node/workspace/node_modules/jsdom/lib/api.js'
);
const JSDOM = (jsdomMod.default || jsdomMod).JSDOM;

const html = fs.readFileSync('index.html', 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost:8080/?demo=1#/timetable',
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await import('./src/main.js');
await wait(500);

const M = await import('./src/model.js');
const COMP = await import('./src/ui/components.js');
const app = window.__buptApp;
const doc = window.document;

const checks = [];
const ok = (name, value) => checks.push([name, !!value]);
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const state = () => app.store.getState();
const sheetHost = doc.getElementById('sheet-host');

/** 提交"活动"表单（时间由调用方给定）。 */
async function addEvent(date, period, title, startTime, endTime) {
  app.openSlotSheet(date, period);
  await wait(60);
  click(doc.querySelector('[data-action="slot-mode"][data-value="event"]'));
  await wait(40);
  doc.getElementById('slot-title').value = title;
  doc.getElementById('ev-start').value = startTime;
  doc.getElementById('ev-end').value = endTime;
  sheetHost
    .querySelector('form')
    .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(80);
  app.render();
  await wait(80);
}

const weekMonday = doc.querySelector('.tt-slot')?.dataset.date;
const date = M.addDays(weekMonday || M.todayStr(), 6); // 周日：示例数据里基本空着

/* ---------------------------------------------------------------- ① 表单是时间输入 */

app.openSlotSheet(date, 1);
await wait(60);
click(doc.querySelector('[data-action="slot-mode"][data-value="event"]'));
await wait(40);

ok('活动栏出现「开始时间 / 结束时间」', !!doc.getElementById('ev-start') && !!doc.getElementById('ev-end'));
ok(
  '两个时间输入都是 type=time',
  doc.getElementById('ev-start').getAttribute('type') === 'time' &&
    doc.getElementById('ev-end').getAttribute('type') === 'time'
);
ok('活动栏里**不再**出现节次选择器', !doc.querySelector('[data-slot-group="event"] [data-pick-id]'));
ok('切回补课仍有节次选择器', !!doc.querySelector('[data-slot-group="makeup"] [data-pick-id]'));
const p1 = state().settings.periods.find((p) => Number(p.index) === 1);
ok('默认时间是点开那一格的起止', doc.getElementById('ev-start').value === p1.start);
app.closeSheet?.();
await wait(40);

/* ------------------------------------------------- ①.5 报错要看得见（用户截图那个 bug） */

// 名称留空直接提交 → 表单不关，并弹红色提示；提示条必须"压过弹层"且让开按钮行
sheetHost.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(60);
const snackHost = doc.getElementById('snackbar-host');
const danger = snackHost.querySelector('.snackbar.is-danger');
ok('空名称提交会弹红色提示', !!danger && snackHost.textContent.includes('名字'));
ok('提交失败后弹层保持打开', sheetHost.classList.contains('is-open'));
ok(
  '提示条被抬到弹层之上（is-over-sheet）',
  snackHost.classList.contains('is-over-sheet')
);
ok(
  '提示条位置让开了弹层按钮行（有内联 bottom）',
  /^\d+px$/.test(snackHost.style.bottom || '') && parseInt(snackHost.style.bottom, 10) >= 12
);
// 关掉弹层再弹提示 → 要恢复默认位置，不能一直吊在屏幕中间
COMP.closeSheet();
await wait(80);
COMP.snackbar('测试普通提示');
await wait(60);
ok('弹层关闭后提示条回到默认位置', !snackHost.classList.contains('is-over-sheet') && !snackHost.style.bottom);

/* ---------------------------------------------------------------- ② 提交：时间 → 节次 */

await addEvent(date, 1, '半格活动', '08:20', '09:00');
const ev1 = state().adjustments.find((a) => a.type === 'event' && a.title === '半格活动');
ok('活动写入了 startTime/endTime', ev1 && ev1.startTime === '08:20' && ev1.endTime === '09:00');
ok('节次由时间反推（08:20-09:00 → 第 1-2 节）', ev1 && ev1.startPeriod === 1 && ev1.endPeriod === 2);
ok('反推的节次与纯函数一致', (() => {
  const r = M.periodRangeForTime(state().settings.periods, '08:20', '09:00');
  return ev1 && ev1.startPeriod === r.startPeriod && ev1.endPeriod === r.endPeriod;
})());

/* ---------------------------------------------------------------- ③ 渲染：按比例定位 */

const blocks = [...doc.querySelectorAll('.tt-block.is-timed')];
ok('渲染出按时间定位的活动块', blocks.length >= 1);

const b1 = blocks.find((b) => b.textContent.includes('半格活动'));
ok('找到 08:20 那块', !!b1);

const geo1 = M.timePlacement(state().settings.periods, '08:20', '09:00');
ok('落在第 1 节那一行（grid-row:2）', b1 && b1.style.gridRow === '2');
ok(
  `行内下移按比例（${(geo1.offset).toFixed(3)} 行）`,
  b1 && b1.getAttribute('style').includes(`margin-top:calc(var(--row-h) * ${geo1.offset.toFixed(3)})`)
);
ok(
  `块高按时间跨度（${(geo1.height).toFixed(3)} 行）`,
  b1 && b1.getAttribute('style').includes(`height:calc(var(--row-h) * ${geo1.height.toFixed(3)} - 4px)`)
);
// 08:20 在第 1 节里，下移量必须明显大于 0 且小于 1（不是整格对齐）
ok('确实没有整格对齐（0 < offset < 1）', geo1.offset > 0.05 && geo1.offset < 0.95);

/* 同一节里另一个时间 → 行内偏移必须不同（位置跟时间走，不是跟节次走） */
await addEvent(date, 1, '靠下活动', '08:40', '08:55');
const b2 = [...doc.querySelectorAll('.tt-block.is-timed')].find((b) => b.textContent.includes('靠下活动'));
const geo2 = M.timePlacement(state().settings.periods, '08:40', '08:55');
ok('08:40 那块也在第 1 行', b2 && b2.style.gridRow === '2');
ok(
  '同一节内 08:40 比 08:20 更靠下',
  b2 && geo2.offset > geo1.offset && b2.getAttribute('style').includes(`${geo2.offset.toFixed(3)}`)
);

/* 跨到下一节 → 行号必须跟着变 */
// 09:00 在第 2 节内（08:50–09:35），10:20 已进第 3 节（09:55–10:40）→ 跨行、且高度 > 1 行
await addEvent(date, 1, '跨节活动', '09:00', '10:20');
const b3 = [...doc.querySelectorAll('.tt-block.is-timed')].find((b) => b.textContent.includes('跨节活动'));
const geo3 = M.timePlacement(state().settings.periods, '09:00', '10:20');
ok('09:00 落在第 2 节那一行（grid-row:3）', b3 && b3.style.gridRow === '3');
ok('跨节块比单节块高', geo3.height > 1);

/* ---------------------------------------------------------------- ④ 详情与日视图 */

click(b3);
await wait(80);
ok('活动详情显示的是具体时间', sheetHost.textContent.includes('09:00') && sheetHost.textContent.includes('10:20'));
ok('详情里不再只写「第 N 节」', !/^第 \d+ 节$/.test(sheetHost.textContent.trim()));

/* 清理：删掉三条活动，别把后面的用例拖脏 */
for (const t of ['半格活动', '靠下活动', '跨节活动']) {
  const adj = state().adjustments.find((a) => a.type === 'event' && a.title === t);
  if (adj) app.store.dispatch({ type: 'DELETE_ADJUSTMENT', payload: { id: adj.id } });
}
await wait(60);
ok('清理后活动全删掉', state().adjustments.every((a) => a.type !== 'event'));

/* ---------------------------------------------------------------- 输出 */

let failed = 0;
for (const [name, pass] of checks) {
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
}
if (errors.length) {
  failed += errors.length;
  for (const e of errors) console.log(`FAIL  JS 报错：${e}`);
}
console.log(`\npassed=${checks.length - failed} failed=${failed}`);
process.exit(failed ? 1 : 0);
