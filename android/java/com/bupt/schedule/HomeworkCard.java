package com.bupt.schedule;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 作业截止提醒卡。
 *
 * 【和上课提醒卡的区别】
 *  - 不做 Live Updates / 流体云：作业不是"这一刻开始"的事件，没有倒计时的语义。
 *  - 可以划掉（{@code setAutoCancel(true)}），也不是 ongoing —— 绝不学课程卡那种
 *    "必须点知道了才消失"，那是为了胶囊收尾才有的强制行为。
 *  - 独立渠道：用户能单独关掉作业提醒，而不影响上课提醒（反之亦然）。
 *
 * 【剩余时间在「发通知那一刻」算，不在排程时算】
 * 排程可能发生在几天前，那时算出来的「还剩 1 天」到点早就不准了。
 * 所以原生只收到 dueEpoch，发通知时现算。
 */
final class HomeworkCard {

    static final String CHANNEL_ID = "bupt_homework_deadline";

    private HomeworkCard() {}

    /** 建渠道。IMPORTANCE_DEFAULT：进通知栏 + 声音，但不强弹横幅（作业不是即时事件）。 */
    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch =
                new NotificationChannel(CHANNEL_ID, "作业截止提醒", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("作业截止前一天提醒一次（由系统闹钟触发）");
        ch.enableVibration(true);
        nm.createNotificationChannel(ch);
    }

    /**
     * 剩余时间文案。
     *
     * 取整一律向下：宁可说「还剩 23 小时」也不要说「还剩 1 天」而实际只有 23 小时 ——
     * 少报会让人提前动手，多报会让人误判还早。
     */
    static String remainText(long dueEpoch, long now) {
        long remain = dueEpoch - now;
        if (remain <= 0) return "已截止";
        if (remain >= 24L * 3600 * 1000) return (remain / (24L * 3600 * 1000)) + " 天";
        if (remain >= 3600 * 1000) return (remain / (3600 * 1000)) + " 小时";
        long min = remain / 60000L;
        return (min < 1 ? 1 : min) + " 分钟";
    }

    /** `11-02 23:59` */
    static String formatDue(long dueEpoch) {
        try {
            return new SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(new Date(dueEpoch));
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * 正文：`高等数学（上）· 还剩 1 天`。没有课程名时只留后半段，不出现「 · 」这种空落。
     */
    static String buildText(String course, long dueEpoch, long now) {
        String remain = "还剩 " + remainText(dueEpoch, now);
        String c = course == null ? "" : course.trim();
        return c.length() == 0 ? remain : c + " · " + remain;
    }

    /** 展开态：课程名 / 截止时刻 / 剩余时间，一行一件事。 */
    static String buildBigText(String title, String course, long dueEpoch, long now) {
        StringBuilder sb = new StringBuilder();
        String c = course == null ? "" : course.trim();
        if (c.length() > 0) sb.append(c).append('\n');
        sb.append("截止 ").append(formatDue(dueEpoch)).append('\n');
        sb.append("还剩 ").append(remainText(dueEpoch, now));
        return sb.toString();
    }

    /**
     * 发一张作业提醒卡。
     *
     * @param hwId     作业 id → 点开直接落到该作业详情；空则落到作业列表
     * @param dueEpoch 截止时刻（epoch ms）
     * @param rc       notification id / PendingIntent requestCode
     */
    static void notify(
            Context ctx, String title, String course, long dueEpoch, String hwId, int rc) {
        if (!ReminderScheduler.canNotify(ctx)) return;
        ensureChannel(ctx);
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        long now = System.currentTimeMillis();
        String name = title == null || title.trim().length() == 0 ? "作业" : title.trim();
        String text = buildText(course, dueEpoch, now);

        Intent open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // 落地页：作业详情。MainActivity 在页面加载完后才执行它，冷启动也不会丢。
        String nav = "#/homework";
        if (hwId != null && hwId.trim().length() > 0) {
            nav = nav + "/" + hwId.trim();
        }
        open.putExtra(MainActivity.EXTRA_NAV, nav);
        PendingIntent content =
                PendingIntent.getActivity(
                        ctx,
                        rc,
                        open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b =
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? new Notification.Builder(ctx, CHANNEL_ID)
                        : new Notification.Builder(ctx);
        b.setSmallIcon(R.drawable.ic_crest_mono)
                .setContentTitle(name)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(buildBigText(name, course, dueEpoch, now)))
                .setContentIntent(content)
                .setAutoCancel(true)
                .setPriority(Notification.PRIORITY_DEFAULT)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setVisibility(Notification.VISIBILITY_PUBLIC);

        try {
            nm.notify(rc, b.build());
        } catch (SecurityException ignored) {
            // 没给通知权限：用户自己去开，页面里也有入口
        }
    }
}
