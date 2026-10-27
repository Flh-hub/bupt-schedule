package com.bupt.schedule;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * 「倒计时保鲜」服务：让胶囊上的「N分后上课」自己跳。
 *
 * 【为什么最后是这个方案】
 * 1.30 ~ 1.34 一共五版都在跟系统抢唤醒：每分钟发一个闹钟去重发通知、换 setAlarmClock
 * 绕 Doze 配额、补 USE_EXACT_ALARM 权限、对齐取整相位……真机上全部会滞后
 * （ColorOS 把闹钟压后几十秒到几分钟，实测「剩 2:42 时胶囊还写 4分后上课」）。
 *
 * 结论：**闹钟这条路打不赢**。但换个角度就通了 ——
 * 用户看状态栏胶囊的那一刻，屏幕必然是亮的；屏幕亮着，前台服务的 Handler 就能正常跑，
 * 不需要唤醒锁、不需要精确闹钟权限、不受 Doze 影响。于是：
 *
 *   提醒响 → 起这个前台服务（复用同一张卡片通知）→ 每 15 秒重发一次刷新文案
 *   上课到 / 用户点「知道了」/ 课表重排 → stopSelf
 *
 * 【1.37.0：把「被系统杀掉」这个真实故障补上】
 * 真机实测过一次「标题停在 @23:11:34 再也不动」—— 那不是 notify 无效，是**服务被杀了**。
 * 之前这里有两个致命设置，导致一杀就永久停：
 *   ① 返回 START_NOT_STICKY —— 系统不会重启；
 *   ② onStartCommand 收到 null intent（系统重启服务时就给 null）直接 stopSelf。
 * 现在改成：参数落盘 + START_STICKY + null intent 时从盘上恢复，被杀后系统会自动拉起，
 * 接着按剩余时间继续刷（不会从头发一遍，文案都是现算的）。
 * 另外在设置页/首次测试时引导「忽略电池优化」，这是国内 ROM 上服务能活下来的前提。
 */
public class ClassRefreshService extends Service {

    /**
     * 两次刷新之间的**上限**。实际间隔由 {@link #nextBoundaryDelay} 按整分钟边界算，
     * 这个值只是兜底（时钟跳变 / 边界算不出来时最多睡这么久）。
     */
    private static final long MAX_GAP_MS = 60_000L;

    private static final String PREF = "class_refresh_state";
    private static final String K_RC = "rc";
    private static final String K_TITLE = "title";
    private static final String K_PERIODS = "periods";
    private static final String K_START = "startEpoch";

    /** 服务是否在跑（同进程内可见）。进程被杀时自然归 false。 */
    private static volatile boolean running = false;
    /** 最后一次心跳时刻；用来识别「进程还在但服务已被杀」这种半死状态。 */
    private static volatile long lastTickAt = 0L;
    /**
     * 心跳超过这个时间没更新，就认为服务已经死了。
     * ★ 必须大于 MAX_GAP_MS：刷新已改成"睡到下一个整分钟"，两次心跳之间正常就会有 50 多秒，
     *   用 40 秒会把活着的服务误判成死的，每次回前台都白重启一遍。
     */
    private static final long HEARTBEAT_TIMEOUT_MS = 75_000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable ticker;

    private int rc;
    private String course;
    private String periods;
    private long startEpoch;

    /** 从别处（闹钟触发 / 测试按钮）拉起服务。 */
    static void start(Context ctx, String course, String periods, long startEpoch, int rc) {
        if (ctx == null || startEpoch <= 0) return;
        Intent i = new Intent(ctx, ClassRefreshService.class);
        i.putExtra("title", course);
        i.putExtra("periods", periods);
        i.putExtra("startEpoch", startEpoch);
        i.putExtra("rc", rc);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Throwable ignored) {
            // 系统不允许起（比如被厂商策略拦），退化成静态文字，不影响提醒本身
        }
    }

    /** 掐掉服务（用户点「知道了」或课表重排时）。 */
    static void stop(Context ctx) {
        if (ctx == null) return;
        // ★ 必须同时清掉落盘参数：否则 ensureAlive() 会读到旧的 startEpoch，
        //   用户明明点过「知道了」，卡片却在下次回到前台时又活过来。
        try {
            ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().clear().apply();
        } catch (Throwable ignored) {
            // 清不掉也不影响下面停服务
        }
        try {
            ctx.stopService(new Intent(ctx, ClassRefreshService.class));
        } catch (Throwable ignored) {
            // 没在跑就算了
        }
    }

    /**
     * App 回到前台时自检：还有未到期的提醒、但服务已经死了，就把它拉起来。
     *
     * ★ 这是最后一道兜底 —— 只要用户打开过一次 App，刷新就会恢复，
     *   不需要用户去系统设置里手动点「启动」。
     */
    static void ensureAlive(Context ctx) {
        if (ctx == null) return;
        try {
            SharedPreferences p = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
            int rc = p.getInt(K_RC, 0);
            long start = p.getLong(K_START, 0L);
            if (rc == 0 || start <= System.currentTimeMillis()) return;
            boolean alive =
                    running && System.currentTimeMillis() - lastTickAt < HEARTBEAT_TIMEOUT_MS;
            if (alive) return;
            start(ctx, p.getString(K_TITLE, ""), p.getString(K_PERIODS, ""), start, rc);
        } catch (Throwable ignored) {
            // 自检失败不影响 App 使用
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            rc = intent.getIntExtra("rc", 0);
            course = intent.getStringExtra("title");
            periods = intent.getStringExtra("periods");
            startEpoch = intent.getLongExtra("startEpoch", 0L);
            persist();
        } else {
            // ★ 系统重启 sticky 服务时 intent 为 null —— 必须从盘上恢复，
            //   否则一被杀就永久停（1.35/1.36 的真机故障就是这么来的）。
            restore();
        }

        if (rc == 0 || startEpoch <= 0 || System.currentTimeMillis() >= startEpoch) {
            clearState();
            stopSelf();
            return START_NOT_STICKY;
        }

        // 前台服务必须先亮出一条通知；直接复用提醒卡本身（同 id，不会多一条）
        Notification n;
        try {
            n = ReminderScheduler.buildCard(this, course, periods, startEpoch, rc);
        } catch (Throwable t) {
            clearState();
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(rc, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(rc, n);
            }
        } catch (Throwable t) {
            // 起不来（权限/厂商限制）→ 只能退，硬撑会触发 "did not call startForeground" 崩溃
            clearState();
            stopSelf();
            return START_NOT_STICKY;
        }

        startTicking();
        running = true;
        lastTickAt = System.currentTimeMillis();
        // ★ STICKY：被 ROM 杀掉后系统会尝试重启，配合上面的 restore() 就能自动续上
        return START_STICKY;
    }

    /**
     * 距离"胶囊文字要变"还有多久（毫秒）。0 表示已经到点。
     *
     * 文案是**向上取整**的分钟数（剩 4:30 →「还有5分钟上课」，剩 3:59 →「还有4分钟上课」），
     * 它只在整分钟边界变化。所以不必每 15 秒轮询：直接睡到下一个边界 ——
     * 换字零延迟，唤醒次数还少 4 倍。
     *
     * 推导：设剩余 ms，显示分钟数 n = ceil(ms / 60000)。
     * 数字变成 n-1 的时刻 = startEpoch - (n-1) * 60000。
     */
    static long nextBoundaryDelay(long startEpoch, long now) {
        long ms = startEpoch - now;
        if (ms <= 0) return 0L;
        long mins = (ms + 59_999L) / 60_000L;
        long nextAt = startEpoch - (mins - 1) * 60_000L;
        long delay = nextAt - now;
        // 边界抖动兜底：算出来是 0 或负数时别忙循环
        if (delay < 120L) delay = 120L;
        if (delay > MAX_GAP_MS) delay = MAX_GAP_MS;
        return delay;
    }

    private void startTicking() {
        handler.removeCallbacksAndMessages(null);
        ticker =
                new Runnable() {
                    @Override
                    public void run() {
                        tick();
                    }
                };
        handler.postDelayed(ticker, nextBoundaryDelay(startEpoch, System.currentTimeMillis()));
    }

    private void tick() {
        // 到点：卡片该由收尾闹钟撤掉，服务自己也退出
        if (System.currentTimeMillis() >= startEpoch) {
            clearState();
            stopSelf();
            return;
        }
        lastTickAt = System.currentTimeMillis();
        try {
            NotificationManager nm =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && ReminderScheduler.canNotify(this)) {
                // 同 id 覆盖 = 更新同一条通知，不会响铃（ClassCard 里设了 setOnlyAlertOnce）
                nm.notify(
                        rc,
                        ReminderScheduler.buildCard(this, course, periods, startEpoch, rc));
            }
        } catch (Throwable ignored) {
            // 单次刷新失败不影响下一跳
        }
        long next = nextBoundaryDelay(startEpoch, System.currentTimeMillis());
        if (next <= 0L) {
            clearState();
            stopSelf();
            return;
        }
        if (ticker != null) handler.postDelayed(ticker, next);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    private void persist() {
        prefs().edit()
                .putInt(K_RC, rc)
                .putString(K_TITLE, course)
                .putString(K_PERIODS, periods)
                .putLong(K_START, startEpoch)
                .apply();
    }

    private void restore() {
        SharedPreferences p = prefs();
        rc = p.getInt(K_RC, 0);
        course = p.getString(K_TITLE, "");
        periods = p.getString(K_PERIODS, "");
        startEpoch = p.getLong(K_START, 0L);
    }

    private void clearState() {
        prefs().edit().clear().apply();
    }

    @Override
    public void onDestroy() {
        running = false;
        lastTickAt = 0L;
        if (ticker != null) handler.removeCallbacks(ticker);
        ticker = null;
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 用户从最近任务里划掉应用时，别顺手把提醒刷新也杀了
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
