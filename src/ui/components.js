/**
 * ui/components.js — 通用视觉件（唯一允许拼 HTML 字符串的地方之一）。
 *
 * 说明：本文件不 import calendar.js，不做任何日期判断；
 * 需要日期的组件全部由调用方把「已算好」的文案传进来。
 */

import {
  PALETTE,
  WEEKDAY_FULL,
  addDays,
  dayOfWeekOf,
  emptyState as createEmptyState,
  todayStr,
  uid
} from '../model.js';

/* ---------------------------------------------------------------- 图标 */

const svg = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${body}</svg>`;

export const ICONS = {
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  check: svg('<path d="M4.5 12.5l5 5 10-11"/>'),
  chevronLeft: svg('<path d="M14.5 5 8 12l6.5 7"/>'),
  chevronRight: svg('<path d="M9.5 5 16 12l-6.5 7"/>'),
  chevronDown: svg('<path d="M9 5l7 7-7 7"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  trash: svg('<path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.8 12.2h9.4L17.5 7"/>'),
  undo: svg('<path d="M9 8H5.5V4.5"/><path d="M5.8 8.2A8 8 0 1 1 4.5 14"/>'),
  alert: svg('<path d="M12 4.5 21 19.5H3L12 4.5Z"/><path d="M12 10v4M12 16.6v.1"/>'),
  info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.1"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>'),
  location: svg('<path d="M12 21s6.5-6.2 6.5-11a6.5 6.5 0 1 0-13 0c0 4.8 6.5 11 6.5 11Z"/><circle cx="12" cy="10" r="2.4"/>'),
  teacher: svg('<circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 20c1.2-3.6 3.9-5.4 7.2-5.4S18 16.4 19.2 20"/>'),
  download: svg('<path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M4.5 17v2.2h15V17"/>'),
  upload: svg('<path d="M12 16V5m0 0 4 4m-4-4L8 9"/><path d="M4.5 17v2.2h15V17"/>'),
  calendar: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 9.5h17M8 3v3.5M16 3v3.5"/>'),
  bell: svg('<path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9Z"/><path d="M9.5 18a2.5 2.5 0 0 0 5 0"/>'),
  book: svg('<path d="M5 4.5h9a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3V4.5Z"/><path d="M8 16.5h9"/>'),
  edit: svg('<path d="M4.5 19.5h4L20 8a2.1 2.1 0 0 0-3-3L5.5 16.5l-1 3Z"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 5.5A2.5 2.5 0 0 0 13.5 3H5.5A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16"/>'),
  search: svg('<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.6 15.6 20 20"/>'),
  shield: svg('<path d="M12 3.5 19 6v6c0 4-3 7-7 8.5C8 19 5 16 5 12V6l7-2.5Z"/><path d="M9 12l2 2 4-4"/>')
};

/* ---------------------------------------------------------------- 基础工具 */

/** HTML 转义（所有用户输入必须经过）。 */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 课程色 → 块内联样式（背景为同色的低透明度填充）。
 *
 * ★ 浅色 12% / 深色 25%：
 *   深色底上 12% 的浅色几乎看不出来，几门课会糊成一片；
 *   提到 25% 才既看得出「这是哪门课」，又不会亮得刺眼。
 */
export function blockStyle(color) {
  const hex = color || PALETTE[0];
  const alpha =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
      ? '40' // 25%
      : '1f'; // 12%
  return `--block-color:${hex};--block-bg:${hex}${alpha};`;
}

/**
 * 课程首字徽章（列表里替代纯文字标题的视觉锚点）。
 * 颜色沿用课程自身 color，与课表块同色，扫一眼就能对上。
 * @param {string} name 课程名
 * @param {string} [color] 课程色，非法值回落到调色板首色（防 CSS 注入）
 */
export function courseAvatar(name, color) {
  const hex = /^#[0-9a-f]{6}$/i.test(String(color || '')) ? color : PALETTE[0];
  const ch = String(name || '').trim().slice(0, 1) || '课';
  return `<span class="avatar" style="--avatar-color:${hex};--avatar-bg:${hex}1f" aria-hidden="true">${escapeHtml(
    ch
  )}</span>`;
}

/** 今日日期中文短文案：由调用方传入 dateStr（本函数不做日期计算）。 */
export function dateCn(dateStr) {
  const [y, m, d] = String(dateStr).split('-');
  return `${Number(m)}月${Number(d)}日`;
}

/** 星期文案，dow 1..7。 */
export function weekdayCn(dow) {
  return WEEKDAY_FULL[dow] || '';
}

/* ---------------------------------------------------------------- Snackbar */

const undoRegistry = new Map();
let snackTimer = null;

function registerUndo(fn) {
  const token = uid('undo');
  undoRegistry.set(token, fn);
  return token;
}

/** 执行并消费一个 undo token。 */
export function runUndo(token) {
  const fn = undoRegistry.get(token);
  if (!fn) return false;
  undoRegistry.delete(token);
  try {
    fn();
  } catch (err) {
    return false;
  }
  return true;
}

/**
 * 提示条避让：弹层（补课 / 活动 / 确认框）打开时，把它整条挪到弹层按钮行之上。
 *
 * 不写死像素：按钮行高度随字体缩放 / 安全区变化，靠实测它的 top 反推。
 * 拿不到布局（jsdom、弹层还在动画中）就退回 92px 的保守值。
 */
function positionOverSheet(host) {
  const sheetHost = document.getElementById('sheet-host');
  const open = !!(sheetHost && sheetHost.classList.contains('is-open'));
  host.classList.toggle('is-over-sheet', open);
  if (!open) {
    host.style.bottom = '';
    return;
  }
  const foot = sheetHost.querySelector('.sheet-foot');
  const rect = foot ? foot.getBoundingClientRect() : null;
  const viewport = (typeof window !== 'undefined' && window.innerHeight) || 0;
  const gap = rect && rect.height > 0 && viewport > 0 ? viewport - rect.top + 8 : 92;
  host.style.bottom = `${Math.round(Math.max(12, gap))}px`;
}

/**
 * 底部提示条（可带撤销）。
 * @param {string} message
 * @param {{undo?:Function, undoLabel?:string, danger?:boolean, duration?:number}} [opts]
 */
export function snackbar(message, opts = {}) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('snackbar-host');
  if (!host) return;
  // ★ 弹层开着时把提示条抬到按钮行上方：否则它正好压在「添加活动 / 确定」上，
  //   用户既看不到错误、又点不到按钮（z-index 只是让它"看得见"，位置还得让开）。
  positionOverSheet(host);
  host.innerHTML = '';
  if (snackTimer) clearTimeout(snackTimer);

  const el = document.createElement('div');
  el.className = `snackbar${opts.danger ? ' is-danger' : ''}`;

  const text = document.createElement('span');
  text.className = 'grow';
  text.textContent = message;
  el.appendChild(text);

  if (typeof opts.undo === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.action = 'snackbar-undo';
    btn.dataset.token = registerUndo(opts.undo);
    btn.textContent = opts.undoLabel || '撤销';
    el.appendChild(btn);
  }

  host.appendChild(el);

  const duration = opts.duration == null ? (opts.undo ? 6000 : 2600) : opts.duration;
  snackTimer = setTimeout(() => {
    el.style.transition = 'opacity .2s ease';
    el.style.opacity = '0';
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 220);
  }, duration);
}

/* ---------------------------------------------------------------- 浮层滚动锁 */

/**
 * 浮层（弹层 / 选择器 / 确认框）打开时锁住页面滚动。
 *
 * 【为什么必须锁】浮层是 fixed 的，但它下面的页面仍然是可滚动的文档：
 *   ① 在遮罩上往下拖 → 滚的是后面的课表，"弹窗还在、课表在动"；
 *   ② 表单比屏幕高时，在 .sheet-body 里滑到底会**滚动链**传给文档，课表跟着走；
 *   ③ 键盘弹起时 Chromium 为了让焦点输入框可见也会滚文档，表现为整页抖一下。
 * 三件事同一个根因，锁一次全解决。
 */
let lockedScrollY = 0;
let scrollGuardBound = false;

/**
 * 兜底：锁住期间页面一旦被"程序化滚动"（键盘为了露出输入框会自动滚），立刻弹回原位。
 * `overflow: hidden` 只挡手势，脚本滚动照样生效 —— 这一层专门挡它。
 */
function scrollGuard() {
  if (typeof document === 'undefined') return;
  if (!document.documentElement.classList.contains('is-overlay-open')) return;
  if (Math.abs(window.scrollY - lockedScrollY) > 1) window.scrollTo(0, lockedScrollY);
}

function syncScrollLock() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const open = ['sheet-host', 'picker-host', 'dialog-host'].some((id) => {
    const el = document.getElementById(id);
    return !!(el && el.classList.contains('is-open'));
  });
  const wasOpen = root.classList.contains('is-overlay-open');

  if (open && !wasOpen) lockedScrollY = window.scrollY;
  root.classList.toggle('is-overlay-open', open);

  if (open && !scrollGuardBound) {
    window.addEventListener('scroll', scrollGuard, { passive: true });
    scrollGuardBound = true;
  }
  if (!open) lockedScrollY = window.scrollY;
}

/* ---------------------------------------------------------------- Sheet */

let sheetClose = null;

/** 关闭当前底部弹层。 */
export function closeSheet() {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('sheet-host');
  if (!host) return;
  host.classList.remove('is-open');
  syncScrollLock();
  const done = sheetClose;
  sheetClose = null;
  setTimeout(() => {
    if (host && !host.classList.contains('is-open')) host.innerHTML = '';
  }, 260);
  if (typeof done === 'function') done();
}

/**
 * 底部弹层表单。
 * @param {{title:string, body:string, submitText?:string, cancelText?:string,
 *          onSubmit?:Function, hideSubmit?:boolean}} config
 */
export function sheet(config) {
  if (typeof document === 'undefined') return null;
  const host = document.getElementById('sheet-host');
  if (!host) return null;
  host.innerHTML = `
    <div class="sheet-mask" data-action="sheet-close"></div>
    <form class="sheet" novalidate>
      <div class="sheet-head">
        <h2>${escapeHtml(config.title || '')}</h2>
        <span class="spacer"></span>
        <button type="button" class="icon-btn" data-action="sheet-close" aria-label="关闭">${ICONS.close}</button>
      </div>
      <div class="sheet-body">${config.body || ''}</div>
      ${
        config.hideSubmit
          ? ''
          : `<div class="sheet-foot">
               <button type="button" class="btn" data-action="sheet-close">${escapeHtml(config.cancelText || '取消')}</button>
               <button type="submit" class="btn btn-primary">${escapeHtml(config.submitText || '确定')}</button>
             </div>`
      }
    </form>`;

  const form = host.querySelector('form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    let result = true;
    if (typeof config.onSubmit === 'function') result = config.onSubmit(data, form);
    if (result !== false) closeSheet();
    else {
      // 提交被拦下：只左右抖一下。
      // ★ 绝对不要给 <form class="sheet">（就是面板本身）做透明度动画 ——
      //   原来重放的是 `.fade-in`（opacity 0 → 1，200ms），等于每点一次「添加活动」，
      //   整块面板先消失再出现，用户看到的就是"闪一下"。
      form.classList.remove('is-nope');
      void form.offsetWidth; // 强制重排，动画才会重播
      form.classList.add('is-nope');
    }
  });

  host.classList.remove('is-open');
  void host.offsetWidth;
  host.classList.add('is-open');
  syncScrollLock();
  sheetClose = config.onClose || null;
  return { form, close: closeSheet };
}

/* ---------------------------------------------------------------- 选择器（picker）
   为什么不用 <select>：
   安卓 WebView 会把 <select> 渲染成系统单选弹窗——白底、灰圆圈、无分组、无课程色、
   一次只显示十几行还带系统字体，跟整体设计完全割裂（这也是给 APK 换掉它的主要原因）。
   自绘之后可以：保留课程色 / 节次按上午下午晚上分组 / 长列表搜索 / 选中即关。
   ------------------------------------------------------------------------ */

let pickerCleanup = null;
// 每次打开自增：用来让「上一次关闭的延时清理」失效，
// 否则 110ms 内又打开一个新的，会被上一次的 closePicker 顺手关掉。
let pickerSeq = 0;

/** 规范化选项：只留渲染需要的字段，颜色做十六进制校验（防样式注入）。 */
function normalizeOptions(options) {
  return (Array.isArray(options) ? options : []).map((o) => ({
    value: String(o && o.value != null ? o.value : ''),
    label: String(o && o.label != null ? o.label : ''),
    sub: o && o.sub ? String(o.sub) : '',
    badge: o && o.badge != null ? String(o.badge) : '',
    avatar: o && o.avatar ? String(o.avatar).slice(0, 1) : '',
    color: /^#[0-9a-f]{6}$/i.test(String((o && o.color) || '')) ? o.color : '',
    group: o && o.group ? String(o.group) : ''
  }));
}

/** 选项左侧的锚点（课程首字色块 / 节次序号），触发器与列表共用。 */
export function optionLead(option) {
  if (!option) return '';
  if (option.avatar) {
    const hex = /^#[0-9a-f]{6}$/i.test(String(option.color || '')) ? option.color : PALETTE[0];
    return `<span class="avatar" style="--avatar-color:${hex};--avatar-bg:${hex}1f" aria-hidden="true">${escapeHtml(
      option.avatar
    )}</span>`;
  }
  if (option.badge) return `<span class="pk-num" aria-hidden="true">${escapeHtml(option.badge)}</span>`;
  return '';
}

/** 关闭选择器。 */
export function closePicker() {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('picker-host');
  if (!host) return;
  const seqAtClose = pickerSeq;
  host.classList.remove('is-open');
  syncScrollLock();
  if (pickerCleanup) {
    pickerCleanup();
    pickerCleanup = null;
  }
  setTimeout(() => {
    if (seqAtClose !== pickerSeq) return; // 期间又开了新的，别清它
    if (host && !host.classList.contains('is-open')) host.innerHTML = '';
  }, 280);
}

/**
 * 底部选择器。
 * @param {{title?:string, options:Array, value?:string, searchable?:boolean,
 *          searchPlaceholder?:string, onPick?:Function}} cfg
 */
export function openPicker(cfg = {}) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('picker-host');
  if (!host) return;
  pickerSeq += 1;
  if (pickerCleanup) {
    pickerCleanup();
    pickerCleanup = null;
  }

  const options = normalizeOptions(cfg.options);
  const current = cfg.value == null ? '' : String(cfg.value);
  const withSearch = cfg.searchable !== false && options.length > 6;
  const title = cfg.title || '请选择';

  host.innerHTML = `
    <div class="picker-mask"></div>
    <div class="picker" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="pk-grip"></div>
      <div class="pk-head">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="icon-btn pk-close" aria-label="关闭">${ICONS.close}</button>
      </div>
      ${
        withSearch
          ? `<div class="pk-search">
               ${ICONS.search}
               <input type="search" class="pk-search-input" autocomplete="off"
                 placeholder="${escapeHtml(cfg.searchPlaceholder || '搜索')}" aria-label="搜索选项" />
             </div>`
          : ''
      }
      <div class="pk-scroll"><div class="pk-list" role="listbox" aria-label="${escapeHtml(title)}"></div></div>
      <p class="pk-empty tiny muted" hidden>没有匹配的选项</p>
    </div>`;

  const listEl = host.querySelector('.pk-list');
  const emptyEl = host.querySelector('.pk-empty');
  const searchEl = host.querySelector('.pk-search-input');

  const rowHtml = (o) => {
    const on = o.value === current;
    return `<button type="button" class="pk-item${on ? ' is-on' : ''}" data-pk-value="${escapeHtml(o.value)}"
      role="option" aria-selected="${on}">
      ${optionLead(o) ? `<span class="pk-lead">${optionLead(o)}</span>` : ''}
      <span class="pk-main">
        <span class="pk-label">${escapeHtml(o.label)}</span>
        ${o.sub ? `<span class="pk-sub">${escapeHtml(o.sub)}</span>` : ''}
      </span>
      <span class="pk-tick" aria-hidden="true">${ICONS.check}</span>
    </button>`;
  };

  const renderList = (keyword) => {
    const kw = String(keyword || '').trim().toLowerCase();
    const hits = kw
      ? options.filter((o) => `${o.label} ${o.sub} ${o.group}`.toLowerCase().includes(kw))
      : options;
    let html = '';
    let lastGroup = null;
    for (const o of hits) {
      if (o.group && o.group !== lastGroup) {
        html += `<div class="pk-group">${escapeHtml(o.group)}</div>`;
        lastGroup = o.group;
      }
      html += rowHtml(o);
    }
    listEl.innerHTML = html;
    if (emptyEl) emptyEl.hidden = hits.length > 0;
  };

  renderList('');

  const finish = (option) => {
    // 选中态立刻反馈（不做 CSS.escape：jsdom 里不一定有）
    for (const row of listEl.querySelectorAll('.pk-item')) {
      const on = row.dataset.pkValue === option.value;
      row.classList.toggle('is-on', on);
      row.setAttribute('aria-selected', String(on));
      // jsdom / 老 WebView 可能没有 scrollIntoView，缺了不能挡住选中回调
      if (on && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    }
    if (typeof cfg.onPick === 'function') cfg.onPick(option);
    // 留一点时间让人看到对勾落下；期间若又开了别的选择器就别关
    const seq = pickerSeq;
    setTimeout(() => {
      if (seq === pickerSeq) closePicker();
    }, 110);
  };

  const onClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('.picker-mask') || target.closest('.pk-close')) {
      event.preventDefault();
      closePicker();
      return;
    }
    const row = target.closest('.pk-item');
    if (!row) return;
    const option = options.find((o) => o.value === row.dataset.pkValue);
    if (option) finish(option);
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePicker();
    }
  };

  const onInput = () => renderList(searchEl ? searchEl.value : '');

  host.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey, true);
  if (searchEl) searchEl.addEventListener('input', onInput);
  pickerCleanup = () => {
    host.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKey, true);
    if (searchEl) searchEl.removeEventListener('input', onInput);
  };

  host.classList.remove('is-open');
  void host.offsetWidth;
  host.classList.add('is-open');
  syncScrollLock();
}

/**
 * 选项字段：外观是「标签 + 一行按钮」，值是隐藏 input，点开才弹选择器。
 * 隐藏 input 带 name，所以 sheet 的 FormData / onSubmit 完全不用改。
 *
 * @param {{id:string, name:string, label:string, value?:string, options:Array,
 *          title?:string, placeholder?:string, searchable?:boolean, hint?:string,
 *          link?:string}} cfg  link = 「选中后要保持 ≥ 本值」的另一个字段 id
 */
export function selectField(cfg) {
  const options = normalizeOptions(cfg.options);
  const value = cfg.value == null ? '' : String(cfg.value);
  const cur = options.find((o) => o.value === value) || null;
  const id = String(cfg.id || '');
  const title = cfg.title || cfg.label || '请选择';
  const lead = cur ? optionLead(cur) : '';

  return `<div class="field">
    <span class="field-label" id="${escapeHtml(id)}-lb">${escapeHtml(cfg.label || '')}</span>
    <input type="hidden" id="${escapeHtml(id)}" name="${escapeHtml(cfg.name || id)}" value="${escapeHtml(
    cur ? cur.value : ''
  )}" />
    <button type="button" class="select-trigger${cur ? '' : ' is-empty'}"
      data-action="pick-open" data-pick-id="${escapeHtml(id)}"
      data-pick-title="${escapeHtml(title)}"
      data-pick-search="${cfg.searchable === false ? '0' : '1'}"
      data-pick-options="${escapeHtml(JSON.stringify(options))}"
      ${cfg.link ? `data-pick-link="${escapeHtml(cfg.link)}"` : ''}
      aria-labelledby="${escapeHtml(id)}-lb" aria-haspopup="dialog">
      <span class="st-lead">${lead}</span>
      <span class="st-main">
        <span class="st-v">${escapeHtml(cur ? cur.label : cfg.placeholder || '请选择')}</span>
        <span class="st-s"${cur && cur.sub ? '' : ' hidden'}>${escapeHtml(cur ? cur.sub : '')}</span>
      </span>
      ${ICONS.chevronDown}
    </button>
    ${cfg.hint ? `<p class="tiny muted" style="margin:6px 0 0">${escapeHtml(cfg.hint)}</p>` : ''}
  </div>`;
}

/** 选中后回写触发器（浏览器端主流程用；不改变隐藏 input 的值）。 */
export function paintSelectTrigger(trigger, option) {
  if (!trigger) return;
  const main = trigger.querySelector('.st-main');
  if (main) {
    const v = main.querySelector('.st-v');
    const s = main.querySelector('.st-s');
    if (v) v.textContent = option ? option.label : '请选择';
    if (s) {
      s.textContent = option && option.sub ? option.sub : '';
      s.hidden = !(option && option.sub);
    }
  }
  const lead = trigger.querySelector('.st-lead');
  if (lead) lead.innerHTML = option ? optionLead(option) : '';
  trigger.classList.toggle('is-empty', !option);
}

/* ---------------------------------------------------------------- Dialog */

let dialogResolver = null;

/**
 * 二次确认。
 * @param {{title?:string, message?:string, confirmText?:string, cancelText?:string, danger?:boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(false);
      return;
    }
    const host = document.getElementById('dialog-host');
    if (!host) {
      resolve(false);
      return;
    }
    host.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>${escapeHtml(opts.title || '确认操作')}</h3>
        <p>${escapeHtml(opts.message || '')}</p>
        <div class="dialog-actions">
          <button type="button" class="btn" data-action="dialog-cancel">${escapeHtml(opts.cancelText || '取消')}</button>
          <button type="button" class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-action="dialog-ok">${escapeHtml(
            opts.confirmText || '确定'
          )}</button>
        </div>
      </div>`;
    host.classList.add('is-open');
    syncScrollLock();
    dialogResolver = (value) => {
      host.classList.remove('is-open');
      host.innerHTML = '';
      syncScrollLock();
      dialogResolver = null;
      resolve(value);
    };
  });
}

/** 供 main.js 的事件委托调用。 */
export function resolveDialog(value) {
  if (dialogResolver) dialogResolver(value);
}

/* ---------------------------------------------------------------- 小组件 */

/** 复制到剪贴板：优先 clipboard API，失败退回 execCommand（WebView 里前者不一定可用）。 */
export function copyText(text, okMsg = '已复制') {
  const done = () => snackbar(okMsg, { duration: 2000 });
  const fail = () => snackbar('复制失败，请长按邮箱手动选中', { danger: true, duration: 2800 });
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done, fail));
      return;
    }
  } catch (err) {
    // 落到下面的兜底
  }
  legacyCopy(text, done, fail);
}

function legacyCopy(text, done, fail) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) done();
    else fail();
  } catch (err) {
    fail();
  }
}

/** 提示横幅。 */
export function banner(type, html, actionHtml = '') {
  const iconMap = { warn: ICONS.alert, holiday: ICONS.info, makeup: ICONS.info, danger: ICONS.alert, info: ICONS.info };
  return `<div class="banner banner-${type}">
    <span class="banner-icon">${iconMap[type] || ICONS.info}</span>
    <span class="grow">${html}</span>
    ${actionHtml}
  </div>`;
}

/** 分段控件。 */
export function segmented(options, active, action, extraAttr = '') {
  return `<div class="segmented" role="tablist">${options
    .map(
      (o) => `<button type="button" role="tab" data-action="${action}" data-value="${escapeHtml(o.value)}"
        aria-selected="${o.value === active}" ${o.disabled ? 'disabled' : ''}
        class="${o.value === active ? 'is-active' : ''}">${escapeHtml(o.label)}</button>`
    )
    .join('')}</div>`;
}

/** 选择胶囊组。 */
export function chips(options, active, action) {
  return `<div class="chips">${options
    .map(
      (o) => `<button type="button" data-action="${action}" data-value="${escapeHtml(String(o.value))}"
        class="chip ${String(o.value) === String(active) ? 'is-active' : ''}">${escapeHtml(o.label)}</button>`
    )
    .join('')}</div>`;
}

/** 空态卡片。 */
export function emptyState(title, desc, actionsHtml = '', icon = ICONS.calendar) {
  return `<div class="empty">
    <div class="e-icon">${icon}</div>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(desc)}</p>
    ${actionsHtml}
  </div>`;
}

/** 折叠面板。 */
export function panel(title, bodyHtml, open = false, icon = '') {
  return `<div class="panel ${open ? 'is-open' : ''}">
    <button type="button" class="panel-head" data-action="toggle-panel">${icon}${escapeHtml(title)}
      ${ICONS.chevronRight}
    </button>
    <div class="panel-body" ${open ? '' : 'hidden'}>${bodyHtml}</div>
  </div>`;
}

/** 开关（按钮形式，44px 触控区）。 */
export function toggleSwitch(on, action, label) {
  // knob 用真实子元素而不是 ::after —— 伪元素没法被 Web Animations API 单独补间，
  // 而整页 innerHTML 重建后正是靠 WAAPI 把"旧位置→新位置"补出来的（见 main.js）。
  // data-switch-key 用于跨渲染识别同一个开关（action 在页内唯一）。
  return `<button type="button" class="switch ${on ? 'is-on' : ''}" data-action="${action}"
    data-switch-key="${escapeHtml(action)}"
    role="switch" aria-checked="${!!on}" aria-label="${escapeHtml(label || '')}"><span class="knob"></span></button>`;
}

/** 徽标。 */
/**
 * 二级页顶栏：左边返回、右边标题。
 * @param {string} title
 * @param {string} backHref 例如 '#/settings'
 * @param {string} [sub]
 */
export function subTopbar(title, backHref, sub = '') {
  return `<div class="topbar">
    <div class="topbar-row">
      <button type="button" class="icon-btn" data-action="nav" data-route="${backHref}" aria-label="返回">${
        ICONS.chevronLeft
      }</button>
      <div class="grow">
        <h1>${escapeHtml(title)}</h1>
        ${sub ? `<p class="sub">${escapeHtml(sub)}</p>` : ''}
      </div>
    </div>
  </div>`;
}

/**
 * 列表式入口（点进二级页）。长列表一律走这个，别把十几行摊在主页面。
 * @param {string} href 目标 hash
 * @param {string} label
 * @param {string} [value] 右侧摘要
 * @param {string} [desc] 副标题
 */
export function entryRow(href, label, value = '', desc = '') {
  return `<a class="entry-row" href="${href}">
    <span class="entry-main">
      <span class="entry-label">${escapeHtml(label)}</span>
      ${desc ? `<span class="entry-desc">${escapeHtml(desc)}</span>` : ''}
    </span>
    <span class="entry-value">${escapeHtml(value)}<i class="entry-chev">›</i></span>
  </a>`;
}

export function badge(text, kind = '') {
  return `<span class="badge ${kind ? `badge-${kind}` : ''}">${escapeHtml(text)}</span>`;
}

/* ---------------------------------------------------------------- 示例数据 */

/**
 * 8 门「北邮风格」示例课 + 3 条调整（停课 / 改教室 / 补课），
 * 学期起始日取「本周周一」，保证点开就能看到本周完整效果。
 */
export function sampleState() {
  const today = todayStr();
  const monday = addDays(today, 1 - dayOfWeekOf(today));
  const base = createEmptyState();
  base.settings.semesterStartMonday = monday;
  base.settings.totalWeeks = 20;
  base.settings.reminder.defaultAdvanceMinutes = 15;
  base.settings.reminder.rules = [];

  const courses = [
    { id: 'c1', name: '高等数学(上)', teacher: '王建民', color: '#013A89', note: '带计算器' },
    { id: 'c2', name: '大学物理(下)', teacher: '李明', color: '#0E7490', note: '' },
    { id: 'c3', name: '数据结构', teacher: '赵晓', color: '#7C3AED', note: '实验课在教三-机房' },
    { id: 'c4', name: '大学英语', teacher: 'Sarah', color: '#C2410C', note: '' },
    { id: 'c5', name: '概率论与数理统计', teacher: '孙涛', color: '#1D4ED8', note: '' },
    { id: 'c6', name: '计算机网络', teacher: '周宏', color: '#BE123C', note: '' },
    { id: 'c7', name: '体育（羽毛球）', teacher: '刘磊', color: '#475569', note: '体育馆二层' },
    { id: 'c8', name: '毛概', teacher: '陈静', color: '#A16207', note: '' }
  ];
  base.courses = courses.map((c) => ({
    ...c,
    credit: null,
    createdAt: '2026-01-01T00:00:00+08:00',
    updatedAt: '2026-01-01T00:00:00+08:00'
  }));

  const all = { start: 1, end: 16, type: 'all', extra: [] };
  base.sessions = [
    { id: 's1', courseId: 'c1', dayOfWeek: 1, startPeriod: 1, endPeriod: 2, location: '教三-201', weeks: all, rawWeeksText: '1-16周', teacher: null, sourceRef: 'sample' },
    { id: 's2', courseId: 'c2', dayOfWeek: 1, startPeriod: 3, endPeriod: 4, location: '教四-105', weeks: all, rawWeeksText: '1-16周', teacher: null, sourceRef: 'sample' },
    { id: 's3', courseId: 'c3', dayOfWeek: 2, startPeriod: 1, endPeriod: 2, location: '教三-305', weeks: all, rawWeeksText: '1-16周', teacher: null, sourceRef: 'sample' },
    { id: 's4', courseId: 'c4', dayOfWeek: 2, startPeriod: 3, endPeriod: 4, location: '主楼-410', weeks: { start: 1, end: 16, type: 'odd', extra: [] }, rawWeeksText: '1-16周(单)', teacher: null, sourceRef: 'sample' },
    { id: 's5', courseId: 'c5', dayOfWeek: 3, startPeriod: 5, endPeriod: 6, location: '教二-208', weeks: all, rawWeeksText: '1-16周', teacher: null, sourceRef: 'sample' },
    { id: 's6', courseId: 'c6', dayOfWeek: 4, startPeriod: 1, endPeriod: 2, location: '教三-101', weeks: all, rawWeeksText: '1-16周', teacher: null, sourceRef: 'sample' },
    { id: 's7', courseId: 'c7', dayOfWeek: 4, startPeriod: 7, endPeriod: 8, location: '体育馆-2F', weeks: all, rawWeeksText: '1-16周', teacher: null, sourceRef: 'sample' },
    { id: 's8', courseId: 'c8', dayOfWeek: 5, startPeriod: 3, endPeriod: 4, location: '教二-101', weeks: all, rawWeeksText: '1-16周', teacher: null, sourceRef: 'sample' }
  ];

  const thursday = addDays(monday, 3);
  const saturday = addDays(monday, 5);
  base.adjustments = [
    {
      id: 'a1',
      date: addDays(monday, 0),
      type: 'roomChange',
      targetSessionId: 's2',
      courseId: 'c2',
      startPeriod: null,
      endPeriod: null,
      startTime: null,
      endTime: null,
      location: '教四-210',
      note: '教室设备检修',
      createdAt: '2026-01-01T00:00:00+08:00'
    },
    {
      id: 'a2',
      date: thursday,
      type: 'cancel',
      targetSessionId: 's6',
      courseId: 'c6',
      startPeriod: null,
      endPeriod: null,
      startTime: null,
      endTime: null,
      location: null,
      note: '老师出差，本次停课',
      createdAt: '2026-01-01T00:00:00+08:00'
    },
    {
      id: 'a3',
      date: saturday,
      type: 'makeup',
      targetSessionId: null,
      courseId: 'c6',
      startPeriod: 5,
      endPeriod: 6,
      startTime: null,
      endTime: null,
      location: '教三-101',
      note: '补周四停掉的课',
      createdAt: '2026-01-01T00:00:00+08:00'
    }
  ];

  return base;
}

/** 文本通道的示例文案（导入页「填充示例」按钮）。 */
export const SAMPLE_TEXT = `周一 1-2节 高等数学(上) 教三-201 王建民 1-16周
周一 3-4节 大学物理(下) 教四-105 李明 1-16周
周二 1-2节 数据结构 教三-305 赵晓 1-16周
周二 3-4节 大学英语 主楼-410 Sarah 1-16周(单)
周三 5-6节 概率论与数理统计 教二-208 孙涛 1-16周
周四 1-2节 计算机网络 教三-101 周宏 1-16周
周四 7-8节 体育(羽毛球) 体育馆-2F 刘磊 1-8,10-16周
周五 3-4节 毛概 教二-101 陈静 1-16周`;
