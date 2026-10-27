package com.bupt.schedule;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Bundle;

/**
 * 上课提醒卡。
 *
 * 【两种形态，同一份内容】
 *  - **安卓 16（API 36）及以上**：做成 Live Updates（ColorOS 16 上即「流体云」）。
 *    胶囊折叠态 = 校徽 + 「5分后上课」；展开 = 完整课程名 + 节次 + 上课时刻。
 *  - **低版本**：退回普通通知，内容一致，只是没有胶囊。
 *
 * 【折叠态为什么只有时间、没有课程名】
 * 胶囊那一行字由 `setShortCriticalText` 独占，`setContentTitle` 不参与渲染（真机上验证过）。
 * 而它只接受约 5~7 个字符，装不下「高等数学（上）· 还有 5 分钟」。用户明确选了「还剩多久」，
 * 课程名留在展开态。
 *
 * 【胶囊里的留白：已知且无解的系统版式】（1.22~1.25 反复实测）
 * 胶囊整体在状态栏严格居中，但内部是**两端对齐**：校徽贴最左，文字钉死在「屏幕中心右 68px」。
 * 于是中间那段空白 ≈ 胶囊宽度的一半，且胶囊宽度 ≈ 212 + 1.82 × 文字宽 ——
 * 唯一能影响它的就是**那行字的长度**（title 长度已证实完全无关，见下方 title 注释）。
 * 应用侧只有 `setShortCriticalText` 一个入口，没有 padding / gravity / 宽度参数。
 *
 * 【倒计时】
 * 1.25.0 起不再设 chronometer（做「留白是不是给倒计时预留的槽位」的对照实验），
 * 展开卡直接显示上课时刻。若实验否定该猜测，下一版把
 * `setUsesChronometer(true) + setChronometerCountDown(true)` 加回来即可，
 * 那是 SystemUI 自己按秒走的，App 只发一次，零唤醒。
 *
 * 【为什么图标必须是单色】
 * 安卓对 `setSmallIcon` **只取 alpha 通道**，颜色一律丢弃后强制着色。所以流体云
 * 最前面那个位置的校徽是单色剪影（`ic_crest_mono`，由 `scripts/make-crest-icon.py`
 * 从北邮官方校徽生成），而不是彩色徽标。
 */
final class ClassCard {

    /** 安卓 16 才有 Live Updates 的 API。用字面量：SDK 36 的 VERSION_CODES 尚未定名。 */
    static final int API_36 = 36;

    /**
     * ★ 请求提升用的 extras key（Android 16 QPR1 / API 36.1 才加进 SDK）。
     *
     * 写成字面量而不是引用常量：本地装的 `platforms;android-36` 是 rev2（Android 16 首发），
     * 里面还没有 `Notification.EXTRA_REQUEST_PROMOTED_ONGOING`，引用会编译失败。
     * 值取自官方文档，可用 `javap` 在更新过的 jar 上复核。
     */
    static final String EXTRA_REQUEST_PROMOTED_ONGOING = "android.requestPromotedOngoing";

    /** 声明在清单里的提升权限。同样因为 SDK 里没有常量，只能写字面量。 */
    static final String PERM_POST_PROMOTED = "android.permission.POST_PROMOTED_NOTIFICATIONS";

    /** 最近一次构造卡片时的自检结论，给「通知诊断」读。提升失败是静默的，不留痕就只能瞎猜。 */
    static volatile String lastVerdict = "尚未发送过通知";

    /* ---------------- 胶囊内部版式的最终结论（1.27.0 定案） ----------------
     *
     * 用户反复问「为什么校徽和文字之间空一大块」「能不能让文字贴着校徽」。
     * 1.17.0 ~ 1.26.0 一共量了六组真机截图，结论如下，**以后不必再试**：
     *
     * 【1】胶囊是「图标钉左端 + 文字钉屏中心右侧」的两点锚定版式，不是顺序排列。
     *   五次不同文案的实测，文字起点固定在「屏幕中心 + 46.5px」（1272 屏宽下是 +68px），
     *   一个字都没动过；校徽则永远贴在左内边距的位置上。
     *   所以中间那段空隙 ≈ 胶囊宽度的一半 —— 不是忘了排，是版式本身。
     *
     * 【2】空隙的**比例恒为 49%**，与内容无关。两次实测（881 屏宽）：
     *     纯倒计时「04:51」 → 胶囊 293，空隙 143（48.8%）
     *     「5分后上课」      → 胶囊 391，空隙 192（49.1%）
     *   比例一模一样，只有绝对值跟着胶囊宽度走。**唯一的可调项是字数**：
     *   字少 → 胶囊窄 → 空隙绝对值小，但永远填不满。
     *
     * 【3】能改胶囊的只有 `shortCriticalText` 一行字。`contentTitle` 试过压到 2 个字，
     *   对宽度的影响系数≈0（1.24.0 结案）；`ProgressStyle` 也试过，胶囊形态没变（1.26.0 结案）。
     *   官方 FAQ 明写不支持 CustomContentView。想让文字贴到图标后面，只有走 OPPO 的
     *   泛在服务卡片（UPK 模板 + 服务接入 SDK）那条路 —— 需要 DevStudio 工程和平台上传，
     *   与我们这个自签名离线 APK 不兼容，此路不通。
     *
     * 【4】所以定稿：折叠态 = 校徽 + `shortCriticalText`（「5分后上课」那类，4~6 字，留 1 字余量）；
     *   展开态 = 课程名 + 节次 + 系统倒计时。**不要再试图给折叠态加第二段文字。**
     */

    /* ---------------- 1.28.0 实验结案：校徽是免费资产，去掉只减分 ----------------
     *
     * 用户问「不要校徽能不能让文字居中」。这是唯一没被隔离过的变量 ——
     * 1.22~1.27 六轮改的全是**文字**，从没单独动过图标。
     * 所以 1.28.0 做了一次单变量实验：`setSmallIcon` 换全透明图（`ic_blank`），其余一字不动。
     *
     * ★★ 真机结果（2026-10-24，屏宽 881）：
     *   · 胶囊照样出现，没有退回普通通知 —— 图标不可见也不影响提升；
     *   · 但文字起点仍是 **487 = 屏幕中心 + 46.5**，跟有校徽时**一个像素都没差**；
     *   · 胶囊反而从 391 变宽到 **478**，整体还偏左 39px（左 163 / 右 240）——
     *     系统依旧按「图标位 + 文字」算宽度，只是那一格画不出东西。
     *
     * → 结论：**图标位是系统的强制占位，不是留白的成因**。
     *   去掉图标换不来居中，只会让胶囊更宽、整体更偏、左边更空，还赔上状态栏小图标。
     *   **校徽留着，它是免费的。**
     *   至此「居中 / 贴住校徽」所有可能路径全部验证完毕（文字长短、title 长度、
     *   ProgressStyle、chronometer、去掉图标），没有一条能改变锚点 —— 版式在 SystemUI 里。
     */

    /* ---------------- 折叠态用哪种形态（1.34.0 定案） ----------------
     *
     * 【为什么最终选倒计时】1.30~1.33 四版都在做「每分钟重发通知刷新文字」，
     * 真机上始终不准：ColorOS 会把刷新闹钟压后几十秒到几分钟，实测出现
     * 「剩 2:42 时胶囊还写 4分后上课」（2026-10-24 第四次反馈）。
     * ★ 结论：**只要文案是字符串，就永远要跟系统抢唤醒，而这一仗打不赢。**
     *
     * 倒计时（chronometer）交给 SystemUI 逐秒渲染，应用只发一次通知，
     * 不排任何闹钟、不要精确闹钟权限、不受 Doze 影响 —— 是唯一能保证准的方案。
     *
     * 代价：折叠态只有一个 `03:42`，没有「上课」二字（展开态仍有课程名 + 「距上课」）。
     * 而且胶囊更窄（293 vs 391px），顺带缓解了左侧留白。
     *
     * 想换回文字形态：把这里改成 false 即可，通知层会自动重新排刷新链。
     */
    static final boolean CHIP_USE_CHRONOMETER = false;

    /**
     * 是否额外用闹钟链兜底刷新（`ACTION_REFRESH`）。
     *
     * 默认 **false**：1.35.0 起由 {@link ClassRefreshService} 每 15 秒重发一次，
     * 已经足够；再叠一层闹钟只会让状态栏一直挂着闹钟图标（setAlarmClock 的副作用）。
     * 万一某台机器上前台服务起不来，把它改 true 就退回纯闹钟方案。
     */
    static final boolean REFRESH_ALARM_FALLBACK = false;

    private ClassCard() {}

    /** 本机是否具备提升到流体云的条件（版本够 + 系统当前允许）。 */
    static boolean canPromote(Context ctx) {
        if (Build.VERSION.SDK_INT < API_36) return false;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;
        try {
            return nm.canPostPromotedNotifications();
        } catch (Exception e) {
            return false;
        }
    }

    /** 清单里到底有没有声明那两条硬性条件，返回第一个缺失项，全齐返回 null。 */
    static String missingPrerequisite(Context ctx) {
        if (Build.VERSION.SDK_INT < API_36) {
            return "系统是 Android " + Build.VERSION.RELEASE + "（API " + Build.VERSION.SDK_INT
                    + "），流体云要 Android 16 起";
        }
        try {
            if (ctx.checkSelfPermission(PERM_POST_PROMOTED) != PackageManager.PERMISSION_GRANTED) {
                return "清单里缺 " + PERM_POST_PROMOTED;
            }
        } catch (Throwable ignored) {
            // 老系统没有这个权限位，忽略
        }
        return null;
    }

    /**
     * 构造提醒卡。
     *
     * @param course     课程名（展开后的标题）
     * @param periods    「第3-4节」，为空时退回默认文案
     * @param startEpoch 上课时刻（epoch 毫秒）；<=0 表示不是真实课程，走普通通知
     * @param content    点击整卡的回跳
     * @param ack        点「知道了」的撤销动作
     */
    static Notification build(
            Context ctx,
            String course,
            String periods,
            long startEpoch,
            PendingIntent content,
            PendingIntent ack) {

        String title = course == null || course.trim().isEmpty() ? "即将上课" : course.trim();
        String sub = periods == null ? "" : periods.trim();
        boolean live = startEpoch > 0;

        String missing = missingPrerequisite(ctx);
        boolean promote = live && missing == null && canPromote(ctx);

        Notification.Builder b =
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? new Notification.Builder(ctx, ReminderScheduler.CHANNEL_ID)
                        : new Notification.Builder(ctx);

        b.setSmallIcon(R.drawable.ic_crest_mono)
                .setContentTitle(title)
                .setContentText(sub)
                .setContentIntent(content)
                .setPriority(Notification.PRIORITY_HIGH)
                .setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE)
                .setCategory(Notification.CATEGORY_EVENT)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                // ★ 必须 onlyAlertOnce：胶囊文字每分钟重发一次同一张卡，
                //   不加这句就是每分钟响一次铃 + 震一次（ReminderScheduler.ACTION_REFRESH）。
                .setOnlyAlertOnce(true);

        if (!live) {
            // 测试通知等：保持可划掉的老行为
            return b.setAutoCancel(true)
                    .setStyle(new Notification.BigTextStyle().bigText(sub))
                    .build();
        }

        // 上课时刻一定要给（展开卡右侧显示），倒计时由 SystemUI 逐秒递减。
        // ★ 必须配一行 subText：光秃秃的「04:59」会被当成「四点五十九分」（真机反馈过）。
        b.setWhen(startEpoch)
                .setUsesChronometer(true)
                .setChronometerCountDown(true)
                .setSubText("距上课");

        if (ack != null) {
            b.addAction(
                    new Notification.Action.Builder(
                                    Icon.createWithResource(ctx, R.drawable.ic_notify), "知道了", ack)
                            .build());
        }

        if (promote) {
            // 常驻：Live Updates 必须是 ongoing，否则不会被提升到胶囊。
            // 代价是不能划掉 —— 所以上面必须给一个「知道了」出口。
            b.setOngoing(true);
            if (!CHIP_USE_CHRONOMETER) {
                // 折叠态那一行文字（课程名进不来，见文件头【4】）。会随闹钟刷新而滞后。
                b.setShortCriticalText(timeChipText(startEpoch));
            }
            // ★ 请求提升**只能**走 extras。
            //   FLAG_PROMOTED_ONGOING 是系统写给应用看「这条已经提升了」的标志位，
            //   应用自己 setFlag 不产生任何效果 —— 1.17.0 就是这么写错的，胶囊一直不出现。
            Bundle req = new Bundle();
            req.putBoolean(EXTRA_REQUEST_PROMOTED_ONGOING, true);
            b.addExtras(req);
        } else {
            b.setAutoCancel(true);
        }

        Notification n = b.build();
        lastVerdict = verdict(ctx, n, promote, missing);
        return n;
    }

    /**
     * 把「为什么没提升」写成一句人话。
     *
     * 系统对提升失败**完全静默**，不报错、不留日志，界面和普通通知一模一样。
     * 所以必须自己判断并留一条结论，否则线上只能盲猜。
     */
    static String verdict(Context ctx, Notification n, boolean promote, String missing) {
        if (Build.VERSION.SDK_INT < API_36) {
            return "系统 API " + Build.VERSION.SDK_INT + "，低于 36（Android 16），无法提升";
        }
        if (missing != null) return missing;
        if (!promote) {
            return "系统拒绝提升：流体云总开关或本应用开关没开"
                    + "（设置 › 通知与控制中心 › 流体云）";
        }
        boolean chars = true;
        try {
            chars = n.hasPromotableCharacteristics();
        } catch (Throwable ignored) {
            // 老一点的 Android 16 没有这个方法，当作合格
        }
        if (!chars) {
            return "通知结构不符合要求（hasPromotableCharacteristics = false）";
        }
        return "已请求提升且结构合格；若仍无胶囊，请检查流体云总开关与本应用开关";
    }

    /**
     * 胶囊折叠态那行字：**只显示还剩多久上课**，例如「5分后上课」。
     *
     * 【为什么不带课程名】
     * 这一行由 `setShortCriticalText` 独占，胶囊里**只有这一个文字槽**。1.19.0 真机验证过
     * `setContentTitle` 完全不进折叠态，安卓也没有第二个能往胶囊里写字的接口。
     * 课程名在展开态里。
     *
     * 【为什么短到 4~6 字：胶囊的留白跟字数成正比】
     * 真机实测（屏宽 1272，胶囊中心恒等于屏中心 636）：
     *   3 字「5 分钟」        → 文字 113px，胶囊 417，中间留白 238
     *   7 字「还有5分钟上课」  → 文字 185px，胶囊 685，中间留白 339
     *   5 字「5分后上课」      → 文字 186px，胶囊 565，中间留白 279
     * 三次的**文字起点完全相同**（x=703 / 704 / 704）—— 文字钉死在「屏幕中心 +68px」，
     * 字数变多只向右溢出（第 7 个字「课」就是这样被裁的），多出来的胶囊宽度**全部向左边长**
     * （左端 428 → 293 → 353），于是字数越多，左边越空。
     * 拟合胶囊宽度 ≈ 212 + 1.82 × 文字宽，**title 项系数≈0**（1.24.0 把 title 压到 2 字，
     * 窄的 120px 全部由文字短 2 字解释，与 title 无关）。
     * 所以压缩字数不是为了塞进字数上限，而是**唯一能让胶囊收窄、让留白变小的手段**。
     *
     * 【取整规则（用户 1.66.13 明确要求）】
     * 一律**向上取整**，只要还有零头分钟就进一位：
     *   剩 4:30 → 「5分钟后上课」
     *   剩 3:59 → 「4分钟后上课」
     * 这是"最晚 N 分钟后上课"的安全读法，宁可说多一点，不让人以为还早。
     *
     * 【为什么不能靠 chronometer】
     * chronometer 是系统逐秒渲染的，准，但只会显示 `04:59` 这种裸数字 ——
     * 「N分钟后上课」这句话它画不出来。所以只能由我们自己算、自己刷新，
     * 换字的时机必须精确到整分钟边界（见 ClassRefreshService#nextBoundaryDelay）。
     */
    static String timeChipText(long startEpoch) {
        long ms = startEpoch - System.currentTimeMillis();
        if (ms <= 0) return "马上上课";
        // ★★ **向上取整**（1.36.0 定案，用户明确要求）。
        //   规则：剩余 3:01 ~ 4:00 一律显示「4分后上课」，只要还有零头分钟就进一位。
        //   理由：这一行是给人做决策的，"还剩 3 分 42 秒"说成「3 分钟」会让人以为还早，
        //   说成「4 分钟」才是"最晚 4 分钟后上课"的安全读法。
        //   ★ 1.33.0 曾改成向下取整，是因为当时靠闹钟刷新、一份文案要挂 1~2 分钟，
        //     向上取整叠上滞后就会变成"胶囊写 3 分、展开卡只剩 1:55"。
        //     1.35.0 起改由 ClassRefreshService 每 15 秒重发一次，滞后上限只有 15 秒，
        //     向上取整最多偏大不到 1 分钟且很快自愈 —— 那条旧的顾虑已经不成立了。
        long mins = (ms + 59_999L) / 60_000L;
        if (mins < 60) return mins + "分钟后上课";
        return ((mins + 30) / 60) + "小时后上课"; // 小时级误差带 ±30 分钟，方向无所谓
    }
}
