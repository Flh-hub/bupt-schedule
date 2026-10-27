/**
 * capture-signals.test.mjs — 原生抓取脚本的信号契约（真跑 capture.js，不是读源码）。
 *
 * 背景：自动导入曾经"抓得到课、但抓不到学期起始周"。根因是 capture.js 在合并首页信号时
 * 重建了 `signals` 对象，把 `weekAnchor`（表头 `周一 08-31` + 周次下拉 `第1周`）整段丢了。
 * 网页侧拿不到锚点 → 只按"当前第 N 周"兜底 → 识别不出起始周。
 *
 * 这里用 jsdom 造一个强智样式的课表页，执行真实的 android/assets/native/capture.js：
 *   ① 同步出口 `__buptCollect()` 必须带 weekAnchor（表头日期 + 周次）
 *   ② 异步出口 `__buptCapture()`（会 fetch 首页补信号）交付的 payload **必须仍然带 weekAnchor**
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const captureSrc = fs.readFileSync('android/assets/native/capture.js', 'utf8');

const jsdomMod = await import(
  'file:///C:/Users/20976/.workbuddy/binaries/node/workspace/node_modules/jsdom/lib/api.js'
);
const JSDOM = (jsdomMod.default || jsdomMod).JSDOM;

/** 造一个"周次下拉 + 表头带日期"的课表页。 */
const PAGE = `<!doctype html><html><head><title>我的课表</title></head><body>
  <div class="term">2026-2027-1 学期</div>
  <select id="week"><option>第1周</option><option>第2周</option></select>
  <table id="kbtable">
    <tr><th>节次</th><th>星期一<br>08-31</th><th>星期二<br>09-01</th><th>星期三<br>09-02</th>
        <th>星期四<br>09-03</th><th>星期五<br>09-04</th><th>星期六<br>09-05</th><th>星期日<br>09-06</th></tr>
    <tr><td>1<br>08:00-08:45</td><td>高等数学<br>教三-101<br>1-16周</td><td></td><td>大学物理<br>教四-202<br>1-16周</td>
        <td></td><td>英语<br>主楼-410<br>1-16周</td><td></td><td></td></tr>
    <tr><td>2<br>08:50-09:35</td><td>高等数学<br>教三-101<br>1-16周</td><td></td><td>大学物理<br>教四-202<br>1-16周</td>
        <td></td><td>英语<br>主楼-410<br>1-16周</td><td></td><td></td></tr>
  </table>
  <p>当前周次：第 1 周</p>
</body></html>`;

function boot() {
  const dom = new JSDOM(PAGE, { url: 'https://jwgl.bupt.edu.cn/jsxsd/kbcx/kbxx_xskb', runScripts: 'outside-only' });
  const { window } = dom;
  window.eval(captureSrc);
  return window;
}

test('同步采集：表头日期与周次都能被抓成 weekAnchor', () => {
  const window = boot();
  const base = window.__buptCollect();
  const anchor = base.signals && base.signals.weekAnchor;
  assert.ok(anchor, '必须有 weekAnchor');
  assert.equal(anchor.week, 1, '周次应取自下拉选中项');
  assert.ok(anchor.dates.includes('08-31'), `表头日期缺失：${JSON.stringify(anchor.dates)}`);
  assert.ok(anchor.dates.length >= 6, '周一到周日都该读到');
  assert.equal(anchor.term, '2026-2027-1', '学年学期代码应识别出来');
  assert.ok(base.candidates.length >= 1, '课表 HTML 要作为候选带回去');
});

test('异步采集：补完首页信号后，weekAnchor 不能被丢掉（回归）', async () => {
  const window = boot();
  let delivered = null;
  window.BuptCapture = {
    deliver(json) {
      delivered = JSON.parse(json);
    }
  };
  // 首页信号：模拟 fetch 拿到 xsMain，里面写着「当前第 1 周」
  window.fetch = () =>
    Promise.resolve({
      ok: true,
      text: () => Promise.resolve('<html><body>当前教学周：第 1 周 2026-2027-1</body></html>')
    });

  window.__buptCapture();
  // fetch 是微任务，等事件循环走完（脚本内部 guard 是 3s，这里给的等待远小于它）
  await new Promise((r) => setTimeout(r, 250));

  assert.ok(delivered, '应当交付一次 payload');
  const anchor = delivered.signals && delivered.signals.weekAnchor;
  assert.ok(anchor, '合并首页信号后 weekAnchor 仍然要在（这正是之前丢的那一块）');
  assert.equal(anchor.week, 1);
  assert.ok(anchor.dates.includes('08-31'));
  assert.ok(
    (delivered.signals.weekTexts || []).some((t) => t.includes('第 1 周')),
    '首页文本也应合并进来'
  );
  assert.ok(delivered.candidates.length >= 1, '候选课表 HTML 不能因为合并而丢');
});

/** 教务周历页（/jsxsd/framework/xsjsdPerson_zlxx.jsp）的真实结构裁剪版。 */
const CAL_HTML = `<html><head><title>周历</title></head><body>
  <div>教学第8周</div>
  <table>
    <tr><th>2026年10月</th><th>一</th><th>二</th><th>三</th><th>四</th><th>五</th><th>六</th><th>日</th></tr>
    <tr><td><div>第七周</div></td><td><div>12</div></td><td><div>13</div></td><td><div>14</div></td>
        <td><div>15</div></td><td><div>16</div></td><td><div>17</div></td><td><div>18</div></td></tr>
    <tr><td class="currentMoth"><div>第八周</div></td><td><div>19</div></td><td><div>20</div></td><td><div>21</div></td>
        <td><div>22</div></td><td><div>23</div></td><td><div>24</div></td><td><div>25</div></td></tr>
  </table>
  <p>2026-2027 学年 第 1 学期</p>
</body></html>`;

test('周历页 → 「第 8 周 = 2026-10-19 起」这种确定对应关系', () => {
  const window = boot();
  const cal = window.__buptParseCalendar(CAL_HTML);
  assert.ok(cal, '应解析出周历');
  assert.equal(cal.week, 8);
  assert.equal(cal.year, 2026);
  assert.equal(cal.month, 10);
  assert.equal(cal.firstDay, 19, '当前周那一行的第一个日期就是周一');
  assert.equal(cal.term, '2026-2027-1', '学年 + 学期应拼成 2026-2027-1');
});

test('周历页结构不对时返回 null（宁可不用，也不要瞎算）', () => {
  const window = boot();
  assert.equal(window.__buptParseCalendar('<html><body>没有周历</body></html>'), null);
  assert.equal(window.__buptParseCalendar(''), null);
});

test('异步采集：拿得到周历时，signals.calendar 必须一起交付', async () => {
  const window = boot();
  let delivered = null;
  window.BuptCapture = { deliver(json) { delivered = JSON.parse(json); } };
  window.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve(CAL_HTML) });

  window.__buptCapture();
  await new Promise((r) => setTimeout(r, 250));

  assert.ok(delivered, '应当交付 payload');
  assert.ok(delivered.signals.calendar, '周历必须随 signals 一起回来');
  assert.equal(delivered.signals.calendar.week, 8);
  assert.equal(delivered.signals.calendar.firstDay, 19);
  assert.ok(delivered.candidates.length >= 1);
});

test('采集信号时压掉「第1周 第2周 … 第30周」这种下拉罗列', () => {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <select id="week">${Array.from({ length: 30 }, (_, i) => `<option>第${i + 1}周</option>`).join('')}</select>
      <p>当前周次：第 8 周</p>
      <table><tr><th>节次</th><th>星期一</th><th>星期二</th></tr>
      <tr><td>1<br>08:00-08:45</td><td>高数<br>教三-101<br>1-16周</td><td>物理<br>教四-202<br>1-16周</td></tr></table>
    </body></html>`,
    { url: 'https://jwgl.bupt.edu.cn/jsxsd/xkb/xskb_list.do', runScripts: 'outside-only' }
  );
  dom.window.eval(captureSrc);
  const base = dom.window.__buptCollect();
  const joined = (base.signals.weekTexts || []).join(' ');
  assert.ok(!/第\s*30\s*周/.test(joined), '下拉里的"第30周"不应留在强信号文本里');
  assert.ok(/第\s*8\s*周/.test(joined), '页面上真正写的「第 8 周」要保留');
});

/* ------------------------------------------------------------ 原生侧的注入顺序（真机踩过） */

test('两个抓取入口都必须"先注入 capture.js，再调用 __buptCapture"', () => {
  // 2026-10-25 真机：自动导入永远拿不到周历/周次信号。根因是 Java 侧先问
  // `typeof window.__buptCapture === 'function'`，但脚本压根没注入过 → 永远走 sync 分支。
  for (const file of [
    'android/java/com/bupt/schedule/AutoGrabber.java',
    'android/java/com/bupt/schedule/JwglActivity.java'
  ]) {
    const src = fs.readFileSync(file, 'utf8');
    const injectAt = src.indexOf('evaluateJavascript(captureJs');
    const askAt = src.indexOf("typeof window.__buptCapture");
    assert.ok(injectAt > 0, `${file} 没有注入 capture.js`);
    assert.ok(askAt > 0, `${file} 没有调用 __buptCapture`);
    assert.ok(
      injectAt < askAt,
      `${file} 里必须先注入脚本再判断 __buptCapture（当前顺序反了，会永远走同步分支）`
    );
  }
});

test('周历请求必须带超时，且异步兜底要留够时间（周历 + 首页两次请求）', () => {
  const src = fs.readFileSync('android/assets/native/capture.js', 'utf8');
  assert.ok(/fetchCalendar/.test(src));
  assert.ok(/AbortController/.test(src), '周历请求要有中断能力');
  assert.ok(/\},\s*2500\);/.test(src) || /2500/.test(src), '周历请求应有 2.5s 超时');
  const guard = src.match(/deliver\(null, null\);\s*\},\s*(\d+)\)/);
  assert.ok(guard && Number(guard[1]) >= 5000, '异步兜底应 ≥5s，否则两次请求来不及');
});
