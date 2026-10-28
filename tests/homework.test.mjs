/**
 * homework.test.mjs — 「查看作业」数据层的契约。
 *
 * 重点守两件容易出错的事：
 *   ① `endTime` 是 `"2026-12-31 23:59:59"` 这种**非标准**时间串，必须按本地时区解析；
 *   ② 列表必须按截止时间升序 —— 待办列表的价值就在"哪个先到期"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDue,
  normalizeList,
  normalizeDetail,
  daysLeft,
  dueLabel,
  isUrgent,
  sanitizeHtml,
  pickCourseName
} from '../src/homework.js';

const NOW = new Date(2026, 9, 28, 14, 0, 0).getTime(); // 2026-10-28 14:00 本地

test('parseDue：学校的时间串按本地时区解析，非法串返回 0', () => {
  assert.equal(parseDue('2026-12-31 23:59:59'), new Date(2026, 11, 31, 23, 59, 59).getTime());
  assert.equal(parseDue('2026-12-31 23:59'), new Date(2026, 11, 31, 23, 59, 0).getTime());
  assert.equal(parseDue('2026-12-31'), new Date(2026, 11, 31, 0, 0, 0).getTime());

  for (const bad of ['', null, undefined, '待定', '2026/12/31', '2026-13-01 00:00:00']) {
    assert.equal(parseDue(bad), 0, `应当拒绝：${String(bad)}`);
  }
});

test('normalizeList：按截止时间升序，没截止的排最后，空行丢掉', () => {
  const payload = {
    siteNum: 12,
    undoneNum: 5,
    undoneList: [
      { activityId: 'c', activityName: '第三次', endTime: '2026-12-05 23:59:59', type: 3 },
      { activityId: 'a', activityName: '第二次', endTime: '2026-10-31 23:59:59', type: 3 },
      { activityId: 'x', activityName: '没有截止的', endTime: '', type: 3 },
      { activityId: '', activityName: '没有 id 的', endTime: '2026-11-01 00:00:00' },
      { activityId: 'b', activityName: '第五次', endTime: '2026-11-02 23:59:59', type: 3 }
    ]
  };
  const out = normalizeList(payload);
  assert.equal(out.total, 12);
  assert.equal(out.undone, 5);
  assert.deepEqual(out.items.map((i) => i.id), ['a', 'b', 'c', 'x'], '顺序应为 10-31 → 11-02 → 12-05 → 无截止');
  assert.equal(out.items[3].dueMs, 0);
});

test('pickCourseName：不同接口版本把课程名放在不同字段，都要认出来', () => {
  // 列表接口实测是 siteName
  assert.equal(pickCourseName({ siteName: '高等数学' }), '高等数学');
  // 详情接口用 courseName
  assert.equal(pickCourseName({ courseName: '大学物理' }), '大学物理');
  // 有的版本塞进嵌套对象
  assert.equal(pickCourseName({ site: { name: '线性代数' } }), '线性代数');
  assert.equal(pickCourseName({ course: { courseName: '概率论' } }), '概率论');
  // 只有空白 / 什么都没有 → 空串，界面据此隐藏标签（不编造"未知课程"）
  assert.equal(pickCourseName({ siteName: '   ' }), '');
  assert.equal(pickCourseName({ site: null, course: '不是对象' }), '');
  assert.equal(pickCourseName(null), '');
});

test('normalizeList：课程名跟着条目走，取不到就是空串', () => {
  const out = normalizeList({
    undoneList: [
      { activityId: 'a', activityName: '第一章习题', endTime: '2026-11-01 23:59:59', siteName: '高等数学' },
      { activityId: 'b', activityName: '实验报告', endTime: '' }
    ]
  });
  assert.equal(out.items[0].courseName, '高等数学');
  assert.equal(out.items[1].courseName, '');
});

test('normalizeList：脏数据不许炸', () => {
  for (const bad of [null, undefined, {}, { undoneList: 'x' }, { undoneList: [null, 1, 'a'] }]) {
    const out = normalizeList(bad);
    assert.ok(Array.isArray(out.items));
    assert.equal(out.items.length, 0);
  }
});

test('dueLabel / daysLeft / isUrgent：7 天内才算紧急', () => {
  const in3 = { dueMs: NOW + 3 * 86400000 };
  const in10 = { dueMs: NOW + 10 * 86400000 };
  const past = { dueMs: NOW - 1000 };
  const none = { dueMs: 0 };

  assert.equal(daysLeft(in3.dueMs, NOW), 3);
  assert.equal(dueLabel(in3, NOW), '还剩 3 天');
  assert.equal(dueLabel(in10, NOW), '还剩 10 天');
  assert.equal(dueLabel(past, NOW), '已截止');
  assert.equal(dueLabel(none, NOW), '没有截止时间');

  assert.equal(isUrgent(in3, NOW), true);
  assert.equal(isUrgent(in10, NOW), false);
  assert.equal(isUrgent(past, NOW), false, '已截止不算紧急，那是另一档');
  assert.equal(isUrgent(none, NOW), false);
});

test('dueLabel：一天以内按小时说，不显示"0 天"', () => {
  const in5h = { dueMs: NOW + 5 * 3600000 };
  const in30m = { dueMs: NOW + 30 * 60000 };
  assert.equal(dueLabel(in5h, NOW), '还剩 5 小时');
  assert.equal(dueLabel(in30m, NOW), '不到 1 小时');
});

test('normalizeDetail：字段归一化 + 正文过滤', () => {
  const d = normalizeDetail({
    id: '2102008402823954434',
    assignmentTitle: '期末考核',
    assignmentContent: '<p>正文</p><script>alert(1)</script>',
    className: '[2026219101]班',
    assignmentBeginTime: '2026-09-21 20:20',
    assignmentEndTime: '2026-12-31 23:59:59',
    fullMark: 100,
    assignmentScore: -1,
    isOvertimeCommit: 1
  });
  assert.equal(d.id, '2102008402823954434');
  assert.equal(d.fullMark, 100);
  assert.equal(d.allowLate, true);
  assert.equal(d.dueMs, new Date(2026, 11, 31, 23, 59, 59).getTime());
  // node 环境没有 DOM，走"去标签"兜底：脚本标签不能以标签形式留下
  assert.equal(/<script/i.test(d.contentHtml), false, '脚本标签不许出现');
  assert.ok(d.contentHtml.includes('正文'));
});

test('sanitizeHtml：空值安全', () => {
  assert.equal(sanitizeHtml(''), '');
  assert.equal(sanitizeHtml(null), '');
  assert.equal(sanitizeHtml(undefined), '');
});
