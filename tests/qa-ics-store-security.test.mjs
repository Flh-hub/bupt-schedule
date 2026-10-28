/**
 * qa-store-security.test.mjs — 存储健壮性 / 输出转义 / 外链与导航契约。
 *
 * 日历(.ics) 导出功能已移除，原 G5/ICS 格式用例随之删除；
 * 保留：损坏 JSON、版本兼容、隐私模式、配额、备份往返、XSS 转义、零外链、tab 契约。
 * 全程 node:test，不依赖 DOM（jsdom 不在零依赖约束内）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { emptyState, STORAGE_KEY, SCHEMA_VERSION } from '../src/model.js';
import { getReminders, resolveDay } from '../src/calendar.js';
import { createStore } from '../src/store.js';
import { badge, chips, escapeHtml, panel, segmented, toggleSwitch } from '../src/ui/components.js';
import { parseText } from '../src/parsers/index.js';

const WEEKS_ALL = { start: 1, end: 20, type: 'all', extra: [] };
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

function makeState(over = {}) {
  const st = emptyState();
  st.settings.semesterStartMonday = over.start === undefined ? '2026-09-07' : over.start;
  st.settings.totalWeeks = over.totalWeeks === undefined ? 20 : over.totalWeeks;
  if (over.reminder) st.settings.reminder = { ...st.settings.reminder, ...over.reminder };
  st.holidays = over.holidays || [];
  st.courses = over.courses || [{ id: 'c1', name: '高等数学', teacher: '王老师' }];
  st.sessions = over.sessions || [
    { id: 's1', courseId: 'c1', dayOfWeek: 4, startPeriod: 1, endPeriod: 2, location: '教三-201', weeks: WEEKS_ALL }
  ];
  st.adjustments = over.adjustments || [];
  return st;
}

/**
 * 内存版 localStorage（store 测试用）。
 * ★ 必须自带 getItem/setItem/removeItem/clear/length/key：store 会读 length 判断可用性。
 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null
  };
}


test('store：localStorage 里是损坏 JSON → 不崩溃、storageBroken 置位、原始串不被清掉', () => {
  const storage = fakeStorage({ [STORAGE_KEY]: '{"settings":{broken' });
  const store = createStore({ storage });
  assert.equal(store.getState().courses.length, 0);
  assert.equal(store.isStorageBroken(), true);
  assert.equal(storage.getItem(STORAGE_KEY), '{"settings":{broken', '损坏的原始数据不应被静默覆盖');
});

test('store：高于当前 schemaVersion 的数据 → 不崩溃且 storageBroken 置位', () => {
  const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ schemaVersion: 99, courses: [{ id: 'c1', name: 'x' }] }) });
  const store = createStore({ storage });
  assert.equal(store.getState().schemaVersion, SCHEMA_VERSION);
  assert.equal(store.getState().courses.length, 0);
  assert.equal(store.isStorageBroken(), true);
});

test('store：localStorage 不可用（隐私模式）→ 内存兜底，dispatch 仍可用', () => {
  const store = createStore({ storage: null });
  const result = store.dispatch({ type: 'SET_SEMESTER', payload: { semesterStartMonday: '2026-09-07', totalWeeks: 20 } });
  assert.equal(result.ok, true);
  assert.equal(store.isStorageBroken(), true);
  assert.equal(store.getState().settings.semesterStartMonday, '2026-09-07');
});

test('store：写入抛错（配额满）→ storageBroken 置位且不抛给调用方', async () => {
  const storage = fakeStorage();
  const store = createStore({ storage });
  storage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  assert.doesNotThrow(() =>
    store.dispatch({ type: 'SET_SEMESTER', payload: { semesterStartMonday: '2026-09-07', totalWeeks: 20 } })
  );
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(store.isStorageBroken(), true);
});

test('store：备份导出 → 清空 → 恢复（覆盖模式）往返一致', () => {
  const store = createStore({ storage: fakeStorage() });
  store.dispatch({ type: 'SET_SEMESTER', payload: { semesterStartMonday: '2026-09-07', totalWeeks: 18 } });
  store.dispatch({
    type: 'IMPORT_COMMIT',
    payload: {
      parseResult: {
        courses: [{ id: 'c1', name: '高等数学', teacher: '王老师' }],
        sessions: [
          { id: 's1', courseId: 'c1', dayOfWeek: 4, startPeriod: 1, endPeriod: 2, location: '教三-201', weeks: { start: 1, end: 16, type: 'all', extra: [] }, rawWeeksText: '1-16周' }
        ]
      }
    }
  });
  const snapshot = () =>
    JSON.stringify({
      courses: store.getState().courses,
      sessions: store.getState().sessions,
      adjustments: store.getState().adjustments,
      start: store.getState().settings.semesterStartMonday,
      weeks: store.getState().settings.totalWeeks
    });
  const before = snapshot();

  const exported = store.dispatch({ type: 'EXPORT_BACKUP' });
  assert.equal(exported.ok, true);
  assert.ok(exported.data.includes('schemaVersion'));

  store.dispatch({ type: 'CLEAR_ALL' });
  assert.equal(store.getState().courses.length, 0);

  const restored = store.dispatch({ type: 'RESTORE_BACKUP', payload: { payload: exported.data } });
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.equal(snapshot(), before, '备份恢复往返不一致');
});

test('store：恢复时拒绝非法输入（坏 JSON / 高版本 / 非法总周数）', () => {
  const store = createStore({ storage: fakeStorage() });
  const bad1 = store.dispatch({ type: 'RESTORE_BACKUP', payload: { payload: '{not json' } });
  assert.equal(bad1.ok, false);
  const bad2 = store.dispatch({ type: 'RESTORE_BACKUP', payload: { payload: { schemaVersion: 9 } } });
  assert.equal(bad2.ok, false);
  assert.match(bad2.errors.join(''), /版本/);
  const bad3 = store.dispatch({
    type: 'RESTORE_BACKUP',
    payload: { payload: { schemaVersion: 1, settings: { totalWeeks: 99 }, courses: [], sessions: [] } }
  });
  assert.equal(bad3.ok, false);
  assert.match(bad3.errors.join(''), /总周数/);
});

test('store：SET_MAKEUP_FOLLOW 校验取值与目标日期', () => {
  const store = createStore({ storage: fakeStorage() });
  assert.equal(store.dispatch({ type: 'SET_MAKEUP_FOLLOW', payload: { date: '2026-10-10', follow: 9 } }).ok, false);
  assert.equal(store.dispatch({ type: 'SET_MAKEUP_FOLLOW', payload: { date: '2026-11-11', follow: 3 } }).ok, false);
  const ok = store.dispatch({ type: 'SET_MAKEUP_FOLLOW', payload: { date: '2026-10-10', follow: 4 } });
  assert.equal(ok.ok, true);
  const entry = store.getState().holidays.find((h) => h.date === '2026-10-10');
  assert.equal(entry.followDayOfWeek, 4);
  assert.equal(entry.inferred, false, '用户明确指定后不再是推定值');
  assert.ok(entry.updatedAt, 'SET_MAKEUP_FOLLOW 必须刷新 updatedAt（导出过期判定依赖它）');
});

test('store：批量「都不上课」逐日写入 none，且不引入全局静默开关', () => {
  const store = createStore({ storage: fakeStorage() });
  const result = store.dispatch({ type: 'SET_MAKEUP_FOLLOW_BULK', payload: { none: true } });
  assert.equal(result.ok, true);
  const targets = store.getState().holidays.filter((h) => h.type === 'makeupWorkday');
  assert.ok(targets.length >= 5);
  for (const h of targets) assert.equal(h.followDayOfWeek, 'none', `${h.date} 未被逐日写入`);
  assert.equal(
    Object.keys(store.getState().settings).some((k) => /silent|mute|allNone|holidayOff/i.test(k)),
    false,
    '不得引入全局静默字段'
  );
});

test('store：节次时间倒序被拒绝，提前量越界被拒绝', () => {
  const store = createStore({ storage: fakeStorage() });
  const bad = store.dispatch({ type: 'SET_PERIOD', payload: { index: 2, field: 'start', value: '07:50' } });
  assert.equal(bad.ok, false);
  assert.equal(store.getState().settings.periods.find((p) => p.index === 2).start, '08:50', '校验失败不得写入');
  assert.equal(store.dispatch({ type: 'SET_REMINDER_DEFAULTS', payload: { defaultAdvanceMinutes: 2000 } }).ok, false);
  assert.equal(store.dispatch({ type: 'SET_REMINDER_DEFAULTS', payload: { defaultAdvanceMinutes: 1440 } }).ok, true);
});

test('store：导入历史最多保留 3 份', () => {
  const store = createStore({ storage: fakeStorage() });
  for (let i = 0; i < 5; i += 1) {
    store.dispatch({
      type: 'IMPORT_COMMIT',
      payload: {
        parseResult: {
          courses: [{ id: 'c1', name: `课程${i}` }],
          sessions: [{ id: `s${i}`, courseId: 'c1', dayOfWeek: 1, startPeriod: 1, endPeriod: 2, location: '', weeks: { start: 1, end: 16, type: 'all', extra: [] } }]
        }
      }
    });
  }
  assert.equal(store.getState().importHistory.length, 3);
});

/* ------------------------------------------------------------------ 转义 */

test('escapeHtml 覆盖 5 个元字符', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)');
  assert.equal(escapeHtml('a&b'), 'a&amp;b');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  assert.equal(escapeHtml(null), '');
});

test('模板函数输出不含裸标签（课程名/地点含 <script> 与引号注入）', () => {
  const payload = '<script>alert(1)</script>';
  const quote = '" onmouseover="alert(1)';
  const outputs = [
    badge(payload),
    badge(quote),
    segmented([{ value: payload, label: payload }], payload, 'act'),
    chips([{ value: quote, label: quote }], quote, 'act'),
    panel(payload, '<b>body</b>', false),
    toggleSwitch(true, 'x', quote)
  ];
  for (const html of outputs) {
    assert.equal(/<script/i.test(html), false, `输出含裸 <script>：${html.slice(0, 120)}`);
    assert.equal(/onmouseover="/.test(html.replace(/aria-[a-z]+="[^"]*"/g, '')), false, '输出含可执行的属性注入');
  }
});

test('恶意课程名经解析后仍保持原样（转义发生在渲染层，不在数据层）', () => {
  const parsed = parseText('周一 1-2节 高数<script>alert(1)</script> 教三-101 1-16周');
  assert.equal(parsed.sessions.length, 1);
  const rendered = escapeHtml(parsed.courses[0].name);
  assert.equal(/<script/i.test(rendered), false);
});

/* --------------------------------------------------------- 静态资源与离线合规 */

test('PWA 必需静态文件存在且非空（离线预缓存清单的前提）', () => {
  const files = [
    'index.html',
    'manifest.webmanifest',
    'sw.js',
    'src/main.js',
    'assets/css/app.css',
    'assets/icons/icon-192.png',
    'assets/icons/icon-512.png'
  ];
  for (const file of files) {
    const abs = path.resolve(file);
    assert.equal(fs.existsSync(abs), true, `缺少静态文件：${file}`);
    assert.ok(fs.statSync(abs).size > 0, `${file} 是空文件`);
  }

  const manifest = JSON.parse(fs.readFileSync('manifest.webmanifest', 'utf8'));
  assert.equal(manifest.name, '北邮课程表');
  assert.ok(manifest.short_name, 'short_name 必填');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '.');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), `缺少 192/512 图标：${JSON.stringify(sizes)}`);
  assert.ok(
    manifest.icons.some((i) => String(i.purpose || '').includes('maskable')),
    'Android 自适应图标需要 maskable purpose（ARCHITECTURE §1 资源清单）'
  );
});

/**
 * G4′ — 零外链（1.4.0 起回到最硬的契约：不要账号、不要云同步）。
 *
 * 1. 壳文件（index.html / sw.js / manifest / css）与 `src/**` 全部不得出现 http(s) 字面量；
 *    唯一例外是 `src/ui/import.js` 里那条「打开教务系统登录页」的 `<a href>`——
 *    用户点了才导航、页面加载时零请求，且必须 `target=_blank` + `rel=noopener`。
 * 2. `.ics` 里的 `bupt_schedule` 是日历 UID 文本，不是链接，白名单放行。
 * 3. 已经没有云端了，所以也不该残留任何「动态注入外部脚本」或云服务数据面路径。
 */
test('全仓库零外链（G4′）', () => {
  const NAV = 'https://jwgl.bupt.edu.cn/jsxsd/framework/xsMain_bjyddx.jsp';
  const shellFiles = ['index.html', 'sw.js', 'manifest.webmanifest', 'assets/css/app.css'];

  const srcFiles = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) srcFiles.push(p.replace(/\\/g, '/'));
    }
  };
  walk('src');

  const offenders = [];
  let navSeen = 0;
  for (const file of [...shellFiles, ...srcFiles]) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (const hit of content.match(/https?:\/\/[^\s'"\)]+/g) || []) {
      if (hit.includes('bupt_schedule')) continue;
      if (file.endsWith('src/ui/import.js') && hit === NAV) {
        navSeen += 1;
        const at = lines.findIndex((l) => l.includes(NAV));
        const block = lines.slice(Math.max(0, at - 1), at + 3).join(' ');
        assert.ok(/href=/.test(block), '教务地址必须放在 href 里，不能用于请求');
        assert.ok(
          /target="_blank"/.test(block) && /rel="noopener/.test(block),
          '外链必须 target=_blank + rel=noopener'
        );
        continue;
      }
      offenders.push(`${file}: ${hit}`);
    }
  }

  assert.deepEqual(offenders, [], '出现外链：离线打开不再自足');
  assert.ok(navSeen >= 1, '导入页必须保留「打开教务系统登录页」的导航入口');

  // 没有云端：不残留 SDK 注入，也不再有云服务数据面
  const all = [...shellFiles, ...srcFiles].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(!/createElement\('script'\)/.test(all), '不应再动态注入外部脚本（云端已移除）');
  assert.ok(!/\.cloud\//.test(all), '不应再出现云服务数据面路径');
});

test('package.json 零依赖（G8）', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.type, 'module', 'type: module 被改动会导致 node --test 加载方式变化');
  assert.equal(pkg.dependencies == null || Object.keys(pkg.dependencies).length === 0, true);
  assert.equal(pkg.devDependencies == null || Object.keys(pkg.devDependencies).length === 0, true);
});

/**
 * G4″ — 导入页只有一个入口（1.7.0 起）。
 *
 * 用户明确要求：四个通道标签（粘贴文本 / HTML / JSON / 跳转登录）合并成**一个**登录跳转入口，
 * 抓完展示课程列表再确认。契约钉死四件事：
 *   ① 主页面不再有通道分段（CHANNELS 只剩备用三通道，且叫 MANUAL_CHANNELS）
 *   ② 主页面必须有抓取入口 + 教务系统 href（浏览器兜底）
 *   ③ 备用通道只能出现在二级页 #/import/manual
 *   ④ 抓取结果必须走「课程列表 → 确认导入」，不能直接落库
 */
test('导入页是单一登录跳转入口（G4″）', () => {
  const importSrc = fs.readFileSync('src/ui/import.js', 'utf8');
  const mainSrc = fs.readFileSync('src/main.js', 'utf8');

  assert.ok(!/const CHANNELS = \[/.test(importSrc), '主页面不应再有四通道 CHANNELS');
  assert.ok(/const MANUAL_CHANNELS = \[/.test(importSrc), '备用通道应命名为 MANUAL_CHANNELS');
  assert.ok(!/value: 'account', label: '跳转登录'/.test(importSrc), '不再有「跳转登录」通道标签');
  assert.ok(!/账号直连不可用/.test(mainSrc), 'main.js 不得有旧拦截弹窗');

  assert.ok(/data-action="import-native-capture"/.test(importSrc), '必须有 App 内抓取入口');
  assert.ok(importSrc.includes('jwgl.bupt.edu.cn'), '浏览器兜底必须含教务系统入口');
  assert.ok(/rel="noopener/.test(importSrc), '外链必须带 rel=noopener');

  assert.ok(/#\/import\/manual/.test(importSrc), '备用导入必须在二级页 #/import/manual');
  assert.ok(/#\/import\/detail/.test(importSrc), '逐条核对必须在二级页 #/import/detail');

  assert.ok(/buildCourseSummary/.test(importSrc), '抓取结果必须聚合成课程列表');
  assert.ok(/data-action="import-commit"/.test(importSrc), '课程列表里必须有「确认导入」');
  assert.ok(/case 'goto-channel'/.test(mainSrc), '必须有 goto-channel 动作，回填到备用通道');
});

test('底部导航 5 个 tab（含作业），无账号页（G4‴）', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const routes = [...html.matchAll(/data-route="#\/([a-z]+)"/g)].map((m) => m[1]);
  // 1.12.0 加了「作业」tab。顺序有意义：课表/作业是天天看的，导入/提醒/设置是配置类。
  assert.deepEqual(
    routes,
    ['timetable', 'homework', 'import', 'reminder', 'settings'],
    '底部 tab 应为 5 个，且「作业」紧跟课表'
  );
  assert.ok(!html.includes('account'), 'index.html 不应再出现 account 路由');
  const mainSrc = fs.readFileSync('src/main.js', 'utf8');
  assert.ok(!/renderAccount|createSync|loadSdk/.test(mainSrc), 'main.js 不应再引用账号/云同步模块');

  // tabbar 列数不能写死：5 个 tab 改成 4 个时，repeat(5, 1fr) 会留一格空白 → "底下没对齐"
  const css = fs.readFileSync('assets/css/app.css', 'utf8');
  const tabbar = css.slice(css.indexOf('.tabbar {'), css.indexOf('.tabbar {') + 600);
  assert.ok(
    !tabbar.includes('grid-template-columns'),
    'tabbar 不能写死列数（5 tab 改 4 时会留一格空白 → 底部错位）'
  );
  assert.ok(/grid-auto-columns:\s*1fr/.test(tabbar), 'tabbar 应用 grid-auto-columns: 1fr 按实际 tab 数均分');
});
