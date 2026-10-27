/**
 * parsers/html.js — 纯逻辑 HTML 适配器（零 DOM）。
 *
 * 【为什么不用 DOMParser】Node 测试环境没有 DOM。这里自研 `parseHtmlLite()`：
 *   用正则把 <table>/<tr>/<td>/<div> 压平成「带 rowspan/colspan 记账的网格」+「卡片块」+「文本行」。
 *   同一份代码在浏览器与 `node --test` 里行为一致 —— 这是「纯逻辑可测」的关键取舍，
 *   代价是选择器能力有限（够用：目标页面结构简单，且本就多策略降级）。
 *
 * ★ rowspan/colspan 占位记账是「静默错位杀手」：不做记账 → 从第 3 行起整列左移，
 *   解析出的星期全错但**不报错**。见 tests/parsers.test.mjs 用例 2。
 *
 * 适配器返回「预归一化」结果：sessions 里带 courseName（还没分配 courseId），
 * 由 parsers/index.js 的 normalize() 统一分配 id / 合并同名课程 / 裁剪周次。
 */

/* eslint-disable no-control-regex */

import { parseWeeksText, todayStr } from '../model.js';

/** 星期字符 → 1..7（周日 = 7）。 */
export function dowCharToNumber(ch) {
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };
  return map[ch] || null;
}

/** 从任意文本里抠出星期（1..7）。 */
export function dowFromText(text) {
  const t = String(text == null ? '' : text).replace(/\s/g, '');
  const m = t.match(/(?:星期|周|礼拜)\s*([一二三四五六日天1-7])/);
  if (m) return dowCharToNumber(m[1]);
  if (/^[一二三四五六日天]$/.test(t)) return dowCharToNumber(t);
  return null;
}

/** HTML 实体解码。 */
export function decodeEntities(input) {
  const s = String(input == null ? '' : input);
  return s
    // ★ 真实教务页面写的是 `&nbspO`（缺分号）：只匹配 `&nbsp;` 会漏，课名变成「数学分析(上) &nbspO」
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/gi, '&');
}

/** HTML → 纯文本（保留块级换行）。 */
export function htmlToText(html) {
  return String(html == null ? '' : html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|td|th|h[1-6]|section|article|dd|dt)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
}

/** HTML → 文本行数组（去空行、压缩空白）。 */
export function htmlToLines(html) {
  return decodeEntities(htmlToText(html))
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0\u3000]+/g, ' ').trim())
    .filter(Boolean);
}

/** ------------------------------------------------------------ HTML 压平器 */

const RAW_TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
const VOID_TAGS = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'col', 'area', 'base', 'source']);

function attrOf(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = String(attrs || '').match(re);
  if (!m) return null;
  return m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
}

function spanOf(attrs) {
  const rs = Number(attrOf(attrs, 'rowspan'));
  const cs = Number(attrOf(attrs, 'colspan'));
  return {
    rowspan: Number.isFinite(rs) && rs > 0 ? Math.min(rs, 30) : 1,
    colspan: Number.isFinite(cs) && cs > 0 ? Math.min(cs, 12) : 1
  };
}

/**
 * 提取所有 `<table>` 的内层 HTML —— 用标签栈配对，**支持嵌套**。
 * ★ 非贪婪正则 `/<table[^>]*>([\s\S]*?)<\/table>/` 会在遇到内层 `</table>` 时提前结束，
 *   外层表格的兄弟单元格全部静默丢失（用户看到"导入成功但课表少一半"）。
 * @param {string} html
 * @returns {string[]} 内层 HTML（内层表格先返回，因为它更早闭合）
 */
function extractTableInners(html) {
  const source = String(html == null ? '' : html);
  const out = [];
  const stack = [];
  const re = /<(\/?)table\b([^>]*)>/gi;
  let m = re.exec(source);
  while (m !== null) {
    if (m[1] === '/') {
      const node = stack.pop();
      if (node) out.push(source.slice(node.start, m.index));
    } else {
      stack.push({ start: re.lastIndex });
    }
    m = re.exec(source);
  }
  return out;
}

/**
 * 提取本层 `<tr>` 的内层 HTML（跳过嵌套表格里的 `<tr>`）。
 * @param {string} inner 单张表的内部 HTML
 * @returns {string[]}
 */
function extractRowInners(inner) {
  const out = [];
  const re = /<(\/?)(tr|table)\b([^>]*)>/gi;
  let tableDepth = 0;
  let cur = null;
  let m = re.exec(inner);
  while (m !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'table') {
      tableDepth += closing ? -1 : 1;
      m = re.exec(inner);
      continue;
    }
    if (tableDepth > 0) {
      m = re.exec(inner);
      continue; // 嵌套表格里的行不属于本表
    }
    if (closing) {
      if (cur) {
        out.push(inner.slice(cur, m.index));
        cur = null;
      }
    } else if (!cur) {
      cur = re.lastIndex;
    }
    m = re.exec(inner);
  }
  if (cur != null) out.push(inner.slice(cur)); // 容错：未闭合的行
  return out;
}

/**
 * 提取本行 `<td>/<th>` 的内层 HTML（跳过嵌套表格里的单元格）。
 * @param {string} rowHtml 单行的内部 HTML
 * @returns {Array<{attrs:string, inner:string}>}
 */
function extractCellInners(rowHtml) {
  const out = [];
  const re = /<(\/?)(td|th|table)\b([^>]*)>/gi;
  let tableDepth = 0;
  let cur = null;
  let m = re.exec(rowHtml);
  while (m !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'table') {
      tableDepth += closing ? -1 : 1;
      m = re.exec(rowHtml);
      continue;
    }
    if (tableDepth > 0) {
      m = re.exec(rowHtml);
      continue;
    }
    if (closing) {
      if (cur) {
        out.push({ attrs: cur.attrs, inner: rowHtml.slice(cur.start, m.index) });
        cur = null;
      }
    } else if (!cur) {
      cur = { attrs: m[3] || '', start: re.lastIndex };
    }
    m = re.exec(rowHtml);
  }
  if (cur != null) out.push({ attrs: cur.attrs, inner: rowHtml.slice(cur.start) });
  return out;
}

/**
 * 解析单张表 → 稠密网格（含 rowspan/colspan 占位）。
 * @param {string} inner <table> 内部 HTML
 * @returns {Array<Array<object>>} rows[r][c] = {text, rowspan, colspan, origin, r, c}
 */
export function parseTableInner(inner) {
  const rawRows = extractRowInners(inner).map((rowHtml) =>
    extractCellInners(rowHtml).map((cell) => {
      const span = spanOf(cell.attrs);
      return {
        text: htmlToLines(cell.inner).join('\n'),
        rowspan: span.rowspan,
        colspan: span.colspan
      };
    })
  );

  const occupied = new Map(); // 'r:c' -> cell
  const rows = [];
  rawRows.forEach((cells, r) => {
    const row = [];
    let ci = 0;
    let c = 0;
    let guard = 0;
    while (guard < 500) {
      guard += 1;
      const key = `${r}:${c}`;
      if (occupied.has(key)) {
        row[c] = occupied.get(key);
        c += 1;
        continue;
      }
      if (ci >= cells.length) break;
      const raw = cells[ci];
      ci += 1;
      const cell = {
        text: raw.text,
        rowspan: raw.rowspan,
        colspan: raw.colspan,
        origin: true,
        r,
        c
      };
      row[c] = cell;
      for (let dr = 0; dr < raw.rowspan; dr += 1) {
        for (let dc = 0; dc < raw.colspan; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          occupied.set(`${r + dr}:${c + dc}`, {
            text: cell.text,
            rowspan: raw.rowspan,
            colspan: raw.colspan,
            origin: false,
            r: r + dr,
            c: c + dc,
            from: cell
          });
        }
      }
      c += raw.colspan;
    }
    rows.push(row);
  });
  return rows;
}

/**
 * 抽取「同类容器块」的内层 HTML（用于企微卡片 / div 列表）。
 * 用标签栈做配对，比非贪婪正则可靠（能应对嵌套 div）。
 * @param {string} html
 * @param {RegExp} classRe 匹配 class 属性
 * @returns {Array<{cls:string, html:string}>}
 */
export function extractBlocks(html, classRe) {
  const blocks = [];
  const stack = [];
  const source = String(html == null ? '' : html);
  RAW_TAG_RE.lastIndex = 0;
  let m = RAW_TAG_RE.exec(source);
  while (m !== null) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    const isClose = full.startsWith('</');
    const isSelfClose = /\/\s*>$/.test(full) || VOID_TAGS.has(tag);

    if (isClose) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === tag) {
          const node = stack[i];
          stack.length = i;
          if (node.cls && classRe.test(node.cls)) {
            blocks.push({ cls: node.cls, html: source.slice(node.contentStart, m.index) });
          }
          break;
        }
      }
    } else if (!isSelfClose) {
      const cls = attrOf(attrs, 'class') || '';
      stack.push({ tag, cls, contentStart: RAW_TAG_RE.lastIndex });
    }
    m = RAW_TAG_RE.exec(source);
  }
  return blocks;
}

/**
 * HTML 轻量压平：表 + 卡片 + 文本行。
 * @param {string} html
 * @returns {{tables:Array, cards:Array, lines:string[]}}
 */
export function parseHtmlLite(html) {
  const source = String(html == null ? '' : html);
  const tables = [];
  for (const tableInner of extractTableInners(source)) {
    const rows = parseTableInner(tableInner);
    if (rows.length) {
      tables.push({
        rows,
        rowCount: rows.length,
        colCount: rows.reduce((max, row) => Math.max(max, row.length), 0)
      });
    }
  }

  const cardRe = /(course|card|item|lesson|kcb|kcinfo|class|subject|schedule|course-item|kcmc)/i;
  const rawCards = extractBlocks(source, cardRe).map((b) => ({
    cls: b.cls,
    lines: htmlToLines(b.html)
  }));

  // 只保留「像课表条目」的块：有星期/节次/周次任一特征且至少 2 行
  const cards = rawCards.filter((b) => {
    if (b.lines.length < 2 || b.lines.length > 16) return false;
    const joined = b.lines.join(' ');
    const hasDow = dowFromText(joined) !== null;
    const hasPeriod = /\d{1,2}\s*[-~—－至]\s*\d{1,2}\s*节|第\s*\d{1,2}\s*节/.test(joined);
    const hasWeeks = /\d{1,2}\s*[-~—－]\s*\d{1,2}\s*周|周次|单周|双周/.test(joined);
    return (hasDow && (hasPeriod || hasWeeks)) || (hasPeriod && hasWeeks);
  });

  return { tables, cards, lines: htmlToLines(source) };
}

/** ------------------------------------------------------------ 行类型标注 */

const RE_WEEKDAY = /(?:星期|周|礼拜)\s*[一二三四五六日天1-7]/;
const RE_PERIOD = /(?:第\s*)?\d{1,2}\s*[-~—－至]\s*\d{1,2}\s*节|(?:第\s*)?\d{1,2}\s*节/;
const RE_TIME_RANGE = /\d{1,2}:\d{2}\s*[-~—－至]\s*\d{1,2}:\d{2}/;
const RE_WEEKS = /周次|\d{1,2}\s*[-~—－至]\s*\d{1,2}\s*周|(?:^|[^\d])\d{1,2}\s*周|单周|双周|\(\s*[单双]\s*\)/;
/**
 * 「周」被括号包住的写法：`4-7(周)` / `4-19(周)` / `8(周)` / `1-16(单周)`。
 * ★ 北邮强智课表就是这么写的，而且**常常单独占一行**（周次一行、节次一行）。
 *   不在行分类里认它，这一行会被当成普通文字 → 该课周次丢失 → 退化成"整学期 1-20 周"。
 */
const RE_WEEK_PAREN = /[（(]\s*[单双]?\s*周\s*[)）]/;
// ★ 「实验」「中心」不能单独成词：`大学物理实验`、`数据结构实验(上)` 是课程名，
//   整词命中会被判成地点、整格进「未识别行」（QA-REPORT §3.9）。
const RE_LOCATION = /教[一二三四五六七八九十\d]|教学楼|实验楼|实验中心|楼|校区|沙河|西土城|宏福|中心|馆|苑|场|厅|[A-Za-z]?\d{2,4}\s*[-－]?\s*[A-Za-z0-9]{0,6}/;
const RE_TEACHER_HINT = /老师|教授|讲师|助教|教师/;

/**
 * 行类型标注（类型标签法，企微卡片与教务单元格共用）。
 * @param {string} rawLine
 * @returns {{kind:string, text:string}}
 *   kind: 'empty'|'weekday'|'period'|'weeks'|'location'|'text'
 */
export function tagLine(rawLine) {
  const text = String(rawLine == null ? '' : rawLine)
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .trim();
  if (!text) return { kind: 'empty', text };
  if (RE_WEEKDAY.test(text)) return { kind: 'weekday', text };
  // ★ 周次必须先于节次判断：`4-7(周)[01-02节]` 两种成分都有，
  //   判成 weeks 后两个都能抽出来（weeks 分支里也解析节次）；
  //   判成 period 就只剩节次，周次丢了。
  if (RE_WEEKS.test(text) || RE_WEEK_PAREN.test(text)) return { kind: 'weeks', text };
  if (RE_PERIOD.test(text)) return { kind: 'period', text };
  if (RE_TIME_RANGE.test(text)) return { kind: 'period', text };
  if (RE_TEACHER_HINT.test(text) && text.length <= 12) return { kind: 'teacher', text };
  if (RE_LOCATION.test(text) && !RE_WEEKS.test(text)) return { kind: 'location', text };
  return { kind: 'text', text };
}

/**
 * 从一段文本解析节次区间。
 *
 * 支持三种真实写法（都来自北邮强智课表）：
 *   `第3-4节` / `[01-02节]` / **`[02-03-04节]`（三连节，实为第 2-4 节）**
 * 一律取「最小..最大」。只认 `02-03节` 这一种会把三连节算成"第 4 节"，
 * 课表上就变成一节 45 分钟、位置还错开一格。
 */
export function periodFromText(text) {
  const t = String(text == null ? '' : text);
  const multi = t.match(/(?:第\s*)?(\d{1,2}(?:\s*[-~—－至,，、]\s*\d{1,2})+)\s*节/);
  if (multi) {
    const nums = multi[1]
      .split(/[-~—－至,，、]/)
      .map((n) => Number(String(n).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (nums.length >= 2) return { startPeriod: Math.min(...nums), endPeriod: Math.max(...nums) };
  }
  const single = t.match(/(?:第\s*)?(\d{1,2})\s*节/);
  if (single) {
    const a = Number(single[1]);
    return { startPeriod: a, endPeriod: a };
  }
  const bare = t.replace(/\s/g, '').match(/^(\d{1,2})(?:[-~—－](\d{1,2}))?$/);
  if (bare) {
    const a = Number(bare[1]);
    const b = bare[2] ? Number(bare[2]) : a;
    return { startPeriod: Math.min(a, b), endPeriod: Math.max(a, b) };
  }
  return null;
}

/** 从文本解析 HH:mm-HH:mm。 */
export function timeRangeFromText(text) {
  const m = String(text == null ? '' : text).match(/(\d{1,2}:\d{2})\s*[-~—－至]\s*(\d{1,2}:\d{2})/);
  if (!m) return null;
  return { startTime: m[1].padStart(5, '0'), endTime: m[2].padStart(5, '0') };
}

/**
 * 一段文本里的**所有** `HH:mm-HH:mm` → 取首段的开始与末段的结束。
 *
 * 为什么需要：强智 jsxsd 的课表左列按"大节"给出，一格里有两条时间
 * （`08:00-08:45 / 08:55-09:40`）。只取第一条会把这门课算成"只上第 1 节"，
 * 整张课表每格都短一节——不报错、不告警，纯粹错数据。
 */
export function timeRangesFromText(text) {
  const all = String(text == null ? '' : text).match(/\d{1,2}:\d{2}\s*[-~—－至]\s*\d{1,2}:\d{2}/g);
  if (!all || !all.length) return null;
  const first = timeRangeFromText(all[0]);
  const last = timeRangeFromText(all[all.length - 1]);
  if (!first || !last) return null;
  return { startTime: first.startTime, endTime: last.endTime, count: all.length };
}

/** 时间 → 最近节次（用于「只给时间」的通道，PRD Q2）。 */
export function periodsFromTimes(startTime, periods, endTime) {
  const list = Array.isArray(periods) ? periods : [];
  if (!startTime || !list.length) return null;
  const minutes = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  };
  const target = minutes(startTime);

  // ① 起始时间落在哪一节；② 否则取最近的一节（±20 分钟容差，PRD Q2 的"反查最近节次"）
  let startIdx = null;
  for (const p of list) {
    if (target >= minutes(p.start) && target <= minutes(p.end)) {
      startIdx = p.index;
      break;
    }
  }
  if (startIdx == null) {
    let best = null;
    for (const p of list) {
      const dist = Math.abs(target - minutes(p.start));
      if (!best || dist < best.dist) best = { dist, index: p.index };
    }
    if (!best || best.dist > 20) return null;
    startIdx = best.index;
  }

  // ③ 给了结束时间 → 反查结束节次，保住连堂课（08:00-09:35 → 第 1-2 节）
  let endIdx = startIdx;
  if (endTime) {
    const endTarget = minutes(endTime);
    for (const p of list) {
      if (p.index < startIdx) continue;
      endIdx = Math.max(endIdx, p.index);
      if (minutes(p.end) >= endTarget) {
        endIdx = p.index;
        break;
      }
    }
  }

  return { startPeriod: startIdx, endPeriod: Math.max(startIdx, endIdx) };
}

/**
 * 周次表达式正则（贪婪吃下整段离散周次）。
 * ★ 必须**整段**匹配：`1-8,10-16周` 若只匹配到 `10-16周`，该课第 1–8 周会直接从课表消失，
 *   而且 `1-8` 残片还会被当成课程名（静默错数据，无任何 warnings）。
 * 组成：`(第)?(段 ,)* 段 [单双] 周 [(单)]`，其中"段"= `1-16` 或 `1`，逗号前的段可省略"周"。
 */
const WEEK_NUM = String.raw`\d{1,2}(?:\s*[-~—－–至]\s*\d{1,2})?`;
const WEEK_PAR = String.raw`(?:\s*[（(]\s*[单双]\s*[)）])?`;
/**
 * 「周」这个标记本身：强智课表写成 `4-19(周)`，多数教务/企微写成 `1-16周`。
 * 两种都必须认——只认后者时整张课表的周次会**全丢**（用户看到十几条
 * "未识别到周次，已按整学期处理"，课表被排满整个学期）。
 */
const WEEK_MARK = String.raw`(?:[（(]\s*[单双]?\s*周\s*[)）]|周(?![\u4e00-\u9fa5]))`;
const WEEK_SEG = String.raw`${WEEK_NUM}(?:\s*[单双]?\s*${WEEK_MARK}${WEEK_PAR})?`;
// ★ 左边界 + 右边界缺一不可：
//   - `(?<![\dA-Za-z])`：避免把「教三-101 周宏」里的「01 周」当成周次（"周"是姓氏）
//   - `周(?![\u4e00-\u9fa5])`：避免把「周宏」「周三」这类以"周"开头的名字/星期词吞进周次
const WEEK_EXPR_RE = new RegExp(
  String.raw`(?<![\dA-Za-z])(?:第\s*)?(?:${WEEK_SEG}\s*[,，、]\s*)*${WEEK_NUM}\s*[单双]?\s*${WEEK_MARK}${WEEK_PAR}`
);
const WEEK_BARE_RE = /(?:^|[\s,，、])([单双])周(?:[\s,，、]|$)/;

/** 从文本抠周次原文（整段）。 */
export function weeksTextFromString(text) {
  const t = String(text == null ? '' : text);
  const m = t.match(WEEK_EXPR_RE);
  if (m) return m[0].trim();
  const bare = t.match(WEEK_BARE_RE);
  if (bare) return `${bare[1]}周`;
  const weekCol = t.match(/周次[^\s,，|]{0,20}/);
  return weekCol ? weekCol[0].trim() : null;
}

/**
 * 单元格 / 卡片文本 → 多条课程记录（邻近关系抽取 + 多课切分）。
 * @param {string[]} lines
 * @returns {Array<object>} 每条含 name/teacher/dayOfWeek/periods/weeksText/location
 */
/**
 * 纯分隔线（`------`、`=====`…）。强智 / 部分教务模板在一个单元格里用横线分隔
 * 「课程名 / 教师 / 周次 / 地点」，这条线既不是课程名也不是教师，必须整行丢弃，
 * 否则会凭空多出一门叫 `------` 的课。
 */
const RE_SEPARATOR_LINE = /^[\s\-_=~*·•.．—–－]{2,}$/;

/**
 * 教学班代码行，如强智课表里的 `(B14)`、`(01)`。
 * 它夹在「课程名」和「教师」之间，且形似地点（`[A-Za-z]?\d{2,4}` 会命中 B14），
 * 一旦被当成地点，记录就算"已完成"，后面的教师会被拆成一门新课（典型症状：
 * 课表里凭空多出一门名叫「宋媛」的课）。所以整行丢弃。
 */
const RE_CLASS_CODE = /^[（(]\s*[A-Za-z0-9]{1,12}\s*[)）]$/;

export function splitMultiCourse(lines) {
  const list = (Array.isArray(lines) ? lines : []).filter(Boolean);
  const records = [];
  let current = null;

  const flush = () => {
    if (current && (current.name || current.weeksText || current.periods)) records.push(current);
    current = null;
  };
  const ensure = () => {
    if (!current) {
      current = {
        name: null,
        teacher: null,
        dayOfWeek: null,
        periods: null,
        times: null,
        weeksText: null,
        location: null,
        rawLines: []
      };
    }
    return current;
  };

  for (let i = 0; i < list.length; i += 1) {
    const line = list[i];
    if (RE_SEPARATOR_LINE.test(String(line))) continue;
    if (RE_CLASS_CODE.test(String(line).trim())) continue;
    const tagged = tagLine(line);
    if (tagged.kind === 'empty') continue;

    if (tagged.kind === 'text') {
      const rec = ensure();
      const stripped = tagged.text.replace(/\s+/g, '');
      // ★ 兜底：万一这行没被认成 weeks（例如混了全角数字），只要它**几乎就是一段周次**，
      //   就并进当前这门课，绝不把它当成新课名/新教师——这行丢了就是"整学期 1-20 周"。
      const bareWeeks = weeksTextFromString(stripped);
      if (bareWeeks && stripped.length <= bareWeeks.replace(/\s+/g, '').length + 3) {
        if (!rec.weeksText) rec.weeksText = bareWeeks;
        rec.rawLines.push(line);
        continue;
      }
      const isShortNoDigit = stripped.length <= 6 && !/\d/.test(stripped);
      // ★ 单元格最后一行若只是「一个像人名的短词」（王建民 / Sarah / 王老师），它是教师，
      //   不是第二门课。不这样做会凭空多出一门名叫「王建民」的课（静默脏数据）。
      const isLastLine = list.slice(i + 1).every((x) => tagLine(x).kind === 'empty');
      // ★ 后面还有「周次 / 节次 / 星期」→ 说明是**下一门课的开头**，不是教师。
      //   强智课表的教师夹在「周次」和「地点」中间（不是最后一行），只靠 isLastLine 会漏。
      const hasLaterSkeleton = list.slice(i + 1).some((x) => {
        const k = tagLine(x).kind;
        return k === 'weeks' || k === 'period' || k === 'weekday';
      });
      const teacherLike =
        !rec.teacher && isShortNoDigit && (looksLikeTeacher(stripped) || RE_CN_PERSON.test(stripped));
      if (rec.name && (rec.periods || rec.weeksText || rec.location || rec.times)) {
        if (teacherLike && !hasLaterSkeleton && (isLastLine || !rec.location)) {
          rec.teacher = tagged.text;
          rec.rawLines.push(line);
          continue;
        }
        // 已经攒够一条的「骨架」→ 新起一条
        flush();
        const next = ensure();
        next.name = tagged.text;
        next.rawLines.push(line);
        continue;
      }
      if (rec.name && !rec.teacher && isShortNoDigit) {
        rec.teacher = tagged.text;
        rec.rawLines.push(line);
        continue;
      }
      if (!rec.name) rec.name = tagged.text;
      else if (!rec.teacher && isShortNoDigit) rec.teacher = tagged.text;
      rec.rawLines.push(line);
      continue;
    }

    const rec = ensure();
    rec.rawLines.push(line);

    if (tagged.kind === 'weekday') {
      const dow = dowFromText(tagged.text);
      if (dow && !rec.dayOfWeek) rec.dayOfWeek = dow;
      const p = periodFromText(tagged.text);
      if (p && !rec.periods) rec.periods = p;
      const t = timeRangeFromText(tagged.text);
      if (t && !rec.times) rec.times = t;
      const w = weeksTextFromString(tagged.text);
      if (w && !rec.weeksText) rec.weeksText = w;
      continue;
    }
    if (tagged.kind === 'period') {
      const p = periodFromText(tagged.text);
      if (p && !rec.periods) rec.periods = p;
      const t = timeRangeFromText(tagged.text);
      if (t && !rec.times) rec.times = t;
      // ★ 强智把周次和节次写在同一行：`4-19(周)[06-07节]`。
      //   这一行被标成 period，若不在这里顺手抠周次，整张课表的周次会全部丢失。
      const w = weeksTextFromString(tagged.text);
      if (w && !rec.weeksText) rec.weeksText = w;
      continue;
    }
    if (tagged.kind === 'weeks') {
      const w = weeksTextFromString(tagged.text);
      if (!rec.weeksText) rec.weeksText = w || tagged.text;
      const p = periodFromText(tagged.text);
      if (p && !rec.periods) rec.periods = p;
      continue;
    }
    if (tagged.kind === 'teacher') {
      if (!rec.teacher) rec.teacher = tagged.text;
      continue;
    }
    if (tagged.kind === 'location') {
      if (!rec.location) rec.location = tagged.text;
      continue;
    }
  }
  flush();
  return records.filter((r) => r.name || r.weeksText || r.periods);
}

/** ------------------------------------------------------------ 通用文本行解析 */

const RE_DOW_TOKEN = /(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/;

/**
 * 地点线索（token 级）。
 * ★ 不能只认「教X / 教学楼 / 楼」：`体育馆-2F`、`操场`、`沙河校区-教学楼A101` 都是真实写法，
 *   漏判会让地点被当成教师、课程名被地点残片抢占（静默错数据）。
 */
const RE_PLACE_WORD = /教学楼|实验楼|综合楼|主楼|[一二三四]教|体育馆|图书馆|操场|校区|公寓|食堂|中心|机房/;
const RE_PLACE_SUFFIX = /[教操场楼厅苑]$/;
const RE_ROOM_CODE = /^[A-Za-z]?\d{1,4}\s*[-－]\s*[A-Za-z0-9]+$/;

export function looksLikeLocation(token) {
  const t = String(token == null ? '' : token).trim();
  if (!t || t.length > 24) return false;
  if (RE_PLACE_WORD.test(t)) return true;
  if (/教\s*[一二三四五六七八九十\d]/.test(t)) return true; // 教三-101 / 教1-201
  if (RE_ROOM_CODE.test(t)) return true; // 410-2 / A301-1
  if (RE_PLACE_SUFFIX.test(t) && t.length <= 8) return true; // 操场 / 主楼 / 三教
  return false;
}

/**
 * 教师线索（token 级）：中文称谓后缀，或纯拉丁名（Sarah / John Smith）。
 */
const RE_TEACHER_SUFFIX = /(老师|教授|讲师|助教|教师)$/;
/** 纯中文人名（2–4 字，无称谓后缀也当教师）。 */
const RE_CN_PERSON = /^[\u4e00-\u9fa5]{2,4}$/;
export function looksLikeTeacher(token) {
  const t = String(token == null ? '' : token).trim();
  if (!t) return false;
  if (RE_TEACHER_SUFFIX.test(t)) return true;
  return /^[A-Za-z][A-Za-z.\-\s]{1,15}$/.test(t);
}
const RE_SEP = /[\t|｜]/;

/**
 * 通用文本行解析（F1 类型识别 / F2 分隔符表格 / F3 时间制）。
 * @param {string} text
 * @param {{periods?:Array}} [opts]
 * @returns {{records:Array, unrecognized:Array}}
 */
export function parseTextLines(text, opts = {}) {
  const periods = Array.isArray(opts.periods) ? opts.periods : [];
  const records = [];
  const unrecognized = [];
  const lines = String(text == null ? '' : text).split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = rawLine.replace(/[\u00a0\u3000]/g, ' ').trim();
    if (!line) return;
    // 显然不是课程行的内容（表头/说明）静默跳过，不算失败
    if (/^(序号|课程表|星期|节次|时间|备注)\s*$/.test(line)) return;
    if (/^[-=_*·—\s]+$/.test(line)) return;

    const parsed = parseOneLine(line, periods);
    if (parsed.error) {
      unrecognized.push({ raw: rawLine, reason: parsed.error, index });
      return;
    }
    records.push({ ...parsed, raw: rawLine, index });
  });

  return { records, unrecognized };
}

/** 单行解析。 */
export function parseOneLine(line, periods = []) {
  // ---------- F2：分隔符表格（Tab / | / 全角竖线） ----------
  if (RE_SEP.test(line)) {
    const parts = line.split(RE_SEP).map((p) => p.trim()).filter((p) => p !== '');
    if (parts.length >= 4) {
      const dowIdx = parts.findIndex((p) => RE_DOW_TOKEN.test(p));
      if (dowIdx >= 0) {
        const dow = dowFromText(parts[dowIdx]);
        const rest = parts.filter((_, i) => i !== dowIdx);
        const nameIdx = rest.findIndex(
          (p) => !RE_DOW_TOKEN.test(p) && !periodFromText(p) && !RE_WEEKS.test(p)
        );
        const periodPart = rest.find((p) => periodFromText(p)) || null;
        const periods2 = periodPart ? periodFromText(periodPart) : null;
        const weeksPart = rest.find((p) => RE_WEEKS.test(p)) || null;
        const locPart =
          rest.find(
            (p) =>
              p !== (nameIdx >= 0 ? rest[nameIdx] : null) &&
              p !== periodPart &&
              p !== weeksPart &&
              /教|楼|馆|中心|沙河|西土城|宏福|[A-Za-z]?\d{2,4}/.test(p)
          ) || null;
        const teacherPart = rest.find(
          (p) =>
            p !== (nameIdx >= 0 ? rest[nameIdx] : null) &&
            p !== periodPart &&
            p !== weeksPart &&
            p !== locPart &&
            p.length <= 8 &&
            !/\d/.test(p)
        );
        if (dow && periods2 && nameIdx >= 0) {
          return {
            name: rest[nameIdx],
            teacher: teacherPart || null,
            dayOfWeek: dow,
            periods: periods2,
            times: null,
            location: locPart || '',
            weeksText: weeksPart || null
          };
        }
      }
    }
  }

  // ---------- F1 / F3：类型识别 ----------
  let rest = line;

  const dowMatch = rest.match(RE_DOW_TOKEN);
  if (!dowMatch) return { error: 'MISSING_DOW' };
  const dayOfWeek = dowCharToNumber(dowMatch[1]);
  rest = rest.replace(dowMatch[0], ' ');

  let periodRange = null;
  let times = null;
  const periodMatch = rest.match(/(?:第\s*)?(\d{1,2})\s*[-~—－至]\s*(\d{1,2})\s*节/);
  const singlePeriod = rest.match(/(?:第\s*)?(\d{1,2})\s*节/);
  if (periodMatch) {
    const a = Number(periodMatch[1]);
    const b = Number(periodMatch[2]);
    periodRange = { startPeriod: Math.min(a, b), endPeriod: Math.max(a, b) };
    rest = rest.replace(periodMatch[0], ' ');
  } else if (singlePeriod) {
    const a = Number(singlePeriod[1]);
    periodRange = { startPeriod: a, endPeriod: a };
    rest = rest.replace(singlePeriod[0], ' ');
  } else {
    const timeMatch = timeRangeFromText(rest);
    if (!timeMatch) return { error: 'MISSING_PERIOD' };
    times = timeMatch;
    rest = rest.replace(/\d{1,2}:\d{2}\s*[-~—－至]\s*\d{1,2}:\d{2}/, ' ');
    const guessed = periodsFromTimes(times.startTime, periods, times.endTime);
    if (!guessed) return { error: 'MISSING_PERIOD' };
    periodRange = guessed;
  }

  let weeksText = null;
  const weeksMatch = weeksTextFromString(rest);
  if (weeksMatch) {
    weeksText = weeksMatch;
    rest = rest.replace(weeksMatch, ' ');
  }

  // ---------- 地点：从后往前找第一个「像地点」的 token（必须留下至少 1 个 token 当课名） ----------
  // ★ 括号不是分隔符：`体育(羽毛球)` / `高等数学(上)` 必须原样保留，
  //   否则两门「体育(篮球/羽毛球)」会被 normalize 按课程名合并成一门。
  let tokens = rest
    .split(/[\s,，、;；|/]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  let location = '';
  for (let i = tokens.length - 1; i > 0; i -= 1) {
    if (looksLikeLocation(tokens[i])) {
      location = tokens[i];
      tokens = tokens.slice(0, i).concat(tokens.slice(i + 1));
      break;
    }
  }

  if (!tokens.length) return { error: 'MISSING_NAME' };

  // ---------- 课程名 / 教师：按线索分类，课名取「非教师线索的最长中文 token」 ----------
  const cjkNameTokens = tokens.filter((t) => /[\u4e00-\u9fa5]/.test(t) && !looksLikeTeacher(t));
  const nameCandidates = cjkNameTokens.length ? cjkNameTokens : tokens;
  const name = nameCandidates.slice().sort((a, b) => b.length - a.length)[0];

  const teacher =
    tokens.find((t) => t !== name && looksLikeTeacher(t)) ||
    tokens.find((t) => t !== name && t.length <= 6 && !/\d/.test(t)) ||
    null;

  return { name, teacher, dayOfWeek, periods: periodRange, times, location, weeksText };
}

/** ------------------------------------------------------------ 教务系统适配器 */

function emptyResult(source, detectedBy, strategy) {
  return {
    courses: [],
    sessions: [],
    warnings: [],
    unrecognized: [],
    periodsHint: null,
    meta: { source, detectedBy, strategy }
  };
}

/** 找「节次 × 星期」网格表：表头含星期、行数最多。 */
export function findScheduleTable(tables) {
  let best = null;
  for (const table of Array.isArray(tables) ? tables : []) {
    for (let r = 0; r < Math.min(table.rows.length, 5); r += 1) {
      const row = table.rows[r];
      let hits = 0;
      for (const cell of row) {
        if (cell && dowFromText(cell.text)) hits += 1;
      }
      if (hits >= 2) {
        if (!best || table.rowCount > best.table.rowCount) {
          best = { table, headerRow: r, dowHits: hits };
        }
        break;
      }
    }
  }
  return best;
}

/** 表头 → 列到星期的映射。 */
function dowColumnsOf(table, headerRow) {
  const map = new Map();
  const row = table.rows[headerRow] || [];
  row.forEach((cell, c) => {
    if (!cell) return;
    const dow = dowFromText(cell.text);
    if (!dow) return;
    const span = cell.colspan || 1;
    for (let dc = 0; dc < span; dc += 1) map.set(c + dc, dow);
  });
  return map;
}

/** `HH:mm` → 分钟数。 */
function minutesOfHhmm(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

/**
 * 结束时间 → 结束节次（带 10 分钟容差）。
 *
 * 为什么不能直接复用 periodsFromTimes：各校区作息表和 App 内置节次表差几分钟很常见
 * （强智给 09:40，内置第 2 节到 09:35），严格比较会把这门课算成"1-3 节"，
 * 整张课表每格都多一节。容差只影响临界值。
 */
function endPeriodOf(endTime, periods, startIdx) {
  const list = Array.isArray(periods) ? periods : [];
  if (!endTime || !list.length) return startIdx;
  const target = minutesOfHhmm(endTime) - 10;
  let idx = startIdx;
  for (const p of list) {
    if (p.index < startIdx) continue;
    idx = Math.max(idx, p.index);
    if (minutesOfHhmm(p.end) >= target) return p.index;
  }
  return idx;
}

/** 一行左侧（节次列）→ 节次区间。 */
function periodOfRow(row, minWeekdayCol, fallbackIndex, periods) {
  const texts = [];
  const limit = Math.max(1, minWeekdayCol);
  for (let c = 0; c < limit; c += 1) {
    const cell = row[c];
    if (cell && cell.origin !== false && cell.text) texts.push(cell.text);
  }
  const joined = texts.join(' ');
  const p = periodFromText(joined);
  if (p) return p;
  // ★ 强智 jsxsd 的课表左列按"大节"给出，一格里有 N 条时间（08:00-08:45 / 08:55-09:40）：
  //   条数就是这一大节含的小节数，比拿时间做区间比对稳得多。
  const t = timeRangesFromText(joined);
  if (t) {
    const start = periodsFromTimes(t.startTime, periods);
    if (start) {
      const lastIndex = periods.length ? periods[periods.length - 1].index : start.startPeriod;
      if (t.count >= 2 && start.startPeriod + t.count - 1 <= lastIndex) {
        return { startPeriod: start.startPeriod, endPeriod: start.startPeriod + t.count - 1 };
      }
      return { startPeriod: start.startPeriod, endPeriod: endPeriodOf(t.endTime, periods, start.startPeriod) };
    }
  }
  if (fallbackIndex >= 1) return { startPeriod: fallbackIndex, endPeriod: fallbackIndex };
  return null;
}

/**
 * 一行左侧的「第几节 + 起止时间」→ 作息表条目。
 * 强智课表左列就是 `1 / 08:00-08:45`、`13 / 19:20-20:05` 这种，一共能到 14 节；
 * 本 App 默认节次表只有 11 节，不把这份作息带回来，晚上的课在周视图里就排不进去。
 */
function periodHintOfRow(row, minWeekdayCol) {
  const texts = [];
  const limit = Math.max(1, minWeekdayCol);
  for (let c = 0; c < limit; c += 1) {
    const cell = row[c];
    if (cell && cell.origin !== false && cell.text) texts.push(cell.text);
  }
  const joined = texts.join(' ');
  // 序号必须在最前面，且不能是 `08:00` 里的 `08`
  const idx = joined.match(/^\s*(\d{1,2})(?![:\d])/);
  const t = timeRangeFromText(joined);
  if (!idx || !t) return null;
  return { index: Number(idx[1]), start: t.startTime, end: t.endTime };
}

/** 只有「1..N 连续、时间递增」才当成可信作息表，避免把别的数字列误当节次。 */
function normalizePeriodsHint(list) {
  const sorted = (Array.isArray(list) ? list : []).slice().sort((a, b) => a.index - b.index);
  if (sorted.length < 6) return null;
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].index !== i + 1) return null;
    if (i > 0 && !(sorted[i].start >= sorted[i - 1].start)) return null;
  }
  return sorted.map((p, i) => ({ index: i + 1, start: p.start, end: p.end }));
}

/**
 * 表格网格 → 预归一化记录（教务 / 企微 S2 共用）。
 * @param {object} table parseHtmlLite().tables[i]
 * @param {{headerRow:number, periods?:Array}} opts
 */
export function parseTableGrid(table, opts = {}) {
  const records = [];
  const unrecognized = [];
  const warnings = [];
  const hint = [];
  const periods = Array.isArray(opts.periods) ? opts.periods : [];
  const headerRow = Number.isInteger(opts.headerRow) ? opts.headerRow : 0;
  const dowCols = dowColumnsOf(table, headerRow);

  if (!dowCols.size) {
    return {
      records,
      unrecognized: [{ raw: '', reason: 'NO_WEEKDAY_HEADER', index: headerRow }],
      warnings,
      periodsHint: null
    };
  }
  const minWeekdayCol = Math.min(...dowCols.keys());

  for (let r = headerRow + 1; r < table.rows.length; r += 1) {
    const row = table.rows[r] || [];
    const fallbackIndex = r - headerRow;
    const rowPeriod = periodOfRow(row, minWeekdayCol, fallbackIndex, periods);

    const rowHint = periodHintOfRow(row, minWeekdayCol);
    if (rowHint && !hint.some((p) => p.index === rowHint.index)) hint.push(rowHint);

    for (const [c, dow] of dowCols.entries()) {
      const cell = row[c];
      if (!cell || cell.origin === false) continue; // 占位（被上方 rowspan 覆盖）→ 跳过
      const text = String(cell.text || '').trim();
      if (!text || /^[-—–\s无/]*$/.test(text)) continue;

      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const subRecords = splitMultiCourse(lines);
      if (!subRecords.length) {
        unrecognized.push({ raw: text, reason: 'MISSING_NAME', index: r });
        continue;
      }

      for (const rec of subRecords) {
        const explicit = rec.periods || periodFromText(text);
        let startPeriod = explicit ? explicit.startPeriod : rowPeriod ? rowPeriod.startPeriod : null;
        let endPeriod = explicit ? explicit.endPeriod : rowPeriod ? rowPeriod.endPeriod : null;
        if (startPeriod == null) {
          unrecognized.push({ raw: text, reason: 'MISSING_PERIOD', index: r });
          continue;
        }
        if (!explicit && cell.rowspan > 1) endPeriod = Math.max(endPeriod, startPeriod + cell.rowspan - 1);
        if (endPeriod == null || endPeriod < startPeriod) {
          unrecognized.push({ raw: text, reason: 'PERIOD_ORDER', index: r });
          continue;
        }
        if (!rec.name) {
          unrecognized.push({ raw: text, reason: 'MISSING_NAME', index: r });
          continue;
        }
        if (!rec.weeksText) warnings.push(`「${rec.name}」未识别到周次，已按整学期处理`);
        records.push({
          name: rec.name,
          teacher: rec.teacher,
          dayOfWeek: rec.dayOfWeek || dow,
          startPeriod,
          endPeriod,
          location: rec.location || '',
          weeksText: rec.weeksText,
          sourceRef: `table:r${r}c${c}`
        });
      }
    }
  }

  return { records, unrecognized, warnings, periodsHint: normalizePeriodsHint(hint) };
}

/**
 * 教务系统适配器。
 * @param {string} html
 * @param {{periods?:Array, totalWeeks?:number}} [opts]
 */
export function parseJwgl(html, opts = {}) {
  const lite = parseHtmlLite(html);
  const result = emptyResult('jwgl', 'feature:jwgl', 'jwgl:table');

  const found = findScheduleTable(lite.tables);
  if (found) {
    const grid = parseTableGrid(found.table, { headerRow: found.headerRow, periods: opts.periods });
    result.sessions = grid.records;
    result.unrecognized = grid.unrecognized;
    result.warnings = grid.warnings;
    result.periodsHint = grid.periodsHint || null;
    if (result.sessions.length) return result;
  }

  // 没有可用的「节次 × 星期」网格 → 明确失败，并给出可操作提示（PRD US-1 AC5）
  // ★ 不在这里做通用文本兜底：文本粘贴是独立通道，混用会让失败原因变得不可解释。
  result.unrecognized = (
    result.unrecognized.length
      ? result.unrecognized
      : [{ raw: String(html || '').slice(0, 400), reason: 'NO_COURSE_FOUND', index: 0 }]
  ).map((u) => (u.reason === 'NO_WEEKDAY_HEADER' ? { ...u, reason: 'NO_COURSE_FOUND' } : u));
  result.warnings.push('未找到课表表格，请改用「粘贴课表文字」或 JSON 通道');
  result.meta = { source: 'jwgl', detectedBy: 'feature:jwgl', strategy: 'jwgl:none' };
  return result;
}

/** ------------------------------------------------------------ 企微适配器 */

/** 在一段脚本里找可解析的 JSON。 */
function tryParseJsonLoose(text) {
  const t = String(text || '').trim().replace(/;\s*$/, '');
  if (!t) return null;
  const startIdx = t.search(/[[{]/);
  if (startIdx < 0) return null;
  const body = t.slice(startIdx);
  try {
    return JSON.parse(body);
  } catch (err) {
    /* 继续尝试裁剪尾部 */
  }
  const lastBrace = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (lastBrace > 0) {
    try {
      return JSON.parse(body.slice(0, lastBrace + 1));
    } catch (err) {
      return null;
    }
  }
  return null;
}

const COURSE_KEY_HINTS = /course|kcmc|kcname|lesson|kcb|schedule|classtable|timetable/i;
const FIELD_KEYS = {
  name: ['courseName', 'kcmc', 'kcname', 'kcmc_mc', 'name', 'title', 'course'],
  teacher: ['teacher', 'teacherName', 'jsxm', 'skls', 'instructor', 'xm'],
  dayOfWeek: ['dayOfWeek', 'xq', 'xingqi', 'weekday', 'xqj', 'day', 'weekDay'],
  startPeriod: ['startPeriod', 'jc', 'startSection', 'section', 'jcs', 'start', 'jc1'],
  endPeriod: ['endPeriod', 'jc2', 'endSection', 'sectionEnd'],
  location: ['location', 'cdmc', 'classroom', 'room', 'place', 'cd', 'classRoom'],
  weeks: ['weeks', 'zc', 'zcd', 'weekText', 'zcmc', 'weekDesc'],
  periods: ['periods', 'jcs', 'sections', 'periodText']
};

function pickField(obj, keys) {
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== '') return obj[key];
  }
  return null;
}

function looksLikeCourse(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  const nameKey = keys.some((k) => /^(courseName|kcmc|kcname|name|title)$/i.test(k));
  const timeKey = keys.some((k) => /^(dayOfWeek|xq|xingqi|weekday|jc|jcs|section|weeks|zc)$/i.test(k));
  return nameKey && timeKey;
}

function findCourseArrays(node, out, depth = 0) {
  if (!node || depth > 8 || out.length > 40) return;
  if (Array.isArray(node)) {
    const sample = node.find((x) => x && typeof x === 'object');
    if (sample && looksLikeCourse(sample)) {
      out.push(node);
      return;
    }
    for (const item of node) findCourseArrays(item, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (COURSE_KEY_HINTS.test(key) || depth < 3) findCourseArrays(node[key], out, depth + 1);
      else findCourseArrays(node[key], out, depth + 1);
    }
  }
}

/** 单条 JSON 课程对象 → 预归一化记录。 */
function recordFromJsonObject(obj) {
  const rawName = pickField(obj, FIELD_KEYS.name);
  const rawDow = pickField(obj, FIELD_KEYS.dayOfWeek);
  const rawPeriods = pickField(obj, FIELD_KEYS.periods);
  const rawStart = pickField(obj, FIELD_KEYS.startPeriod);
  const rawEnd = pickField(obj, FIELD_KEYS.endPeriod);
  const rawWeeks = pickField(obj, FIELD_KEYS.weeks);

  let dayOfWeek = null;
  if (rawDow != null) {
    const text = String(rawDow);
    dayOfWeek = dowFromText(text) || Number(text) || null;
    if (dayOfWeek === 0) dayOfWeek = 7;
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) dayOfWeek = null;
  }

  let periods = null;
  if (rawPeriods != null) periods = periodFromText(String(rawPeriods));
  if (!periods && rawStart != null) periods = periodFromText(String(rawStart));
  if (!periods && rawStart != null && rawEnd != null) {
    const a = Number(String(rawStart).replace(/[^\d]/g, ''));
    const b = Number(String(rawEnd).replace(/[^\d]/g, ''));
    if (Number.isFinite(a) && a >= 1) {
      periods = { startPeriod: Math.min(a, b), endPeriod: Math.max(a, b) };
    }
  }

  let weeksText = null;
  if (rawWeeks != null) {
    if (Array.isArray(rawWeeks)) weeksText = `${rawWeeks[0]}-${rawWeeks[rawWeeks.length - 1]}周`;
    else weeksText = String(rawWeeks);
  }

  return {
    name: rawName == null ? null : String(rawName).trim(),
    teacher: pickField(obj, FIELD_KEYS.teacher)
      ? String(pickField(obj, FIELD_KEYS.teacher)).trim()
      : null,
    dayOfWeek,
    startPeriod: periods ? periods.startPeriod : null,
    endPeriod: periods ? periods.endPeriod : null,
    location: pickField(obj, FIELD_KEYS.location) ? String(pickField(obj, FIELD_KEYS.location)).trim() : '',
    weeksText
  };
}

/** S1：内联 JSON。 */
export function parseWecomJson(html) {
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  const arrays = [];
  let m = scriptRe.exec(html);
  while (m !== null) {
    const parsed = tryParseJsonLoose(m[1]);
    if (parsed) findCourseArrays(parsed, arrays);
    m = scriptRe.exec(html);
  }
  // 有些页面把 JSON 直接写在属性 / 文本里
  if (!arrays.length) {
    const parsed = tryParseJsonLoose(html);
    if (parsed) findCourseArrays(parsed, arrays);
  }
  const records = [];
  for (const arr of arrays) {
    for (const item of arr) {
      const rec = recordFromJsonObject(item);
      if (rec.name && rec.dayOfWeek && rec.startPeriod) records.push(rec);
    }
  }
  return records;
}

/** S3：卡片 / div 列表。 */
export function parseWecomCards(cards) {
  const records = [];
  const unrecognized = [];
  (Array.isArray(cards) ? cards : []).forEach((card, index) => {
    const subRecords = splitMultiCourse(card.lines);
    if (!subRecords.length) {
      unrecognized.push({ raw: card.lines.join(' / '), reason: 'NO_COURSE_FOUND', index });
      return;
    }
    for (const rec of subRecords) {
      if (!rec.name) {
        unrecognized.push({ raw: card.lines.join(' / '), reason: 'MISSING_NAME', index });
        continue;
      }
      if (!rec.dayOfWeek && !rec.periods) {
        unrecognized.push({ raw: card.lines.join(' / '), reason: 'MISSING_FIELD', index });
        continue;
      }
      if (!rec.dayOfWeek) {
        unrecognized.push({ raw: card.lines.join(' / '), reason: 'MISSING_DOW', index });
        continue;
      }
      if (!rec.periods) {
        unrecognized.push({ raw: card.lines.join(' / '), reason: 'MISSING_PERIOD', index });
        continue;
      }
      records.push({
        name: rec.name,
        teacher: rec.teacher,
        dayOfWeek: rec.dayOfWeek,
        startPeriod: rec.periods.startPeriod,
        endPeriod: rec.periods.endPeriod,
        location: rec.location || '',
        weeksText: rec.weeksText,
        sourceRef: `wecom:card${index}`
      });
    }
  });
  return { records, unrecognized };
}

/**
 * 企微适配器：S1 内联 JSON → S2 table → S3 卡片 → S4 文本，命中即停。
 * @param {string} html
 * @param {{periods?:Array}} [opts]
 */
export function parseWecom(html, opts = {}) {
  const result = emptyResult('wecom', 'feature:wecom', 'wecom:json');

  // S1
  const jsonRecords = parseWecomJson(html);
  if (jsonRecords.length) {
    result.sessions = jsonRecords.map((r, i) => ({
      ...r,
      sourceRef: `wecom:json:${i}`
    }));
    return result;
  }

  const lite = parseHtmlLite(html);

  // S2
  const found = findScheduleTable(lite.tables);
  if (found) {
    const grid = parseTableGrid(found.table, { headerRow: found.headerRow, periods: opts.periods });
    if (grid.records.length) {
      result.sessions = grid.records;
      result.unrecognized = grid.unrecognized;
      result.warnings = grid.warnings;
      result.meta.strategy = 'wecom:table';
      return result;
    }
  }

  // S3
  const cardRes = parseWecomCards(lite.cards);
  if (cardRes.records.length) {
    result.sessions = cardRes.records;
    result.unrecognized = cardRes.unrecognized;
    result.meta.strategy = 'wecom:card';
    return result;
  }

  // S4
  const textRes = parseTextLines(lite.lines.join('\n'), { periods: opts.periods });
  if (textRes.records.length) {
    result.sessions = textRes.records.map((r, i) => ({
      name: r.name,
      teacher: r.teacher,
      dayOfWeek: r.dayOfWeek,
      startPeriod: r.periods ? r.periods.startPeriod : null,
      endPeriod: r.periods ? r.periods.endPeriod : null,
      location: r.location || '',
      weeksText: r.weeksText,
      sourceRef: `wecom:text:${i}`
    }));
    result.unrecognized = [...cardRes.unrecognized, ...textRes.unrecognized];
    result.meta.strategy = 'wecom:text';
    return result;
  }

  result.unrecognized = [
    ...cardRes.unrecognized,
    ...textRes.unrecognized,
    { raw: String(html || '').slice(0, 400), reason: 'NO_COURSE_FOUND', index: 0 }
  ];
  result.warnings.push('未在页面中找到课程数据，建议改用「粘贴课表文字」通道');
  result.meta.strategy = 'wecom:none';
  return result;
}

/** 供 UI 展示「示例解析时间」等场景。 */
export function parserStamp() {
  return todayStr();
}
