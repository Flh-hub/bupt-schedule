/**
 * grab.js — 「输入学号密码 → 后台自动抓取」这条任务的**状态机**（纯逻辑，无 DOM）。
 *
 * 【为什么单独一层】
 * 抓取发生在原生侧（隐藏 WebView 里跑真实的教务系统页面），网页层只看到一串事件：
 * 进度、结果、失败。这些事件会乱序、会重复、会在用户已经取消了之后才姗姗来迟
 * （网络慢的时候尤其明显）。如果 UI 直接拿事件画界面，就会看到进度条倒着走、
 * 失败卡片被一条迟到的进度顶掉、或者点了取消还在转圈。
 *
 * 所以这里定三条铁律，全部由 applyGrabEvent 保证，UI 只管照着状态画：
 *   ① **进度只增不减**，且不超过当前步骤的上限（"登录中 90%" 是错的）；
 *   ② **终态不可覆盖**：一旦 failed / done，任何后来的事件都丢掉（取消后迟到的结果不能把人拽回去）；
 *   ③ **事件必须属于本次任务**：带 id 且对不上的一律忽略（上一次抓取的残留不能污染这一次）。
 *
 * 时间一律由调用方传入 `now`，本文件不读系统时间——Node 里才好测。
 */

/** 抓取的五个阶段。`from`/`to` 是进度条区间，原生侧也会发 percent，两者取可信者。 */
export const GRAB_STEPS = [
  { key: 'connect', label: '连接教务系统', from: 0, to: 10 },
  { key: 'login', label: '登录', from: 10, to: 32 },
  { key: 'find', label: '打开课表', from: 32, to: 58 },
  { key: 'read', label: '读取课表', from: 58, to: 82 },
  { key: 'parse', label: '解析并核对', from: 82, to: 99 }
];

const STEP_INDEX = new Map(GRAB_STEPS.map((s, i) => [s.key, i]));

/** 事件里出现未知 step 时的兜底（保留当前步骤，只更新文字）。 */
function stepOf(key, fallback) {
  return STEP_INDEX.has(key) ? key : fallback;
}

function stepIndex(key) {
  const i = STEP_INDEX.get(key);
  return i == null ? 0 : i;
}

function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * 失败码 → 用户能看懂的一句话 + 下一步该干什么。
 *
 * `manual: true` 表示"自动这条路走不通了，但手动抓取一定能导进来"——
 * 这类失败必须给出手动入口，否则用户就被卡死了（验证码是最典型的）。
 */
export const GRAB_ERRORS = {
  no_network: {
    title: '连不上教务系统',
    hint: '教务系统只在校内网能访问。连上校园网或学校 VPN 再试；如果已经在校园网，可能是教务系统临时故障。',
    manual: true
  },
  bad_credentials: {
    title: '学号或密码不对',
    hint: '请检查后重试。连着输错可能触发账号锁定，也可以改用手动抓取（只影响这台手机，不动学校账号）。',
    manual: true
  },
  captcha: {
    title: '教务系统要输验证码',
    hint: '有验证码时自动登录做不了，请用手动抓取：在 App 里登录一次，看到课表后点抓取即可。',
    manual: true
  },
  no_form: {
    title: '找不到登录框',
    hint: '教务系统页面可能改版了。请先用手动抓取导一次，这部分我们会跟着适配。',
    manual: true
  },
  no_timetable: {
    title: '登录成功，但没找到课表页',
    hint: '可能这学期还没排课，或者课表页换了地址。可以手动进入「课表查询」，看到整周课表后抓取。',
    manual: true
  },
  timeout: {
    title: '抓取超时',
    hint: '校园网或教务系统比较慢。可以直接重试；如果反复超时，改用手动抓取更稳。',
    manual: true
  },
  read_failed: {
    title: '抓到的内容读不出来',
    hint: '读到的课表数据不完整，本地课表没有任何改动。重试一次通常就好。',
    manual: true
  },
  parse_failed: {
    title: '抓到页面了，但没认出课程',
    hint: '课表格式可能变了。源码已经留在这个页面下方，可以手动核对；也可以改用手动抓取。',
    manual: true
  },
  cancelled: {
    title: '已取消抓取',
    hint: '本地课表没有改动。随时可以重新抓。',
    manual: false
  },
  busy: {
    title: '已经有一个抓取在进行',
    hint: '等它结束再点，或者先取消上一次。',
    manual: false
  },
  unsupported: {
    title: '当前环境不支持自动抓取',
    hint: '自动抓取需要 App 内置的浏览器。在网页版里请用下方的粘贴 / HTML 导入。',
    manual: false
  },
  unknown: {
    title: '抓取没能完成',
    hint: '本地课表没有任何改动。可以重试，或者改用手动抓取。',
    manual: true
  }
};

export function grabErrorInfo(code) {
  return GRAB_ERRORS[code] || GRAB_ERRORS.unknown;
}

export function isGrabErrorCode(code) {
  // ★ 必须用 hasOwnProperty：`'toString' in GRAB_ERRORS` 会命中原型链，
  //   把任意对象自带的方法名当成合法失败码，最后显示一条 undefined 的文案。
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(GRAB_ERRORS, code);
}

/**
 * 新建一次抓取任务。
 * @param {string} id 本次任务号（原生侧会带着同一个 id 回事件）
 * @param {number} [now]
 */
export function createGrab(id, now = 0) {
  return {
    id: String(id == null ? '' : id),
    status: 'running', // running | failed | done
    step: 'connect',
    percent: 0,
    text: '正在连接教务系统…',
    startedAt: Number(now) || 0,
    updatedAt: Number(now) || 0,
    error: null,
    detail: ''
  };
}

/**
 * 吃一个原生事件，返回**新的**任务对象（不改入参）。
 *
 * @param {object|null} grab 当前任务
 * @param {{type:string,id?:string,step?:string,percent?:number,text?:string,code?:string,detail?:string}} event
 * @param {number} [now]
 */
export function applyGrabEvent(grab, event, now = 0) {
  if (!grab || grab.status !== 'running') return grab; // ② 终态不可覆盖
  if (!event || typeof event !== 'object') return grab;

  const id = event.id == null ? '' : String(event.id);
  if (id && grab.id && id !== grab.id) return grab; // ③ 不是本次任务的事件

  const stamp = Number(now) || grab.updatedAt;

  if (event.type === 'progress') {
    const step = stepOf(event.step, grab.step);
    const meta = GRAB_STEPS[stepIndex(step)];
    // 不允许倒退到更早的步骤：乱序事件只会被"忽略"，不会把进度条往回拽
    const advanced = stepIndex(step) >= stepIndex(grab.step) ? step : grab.step;
    const useMeta = GRAB_STEPS[stepIndex(advanced)];

    const raw = Number(event.percent);
    const wanted = Number.isFinite(raw) ? Math.round(raw) : useMeta.from;
    // ① 只增不减，且不越过当前步骤上限
    const percent = clamp(Math.max(wanted, grab.percent), grab.percent, Math.max(useMeta.to, grab.percent));

    return {
      ...grab,
      step: advanced,
      percent,
      text: typeof event.text === 'string' && event.text ? event.text : meta.label + '…',
      updatedAt: stamp
    };
  }

  if (event.type === 'error') {
    const code = isGrabErrorCode(event.code) ? event.code : 'unknown';
    return {
      ...grab,
      status: 'failed',
      step: grab.step,
      error: code,
      detail: String(event.detail || ''),
      text: grabErrorInfo(code).title,
      updatedAt: stamp
    };
  }

  if (event.type === 'done') {
    return {
      ...grab,
      status: 'done',
      step: 'parse',
      percent: 100,
      text: '抓取完成',
      updatedAt: stamp
    };
  }

  return grab;
}

/** 是否正在抓（按钮置灰、防重复点击都看这个）。 */
export function grabIsRunning(grab) {
  return !!grab && grab.status === 'running';
}

/** 这次任务是否已经结束（成功或失败都算）。 */
export function grabIsSettled(grab) {
  return !!grab && (grab.status === 'failed' || grab.status === 'done');
}

/** 已用秒数（结果卡片上会写"用时 8 秒"）。 */
export function grabElapsedSec(grab, now = 0) {
  if (!grab) return 0;
  const end = grab.status === 'running' ? Number(now) || grab.updatedAt : grab.updatedAt;
  const ms = end - grab.startedAt;
  return ms > 0 ? Math.round(ms / 1000) : 0;
}

/**
 * 前端自己的看门狗：原生侧的硬超时可能没来得及回调（进程被杀、WebView 崩了），
 * 这时页面不能永远转圈。超过 limitMs 就判失败。
 */
export function grabIsStalled(grab, now = 0, limitMs = 75000) {
  if (!grab || grab.status !== 'running') return false;
  const t = Number(now) || 0;
  if (!t || !grab.startedAt) return false;
  return t - grab.startedAt > limitMs;
}

/**
 * 步骤清单（UI 直接画）：done 打勾、active 高亮、todo 灰着。
 * @returns {Array<{key:string,label:string,state:'done'|'active'|'todo'}>}
 */
export function grabStepList(grab) {
  const current = grab ? stepIndex(grab.step) : -1;
  const settled = grabIsSettled(grab);
  const ok = grab && grab.status === 'done';
  return GRAB_STEPS.map((s, i) => {
    let state = 'todo';
    if (ok || i < current) state = 'done';
    else if (i === current) state = settled ? 'todo' : 'active';
    if (ok) state = 'done';
    return { key: s.key, label: s.label, state };
  });
}

/**
 * 进度条上的主文案。抓取中显示步骤名，结束时显示结论。
 * @param {object|null} grab
 * @param {number} [now]
 */
export function grabHeadline(grab, now = 0) {
  if (!grab) return '';
  if (grab.status === 'failed') return grabErrorInfo(grab.error).title;
  if (grab.status === 'done') return `抓取完成 · 用时 ${grabElapsedSec(grab, now)} 秒`;
  const sec = grabElapsedSec(grab, now);
  const tail = sec >= 3 ? `（${sec} 秒）` : '';
  return (grab.text || '正在抓取…') + tail;
}
