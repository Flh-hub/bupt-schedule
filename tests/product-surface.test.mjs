/**
 * product-surface.test.mjs — 「面向终端用户」的产品边界。
 *
 * 开发期为了排障，界面上曾经有一批入口：
 *   · 提醒页「发一条测试通知」（会凭空发一条假课）
 *   · 首次引导 / 通知弹层里的「试一张」流体云
 *   · 「修改后台运行模式」页的隐藏诊断块（列出本机能打开的耗电页）
 * 这些对用户没有意义，还会让人以为「点了就代表已开好」。1.66.31 起全部下线。
 *
 * 这条测试守两件事：
 *   ① 这些入口和它们的原生桥不许偷偷回来；
 *   ② 下线它们的同时，真正的功能必须还在（别把提醒链路一起删了）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const JAVA_DIR = path.join('android', 'java', 'com', 'bupt', 'schedule');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const jsFiles = walk('src');
const javaFiles = fs.readdirSync(JAVA_DIR).filter((f) => f.endsWith('.java')).map((f) => path.join(JAVA_DIR, f));

test('界面上不再有「测试通知」入口', () => {
  for (const file of jsFiles) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!src.includes('notify-test'), `${file} 还留着 data-action="notify-test"`);
    assert.ok(!src.includes('notifyTest'), `${file} 还在调原生 notifyTest`);
    assert.ok(!src.includes('测试通知'), `${file} 文案里还有"测试通知"`);
  }
  for (const file of javaFiles) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('notifyTest'), `${file} 还暴露 notifyTest 桥`);
  }
});

test('流体云「试一张」试发链路整体下线', () => {
  for (const file of jsFiles) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!src.includes('promoteDemo'), `${file} 还在调 promoteDemo`);
    assert.ok(!src.includes('data-pm'), `${file} 还有「试一张」按钮`);
    assert.ok(!src.includes('试一张'), `${file} 文案里还有"试一张"`);
  }
  assert.ok(!fs.existsSync(path.join('src', 'ui', 'promoted.js')), 'promoted.js 应已删除');
  for (const file of javaFiles) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('promoteDemo'), `${file} 还暴露 promoteDemo 桥`);
  }
});

test('后台运行模式页不再有诊断块', () => {
  const rv = fs.readFileSync(path.join('src', 'ui', 'reminderView.js'), 'utf8');
  assert.ok(!rv.includes('battery-diag'), '提醒页还有诊断开关');
  assert.ok(!rv.includes('diagHtml'), '提醒页还在渲染诊断块');
  assert.ok(!fs.readFileSync(path.join('src', 'native.js'), 'utf8').includes('batteryActivities'), 'native.js 还有诊断接口');
});

test('测试用的 requestCode 常量不该留在正式包里', () => {
  const js = fs.readFileSync(path.join('src', 'grab.js'), 'utf8');
  assert.ok(!js.includes('TEST_RC'));
  for (const file of javaFiles) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('TEST_RC'), `${file} 还有 TEST_RC`);
  }
});

test('真正的功能仍在（别把提醒链路一起删了）', () => {
  const scheduler = fs.readFileSync(path.join(JAVA_DIR, 'ReminderScheduler.java'), 'utf8');
  assert.ok(scheduler.includes('notifyNow('), '改造提醒的入口没了');
  assert.ok(scheduler.includes('buildCard('), '提醒卡片构造没了');

  const card = fs.readFileSync(path.join(JAVA_DIR, 'ClassCard.java'), 'utf8');
  assert.ok(card.includes('canPromote('), '胶囊提升判定没了（真实课前胶囊依赖它）');

  const widget = fs.readFileSync(path.join(JAVA_DIR, 'CourseWidget.java'), 'utf8');
  assert.ok(widget.includes('syncAll('), '桌面小组件同步没了');

  const guide = fs.readFileSync(path.join('src', 'ui', 'notifyGuide.js'), 'utf8');
  assert.ok(guide.includes('jumpToNotifyPermissionPage'), '通知跳转的唯一入口没了');

  const perms = fs.readFileSync(path.join('src', 'permissions.js'), 'utf8');
  assert.ok(perms.includes('export function buildSteps'), '权限清单没了');
  assert.ok(perms.includes('NOTIFY_MANUAL_ITEMS'), '手动开哪几项的清单没了');
});

test('提醒页仍能展示权限状态与保活入口', () => {
  const rv = fs.readFileSync(path.join('src', 'ui', 'reminderView.js'), 'utf8');
  assert.ok(rv.includes('permissionCard'), '权限状态卡没了');
  assert.ok(rv.includes('keepalive'), '后台保活入口没了');
  assert.ok(rv.includes('#/reminder/battery-mode'), '「修改后台运行模式」页入口没了');
});

/* ---------------- 反馈入口 ---------------- */

test('关于页要有反馈邮箱，而且能一键复制', () => {
  const settings = fs.readFileSync('src/ui/settings.js', 'utf8');
  // 邮箱只在这一处定义。★ 不写死具体地址：开源仓库里是占位，部署方换成自己的即可
  const m = settings.match(/export const FEEDBACK_EMAIL = '([^']+)'/);
  assert.ok(m, '缺反馈邮箱常量');
  assert.match(m[1], /^[^@\s]+@[^@\s]+\.[^@\s]+$/, `反馈邮箱格式不对：${m[1]}`);
  assert.match(settings, /data-action="copy-feedback"/, '缺复制按钮');
  assert.match(settings, /发邮件到上面这个地址/, '缺一句引导用户的话');
  // 邮箱只允许出现在 settings.js 一处：别处再写死一遍，改地址就会漏改
  const mail = m[1];
  const elsewhere = ['src/main.js', 'src/ui/onboard.js', 'src/ui/privacy.js']
    .filter((f) => fs.readFileSync(f, 'utf8').includes(mail));
  assert.deepEqual(elsewhere, [], `这些文件又写了一遍邮箱：${elsewhere.join(', ')}`);
  assert.match(fs.readFileSync('src/main.js', 'utf8'), /FEEDBACK_EMAIL/, 'main.js 要 import 常量');

  const main = fs.readFileSync('src/main.js', 'utf8');
  assert.match(main, /case 'copy-feedback':/, '缺 copy-feedback 动作');
  assert.match(main, /copyText\(/, '要走统一的复制工具');
});

/* ---------------- 深色模式 ---------------- */
/* 断言一律用 includes / indexOf，不写正则 —— heredoc 会把反斜杠吃掉，踩过两次。 */

test('CSS 要有深色调色板，且覆盖的是令牌而不是组件', () => {
  const css = fs.readFileSync('assets/css/app.css', 'utf8');
  assert.ok(css.includes('color-scheme: light dark'), '要声明支持两套配色');
  assert.ok(css.includes('@media (prefers-color-scheme: dark)'), '缺深色媒体查询');

  const at = css.indexOf('@media (prefers-color-scheme: dark)');
  const blk = css.slice(at, at + 2000);
  for (const token of ['--bg:', '--surface:', '--text:', '--line:', '--brand:', '--warn-ink:', '--danger-bg:']) {
    assert.ok(blk.includes(token), '深色块里没覆盖 ' + token);
  }
  assert.ok(blk.includes('--canvas: #0'), '深色画布要足够暗');
});

test('组件级的深色覆盖必须放在文件末尾（否则被同权重规则盖掉）', () => {
  const css = fs.readFileSync('assets/css/app.css', 'utf8');
  const lastDark = css.lastIndexOf('@media (prefers-color-scheme: dark)');
  assert.ok(lastDark > css.length * 0.5, '组件级深色覆盖要放在文件后半段');
  assert.ok(css.slice(lastDark).includes('.tt-block'), '课程块兜底色没跟着深色走');
});

test('原生：系统栏与底色跟随深浅色，切模式不重建也要重刷', () => {
  const java = fs.readFileSync('android/java/com/bupt/schedule/MainActivity.java', 'utf8');
  assert.ok(java.includes('private boolean isNight()'), '缺 isNight');
  assert.ok(java.includes('private void applySystemBars()'), '缺 applySystemBars');
  const at = java.indexOf('public void onConfigurationChanged');
  assert.ok(at > 0, '缺 onConfigurationChanged：切深色后状态栏不会跟着变');
  const body = java.slice(at, at + 1400);
  assert.ok(body.includes('recreate()'), 'onConfigurationChanged 里没重建（主题不会换）');
  assert.ok(body.includes('applySystemBars()'), 'onConfigurationChanged 里没重刷系统栏');
  assert.ok(java.includes('Theme_Material_Dialog_Alert'), '原生对话框没按深浅色选主题');
});

test('主题必须分深浅两份，否则 WebView 永远上报 light', () => {
  const light = fs.readFileSync('android/res/values/styles.xml', 'utf8');
  const dark = fs.readFileSync('android/res/values-night/styles.xml', 'utf8');
  assert.ok(light.includes('name="AppTheme"'), 'values 里缺 AppTheme');
  assert.ok(dark.includes('name="AppTheme"'), 'values-night 里缺 AppTheme（缺了深色不生效）');
  assert.ok(light.includes('Theme.Material.Light'), '浅色主题应继承 Light');
  assert.equal(
    dark.includes('Theme.Material.Light'),
    false,
    '深色主题不能还继承 Light —— WebView 的 prefers-color-scheme 看的是宿主主题'
  );
  const mf = fs.readFileSync('android/AndroidManifest.xml', 'utf8');
  assert.ok(mf.includes('android:theme="@style/AppTheme"'), '清单里要用 AppTheme');
  const java = fs.readFileSync('android/java/com/bupt/schedule/MainActivity.java', 'utf8');
  assert.ok(java.includes('recreate()'), '切深浅色要重建 Activity，否则主题不换');
});
