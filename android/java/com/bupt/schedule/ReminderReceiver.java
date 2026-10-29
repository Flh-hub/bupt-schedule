package com.bupt.schedule;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 闹钟到点 / 开机完成 的接收器。
 *
 * 闹钟是显式 Intent（指向本类），所以这里不需要 intent-filter 也能收到；
 * 开机广播是系统广播，靠 manifest 里的 BOOT_COMPLETED 过滤器。
 */
public class ReminderReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;

        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            // 重启/升级后闹钟会被系统清空，按上次的计划重新排
            ReminderScheduler.rescheduleFromPrefs(context);
            CourseWidget.refreshAll(context);
            return;
        }

        // 上课时刻到点：把提醒卡收掉。Live Updates 是 ongoing，不会自己消失。
        if (ReminderScheduler.ACTION_DISMISS.equals(intent.getAction())) {
            ReminderScheduler.dismiss(context, intent.getIntExtra("rc", 0));
            // 卡片没了，保鲜服务也没必要活着
            ClassRefreshService.stop(context);
            CourseWidget.refreshAll(context);
            return;
        }

        // ★ 胶囊文字刷新：重发同一张卡，让「5分后上课」→「4分后上课」跟着走。
        if (ReminderScheduler.ACTION_REFRESH.equals(intent.getAction())) {
            int rc = intent.getIntExtra("rc", 0);
            long startEpoch = intent.getLongExtra("startEpoch", 0L);
            // 用户已经点过「知道了」→ 链该断在这里，绝不能把卡片复活
            if (ReminderScheduler.wasDismissed(context, rc)) return;
            // 已经到点或过点：交给收尾闹钟，不再刷
            if (startEpoch <= 0 || System.currentTimeMillis() >= startEpoch) return;
            // notifyNow 内部会重新排下一次刷新（链式自持）
            ReminderScheduler.notifyNow(
                    context,
                    intent.getStringExtra("title"),
                    intent.getStringExtra("periods"),
                    startEpoch,
                    rc);
            return;
        }

        // ★ 作业截止提醒：普通通知，发完就结束。
        //   不进课程那套「胶囊 + 收尾闹钟 + 刷新服务」——作业没有"开始/结束"这一刻，
        //   挂前台服务只会白耗电，而且那张卡用户是可以直接划掉的。
        if ("homework".equals(intent.getStringExtra("kind"))) {
            int hwRc = intent.getIntExtra("rc", 0);
            HomeworkCard.notify(
                    context,
                    intent.getStringExtra("title"),
                    intent.getStringExtra("course"),
                    intent.getLongExtra("dueEpoch", 0L),
                    intent.getStringExtra("hwId"),
                    hwRc);
            return;
        }

        String title = intent.getStringExtra("title");
        String periods = intent.getStringExtra("periods");
        long startEpoch = intent.getLongExtra("startEpoch", 0L);
        int rc = intent.getIntExtra("rc", ReminderScheduler.requestCodeOf(String.valueOf(title)));
        ReminderScheduler.notifyNow(context, title, periods, startEpoch, rc);

        // ★ 1.35.0：「N分后上课」要自己跳，就靠这个前台服务每 15 秒重发一次。
        //   不走闹钟 —— 闹钟在国内 ROM 上压得太狠（1.30~1.34 五版的血泪）。
        ClassRefreshService.start(context, title, periods, startEpoch, rc);

        // 闹钟正好落在"上课/下课"的那一刻：顺手让小组件重算一遍"已上完"的淡化状态，
        // 否则要等到下一次 30 分钟的定时刷新才更新。
        CourseWidget.refreshAll(context);
    }
}
