import test from 'node:test';
import assert from 'node:assert/strict';

import { dayOfWeekOf } from '../src/model.js';
import {
  BUILTIN_2026,
  BUILTIN_2027_TENTATIVE,
  DATA_REVISION,
  OFFICIAL_SOURCE,
  auditBuiltinHolidays,
  buildHolidayIndex,
  effectiveDayOfWeek,
  getAllBuiltinHolidays,
  getBuiltinHolidays,
  getHoliday,
  getTentativeHolidays,
  listMakeupDays
} from '../src/holidays.js';

const builtin = getBuiltinHolidays();
const index = buildHolidayIndex([]);

test('内置数据自检通过（无重复日期 / 类型合法 / 日期格式合法 / 带 source+note+dataRevision）', () => {
  const audit = auditBuiltinHolidays();
  assert.deepEqual(audit.errors, []);
  assert.equal(audit.ok, true);
  for (const h of builtin) {
    assert.ok(h.source, `${h.date} 缺少 source`);
    assert.match(h.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['holiday', 'makeupWorkday'].includes(h.type));
    assert.equal(h.dataRevision, DATA_REVISION);
    assert.ok(h.note, `${h.date} 缺少 note`);
  }
});

test('G11：放假日 33 天、调休上班日 6 天', () => {
  assert.equal(builtin.length, 39);
  assert.equal(builtin.filter((h) => h.type === 'holiday').length, 33);
  assert.equal(builtin.filter((h) => h.type === 'makeupWorkday').length, 6);
  assert.equal(BUILTIN_2026.length, 39);
});

test('G11：仅 2026-01-04 有推定映射 5 且 inferred=true，其余 5 条一律 null', () => {
  const makeups = builtin.filter((h) => h.type === 'makeupWorkday');
  const jan4 = makeups.find((h) => h.date === '2026-01-04');
  assert.equal(jan4.followDayOfWeek, 5);
  assert.equal(jan4.inferred, true);

  const others = makeups.filter((h) => h.date !== '2026-01-04');
  assert.equal(others.length, 5);
  for (const h of others) {
    assert.equal(h.followDayOfWeek, null, `${h.date} 必须是未确认（null），不得猜`);
    assert.equal(h.inferred, false);
  }
  // 六个补班日的日期集合
  assert.deepEqual(
    makeups.map((h) => h.date).sort(),
    ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']
  );
});

test('放假日逐日核对（元旦 3 / 春节 9 / 清明 3 / 劳动 5 / 端午 3 / 中秋 3 / 国庆 7）', () => {
  const byName = new Map();
  for (const h of builtin.filter((x) => x.type === 'holiday')) {
    byName.set(h.name, (byName.get(h.name) || 0) + 1);
  }
  assert.equal(byName.get('元旦'), 3);
  assert.equal(byName.get('春节'), 9);
  assert.equal(byName.get('清明节'), 3);
  assert.equal(byName.get('劳动节'), 5);
  assert.equal(byName.get('端午节'), 3);
  assert.equal(byName.get('中秋节'), 3);
  assert.equal(byName.get('国庆节'), 7);
});

test('关键日期的真实星期（用 dayOfWeekOf 复算）', () => {
  assert.equal(dayOfWeekOf('2026-01-01'), 4); // 周四
  assert.equal(dayOfWeekOf('2026-01-04'), 7); // 周日补班
  assert.equal(dayOfWeekOf('2026-09-20'), 7); // 周日补班
  assert.equal(dayOfWeekOf('2026-10-10'), 6); // 周六补班
  assert.equal(dayOfWeekOf('2026-10-01'), 4); // 周四国庆
  assert.equal(dayOfWeekOf('2026-10-07'), 3);
});

test('2026-10-08 不是假期；10-11 也不是（补班是 10-10）', () => {
  assert.equal(getHoliday('2026-10-08', index), null);
  assert.equal(getHoliday('2026-10-11', index), null);
});

test("effectiveDayOfWeek 三态翻译：'none' → skip/null", () => {
  const r = effectiveDayOfWeek({ followDayOfWeek: 'none' }, 6, 'followWeekday');
  assert.deepEqual(r, { dow: null, kind: 'skip' });
});

test('effectiveDayOfWeek 三态翻译：1..7 + followWeekday → follow', () => {
  const r = effectiveDayOfWeek({ followDayOfWeek: 5 }, 7, 'followWeekday');
  assert.deepEqual(r, { dow: 5, kind: 'follow' });
});

test("effectiveDayOfWeek 三态翻译：1..7 + mode='skip' → skipWithHint（带 dow）", () => {
  const r = effectiveDayOfWeek({ followDayOfWeek: 5 }, 7, 'skip');
  assert.deepEqual(r, { dow: 5, kind: 'skipWithHint' });
});

test("effectiveDayOfWeek 三态翻译：null 在任何 mode 下都是 unconfirmed（不降级为 skip）", () => {
  assert.deepEqual(effectiveDayOfWeek({ followDayOfWeek: null }, 6, 'followWeekday'), {
    dow: null,
    kind: 'unconfirmed'
  });
  assert.deepEqual(effectiveDayOfWeek({ followDayOfWeek: null }, 6, 'skip'), {
    dow: null,
    kind: 'unconfirmed'
  });
});

test('listMakeupDays 返回 6 天并按日期升序', () => {
  const days = listMakeupDays([]);
  assert.equal(days.length, 6);
  assert.deepEqual(days.map((d) => d.date), [
    '2026-01-04',
    '2026-02-14',
    '2026-02-28',
    '2026-05-09',
    '2026-09-20',
    '2026-10-10'
  ]);
});

test('listMakeupDays 合并用户覆盖（写入 none 后立即反映）', () => {
  const days = listMakeupDays([
    { date: '2026-10-10', name: '国庆调休上班', type: 'makeupWorkday', followDayOfWeek: 'none', source: 'manual' }
  ]);
  const entry = days.find((d) => d.date === '2026-10-10');
  assert.equal(entry.followDayOfWeek, 'none');
  assert.equal(entry.source, 'manual');
  // 其他 5 天不受影响
  assert.equal(days.filter((d) => d.followDayOfWeek == null).length, 4);
});

test('用户同日覆盖内置（放假改校庆日）', () => {
  const idx = buildHolidayIndex([
    { date: '2026-10-01', name: '校庆日', type: 'holiday', source: 'manual', note: '全校停课' }
  ]);
  assert.equal(getHoliday('2026-10-01', idx).name, '校庆日');
  assert.equal(getHoliday('2026-10-01', idx).source, 'manual');
});

test('2027 元旦为 tentative 预留，且单独成表、不计入 BUILTIN_2026', () => {
  assert.equal(BUILTIN_2027_TENTATIVE.length, 3);
  const t = getTentativeHolidays();
  assert.equal(t.length, 3);
  assert.ok(t.every((h) => h.tentative === true));
  assert.match(t[0].note, /2027/);
  // 索引里仍可查到（参与判定）
  const h = getHoliday('2027-01-01', index);
  assert.ok(h);
  assert.equal(h.tentative, true);
});

test('getAllBuiltinHolidays 含 2027 预留共 42 条', () => {
  assert.equal(getAllBuiltinHolidays().length, 42);
});

test('OFFICIAL_SOURCE / DATA_REVISION 可用于 UI 展示与日后核对', () => {
  assert.match(OFFICIAL_SOURCE, /国务院办公厅/);
  assert.match(OFFICIAL_SOURCE, /2026/);
  assert.equal(DATA_REVISION, 'gb-2025-11-04');
});

test('内置数据不含中国法定假期以外的误录（抽查若干普通日为空）', () => {
  for (const date of ['2026-03-05', '2026-06-10', '2026-11-11', '2026-12-25']) {
    assert.equal(getHoliday(date, index), null, `${date} 不应是节假日`);
  }
});
