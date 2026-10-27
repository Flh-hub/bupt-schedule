/**
 * ui/returnCheck.js — 从系统设置回来后，按机型提示"还差哪一项"。
 *
 * 【为什么需要】
 * 「后台运行」「权限一键检查」这些入口点出去是**离开 App** 的：用户在系统页改完、
 * 按返回，回到课表什么反馈都没有 —— 到底改成功没有，只能等下次提醒响不响来赌。
 * 这里做一件事：**回来就查一遍，还差哪项当场说清楚，并给出你这台机型的路径**。
 *
 * 【边界，别越界】
 *  · 只查系统**有 API** 的三项：通知权限、精确闹钟、电池豁免。
 *    厂商的「自启动 / 关联启动」没有任何查询接口，所以只给路径，绝不判"没开"。
 *  · 只有用户**点过某个入口**才查（`armReturnCheck`）。只是切出去看眼微信再回来，
 *    不该被弹窗拦住。
 *  · 通知权限若还处于「未询问」，直接拉起系统权限弹窗 —— 这才是真正意义上的
 *    "自动弹出权限询问请求"；已经拒绝过的系统不会再弹，只能引导去设置页。
 *  · 引导弹层 / 通知指引开着的时候不查：那两个弹层自己会随状态重画，
 *    再叠一个对话框只会打架。
 */

import { orderedBrands } from '../keepalive.js';
import * as NATIVE from '../native.js';
import { confirmDialog, snackbar } from './components.js';

/** 可查的三项（key → 人话）。厂商自启动不在此列：读不到，不判。 */
const LABELS = {
  notify: '通知权限',
  exact: '精确闹钟',
  battery: '后台运行'
};

/** 待检查项；null = 没点过入口，回到前台不打扰。 */
let pending = null;
/** 对话框开着时别重入（用户连续切前后台会触发多次 visible）。 */
let busy = false;

/**
 * 登记"回来后要查什么"。跳系统页之前调用。
 * @param {...(string|string[])} kinds notify / exact / battery
 */
export function armReturnCheck(...kinds) {
  const list = kinds.flat().filter((k) => LABELS[k]);
  if (!list.length) return;
  if (!pending) pending = new Set();
  for (const k of list) pending.add(k);
}

/** 清空（测试用 / 用户明确不想再被问）。 */
export function resetReturnCheck() {
  pending = null;
}

/** 按当前快照挑出仍然缺的项。 */
function pickMissing(kinds, snap) {
  const out = [];
  if (kinds.has('notify') && snap.notify !== 'granted') out.push('notify');
  if (kinds.has('exact') && snap.exactAlarm !== true) out.push('exact');
  if (kinds.has('battery') && snap.batteryExempt !== true) out.push('battery');
  return out;
}

/** 「你的 OPPO PLG110」——机型串，用于把话说具体。 */
function whoText() {
  const brand = NATIVE.deviceBrand();
  const model = NATIVE.deviceModel();
  if (!brand) return '这台手机';
  return model ? `${brand} ${model}` : brand;
}

/** 每一项在**这台机器**上的具体路径。 */
function lineOf(kind, snap, current) {
  if (kind === 'notify') {
    return snap.notify === 'denied'
      ? '· 通知权限：被拒绝过，系统不会再弹窗 —— 设置 › 应用 › 北邮课程表 › 权限管理 › 通知'
      : '· 通知权限：设置 › 应用 › 北邮课程表 › 权限管理 › 通知';
  }
  if (kind === 'exact') {
    return '· 精确闹钟：设置 › 应用 › 特殊权限 › 闹钟和提醒';
  }
  // 电池：把品牌页里那条"耗电管理"路径抽出来，比通用说法准
  const brandPath = (current.path || []).find((p) => /耗电|电池|省电/.test(p));
  return `· 后台运行：${brandPath || '设置 › 应用 › 北邮课程表 › 耗电管理'}，选「允许完全后台行为」`;
}

/** 跳到某一项对应的系统页。 */
function jumpTo(kind) {
  if (kind === 'notify') {
    const landing = NATIVE.openNotificationPermissionPage();
    if (landing === 'none') NATIVE.openNotificationCenter();
    return;
  }
  if (kind === 'exact') {
    NATIVE.openExactAlarmSettings();
    return;
  }
  NATIVE.openBatteryModePage();
}

/** 引导弹层 / 通知指引开着时，跳过（它们自己会重画）。 */
function modalOpen() {
  for (const id of ['onboard-host', 'guide-host']) {
    const el = typeof document === 'undefined' ? null : document.getElementById(id);
    if (el && el.innerHTML.trim()) return true;
  }
  return false;
}

/**
 * 回到前台时调用。
 * @returns {'idle'|'skipped'|'ok'|'requested'|'prompted'}
 *          requested = 已拉起系统权限弹窗；prompted = 弹了 App 内提示
 */
export async function runReturnCheck() {
  if (!pending || busy) return 'idle';
  if (!NATIVE.isNativeApp()) return 'idle';

  const snap = NATIVE.permissionSnapshot();
  if (!snap) return 'idle';

  if (modalOpen()) {
    // 弹层里已经列着状态了，别叠一层
    pending = null;
    return 'skipped';
  }

  const kinds = pending;
  pending = null; // 只查一次：用户没再点入口就不重复打扰

  const missing = pickMissing(kinds, snap);
  if (!missing.length) {
    // 全部开着也要给一句反馈：否则用户从设置回来"什么都没发生"，
    // 根本不知道有没有生效 —— 这正是这次要解决的问题。
    const names = [...kinds].map((k) => LABELS[k]).join('、');
    snackbar(`已复查：${names}都开着`, { duration: 2600 });
    return 'ok';
  }

  // ★ 通知还处于「未询问」：直接把系统权限框拉起来。
  //   这是唯一一次"系统愿意弹"的机会，比任何文字提示都直接。
  if (missing.includes('notify') && snap.notify === 'default') {
    NATIVE.requestNotifyPermission();
    // 系统框关掉后 main.js 会回调 __buptNotifyPermissionChanged，那里不再重复提示
    return 'requested';
  }

  const { current } = orderedBrands(NATIVE.deviceBrand());
  const lines = missing.map((k) => lineOf(k, snap, current));
  const title = `${missing.length} 项还没开好`;
  const message = `你的 ${whoText()} 需要手动确认：\n\n${lines.join('\n')}`;

  busy = true;
  const go = await confirmDialog({
    title,
    message,
    confirmText: '去打开',
    cancelText: '知道了'
  });
  busy = false;

  if (go) {
    // 又跳出去了 → 回来再查一遍，形成"改完 → 复查"的闭环
    armReturnCheck(missing);
    jumpTo(missing[0]);
  }
  return 'prompted';
}
