package com.bupt.schedule;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;


/**
 * 原生上课提醒：AlarmManager 精确闹钟 + 通知渠道。
 *
 * 【为什么必须走原生】Android WebView 里**没有** Notification API，也没有
 * Service Worker；页面里的 setTimeout 在 App 进后台/被杀后就断了。
 * 只有系统闹钟能在锁屏、清后台之后照样响。
 *
 * 排程数据由网页侧算好（未来 7 天，最多几十条）后整批传进来，这里只负责：
 *   撤销上一次排的 → 按新列表排 → 同时把列表存进 SharedPreferences（开机后重排）。
 */
final class ReminderScheduler {

    static final String CHANNEL_ID = "bupt_class_reminder";
    static final String ACTION_FIRE = "com.bupt.schedule.REMIND";
    /**
     * 上课时刻到点，把提醒卡收掉。
     *
     * 【为什么必须单独排一个闹钟】Live Updates 形态的通知是 ongoing（不能划掉），
     * 靠 setAutoCancel 永远不会自己消失。不排这个收尾闹钟，胶囊会一直挂到用户
     * 手动点「知道了」为止 —— 真机上表现为"上课十分钟了还写着还有 0 分钟"。
     */
    static final String ACTION_DISMISS = "com.bupt.schedule.DISMISS";

    /**
     * 每分钟刷一次胶囊文字。
     *
     * 【为什么需要】`setShortCriticalText` 传的是**字符串**，不是时间戳。系统只会把它原样画出来，
     * 不会替你算「现在还剩几分钟」。所以提前 5 分钟发出的「5分后上课」，过两分钟还是「5分后上课」
     * —— 用户在真机上撞到了（2026-10-24：倒计时到 3 分钟了，胶囊还写着 5 分钟）。
     *
     * 【修法】用同一个 notification id 重发，`setOnlyAlertOnce(true)` 保证不重复响铃。
     * 每分钟链式排下一次，直到剩最后一分钟 —— 那时文字已经是「1分后上课」，交给收尾闹钟。
     *
     * 【为什么不自己逐秒】逐秒要 60 倍的唤醒，而且系统对高频 notify 有限流。
     * 逐秒的倒计时在展开态由 SystemUI 的 chronometer 负责，折叠态一分钟一格足够。
     */
    static final String ACTION_REFRESH = "com.bupt.schedule.REFRESH_TEXT";

    private static final String PREFS = "bupt_reminders";
    private static final String KEY_PLAN = "plan";
    private static final String KEY_IDS = "ids";
    private static final int MAX_ALARMS = 200;
    /** setAlarmClock 的 showIntent 用独立 requestCode，别和通知点击（0）撞。 */
    private static final int SHOW_RC = 0x5A5A;

    private ReminderScheduler() {}

    /* ------------------------------------------------------------ 通知渠道 */

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch =
                new NotificationChannel(CHANNEL_ID, "上课提醒", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("上课前按课表提醒（由系统闹钟触发）");
        ch.enableVibration(true);
        ch.enableLights(true);
        nm.createNotificationChannel(ch);
    }

    /**
     * 精确闹钟到底能不能用。
     *
     * Android 12 起 `SCHEDULE_EXACT_ALARM` 是**特殊权限**，默认关闭、要用户去系统设置里开；
     * 13+ 声明了 `USE_EXACT_ALARM` 就是装的即授予。两者任一到位这里才返回 true。
     * 返回 false 时所有闹钟都会退化成 `setAndAllowWhileIdle`，能漂十几分钟 ——
     * 「胶囊一直挂着 5 分钟不变」就是这么来的（2026-10-24 真机定位）。
     */
    static boolean exactAlarmGranted(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    /** 有没有发通知的权限（Android 13+ 需要运行时授权）。 */
    static boolean canNotify(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                == PackageManager.PERMISSION_GRANTED;
    }

    /* ------------------------------------------------------------ 排程 */

    /**
     * 整批重排。返回实际排上的条数。
     * @param json `[{id,at,title,body}]`，at 为 epoch 毫秒
     */
    static int schedule(Context ctx, String json) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return 0;
        ensureChannel(ctx);
        cancelAll(ctx, am);

        JSONArray input;
        try {
            input = new JSONArray(String.valueOf(json));
        } catch (Exception e) {
            return 0;
        }

        long now = System.currentTimeMillis();
        JSONArray kept = new JSONArray();
        JSONArray ids = new JSONArray();
        int count = 0;

        for (int i = 0; i < input.length() && count < MAX_ALARMS; i += 1) {
            JSONObject item = input.optJSONObject(i);
            if (item == null) continue;
            long at = item.optLong("at", 0L);
            if (at <= now + 1000L) continue; // 过去的不排
            String id = str(item, "id");
            if (id.length() == 0) id = String.valueOf(at);
            int requestCode = requestCodeOf(id);

            Intent intent = new Intent(ctx, ReminderReceiver.class);
            intent.setAction(ACTION_FIRE);
            // ★ 走 str()：org.json 的 optString 遇到 JSON null 会返回字符串 "null"，
            //   兜底值只在键不存在时生效。一旦漏掉，通知栏里就会出现「null」。
            String title = str(item, "title");
            intent.putExtra("title", title.length() == 0 ? "即将上课" : title);
            intent.putExtra("body", str(item, "body"));
            intent.putExtra("periods", str(item, "periods"));
            intent.putExtra("startEpoch", item.optLong("startEpoch", 0L));
            intent.putExtra("id", id);
            intent.putExtra("rc", requestCode);

            PendingIntent pi =
                    PendingIntent.getBroadcast(
                            ctx, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            setAlarm(am, at, pi);
            kept.put(item);
            ids.put(requestCode);
            count += 1;
        }

        prefs(ctx).edit().putString(KEY_PLAN, kept.toString()).putString(KEY_IDS, ids.toString()).apply();
        return count;
    }

    /** 撤销上一次排的全部闹钟。 */
    static void cancelAll(Context ctx, AlarmManager am) {
        JSONArray ids;
        try {
            ids = new JSONArray(prefs(ctx).getString(KEY_IDS, "[]"));
        } catch (Exception e) {
            ids = new JSONArray();
        }
        for (int i = 0; i < ids.length(); i += 1) {
            int rc = ids.optInt(i, 0);
            Intent intent = new Intent(ctx, ReminderReceiver.class);
            intent.setAction(ACTION_FIRE);
            PendingIntent pi =
                    PendingIntent.getBroadcast(
                            ctx, rc, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            try {
                am.cancel(pi);
                pi.cancel();
            } catch (Exception ignored) {
                // 撤销失败不影响后面重排
            }
            // ★ 已发出的卡片如果还挂着刷新链，会在重排后继续按旧时间刷 —— 一并掐掉
            cancelRefresh(ctx, rc);
        }
        prefs(ctx).edit().remove(KEY_IDS).apply();
    }

    private static void setAlarm(AlarmManager am, long at, PendingIntent pi) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
                // 用户没给"精确闹钟"权限：退化成允许休眠的闹钟，晚几分钟但不丢
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (SecurityException e) {
            am.set(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    /** 开机后按上次存的计划重排（否则重启一次所有闹钟就没了）。 */
    static void rescheduleFromPrefs(Context ctx) {
        String plan = prefs(ctx).getString(KEY_PLAN, "");
        if (plan == null || plan.length() < 4) return;
        schedule(ctx, plan);
    }

    /* ------------------------------------------------------------ 发通知 */

    /**
     * 发一条提醒卡。
     *
     * @param course     课程名（展开后的标题）
     * @param periods    「第3-4节」
     * @param startEpoch 上课时刻；<=0 表示不是真实课程（测试通知），走普通可划掉的通知
     */
    static void notifyNow(Context ctx, String course, String periods, long startEpoch, int requestCode) {
        post(ctx, course, periods, startEpoch, requestCode);
    }

    /**
     * 构造（但不发出）一张提醒卡。
     *
     * 抽出来是因为**前台服务**也要用同一份通知：`startForeground` 必须拿到
     * 一个 Notification 对象，而它和后面 notify 更新的必须是同一条（同 id），
     * 否则通知栏会出现两张卡。
     */
    static Notification buildCard(
            Context ctx, String course, String periods, long startEpoch, int requestCode) {
        // ★ 标题只放课程名，绝不拼任何时间戳/调试信息 ——
        //   曾经在标题里拼「@15:45:32」以确认刷新链在跑，用户把它当成上课时间，看起来就是"时间不准"。
        Intent open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent =
                PendingIntent.getActivity(
                        ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // 常驻通知划不掉，必须给一个明确的撤销出口
        PendingIntent ack = null;
        if (startEpoch > 0) {
            Intent dismiss = new Intent(ctx, ReminderReceiver.class);
            dismiss.setAction(ACTION_DISMISS);
            dismiss.putExtra("rc", requestCode);
            ack =
                    PendingIntent.getBroadcast(
                            ctx,
                            requestCode + 1,
                            dismiss,
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }
        return ClassCard.build(ctx, course, periods, startEpoch, contentIntent, ack);
    }

    private static void post(
            Context ctx, String course, String periods, long startEpoch, int requestCode) {
        if (!canNotify(ctx)) return;
        // 重新发卡 = 这张卡重新存在，之前「已撤销」的标记作废
        clearDismissed(ctx, requestCode);
        ensureChannel(ctx);
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        try {
            nm.notify(requestCode, buildCard(ctx, course, periods, startEpoch, requestCode));
        } catch (SecurityException ignored) {
            // 没权限就算了，页面上会提示去开
        }
        scheduleDismiss(ctx, startEpoch, requestCode);
        scheduleRefresh(ctx, course, periods, startEpoch, requestCode);
    }

    /** 上课那一刻把卡片收掉（ongoing 通知不会自己消失）。 */
    static void dismiss(Context ctx, int requestCode) {
        // ★ 先掐断刷新链：否则一分钟后又会把刚撤掉的卡片发回来
        cancelRefresh(ctx, requestCode);
        // 留个标记兜底（cancel 万一没生效，refresh 会自己看到这个标记）
        prefs(ctx).edit().putBoolean(DISMISSED_PREFIX + requestCode, true).apply();
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        try {
            nm.cancel(requestCode);
        } catch (Exception ignored) {
            // 已经没了就算了
        }
    }

    private static void scheduleDismiss(Context ctx, long startEpoch, int requestCode) {
        if (startEpoch <= 0 || startEpoch <= System.currentTimeMillis() + 1000L) return;
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent intent = new Intent(ctx, ReminderReceiver.class);
        intent.setAction(ACTION_DISMISS);
        intent.putExtra("rc", requestCode);
        // 与触发闹钟同 requestCode 但 action 不同，PendingIntent 不会互相覆盖
        PendingIntent pi =
                PendingIntent.getBroadcast(
                        ctx, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            setAlarm(am, startEpoch, pi);
        } catch (Exception ignored) {
            // 收尾闹钟排不上不算致命：用户还能点「知道了」
        }
    }

    /* ------------------------------------------------------------ 胶囊文字刷新 */

    private static final String DISMISSED_PREFIX = "dismissed_";

    /** 刷新闹钟用独立 requestCode，避开 fire(=rc) 与知道了(=rc+1)。 */
    private static int refreshCode(int requestCode) {
        return requestCode + 2;
    }

    private static PendingIntent refreshIntent(Context ctx, int requestCode) {
        Intent intent = new Intent(ctx, ReminderReceiver.class);
        intent.setAction(ACTION_REFRESH);
        intent.putExtra("rc", requestCode);
        return PendingIntent.getBroadcast(
                ctx,
                refreshCode(requestCode),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * 排「一分钟后重发一次」。
     *
     * 每次刷新触发时都会再调一次本方法，形成自持的链；断链只有两个出口：
     *   · 剩最后一分钟（文字已经是「1分后上课」，不用再刷）
     *   · 用户点「知道了」→ {@link #cancelRefresh}
     */
    static void scheduleRefresh(
            Context ctx, String course, String periods, long startEpoch, int requestCode) {
        if (startEpoch <= 0) return;
        // ★ 1.35.0 起默认不排闹钟链：刷新交给 ClassRefreshService（前台服务自己跑 Handler）。
        //   闹钟链在 ColorOS 上压得太狠，留着只会让状态栏多一个闹钟图标。
        if (!ClassCard.REFRESH_ALARM_FALLBACK) return;
        long now = System.currentTimeMillis();
        long remain = startEpoch - now;
        if (remain <= 30_000L) return; // 最后半分钟：文字已是「马上上课」，交收尾闹钟

        // ★★ 刷新时刻必须落在每个文案区间的**中点**，不能是 now+60s。
        //   每档文案（「4分后上课」）的有效区间宽度正好 60 秒，和刷新周期一样宽。
        //   相位一旦错开就会整级跳过（真机出现过 5 分直接跳 3 分）。
        //   取区间中点：remain = (k - 0.5) × 60000，两侧各有 30 秒容差，
        //   即使闹钟晚几十秒也不会跨到隔壁档。
        // 档位 k 与 timeChipText 的取整方向必须一致：文案向上取整，档位也向上取整
        long k = (remain + 59_999L) / 60_000L;
        if (k < 1) return;
        long nextAt = startEpoch - k * 60_000L + 30_000L;
        if (nextAt <= now + 3_000L) return; // 防自激：算出来是过去/太近就停

        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        Intent intent = new Intent(ctx, ReminderReceiver.class);
        intent.setAction(ACTION_REFRESH);
        intent.putExtra("title", course);
        intent.putExtra("periods", periods);
        intent.putExtra("startEpoch", startEpoch);
        intent.putExtra("rc", requestCode);
        PendingIntent pi =
                PendingIntent.getBroadcast(
                        ctx,
                        refreshCode(requestCode),
                        intent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            setRefreshAlarm(ctx, am, nextAt, pi);
        } catch (Exception ignored) {
            // 排不上就停在当前文字，不算致命
        }
    }

    /**
     * 排刷新闹钟 —— **必须走 setAlarmClock，不能用 setExactAndAllowWhileIdle**。
     *
     * 【为什么】`setExactAndAllowWhileIdle` 在 Doze（灭屏静止后进入）下被系统限制成
     * **每个应用每 9 分钟只能唤醒一次**。课前 5 分钟的窗口里，每分钟一次的刷新根本排不进去，
     * 真机表现就是「一直挂着 5 分钟，直到 2 分钟才跳一次」（2026-10-24 用户反馈）。
     * 这跟有没有「闹钟和提醒」权限无关 —— 那是另一道门，两道都会拦。
     *
     * `setAlarmClock` 是系统最高优先级的闹钟类型（就是系统「闹钟」App 用的那个），
     * **不受 Doze 配额限制**，也不需要 SCHEDULE_EXACT_ALARM 权限，能按点唤醒。
     *
     * 代价：状态栏会出现闹钟图标（系统「下一个闹钟」）。只在课前这几分钟存在，
     * 刷新链一断就没了。这个代价换「分钟数准」，值得。
     */
    private static void setRefreshAlarm(
            Context ctx, AlarmManager am, long at, PendingIntent pi) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent show =
                PendingIntent.getActivity(
                        ctx,
                        SHOW_RC,
                        open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), pi);
        } catch (Throwable t) {
            // 某些 ROM 对 setAlarmClock 有额外限制，退回普通精确闹钟
            setAlarm(am, at, pi);
        }
    }

    /** 掐断刷新链。 */
    static void cancelRefresh(Context ctx, int requestCode) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = refreshIntent(ctx, requestCode);
        try {
            am.cancel(pi);
        } catch (Exception ignored) {
            // 已触发过就算了
        }
        pi.cancel();
    }

    /** 这张卡是不是已经被用户撤掉了（刷新前必须问一句，否则会把卡片复活）。 */
    static boolean wasDismissed(Context ctx, int requestCode) {
        return prefs(ctx).getBoolean(DISMISSED_PREFIX + requestCode, false);
    }

    static void clearDismissed(Context ctx, int requestCode) {
        prefs(ctx).edit().remove(DISMISSED_PREFIX + requestCode).apply();
    }

    /* ------------------------------------------------------------ 小工具 */

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * 读一个「可能为 null」的字符串字段，JSON null 一律当空串。
     *
     * ★ `optString(key, fallback)` 的 fallback **只在键不存在时**生效；
     *   值为 JSON null 时它返回字符串 "null"，于是通知里会印出「null」。
     */
    private static String str(JSONObject o, String key) {
        if (o == null || o.isNull(key)) return "";
        String v = o.optString(key, "");
        return "null".equals(v) ? "" : v;
    }

    /** 字符串 id → 稳定的非负 int（PendingIntent 的 requestCode）。 */
    static int requestCodeOf(String id) {
        int h = 0;
        for (int i = 0; i < id.length(); i += 1) {
            h = (h * 31 + id.charAt(i)) & 0x7fffffff;
        }
        return h == 0 ? 1 : h;
    }
}
