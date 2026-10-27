/**
 * ui/dragdrop.js — 课表块「长按拖动 → 换到本周其他时段」。
 *
 * 【为什么不用 HTML5 拖放】
 * 安卓 WebView 里 `dragstart` 对触摸基本不触发，`dragover/drop` 也没法给出跟手反馈。
 *
 * 【为什么是长按，而不是加一个拖动手柄】
 * 课表格子被块占满，如果整块直接可拖、或加一个小手柄，手指想上下滚动课表时会先被抓住。
 * 长按 220ms 才进入拖动：短按仍然是「打开详情」，纵向滑动仍然是滚动，三者不打架。
 *
 * 【为什么用 document 级委托】
 * 课表每次 dispatch 都整块重绘，块元素是新对象；委托到 document 才不会丢监听。
 */

/**
 * 长按多久算"要挪课"。
 *
 * 原来是 220ms —— 太短了。课表页几乎被课程块铺满，用户想上下滚一下就正好按在块上，
 * 手指还没动够 220ms 就被判成长按，于是页面定住不动（真机录屏里 3.3 秒只挪了 20px）。
 * 拖拽改课是低频操作，多等 0.2 秒没关系；误触抢走滚动却是每次都会碰上的。
 */
const LONG_PRESS_MS = 500;
/** 长按判定期间允许的手指抖动（超过就当成滚动意图，直接放行）。 */
const MOVE_TOLERANCE = 10;

/**
 * 装上拖动。
 * @param {{onDrop:(src:object, target:{date:string, period:number})=>boolean,
 *          getHint?:(src:object)=>string}} opts
 *   onDrop 返回 true 表示真的移动了（调用方负责提示 / 撤销）。
 * @returns {() => void} 卸载函数
 */
export function installBlockDrag(opts = {}) {
  if (typeof document === 'undefined') return () => {};

  let press = null; // { el, src, x, y, timer }
  let drag = null; // { el, src, ghost, target, span, w, h, grabX, grabY }

  const onDrop = typeof opts.onDrop === 'function' ? opts.onDrop : () => false;

  /**
   * 按下时就把上下文抠出来存好。
   * ★ 不能只存元素引用：store 每次 dispatch 之后 200ms 还有一次落盘通知，
   *   订阅方会因此重绘，块元素就地被替换成新对象。拖到一半元素被换掉不该让拖动失效。
   */
  function readSrc(el) {
    const start = Number(el.dataset.gs);
    const end = Number(el.dataset.ge);
    const ok = Number.isFinite(start) && Number.isFinite(end) && end >= start;
    return {
      date: el.dataset.date,
      name: el.dataset.dname || '',
      start,
      end,
      /** 课程原本占几节（连堂课 2 节、三连节 3 节…）。影子和落点都按这个数铺开。 */
      span: ok ? end - start + 1 : 1,
      sessionId: el.dataset.sid || null,
      courseId: el.dataset.cid || null,
      dtype: el.dataset.dtype || '',
      daid: el.dataset.daid || null,
      location: el.dataset.dloc || ''
    };
  }

  /** 找落点：优先格子；落在别的块上就取那个块的起点（"放到这门课上"也说得通）。 */
  function targetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || !el.closest) return null;
    const slot = el.closest('.tt-slot');
    if (slot) return { date: slot.dataset.date, period: Number(slot.dataset.period) };
    const block = el.closest('.tt-block[data-date]');
    if (block) return { date: block.dataset.date, period: Number(block.dataset.gs) };
    return null;
  }

  /** 落位矩形：首格左上 → 末格右下。按"格"算，不按手指算，所以格数永远等于课程原本的格数。 */
  function footprintOf(first, last) {
    const a = first.getBoundingClientRect();
    const b = last.getBoundingClientRect();
    return { left: a.left, top: a.top, width: a.width, height: b.bottom - a.top };
  }

  /** 把影子贴到足迹上：看到的那一整块，就是松手后落地的那一整块。 */
  function snapGhostTo(rect) {
    if (!drag || !drag.ghost) return;
    drag.w = Math.round(rect.width);
    drag.h = Math.round(rect.height);
    drag.ghost.style.width = `${drag.w}px`;
    drag.ghost.style.height = `${drag.h}px`;
    drag.ghost.style.left = `${Math.round(rect.left)}px`;
    drag.ghost.style.top = `${Math.round(rect.top)}px`;
  }

  /**
   * 高亮落点：按课程原本的格数整段铺开，并把影子贴上去。
   * 只亮一格会让人以为"落地后只剩一节"，尤其连堂课；这里从落点开始铺满 span 格，
   * 首尾格加圆角与横边连成一个整块。用格子本身做定位，任何屏幕尺寸 / 行高都自动对齐，
   * 不需要额外叠一层绝对定位的蒙层去算坐标。
   */
  function paintTarget(target) {
    for (const el of document.querySelectorAll('.tt-slot.is-drop-target')) {
      el.classList.remove('is-drop-target', 'is-drop-first', 'is-drop-last');
    }
    if (!target) return;
    const span = drag && drag.span > 0 ? drag.span : 1;
    let first = null;
    let last = null;
    for (let i = 0; i < span; i += 1) {
      const slot = document.querySelector(
        `.tt-slot[data-date="${target.date}"][data-period="${target.period + i}"]`
      );
      if (!slot) break; // 越过当天最后一节就不再画：放下时会被拒，这里先如实反映"放不下"
      slot.classList.add('is-drop-target');
      if (!first) first = slot;
      last = slot;
    }
    if (!first) return;
    first.classList.add('is-drop-first');
    last.classList.add('is-drop-last');
    snapGhostTo(footprintOf(first, last));
  }

  function clearPress() {
    if (press && press.timer) clearTimeout(press.timer);
    press = null;
  }

  function stopDrag() {
    if (!drag) return;
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    if (drag.el) drag.el.classList.remove('is-dragging');
    paintTarget(null);
    document.body.classList.remove('is-dragging-block');
    drag = null;
  }

  /**
   * 进入拖动：影子按"课程原本的格数"造，和课表里的块一样大小，并把块本身压暗。
   * ★ 尺寸直接取原块的真实矩形（连堂课就是两节的高度），随后由 paintTarget 贴到落点足迹上，
   *   所以影子的格数永远等于课程实际格数，不会随屏幕变化。
   */
  function beginDrag(pointer, el, src) {
    const rect = el.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.width = `${Math.round(rect.width)}px`;
    ghost.style.height = `${Math.round(rect.height)}px`;

    const nameEl = document.createElement('span');
    nameEl.className = 'dg-name';
    nameEl.textContent = src.name || (el.textContent || '').trim();
    const metaEl = document.createElement('span');
    metaEl.className = 'dg-meta';
    const span = src.span > 0 ? src.span : 1;
    metaEl.textContent = span > 1 ? `${src.start}-${src.end} 节` : `${src.start} 节`;
    ghost.append(nameEl, metaEl);
    ghost.setAttribute('aria-hidden', 'true');
    document.body.appendChild(ghost);

    drag = {
      el,
      src,
      ghost,
      target: null,
      span,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      // 手指还没进网格（没有落点）时，影子按"抓着哪一处"跟手，别像块砖一样拍在屏幕顶上。
      grabX: pointer.clientX - rect.left,
      grabY: pointer.clientY - rect.top,
      // 起拖位置 + 有没有判过方向（见 onPointerMove 里"这一下到底是滚还是拖"）
      originX: pointer.clientX,
      originY: pointer.clientY,
      dirChecked: false
    };
    el.classList.add('is-dragging');
    document.body.classList.add('is-dragging-block');
    // 长按点本来就落在自己身上：先贴到自己那块（影子像"从课表里被拎起来"），
    // 之后手指一动就会跟着落点换格子。
    const initial = targetAt(pointer.clientX, pointer.clientY);
    if (initial) {
      drag.target = initial;
      paintTarget(initial);
    } else {
      placeGhost(pointer.clientX, pointer.clientY);
    }
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(12); // 长按反馈，桌面与不支持振动的设备静默跳过
      } catch (err) {
        /* 忽略 */
      }
    }
  }

  /**
   * 手指移到网格外、没有落点时的兜底摆放：保持"抓取点贴手指"，并夹在视口内。
   */
  function placeGhost(x, y) {
    if (!drag || !drag.ghost) return;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const left = Math.min(Math.max(x - drag.grabX, 4), Math.max(4, vw - drag.w - 4));
    const top = Math.min(Math.max(y - drag.grabY, 4), Math.max(4, vh - drag.h - 4));
    drag.ghost.style.left = `${Math.round(left)}px`;
    drag.ghost.style.top = `${Math.round(top)}px`;
  }

  /* ---------------------------------------------------------- 事件 */

  function onPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    const el = event.target instanceof Element ? event.target.closest('.tt-block[data-drag="1"]') : null;
    if (!el) return;
    clearPress();
    press = {
      el,
      src: readSrc(el),
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        const pending = press;
        if (!pending) return;
        press = null;
        beginDrag({ clientX: pending.x, clientY: pending.y }, pending.el, pending.src);
      }, LONG_PRESS_MS)
    };
  }

  function onPointerMove(event) {
    // 还没进入拖动：手指动了就说明想滚动，放弃长按
    if (press && !drag) {
      const dx = Math.abs(event.clientX - press.x);
      const dy = Math.abs(event.clientY - press.y);
      if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) clearPress();
      return;
    }
    if (!drag) return;
    // ★ 这一下到底是"滚页面"还是"挪课程"？
    //   课表页几乎被课程块铺满，手指很容易落在块上；长按一起拖就把滑动手势抢走了，
    //   表现是"怎么划都不动"，更糟的是松手时把课挪到了别处。
    //   所以拖起来之后第一段位移必须判方向：明显上下走（且不是斜着拖格）就判为用户想滚动，
    //   立刻放弃这次拖拽 —— 宁可让他多滑一次，也不能默默改课表。
    if (!drag.dirChecked) {
      const dx = Math.abs(event.clientX - drag.originX);
      const dy = Math.abs(event.clientY - drag.originY);
      if (dy > 24 && dy > dx * 2) {
        stopDrag();
        return;
      }
      if (dx > 10 || dy > 10) drag.dirChecked = true;
    }
    if (event.cancelable) event.preventDefault();
    const target = targetAt(event.clientX, event.clientY);
    const changed =
      !drag.target ||
      !target ||
      target.date !== drag.target.date ||
      target.period !== drag.target.period;
    if (changed) {
      drag.target = target;
      paintTarget(target); // 会顺带把影子贴到落点的整段格数上
    }
    // 手指滑出网格（没有落点）时，影子跟着手指走，不然会钉在最后一格上装作还在拖
    if (!target) placeGhost(event.clientX, event.clientY);
  }

  /**
   * 拖完要吃掉紧随其后的那次 click。
   * 不然手指抬起时浏览器照常派发 click → 刚放下就弹出「课程详情」，等于白拖一次。
   * 只吃一次、且 300ms 后自动失效：用户马上点提示条上的「撤销」不能被误吞。
   */
  function suppressNextClick() {
    const stop = (event) => {
      event.stopPropagation();
      event.preventDefault();
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener('click', stop, true);
      clearTimeout(timer);
    };
    const timer = setTimeout(cleanup, 300);
    window.addEventListener('click', stop, true);
  }

  function onPointerUp(event) {
    clearPress();
    if (!drag) return;
    const target = drag.target || targetAt(event.clientX, event.clientY);
    const src = drag.src;
    stopDrag();
    suppressNextClick();
    if (!target || !src) return;
    if (target.date === src.date && target.period === src.start) return; // 原地放下，不算移动
    onDrop(src, target);
  }

  function onPointerCancel() {
    clearPress();
    stopDrag();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && (drag || press)) {
      clearPress();
      stopDrag();
    }
  }

  /** 页面一滚就认定"用户想滑动"，把拖拽收掉，别让他边滚边拖。 */
  function onWindowScroll() {
    if (drag) stopDrag();
    if (press) clearPress();
  }

  // touchmove 必须是非 passive 才拦得住"拖动时页面跟着滚"
  function onTouchMove(event) {
    if (!drag) return;
    if (event.cancelable) event.preventDefault();
  }

  document.addEventListener('pointerdown', onPointerDown, { passive: true });
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('keydown', onKeyDown);
  // 双保险：页面已经滚起来了就说明用户是在滑动，立刻放弃这次拖拽。
  // （`touch-action: pan-y` 下浏览器接管滚动时会先派 pointercancel，正常轮不到这里；
  //   但慢速/异常手势下 cancel 不一定及时，这条兜底能保证不会"边滚边拖"。）
  window.addEventListener('scroll', onWindowScroll, { passive: true });

  return () => {
    clearPress();
    stopDrag();
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('scroll', onWindowScroll);
  };
}
