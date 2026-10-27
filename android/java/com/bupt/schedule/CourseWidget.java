package com.bupt.schedule;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 桌面小组件：显示「今天还剩哪几节课」。
 *
 * 【为什么不是 ColorOS 的「我的服务」卡片】
 * 那种卡片属于 OPPO 泛在服务（UPK），授权码/意图/服务ID 要人工申请、必须用官方模板，
 * 个人开发者 sideload 的 APK 进不去。App Widget 是 Android 自带的开放能力，
 * 任何安装的 APK 都能带，桌面「小组件」列表里直接就能加。
 *
 * 【数据从哪来】
 * 小组件跑不了 JS、读不到 localStorage，所以网页侧（{@code src/widget.js}）把
 * 接下来 14 天每天有什么课算好，通过 {@code BuptNative.syncWidget(json)} 交过来，
 * 这里存进 SharedPreferences 并立刻重绘。
 *
 * 【为什么存 14 天而不是只存今天】
 * 系统对小组件的唤醒最短间隔就是 30 分钟，而且用户可能好几天不开应用。
 * 只存今天的话，第二天小组件就会理直气壮地显示昨天的课 —— 那是比空白更糟的错误。
 * 存一个窗口，渲染时按"今天"自己挑；超出窗口才提示"数据旧了"。
 *
 * ★ 一天的取舍规则（调课/放假/补班）全部由网页侧的 calendar.resolveDay 决定，
 *   这里只做展示，绝不重新判断"这天有没有课"。
 */
public class CourseWidget extends AppWidgetProvider {

    /** 小组件自己的偏好文件，和网页的 localStorage、提醒的 prefs 都不共用。 */
    static final String PREFS = "bupt_widget";
    private static final String KEY_PAYLOAD = "payload";

    /** 最多画几行：再高的小组件也没必要，用户不如直接打开应用。 */
    private static final int MAX_ROWS = 5;

    /** 单行高度（dp），与 widget_row.xml 的 32dp 对齐。 */
    private static final int ROW_DP = 32;

    /**
     * 除课程行以外的固定占用：标题栏 26dp + 上下内边距 8+8dp = 42dp。
     *
     * ★ 不要再加"安全余量"。之前留了 6dp，结果 110dp 的 2 行小组件只能算出 1 行
     *   （(110-48)/32 = 1），白白浪费一半高度。
     */
    private static final int CHROME_DP = 42;

    /* ------------------------------------------------------------ 生命周期 */

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        if (ctx == null || mgr == null || ids == null) return;
        String raw = load(ctx);
        for (int id : ids) safeRender(ctx, mgr, id, raw);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle options) {
        // 用户拖动了大小：行数要跟着变，否则会留一块空白
        safeRender(ctx, mgr, id, load(ctx));
    }

    /* ------------------------------------------------------------ 对外：网页同步 */

    /** 网页把新数据交过来：存盘 + 立刻重绘所有实例。 */
    static void syncAll(Context ctx, String json) {
        if (ctx == null) return;
        save(ctx, json);
        refreshAll(ctx, json);
    }

    /** 用已存的数据重绘全部实例（闹钟到点时也会调，用来刷新"已上完"的淡化状态）。 */
    static void refreshAll(Context ctx) {
        refreshAll(ctx, load(ctx));
    }

    static void refreshAll(Context ctx, String raw) {
        if (ctx == null) return;
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, CourseWidget.class));
            if (ids == null) return;
            for (int id : ids) safeRender(ctx, mgr, id, raw);
        } catch (Throwable ignored) {
            // 桌面进程异常不该影响应用本身
        }
    }

    private static void save(Context ctx, String json) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (json == null || json.length() == 0) sp.edit().remove(KEY_PAYLOAD).apply();
            else sp.edit().putString(KEY_PAYLOAD, json).apply();
        } catch (Throwable ignored) {
        }
    }

    private static String load(Context ctx) {
        try {
            return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PAYLOAD, "");
        } catch (Throwable t) {
            return "";
        }
    }

    /* ------------------------------------------------------------ 渲染 */

    /**
     * 任何一步抛异常都要退化成"打开应用"卡片——绝不能让小组件变成系统错误块。
     *
     * 三层：正常渲染 → 空状态卡 → **极简卡（只有一个 TextView）**。
     * 最后一层存在的理由：RemoteViews 的 apply 失败发生在**桌面进程**，
     * 我们这边 catch 不到；但布局越简单，桌面越不可能不认。
     */
    private static void safeRender(Context ctx, AppWidgetManager mgr, int widgetId, String raw) {
        RemoteViews rv;
        try {
            rv = build(ctx, widgetId, raw);
        } catch (Throwable t) {
            try {
                rv = fallback(ctx);
            } catch (Throwable inner) {
                try {
                    rv = minimal(ctx);
                } catch (Throwable last) {
                    return;
                }
            }
        }
        try {
            mgr.updateAppWidget(widgetId, rv);
        } catch (Throwable ignored) {
        }
    }

    private static RemoteViews build(Context ctx, int widgetId, String raw) {
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_course);
        rv.removeAllViews(R.id.w_rows);
        rv.setOnClickPendingIntent(R.id.w_root, openApp(ctx));

        JSONObject root = readRoot(raw);
        if (root == null) {
            return notice(ctx, rv, ctx.getString(R.string.widget_empty_title), "",
                    ctx.getString(R.string.widget_empty_hint));
        }

        JSONObject day = findDay(root.optJSONArray("days"), today());
        if (day == null) {
            // 存的数据里没有"今天" —— 说明 App 已经两周以上没打开过了
            return notice(ctx, rv, ctx.getString(R.string.widget_stale_title), "",
                    ctx.getString(R.string.widget_stale_hint));
        }

        String date = str(day, "date");
        String monthDay = str(day, "monthDay");
        String weekday = str(day, "weekday");
        boolean complete = day.optBoolean("complete", false);
        // ★ 必须走 str()：普通日子这个字段是 JSON null，裸 optString 会得到字符串 "null"
        String holidayName = str(day, "holidayName");
        JSONArray courses = day.optJSONArray("courses");
        int total = courses == null ? 0 : courses.length();

        // 2 列的小组件只有 110dp 宽，减掉内边距只剩 90dp ——
        // 「今天 · 10月26日」放不下会截成「今天 · 10月…」，不如只留「今天」。
        int wDp = widgetWidthDp(ctx, widgetId);
        boolean narrow = wDp > 0 && wDp < 150;
        String head = narrow
                ? relativeLabel(date, weekday)
                : joinDot(relativeLabel(date, weekday), monthDay);

        // 「补班日到底上不上课」没确认时不展示课程：宁可让用户去确认，也不能给错的课表
        if (!complete) {
            return notice(ctx, rv, head, "", ctx.getString(R.string.widget_pending));
        }
        if (total == 0) {
            String badge = TextUtils.isEmpty(holidayName)
                    ? ctx.getString(R.string.widget_rest)
                    : ctx.getString(R.string.widget_holiday, holidayName);
            return notice(ctx, rv, head, badge, ctx.getString(R.string.widget_no_course));
        }

        // 只有"今天"才淡化已上完的课；看未来几天时不该有任何一行是灰的
        int nowMin = offsetOf(date) == 0 ? nowMinutes() : -1;

        // 今天的课全上完了 → 不再列清单，给一句收工的话（和 App 首页今日卡片同一句）
        if (nowMin >= 0 && allDone(courses, nowMin)) {
            return notice(ctx, rv, head, ctx.getString(R.string.widget_count, total),
                    ctx.getString(R.string.widget_daily_done));
        }

        rv.setTextViewText(R.id.w_head, head);
        rv.setTextViewText(R.id.w_badge, ctx.getString(R.string.widget_count, total));
        rv.setViewVisibility(R.id.w_badge, View.VISIBLE);
        rv.setViewVisibility(R.id.w_rows, View.VISIBLE);
        rv.setViewVisibility(R.id.w_empty, View.GONE);

        List<JSONObject> picked = pick(courses, rowBudget(ctx, widgetId), nowMin);
        for (int i = 0; i < picked.size(); i += 1) {
            rv.addView(R.id.w_rows, buildRow(ctx, picked.get(i), nowMin));
        }
        return rv;
    }

    /** 一行课：色条 + 开始时间 + 课名 / 地点 · 节次。 */
    private static RemoteViews buildRow(Context ctx, JSONObject c, int nowMinutes) {
        RemoteViews row = new RemoteViews(ctx.getPackageName(), R.layout.widget_row);

        // 这几个字段网页侧保证是字符串，但仍走 str()：一个 null 漏进来就会在桌面印出 "null"
        String name = str(c, "name");
        String room = str(c, "room");
        String start = str(c, "start");
        String end = str(c, "end");
        String periods = str(c, "periods");
        String color = str(c, "color");

        row.setTextViewText(R.id.w_row_name, name);

        // 第二行 = 时间 · 地点 · 节次。时间单独一个 TextView（窄屏时会被截断而不是挤掉课名），
        // 后面的内容带一个「·」分隔，两者拼起来才读得通。
        String sub = joinDot(room, periods);
        if (sub.length() == 0 && start.length() > 0 && end.length() > 0) sub = start + "-" + end;
        String tail = (start.length() > 0 && sub.length() > 0) ? " · " + sub : sub;

        row.setTextViewText(R.id.w_row_time, start);
        row.setTextViewText(R.id.w_row_sub, tail);
        row.setViewVisibility(R.id.w_row_sub, tail.length() == 0 ? View.GONE : View.VISIBLE);

        int bar;
        try {
            bar = Color.parseColor(color);
        } catch (Throwable t) {
            bar = ctx.getColor(R.color.widget_bar);
        }
        row.setInt(R.id.w_row_bar, "setBackgroundColor", bar);

        // 已经上完的课淡化到 35%：一眼能看出"上午结束了"
        float alpha = 1f;
        if (nowMinutes >= 0 && end.length() == 5) {
            int endMin = minutesOf(end);
            if (endMin > 0 && endMin <= nowMinutes) alpha = 0.35f;
        }
        row.setFloat(R.id.w_row, "setAlpha", alpha);
        return row;
    }

    /** 空态 / 提示卡片：只留标题行和一句说明。 */
    private static RemoteViews notice(Context ctx, RemoteViews rv, String head, String badge, String body) {
        rv.setTextViewText(R.id.w_head, head);
        if (TextUtils.isEmpty(badge)) {
            rv.setViewVisibility(R.id.w_badge, View.GONE);
        } else {
            rv.setTextViewText(R.id.w_badge, badge);
            rv.setViewVisibility(R.id.w_badge, View.VISIBLE);
        }
        rv.setViewVisibility(R.id.w_rows, View.GONE);
        rv.setViewVisibility(R.id.w_empty, View.VISIBLE);
        rv.setTextViewText(R.id.w_empty, body);
        return rv;
    }

    /** 极简兜底：布局里只有一个 TextView，桌面不可能 inflate 失败。 */
    private static RemoteViews minimal(Context ctx) {
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_min);
        try {
            rv.setTextViewText(R.id.w_min_text, ctx.getString(R.string.widget_empty_title));
        } catch (Throwable ignored) {
            // 连字符串都取不到就留布局里的默认文字
        }
        return rv;
    }

    private static RemoteViews fallback(Context ctx) {
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_course);
        rv.setOnClickPendingIntent(R.id.w_root, openApp(ctx));
        return notice(ctx, rv, ctx.getString(R.string.widget_empty_title), "",
                ctx.getString(R.string.widget_empty_hint));
    }

    /* ------------------------------------------------------------ 小工具 */

    /**
     * 读一个「可能为 null」的字符串字段，null 一律当空串。
     *
     * ★★ 不能直接 `obj.optString(key, "")`。org.json 的 optString 在值为 JSON null 时
     *   返回字符串 **"null"**（它把 JSONObject.NULL 交给 JSON.toString 就得到 "null"），
     *   fallback 只在键**不存在**时才生效。网页侧 `widget.js` 的契约是
     *   `holidayName: string|null`，于是普通日子会传 `"holidayName": null`，
     *   原样读出来就是 "null"，再拼进 `widget_holiday` 格式串 ——
     *   真机上小组件右上角就显示了「**null · 放假**」（2026-10-24 用户截图）。
     */
    private static String str(JSONObject o, String key) {
        if (o == null || o.isNull(key)) return "";
        String v = o.optString(key, "");
        return "null".equals(v) ? "" : v;
    }

    private static JSONObject readRoot(String raw) {
        if (raw == null || raw.length() == 0) return null;
        try {
            return new JSONObject(raw);
        } catch (Throwable t) {
            return null;
        }
    }

    private static JSONObject findDay(JSONArray days, String date) {
        if (days == null) return null;
        for (int i = 0; i < days.length(); i += 1) {
            JSONObject d = days.optJSONObject(i);
            if (d != null && date.equals(str(d, "date"))) return d;
        }
        return null;
    }

    /**
     * 行数预算：按小组件实际高度算，向下取整。
     *
     * 拿不到尺寸时给满（MAX_ROWS）——宁可多画几行被裁掉，也不要一上来就只显示 1 行。
     */
    /** 小组件当前宽度（dp）；读不到返回 0。用来决定头部要不要省略日期。 */
    private static int widgetWidthDp(Context ctx, int widgetId) {
        try {
            Bundle o = AppWidgetManager.getInstance(ctx).getAppWidgetOptions(widgetId);
            if (o == null) return 0;
            int w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0);
            if (w <= 0) w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
            return w;
        } catch (Throwable t) {
            return 0;
        }
    }

    private static int rowBudget(Context ctx, int widgetId) {
        int hDp = 0;
        try {
            Bundle o = AppWidgetManager.getInstance(ctx).getAppWidgetOptions(widgetId);
            if (o != null) {
                hDp = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
                if (hDp <= 0) hDp = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
            }
        } catch (Throwable ignored) {
        }
        if (hDp <= 0) return MAX_ROWS;
        int rows = (hDp - CHROME_DP) / ROW_DP;
        if (rows < 1) rows = 1;
        if (rows > MAX_ROWS) rows = MAX_ROWS;
        return rows;
    }

    /**
     * 今天的课是不是**全都上完了**。
     *
     * 不能只看"还有没有剩余课程"：正在上的那节也不算剩余，但它显然不算结束。
     * 这里按「每节课都有结束时间、且最晚的结束时间已经过去」判断，
     * 跨午夜的课（end 比 start 小）一律算没完 —— 它真正结束是在第二天。
     */
    private static boolean allDone(JSONArray courses, int nowMin) {
        if (courses == null || courses.length() == 0) return false;
        int last = -1;
        for (int i = 0; i < courses.length(); i += 1) {
            JSONObject c = courses.optJSONObject(i);
            if (c == null) continue;
            String start = str(c, "start");
            String end = str(c, "end");
            if (start.length() != 5 || end.length() != 5) return false;
            if (end.compareTo(start) < 0) return false;
            int endMin = minutesOf(end);
            if (endMin < 0) return false;
            if (endMin > last) last = endMin;
        }
        return last >= 0 && nowMin >= last;
    }

    private static List<JSONObject> pick(JSONArray courses, int budget, int nowMinutes) {
        List<JSONObject> all = new ArrayList<JSONObject>();
        if (courses != null) {
            for (int i = 0; i < courses.length(); i += 1) {
                JSONObject c = courses.optJSONObject(i);
                if (c != null) all.add(c);
            }
        }
        int limit = Math.max(1, Math.min(MAX_ROWS, budget));
        if (all.size() <= limit) return all;

        // 行数不够时先丢已经上完的：正在上/还没上的课对用户才有意义
        List<JSONObject> live = new ArrayList<JSONObject>();
        List<JSONObject> gone = new ArrayList<JSONObject>();
        for (int i = 0; i < all.size(); i += 1) {
            JSONObject c = all.get(i);
            String end = str(c, "end");
            int endMin = end.length() == 5 ? minutesOf(end) : -1;
            if (nowMinutes >= 0 && endMin > 0 && endMin <= nowMinutes) gone.add(c);
            else live.add(c);
        }
        List<JSONObject> out = new ArrayList<JSONObject>();
        for (int i = 0; i < live.size() && out.size() < limit; i += 1) out.add(live.get(i));
        for (int i = 0; i < gone.size() && out.size() < limit; i += 1) out.add(gone.get(i));
        return out;
    }

    private static String joinDot(String a, String b) {
        String x = a == null ? "" : a.trim();
        String y = b == null ? "" : b.trim();
        if (x.length() == 0) return y;
        if (y.length() == 0) return x;
        return x + " · " + y;
    }

    /** 「今天 / 明天 / 后天 / 周X」—— 三天以内用相对说法，更远的日子直接给星期。 */
    private static String relativeLabel(String date, String weekday) {
        int offset = offsetOf(date);
        if (offset == 0) return "今天";
        if (offset == 1) return "明天";
        if (offset == 2) return "后天";
        return TextUtils.isEmpty(weekday) ? date : weekday;
    }

    /** date 距今天几天（负数 = 过去）。解析失败返回 -999，走"星期几"分支。 */
    private static int offsetOf(String date) {
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            f.setLenient(false);
            Date d = f.parse(date);
            Date t = f.parse(today());
            if (d == null || t == null) return -999;
            return (int) Math.round((d.getTime() - t.getTime()) / 86400000.0);
        } catch (Throwable e) {
            return -999;
        }
    }

    private static String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    private static int nowMinutes() {
        Calendar c = Calendar.getInstance();
        return c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE);
    }

    private static int minutesOf(String hhmm) {
        try {
            int h = Integer.parseInt(hhmm.substring(0, 2));
            int m = Integer.parseInt(hhmm.substring(3, 5));
            return h * 60 + m;
        } catch (Throwable t) {
            return -1;
        }
    }

    private static PendingIntent openApp(Context ctx) {
        Intent it = new Intent(ctx, MainActivity.class);
        // singleTask + CLEAR_TOP：从桌面点进来回到原来的页面栈，而不是又开一个
        it.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(ctx, 0, it,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
