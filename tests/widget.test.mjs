/**
 * tests/widget.test.mjs — 桌面小组件的数据契约。
 *
 * 小组件是原生 RemoteViews 渲染的，跑不了 JS、读不到 localStorage，只能吃网页
 * 序列化过去的 JSON。所以这份契约一旦破了，原生侧不会报错，只会**静默画错**：
 * 颜色非法 → Color.parseColor 抛异常 → 整块卡片空白；字段缺 → 一行空白；
 * 窗口不够长 → 第二天显示昨天的课。
 *
 * 因此这里测的不是"算得对不对"（那是 calendar.test.mjs 的事），而是
 * **交出去的那份 JSON 长什么样、能不能被原生安全消费**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { emptyState, todayStr, wallToEpoch, weeksToText } from '../src/model.js';
import { buildWidgetPayload, pickWidgetCourses, WIDGET_DAYS, WIDGET_MAX_COURSES } from '../src/widget.js';

/* ---------------------------------------------------------------- fixtures */

const COURSE = (id, name) => ({
  id,
  name,
  teacher: null,
  color: null,
  note: null,
  credit: null,
  createdAt: '2026-01-01T00:00:00+08:00',
  updatedAt: '2026-01-01T00:00:00+08:00'
});

const SESSION = (id, courseId, dayOfWeek, startPeriod, endPeriod, location) => {
  const weeks = { start: 1, end: 16, type: 'all', extra: [] };
  return {
    id,
    courseId,
    dayOfWeek,
    startPeriod,
    endPeriod,
    location: location || '教三-201',
    weeks,
    rawWeeksText: weeksToText(weeks),
    teacher: null,
    sourceRef: 'test'
  };
};

/**
 * 2026-09-07（周一）开学，第 7 周 = 10-19 ~ 10-25。
 * 所以「今天」固定取 2026-10-24（周六 · 第 7 周），只有 s4 这节数据结构。
 */
function makeState(extra = {}) {
  const state = emptyState();
  state.settings.semesterStartMonday = '2026-09-07';
  state.settings.totalWeeks = 20;
  state.courses = [
    COURSE('c1', '高等数学(上)'),
    COURSE('c2', '大学物理'),
    COURSE('c3', '数据结构')
  ];
  state.sessions = [
    SESSION('s1', 'c1', 1, 1, 2, '教三-104'), // 周一
    SESSION('s2', 'c2', 3, 3, 4, '教四-201'), // 周三 3-4
    SESSION('s3', 'c1', 3, 6, 7, '教三-104'), // 周三 6-7
    SESSION('s4', 'c3', 6, 1, 2, '实验楼-S215') // 周六
  ];
  Object.assign(state, extra.state || {});
  if (extra.settings) Object.assign(state.settings, extra.settings);
  return state;
}

/** 2026-10-24 10:00（周六）。用 wallToEpoch 而不是硬编码时间戳，避免受运行机器时区影响。 */
const NOW = wallToEpoch('2026-10-24', '10:00');

const dayOf = (payload, date) => payload.days.find((d) => d.date === date);

/* ---------------------------------------------------------------- 窗口 */

test('payload 覆盖 WIDGET_DAYS 天，从今天开始按天递增', () => {
  const p = buildWidgetPayload(makeState(), NOW);
  assert.equal(p.days.length, WIDGET_DAYS);
  assert.equal(p.days[0].date, '2026-10-24');
  assert.equal(p.days[1].date, '2026-10-25');
  assert.equal(p.days[WIDGET_DAYS - 1].date, '2026-11-06');
  for (let i = 1; i < p.days.length; i += 1) {
    assert.ok(p.days[i].date > p.days[i - 1].date, `${p.days[i].date} 没有比前一天大`);
  }
});

test('payload 带上 today 与 updatedAt（原生靠 today 找当天，缺了就显示"数据旧了"）', () => {
  const p = buildWidgetPayload(makeState(), NOW);
  assert.equal(p.version, 1);
  assert.equal(p.today, '2026-10-24');
  assert.equal(p.updatedAt, NOW);
});

test('opts.days 可调，但被夹在 1..31 之间（防止一次塞一整个学期）', () => {
  assert.equal(buildWidgetPayload(makeState(), NOW, { days: 3 }).days.length, 3);
  assert.equal(buildWidgetPayload(makeState(), NOW, { days: 0 }).days.length, WIDGET_DAYS);
  assert.equal(buildWidgetPayload(makeState(), NOW, { days: 400 }).days.length, 31);
});

test('payload 能 JSON round-trip 且内容不变（原生收到的就是这个字节串）', () => {
  const p = buildWidgetPayload(makeState(), NOW);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
});

/* ---------------------------------------------------------------- 单日内容 */

test('周六只有一节数据结构，字段齐全可被原生直接画出来', () => {
  const day = dayOf(buildWidgetPayload(makeState(), NOW), '2026-10-24');
  assert.equal(day.weekday, '周六');
  assert.equal(day.monthDay, '10月24日');
  assert.equal(day.weekNo, 7);
  assert.equal(day.complete, true);
  assert.equal(day.courses.length, 1);
  const c = day.courses[0];
  assert.equal(c.name, '数据结构');
  assert.equal(c.room, '实验楼-S215');
  assert.match(c.start, /^\d{2}:\d{2}$/);
  assert.match(c.end, /^\d{2}:\d{2}$/);
  assert.equal(c.periods, '第1-2节');
  assert.equal(c.isEvent, false);
});

test('一天多节课按时间先后排好（原生不做排序，拿到的顺序就是显示顺序）', () => {
  const day = dayOf(buildWidgetPayload(makeState(), NOW), '2026-10-28');
  assert.deepEqual(day.courses.map((c) => c.name), ['大学物理', '高等数学(上)']);
  assert.equal(day.courses[0].periods, '第3-4节');
  assert.equal(day.courses[1].periods, '第6-7节');
});

test('没课的日子给空数组而不是 null（原生 optJSONArray 拿到 null 会当成"没数据"）', () => {
  const day = dayOf(buildWidgetPayload(makeState(), NOW), '2026-10-25'); // 周日
  assert.deepEqual(day.courses, []);
  assert.equal(day.complete, true);
});

/* ---------------------------------------------------------------- 原生安全边界 */

test('每门课的 color 一定是 #rrggbb（非法值会让 Java 的 Color.parseColor 抛异常，整块卡片空白）', () => {
  const p = buildWidgetPayload(makeState(), NOW);
  for (const day of p.days) {
    for (const c of day.courses) assert.match(c.color, /^#[0-9a-f]{6}$/, `${c.name} 的颜色是 ${c.color}`);
  }
});

test('非法课程色回落到默认色，不会被原样传给原生', () => {
  const state = makeState();
  state.courses[0].color = 'red; drop table';
  const p = buildWidgetPayload(state, NOW);
  for (const day of p.days) {
    for (const c of day.courses) assert.match(c.color, /^#[0-9a-f]{6}$/);
  }
});

test('课名/地点超长会被截断（小组件一行放不下，原生还得多截一次）', () => {
  const state = makeState();
  state.courses[0].name = '一门名字特别特别特别特别特别特别特别特别特别特别长的课程名称一共三十多个字';
  state.sessions[0].location = '某个特别特别特别特别特别特别特别特别特别长的教学楼名称-101教室';
  const p = buildWidgetPayload(state, NOW);
  const c = dayOf(p, '2026-10-26').courses[0]; // 周一那节
  assert.ok(c.name.length <= 24, `课名长度 ${c.name.length}`);
  assert.ok(c.room.length <= 24, `地点长度 ${c.room.length}`);
  assert.ok(c.name.endsWith('…'));
});

test('没有显式配色的课也要拿到各自的调色板颜色（否则几门课全是同一条色条）', () => {
  const p = buildWidgetPayload(makeState(), NOW);
  const colors = new Set();
  for (const day of p.days) for (const c of day.courses) colors.add(c.color);
  assert.ok(colors.size >= 2, `整张表只出现了 ${colors.size} 种颜色`);
});

test('单日课程数被截到 WIDGET_MAX_COURSES，防止异常数据把 JSON 撑爆', () => {
  const state = makeState();
  const many = [];
  for (let i = 0; i < 30; i += 1) {
    const periods = emptyState().settings.periods;
    const p = periods[i % periods.length];
    many.push(SESSION(`x${i}`, 'c1', 1, Number(p.index), Number(p.index), '教三-101'));
  }
  state.sessions = many;
  const day = dayOf(buildWidgetPayload(state, NOW), '2026-10-26');
  assert.equal(day.courses.length, WIDGET_MAX_COURSES);
});

test('时间缺失的课退化成节次文本而不是空字符串（原生那行仍然有信息）', () => {
  const state = makeState();
  state.settings.periods = []; // 作息被清空 → 节次翻不出时刻
  const c = dayOf(buildWidgetPayload(state, NOW), '2026-10-24').courses[0];
  assert.equal(c.start, '');
  assert.equal(c.end, '');
  assert.equal(c.periods, '第1-2节');
});

/* ---------------------------------------------------------------- 与 App 内结论一致 */

test('放假那天没有课，且带上假期名（小组件标题栏要显示"中秋 · 放假"）', () => {
  const state = makeState({
    state: {
      holidays: [{ date: '2026-10-28', name: '测试节', type: 'holiday', followDayOfWeek: null }]
    }
  });
  const day = dayOf(buildWidgetPayload(state, NOW), '2026-10-28');
  assert.equal(day.holidayName, '测试节');
  assert.deepEqual(day.courses, []);
});

test('普通日子 holidayName 是 null，不是空串', () => {
  // ★ 这条不是形式主义：原生侧一旦用 `optString("holidayName", "")` 读，
  //   JSON null 会被读成字符串 "null"（fallback 只在键不存在时生效），
  //   拼进 `%1$s · 放假` 后桌面小组件右上角就印出「null · 放假」——1.27.0 真机修过。
  //   原生必须走 CourseWidget.str()（.gate-json.mjs 守着），这里钉住契约本身。
  const state = makeState({});
  for (const date of ['2026-10-24', '2026-10-26']) {
    const day = dayOf(buildWidgetPayload(state, NOW), date);
    assert.equal(day.holidayName, null, `${date} 的 holidayName 应为 null`);
  }
});

test('补班日还没确认那天上不上课时，complete 为 false（原生据此不给课程，只提示去确认）', () => {
  const state = makeState({
    state: {
      holidays: [{ date: '2026-10-31', name: '某假', type: 'makeupWorkday', followDayOfWeek: null }]
    }
  });
  const day = dayOf(buildWidgetPayload(state, NOW), '2026-10-31');
  assert.equal(day.complete, false);
});

test('调课（换教室）会反映到小组件，不用原生自己再算一遍', () => {
  const state = makeState({
    state: {
      adjustments: [
        {
          id: 'a1',
          type: 'roomChange',
          date: '2026-10-24',
          targetSessionId: 's4',
          location: '教二-330',
          createdAt: '2026-10-23T12:00:00+08:00'
        }
      ]
    }
  });
  const day = dayOf(buildWidgetPayload(state, NOW), '2026-10-24');
  assert.equal(day.courses.length, 1);
  assert.equal(day.courses[0].room, '教二-330');
});

test('自定义活动（event）也进小组件，用活动自己的名字', () => {
  const state = makeState({
    state: {
      adjustments: [
        {
          id: 'e1',
          type: 'event',
          date: '2026-10-25',
          title: '社团招新',
          startPeriod: 3,
          endPeriod: 4,
          location: '体育馆',
          createdAt: '2026-10-23T12:00:00+08:00'
        }
      ]
    }
  });
  const day = dayOf(buildWidgetPayload(state, NOW), '2026-10-25');
  assert.equal(day.courses.length, 1);
  assert.equal(day.courses[0].name, '社团招新');
  assert.equal(day.courses[0].isEvent, true);
});

/* ---------------------------------------------------------------- 取行规则 */

test('行数够时原样返回，不改顺序', () => {
  const list = [{ name: 'A', end: '09:40' }, { name: 'B', end: '11:30' }];
  assert.deepEqual(pickWidgetCourses(list, 5, 600).map((c) => c.name), ['A', 'B']);
});

test('行数不够时先丢已经上完的课（用户要看的是"接下来上什么"）', () => {
  const list = [
    { name: 'A', end: '09:40' },
    { name: 'B', end: '11:30' },
    { name: 'C', end: '15:00' }
  ];
  // 10:00 → A 已上完，只剩 B、C 两行可用
  assert.deepEqual(pickWidgetCourses(list, 2, 600).map((c) => c.name), ['B', 'C']);
});

test('全部上完时仍然全部返回（原生会淡化显示，而不是把卡片弄空）', () => {
  const list = [{ name: 'A', end: '09:40' }, { name: 'B', end: '11:30' }];
  assert.deepEqual(pickWidgetCourses(list, 5, 23 * 60).map((c) => c.name), ['A', 'B']);
});

test('todayStr 的今天和 payload 的第一天是同一天（跨零点后窗口必须跟着走）', () => {
  const p = buildWidgetPayload(makeState(), NOW);
  assert.equal(p.today, todayStr(NOW));
});


/* ---------------------------------------------------------------- 尺寸声明 */

test('小组件默认尺寸是 3×2', () => {
  const xml = fs.readFileSync('android/res/xml/course_widget_info.xml', 'utf8');
  // 系统换算公式 70*n-30：3 列 → 180dp，2 行 → 110dp
  assert.match(xml, /android:minWidth="180dp"/, '3 列');
  assert.match(xml, /android:minHeight="110dp"/, '2 行');
  assert.match(xml, /android:targetCellWidth="3"/);
  assert.match(xml, /android:targetCellHeight="2"/);
  // 能拖到 2 列 / 1 行
  assert.match(xml, /android:resizeMode="horizontal\|vertical"/);
  assert.match(xml, /android:minResizeWidth="110dp"/);
  assert.match(xml, /android:minResizeHeight="70dp"/);
});

test('行版式是「课名一行 + 时间/地点一行」（2 列放不下左时间列）', () => {
  const row = fs.readFileSync('android/res/layout/widget_row.xml', 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  // 时间不再单独占左侧一列，而是和 sub 一起放在第二行的横向容器里
  const timeIdx = row.indexOf('@+id/w_row_time');
  const subIdx = row.indexOf('@+id/w_row_sub');
  const nameIdx = row.indexOf('@+id/w_row_name');
  assert.ok(nameIdx > 0 && timeIdx > nameIdx && subIdx > timeIdx, '顺序应为 name → time → sub');
  // 时间不能是固定 42dp 的左侧列
  assert.equal(
    /w_row_time[\s\S]{0,200}?layout_width="42dp"/.test(row),
    false,
    '时间列不要固定宽度（2 列时会把课名挤没）'
  );
});

test('行数预算的常量要和布局里的高度对得上', () => {
  const java = fs.readFileSync('android/java/com/bupt/schedule/CourseWidget.java', 'utf8');
  const layout = fs.readFileSync('android/res/layout/widget_course.xml', 'utf8');
  const chrome = Number((java.match(/CHROME_DP = (\d+)/) || [])[1]);
  const head = Number((layout.match(/android:layout_height="(\d+)dp"\s*\n\s*android:orientation="horizontal"/) || [])[1]);
  const padTop = Number((layout.match(/android:paddingTop="(\d+)dp"/) || [])[1]);
  const padBottom = Number((layout.match(/android:paddingBottom="(\d+)dp"/) || [])[1]);
  assert.ok(chrome > 0 && head > 0, 'CHROME_DP / 标题栏高度没解析出来');
  // CHROME_DP = 标题栏 + 上下内边距 + 几 dp 余量；差太多就会多画或少画一行
  const overhead = chrome - (head + padTop + padBottom);
  assert.ok(overhead >= 0 && overhead <= 10, `CHROME_DP(${chrome}) 与 标题栏+内边距(${head + padTop + padBottom}) 差了 ${overhead}dp`);
});

test('小组件配置与 1.66.11 一致（改动它就会在 ColorOS 上炸）', () => {
  const xml = fs.readFileSync('android/res/xml/course_widget_info.xml', 'utf8');
  // 1.66.12~1.66.18 改过这里的每一项，每次都让 ColorOS 16 报
  // 「载入窗口小部件时出现问题」，且清桌面数据/重启/重装都救不回来。
  // 现在全部还原到 1.66.11。**要动这里，一次只改一处，改完立刻真机验证。**
  assert.match(xml, /android:initialLayout="@layout\/widget_course"/);
  assert.match(xml, /android:previewLayout="@layout\/widget_course"/);
  assert.match(xml, /android:previewImage="@drawable\/widget_preview"/);
  assert.match(xml, /android:updatePeriodMillis="1800000"/);
});

test('小组件要有极简兜底布局（桌面进程 apply 失败时还有得显示）', () => {
  assert.ok(fs.existsSync('android/res/layout/widget_min.xml'), '缺 widget_min.xml');
  const min = fs.readFileSync('android/res/layout/widget_min.xml', 'utf8');
  // 兜底布局必须简单到不可能失败：一个容器 + 一个 TextView
  const tags = [...min.matchAll(/<([A-Za-z]+)\s/g)].map((m) => m[1]);
  assert.deepEqual(tags, ['LinearLayout', 'TextView'], `兜底布局别塞复杂控件，当前：${tags}`);

  const java = fs.readFileSync('android/java/com/bupt/schedule/CourseWidget.java', 'utf8');
  assert.match(java, /R\.layout\.widget_min/, 'Java 侧要真的用上它');
  assert.match(java, /private static RemoteViews minimal\(Context ctx\)/);
});

test('启动时主动重绘小组件（sideload 装完是 stopped 状态，收不到任何广播）', () => {
  const java = fs.readFileSync('android/java/com/bupt/schedule/MainActivity.java', 'utf8');
  const at = java.indexOf('protected void onCreate(Bundle savedInstanceState)');
  assert.ok(at > 0, '缺 onCreate');
  const head = java.slice(at, at + 900);
  assert.match(head, /CourseWidget\.refreshAll\(this\)/, 'onCreate 里要把小组件重画一遍');
});

test('启动时主动重绘小组件（sideload 装完是 stopped 状态，收不到任何广播）', () => {
  const java = fs.readFileSync('android/java/com/bupt/schedule/MainActivity.java', 'utf8');
  const at = java.indexOf('protected void onCreate(Bundle savedInstanceState)');
  assert.ok(at > 0, '缺 onCreate');
  const head = java.slice(at, at + 900);
  assert.match(head, /CourseWidget\.refreshAll\(this\)/, 'onCreate 里要把小组件重画一遍');
});

test('RemoteViews 布局里不许出现 <View>（桌面会拒绝 inflate）', () => {
  // 真机日志（2026-10-26 14:52）：
  //   InflateException: Binary XML file line #14 in layout/widget_row:
  //   Error inflating class android.view.View
  //   Caused by: Class not allowed to be inflated android.view.View
  //
  // RemoteViews 只允许 @RemoteView 注解过的类（TextView / ImageView / LinearLayout …），
  // 裸 <View> 不在白名单里。以前"今天没课"时不画行，所以没暴露；一有课就整块报错。
  for (const f of ['widget_course.xml', 'widget_row.xml', 'widget_min.xml']) {
    const p = `android/res/layout/${f}`;
    if (!fs.existsSync(p)) continue;
    // 先去掉 XML 注释，注释里写「不能是 <View>」不算违规
    const xml = fs.readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.equal(
      /<View[\s>]/.test(xml),
      false,
      `${f} 里出现了 <View>，RemoteViews 会拒绝 inflate（改用 TextView）`
    );
  }
});
