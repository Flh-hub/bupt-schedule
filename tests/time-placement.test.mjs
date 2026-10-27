/**
 * time-placement.test.mjs — 活动按「具体时间」在课表格子里的定位。
 *
 * 规则（对应 UI 里的表现）：
 *  - 每一节在表格里占 **1 个等高行**，所以节内位移 = (t - 本节开始) / 本节时长；
 *  - 节与节之间的空档（午休）没有像素，压成 0 高度 —— 12:00 与 11:30 落在同一条线上；
 *  - 位置 **不按"第几节"取整**：08:20 与 08:40 都在第 1 节里，但一个偏上、一个偏下。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PERIODS,
  periodRangeForTime,
  timePlacement,
  timeToRowUnits
} from '../src/model.js';

const P = DEFAULT_PERIODS;

const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${msg}: 期望 ${expected}，实际 ${actual}`);

test('行坐标：每节占 1 行，节内按时间线性插值', () => {
  near(timeToRowUnits(P, '08:00'), 0, '第 1 节开始 = 0');
  near(timeToRowUnits(P, '08:45'), 1, '第 1 节结束 = 1');
  near(timeToRowUnits(P, '08:20'), 20 / 45, '第 1 节内 20 分钟');
  near(timeToRowUnits(P, '09:00'), 1 + 10 / 45, '第 2 节内 10 分钟');
  near(timeToRowUnits(P, '09:55'), 2, '第 3 节开始 = 2');
});

test('行坐标：节次之间的空档压成 0 高度（午休不占像素）', () => {
  // 第 4 节 11:30 结束、第 5 节 13:30 开始 —— 12:00 与 11:30 必须是同一条线
  near(timeToRowUnits(P, '11:30'), 4, '第 4 节底部');
  near(timeToRowUnits(P, '12:00'), 4, '午休贴在第 4 节底部');
  near(timeToRowUnits(P, '13:29'), 4, '第 5 节开始前仍贴底部');
  near(timeToRowUnits(P, '13:30'), 4, '第 5 节开始 = 4');
});

test('行坐标：非法输入与越界', () => {
  assert.equal(timeToRowUnits(P, ''), null);
  assert.equal(timeToRowUnits(P, '8:00'), null, '单位数小时不算合法 HH:mm');
  assert.equal(timeToRowUnits([], '08:00'), null, '没有节次表就定位不了');
  // 晚于最后一节 → 按最后一节的「分钟→行」比例继续外推。
  // （以前一律返回节数，导致 21:00 和 23:00 都落在表格底，超出最后一节课的活动画不出来）
  const bottom = timeToRowUnits(P, '23:59');
  assert.ok(bottom > P.length, `晚于最后一节必须外推，实际 ${bottom}`);
  // 正好压在最后一节结束时，仍然是"表格底部"
  assert.equal(timeToRowUnits(P, P[P.length - 1].end), P.length);
});

test('几何位置：活动晚于最后一节课，必须算得出可用的高度', () => {
  const last = P[P.length - 1];
  const g = timePlacement(P, last.end, '23:30');
  assert.ok(g, '不能返回 null');
  assert.equal(g.rowIndex, P.length, '起点落在最后一节的下一条线上');
  near(g.offset, 0, '正好接在最后一节底部');
  assert.ok(g.height > 0.5, `高度要按真实时长算，实际 ${g.height}`);
  assert.ok(g.rowIndex + g.height > P.length, '下沿必须越过原有行数，交给隐式行接住');
});

test('时间 → 节次：开始归下一节、结束归上一节', () => {
  assert.deepEqual(periodRangeForTime(P, '08:20', '09:00'), { startPeriod: 1, endPeriod: 2 });
  assert.deepEqual(periodRangeForTime(P, '08:00', '08:45'), { startPeriod: 1, endPeriod: 1 });
  // 跨午休：开始 11:00（第 4 节内）、结束 14:00（第 5 节内）
  assert.deepEqual(periodRangeForTime(P, '11:00', '14:00'), { startPeriod: 4, endPeriod: 5 });
  // 整段落在午休里 → 归到下一节（那一格是离它最近的画得出来的位置）
  assert.deepEqual(periodRangeForTime(P, '12:00', '12:30'), { startPeriod: 5, endPeriod: 5 });
});

test('时间 → 节次：非法区间返回 null', () => {
  assert.equal(periodRangeForTime(P, '10:00', '10:00'), null, '起止相同');
  assert.equal(periodRangeForTime(P, '10:00', '09:00'), null, '结束早于开始');
  assert.equal(periodRangeForTime(P, '25:00', '26:00'), null);
});

test('几何位置：整节对齐时间 → 行内偏移 0、高度 1', () => {
  const g = timePlacement(P, '08:00', '08:45');
  assert.equal(g.rowIndex, 0);
  near(g.offset, 0, 'offset');
  near(g.height, 1, 'height');
});

test('几何位置：半格起点按比例下移，高度按时间跨度算', () => {
  const g = timePlacement(P, '08:20', '09:00');
  assert.equal(g.rowIndex, 0, '起点在第 1 节那一行');
  near(g.offset, 20 / 45, '行内偏移 = 20/45');
  near(g.height, 1 + 10 / 45 - 20 / 45, '高度 = 09:00 的行坐标 - 08:20 的行坐标');
});

test('几何位置：跨节次的活动能跨过行边界', () => {
  const g = timePlacement(P, '09:30', '10:10');
  assert.equal(g.rowIndex, 1);
  near(g.offset, 40 / 45, '第 2 节内 40 分钟');
  // 10:10 在第 3 节（09:55 开始）里，行坐标 = 2 + 15/45
  near(g.height, 2 + 15 / 45 - (1 + 40 / 45), '跨行高度');
});

test('几何位置：极端输入不返回半截数据', () => {
  assert.equal(timePlacement(P, '09:00', '09:00'), null);
  assert.equal(timePlacement(P, '', '09:00'), null);
  assert.equal(timePlacement([], '08:20', '09:00'), null);
  // 早于第 1 节开始：贴顶显示，不出现负偏移
  const early = timePlacement(P, '07:00', '08:45');
  assert.equal(early.rowIndex, 0);
  near(early.offset, 0, '负偏移被夹到 0');
});
