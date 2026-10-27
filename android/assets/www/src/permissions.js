/**
 * permissions.js — 首次启动的「该开的都开了吗」清单（纯逻辑）。
 *
 * 装完 App 第一次打开时，用户面对的是 3~5 个散落在系统设置里的开关：
 * 通知权限、精确闹钟、电池优化白名单、（Android 16）提升通知/流体云。
 * 本模块把它们归一成一张清单，UI 只负责画。
 *
 * 原则：
 *  - **只按真实状态判断**（原生 permissionSnapshot 给什么就是什么），不猜；
 *  - 无法检测的（厂商自启动）标成"说明"项，不计入未完成数量；
 *  - 每项都写清"不开启会怎样"，因为绝大多数人不知道为什么要点。
 */

/**
 * @typedef {{sdk?:number, notify?:string, batteryExempt?:boolean,
 *            exactAlarm?:boolean, promoted?:boolean|null}} Snapshot
 */

/**
 * @param {Snapshot} snapshot 原生 `permissionSnapshot()` 的结果
 * @param {{batteryConfirmed?:boolean}} [opts] 用户是否已在自己机型上手动确认过（系统读不到，只能问）
 * @returns {Array<{key:string, title:string, desc:string, ok:boolean,
 *                  kind:'check'|'info', action:string|null, cta:string}>}
 */
export function buildSteps(snapshot, opts = {}) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const batteryConfirmed = Boolean(opts && opts.batteryConfirmed);
  const sdk = Number(s.sdk) || 0;
  const steps = [];

  // ① 通知权限（Android 13+ 才需要运行时授予）
  //    ★ 「课前胶囊（流体云 / 灵动岛）」也走这条通知：它发的就是一条通知，
  //      没权限根本发不出去，所以不单列一行，免得用户以为是重复项。
  steps.push({
    key: 'notify',
    title: '通知权限',
    desc:
      sdk >= 33
        ? '不开就收不到任何提醒。课前胶囊也走这条通知。'
        : '系统版本较老，通知默认可用，确认没被关就行。课前胶囊也走这条通知。',
    ok: s.notify === 'granted',
    kind: 'check',
    action: 'onboard-notify',
    cta: '去开启'
  });

  // ② 精确闹钟（Android 12+ 的特殊权限）
  if (sdk >= 31) {
    steps.push({
      key: 'exactAlarm',
      title: '精确闹钟',
      desc: '不开的话，提醒可能晚十几分钟。',
      ok: s.exactAlarm === true,
      kind: 'check',
      action: 'onboard-exact',
      cta: '去开启'
    });
  }

  // ③ 电池优化 / 后台行为
  //    ★ 国内 ROM 有自己一套（ColorOS 的「耗电管理」默认是"智能优化"），
  //      系统只让我们读 AOSP 白名单，读不到厂商那一层的选择 → 让用户在 App 内确认后记住。
  steps.push({
    key: 'battery',
    title: '后台运行',
    desc: '省电时会清掉已排的闹钟。要在「耗电管理」里选「允许完全后台行为」，别选「智能优化」。',
    ok: s.batteryExempt === true || batteryConfirmed,
    kind: 'check',
    action: 'onboard-battery',
    cta: '去设置',
    dialog: 'battery'
  });

  // ④ 厂商自启动：系统没有接口可查，只能给路径
  steps.push({
    key: 'autostart',
    title: '自启动（看机型）',
    desc: '有的手机重启后会关掉闹钟，点进去有路径。',
    ok: true, // 无法检测，不计入未完成
    kind: 'info',
    action: 'onboard-keepalive',
    cta: '查看路径'
  });

  return steps;
}

/** 还需要用户动手的项数（"说明"类不算）。 */
export function pendingCount(steps) {
  return (Array.isArray(steps) ? steps : []).filter((x) => x.kind === 'check' && !x.ok).length;
}

/** 首次引导是否该弹：原生环境 + 没弹过。 */
export function shouldOnboard({ native, done, snapshot }) {
  if (!native) return false;
  if (done) return false;
  return Boolean(snapshot && typeof snapshot === 'object');
}

/**
 * 「系统通知设置页里，到底要开哪几项」的清单。
 *
 * 为什么需要它：Android 不允许应用代开这些开关（渠道级偏好归用户），
 * 跳过去之后如果只丢一句"去打开"，用户照样不知道点哪里。所以把要开的项逐条列出来。
 *
 * ★ 落点是「设置 › 应用 › 北邮课程表 › 权限管理 › 通知」（用户明确指定的那一页）。
 *   那一页只有「允许通知」一个开关；横幅/锁屏/静默在它的下一层：
 *   返回上一级 →「通知管理」→「上课提醒」。所以第 2~4 项都要写清"再往里走一层"，
 *   否则用户会在权限页上找不到横幅。
 */
export const NOTIFY_MANUAL_ITEMS = [
  {
    key: 'allow',
    title: '允许通知',
    where: '就是这一页的开关',
    why: '关着后面都没意义。灰的点不动，就先返回上一层打开「通知」。'
  },
  {
    key: 'silent',
    title: '静默通知（必须关闭）',
    where: '上一级 →「通知管理」→「上课提醒」，保持关闭',
    why: '开着就只进通知中心，不响也不弹横幅。'
  },
  {
    key: 'lockscreen',
    title: '锁屏',
    where: '同一页，「锁屏」打勾',
    why: '手机在兜里时，锁屏上看得到才算提醒到人。'
  },
  {
    key: 'banner',
    title: '横幅',
    where: '同一页，「横幅」打勾',
    why: '只在状态栏闪一下，很容易错过。'
  }
];

/** 落地级别 → 一句"你现在在哪一页"。 */
export function landingGuideText(landing, brandId = 'coloros') {
  // ★ 「权限管理」「通知与控制中心」都是 ColorOS 的菜单名。
  //   小米/华为/三星上没有这两个入口，照抄会把用户指到不存在的地方，
  //   所以非 ColorOS 一律用中性说法。
  const os = brandId === 'coloros';
  if (landing === 'perm') {
    return os
      ? '已打开「权限管理」：点其中的「通知」这一项，再按下面几项打开。'
      : '已打开「通知」权限页：按下面几项打开即可。';
  }
  if (landing === 'notify') return '已打开「通知」权限页：按下面几项打开即可。';
  if (landing === 'channel') return '已打开「上课提醒」渠道页：按下面几项打开即可。';
  if (landing === 'center') {
    return os
      ? '已打开「通知与控制中心」：点页面底部「应用通知设置」→「北邮课程表」，再按下面几项打开。'
      : '已打开通知设置：找到「北邮课程表」，再按下面几项打开。';
  }
  if (landing === 'list') return '已打开通知列表：点一下「北邮课程表」，再按下面几项打开。';
  if (landing === 'detail' || landing === 'none') {
    return os
      ? '没能直达，请按 设置 › 应用 › 北邮课程表 › 权限管理 › 通知 进来。'
      : '没能直达，请按 设置 › 应用 › 北邮课程表 › 通知 进来。';
  }
  return '已打开通知设置：按下面几项打开即可。';
}

/**
 * 哪些是"必开项"（没开不能离开引导页）。
 *
 * 只放真正影响核心功能的：通知、精确闹钟、后台运行。
 * 流体云/自启动不进必开：前者系统可能不给（非白名单应用），后者读不到状态，
 * 硬卡会让用户永远出不去。
 */
export const REQUIRED_KEYS = ['notify', 'exactAlarm', 'battery'];

/** 还没开好的必开项（给引导页的按钮文案/禁用态用）。 */
export function requiredPending(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return list.filter((s) => s.kind === 'check' && REQUIRED_KEYS.includes(s.key) && !s.ok);
}
