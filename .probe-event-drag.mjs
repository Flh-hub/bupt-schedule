/**
 * .probe-event-drag.mjs — 两个新功能走一遍 jsdom 全流程：
 *   ① 空白格 → 添加「活动 / 会议」（不是课程）；
 *   ② 长按课程块 → 拖到本周其他时段，只改这一天。
 * 只是开发期探针，不参与交付门禁（依赖托管 node_modules 里的 jsdom）。
 *
 *   NODE_PATH=.../node_modules node .probe-event-drag.mjs
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

const C = await import('./src/calendar.js');
const { addDays } = await import('./src/model.js');
const app = window.__buptApp;
const doc = window.document;
const sheetHost = doc.getElementById('sheet-host');

const checks = [];
const ok = (name, value) => checks.push([name, !!value]);
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

/** jsdom 不做布局，elementFromPoint 恒为 null：由用例指定"此刻手指下面是哪个格子"。 */
let hitElement = null;
doc.elementFromPoint = () => hitElement;

/** 造一个只有指针必要字段的事件（jsdom 没有 PointerEvent）。 */
function pointerEvent(type, x, y) {
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  return ev;
}

const state = () => app.store.getState();
const adjOf = (fn) => state().adjustments.filter(fn);

/* ============================ ① 添加自定义活动 ============================ */

// 取"当前显示那一周"的周五：写死日期过一周就会掉出视野，探针会假失败
const weekMonday = doc.querySelector('.tt-slot')?.dataset.date;
const today = weekMonday ? addDays(weekMonday, 4) : '2026-10-30';
const maxIdx = Math.max(...state().settings.periods.map((p) => p.index));
// 找一个当天空着的格子放活动，免得和课程合并成一个块
const busy = new Set(C.resolveDay(state(), today).classes.map((c) => c.startPeriod));
let freeStart = 1;
while (busy.has(freeStart) && freeStart < maxIdx) freeStart += 1;
const freeEnd = Math.min(freeStart + 1, maxIdx);

app.openSlotSheet(today, freeStart);
await wait(60);

ok('弹层打开后默认是「补课」', !doc.querySelector('[data-slot-group="makeup"]').hidden);
ok('「活动」栏默认收着', doc.querySelector('[data-slot-group="event"]').hidden);

click(doc.querySelector('[data-action="slot-mode"][data-value="event"]'));
await wait(40);
ok('切到「活动」后显示名称输入', !doc.querySelector('[data-slot-group="event"]').hidden);
ok('切到「活动」后藏起课程选择', doc.querySelector('[data-slot-group="makeup"]').hidden);
ok(
  '提交按钮改成「添加活动」',
  sheetHost.querySelector('button[type="submit"]').textContent.trim() === '添加活动'
);

// 不填名字直接提交 → 应被拦住
sheetHost.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(40);
ok('空名字不让提交', adjOf((a) => a.type === 'event').length === 0);

doc.getElementById('slot-title').value = '班会';
doc.getElementById('slot-loc').value = '教三-101';
// ★ 活动改成「具体时间」录入：节次由时间反推（这里用整节的起止，反推结果应等于原节次）
const pStart = state().settings.periods.find((p) => Number(p.index) === freeStart);
const pEnd = state().settings.periods.find((p) => Number(p.index) === freeEnd);
ok('活动表单有开始/结束时间输入', !!doc.getElementById('ev-start') && !!doc.getElementById('ev-end'));
ok('默认时间就是点开那一格的起止', doc.getElementById('ev-start').value === pStart.start);
doc.getElementById('ev-start').value = pStart.start;
doc.getElementById('ev-end').value = pEnd.end;
sheetHost.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(60);

const events = adjOf((a) => a.type === 'event');
ok('活动已写进 adjustments', events.length === 1);
ok('活动带名称', events[0] && events[0].title === '班会');
ok('活动没有挂课程', events[0] && events[0].courseId === null);
ok(`活动节次 ${freeStart}-${freeEnd}`, events[0] && events[0].startPeriod === freeStart && events[0].endPeriod === freeEnd);
ok('活动地点存下来了', events[0] && events[0].location === '教三-101');
ok('活动存了具体时间', events[0] && events[0].startTime === pStart.start && events[0].endTime === pEnd.end);
ok('提交后弹层已关闭', !sheetHost.classList.contains('is-open'));

// 日历投影：活动要当成一节课出现在那天
const dayWithEvent = C.resolveDay(state(), today);
const eventClass = dayWithEvent.classes.find((c) => c.isEvent);
ok('日历里能看到这条活动', !!eventClass);
ok('活动的展示名就是标题', eventClass && eventClass.courseName === '班会');
ok('活动时间由节次解析出来', eventClass && eventClass.startTime && eventClass.endTime);
ok('活动不影响"这一天有几节课"以外的天', C.resolveDay(state(), addDays(today, 1)).classes.every((c) => !c.isEvent));

// 渲染：出现虚线活动块
app.render();
await wait(60);
const eventBlock = doc.querySelector('.tt-block.is-event');
ok('课表里渲染出活动块', !!eventBlock);
ok('活动块点开是活动详情', eventBlock && eventBlock.dataset.action === 'open-event');

// 打开详情 → 删除
click(eventBlock);
await wait(60);
ok('活动详情弹层打开', sheetHost.classList.contains('is-open'));
ok('详情里有名称', sheetHost.textContent.includes('班会'));
click(sheetHost.querySelector('[data-action="event-delete"]'));
await wait(60);
ok('删除后活动记录消失', adjOf((a) => a.type === 'event').length === 0);

/* ============================ ② 拖动改时段（同一天） ============================ */

app.render();
await wait(60);

const maxIndex = Math.max(...state().settings.periods.map((p) => p.index));
const blocks = [...doc.querySelectorAll('.tt-block[data-drag="1"]')];
ok('课表块带上了拖动上下文', blocks.length > 0);

/* jsdom 不做布局，getBoundingClientRect 全是 0，量不出"影子有几格高"。
   这里按「一节 50px、一列 60px」造一份假布局，才能验证影子/落点的格数。 */
const CELL_H = 50;
const CELL_W = 60;
const dayIndex = new Map();
for (const s of doc.querySelectorAll('.tt-slot')) {
  if (!dayIndex.has(s.dataset.date)) dayIndex.set(s.dataset.date, dayIndex.size);
}
function fakeRect(el) {
  const first = Number(el.dataset?.period || el.dataset?.gs || 1);
  const last = Number(el.dataset?.period || el.dataset?.ge || first);
  const cells = Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first + 1 : 1;
  const top = (first - 1) * CELL_H;
  const left = (dayIndex.get(el.dataset?.date) || 0) * CELL_W;
  return { left, top, width: CELL_W, height: cells * CELL_H, right: left + CELL_W, bottom: top + cells * CELL_H };
}
window.Element.prototype.getBoundingClientRect = function () {
  return fakeRect(this);
};

// 挑一个"干净"的块（没被调整过），且往后挪 2 节不会越过最后一节。
// 优先挑连堂课：这一路要验证"落点按格数铺开"，单节块看不出差别。
const draggable = blocks.filter((b) => !b.dataset.dtype && Number(b.dataset.ge) + 2 <= maxIndex);
const pick = draggable.find((b) => Number(b.dataset.ge) > Number(b.dataset.gs)) || draggable[0];
ok('找到一个可拖的课程块', !!pick);
ok('挑到的是连堂课（才能验证按格数铺开）', Number(pick.dataset.ge) > Number(pick.dataset.gs));
const srcDate = pick.dataset.date;
const srcStart = Number(pick.dataset.gs);
const srcEnd = Number(pick.dataset.ge);
const srcSession = pick.dataset.sid;
const srcName = pick.dataset.dname;
const targetPeriod = srcStart + 2;

const nextWeek = C.resolveDay(state(), addDays(srcDate, 7)); // 同一天在下一周的样子（应是原样）
const nextWeekSame = nextWeek.classes.filter((c) => c.sessionId === srcSession)[0];

const targetSlot = doc.querySelector(`.tt-slot[data-date="${srcDate}"][data-period="${targetPeriod}"]`);
ok('目标格子存在', !!targetSlot);

pick.dispatchEvent(pointerEvent('pointerdown', 100, 100));
await wait(300); // 等过长按阈值
hitElement = targetSlot;
doc.body.dispatchEvent(pointerEvent('pointermove', 120, 240));
await wait(30);
// 重绘会换掉格子元素，所以查「此刻有没有高亮」，而不是盯住某个节点
const liveTarget = doc.querySelector('.tt-slot.is-drop-target');
ok(
  '拖动时目标格高亮',
  !!liveTarget &&
    liveTarget.dataset.date === srcDate &&
    Number(liveTarget.dataset.period) === targetPeriod
);

// 落点必须按课程原本的格数铺开（早期只亮一格，连堂课看起来像"落地后只剩一节"）
{
  const span = srcEnd - srcStart + 1;
  const lit = [...doc.querySelectorAll('.tt-slot.is-drop-target')];
  ok(`落点铺开了 ${span} 格（连堂课不是只亮一格）`, lit.length === span);
  ok(
    '铺开的格子从落点开始逐格连续',
    lit.every(
      (s, i) => s.dataset.date === srcDate && Number(s.dataset.period) === targetPeriod + i
    )
  );
  ok(
    '首尾格带圆角标记（连起来是一个整块）',
    lit[0].classList.contains('is-drop-first') &&
      lit[lit.length - 1].classList.contains('is-drop-last')
  );

  const ghost = doc.querySelector('.drag-ghost');
  ok('拖动时有跟手影子', !!ghost);
  ok(
    '影子的副行写着真实节次范围',
    !!ghost && ghost.querySelector('.dg-meta')?.textContent === `${srcStart}-${srcEnd} 节`
  );
  ok(
    '影子高度 = 课程原本的格数 × 单格高度（不是固定一格高）',
    !!ghost && parseFloat(ghost.style.height) === span * CELL_H
  );
  ok(
    '影子贴着落点左上角',
    !!ghost &&
      parseFloat(ghost.style.left) === (dayIndex.get(srcDate) || 0) * CELL_W &&
      parseFloat(ghost.style.top) === (targetPeriod - 1) * CELL_H
  );
}
doc.body.dispatchEvent(pointerEvent('pointerup', 120, 240));
await wait(80);

const moved = adjOf((a) => a.type === 'reschedule' && a.targetSessionId === srcSession && a.date === srcDate);
ok('生成了一条「改时间」记录', moved.length === 1);
ok('新节次 = 落点', moved[0] && moved[0].startPeriod === targetPeriod);
ok('连堂长度保持不变', moved[0] && moved[0].endPeriod === targetPeriod + (srcEnd - srcStart));

const dayAfter = C.resolveDay(state(), srcDate);
const movedClass = dayAfter.classes.find((c) => c.sessionId === srcSession);
ok('当天投影挪到了新节次', movedClass && movedClass.startPeriod === targetPeriod);
ok('当天被标记为「已调课」', movedClass && movedClass.adjustmentType === 'reschedule');

const nextWeekAfter = C.resolveDay(state(), addDays(srcDate, 7));
const stillThere = nextWeekAfter.classes.find((c) => c.sessionId === srcSession);
ok(
  '下一周同一门课没被动（仍在原节次）',
  nextWeekSame && stillThere && stillThere.startPeriod === nextWeekSame.startPeriod
);

await wait(400); // 等过「拖完吃掉一次 click」的保护窗口
// 撤销：点提示条上的撤销
const undoBtn = doc.querySelector('#snackbar-host [data-action="snackbar-undo"]');
ok('移动后给了撤销入口', !!undoBtn);
click(undoBtn);
await wait(60);
ok('撤销后「改时间」记录被移除', adjOf((a) => a.type === 'reschedule' && a.date === srcDate).length === 0);
ok(
  '撤销后回到原节次',
  (C.resolveDay(state(), srcDate).classes.find((c) => c.sessionId === srcSession) || {}).startPeriod === srcStart
);

/* ============================ ③ 拖动到另一天 ============================ */

app.render();
await wait(60);
const blocks2 = [...doc.querySelectorAll('.tt-block[data-drag="1"]')];
const pick2 = blocks2.find((b) => !b.dataset.dtype && b.dataset.date !== '2026-10-25');
ok('为跨天拖动找到源块', !!pick2);
const s2 = {
  date: pick2.dataset.date,
  start: Number(pick2.dataset.gs),
  session: pick2.dataset.sid
};
// 目标日期落在同一周内（+2 天，碰到周日就回退两天）——写死日期过一周就失效
const toDate = addDays(s2.date, s2.date === addDays(weekMonday, 6) ? -2 : 2);
// 示例数据本身那天可能已有补课，所以要比「拖之前有几条」，不能直接数 == 0
const makeupBefore = adjOf((a) => a.type === 'makeup' && a.date === toDate).length;

pick2.dispatchEvent(pointerEvent('pointerdown', 100, 100));
await wait(300);
hitElement = doc.querySelector(`.tt-slot[data-date="${toDate}"][data-period="5"]`);
doc.body.dispatchEvent(pointerEvent('pointermove', 200, 300));
await wait(30);
doc.body.dispatchEvent(pointerEvent('pointerup', 200, 300));
await wait(80);

ok('原日期生成了「停课」', adjOf((a) => a.type === 'cancel' && a.date === s2.date && a.targetSessionId === s2.session).length === 1);
ok('目标日期生成了「补课」', adjOf((a) => a.type === 'makeup' && a.date === toDate && a.startPeriod === 5).length === 1);
ok('原日期这节已经不在投影里', !C.resolveDay(state(), s2.date).classes.some((c) => c.sessionId === s2.session));
ok('目标日期能看到它', C.resolveDay(state(), toDate).classes.some((c) => c.adjustmentType === 'makeup' && c.startPeriod === 5));

await wait(400); // 同上，拖完 300ms 内会吃掉一次 click
// 撤掉，别影响后面的检查
const undo2 = doc.querySelector('#snackbar-host [data-action="snackbar-undo"]');
click(undo2);
await wait(60);
ok('跨天移动也能一键撤销', adjOf((a) => a.type === 'makeup' && a.date === toDate).length === makeupBefore);

/* ============================ ④ 边界 ============================ */

app.render();
await wait(60);
// 连堂块拖到最后一节 → 结束节次必然越界，应该被拒绝且不留半条记录
const tail = [...doc.querySelectorAll('.tt-block[data-drag="1"]')].find(
  (b) => !b.dataset.dtype && Number(b.dataset.ge) > Number(b.dataset.gs)
);
if (tail) {
  const before = state().adjustments.length;
  tail.dispatchEvent(pointerEvent('pointerdown', 100, 100));
  await wait(300);
  hitElement = doc.querySelector(`.tt-slot[data-date="${tail.dataset.date}"][data-period="${maxIndex}"]`);
  doc.body.dispatchEvent(pointerEvent('pointermove', 150, 320));
  await wait(30);
  doc.body.dispatchEvent(pointerEvent('pointerup', 150, 320));
  await wait(60);
  ok('连堂块拖到最后一节会被拒绝', state().adjustments.length === before);
} else {
  ok('（没有合适的边界块，跳过超出最后一节的用例）', true);
}

ok('没有 JS 报错', errors.length === 0);

let failed = 0;
for (const [name, pass] of checks) {
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
}
if (errors.length) console.log('errors:', errors);
console.log(`\nfailed=${failed}`);
process.exit(failed ? 1 : 0);
