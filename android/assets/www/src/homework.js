/**
 * homework.js — 「查看作业」的数据层（纯函数，不碰 DOM、不碰网络）。
 *
 * 数据来自学校「云邮教学空间」(ucloud) 的两个接口，由原生侧的 HomeworkGrabber
 * 在隐藏 WebView 里取回来（见 android/java/.../HomeworkGrabber.java）：
 *
 *   ① GET /ykt-site/site/student/undone?userId=…       → 待办列表
 *   ② GET /ykt-site/work/detail?assignmentId=…         → 单条详情（正文是 HTML）
 *
 * 这一层只做三件事：**归一化 → 排序 → 算剩余时间**。
 * 界面拿到的是干净的 `HomeworkItem`，不认识学校的字段名。
 *
 * ★ 为什么不直接把接口响应塞进 state：
 *   学校字段是 `activityName` / `endTime` / `assignmentStatus` 这种，
 *   而且 `endTime` 是 `"2026-12-31 23:59:59"` 这种带秒的本地时间串（不是 ISO）。
 *   散落各处解析，早晚会有一处写成 `new Date("2026-12-31 23:59:59")` —— 那是**非法格式**，
 *   Safari/旧 WebView 直接 Invalid Date。所以统一在这里解析一次。
 */

/** 一条待办的归一化结果。 */
export const EMPTY_ITEM = Object.freeze({
  id: '',
  title: '',
  due: '', // 'YYYY-MM-DD HH:mm:ss'，原样保留（展示用）
  dueMs: 0, // 毫秒时间戳；0 = 没给截止时间
  courseName: '',
  type: 0
});

/**
 * 解析学校那种「本地时间串」。
 *
 * ★ 必须手动拼，不能 `new Date(str)`：
 *   `"2026-12-31 23:59:59"` 不是 ECMAScript 规定的格式，各引擎解析结果不一致
 *   （有的当本地时间、有的直接 NaN）。这里显式按本地时区构造。
 *
 * @returns {number} 毫秒时间戳；格式不对返回 0
 */
export function parseDue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 0;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return 0;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const h = Number(m[4] || 0);
  const mi = Number(m[5] || 0);
  const sec = Number(m[6] || 0);

  // ★ 光靠正则不够：`2026-13-01` 会被 Date 顺延成 2027-01-01，
  //   `2026-02-31` 会变成 3 月 3 日 —— 都是"看起来成功、其实错了"。
  //   所以构造完再回读一遍，对不上就判非法。
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return 0;
  if (h > 23 || mi > 59 || sec > 59) return 0;

  const dt = new Date(y, mo, d, h, mi, sec);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return 0;
  return Number.isFinite(dt.getTime()) ? dt.getTime() : 0;
}

/**
 * 从一条原始记录里取出「哪门课布置的」。
 *
 * 学校这套接口对课程名的字段不统一：列表里实测是 `siteName`（"站点名"=课程），
 * 但同一家的详情接口用的是 `courseName`，个别版本还会把课程塞进 `site` / `course`
 * 对象里。写死一个字段，换个接口版本课程名就空了 —— 而"这是哪门课的作业"
 * 恰恰是学生判断优先级的第一依据。
 *
 * @returns {string} 取不到返回空串（界面会隐藏课程标签，不编造）
 */
export function pickCourseName(row) {
  const r = row && typeof row === 'object' ? row : {};
  const txt = (v) => (v == null ? '' : String(v).trim());
  const direct = [r.siteName, r.courseName, r.siteTitle, r.courseTitle, r.subject];
  for (const v of direct) {
    const s = txt(v);
    if (s) return s;
  }
  const nested = [r.site, r.course];
  for (const o of nested) {
    if (o && typeof o === 'object') {
      const s = txt(o.name) || txt(o.siteName) || txt(o.courseName) || txt(o.title);
      if (s) return s;
    }
  }
  return '';
}

/**
 * 把 `site/student/undone` 的响应归一化成列表。
 *
 * 接口形如：
 * ```json
 * { "siteNum": 12, "undoneNum": 5,
 *   "undoneList": [ { "activityId": "…", "activityName": "…",
 *                     "endTime": "2026-12-31 23:59:59", "type": 3 } ] }
 * ```
 *
 * ★ 排序规则：**截止时间升序，没有截止时间的排最后**。
 *   待办列表的价值就在"哪个先到期"，让用户自己找等于没做。
 *
 * @param {any} payload 接口返回的 `data` 字段（不是整个响应体）
 * @returns {{items:Array, total:number, undone:number}}
 */
export function normalizeList(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const raw = Array.isArray(data.undoneList) ? data.undoneList : [];

  const items = raw
    .map((row) => {
      const r = row && typeof row === 'object' ? row : {};
      const due = String(r.endTime == null ? '' : r.endTime).trim();
      return {
        id: String(r.activityId == null ? '' : r.activityId),
        title: String(r.activityName == null ? '' : r.activityName).trim(),
        due,
        dueMs: parseDue(due),
        courseName: pickCourseName(r),
        type: Number(r.type) || 0
      };
    })
    // 没有 id 的条目没法打开详情，直接丢掉（学校偶尔会回空行）
    .filter((it) => it.id !== '' && it.title !== '');

  items.sort((a, b) => {
    if (a.dueMs && b.dueMs) return a.dueMs - b.dueMs;
    if (a.dueMs) return -1; // 有截止时间的排前面
    if (b.dueMs) return 1;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });

  return {
    items,
    total: Number(data.siteNum) || 0,
    undone: Number(data.undoneNum) || items.length
  };
}

/** 剩余天数（向下取整到"天"）。已过期返回负数。 */
export function daysLeft(dueMs, now) {
  if (!dueMs) return null;
  const diff = dueMs - Number(now || 0);
  // 用 ceil 而不是 floor：还剩 3 小时也应该显示"1 天"，显示 0 天会让人以为今天到期
  return Math.ceil(diff / 86400000);
}

/**
 * 剩余时间的人话说法。
 *
 * 文案约定（和全站一致）：一行只说一件事，短句，不用"截止"以外的技术词。
 */
export function dueLabel(item, now) {
  const ms = item && item.dueMs ? item.dueMs : 0;
  if (!ms) return '没有截止时间';
  const left = ms - Number(now || 0);
  if (left <= 0) return '已截止';
  const d = Math.ceil(left / 86400000);
  if (d <= 1) {
    // 一天以内：说小时更准，说"1 天"用户会以为明天
    const h = Math.max(1, Math.ceil(left / 3600000));
    return h <= 1 ? '不到 1 小时' : `还剩 ${h} 小时`;
  }
  return `还剩 ${d} 天`;
}

/** 是否紧急（7 天内到期）。列表用它标红。 */
export function isUrgent(item, now) {
  const ms = item && item.dueMs ? item.dueMs : 0;
  if (!ms) return false;
  const left = ms - Number(now || 0);
  return left > 0 && left <= 7 * 86400000;
}

/* ------------------------------------------------------------------ 详情 */

/**
 * 详情正文的安全过滤。
 *
 * ★ 正文是学校编辑器产出的 HTML，直接 innerHTML 有 XSS 风险
 *   （哪怕内容来自学校，也不该把"能执行脚本的字符串"塞进我们的页面）。
 *   这里用**白名单**：只保留排版标签，其余一律丢掉，属性只留 class。
 *
 * 白名单刻意很短 —— 作业正文实际只用得到段落、加粗、列表、换行。
 */
const ALLOWED_TAGS = new Set([
  'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S',
  'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4',
  'BLOCKQUOTE', 'PRE', 'CODE', 'SPAN', 'DIV', 'A',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'IMG'
]);

/** 需要整块丢弃的标签（连同内容一起）。 */
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META']);

/**
 * 把学校给的 HTML 正文变成可以安全插入页面的 HTML 串。
 *
 * @param {string} html 原始 HTML
 * @returns {string} 过滤后的 HTML
 */
export function sanitizeHtml(html) {
  const src = String(html == null ? '' : html);
  if (!src) return '';

  // 浏览器里才做真解析；测试环境（node）没有 DOM，退回"去标签只留文本"的保守做法
  if (typeof document === 'undefined' || !document.createElement) {
    return src
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  const box = document.createElement('div');
  box.innerHTML = src;

  const walk = (node) => {
    const kids = Array.from(node.childNodes || []);
    kids.forEach((child) => {
      if (child.nodeType === 3) return; // 文本节点，保留
      if (child.nodeType !== 1) {
        child.remove();
        return;
      }
      const tag = String(child.tagName || '').toUpperCase();

      if (DROP_TAGS.has(tag)) {
        child.remove();
        return;
      }
      if (!ALLOWED_TAGS.has(tag)) {
        // 不认识的标签：保留里面的文字，去掉标签本身
        const text = document.createTextNode(child.textContent || '');
        child.replaceWith(text);
        return;
      }

      // 属性只留 href（链接）和 src/alt（图片），其余全删 —— 特别是 on* 事件
      Array.from(child.attributes || []).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const keep =
          (tag === 'A' && name === 'href') ||
          (tag === 'IMG' && (name === 'src' || name === 'alt'));
        if (!keep) child.removeAttribute(attr.name);
      });
      if (tag === 'A') {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noreferrer noopener');
      }
      walk(child);
    });
  };

  walk(box);
  return box.innerHTML;
}

/**
 * 归一化详情响应。
 *
 * @param {any} data 接口返回的 `data` 字段
 */
export function normalizeDetail(data) {
  const d = data && typeof data === 'object' ? data : {};
  const due = String(d.assignmentEndTime == null ? '' : d.assignmentEndTime).trim();
  return {
    id: String(d.id == null ? '' : d.id),
    title: String(d.assignmentTitle == null ? '' : d.assignmentTitle).trim(),
    contentHtml: sanitizeHtml(d.assignmentContent),
    // ★ className 实测是「[2026219101-2026219103]班,2026299101班」这种**班级范围**，
    //   不是课程名。以前把它塞进 courseName，界面会冒出一长串班级号。
    classes: String(d.className == null ? '' : d.className).trim(),
    begin: String(d.assignmentBeginTime == null ? '' : d.assignmentBeginTime).trim(),
    due,
    dueMs: parseDue(due),
    fullMark: Number(d.fullMark) || 0,
    score: Number(d.assignmentScore),
    allowLate: Number(d.isOvertimeCommit) === 1
  };
}
