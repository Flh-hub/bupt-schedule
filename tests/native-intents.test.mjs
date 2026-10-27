/**
 * native-intents.test.mjs — 原生"跳系统设置"的契约。
 *
 * 2026-10-25 真机反馈：点通知权限只停在「应用详情」，用户还得自己点
 * 权限管理 → 通知 两层。根因是只用 `ACTION_APP_NOTIFICATION_SETTINGS`，
 * ColorOS 不认（或不带 extra 时落到应用详情）。
 *
 * 所以这里钉死：必须先试**渠道级**（带渠道 ID），再试应用级（并补老 ROM 的 extra），
 * 最后才退回应用详情；而且每次 startActivity 失败要能继续下一个候选。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync('android/java/com/bupt/schedule/MainActivity.java', 'utf8');

// 文案/品牌数据也在这里一并验（同一批跨品牌改动）
const permissionsMod = await import('../src/permissions.js');
const keepaliveMod = await import('../src/keepalive.js');

test('通知设置跳转顺序：厂商直达 → 渠道页 → 通知列表 → 标准应用页 → 应用详情', () => {
  // 只看方法体里的代码：注释里也会出现这些名字，直接 indexOf 会误判顺序
  const body = src.slice(src.indexOf('private String openNotificationSettingsChain'));
  const vendorAt = body.indexOf('com.oplus.notificationmanager');
  const channelAt = body.indexOf('Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS');
  const listAt = body.indexOf('android.settings.NOTIFICATION_SETTINGS');
  const appAt = body.indexOf('Settings.ACTION_APP_NOTIFICATION_SETTINGS');
  assert.ok(vendorAt > 0, '缺少 ColorOS 厂商直达（com.oplus/com.coloros notificationmanager）');
  assert.ok(channelAt > vendorAt, '厂商直达要排在最前（ColorOS 会把标准 action fallback 到应用详情）');
  assert.ok(listAt > channelAt, '通知列表页要排在标准应用页之前（它是 ColorOS 真实可用的通知页）');
  assert.ok(appAt > listAt, '标准应用页排最后（ColorOS 上会落到应用详情）');
});

test('必须把"落在哪一级"回报给网页（否则用户不知道还差一步）', () => {
  assert.match(src, /public String openNotificationSettingsEx\(\)/, '缺少带返回值的跳转');
  for (const tag of ['vendor_new', 'vendor_old', 'channel', 'list', 'app', 'detail']) {
    assert.ok(src.includes(`"${tag}"`), `返回值缺少 ${tag}`);
  }
});

test('渠道级 intent 必须带渠道 ID，否则打开的是空页面', () => {
  assert.match(src, /putExtra\(Settings\.EXTRA_CHANNEL_ID/, '必须传 EXTRA_CHANNEL_ID');
  assert.match(src, /ReminderScheduler\.CHANNEL_ID/, '渠道 ID 要用常量，不要写字面量');
});

test('应用级 intent 要补老 ROM 认的 extra（app_package / app_uid）', () => {
  assert.match(src, /putExtra\("app_package"/);
  assert.match(src, /putExtra\("app_uid"/);
  assert.match(src, /putExtra\("android\.provider\.extra\.APP_PACKAGE"/);
});

test('每个候选都要"能开才继续"：失败就试下一个，最后兜底应用详情', () => {
  assert.match(src, /private boolean tryStartActivity\(Intent intent\)/, '缺少统一的 try/catch 启动器');
  assert.match(src, /if \(tryStartActivity\(ch\)\) return "channel";/, '渠道级失败要能继续');
  assert.match(src, /if \(tryStartActivity\(app\)\) return "app";/, '应用级失败要能继续');
  assert.match(src, /if \(tryStartActivity\(v\)\) return/, '厂商直达失败要能继续');
  assert.match(src, /openAppDetail\(\);/, '最后必须兜底到应用详情');
});

test('跳转前先建渠道（否则渠道页是空的）', () => {
  const chainAt = src.indexOf('private boolean openNotificationSettingsChain');
  const ensureAt = src.indexOf('ReminderScheduler.ensureChannel(this)', chainAt);
  assert.ok(ensureAt > chainAt, 'openNotificationSettingsChain 里要先 ensureChannel');
});

test('应用级通知未授权时，不得跳"渠道页"（那是灰的、点不动）', () => {
  assert.match(
    src,
    /final boolean granted = ReminderScheduler\.canNotify\(this\)/,
    '链里要先读应用级授权状态'
  );
  assert.match(
    src,
    /if \(granted && Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.O\)/,
    '渠道页必须用 granted 包住，否则未授权时会把用户送进"灰色死路"'
  );
});

test('「通知与控制中心」有独立入口，且只能在用户确认后调用', () => {
  assert.match(src, /public boolean openNotificationCenter\(\)/, '缺少"通知与控制中心"直达方法');
  assert.match(src, /android\.settings\.NOTIFICATION_SETTINGS/, '应跳到通知与控制中心');
  assert.match(src, /final boolean\[\] ok = \{false\}/, '要能返回是否真的打开了');
});

test('网页侧：确认框打开时不得调用任何跳转（未确认不跳转）', () => {
  const guide = fs.readFileSync('src/ui/notifyGuide.js', 'utf8');
  const openFn = guide.slice(guide.indexOf('export function openNotifyGuide'));
  assert.ok(!/openNotificationCenter|openNotificationSettingsEx/.test(openFn.slice(0, openFn.indexOf('}'))),
    'openNotifyGuide 里不能跳转，只能在"去设置"的回调里跳');

  const onboard = fs.readFileSync('src/ui/onboard.js', 'utf8');
  const actionBlock = onboard.slice(
    onboard.indexOf("'onboard-notify': () =>"),
    onboard.indexOf("'onboard-keepalive'")
  );
  assert.ok(!/openNotificationCenter|openNotificationSettingsEx/.test(actionBlock),
    '引导里点通知项只能弹确认框，不能直接跳转');
});

test('顺序硬约束：request 之后不得立即跳转，只在权限回调里跳', () => {
  const guide = fs.readFileSync('src/ui/notifyGuide.js', 'utf8');
  const fnStart = guide.indexOf('export function startNotifyFlow');
  const fnBody = guide.slice(fnStart, guide.indexOf('export function onPermissionResult'));
  // 弹窗阶段（willShowDialog 为真）里必须先 request，且不能直接调用跳转
  assert.ok(/requestNotifyPermission\(\)/.test(fnBody), 'startNotifyFlow 里要先拉系统权限窗口');
  assert.ok(!/jumpToSettings\(\);\s*return 'dialog'/.test(fnBody), '弹窗阶段不允许直接跳');
  assert.match(fnBody, /pendingAfterDialog = after/, '要把"跳转"挂到 pending 上等回调');

  const main = fs.readFileSync('src/main.js', 'utf8');
  // 取回调函数体的前 400 字符即可（用 indexOf 找下一个语句会被同名的 syncNativeAlarms 提前截断）
  const at = main.indexOf('window.__buptNotifyPermissionChanged');
  const hook = main.slice(at, at + 400);
  assert.match(hook, /onPermissionResult\(\)/, '权限回调里要调用 onPermissionResult 才跳转');
});

test('"权限管理→通知"链路：厂商权限页 → 应用通知页 → 应用详情', () => {
  assert.match(src, /public String openNotificationPermissionPage\(\)/, '缺少权限页入口');
  const body = src.slice(src.indexOf('private String openNotificationPermissionChain'));
  const permAt = body.indexOf('PermissionManagerActivity');
  const notifyAt = body.indexOf('Settings.ACTION_APP_NOTIFICATION_SETTINGS');
  const detailAt = body.indexOf('Settings.ACTION_APPLICATION_DETAILS_SETTINGS');
  assert.ok(permAt > 0, '缺厂商权限管理器入口');
  assert.ok(notifyAt > permAt, '应用通知页应排在权限管理器之后（能直达权限页时优先）');
  assert.ok(detailAt > notifyAt, '应用详情必须是最后兜底');
  for (const tag of ['perm', 'notify', 'detail']) {
    assert.ok(body.includes(`return "${tag}"`), `返回值缺少 ${tag}`);
  }
});

test('网页侧跳转必须走新接口（不再跳"通知与控制中心"）', () => {
  const guide = fs.readFileSync('src/ui/notifyGuide.js', 'utf8');
  assert.match(guide, /openNotificationPermissionPage\(\)/, 'notifyGuide 应调用权限页接口');
  assert.match(
    guide,
    /return NATIVE\.openNotificationCenter\(\) \? 'center' : 'none'/,
    '仅在权限页链路全失败时才退回"通知与控制中心"'
  );
});

test('通知体检接口存在，且覆盖可读的三项', () => {
  assert.match(src, /public String notificationAudit\(\)/);
  for (const key of ['granted', 'importance', 'importanceLabel', 'promoted']) {
    assert.ok(src.includes(`o.put("${key}"`), `体检结果缺 ${key}`);
  }
  assert.match(src, /getNotificationChannel/, '必须读渠道 importance（能识别"被静音/关闭"）');
});

test('「后台运行模式」页：先枚举厂商耗电页，应用详情兜底', () => {
  assert.match(src, /public String openBatteryModePage\(\)/);
  const body = src.slice(src.indexOf('private String openBatteryModeChain'));
  const findAt = body.indexOf('findActivityContaining(');
  const detailAt = body.indexOf('ACTION_APPLICATION_DETAILS_SETTINGS');
  assert.ok(findAt > 0, '缺厂商耗电页枚举');
  assert.ok(detailAt > findAt, '应用详情只能兜底');
  assert.ok(body.includes('return "powerPage"') && body.includes('return "appDetail"'));
});

/* ---------------- 1.66.0：体检升级 + 电池链路改厂商优先 ---------------- */

test('通知体检必须覆盖应用级总开关与勿扰（只查运行时权限会误判通过）', () => {
  for (const key of ['appEnabled', 'channelExists', 'bannerLikely', 'dndActive']) {
    assert.ok(src.includes(`o.put("${key}"`), `体检结果缺 ${key}`);
  }
  assert.match(src, /areNotificationsEnabled\(\)/, '必须读应用级总开关');
  assert.match(src, /getCurrentInterruptionFilter\(\)/, '必须读勿扰状态');
});

test('电池链路：运行时枚举厂商耗电页，不靠硬编码类名', () => {
  const body = src.slice(src.indexOf('private String openBatteryModeChain'));
  const findAt = body.indexOf('findActivityContaining(');
  const detailAt = body.indexOf('ACTION_APPLICATION_DETAILS_SETTINGS');
  assert.ok(findAt > 0, '必须先枚举系统包里的耗电页（类名各版本不一致，硬编码会落错页）');
  assert.ok(detailAt > findAt, '应用详情只能作兜底');

  // 枚举实现本身
  assert.match(src, /private String findActivityContaining\(/);
  assert.match(src, /getPackageInfo\(hostPkg, PackageManager\.GET_ACTIVITIES\)/);
  // 非 exported 的 Activity 第三方根本调不动，必须先只挑 exported 的
  assert.match(src, /ai\.exported/, '要判断 android:exported');
  assert.match(src, /exportedOnly/, '要能按 exported 过滤');

  // 类名特征顺序：PowerUsageModel（三个单选项那一页）必须排在 PowerConsumption（统计列表）之前
  const hints = src.slice(src.indexOf('POWER_ACTIVITY_HINTS = {'));
  const modelAt = hints.indexOf('PowerUsageModel');
  const consumptionAt = hints.indexOf('PowerConsumption');
  assert.ok(modelAt > 0 && consumptionAt > modelAt, 'PowerUsageModel 必须优先于 PowerConsumption');
});

test('枚举的包必须在清单 <queries> 里声明（否则 Android 11+ 抛异常）', () => {
  const manifest = fs.readFileSync('android/AndroidManifest.xml', 'utf8');
  assert.match(manifest, /<queries>/, '缺 <queries>，getPackageInfo 会被包可见性拦掉');
  for (const pkg of ['com.oplus.battery', 'com.coloros.oppoguardelf', 'com.oplus.powermanager']) {
    assert.ok(manifest.includes(`<package android:name="${pkg}" />`), `<queries> 缺 ${pkg}`);
  }
  // 只声明必要的包，不申请 QUERY_ALL_PACKAGES
  assert.equal(
    manifest.includes('android.permission.QUERY_ALL_PACKAGES'),
    false,
    '不要为这个功能申请全量包可见'
  );
});

test('打开厂商耗电页要带全 extra 和 data（各家读法不同）', () => {
  const body = src.slice(src.indexOf('private Intent buildPowerIntent'));
  for (const key of ['package_name', 'packageName', 'pkg_name', 'app_package', 'android.provider.extra.APP_PACKAGE']) {
    assert.ok(body.includes(`"${key}"`), `缺 extra ${key}`);
  }
  assert.match(body, /setData\(Uri\.parse\("package:" \+ targetPkg\)\)/, '有些页面读 getData()');
});

test('电池链路必须回报落点，网页才能给准确提示', () => {
  for (const tag of ['powerPage', 'appDetail', 'ignoreList', 'requestIgnore', 'none']) {
    assert.ok(src.includes(`"${tag}"`), `返回值缺少 ${tag}`);
  }
});

test('AOSP 电池优化列表要单独留一个入口（和厂商耗电管理是两件事）', () => {
  assert.match(src, /private String openAospBatteryList\(\)/);
  assert.match(src, /public String openAospBatteryList\(\)/);
  const js = fs.readFileSync('src/native.js', 'utf8');
  assert.match(js, /export function openAospBatteryList\(\)/);
  assert.match(js, /powerPage:/, '落点提示缺 powerPage');
});

test('诊断入口已从正式版移除（只保留排障能力在代码注释里）', () => {
  const js = fs.readFileSync('src/native.js', 'utf8');
  const rv = fs.readFileSync('src/ui/reminderView.js', 'utf8');
  assert.ok(!js.includes('batteryActivities'), 'native.js 不该再暴露诊断接口');
  assert.ok(!rv.includes('battery-diag'), '提醒页不该再有诊断开关');
  assert.ok(!src.includes('public String batteryActivities()'), '原生桥不该再暴露诊断接口');
});

test('「电池优化」类入口必须收敛到修改后台运行模式页', () => {
  const main = fs.readFileSync('src/main.js', 'utf8');
  const body = main.slice(main.indexOf("case 'keepalive-battery'"));
  const nextCase = body.indexOf('case ', 10);
  const branch = body.slice(0, nextCase > 0 ? nextCase : 400);
  assert.match(branch, /#\/reminder\/battery-mode/, 'keepalive-battery 应导航到专用页面');
  assert.equal(/openBatterySettings\(\)/.test(branch), false, '不许再直接甩 AOSP 设置页');

  const rv = fs.readFileSync('src/ui/reminderView.js', 'utf8');
  assert.match(rv, /sub === 'battery-mode'/, '缺 battery-mode 二级路由');
  assert.match(rv, /batteryModeCardHtml/, '页面内容要与引导弹层共用一份');
});

test('引导弹层也走同一条通知跳转链路（全 App 只有一条）', () => {
  const ob = fs.readFileSync('src/ui/onboard.js', 'utf8');
  assert.match(ob, /jumpToNotifyPermissionPage/, '引导弹层必须复用 notifyGuide 的统一跳转');
  assert.equal(
    /openNotificationSettingsEx\(|openNotificationCenter\(/.test(ob),
    false,
    '引导弹层不许再自己写第二条链路（这就是"同一件事跳三个页面"的根源）'
  );
  const guide = fs.readFileSync('src/ui/notifyGuide.js', 'utf8');
  assert.match(guide, /export function jumpToNotifyPermissionPage\(\)/, '要导出给其它入口复用');
});

test('「我已经开好了」不再做检测，就是收起', () => {
  const guide = fs.readFileSync('src/ui/notifyGuide.js', 'utf8');
  const ob = fs.readFileSync('src/ui/onboard.js', 'utf8');
  for (const [name, src] of [['notifyGuide', guide], ['onboard', ob]]) {
    assert.equal(/startCheck\(|runProbe\(|auditVerdict/.test(src), false, `${name} 不应再有检测调用`);
    // 按钮文案里不许再出现"检测"（注释里解释为什么删掉是可以的）
    assert.equal(/>[^<>]*检测[^<>]*</.test(src), false, `${name} 按钮文案里不应再有"检测"`);
  }
  // permissionCheck 模块已删除
  assert.equal(fs.existsSync('src/ui/permissionCheck.js'), false, '检测模块应已删除');
  // 原生探针也一并移除（它会往通知栏发东西）
  assert.equal(/notificationProbe/.test(src), false, '原生探针应已移除');
});

test('通知设置的两个按钮必须走同一个跳转函数，且落到「权限管理 › 通知」', () => {
  const guide = fs.readFileSync('src/ui/notifyGuide.js', 'utf8');
  const fn = guide.slice(guide.indexOf('function jumpToSettings'), guide.indexOf('/**', guide.indexOf('function jumpToSettings')));
  // 用户明确要求的目标页：设置 › 应用 › 北邮课程表 › 权限管理 › 通知
  assert.match(fn, /openNotificationPermissionPage\(\)/, '必须落到权限管理 › 通知这一页');
  assert.equal(
    /openNotificationSettingsEx\(\)/.test(fn),
    false,
    '不许改跳到渠道页（那是再往里一层，不是这个入口要的落点）'
  );
  // 两个按钮都只调用 jumpToSettings()
  const goAt = guide.indexOf("if (act === 'go')");
  const againAt = guide.indexOf("if (act === 'again')");
  assert.ok(goAt > 0 && againAt > goAt);
  const goBlock = guide.slice(goAt, againAt);
  const againBlock = guide.slice(againAt, againAt + 300);
  assert.match(goBlock, /jumpToSettings\(\)/, '「去设置」要走统一跳转');
  assert.match(againBlock, /jumpToSettings\(\)/, '「再打开一次」要走统一跳转');
  // 「再打开一次」也必须走同一个函数，否则两次点击落点会漂移
  assert.match(againBlock, /jumpToSettings\(\)/, '「再打开一次」要走统一跳转');
});

/* ---------------- 1.66.6：课前胶囊（流体云）合并进「通知」 ---------------- */

test('流体云不再单独占一行，两个入口都渲染同一块', () => {
  const perms = fs.readFileSync('src/permissions.js', 'utf8');
  assert.equal(
    /key: 'promoted'/.test(perms),
    false,
    'buildSteps 里不该再有独立的 promoted 项'
  );

  const guide = fs.readFileSync('src/ui/notifyGuide.js', 'utf8');
  const ob = fs.readFileSync('src/ui/onboard.js', 'utf8');
  for (const [name, src] of [['notifyGuide', guide], ['onboard', ob]]) {
    assert.ok(!src.includes('promotedBlockHtml'), `${name} 不该再渲染流体云试发区块`);
    assert.ok(!src.includes('data-pm'), `${name} 不该再有「试一张」按钮`);
  }
  // 试发模块整体下线：正式版不给用户"发一条演示通知"这种入口
  assert.ok(!fs.existsSync('src/ui/promoted.js'), 'promoted.js 应已删除');
});

test('预缓存清单里不能留着已删除的模块（否则离线安装 404）', () => {
  const sw = fs.readFileSync('sw.js', 'utf8');
  assert.ok(!sw.includes("'./src/ui/promoted.js'"), 'promoted.js 已删除，预缓存清单也要删掉这一行');
});

/* ---------------- 1.66.9：从设置返回时按机型复查 ---------------- */

test('从系统设置返回要能按机型复查（只查有 API 的三项）', () => {
  const rc = fs.readFileSync('src/ui/returnCheck.js', 'utf8');
  assert.match(rc, /export function armReturnCheck/, '要能登记"回来后查什么"');
  assert.match(rc, /export async function runReturnCheck/, '要有回到前台的复查入口');
  // 只查系统读得到的三项；厂商自启动读不到，不能判
  assert.match(rc, /notify: '通知权限'/);
  assert.match(rc, /exact: '精确闹钟'/);
  assert.match(rc, /battery: '后台运行'/);
  assert.equal(/autostart/.test(rc), false, '厂商自启动没有查询接口，不许判"没开"');

  // 通知还处于"未询问"时，直接拉系统权限弹窗（真正的自动询问）
  assert.match(rc, /requestNotifyPermission\(\)/);
  assert.match(rc, /snap\.notify === 'default'/);
});

test('各入口跳转前必须登记，回到前台才会复查', () => {
  const main = fs.readFileSync('src/main.js', 'utf8');
  assert.match(main, /import \{ armReturnCheck, runReturnCheck \}/);
  assert.match(main, /runReturnCheck\(\)/, '回到前台要跑复查');
  for (const action of ['keepalive-app-settings', 'battery-open-system', 'battery-open-aosp', 'perm-request']) {
    const at = main.indexOf(`case '${action}'`);
    assert.ok(at > 0, `缺 ${action}`);
    const branch = main.slice(at, at + 260);
    assert.match(branch, /armReturnCheck\(/, `${action} 跳转前没登记复查`);
  }

  const guide = fs.readFileSync('src/ui/notifyGuide.js', 'utf8');
  assert.match(guide, /armReturnCheck\('notify'\)/, '通知跳转要登记复查');

  const ob = fs.readFileSync('src/ui/onboard.js', 'utf8');
  assert.match(ob, /armReturnCheck\('exact'\)/, '精确闹钟跳转要登记');
  assert.match(ob, /armReturnCheck\('battery'\)/, '耗电管理跳转要登记');
});

test('弹层开着时跳过复查（弹层自己会重画）', () => {
  const rc = fs.readFileSync('src/ui/returnCheck.js', 'utf8');
  assert.match(rc, /function modalOpen\(\)/);
  assert.match(rc, /onboard-host/);
  assert.match(rc, /guide-host/);
});

test('回前台的复查不能只靠 visibilitychange（WebView 里不一定派发）', () => {
  // 原生 onResume 必须直接回调网页
  const onResumeAt = src.indexOf('protected void onResume()');
  assert.ok(onResumeAt > 0, '缺 onResume');
  const onResume = src.slice(onResumeAt, onResumeAt + 600);
  assert.match(onResume, /__buptResume/, 'onResume 要回调 window.__buptResume');

  // 网页侧两条路汇到同一个入口
  const main = fs.readFileSync('src/main.js', 'utf8');
  assert.match(main, /window\.__buptResume = \(\) =>/, '要暴露 __buptResume 给原生调用');
  assert.match(main, /if \(document\.hidden\) return;\s*\n\s*window\.__buptResume\(\);/, 'visibilitychange 也要走同一入口');
});

test('三项都开着时也要给反馈（否则用户以为没生效）', () => {
  const rc = fs.readFileSync('src/ui/returnCheck.js', 'utf8');
  assert.match(rc, /已复查/, '全部满足时要提示一句');
});

test('必开项开好后，「后台运行」入口要自动收起', () => {
  const ob = fs.readFileSync('src/ui/onboard.js', 'utf8');
  assert.match(ob, /export function checklistReady\(\)/, '要复用引导那套判定，别在提醒页另写一套');
  assert.match(ob, /requiredPending\(steps\)\.length === 0/);

  const rv = fs.readFileSync('src/ui/reminderView.js', 'utf8');
  assert.match(rv, /checklistReady\(\)/, '提醒页要读这个判定');
  assert.match(rv, /后台运行 · 已就绪/, '就绪时给一个折叠项');
  // 就绪时三条入口仍在，只是收进折叠项（不能直接删掉，用户还要复查）
  assert.match(rv, /backendEntries/, '三条入口要抽成一段可复用的 HTML');
});

test('必开项开好后，「后台运行」入口要自动收起', () => {
  const ob = fs.readFileSync('src/ui/onboard.js', 'utf8');
  assert.match(ob, /export function checklistReady\(\)/, '要复用引导那套判定，别在提醒页另写一套');
  assert.match(ob, /requiredPending\(steps\)\.length === 0/);

  const rv = fs.readFileSync('src/ui/reminderView.js', 'utf8');
  assert.match(rv, /checklistReady\(\)/, '提醒页要读这个判定');
  assert.match(rv, /后台运行 · 已就绪/, '就绪时给一个折叠项');
  // 就绪时三条入口仍在，只是收进折叠项（不能直接删掉，用户还要复查）
  assert.match(rv, /backendEntries/, '三条入口要抽成一段可复用的 HTML');
});

test('通知标题里不许再拼诊断时间（用户会当成上课时间）', () => {
  const rs = fs.readFileSync('android/java/com/bupt/schedule/ReminderScheduler.java', 'utf8');
  assert.equal(
    /indexOf\(" @"\)/.test(rs),
    false,
    '标题里拼 @HH:mm:ss 会让用户以为那是上课时间，看着就是"不准"'
  );
  assert.equal(/SimpleDateFormat/.test(rs), false, '诊断时间已移除，别再引回来');
});

test('胶囊文案是「N分钟后上课」，且向上取整', () => {
  const cc = fs.readFileSync('android/java/com/bupt/schedule/ClassCard.java', 'utf8');
  // 用户明确要求文字版（不是 04:59 那种裸数字）
  assert.match(cc, /CHIP_USE_CHRONOMETER = false/);
  assert.match(cc, /mins \+ "分钟后上课"/, '文案要是「N分钟后上课」');
  assert.equal(/"还有"/.test(cc), false, '前面不要再加「还有」');
  // 向上取整：4:30 → 5，3:59 → 4
  assert.match(cc, /\(ms \+ 59_999L\) \/ 60_000L/, '必须是向上取整');
  assert.match(cc, /return "马上上课"/, '到点了要有兜底文案');
});

test('胶囊换字要对齐整分钟边界，不能靠 15 秒轮询', () => {
  const svc = fs.readFileSync('android/java/com/bupt/schedule/ClassRefreshService.java', 'utf8');
  assert.match(svc, /static long nextBoundaryDelay\(long startEpoch, long now\)/);
  assert.match(svc, /startEpoch - \(mins - 1\) \* 60_000L/, '边界 = startEpoch - (n-1) 分钟');
  assert.equal(/TICK_MS/.test(svc), false, '固定 15 秒轮询已移除');
  // 心跳超时必须大于最长间隔，否则会误判服务已死
  const gap = Number((svc.match(/MAX_GAP_MS = (\d+)/) || [])[1]);
  const hb = Number((svc.match(/HEARTBEAT_TIMEOUT_MS = (\d+)/) || [])[1]);
  assert.ok(gap > 0 && hb > gap, `心跳超时(${hb})必须大于最长间隔(${gap})`);
});

/* ---------------- 1.66.33：后台权限弹窗按品牌给路径 ---------------- */

test('原生「让提醒更准时」弹窗不能写死 ColorOS 的菜单名', () => {
  const java = fs.readFileSync('android/java/com/bupt/schedule/MainActivity.java', 'utf8');
  const at = java.indexOf('private void requestBackgroundPermissionIfNeeded()');
  assert.ok(at > 0, '缺 requestBackgroundPermissionIfNeeded');
  const body = java.slice(at, at + 1400);

  // 正文必须是拼出来的，不能是「点「耗电管理」」这种死字符串
  assert.equal(
    /点「耗电管理」/.test(body),
    false,
    '正文写死 ColorOS 菜单名，小米/华为用户照着找不到'
  );
  assert.match(body, /backgroundPath\(\)\[0\]/, '正文要按机型取页面名');
  assert.match(body, /backgroundPath\(\)\[1\]/, '正文要按机型取选项名');
});

test('backgroundPath 覆盖六个品牌分支 + 兜底', () => {
  const java = fs.readFileSync('android/java/com/bupt/schedule/MainActivity.java', 'utf8');
  const at = java.indexOf('private static String[] backgroundPath()');
  assert.ok(at > 0, '缺 backgroundPath');
  const fn = java.slice(at, at + 1200);
  for (const key of ['xiaomi', 'oppo', 'vivo', 'huawei', 'samsung']) {
    assert.match(fn, new RegExp(`contains\\("${key}"\\)`), `缺 ${key} 分支`);
  }
  // 每个品牌都要给出「页面名 + 选项名」两个词，否则弹窗会拼出空串
  const pairs = fn.match(/return new String\[\] \{"[^"]+", "[^"]+"\}/g) || [];
  assert.ok(pairs.length >= 6, `分支只有 ${pairs.length} 个，应该是 6 个（含兜底）`);
});

/* ---------------- 1.66.34：跨品牌文案与直达 ---------------- */

test('非 ColorOS 的落地文案不许出现「权限管理」「通知与控制中心」', () => {
  const { landingGuideText } = permissionsMod;
  for (const landing of ['perm', 'center', 'detail', 'none']) {
    const text = landingGuideText(landing, 'xiaomi');
    assert.equal(/权限管理|通知与控制中心/.test(text), false, `${landing} 仍带着 ColorOS 菜单名：${text}`);
  }
  // ColorOS 自己保持原来的精确说法
  assert.match(landingGuideText('perm', 'coloros'), /权限管理/);
  assert.match(landingGuideText('detail', 'coloros'), /权限管理 › 通知/);
});

test('六个品牌都要有「后台运行」的本地叫法', () => {
  const { BRANDS, powerTerms } = keepaliveMod;
  assert.equal(BRANDS.length, 6);
  for (const b of BRANDS) {
    assert.ok(b.power && b.power.page && b.power.option, `${b.id} 缺 power 叫法`);
  }
  assert.deepEqual(powerTerms('OPPO'), { page: '耗电管理', option: '允许完全后台行为' });
  assert.deepEqual(powerTerms('Xiaomi'), { page: '省电策略', option: '无限制' });
  assert.deepEqual(powerTerms('HUAWEI'), { page: '应用启动管理', option: '允许后台活动' });
  assert.deepEqual(powerTerms('samsung'), { page: '电池', option: '不受限制' });
});

test('品牌直达：三星用官方 action，小米/华为用枚举到的 ComponentName', () => {
  const java = fs.readFileSync('android/java/com/bupt/schedule/MainActivity.java', 'utf8');
  assert.match(java, /private String openBrandBatteryPage\(\)/, '缺品牌直达');
  // 三星：官方文档给的 action + setPackage + activity_type=2
  assert.match(java, /com\.samsung\.android\.sm\.ACTION_OPEN_CHECKABLE_LISTACTIVITY/);
  assert.match(java, /setPackage\("com\.samsung\.android\.lool"\)/);
  assert.match(java, /putExtra\("activity_type", 2\)/);
  // 小米 / 华为
  assert.match(java, /com\.miui\.powerkeeper/);
  assert.match(java, /StartupNormalAppListActivity/);
  // vivo 没有可靠来源，不许瞎猜
  assert.equal(/com\.vivo\./.test(java), false, 'vivo 没有可靠深链，不要猜');
  // 品牌直达必须排在枚举之前
  const chain = java.indexOf('private String openBatteryModeChain()');
  const call = java.indexOf('openBrandBatteryPage();', chain);
  const loop = java.indexOf('for (int pass = 0; pass < 2; pass += 1)', chain);
  assert.ok(call > 0 && call < loop, '品牌直达要排在运行时枚举之前');
});

test('新增的系统包要进 queries（Android 11+ 包可见性）', () => {
  const xml = fs.readFileSync('android/AndroidManifest.xml', 'utf8');
  for (const pkg of [
    'com.samsung.android.lool',
    'com.miui.powerkeeper',
    'com.huawei.systemmanager',
    'com.hihonor.systemmanager'
  ]) {
    assert.ok(xml.includes(`android:name="${pkg}"`), `${pkg} 没进 queries`);
  }
});

test('小米官方文档 pId=1628：后台限制状态可读，但只当正向证据', () => {
  const java = fs.readFileSync('android/java/com/bupt/schedule/MainActivity.java', 'utf8');
  const at = java.indexOf('public String permissionSnapshot()');
  const body = java.slice(at, at + 1600);
  // API 28+ 才有 isBackgroundRestricted
  assert.match(body, /SDK_INT >= Build\.VERSION_CODES\.P/, '要按 API 28 加门槛');
  assert.match(body, /isBackgroundRestricted\(\)/);
  assert.match(body, /"bgRestricted"/);

  // JS：只判 true，不许拿 false 反推"没被限制"
  const js = fs.readFileSync('src/ui/batteryMode.js', 'utf8');
  assert.match(js, /batteryRestricted\(\) === true/, '只能判 true');
  assert.equal(
    /batteryRestricted\(\) === false/.test(js),
    false,
    '其它 ROM 上 false 不可靠，不能反推'
  );
});

/* ---------------- 返回手势：先关弹层，别退出 ---------------- */

test('返回键要先问网页有没有弹层，再决定后退/退出', () => {
  const java = fs.readFileSync('android/java/com/bupt/schedule/MainActivity.java', 'utf8');
  const at = java.indexOf('public void onBackPressed()');
  assert.ok(at > 0, '缺 onBackPressed');
  // 只取 onBackPressed 本体（切到 fallbackBack 之前），并剥掉注释 ——
  // 注释里会提到 canGoBack()，不剥会误判
  const end = java.indexOf('private void fallbackBack()', at);
  const body = java.slice(at, end > at ? end : at + 1200).replace(/\/\/[^\n]*/g, '');

  // 必须先问网页；老逻辑（canGoBack/双击退出）整体搬进 fallbackBack，不许留在这里
  assert.match(body, /__buptDismissModal/, '要先调网页的 __buptDismissModal');
  assert.equal(
    /canGoBack\(\)/.test(body),
    false,
    'canGoBack 不该还留在 onBackPressed 里（会绕过弹层判断）'
  );

  // 老逻辑单独抽成方法：能后退就后退，否则双击退出
  const fb = java.slice(java.indexOf('private void fallbackBack()'));
  assert.match(fb.slice(0, 400), /canGoBack\(\)/);
  assert.match(fb.slice(0, 600), /再按一次退出/);
});

test('网页侧：__buptDismissModal 要能收掉各层弹层', () => {
  const main = fs.readFileSync('src/main.js', 'utf8');
  assert.match(main, /window\.__buptDismissModal = \(\) => dismissTopModal\(\)/);
  const at = main.indexOf('function dismissTopModal()');
  assert.ok(at > 0, '缺 dismissTopModal');
  const body = main.slice(at, at + 1200);
  for (const host of ['dialog-host', 'sheet-host', 'picker-host', 'guide-host']) {
    assert.ok(body.includes(host), `dismissTopModal 没处理 ${host}`);
  }
  // 隐私弹层和 confirmDialog 共用 dialog-host，要分开处理
  assert.match(body, /data-privacy/);
  assert.match(body, /dismissPrivacyGate\(\)/);
  assert.match(body, /resolveDialog\(false\)/);
});

test('隐私弹层被返回手势收掉时，不能当成"同意"', () => {
  const p = fs.readFileSync('src/ui/privacy.js', 'utf8');
  const at = p.indexOf('export function dismissPrivacyGate()');
  assert.ok(at > 0, '缺 dismissPrivacyGate');
  const body = p.slice(at, at + 300);
  assert.match(body, /snoozePrivacy\(\)/, '要按"暂不"处理（记 7 天暂缓）');
  assert.equal(/acceptPrivacy\(/.test(body), false, '返回手势不许当成同意');
  assert.equal(/onAcceptCallback\(\)/.test(body), false, '也不该触发后续引导');
});

/* ---------------- 发版前的清单卫生 ---------------- */

test('清单不许留 usesCleartextTraffic（会和 networkSecurityConfig 打架）', () => {
  const xml = fs.readFileSync('android/AndroidManifest.xml', 'utf8');
  assert.equal(
    /android:usesCleartextTraffic/.test(xml),
    false,
    'network_security_config 已经接管明文策略，再留这个开关会被安全扫描/审核挑刺'
  );
  // 但 config 本身必须在，且确实放行了教务域名
  assert.match(xml, /android:networkSecurityConfig="@xml\/network_security_config"/);
  const cfg = fs.readFileSync('android/res/xml/network_security_config.xml', 'utf8');
  assert.match(cfg, /cleartextTrafficPermitted="false"/, '默认必须禁止明文');
  assert.match(cfg, /bupt\.edu\.cn/, '教务系统要放行');
});

test('清单源文件里的版本号要和构建脚本一致（别让人看错）', () => {
  const xml = fs.readFileSync('android/AndroidManifest.xml', 'utf8');
  const build = fs.readFileSync('scripts/build-android.mjs', 'utf8');
  const vName = (build.match(/VERSION_NAME = '([^']+)'/) || [])[1];
  const vCode = (build.match(/VERSION_CODE = '([^']+)'/) || [])[1];
  assert.ok(vName && vCode, '构建脚本里没读到版本号');
  assert.ok(xml.includes(`android:versionName="${vName}"`), `清单 versionName 不是 ${vName}`);
  assert.ok(xml.includes(`android:versionCode="${vCode}"`), `清单 versionCode 不是 ${vCode}`);
});

test('不许把含凭证的数据交给系统备份', () => {
  const xml = fs.readFileSync('android/AndroidManifest.xml', 'utf8');
  assert.match(
    xml,
    /android:allowBackup="false"/,
    '备份里有学号和 Keystore 加密的口令；换机恢复时密钥不跟着走，解密必然失败'
  );
});
