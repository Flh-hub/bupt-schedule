package com.bupt.schedule;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.ActivityManager;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.provider.Settings;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 应用主界面：一个 WebView 承载打包进 APK 的整个 PWA。
 *
 * 【为什么用虚拟 https 源而不是 file://】
 * file:// 下 localStorage 是"不透明源"、ES Module 与 Service Worker 都被拦，
 * 课表存不住。这里用 shouldInterceptRequest 把 https://appassets.androidplatform.net/
 * 全部映射到 APK 的 assets/www/：网页拿到的仍是一个正常的 https 源，
 * 存储、模块、fetch 全部照常工作，而且**一个网络请求都不发**（完全离线）。
 *
 * 【为什么不收账号密码】
 * 登录交给 {@link JwglActivity} 里的学校页面，密码只进那个表单；
 * 本类只接收它抓回来的课表页 HTML。
 */
public class MainActivity extends Activity {

    /** 虚拟源：所有 APK 内资源都挂在这个域名下。 */
    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final String VERSION = "1.12.7";

    private static final int REQ_FILE = 1001;
    private static final int REQ_JWGL = 1002;
    private static final int REQ_NOTIFY = 1003;
    private static final int REQ_AUTO = 1004;

    /**
     * 可能承载「耗电行为控制」那一页的系统包（ColorOS 各版本不一样）。
     *
     * ★ 必须同时在 AndroidManifest 的 `<queries>` 里声明，
     *   否则 Android 11+ 的包可见性会让 `getPackageInfo` 直接抛异常。
     *
     * `com.oplus.appdetail` 是「应用详情」这一页的宿主 —— 1.66.2 真机上
     * 电池包里的类名一个都没命中，而「耗电管理」是从应用详情点进去的，
     * 所以那一页很可能也挂在这个包里。
     */
    private static final String[] POWER_PKGS = {
        "com.oplus.battery",
        "com.coloros.oppoguardelf",
        "com.oplus.powermanager",
        "com.oplus.appdetail"
    };

    /**
     * 按"最像目标页 → 最不像"排序的类名特征。
     *
     * `PowerUsageModel` 的 model 就是"完全允许 / 智能优化 / 限制"这三种模式，
     * 命中它基本就是那一页；`PowerConsumption` 更像耗电统计列表，排最后。
     * 后面几条是"类名没猜中时的近亲"，宁可多试几个，也不要直接掉回应用详情。
     */
    private static final String[] POWER_ACTIVITY_HINTS = {
        "PowerUsageModel",
        "PowerUsageDetail",
        "AppPowerUsage",
        "PowerUsage",
        "PowerConsumption",
        "PowerConsume",
        "BatteryUsage",
        "BatteryDetail"
    };

    /**
     * 诊断时用的宽松匹配：只要类名沾上这些词就报出来。
     * 目的不是打开它，而是让用户截个图，我们就能知道这台机器上真实类名是什么。
     */
    private static final String[] POWER_DIAG_WORDS = {"Power", "Battery", "Consum"};

    private WebView web;
    /** 后台抓取用的 1×1 容器：AutoGrabber 把隐藏 WebView 塞进来跑学校页面。 */
    private FrameLayout grabHost;
    /** 「一键获取作业」的后台引擎（与课表抓取共用那个 1×1 容器，同时只跑一个）。 */
    private HomeworkGrabber homeworkGrabber;
    private AutoGrabber grabber;
    private GrabListener grabListener;
    private ValueCallback<Uri[]> fileCallback;
    private long lastBackPressedAt = 0L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // ★ 装完新包第一次启动时，把桌面小组件立刻重画一遍。
        //   为什么必须在 onCreate 里做：sideload 安装后应用处于 **stopped 状态**，
        //   连 MY_PACKAGE_REPLACED 都收不到 —— 桌面拿不到任何 RemoteViews，
        //   「添加小组件」界面就会显示「载入窗口小部件时出现问题」。
        //   用户打开一次 App 之后 stopped 状态解除，这里顺手把小组件补上。
        try {
            CourseWidget.refreshAll(this);
        } catch (Throwable ignored) {
            // 小组件出问题不该影响应用启动
        }

        final boolean night = isNight();
        lastNight = night;
        final int rootColor = Color.parseColor(night ? "#14171C" : "#FFFFFF");

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(rootColor);
        applySystemBars();
        // 先加 1×1 的抓取容器、再加全屏 web：后者盖在上面，管道既在窗口里又不挡任何点击
        grabHost = new FrameLayout(this);
        root.addView(grabHost, new FrameLayout.LayoutParams(1, 1));
        web = new WebView(this);
        root.addView(
                web,
                new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        configureWebView();
        // 首屏加载瞬间 WebView 会先用自身底色刷一遍，不设就会闪一下白
        web.setBackgroundColor(rootColor);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.addJavascriptInterface(new Bridge(), "BuptNative");

        grabber = new AutoGrabber(this, grabHost, grabListener = new GrabListener());
        homeworkGrabber = new HomeworkGrabber(this, grabHost, new HomeworkListener());

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(ORIGIN + "/index.html");
        }

        // 后台权限询问的时机交给页面决定（见 Bridge.askBackground）：
        // 这里以前是 postDelayed 1.2 秒自己弹，加了隐私说明之后那个原生框会正好
        // 压在第一屏的隐私弹层上，真机上就是两层对话框叠着，点哪个都不对。
        // ★ 只能是"首次启动"而不是"安装时"：安装由系统进程完成，应用代码还没被执行。
    }

    /** 上一次看到的深浅色状态，用于判断是否真的切换了（见 onConfigurationChanged）。 */
    private boolean lastNight;

    /** 当前是否深色模式。 */
    private boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    /**
     * 状态栏 / 导航栏配色跟随深浅色。
     *
     * ★ 网页侧的调色板在 `assets/css/app.css` 的 `@media (prefers-color-scheme: dark)` 里；
     *   这里只管 WebView 之外的那几块。两边底色必须一致，否则页面切深色后
     *   状态栏/导航栏还是亮的，屏幕边上会露出一条白边。
     * ★ manifest 里 `configChanges` 带了 `uiMode`，切深浅色时 Activity **不会重建**
     *   （否则 WebView 会重新加载、丢状态），所以必须自己监听配置变化重刷一遍。
     */
    private void applySystemBars() {
        boolean night = isNight();
        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor(night ? "#0B0D10" : "#013A89"));
        window.setNavigationBarColor(Color.parseColor(night ? "#0B0D10" : "#FFFFFF"));

        // 导航栏图标：浅底用深色图标，深底用浅色图标，否则暗色下图标会「消失」
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            View decor = window.getDecorView();
            int flags = decor.getSystemUiVisibility();
            if (night) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility(flags);
        }
        if (web != null) web.setBackgroundColor(Color.parseColor(night ? "#14171C" : "#FFFFFF"));
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);

        // ★ 深浅色切换必须**重建 Activity**，不能只改系统栏。
        //   WebView 的 `prefers-color-scheme` 读的是**宿主应用的主题**（见 res/values-night/styles.xml），
        //   而 manifest 里 configChanges 带了 uiMode，系统不会自动重建 ——
        //   结果就是"系统切了深色、状态栏变黑了，页面还是白的"（2026-10-27 真机踩到）。
        //   recreate() 之后会按新的资源限定符取到 values-night 的 AppTheme，WebView 才会上报 dark。
        //   WebView 状态由 onSaveInstanceState/restoreState 保住，不会跳回首页。
        if (isNight() != lastNight) {
            lastNight = isNight();
            recreate();
            return;
        }

        try {
            applySystemBars();
        } catch (Throwable ignored) {
            // 刷不到就算了，不影响功能
        }
    }

    /** 作业抓取的三个回调 → 统一转成 `__buptHomeworkEvent`。 */
    private class HomeworkListener implements HomeworkGrabber.Listener {
        @Override
        public void onProgress(String text) {
            emitHomework("progress", text, null, null);
        }

        @Override
        public void onResult(String json) {
            emitHomework("result", null, json, null);
        }

        @Override
        public void onError(String code, String detail) {
            emitHomework("error", null, null, code);
        }
    }

    /** 推一条作业事件给网页。字段用 JSON 拼，别手写字符串（转义会出错）。 */
    private void emitHomework(String type, String text, String json, String code) {
        if (web == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("type", type);
            if (text != null) o.put("text", text);
            if (json != null) o.put("json", json);
            if (code != null) o.put("code", code);
            web.evaluateJavascript(
                    "window.__buptHomeworkEvent&&window.__buptHomeworkEvent(" + o.toString() + ")",
                    null);
        } catch (Exception ignored) {
            // 推不出去就算了，网页侧有超时兜底
        }
    }

    /** 本轮是否已经弹过「后台运行」对话框（防止重复显示叠成两层）。 */
    private boolean bgAskShown = false;

    /**
     * 由页面调用：**隐私说明处理完之后**再问后台运行，保证同一屏只有一个对话框。
     *
     * 页面在隐私弹层的三个出口（同意 / 暂不 / 查看全文）都会调一次，
     * 已经同意过隐私的用户则在启动后直接调。原生侧 `askedBefore()` 仍然生效，
     * 用户点过「去开启」或「暂不」之后就永不再问。
     */
    private void askBackgroundOnce() {
        if (bgAskShown) return;
        bgAskShown = true;
        requestBackgroundPermissionIfNeeded();
    }

    private boolean ignoringBattery() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
        } catch (Throwable t) {
            return true;
        }
    }

    private static final String PREFS_BG = "class_refresh_state";
    private static final String K_ASKED_BG = "asked_battery_v2";

    private boolean askedBefore() {
        return getSharedPreferences(PREFS_BG, MODE_PRIVATE).getBoolean(K_ASKED_BG, false);
    }

    private void markAsked() {
        getSharedPreferences(PREFS_BG, MODE_PRIVATE)
                .edit()
                .putBoolean(K_ASKED_BG, true)
                .apply();
    }

    /**
     * 后台运行申请：**先在我们自己的对话框里说明原因，用户点「去开启」才跳系统页**。
     *
     * 【为什么必须这样，而不能"安装时自动切换"】
     * Android 不允许任何应用给自己提权：是否把本应用放进「忽略电池优化 / 允许后台运行」
     * 白名单，只能由用户在系统界面里点确认。而且**安装过程不执行应用代码**
     * （代码要等首次启动才跑），所以最早的时机是首屏加载完成后。
     *
     * 【两条路径的表现】
     *  · 用户点「去开启」→ 跳系统对话框 → 同意后本应用进入白名单，服务不再被清，
     *    胶囊倒计时全程连续跳动；
     *  · 用户点「暂不」/ 直接返回 → **不影响任何功能**，App 照常用、提醒照常响，
     *    只是胶囊文字可能在中途停住（回到前台会自动补上）。
     *
     * 只问一次（`asked_battery_v2` 标记），之后不再打扰。
     */
    /**
     * 当前机型的「后台运行」设置路径：{页面名, 该选的选项名}。
     *
     * ★ 这段文案以前写死 ColorOS 的「耗电管理 / 允许完全后台行为」，
     *   而 askBackgroundOnce() 没有品牌门槛 —— 所有机型都会弹，
     *   小米/华为用户照着找，设置里根本没有这一项。
     *   各家的叫法：
     *     小米 → 省电策略 / 无限制
     *     OPPO 系 → 耗电管理 / 允许完全后台行为
     *     vivo 系 → 后台耗电管理 / 允许后台高耗电
     *     华为荣耀 → 应用启动管理 / 允许后台活动
     *     三星 → 电池 / 不受限制
     *     其它 → 电池优化 / 不优化
     */
    private static String[] backgroundPath() {
        String m = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
        if (m.contains("xiaomi") || m.contains("redmi") || m.contains("poco")) {
            return new String[] {"省电策略", "无限制"};
        }
        if (m.contains("oppo") || m.contains("oneplus") || m.contains("realme")) {
            return new String[] {"耗电管理", "允许完全后台行为"};
        }
        if (m.contains("vivo") || m.contains("iqoo")) {
            return new String[] {"后台耗电管理", "允许后台高耗电"};
        }
        if (m.contains("huawei") || m.contains("honor")) {
            return new String[] {"应用启动管理", "允许后台活动"};
        }
        if (m.contains("samsung")) {
            return new String[] {"电池", "不受限制"};
        }
        return new String[] {"电池优化", "不优化"};
    }

    private void requestBackgroundPermissionIfNeeded() {
        if (ignoringBattery() || askedBefore() || isFinishing()) return;
        try {
            // 对话框单独选主题：Activity 的主题是固定的浅色（页面自己管配色），
            // 但原生框不会跟着 WebView 走，所以这里按当前深浅色挑一个。
            new AlertDialog.Builder(
                            this,
                            isNight()
                                    ? android.R.style.Theme_Material_Dialog_Alert
                                    : android.R.style.Theme_Material_Light_Dialog_Alert)
                    .setTitle("让提醒更准时")
                    .setMessage(
                            "下一步打开「设置 › 应用 › 北邮课程表」，点「"
                                    + backgroundPath()[0]
                                    + "」，选「"
                                    + backgroundPath()[1]
                                    + "」。\n\n"
                                    + "别选更省电的那一档 —— 省电时会把已排的闹钟清掉。\n\n"
                                    + "选「暂不」也能用，只是倒计时可能中途停住。")
                    .setPositiveButton(
                            "去开启",
                            new DialogInterface.OnClickListener() {
                                @Override
                                public void onClick(DialogInterface d, int w) {
                                    markAsked();
                                    openBatteryModeChain();
                                }
                            })
                    .setNegativeButton(
                            "暂不",
                            new DialogInterface.OnClickListener() {
                                @Override
                                public void onClick(DialogInterface d, int w) {
                                    markAsked();
                                    Toast.makeText(
                                                    MainActivity.this,
                                                    "已跳过。倒计时若中途停下，回到本应用即可自动恢复",
                                                    Toast.LENGTH_LONG)
                                            .show();
                                }
                            })
                    .setCancelable(false)
                    .show();
        } catch (Throwable ignored) {
            // 弹不出来就算了，功能不受影响
        }
    }

    /**
     * 跳系统「修改后台运行模式」页（见 {@link #openBatteryModeChain()}）。
     *
     * ★ 保留这个名字是为了兼容网页侧已有的 `BuptNative.openBatterySettings()`，
     *   但**行为已经改成厂商优先**：以前这里直接甩 AOSP 的"忽略电池优化"确认框，
     *   在 ColorOS 上跟后台被杀毫无关系（见方法体注释）。
     */
    private void openBatterySettings() {
        String landing = openBatteryModeChain();
        if ("none".equals(landing)) {
            Toast.makeText(
                            this,
                            "请到 设置 › 应用 › 北邮课程表 › "
                                    + backgroundPath()[0]
                                    + " 里选「"
                                    + backgroundPath()[1]
                                    + "」",
                            Toast.LENGTH_LONG)
                    .show();
        }
    }


    /**
     * 打开「通知设置」，按"最可能直达 → 最宽泛"依次尝试。
     *
     * 【为什么之前停在应用详情】ColorOS 对标准的 `ACTION_APP_NOTIFICATION_SETTINGS`
     * 会 **fallback 到应用详情页**（不是通知页），`ACTION_CHANNEL_NOTIFICATION_SETTINGS`
     * 在部分版本上也被吞掉；两条都"启动成功但落错页"，所以代码看着没问题、用户却要多点两层。
     *
     * 【现在的顺序】
     *   ① ColorOS 新版通知管理器的应用通知页（ComponentName 直指，最准）
     *   ② ColorOS 旧版（com.coloros.notificationmanager）
     *   ③ 标准渠道页 ACTION_CHANNEL_NOTIFICATION_SETTINGS（AOSP/多数 ROM 直达）
     *   ④ 通用通知设置页 android.settings.NOTIFICATION_SETTINGS（落在"通知与状态栏→应用通知设置"列表）
     *   ⑤ 标准应用通知页 ACTION_APP_NOTIFICATION_SETTINGS（+ 新老 extra）
     *   ⑥ 应用详情（最后兜底）
     *
     * @return 实际命中的是哪一级（给网页提示用）：vendor_new / vendor_old / channel / list / app / detail / none
     */
    private String openNotificationSettingsChain() {
        final String pkg = getPackageName();
        try {
            ReminderScheduler.ensureChannel(this); // 渠道不存在时渠道页是空的
        } catch (Throwable ignored) {
            // 忽略
        }

        // ① / ② 厂商直达：ColorOS 的通知管理器直接接收包名
        final String[][] vendors = {
            {"com.oplus.notificationmanager", "com.oplus.notificationmanager.NotificationSettingsActivity"},
            {"com.oplus.notificationmanager", "com.oplus.notificationmanager.AppNotificationSettingsActivity"},
            {"com.coloros.notificationmanager", "com.coloros.notificationmanager.NotificationSettingsActivity"}
        };
        for (int i = 0; i < vendors.length; i += 1) {
            Intent v = new Intent();
            v.setComponent(new ComponentName(vendors[i][0], vendors[i][1]));
            v.putExtra("app_package", pkg);
            v.putExtra("app_uid", getApplicationInfo().uid);
            v.putExtra("android.provider.extra.APP_PACKAGE", pkg);
            v.putExtra("pkg_name", pkg);
            v.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (tryStartActivity(v)) return i == 2 ? "vendor_old" : "vendor_new";
        }

        // ★ 应用级通知还没授时，渠道页上的「允许通知」是**灰的、点不动**（子开关被父开关锁住）。
        //   这种时候必须先去应用级/列表页把总开关打开，再回来调横幅/锁屏。
        final boolean granted = ReminderScheduler.canNotify(this);

        // ③ 标准渠道页（仅在已授权时可跳；否则会落到"灰色死路"）
        if (granted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent ch = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS);
            ch.putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
            ch.putExtra(Settings.EXTRA_CHANNEL_ID, ReminderScheduler.CHANNEL_ID);
            ch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (tryStartActivity(ch)) return "channel";
        }

        // ④ 通用通知设置列表页（ColorOS：通知与状态栏 → 应用通知设置）
        Intent list = new Intent("android.settings.NOTIFICATION_SETTINGS");
        list.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (tryStartActivity(list)) return "list";

        // ⑤ 标准应用通知页
        Intent app = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        app.putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
        app.putExtra("android.provider.extra.APP_PACKAGE", pkg);
        app.putExtra("app_package", pkg);
        app.putExtra("app_uid", getApplicationInfo().uid);
        app.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (tryStartActivity(app)) return "app";

        // ⑥ 兜底：应用详情
        openAppDetail();
        return "detail";
    }

    /**
     * 「权限管理 → 通知」的最佳努力链路。见 Bridge#openNotificationPermissionPage 的说明。
     * @return perm / notify / detail / none
     */
    private String openNotificationPermissionChain() {
        final String pkg = getPackageName();
        try {
            ReminderScheduler.ensureChannel(this);
        } catch (Throwable ignored) {
            // 忽略
        }

        // ① / ② 厂商权限管理器（能直达"权限列表"，通知就在里面）
        final String[][] permHosts = {
            {"com.color.safecenter", "com.color.safecenter.permission.PermissionManagerActivity"},
            {"com.oplus.securitypermission", "com.oplus.securitypermission.ui.PermissionManagerActivity"},
            {"com.oplus.securitypermission", "com.oplus.securitypermission.PermissionManagerActivity"}
        };
        for (String[] host : permHosts) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(host[0], host[1]));
            i.putExtra("packageName", pkg);
            i.putExtra("pkg_name", pkg);
            i.putExtra("app_package", pkg);
            i.putExtra("android.provider.extra.APP_PACKAGE", pkg);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (tryStartActivity(i)) return "perm";
        }

        // ③ 标准的"应用通知设置"——就是"通知"权限页
        Intent notify = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        notify.putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
        notify.putExtra("app_package", pkg);
        notify.putExtra("app_uid", getApplicationInfo().uid);
        notify.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (tryStartActivity(notify)) return "notify";

        // ④ 应用详情（ColorOS 在这里放「权限管理」入口）
        if (tryStartActivity(new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg)))) {
            return "detail";
        }
        return "none";
    }

    /**
     * 按品牌直达「后台运行」那一页。返回落点，没命中返回 null。
     *
     * 证据等级（很重要，别后人凭印象往里加）：
     *  · 三星：**官方 API**，`activity_type=2` 就是「永不休眠的应用」。
     *  · 小米：`com.miui.powerkeeper/ui.HiddenAppsConfigActivity`（社区实践，2019 起多篇引用）。
     *  · 华为 / 荣耀：`startupmgr.ui.StartupNormalAppListActivity`（社区实践，多篇引用）。
     *  · vivo / 其它：没有可靠来源，**不写**。宁可让用户照手动路径点，也不要跳错页。
     */
    private String openBrandBatteryPage() {
        String m = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();

        if (m.contains("samsung")) {
            Intent i = new Intent("com.samsung.android.sm.ACTION_OPEN_CHECKABLE_LISTACTIVITY");
            i.setPackage("com.samsung.android.lool");
            i.putExtra("activity_type", 2);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (tryStartActivity(i)) return "powerPage";
        }

        if (m.contains("xiaomi") || m.contains("redmi") || m.contains("poco")) {
            Intent i = new Intent();
            i.setComponent(
                    new ComponentName(
                            "com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"));
            i.putExtra("package_name", getPackageName());
            i.putExtra("package_label", getString(R.string.app_name));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (tryStartActivity(i)) return "powerPage";
        }

        if (m.contains("huawei") || m.contains("honor")) {
            String[] hosts = {"com.huawei.systemmanager", "com.hihonor.systemmanager"};
            for (String host : hosts) {
                Intent i = new Intent();
                i.setComponent(
                        new ComponentName(host, host + ".startupmgr.ui.StartupNormalAppListActivity"));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (tryStartActivity(i)) return "powerPage";
            }
        }

        return null;
    }

    /** startActivity 不抛异常才算真的打开了。 */
    private boolean tryStartActivity(Intent intent) {
        try {
            startActivity(intent);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 「修改后台运行模式」页链路 —— 目标是 **「耗电行为控制」那三个单选项**。
     *
     * 【为什么不再硬编码厂商类名（1.66.0 / 1.66.1 两次真机反馈）】
     * ColorOS 没有公开这一页的深链文档，网上流传的
     * `com.oplus.battery/...PowerUsageModelActivity` 之类类名各版本不一致：
     * 1.66.0 试了三个候选，最后落到了「应用的电池使用情况」——所有应用的列表页；
     * 1.66.1 退回应用详情，还要用户自己点一下「耗电管理」。
     *
     * 【现在的做法：运行时枚举，不猜】
     * 用 PackageManager 把几个可能承载这一页的系统包里的 Activity 列出来，
     * 按名字特征找"最像耗电行为控制"的那个。类名换版本、换包名都能自适应，
     * 找不到才退回应用详情 —— 绝不因为猜错把用户丢到别的页面。
     *
     * 【为什么按 hints 顺序而不是包顺序】
     * `PowerUsageModel` 里的 model 就是"完全允许 / 智能优化 / 限制"这三种模式，
     * 命中它基本就是目标页；`PowerConsumption` 更像"耗电统计/列表"，
     * 排在最后 —— 万一只能命中它，也比什么都不做强。
     *
     * @return powerPage / appDetail / ignoreList / requestIgnore / none
     */
    private String openBatteryModeChain() {
        final String pkg = getPackageName();

        // ⓪ 品牌直达：**只写有据可查的**。
        //    ★ 三星有官方文档（developer.samsung.com/mobile/app-management.html）：
        //      action + setPackage + activity_type=2 = 「永不休眠的应用」。
        //    ★ 小米 / 华为只有社区实践（多篇互相印证，但无官方文档背书），
        //      所以放在枚举之前、用 tryStartActivity 兜住，打不开就继续往下走。
        //    ★ vivo 找不到任何可靠来源 → 不猜，走手动路径（网页侧已按品牌给文案）。
        String brand = openBrandBatteryPage();
        if (brand != null) return brand;

        // ① 枚举各系统包，按"最像目标页"的顺序尝试。
        //    先只挑 exported 的：非 exported 的 Activity 第三方应用**根本调不动**
        //    （startActivity 直接抛 SecurityException），1.66.2 很可能就栽在这里 ——
        //    枚举看起来命中了，实际一个都打不开，于是静默掉回应用详情。
        for (int pass = 0; pass < 2; pass += 1) {
            final boolean exportedOnly = pass == 0;
            for (String hint : POWER_ACTIVITY_HINTS) {
                for (String host : POWER_PKGS) {
                    String cls = findActivityContaining(host, hint, exportedOnly);
                    if (cls == null) continue;
                    if (tryStartActivity(buildPowerIntent(host, cls, pkg))) return "powerPage";
                }
            }
        }

        // ② 应用详情页（设置 › 应用 › 北邮课程表）—— 「耗电管理」就在这一页里
        try {
            Intent detail = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            detail.setData(Uri.parse("package:" + pkg));
            detail.putExtra(":settings:fragment_args_key", "battery");
            detail.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (tryStartActivity(detail)) return "appDetail";
        } catch (Throwable ignored) {
            // 继续往下试
        }

        // ③ AOSP 电池优化列表（厂商那层管不到 Doze，这层仍要单独开）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Intent list = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            list.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (tryStartActivity(list)) return "ignoreList";
        }

        // ④ AOSP 忽略电池优化确认框
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                Intent req = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                req.setData(Uri.parse("package:" + pkg));
                req.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (tryStartActivity(req)) return "requestIgnore";
            } catch (Throwable ignored) {
                // 部分 ROM 没有这个入口
            }
        }

        return "none";
    }

    /**
     * 在指定包里找一个类名包含 hint 的 Activity。
     *
     * ★ Android 11+ 的包可见性：没在清单 `<queries>` 里声明过的包，
     *   `getPackageInfo` 会直接抛 NameNotFoundException。所以清单里声明了
     *   com.oplus.battery / com.coloros.oppoguardelf / com.oplus.powermanager / com.oplus.appdetail。
     *
     * @param exportedOnly true 时只返回 `android:exported="true"` 的 —— 只有这种第三方才调得动
     * @return 完整类名；找不到返回 null
     */
    private String findActivityContaining(String hostPkg, String hint, boolean exportedOnly) {
        try {
            PackageInfo pi =
                    getPackageManager()
                            .getPackageInfo(hostPkg, PackageManager.GET_ACTIVITIES);
            if (pi.activities == null) return null;
            for (ActivityInfo ai : pi.activities) {
                if (ai.name == null || !ai.name.contains(hint)) continue;
                if (exportedOnly && !ai.exported) continue;
                return ai.name;
            }
        } catch (Throwable ignored) {
            // 包不存在 / 不可见 / 系统限制，都当"没有"
        }
        return null;
    }

    /**
     * 组装"打开某个应用耗电页"的 Intent。
     *
     * 厂商页认的 extra 名字各家不同，这里把已知的写法全塞一遍（多给的会被忽略）；
     * 同时带上 `package:` 形式的 data —— 有些 OPPO 页面读的是 getData() 而不是 extra。
     */
    private Intent buildPowerIntent(String hostPkg, String cls, String targetPkg) {
        Intent i = new Intent();
        i.setComponent(new ComponentName(hostPkg, cls));
        i.setData(Uri.parse("package:" + targetPkg));
        i.putExtra("package_name", targetPkg);
        i.putExtra("packageName", targetPkg);
        i.putExtra("pkg_name", targetPkg);
        i.putExtra("package", targetPkg);
        i.putExtra("app_package", targetPkg);
        i.putExtra("android.provider.extra.APP_PACKAGE", targetPkg);
        try {
            i.putExtra("app_uid", getApplicationInfo().uid);
        } catch (Throwable ignored) {
            // 拿不到 uid 也不影响打开页面
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return i;
    }

    /**
     * 只打开 AOSP 那层「电池优化」列表。
     *
     * 单独留一个入口，是因为它和厂商的「耗电管理」是**两件事**：
     * 应用信息页里的「耗电管理」管厂商的省电策略，Doze 白名单还得在电池优化列表里加。
     * 用户把两层都开了才算齐。
     *
     * @return ignoreList / requestIgnore / none
     */
    private String openAospBatteryList() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Intent list = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            list.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (tryStartActivity(list)) return "ignoreList";

            try {
                Intent req = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                req.setData(Uri.parse("package:" + getPackageName()));
                req.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (tryStartActivity(req)) return "requestIgnore";
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        return "none";
    }

    /** 渠道 importance → 人话（体检结果里给用户看）。 */
    private static String importanceLabelOf(int importance) {
        if (importance < 0) return "未知（渠道还没创建）";
        if (importance == NotificationManager.IMPORTANCE_NONE) return "已关闭（通知不会出现）";
        if (importance <= NotificationManager.IMPORTANCE_MIN) return "最低（不响不亮、不提示）";
        if (importance <= NotificationManager.IMPORTANCE_LOW) return "较低（没有声音，可能没有横幅）";
        if (importance <= NotificationManager.IMPORTANCE_DEFAULT) return "默认（有声音，不一定有横幅）";
        return "高（有声音、横幅）";
    }

    /** 应用详情页（多个入口的兜底）。 */
    private void openAppDetail() {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Throwable t) {
            Toast.makeText(this, "请手动进入 设置 › 应用 里找到本应用", Toast.LENGTH_LONG).show();
        }
    }

    /* ------------------------------------------------------------ 抓取进度回灌 */

    /**
     * 把后台抓取的状态推给网页层（用户看到的就是自己课表界面上的进度条）。
     *
     * 两类通道分开：
     *  - 进度 / 失败是小 JSON，直接拼进 JS 调用（JSONObject 会正确转义）；
     *  - 结果是几 MB 的 HTML，必须走 base64，否则引号换行一定把字符串打断。
     *
     * id 由**网页**生成并传下来：网页立刻就能建好状态，不用等原生返回什么，
     * 而且上一次抓取迟到的结果因为 id 对不上会被自动丢掉。
     */
    private class GrabListener implements AutoGrabber.Listener {
        @Override
        public void onProgress(String id, String step, int percent, String text) {
            if (web == null) return;
            JSONObject o = new JSONObject();
            try {
                o.put("type", "progress");
                o.put("id", id);
                o.put("step", step);
                o.put("percent", percent);
                o.put("text", text);
            } catch (Exception e) {
                return;
            }
            web.evaluateJavascript("window.__buptGrabEvent&&window.__buptGrabEvent(" + o.toString() + ")", null);
        }

        @Override
        public void onError(String id, String code, String detail) {
            if (web == null) return;
            JSONObject o = new JSONObject();
            try {
                o.put("type", "error");
                o.put("id", id);
                o.put("code", code);
                o.put("detail", detail == null ? "" : detail);
            } catch (Exception e) {
                return;
            }
            web.evaluateJavascript("window.__buptGrabEvent&&window.__buptGrabEvent(" + o.toString() + ")", null);
        }

        @Override
        public void onResult(String id, String json) {
            if (web == null) return;
            String b64 = Base64.encodeToString(
                    json.getBytes(java.nio.charset.Charset.forName("UTF-8")), Base64.NO_WRAP);
            web.evaluateJavascript(
                    "window.__buptGrabResult&&window.__buptGrabResult("
                            + JSONObject.quote(id) + ",'" + b64 + "')",
                    null);
        }
    }

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        // 本地资源不出网；云端 SDK 走 https，不需要混合内容
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 允许 chrome://inspect 调试，出问题时用户能自己看到控制台
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    /* ------------------------------------------------------------ WebView 客户端 */

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!ORIGIN.equals(url.getScheme() + "://" + url.getHost())) return null;

            String path = url.getPath();
            if (path == null || path.length() == 0 || "/".equals(path)) path = "/index.html";
            if (path.endsWith("/")) path = path + "index.html";

            String assetPath = "www" + path;
            try {
                InputStream in = getAssets().open(assetPath);
                return new WebResourceResponse(mimeOf(assetPath), charsetOf(assetPath), 200, "OK", headers(), in);
            } catch (IOException e) {
                return new WebResourceResponse(
                        "text/plain",
                        "utf-8",
                        404,
                        "Not Found",
                        headers(),
                        new ByteArrayInputStream(("missing asset: " + assetPath).getBytes()));
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String scheme = url.getScheme() == null ? "" : url.getScheme();
            if ("http".equals(scheme) || "https".equals(scheme)) {
                if (ORIGIN.equals(scheme + "://" + url.getHost())) return false;
                // 外部链接（公众号授权、云服务说明页…）交给系统浏览器，避免污染应用内页面
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                    // 没有可用浏览器时留在原地即可
                }
                return true;
            }
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(
                WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
            }
            fileCallback = callback;
            try {
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                String[] accept = params == null ? null : params.getAcceptTypes();
                String type = "*/*";
                if (accept != null && accept.length > 0 && accept[0] != null && accept[0].length() > 0) {
                    type = accept[0].split(",")[0].trim();
                }
                intent.setType(type);
                startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
            } catch (Exception e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("知道了", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.confirm();
                        }
                    })
                    .setCancelable(false)
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.confirm();
                        }
                    })
                    .setNegativeButton("取消", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.cancel();
                        }
                    })
                    .setCancelable(false)
                    .show();
            return true;
        }
    }

    /* ------------------------------------------------------------ JS 桥 */

    /** 只暴露三个方法，全部是"打开某个界面"或"读版本号"，不涉及数据与账号。 */
    private class Bridge {
        @JavascriptInterface
        public String getInfo() {
            String brand = String.valueOf(Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
            String model = String.valueOf(Build.MODEL == null ? "" : Build.MODEL);
            return "{\"platform\":\"android\",\"appVersion\":\"" + VERSION + "\",\"sdk\":" + Build.VERSION.SDK_INT
                    + ",\"brand\":\"" + brand.replace("\"", "") + "\",\"model\":\"" + model.replace("\"", "") + "\"}";
        }

        /**
         * 页面调：现在可以问「后台运行模式」了。
         *
         * 由 JS 在隐私说明处理完之后调一次 —— 原生不再自己定时弹，
         * 否则那个原生框会正好压在首屏的隐私弹层上，叠成两层。
         * AlertDialog 必须在 UI 线程创建，所以这里 runOnUiThread。
         */
        @JavascriptInterface
        public void askBackground() {
            runOnUiThread(
                    new Runnable() {
                        @Override
                        public void run() {
                            askBackgroundOnce();
                        }
                    });
        }

        /**
         * 通知体检：把"系统真的允许到什么程度"一次报回来，供「我已开启」按钮校验。
         *
         * 【为什么不是只查 POST_NOTIFICATIONS】
         * 运行时权限只是第一道闸。用户完全可能在授予权限之后：
         *   · 关掉应用级「允许通知」总开关（`areNotificationsEnabled()` 为 false）；
         *   · 把「上课提醒」渠道关掉或降级（`importance == 0` / 降到 DEFAULT）；
         *   · 开着勿扰模式 —— 通知进了通知栏，但**横幅不会弹**；
         * 这三种情况 `granted` 全是 true。只查权限就判"通过"，等于假装校验过。
         *
         * 【哪些读不到，必须如实说】
         * 「横幅」「锁屏」两个复选框 Android **没有查询 API**。
         * ColorOS 关掉横幅会把渠道降到 `IMPORTANCE_DEFAULT(3)`，所以 `bannerLikely`
         * 只是**代理判定**（importance >= HIGH 才为 true），不能当成确定结论。
         * 真正的确认交给网页侧的「发一条测试通知 + 问用户看到没有」。
         *
         * @return `{granted, appEnabled, importance, importanceLabel, channelExists,
         *          bannerLikely, dndActive, promoted}`
         */
        @JavascriptInterface
        public String notificationAudit() {
            JSONObject o = new JSONObject();
            try {
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);

                // ① 运行时权限（Android 13+ 才有意义）
                o.put("granted", ReminderScheduler.canNotify(MainActivity.this));

                // ② 应用级总开关：API 24+ 可用；13 以下这是唯一的总开关
                boolean appEnabled = true;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && nm != null) {
                    try {
                        appEnabled = nm.areNotificationsEnabled();
                    } catch (Throwable ignored) {
                        appEnabled = true; // 读不到就别诬告用户
                    }
                }
                o.put("appEnabled", appEnabled);

                // ③ 渠道 importance（0 = 关了；<=2 = 没有横幅/声音）
                int importance = -1;
                boolean channelExists = false;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
                    NotificationChannel ch = nm.getNotificationChannel(ReminderScheduler.CHANNEL_ID);
                    if (ch != null) {
                        channelExists = true;
                        importance = ch.getImportance();
                    }
                }
                o.put("importance", importance);
                o.put("importanceLabel", importanceLabelOf(importance));
                o.put("channelExists", channelExists);
                o.put("bannerLikely", importance >= NotificationManager.IMPORTANCE_HIGH);

                // ④ 勿扰模式：不等于 ALL 就说明横幅会被压掉
                boolean dndActive = false;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && nm != null) {
                    try {
                        dndActive =
                                nm.getCurrentInterruptionFilter()
                                        != NotificationManager.INTERRUPTION_FILTER_ALL;
                    } catch (Throwable ignored) {
                        dndActive = false;
                    }
                }
                o.put("dndActive", dndActive);

                // ⑤ 提升通知（流体云）：API 36+ 才有这个概念
                if (Build.VERSION.SDK_INT >= 36) {
                    o.put("promoted", nm != null && nm.canPostPromotedNotifications());
                } else {
                    o.put("promoted", JSONObject.NULL);
                }
            } catch (Exception e) {
                // 读失败就当没通过，别让用户以为开好了
            }
            return o.toString();
        }

        /**
         * 打开「后台运行模式」相关页面：**应用详情页优先**（设置 › 应用 › 北邮课程表，
         * 「耗电管理」就在这一页）。详见 {@link #openBatteryModeChain()}。
         *
         * @return appDetail / ignoreList / requestIgnore / none
         */
        @JavascriptInterface
        public String openBatteryModePage() {
            final String[] out = {"none"};
            try {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        out[0] = openBatteryModeChain();
                    }
                });
                Thread.sleep(140);
            } catch (Throwable ignored) {
                // 忽略
            }
            return out[0];
        }

        /**
         * 只开 AOSP 那层「电池优化」列表（Doze 白名单，和厂商的耗电管理是两件事）。
         *
         * @return ignoreList / requestIgnore / none
         */
        @JavascriptInterface
        public String openAospBatteryList() {
            final String[] out = {"none"};
            try {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        out[0] = MainActivity.this.openAospBatteryList();
                    }
                });
                Thread.sleep(140);
            } catch (Throwable ignored) {
                // 忽略
            }
            return out[0];
        }

        /** 是否已在「忽略电池优化」白名单里。 */
        @JavascriptInterface
        public boolean batteryExempt() {
            return ignoringBattery();
        }

        /* ---------------- 首次启动的一次性引导（1.56.0） ---------------- */

        /**
         * 一次性汇报所有"要用户点一下才生效"的状态，网页据此渲染引导清单。
         *
         * 全是只读判断，不弹任何系统框；真要点按钮时网页再调下面的 openXxx。
         */
        @JavascriptInterface
        public String permissionSnapshot() {
            JSONObject o = new JSONObject();
            try {
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("notify", getNotifyPermission());
                o.put("batteryExempt", ignoringBattery());
                // ★ 小米官方文档（dev.mi.com/xiaomihyperos pId=1628）第 6 条：
                //   "当应用程序调用 isBackgroundRestricted() 方法时，返回 true" ——
                //   也就是**厂商那层的限制状态在小米上是可读的**（标准 API，API 28+）。
                //   其它 ROM 上这个值只反映标准的后台限制开关，可能为 false 但实际仍被限，
                //   所以 UI 只拿它当"已被限制"的正向证据，**绝不反推"没被限制"**。
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    ActivityManager am = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
                    o.put("bgRestricted", am != null && am.isBackgroundRestricted());
                } else {
                    o.put("bgRestricted", JSONObject.NULL);
                }
                o.put("exactAlarm", ReminderScheduler.exactAlarmGranted(MainActivity.this));
                // 提升通知（流体云）：API 36+ 才存在这个概念
                if (Build.VERSION.SDK_INT >= 36) {
                    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                    o.put("promoted", nm != null && nm.canPostPromotedNotifications());
                } else {
                    o.put("promoted", JSONObject.NULL);
                }
            } catch (Exception e) {
                // 任何一项读失败都不该让引导整个挂掉
            }
            return o.toString();
        }

        /** 精确闹钟（Android 12+ 的特殊权限，默认关闭）。 */
        @JavascriptInterface
        public void openExactAlarmSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                            Intent i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                            i.setData(Uri.parse("package:" + getPackageName()));
                            startActivity(i);
                            return;
                        }
                    } catch (Throwable ignored) {
                        // 落到应用详情页
                    }
                    openAppDetail();
                }
            });
        }

        /**
         * 通知设置页 —— 必须**一次点到渠道页**，不能让用户自己在应用详情里翻。
         *
         * ColorOS 实测（2026-10-25）：`ACTION_APP_NOTIFICATION_SETTINGS` 在这台机器上
         * 要么不认、要么直接落到「应用详情」，用户还得再点「权限管理 → 通知」两层。
         *
         * 所以按"最具体 → 最宽泛"依次尝试，第一个真正能打开的才算数：
         *   ① 渠道级 `ACTION_CHANNEL_NOTIFICATION_SETTINGS`（带渠道 ID）→ 横幅/锁屏/静默全在这一页
         *   ② 应用级 `ACTION_APP_NOTIFICATION_SETTINGS`（并补老版本用的 app_package / app_uid extra）
         *   ③ 应用详情页（兜底，至少离目标最近）
         */
        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    openNotificationSettingsChain();
                }
            });
        }

        /**
         * 目标是「设置 → 应用 → 北邮课程表 → 权限管理 → 通知」这一页。
         *
         * 现实约束：**"权限管理"这一层没有公开 API**（AOSP 只提供"应用详情"和"应用通知设置"）。
         * 所以按"最接近目标"的顺序试，并回报落点：
         *   ① ColorOS 权限管理器（旧版 `com.color.safecenter`，带 packageName extra）→ 直接是权限列表
         *   ② 新版 `com.oplus.securitypermission` 的权限管理页（存在才用）
         *   ③ 标准「应用通知设置」ACTION_APP_NOTIFICATION_SETTINGS（"通知"权限页，多数 ROM 直达）
         *   ④ 应用详情（ColorOS 在这里提供「权限管理」入口，用户再点一层）
         *
         * @return perm / notify / detail / none
         */
        @JavascriptInterface
        public String openNotificationPermissionPage() {
            final String[] out = {"none"};
            try {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        out[0] = openNotificationPermissionChain();
                    }
                });
                Thread.sleep(140);
            } catch (Throwable ignored) {
                // 忽略
            }
            return out[0];
        }

        /**
         * 直接打开「通知与控制中心」（`android.settings.NOTIFICATION_SETTINGS`）。
         *
         * 用户明确指定要落这一页：它是 ColorOS 里离"应用通知设置"最近、且**确实能打开**的页面
         * （底部有「应用通知设置」入口）。跳不动时再退回完整链路，绝不静默失败。
         *
         * @return true 表示已经打开
         */
        @JavascriptInterface
        public boolean openNotificationCenter() {
            final boolean[] ok = {false};
            try {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            ReminderScheduler.ensureChannel(MainActivity.this);
                        } catch (Throwable ignored) {
                            // 忽略
                        }
                        Intent i = new Intent("android.settings.NOTIFICATION_SETTINGS");
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        ok[0] = tryStartActivity(i);
                    }
                });
                Thread.sleep(120);
            } catch (Throwable ignored) {
                // 忽略
            }
            return ok[0];
        }

        /**
         * 同 openNotificationSettings，但同步告诉你**落到了哪一级**，
         * 网页据此给一句准确提示（例如落在列表页时提醒"点一下北邮课程表"）。
         */
        @JavascriptInterface
        public String openNotificationSettingsEx() {
            final String[] out = {"none"};
            try {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        out[0] = openNotificationSettingsChain();
                    }
                });
                // 主线程排队后可能还没执行完，给个很短的等待（不影响 UI 响应）
                Thread.sleep(120);
            } catch (Throwable ignored) {
                // 忽略
            }
            return out[0];
        }

        /** 提升通知 / 流体云（API 36+ 才有独立开关）。 */
        @JavascriptInterface
        public void openPromotedSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (Build.VERSION.SDK_INT >= 36) {
                            startActivity(new Intent("android.settings.MANAGE_APP_PROMOTED_NOTIFICATIONS"));
                            return;
                        }
                    } catch (Throwable ignored) {
                        // 厂商没有这个入口
                    }
                    openAppDetail();
                }
            });
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                        i.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(i);
                    } catch (Throwable t) {
                        Toast.makeText(MainActivity.this, "请手动进入 设置 › 应用 里找到本应用", Toast.LENGTH_LONG)
                                .show();
                    }
                }
            });
        }

        /** 打开系统「忽略电池优化」页（厂商没这个入口时自动退回应用详情页）。 */
        @JavascriptInterface
        public void openBatterySettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.openBatterySettings();
                }
            });
        }

        @JavascriptInterface
        public void openJwgl() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent intent = new Intent(MainActivity.this, JwglActivity.class);
                    startActivityForResult(intent, REQ_JWGL);
                }
            });
        }

        /** 保存学号密码（Keystore 加密后存本机，网页读不到明文）。 */
        @JavascriptInterface
        /**
         * 「一键获取作业」：登录云邮教学空间，把待办 + 详情抓回来。
         *
         * 结果不从这里同步返回（要跑十几秒），而是通过
         * `window.__buptHomeworkEvent(...)` 推给网页。
         */
        public boolean grabHomework(final String account, final String password) {
            // ★ JS 桥是在 JavaBridge 线程调进来的，碰 View 必须先切 UI 线程，
            //   否则直接抛 "Calling View methods on another thread"（真机崩过）。
            runOnUiThread(
                    new Runnable() {
                        @Override
                        public void run() {
                            if (grabber != null && grabber.isRunning()) {
                                Toast.makeText(
                                                MainActivity.this,
                                                "课表还在抓，等它跑完",
                                                Toast.LENGTH_SHORT)
                                        .show();
                                return;
                            }
                            if (homeworkGrabber == null) {
                                homeworkGrabber =
                                        new HomeworkGrabber(
                                                MainActivity.this, grabHost, new HomeworkListener());
                            }
                            // 失败原因由 start() 自己 emitError，这里不用管返回值
                            homeworkGrabber.start(account, password);
                        }
                    });
            // 乐观返回 true：真正的失败会通过 __buptHomeworkEvent 推回来
            return true;
        }

        /* ---- 作业的凭证单独一套：云邮和教务的密码不一样 ---- */

        @JavascriptInterface
        public boolean saveHomeworkCredentials(String account, String password) {
            return Credentials.saveHomework(MainActivity.this, account, password);
        }

        @JavascriptInterface
        public boolean hasHomeworkCredentials() {
            return Credentials.hasHomework(MainActivity.this);
        }

        @JavascriptInterface
        public String homeworkAccount() {
            return Credentials.homeworkAccount(MainActivity.this);
        }

        @JavascriptInterface
        public void clearHomeworkCredentials() {
            Credentials.clearHomework(MainActivity.this);
        }

        public boolean saveCredentials(String account, String password) {
            return Credentials.save(MainActivity.this, account, password);
        }

        @JavascriptInterface
        public boolean hasCredentials() {
            return Credentials.has(MainActivity.this);
        }

        /** 已保存的学号（只回显账号，**绝不回传密码**）。 */
        @JavascriptInterface
        public String credentialsAccount() {
            return Credentials.account(MainActivity.this);
        }

        @JavascriptInterface
        public void clearCredentials() {
            Credentials.clear(MainActivity.this);
        }

        /** 「更新课表」：自动登录 + 抓取，结果走 __buptUpdatePayload / __buptAutoCaptureError。 */
        @JavascriptInterface
        public void autoCapture() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (!Credentials.has(MainActivity.this)) {
                        web.evaluateJavascript("window.__buptAutoCaptureError&&window.__buptAutoCaptureError('bad_credentials')", null);
                        return;
                    }
                    Intent intent = new Intent(MainActivity.this, JwglActivity.class);
                    intent.putExtra(JwglActivity.EXTRA_AUTO, true);
                    startActivityForResult(intent, REQ_AUTO);
                }
            });
        }

        /* ---------------- 后台自动抓取（1.15.0） ---------------- */

        /**
         * 只给学号密码就开始抓：**不跳界面**，在隐藏 WebView 里跑，进度实时回传。
         *
         * @param id 网页生成的本次任务号（结果/进度/失败都带着它，用来丢弃迟到事件）
         * @param account 学号
         * @param password 密码；空串表示用已保存的那份（网页读不到明文）
         */
        @JavascriptInterface
        public void startGrab(final String id, final String account, final String password) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (grabber == null) {
                        // 引擎没建起来也要给结论——网页不能永远转圈
                        grabListener.onError(id, "unknown", "抓取引擎未初始化");
                        return;
                    }
                    grabber.start(id, account, password);
                }
            });
        }

        /** 用户点了取消：立刻停并回一个 cancelled 终态。 */
        @JavascriptInterface
        public void cancelGrab() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (grabber != null) grabber.cancel();
                }
            });
        }

        /** 是否已有抓取在跑（网页重新进导入页时用来恢复进度，而不是显示"空闲"）。 */
        @JavascriptInterface
        public boolean grabRunning() {
            return grabber != null && grabber.isRunning();
        }

        /** 原生通知权限：13 以下恒为 granted；13+ 看 POST_NOTIFICATIONS。 */
        @JavascriptInterface
        public String getNotifyPermission() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted";
            if (ReminderScheduler.canNotify(MainActivity.this)) return "granted";
            return shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
                    ? "denied"
                    : "default";
        }

        /** 拉起系统权限弹窗（回调后通过 __buptNotifyPermissionChanged 通知网页）。 */
        @JavascriptInterface
        public void requestNotifyPermission() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    ReminderScheduler.ensureChannel(MainActivity.this);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
                    } else {
                        notifyPermissionMaybeChanged();
                    }
                }
            });
        }

        /** 网页算好的提醒点（未来 7 天）整批交过来排系统闹钟。 */
        @JavascriptInterface
        public void scheduleReminders(final String json) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        ReminderScheduler.schedule(MainActivity.this, json);
                    } catch (Exception ignored) {
                        // 排程失败不该影响网页
                    }
                }
            }).start();
        }

        /* ---------------- 桌面小组件（1.16.0） ---------------- */

        /**
         * 网页把"接下来 14 天每天有什么课"算好交过来，存盘并立刻重绘桌面小组件。
         *
         * 只传展示所需的字段（课名/地点/时间/颜色），不含学号密码，也不含任何账号信息。
         * 全程不抛异常：小组件出问题不该把网页的渲染流程带崩。
         */
        @JavascriptInterface
        public void syncWidget(final String json) {
            try {
                CourseWidget.syncAll(MainActivity.this, json);
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface
        public void toast(final String message) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, String.valueOf(message), Toast.LENGTH_SHORT).show();
                }
            });
        }
    }

    /** 权限弹窗回来后告诉网页刷新（否则用户点了允许，卡片还显示未授权）。 */
    private void notifyPermissionMaybeChanged() {
        if (web == null) return;
        web.evaluateJavascript("window.__buptNotifyPermissionChanged&&window.__buptNotifyPermissionChanged()", null);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_NOTIFY) notifyPermissionMaybeChanged();
    }

    /* ------------------------------------------------------------ 结果回传 */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQ_FILE) {
            if (fileCallback == null) return;
            Uri[] uris = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                uris = new Uri[] { data.getData() };
            }
            fileCallback.onReceiveValue(uris);
            fileCallback = null;
            return;
        }

        if (requestCode == REQ_JWGL) {
            if (resultCode != RESULT_OK || data == null) {
                Toast.makeText(this, "已取消抓取", Toast.LENGTH_SHORT).show();
                return;
            }
            String path = data.getStringExtra(JwglActivity.EXTRA_CAPTURE_PATH);
            if (path == null) return;
            String json;
            try {
                json = readFile(new File(path));
            } catch (IOException e) {
                Toast.makeText(this, "读取抓取结果失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                return;
            }
            // 用 base64 转交：HTML 里有引号、换行、反斜杠，直接拼 JS 字符串必炸
            String b64 = Base64.encodeToString(json.getBytes(java.nio.charset.Charset.forName("UTF-8")), Base64.NO_WRAP);
            web.evaluateJavascript("window.__buptNativeImportPayload('" + b64 + "')", null);
            return;
        }

        if (requestCode == REQ_AUTO) {
            if (resultCode != RESULT_OK || data == null) {
                String code = data == null ? "unknown" : String.valueOf(data.getStringExtra(JwglActivity.EXTRA_ERROR));
                web.evaluateJavascript(
                        "window.__buptAutoCaptureError&&window.__buptAutoCaptureError('" + code + "')", null);
                return;
            }
            String path = data.getStringExtra(JwglActivity.EXTRA_CAPTURE_PATH);
            if (path == null) {
                web.evaluateJavascript("window.__buptAutoCaptureError&&window.__buptAutoCaptureError('no_timetable')", null);
                return;
            }
            String json;
            try {
                json = readFile(new File(path));
            } catch (IOException e) {
                web.evaluateJavascript("window.__buptAutoCaptureError&&window.__buptAutoCaptureError('read_failed')", null);
                return;
            }
            String b64 = Base64.encodeToString(json.getBytes(java.nio.charset.Charset.forName("UTF-8")), Base64.NO_WRAP);
            web.evaluateJavascript("window.__buptUpdatePayload&&window.__buptUpdatePayload('" + b64 + "')", null);
        }
    }

    private static String readFile(File file) throws IOException {
        FileInputStream in = new FileInputStream(file);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), java.nio.charset.Charset.forName("UTF-8"));
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
                // 忽略
            }
        }
    }

    /* ------------------------------------------------------------ 生命周期 / 返回键 */

    @Override
    public void onBackPressed() {
        // ★ 先问网页：有弹层就把弹层收掉。
        //   真机反馈（2026-10-26）：弹层开着时从左边缘右滑，应用直接退了 ——
        //   因为 canGoBack() 为 false 就走了"再按一次退出"。弹层浮在页面之上，
        //   返回语义应该是"关掉它"，而不是退出。
        if (web == null) {
            fallbackBack();
            return;
        }
        try {
            web.evaluateJavascript(
                    "window.__buptDismissModal?window.__buptDismissModal():false",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            // 网页返回的是 JSON：true / false
                            if ("true".equals(value)) return;
                            fallbackBack();
                        }
                    });
        } catch (Throwable t) {
            fallbackBack();
        }
    }

    /** 网页没有弹层时的老逻辑：能后退就后退，否则双击退出。 */
    private void fallbackBack() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPressedAt < 2000L) {
            super.onBackPressed();
            return;
        }
        lastBackPressedAt = now;
        Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 每次回到前台自检一次：刷新服务要是被系统杀了，立刻拉起来
        ClassRefreshService.ensureAlive(this);
        if (web != null) {
            web.onResume();
            // ★ WebView 里 visibilitychange 不可靠：Activity 暂停时 WebView 也会被 onPause，
            //   部分机型回来时不派发这个事件。所以从原生 onResume 直接回调一次，
            //   网页那边用 pending 去重，两条路都走也只会执行一遍。
            web.evaluateJavascript("window.__buptResume&&window.__buptResume()", null);
        }
    }

    @Override
    protected void onDestroy() {
        // 先停掉后台抓取，再销毁主 WebView：否则回调会打到已销毁的 web 上
        if (grabber != null) {
            grabber.release();
            grabber = null;
        }
        if (web != null) {
            web.setWebChromeClient(null);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /* ------------------------------------------------------------ 小工具 */

    private static Map<String, String> headers() {
        Map<String, String> map = new HashMap<String, String>();
        map.put("Cache-Control", "no-cache");
        return map;
    }

    private static String charsetOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".png") || p.endsWith(".jpg") || p.endsWith(".jpeg") || p.endsWith(".webp")
                || p.endsWith(".ico") || p.endsWith(".woff2") || p.endsWith(".woff")) {
            return null;
        }
        return "utf-8";
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }
}
