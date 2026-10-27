/**
 * permissions.test.mjs — 首次引导清单的契约。
 *
 * 这张清单直接决定"用户第一次打开要点几下"。写错了会出现两种坏结果：
 *   ① 明明没开却不提示 → 用户以为提醒坏了；
 *   ② 系统根本不支持（比如 Android 13 没有"精确闹钟"概念之外的东西）却提示 → 白折腾。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTIFY_MANUAL_ITEMS,
  REQUIRED_KEYS,
  requiredPending,
  buildSteps,
  landingGuideText,
  pendingCount,
  shouldOnboard
} from '../src/permissions.js';

const base = {
  sdk: 34,
  notify: 'default',
  batteryExempt: false,
  exactAlarm: false,
  promoted: null
};

test('Android 14 未授权：通知 / 精确闹钟 / 电池优化三项待办', () => {
  const steps = buildSteps(base);
  const keys = steps.filter((s) => s.kind === 'check').map((s) => s.key);
  assert.deepEqual(keys, ['notify', 'exactAlarm', 'battery']);
  assert.equal(pendingCount(steps), 3);
});

test('全部开启后待办归零，且不再显示"去开启"按钮', () => {
  const steps = buildSteps({ ...base, notify: 'granted', batteryExempt: true, exactAlarm: true });
  assert.equal(pendingCount(steps), 0);
  for (const s of steps.filter((x) => x.kind === 'check')) {
    assert.equal(s.ok, true);
  }
});

test('Android 12 以下没有"精确闹钟"这一项', () => {
  const steps = buildSteps({ ...base, sdk: 30 });
  assert.ok(!steps.some((s) => s.key === 'exactAlarm'));
});

test('Android 13 以下不需要通知运行时权限（仍给出确认项，但状态由原生决定）', () => {
  const steps = buildSteps({ ...base, sdk: 30, notify: 'granted' });
  const notify = steps.find((s) => s.key === 'notify');
  assert.equal(notify.ok, true);
});

test('流体云不再单独成项：已合并进「通知权限」', () => {
  const steps = buildSteps({ ...base, sdk: 36, promoted: false });
  assert.equal(
    steps.some((s) => s.key === 'promoted'),
    false,
    '流体云不该再单独占一行（会和通知权限看着像重复项）'
  );
  // 但通知那一项要说明"胶囊也走这条通知"
  const notify = steps.find((s) => s.key === 'notify');
  assert.match(notify.desc, /胶囊/, '通知项要说清课前胶囊也归它管');
});

test('任何快照下都不会再有独立的流体云项', () => {
  for (const promoted of [null, true, false]) {
    const steps = buildSteps({ ...base, sdk: 36, promoted });
    assert.equal(steps.some((s) => s.key === 'promoted'), false, `promoted=${promoted} 时仍冒出一行`);
  }
});

test('厂商自启动是"说明"项：永远不计入待办', () => {
  const steps = buildSteps(base);
  const auto = steps.find((s) => s.key === 'autostart');
  assert.equal(auto.kind, 'info');
  assert.equal(auto.ok, true);
  assert.equal(pendingCount([auto]), 0);
});

test('每一项都必须有标题和"不开会怎样"的说明', () => {
  for (const s of buildSteps({ ...base, sdk: 36, promoted: false })) {
    assert.ok(s.title.length >= 2, `${s.key} 缺标题`);
    assert.ok(s.desc.length >= 8, `${s.key} 缺说明`);
    if (s.kind === 'check') assert.ok(s.action && s.cta, `${s.key} 缺按钮`);
  }
});

test('shouldOnboard：只在原生 + 没做过 + 有快照时弹', () => {
  assert.equal(shouldOnboard({ native: true, done: false, snapshot: base }), true);
  assert.equal(shouldOnboard({ native: false, done: false, snapshot: base }), false);
  assert.equal(shouldOnboard({ native: true, done: true, snapshot: base }), false);
  assert.equal(shouldOnboard({ native: true, done: false, snapshot: null }), false);
});

test('快照缺字段也不能崩（老原生 / 读失败）', () => {
  const steps = buildSteps({});
  assert.ok(steps.length >= 2);
  assert.ok(typeof pendingCount(steps) === 'number');
  assert.equal(buildSteps(null).length >= 2, true);
});

test('电池项带"App 内先问"的确认框标记', () => {
  const steps = buildSteps({ ...base, sdk: 36, promoted: false });
  const battery = steps.find((s) => s.key === 'battery');
  assert.equal(battery.dialog, 'battery');
});

test('厂商那层读不到：用户确认过就视为已开启', () => {
  const snapshot = { ...base, batteryExempt: false };
  assert.equal(buildSteps(snapshot).find((s) => s.key === 'battery').ok, false);
  assert.equal(
    buildSteps(snapshot, { batteryConfirmed: true }).find((s) => s.key === 'battery').ok,
    true
  );
  // 全部确认后待办归零
  const allOk = { ...base, notify: 'granted', exactAlarm: true, batteryExempt: false };
  assert.equal(pendingCount(buildSteps(allOk, { batteryConfirmed: true })), 0);
});

test('「开启通知」清单必须覆盖：允许通知 / 静默通知 / 锁屏 / 横幅', () => {
  const keys = NOTIFY_MANUAL_ITEMS.map((x) => x.key);
  assert.deepEqual(keys, ['allow', 'silent', 'lockscreen', 'banner']);
  for (const it of NOTIFY_MANUAL_ITEMS) {
    assert.ok(it.title && it.where && it.why, `${it.key} 必须写清"开什么/在哪开/为什么"`);
  }
  // 真机踩过：渠道页开关是灰的、点不动 → 顶端那项必须解释原因
  assert.match(NOTIFY_MANUAL_ITEMS[0].why, /灰/, '「允许通知」要说明灰掉时怎么办');
});

test('落地提示要能区分"在列表页/在渠道页/没跳成"', () => {
  assert.match(landingGuideText('list'), /点一下/);
  assert.match(landingGuideText('channel'), /渠道/);
  // 目标路径已统一为「设置 → 应用 → 北邮课程表 → 权限管理 → 通知」
  assert.match(landingGuideText('detail'), /权限管理 › 通知/);
  assert.match(landingGuideText('none'), /权限管理 › 通知/);
  assert.match(landingGuideText('perm'), /权限管理/);
  assert.match(landingGuideText('notify'), /通知」权限页/);
});

test('必开项：通知/精确闹钟/后台运行；流体云不算（系统可能不给）', () => {
  assert.deepEqual(REQUIRED_KEYS, ['notify', 'exactAlarm', 'battery']);
  const steps = buildSteps({ sdk: 36, notify: 'default', batteryExempt: false, exactAlarm: false, promoted: false });
  const missing = requiredPending(steps).map((s) => s.key);
  assert.deepEqual(missing, ['notify', 'exactAlarm', 'battery']);
  assert.ok(!missing.includes('promoted'), '流体云不再是独立项，不该出现在必开里');
});

test('必开项全开 → 允许继续（流体云已合并，不再单独计数）', () => {
  const steps = buildSteps({ sdk: 36, notify: 'granted', batteryExempt: true, exactAlarm: true, promoted: false });
  assert.equal(requiredPending(steps).length, 0);
  // 流体云不再单独成项，所以待办就是 0
  assert.equal(pendingCount(steps), 0);
});

test('电池项用户确认过也算满足', () => {
  const steps = buildSteps({ sdk: 34, notify: 'granted', batteryExempt: false, exactAlarm: true }, { batteryConfirmed: true });
  assert.equal(requiredPending(steps).length, 0);
});

/* ---------------- 1.66.4：不再做检测，清单必须和真实落点对得上 ----------------
 *
 * 背景：跳过去是「上课提醒」渠道页，而清单里原来写着「流体云」——
 * 那一页根本没有这一项，用户照着找只会找不到。测试钉死"清单 = 那一页的控件"。
 */

test('通知清单必须和渠道页上真实存在的开关一一对应', () => {
  const keys = NOTIFY_MANUAL_ITEMS.map((x) => x.key);
  assert.deepEqual(keys, ['allow', 'silent', 'lockscreen', 'banner'], '渠道页从上到下就是这四项');
  // 渠道页没有"流体云"，不许再列
  assert.equal(
    NOTIFY_MANUAL_ITEMS.some((x) => /流体云/.test(x.title)),
    false,
    '渠道页没有流体云开关，列出来用户找不到'
  );
  // 静默通知开着 = 不响不弹，必须提示关闭
  const silent = NOTIFY_MANUAL_ITEMS.find((x) => x.key === 'silent');
  assert.match(silent.title, /关闭/);
});

test('每一项都要说清"在哪一页的什么位置"', () => {
  for (const it of NOTIFY_MANUAL_ITEMS) {
    assert.ok(it.title.length >= 2, `${it.key} 缺标题`);
    assert.ok(it.where.length >= 2, `${it.key} 缺位置说明`);
    assert.ok(it.why.length >= 4, `${it.key} 缺"不开会怎样"`);
  }
});
