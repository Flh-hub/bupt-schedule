/**
 * .probe-nowline.mjs — 两件事：
 *  ① 红线在「活动把网格延长」时要能走进延长区，没有延长时停在表格底；
 *  ② 删掉那条活动后，延长行必须一起消失（不能留一排空刻度）。
 */
import fs from 'node:fs';

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
  ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.Element = window.Element;
globalThis.Node = window.Node;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });

const { sampleState } = await import('./src/ui/components.js');
const { renderTimetable } = await import('./src/ui/timetable.js');
const { addDays, dayOfWeekOf, todayStr, DEFAULT_PERIODS } = await import('./src/model.js');
const { getNowMarker } = await import('./src/calendar.js');

const checks = [];
const check = (n, p, extra = '') => checks.push({ n, p, extra });

const today = todayStr();
const monday = addDays(today, 1 - dayOfWeekOf(today));
const event = {
  id: 'a_evt',
  date: monday,
  type: 'event',
  title: '组会',
  location: '教三-101',
  startTime: '19:20',
  endTime: '23:10',
  note: '',
  createdAt: '2026-01-01T00:00:00+08:00'
};

// 让"现在"落在 22:30（延长区里）
const now = new Date(`${today}T22:30:00+08:00`).getTime();

const state = sampleState();
const view = document.getElementById('view');

/* ① 有活动 */
state.adjustments = [event];
renderTimetable(view, state, { weekOffset: 0, viewMode: 'week', stateRef: state, nowRef: now });
const extWith = view.querySelectorAll('.tt-time.is-extended').length;
const markerWith = getNowMarker(state, now, DEFAULT_PERIODS.length + extWith);
const lineWith = view.querySelector('.now-line');
const lineRowWith = lineWith ? Number((lineWith.getAttribute('style') || '').match(/grid-row:(\d+)/)?.[1]) : -1;

check('有活动时有延长行', extWith > 0, `extended=${extWith}`);
check('红线走进了延长区（rowIndex ≥ 节数）', markerWith.rowIndex >= DEFAULT_PERIODS.length, `rowIndex=${markerWith.rowIndex}, 节数=${DEFAULT_PERIODS.length}`);
check('红线 DOM 落在延长行里', lineRowWith > DEFAULT_PERIODS.length + 1, `grid-row=${lineRowWith}`);

/* ② 删掉活动 */
state.adjustments = [];
renderTimetable(view, state, { weekOffset: 0, viewMode: 'week', stateRef: state, nowRef: now });
const extWithout = view.querySelectorAll('.tt-time.is-extended').length;
const markerWithout = getNowMarker(state, now);
const lineWithout = view.querySelector('.now-line');
const lineRowWithout = lineWithout ? Number((lineWithout.getAttribute('style') || '').match(/grid-row:(\d+)/)?.[1]) : -1;

check('删活动后延长行消失', extWithout === 0, `extended=${extWithout}`);
check('没有延长时红线停在表格底部（不悬空）', markerWithout.rowIndex <= DEFAULT_PERIODS.length, `rowIndex=${markerWithout.rowIndex}`);
check('红线 DOM 不超出原网格', lineRowWithout <= DEFAULT_PERIODS.length + 1, `grid-row=${lineRowWithout}`);
check('网格高度回到原状', (() => {
  const grids = view.querySelectorAll('.tt-grid');
  return grids.length === 1;
})(), '应只有一个网格');

let pass = 0;
for (const c of checks) {
  console.log(`${c.p ? 'ok  ' : 'FAIL'} ${c.n}${c.p ? '' : `  → ${c.extra}`}`);
  if (c.p) pass += 1;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
