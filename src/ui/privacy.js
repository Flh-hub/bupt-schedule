/**
 * ui/privacy.js — 隐私说明：首次启动征求同意 + 设置内全文页。
 *
 * 【为什么要这一页】
 * 国产 ROM 的安装器会对非应用商店来源的 APK 做一次个人信息合规检测，
 * 命中「应用内未提供隐私政策」时弹「个人信息收集提醒」（要求勾选「已知悉风险」）。
 * 应用内有一页把收集范围讲清楚、首次启动征求一次同意，这个检测项就不再命中。
 *
 * 【内容纪律】
 * 下面每一条都必须与代码实际行为对得上，写之前核对过：
 *  - 没有服务器、没有账号、没有埋点：全库唯一的对外域名是 jwgl.bupt.edu.cn
 *  - 不读 IMEI / Android ID / OAID / 通讯录 / 位置：代码里不存在这些调用
 *  - 学号明文 + 密码 AES-GCM 密文（Keystore 密钥不可导出）存原生 SharedPreferences
 * 将来新增对外请求、新增本地存储、接入任何 SDK，**必须同步改这一页**，
 * 否则它就变成一份虚假声明——那比没有这一页更糟。
 */

const ACCEPT_KEY = 'privacy-accepted';
const SNOOZE_KEY = 'privacy-snooze';
/** 内容版本：改动了实质条款就换一个值，用户会被重新问一次。 */
const VERSION = '2026-10';

function readFlag(name) {
  try {
    return window.localStorage.getItem(name);
  } catch {
    return null;
  }
}

function writeFlag(name, value) {
  try {
    window.localStorage.setItem(name, value);
  } catch {
    /* 隐私模式下写不进去：那就每次都问，宁多问不漏问 */
  }
}

/** 是否已同意当前版本的隐私说明。 */
export function privacyAccepted() {
  return readFlag(ACCEPT_KEY) === VERSION;
}

/** 用户选过「暂不」且还在暂缓期内（7 天）。 */
export function privacySnoozed(now = Date.now()) {
  const until = Number(readFlag(SNOOZE_KEY) || 0);
  return until > now;
}

export function acceptPrivacy() {
  writeFlag(ACCEPT_KEY, VERSION);
  writeFlag(SNOOZE_KEY, '');
}

export function snoozePrivacy(now = Date.now()) {
  writeFlag(SNOOZE_KEY, String(now + 7 * 86400000));
}

/* ---------------------------------------------------------------- 正文 */

const SECTIONS = [
  {
    title: '不收集你的个人信息',
    items: [
      '没有服务器、没有账号系统、没有统计埋点、没有广告 SDK。',
      '课表、课程、提醒设置全部存在手机本机，不会上传到任何地方。',
      '卸载应用或清除应用数据，这些内容随之消失，我们这边没有任何副本。'
    ]
  },
  {
    title: '唯一会联网的地方：自动导入课表',
    items: [
      '你填的学号和密码只发往北邮教务系统 jwgl.bupt.edu.cn，不经过任何中间服务器。',
      '该站点只在校内网络可达；不在校内时请求不会成功。',
      '密码在安卓端用系统 Keystore 的密钥加密后存在本机，网页层读不到明文。',
      '随时可以在「导入」页清除已保存的账号，清除后不再保留。'
    ]
  },
  {
    title: '申请的权限，各自用在哪',
    items: [
      '通知：课前提醒、桌面小组件。',
      '精确闹钟：让提醒准点响，而不是被系统推迟几分钟。',
      '电池优化豁免 / 开机自启：避免锁屏或重启后提醒被系统掐掉。',
      '震动：提醒时震动（可在应用内关闭）。',
      '网络：「自动导入课表」。'
    ]
  },
  {
    title: '没有做的事',
    items: [
      '不读取通讯录、短信、相册、位置、通话记录、剪贴板。',
      '不读取 IMEI / Android ID / OAID 等设备标识。',
      '不上报崩溃日志、不统计使用行为。',
      '应用不含任何第三方 SDK。'
    ]
  },
  {
    title: '你的选择',
    items: [
      '选「暂不」也能正常看课表、手动加课、导出备份；只有「自动导入课表」需要联网读取你的教务账号信息。',
      '在「设置 › 数据与备份」可以随时清空全部本地数据。',
      '在「设置 › 隐私说明」可以随时回看这一页。'
    ]
  }
];

function sectionsHtml() {
  return SECTIONS.map(
    (sec) => `<div class="card">
      <h2 class="card-title"><span class="dot"></span>${sec.title}</h2>
      <ul class="steps-plain">
        ${sec.items.map((x) => `<li>${x}</li>`).join('')}
      </ul>
    </div>`
  ).join('');
}

/** 设置里的二级页（`#/settings/privacy`）。 */
export function privacyPageHtml() {
  return `<div class="page">
    ${sectionsHtml()}
    <p class="tiny muted" style="margin:16px 4px 0;text-align:center;line-height:1.7">
      本页说明与 1.66.31 起的程序行为一致。<br />
      如果以后新增了联网功能，会先更新这一页再要求你重新确认。
    </p>
  </div>`;
}

/* ---------------------------------------------------------------- 首次启动弹层 */

let bound = false;
let onAcceptCallback = null;

function host() {
  return document.getElementById('dialog-host');
}

function closeGate() {
  const el = host();
  if (!el) return;
  el.classList.remove('is-open');
  el.innerHTML = '';
}

/**
 * 供「返回手势」调用：等同于点「暂不」——收起弹层并记 7 天暂缓。
 *
 * ★ 不调 onAcceptCallback：返回手势不该被当成"同意"，也不该触发后续引导，
 *   否则用户只是想退出弹层，却被塞了一屏权限清单。
 */
export function dismissPrivacyGate() {
  snoozePrivacy();
  closeGate();
  onAcceptCallback = null;
}

function bind() {
  if (bound) return;
  bound = true;
  document.addEventListener('click', (event) => {
    const el = event.target instanceof Element ? event.target.closest('[data-privacy]') : null;
    if (!el) return;
    const action = el.dataset.privacy;
    if (action === 'accept') {
      acceptPrivacy();
      closeGate();
      if (typeof onAcceptCallback === 'function') onAcceptCallback();
      onAcceptCallback = null;
    } else if (action === 'later') {
      snoozePrivacy();
      closeGate();
      onAcceptCallback = null;
    } else if (action === 'more') {
      // 去看全文：弹层收起并记 7 天暂缓——否则下次启动又弹同一层，
      // 用户会以为"点了没反应"。7 天后若还没同意，会再问一次。
      snoozePrivacy();
      closeGate();
      onAcceptCallback = null;
    }
  });
}

/**
 * 首次启动征求同意。
 *
 * 只弹一次，且**不阻断**任何本机功能：用户选「暂不」照样能看课表。
 * 真正需要拦截的是联网抓取（见 `import.js` 的同意检查），不是打开应用。
 *
 * @param {{onAccept?:Function, force?:boolean}} [opts] force：跳过「暂不」的 7 天暂缓
 *   （联网抓取前必须拿到明确同意，暂缓期也要问）
 * @returns {boolean} 是否弹了
 */
export function maybeAskPrivacy(opts = {}) {
  if (typeof document === 'undefined') return false;
  if (privacyAccepted()) return false;
  if (!opts.force && privacySnoozed()) return false;
  const el = host();
  if (!el) return false;
  bind();
  onAcceptCallback = typeof opts.onAccept === 'function' ? opts.onAccept : null;

  // 只摘前两段（"不收集什么" + "唯一联网的地方"）。权限用途和"没做的事"留给全文页：
  // 弹层不需要把整篇塞进来，塞进来就一定要滚动，最后一行往往正好被切掉半截。
  const summary = SECTIONS.slice(0, 2)
    .map(
      (sec) => `<p class="small" style="margin:0 0 4px"><b>${sec.title}</b></p>
        <ul class="steps-plain" style="margin:0 0 10px">
          ${sec.items.slice(0, 2).map((x) => `<li>${x}</li>`).join('')}
        </ul>`
    )
    .join('');

  el.innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="privacy-title">
      <h3 id="privacy-title">隐私说明</h3>
      <div style="max-height:48vh;overflow-y:auto;margin:0 0 10px">
        <p class="small muted" style="margin:0 0 10px">
          北邮课程表不收集你的个人信息。下面是完整的处理方式，读完再决定。
        </p>
        ${summary}
      </div>
      <a class="small" href="#/settings/privacy" data-privacy="more"
         style="display:block;margin:0 0 10px;color:var(--brand-ink)">查看完整说明</a>
      <div class="dialog-actions">
        <button type="button" class="btn" data-privacy="later">暂不</button>
        <button type="button" class="btn btn-primary" data-privacy="accept">同意并继续</button>
      </div>
    </div>`;
  el.classList.add('is-open');
  return true;
}
