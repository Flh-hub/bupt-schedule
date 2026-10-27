/**
 * capture.js — 在教务系统页面里收集「可能是课表」的 HTML + 判定「今天是第几教学周」的线索。
 *
 * 由 JwglActivity 注入执行。两种用法：
 *   ① `window.__buptCapture()`：**异步**，顺手 fetch 学生首页补「当前第 N 周」，
 *      完了调 `BuptCapture.deliver(json)` 交给原生（推荐路径）。
 *   ② 脚本本身的**返回值**是同步采集的 JSON（老路径 / 兜底，不含首页信号）。
 *
 * 【为什么课表页不够】课表页只显示「周次：全部」，不告诉你今天是第几周；
 * 而学生首页（xsMain）通常会写「当前第 N 周」。没有这个数，就没法反推开学日。
 *
 * 【安全】只读 DOM、只读选中项文本，不读任何表单值（密码框不会被碰）。
 * 唯一的网络请求是同源的首页 GET（带 cookie，等价于用户自己点一下菜单）。
 */
(function () {
  var MAX_TOTAL = 1400000; // 单次回传上限
  var MAX_CANDIDATES = 6;
  var out = [];
  var bestTable = null; // 分数最高的 table 元素（用来读表头日期）
  var bestScore = 0;

  /**
   * 元素可见文本。`innerText` 只有真实浏览器才有（jsdom / 部分环境是 undefined），
   * 取不到就退化为 `textContent`，并先剃掉 script/style——否则页面脚本里的
   * 「第X周」字样会被当成当前周，直接算错开学日。
   */
  function visibleText(el) {
    if (!el) return '';
    try {
      if (typeof el.innerText === 'string' && el.innerText) return el.innerText;
    } catch (e) {
      // 继续走兜底
    }
    try {
      var clone = el.cloneNode(true);
      var junk = clone.querySelectorAll ? clone.querySelectorAll('script,style,noscript') : [];
      for (var i = 0; i < junk.length; i += 1) {
        if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
      }
      return clone.textContent || '';
    } catch (e) {
      return '';
    }
  }

  function textOf(el) {
    try {
      return el.textContent || el.innerText || '';
    } catch (e) {
      return '';
    }
  }

  /** 越像课表分越高：星期表头 ≥2 + 有节次/时间特征。 */
  function tableScore(t) {
    var txt = textOf(t);
    if (!txt) return 0;
    var dowHits = (txt.match(/(?:星期|周)[一二三四五六日天]/g) || []).length;
    if (dowHits < 2) return 0;
    var periodHit = /节次|第[一二三四五六七八九十]+大节|\d{1,2}:\d{2}/.test(txt) ? 20 : 0;
    return dowHits * 20 + periodHit + Math.min(60, Math.floor(txt.length / 40));
  }

  function collect(win, depth) {
    if (depth > 3) return;
    try {
      var doc = win.document;
      if (doc && doc.documentElement) {
        var tables = doc.getElementsByTagName('table');
        for (var i = 0; i < tables.length; i++) {
          var t = tables[i];
          var score = tableScore(t);
          if (!score) continue;
          if (score > bestScore) {
            bestScore = score;
            bestTable = t;
          }
          var html = '';
          try {
            html = t.outerHTML || '';
          } catch (e) {
            html = '';
          }
          if (html.length < 200) continue;
          var cls = typeof t.className === 'string' ? t.className : '';
          out.push({
            label: '表格 ' + (t.id ? '#' + t.id : '') + (cls ? '.' + cls.split(/\s+/).join('.') : ''),
            html: html,
            score: score
          });
        }
        try {
          var whole = doc.documentElement.outerHTML || '';
          if (whole.length > 200) {
            out.push({ label: '整页 ' + (doc.title || ''), html: whole, score: 1 });
          }
        } catch (e) {
          // 忽略
        }
      }
    } catch (e) {
      // 跨域 frame：静默跳过
    }
    try {
      var frames = win.frames || [];
      for (var j = 0; j < frames.length; j += 1) collect(frames[j], depth + 1);
    } catch (e) {
      // 忽略
    }
  }

  /* ---------------------------------------------------------------- 信号采集 */

  /**
   * 扫一页（含子 frame）里「像当前周」的文字，以及各 select 的选中项。
   * 只取每页顶部 1500 字：能覆盖页头横幅/欢迎语，又不会被几十个课表格子灌满。
   */
  function scanWindow(win, depth, acc) {
    if (depth > 3) return;
    try {
      var doc = win.document;
      if (doc) {
        var title = String(doc.title || '');
        if (title) acc.titles.push(title.slice(0, 80));
        var body = String(visibleText(doc.body) || '');
        if (body) {
          // ★ 周次下拉的文本是「(全部) 第1周 第2周 … 第30周」——整段罗列，
          //   直接喂给"当前第 N 周"的解析会被误当成第 30 周（实测把起始日算成 2026-03-30）。
          //   这里先压掉连续罗列，只留下真正单独出现的「第 N 周」。
          var cleaned = String(body).replace(/(?:第\s*\d{1,2}\s*周[\s,，、·]*){3,}/g, ' ');
          acc.weekTexts.push(cleaned.slice(0, 1500));
        }
        var nodes = doc.querySelectorAll('[class*=week],[id*=week],[class*=zhou],[id*=zhou]');
        for (var i = 0; i < nodes.length && i < 6; i += 1) {
          var t = String(visibleText(nodes[i]) || '').trim();
          // 同样压掉下拉罗列，避免 "第1周 第2周 … 第30周" 被当成当前周
          t = t.replace(/(?:第\s*\d{1,2}\s*周[\s,，、·]*){3,}/g, ' ').trim();
          if (t && t.length <= 120) acc.weekTexts.push(t);
        }
        var selects = doc.getElementsByTagName('select');
        for (var j = 0; j < selects.length; j += 1) {
          var opt = selects[j].options && selects[j].options[selects[j].selectedIndex];
          if (opt && opt.text) acc.weakTexts.push(String(opt.text).trim().slice(0, 40));
        }
      }
    } catch (e) {
      // 忽略
    }
    try {
      var frames = win.frames || [];
      for (var k = 0; k < frames.length; k += 1) scanWindow(frames[k], depth + 1, acc);
    } catch (e) {
      // 忽略
    }
  }

  function pageSignals() {
    var acc = { weekTexts: [], weakTexts: [], titles: [] };
    scanWindow(window, 0, acc);
    return acc;
  }

  /* ---------------------------------------------------------------- 表头日期 */

  var TERM_RE = /(20\d{2})\s*[-—－]\s*(20\d{2})\s*[-—－]\s*([12])/;

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /**
   * 从「周一 08-31」这种表头文本里取 MM-DD。
   * 表头只有月日没有年份（年份由网页侧按今天推断），所以这里只取月日。
   */
  function mdOf(text) {
    var t = String(text || '');
    var iso = t.match(/(20\d{2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/);
    if (iso) return pad2(Number(iso[2])) + '-' + pad2(Number(iso[3]));
    var md = t.match(/(\d{1,2})\s*[-./]\s*(\d{1,2})/);
    if (!md) return null;
    var m = Number(md[1]);
    var d = Number(md[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return pad2(m) + '-' + pad2(d);
  }

  /**
   * 课表表头的「第几周 + 每一天的日期」——这是推算开学日最硬的证据：
   * 用户截图里的表头就是 `周一 08-31 … 周日 09-06`，右上角周次是 `第1周`。
   *
   * @returns {{week:number|null, dates:string[], picker:string|null, term:string|null}}
   */
  function weekAnchorOf(table, doc) {
    var anchor = { week: null, dates: [], picker: null, term: null };
    try {
      var rows = table.rows || [];
      for (var r = 0; r < Math.min(3, rows.length); r += 1) {
        var cells = rows[r].cells || [];
        for (var c = 0; c < cells.length; c += 1) {
          var txt = String(visibleText(cells[c]) || '');
          if (!/(?:周|星期)\s*[一二三四五六日天]/.test(txt)) continue;
          var md = mdOf(txt);
          if (md && anchor.dates.indexOf(md) < 0) anchor.dates.push(md);
        }
      }
      var sels = doc.getElementsByTagName('select');
      for (var i = 0; i < sels.length; i += 1) {
        var opt = sels[i].options && sels[i].options[sels[i].selectedIndex];
        var m = opt && String(opt.text || '').match(/第\s*(\d{1,2})\s*周/);
        if (m) {
          anchor.week = Number(m[1]);
          break;
        }
      }
      var inputs = doc.querySelectorAll('input');
      for (var j = 0; j < inputs.length; j += 1) {
        var v = String(inputs[j].value || '');
        if (/^20\d{2}-\d{2}-\d{2}$/.test(v)) {
          anchor.picker = v;
          break;
        }
      }
      var body = String(visibleText(doc.body) || '').slice(0, 3000);
      var tm = body.match(TERM_RE);
      if (tm) anchor.term = tm[1] + '-' + tm[2] + '-' + tm[3];
    } catch (e) {
      // 忽略
    }
    return anchor;
  }


  /* ------------------------------------------------------------ 周历（月历） */

  /**
   * 教务「周历」页：`/jsxsd/framework/xsjsdPerson_zlxx.jsp`
   * （学生首页右上角点时间就打开它）
   *
   * 它给的是一条**确定的对应关系**：
   *   教学第8周 / 2026年10月 / 第八周 19 20 21 22 23 24 25（当前周那一行带 currentMoth）
   * 即「第 8 周 = 10-19 ~ 10-25」，于是起始日 = 10-19 − 7×7 = 08-31。
   * 比"当前第几周"的文本稳：不依赖措辞、不依赖今天是周几。
   */
  var CAL_URL = '/jsxsd/framework/xsjsdPerson_zlxx.jsp';

  function parseCalendar(html) {
    var s = String(html || '');
    if (!s) return null;
    var w = s.match(/教学第\s*(\d{1,2})\s*周/);
    var ym = s.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月/);
    var at = s.indexOf('currentMoth');
    if (!w || !ym || at < 0) return null;

    var seg = s.slice(at);
    var end = seg.indexOf('</tr>');
    if (end > 0) seg = seg.slice(0, end);
    var days = [];
    var re = /<div[^>]*>\s*(\d{1,2})\s*<\/div>/g;
    var m;
    while ((m = re.exec(seg))) days.push(Number(m[1]));
    if (!days.length) return null;

    var term = null;
    var tm = s.match(/(20\d{2})\s*[-－]\s*(20\d{2})/);
    if (tm) {
      var half = s.match(/第\s*([12一二])\s*学期/);
      var n = half ? (half[1] === '一' ? 1 : half[1] === '二' ? 2 : Number(half[1])) : null;
      term = tm[1] + '-' + tm[2] + (n ? '-' + n : '');
    }
    return { year: Number(ym[1]), month: Number(ym[2]), firstDay: days[0], week: Number(w[1]), term: term };
  }

  function fetchCalendar(cb) {
    var ctrl = null;
    try {
      if (typeof AbortController === 'function') ctrl = new AbortController();
    } catch (e) {
      ctrl = null;
    }
    // 校园网偶尔很慢：2.5s 拿不到就放弃，别把整次抓取拖过去
    var timer = setTimeout(function () {
      try {
        if (ctrl) ctrl.abort();
      } catch (e) {
        // 忽略
      }
    }, 2500);
    try {
      var opts = { credentials: 'same-origin' };
      if (ctrl) opts.signal = ctrl.signal;
      fetch(CAL_URL, opts)
        .then(function (r) {
          clearTimeout(timer);
          return r && r.ok ? r.text() : '';
        })
        .then(function (html) {
          cb(parseCalendar(html));
        })
        .catch(function () {
          clearTimeout(timer);
          cb(null);
        });
    } catch (e) {
      clearTimeout(timer);
      cb(null);
    }
  }

  /** 课表页通常不显示当前周，学生首页才有；按顺序试几个同源地址。 */
  var HOME_URLS = [
    '/jsxsd/framework/xsMain_bjyddx.jsp',
    '/jsxsd/framework/xsMain.jsp',
    '/jsxsd/index.jsp'
  ];

  function stripHtml(html) {
    return String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[\s\u00a0]+/g, ' ');
  }

  function fetchHomeSignals(cb) {
    var i = 0;
    function next() {
      if (i >= HOME_URLS.length) {
        cb([]);
        return;
      }
      var url = HOME_URLS[i];
      i += 1;
      var ctrl = null;
      try {
        if (typeof AbortController === 'function') ctrl = new AbortController();
      } catch (e) {
        ctrl = null;
      }
      var timer = setTimeout(function () {
        try {
          if (ctrl) ctrl.abort();
        } catch (e) {
          // 忽略
        }
      }, 2000);
      var opts = { credentials: 'same-origin' };
      if (ctrl) opts.signal = ctrl.signal;
      fetch(url, opts)
        .then(function (r) {
          return r && r.ok ? r.text() : '';
        })
        .then(function (html) {
          clearTimeout(timer);
          var text = stripHtml(html);
          if (text && text.indexOf('周') >= 0) cb([text.slice(0, 3000)]);
          else next();
        })
        .catch(function () {
          clearTimeout(timer);
          next();
        });
    }
    next();
  }

  /* ---------------------------------------------------------------- 组装 */

  collect(window, 0);
  out.sort(function (a, b) {
    return b.score - a.score;
  });

  var picked = [];
  var seen = {};
  var total = 0;
  for (var k = 0; k < out.length && picked.length < MAX_CANDIDATES; k += 1) {
    var html = out[k].html;
    var key = html.slice(0, 300);
    if (seen[key]) continue;
    seen[key] = 1;
    if (total + html.length > MAX_TOTAL) continue;
    total += html.length;
    picked.push({ label: out[k].label, html: html, score: out[k].score });
  }

  var href = '';
  try {
    href = String(window.top.location.href);
  } catch (e) {
    href = '';
  }
  var title = '';
  try {
    title = String(document.title || '');
  } catch (e) {
    title = '';
  }

  var base = {
    url: href,
    title: title,
    at: new Date().toISOString(),
    candidates: picked,
    signals: pageSignals()
  };
  try {
    if (bestTable) base.signals.weekAnchor = weekAnchorOf(bestTable, bestTable.ownerDocument || document);
  } catch (e) {
    // 忽略
  }

  /** 同步采集结果（原生侧兜底直接用返回值）。 */
  window.__buptCollect = function () {
    return base;
  };

  /** 异步采集：补首页信号后交给原生。 */
  window.__buptCapture = function () {
    var done = false;
    function deliver(extra, cal) {
      if (done) return;
      done = true;
      var payload = base;
      if ((extra && extra.length) || cal) {
        payload = {
          url: base.url,
          title: base.title,
          at: base.at,
          candidates: base.candidates,
          signals: {
            weekTexts: base.signals.weekTexts.concat(extra || []),
            weakTexts: base.signals.weakTexts,
            titles: base.signals.titles,
            // ★ 必须带上：这里重建 signals 时漏掉 weekAnchor，
            //   会让"自动导入"永远识别不出学期起始周（网页只看得到 candidates）
            weekAnchor: base.signals.weekAnchor || null,
            // 周历（第 N 周 = 哪天到哪天）——比文本更硬的证据
            calendar: cal || null
          }
        };
      }
      var json = '';
      try {
        json = JSON.stringify(payload);
      } catch (e) {
        return;
      }
      try {
        if (window.BuptCapture && typeof window.BuptCapture.deliver === 'function') {
          window.BuptCapture.deliver(json);
        }
      } catch (e) {
        // 原生接口不可用时只能放弃（超时兜底会提示用户重试）
      }
    }
    // 页面迟迟不回也不能卡住用户
    var guard = setTimeout(function () {
      deliver(null, null);
    }, 6000);

    // ① 优先周历：它直接给出「第 N 周 = 哪天到哪天」
    try {
      fetchCalendar(function (cal) {
        if (cal) {
          clearTimeout(guard);
          deliver(null, cal);
          return;
        }
        // ② 周历取不到，退回首页文本（「2026-2027-1 第8周」这类）
        try {
          fetchHomeSignals(function (texts) {
            clearTimeout(guard);
            deliver(texts, null);
          });
        } catch (e) {
          clearTimeout(guard);
          deliver(null, null);
        }
      });
    } catch (e) {
      clearTimeout(guard);
      deliver(null, null);
    }
  };

  // 供自动化测试直接调用（不影响线上逻辑）
  window.__buptParseCalendar = parseCalendar;

  // 同步兜底：脚本的返回值就是采集结果
  return JSON.stringify(base);
})()
