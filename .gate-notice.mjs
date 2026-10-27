/**
 * .gate-notice.mjs — G14：NOTICE 键集合与值类型（运行时门禁）。
 * 退出码：0 PASS / 1 键集或值类型不符 / 2 门禁自身故障（模块加载不进来）。
 * 规范来源：docs/TASKS.md §3 G14 参考脚本（逐字实现，不改成 grep）。
 */
const ST = ['normal', 'holiday_silent', 'makeup_unconfirmed', 'makeup_skipped', 'makeup_follow', 'out_of_semester', 'unconfigured'];

let C;
try {
  C = await import('./src/calendar.js');
} catch (e) {
  console.log('GATE14: BROKEN');
  console.log('  load-failed: ' + (e && e.message));
  process.exit(2);
}

const N = C.NOTICE;
if (!N || typeof N !== 'object') {
  console.log('GATE14: FAIL');
  console.log('  NOTICE-not-exported（契约要求导出 NOTICE，便于门禁运行时校验）');
  process.exit(1);
}

const got = Object.keys(N).sort();
const want = [...ST].sort();
const missKeys = want.filter((k) => !got.includes(k));
const extraKeys = got.filter((k) => !want.includes(k));
const notFn = got.filter((k) => typeof N[k] !== 'function');

const bad = missKeys.length + extraKeys.length + notFn.length;
console.log(bad ? 'GATE14: FAIL' : 'GATE14: PASS');
console.log(
  bad
    ? '  missing=' + JSON.stringify(missKeys) + ' ; extra=' + JSON.stringify(extraKeys) + ' ; notFunction=' + JSON.stringify(notFn)
    : '  ' + got.length + ' keys, all functions'
);
process.exitCode = bad ? 1 : 0;
