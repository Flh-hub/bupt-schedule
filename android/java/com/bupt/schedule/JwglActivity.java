package com.bupt.schedule;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;

/**
 * 教务系统登录 + 抓取页（App 内 WebView）。
 *
 * 【安全边界】
 * 本界面**没有**任何自定义的账号/密码输入框：登录表单是学校页面自己的，
 * 密码直接提交给 jwgl.bupt.edu.cn。App 只做两件事：
 *   1. 登录成功后自动跳到「课表查询」；
 *   2. 用户点「抓取课表」时，把课表页及其各 frame 的 HTML 取出来带回去解析。
 * 全程不记录、不上传、不落盘任何凭据（只落盘课表 HTML）。
 */
public class JwglActivity extends Activity {

    static final String EXTRA_CAPTURE_PATH = "capture_path";
    /** auto=true 时：用已保存的凭证自动登录并抓取（「更新课表」走这条路）。 */
    static final String EXTRA_AUTO = "auto";
    /** 自动模式失败原因：bad_credentials / timeout / no_form / no_timetable */
    static final String EXTRA_ERROR = "error";

    private static final String ERR_BAD_CREDENTIALS = "bad_credentials";
    private static final String ERR_TIMEOUT = "timeout";
    private static final String ERR_NO_FORM = "no_form";
    private static final String ERR_NO_TIMETABLE = "no_timetable";
    /** 自动模式总时限：登录 + 跳课表 + 抓取，超过就认失败，别让用户干等。 */
    private static final long AUTO_DEADLINE_MS = 45000L;

    private static final String LOGIN_URL = "https://jwgl.bupt.edu.cn/jsxsd/";
    /** 不同年份的强智模板课表路径不一样，按顺序试。 */
    private static final String[] KB_URLS = {
        "https://jwgl.bupt.edu.cn/jsxsd/kbcx/kbxx_xskb",
        "https://jwgl.bupt.edu.cn/jsxsd/xskb/xskb_list.do?Ves632DSdyV=NEW_XSD_XKB",
        "https://jwgl.bupt.edu.cn/jsxsd/xskb/xskb_list.do",
        "https://jwgl.bupt.edu.cn/jsxsd/framework/xsMain_bjyddx.jsp"
    };

    private static final String PROBE_JS =
            "(function(){"
            + "function cnt(doc){var n=0;try{var ts=doc.getElementsByTagName('table');"
            + "for(var i=0;i<ts.length;i++){var t=ts[i].textContent||'';"
            + "if(((t.match(/(?:星期|周)[一二三四五六日天]/g)||[]).length)>=2)n++;}}catch(e){}return n;}"
            + "var total=0;try{total+=cnt(document);}catch(e){}"
            + "try{var fs=window.frames||[];for(var j=0;j<fs.length;j++){try{total+=cnt(fs[j].document);}catch(e){}}}catch(e){}"
            + "return total;})()";

    private WebView web;
    private TextView status;
    private TextView grabBtn;

    private String captureJs = "";
    private static final long CAPTURE_TIMEOUT_MS = 9000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean capturing = false;
    private boolean autoMode = false;
    private boolean autoTried = false;
    private boolean autoFailed = false;
    private String[] autoCreds = null;
    private boolean jumped = false;
    private boolean waitingKb = false;
    private int kbIndex = -1;
    private int probeRetry = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#1A7F5A"));
        window.setNavigationBarColor(Color.WHITE);

        autoMode = getIntent() != null && getIntent().getBooleanExtra(EXTRA_AUTO, false);
        if (autoMode) autoCreds = Credentials.load(this);

        captureJs = readAsset("native/capture.js");
        setContentView(buildUi());
        configureWebView();

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
            setStatus("继续上次的登录状态");
        } else {
            setStatus(
                    autoMode
                            ? (autoCreds == null ? "没有可用的账号，请先保存账号密码" : "正在自动登录并抓取…")
                            : "请用学号密码登录（页面是学校的，App 不接触密码）");
            web.loadUrl(LOGIN_URL);
        }

        if (autoMode) {
            if (autoCreds == null) {
                failAuto(ERR_BAD_CREDENTIALS);
                return;
            }
            handler.postDelayed(autoDeadline, AUTO_DEADLINE_MS);
        }
    }

    /** 自动模式总超时：到点还没抓到就明确失败（不猜、不无限等）。 */
    private final Runnable autoDeadline =
            new Runnable() {
                @Override
                public void run() {
                    if (!autoMode || autoFailed) return;
                    if (!isFinishing()) failAuto(ERR_TIMEOUT);
                }
            };

    /** 自动模式失败：带原因码回给网页，本地数据一点不动。 */
    private void failAuto(String code) {
        if (autoFailed) return;
        autoFailed = true;
        handler.removeCallbacks(autoDeadline);
        setResult(RESULT_CANCELED, new Intent().putExtra(EXTRA_ERROR, code));
        finish();
    }

    /* ------------------------------------------------------------ 界面 */

    private View buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#1A7F5A"));
        bar.setPadding(dp(10), dp(8), dp(10), dp(8));

        TextView back = chip("返回", Color.parseColor("#2E9E76"), Color.WHITE);
        back.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });

        TextView title = new TextView(this);
        title.setText("教务系统");
        title.setTextColor(Color.WHITE);
        title.setTextSize(16);
        title.setPadding(dp(10), 0, dp(6), 0);
        title.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView kb = chip("课表", Color.parseColor("#2E9E76"), Color.WHITE);
        kb.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                kbIndex = 0;
                loadNextKb();
            }
        });

        grabBtn = chip("抓取课表", Color.WHITE, Color.parseColor("#1A7F5A"));
        grabBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                capture();
            }
        });

        bar.addView(back);
        bar.addView(title);
        bar.addView(kb);
        bar.addView(grabBtn);

        status = new TextView(this);
        status.setTextSize(12);
        status.setTextColor(Color.parseColor("#41544B"));
        status.setBackgroundColor(Color.parseColor("#EDF6F1"));
        status.setPadding(dp(12), dp(8), dp(12), dp(8));
        status.setLineSpacing(0f, 1.2f);

        FrameLayout holder = new FrameLayout(this);
        web = new WebView(this);
        holder.addView(
                web,
                new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(status, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(holder, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        return root;
    }

    private TextView chip(String text, int bg, int fg) {
        TextView v = new TextView(this);
        v.setText(text);
        v.setTextSize(13);
        v.setTextColor(fg);
        v.setGravity(Gravity.CENTER);
        GradientDrawable d = new GradientDrawable();
        d.setColor(bg);
        d.setCornerRadius(dp(15));
        v.setBackground(d);
        v.setPadding(dp(12), dp(6), dp(12), dp(6));
        LinearLayout.LayoutParams lp =
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(6);
        v.setLayoutParams(lp);
        return v;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void setStatus(String text) {
        if (status != null) status.setText(text);
    }

    /* ------------------------------------------------------------ WebView */

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        // 抓取脚本的异步回传口（只接收抓取 JSON，不开放任何读写能力）
        web.addJavascriptInterface(new CaptureBridge(), "BuptCapture");
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // 全程留在本 WebView 里，避免丢失 CSP / JSESSIONID 登录态
            return false;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (url == null) return;
            // 只看教务系统自己的页面；外部跳转（极少）不做处理
            if (!url.startsWith("https://jwgl.bupt.edu.cn") && !url.startsWith("http://jwgl.bupt.edu.cn")) {
                return;
            }
            probeAndMaybeJump(url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request != null && request.isForMainFrame() && waitingKb) {
                loadNextKb();
            }
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
            new AlertDialog.Builder(JwglActivity.this)
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
            new AlertDialog.Builder(JwglActivity.this)
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

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
            // 强智界面里有 target=_blank 的菜单链接；不弹新窗口，也不丢登录态
            Toast.makeText(JwglActivity.this, "该链接需要在电脑上打开", Toast.LENGTH_SHORT).show();
            return false;
        }
    }

    /* ------------------------------------------------------------ 登录后跳课表 */

    private boolean isPostLoginLanding(String url) {
        if (url == null) return false;
        String u = url;
        if (u.contains("LoginToXk")) return false;
        return u.endsWith("/jsxsd/")
                || u.contains("/jsxsd/index")
                || u.contains("/jsxsd/framework/")
                || u.contains("xsMain");
    }

    private void probeAndMaybeJump(final String url) {
        web.evaluateJavascript(PROBE_JS, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                int tables = parseInt(value);
                if (tables > 0) {
                    waitingKb = false;
                    kbIndex = -1;
                    probeRetry = 0;
                    setStatus("已找到课表（" + tables + " 张表）。点右上角「抓取课表」就能导回 App。");
                    if (autoMode) capture(); // 自动更新：不等用户点，直接读
                    return;
                }

                if (waitingKb) {
                    // 课表页常是 frameset：主页的 onPageFinished 可能早于子 frame 渲染完，
                    // 直接换下一个地址会误判。这里重试两次再放弃。
                    if (probeRetry < 2) {
                        probeRetry += 1;
                        new Handler(Looper.getMainLooper())
                                .postDelayed(
                                        new Runnable() {
                                            @Override
                                            public void run() {
                                                probeAndMaybeJump(url);
                                            }
                                        },
                                        1200);
                        return;
                    }
                    probeRetry = 0;
                    loadNextKb();
                    return;
                }

                if (jumped) return;
                if (!isPostLoginLanding(url)) return;
                web.evaluateJavascript(
                        "(function(){try{return document.getElementById('userAccount')?1:0}catch(e){return 0}})()",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String hasLoginForm) {
                                if ("1".equals(String.valueOf(hasLoginForm).trim())) {
                                    if (autoMode) {
                                        // 提交过一次又回到登录页 = 账号或密码不对；不要再重试刷屏
                                        if (autoTried) {
                                            failAuto(ERR_BAD_CREDENTIALS);
                                            return;
                                        }
                                        tryAutoLogin();
                                        return;
                                    }
                                    setStatus("请用学号密码登录（页面是学校的，App 不接触密码）");
                                    return;
                                }
                                jumped = true;
                                probeRetry = 0;
                                setStatus("登录成功，正在打开课表查询…");
                                kbIndex = 0;
                                loadNextKb();
                            }
                        });
            }
        });
    }

    /**
     * 自动登录：把已保存的学号密码填进**学校自己的**登录表单并提交。
     *
     * 不写死选择器：强智模板各校字段名不一致，按"常见 id/name + type=password"逐个试。
     * 找不到表单就认失败（no_form），绝不瞎点页面上的其他按钮。
     */
    private void tryAutoLogin() {
        if (autoTried || autoCreds == null || autoCreds.length < 2) return;
        autoTried = true;
        setStatus("正在自动登录…");

        // 注意：CSS 属性选择器里用**不加引号的值**（input[name=userAccount]），
        // 这样 Java 字符串里不用写转义双引号，避免 \" 把字面量截断。
        String js =
                "(function(){"
                + "function q(sels){for(var i=0;i<sels.length;i++){var el=null;try{el=document.querySelector(sels[i]);}catch(e){}if(el)return el;}return null;}"
                + "var u=q(['#userAccount','input[name=userAccount]','#username','input[name=username]','#yhm','input[name=yhm]']);"
                + "var p=q(['#userPassword','input[type=password]','#password','input[name=password]','#mm']);"
                + "if(!u||!p)return 'no_form';"
                + "u.value=__ACC__;p.value=__PWD__;"
                + "try{u.dispatchEvent(new Event('input',{bubbles:true}));p.dispatchEvent(new Event('input',{bubbles:true}));}catch(e){}"
                + "var b=q(['#loginButton','button[type=submit]','input[type=submit]','.login-btn','#btn']);"
                + "if(b){b.click();return 'clicked';}"
                + "var f=u.form||p.form;if(f){f.submit();return 'submitted';}"
                + "return 'no_form';})()";

        js = js.replace("__ACC__", JSONObject.quote(autoCreds[0])).replace("__PWD__", JSONObject.quote(autoCreds[1]));

        web.evaluateJavascript(js, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                String r = String.valueOf(value);
                if (r.contains("no_form")) {
                    failAuto(ERR_NO_FORM);
                    return;
                }
                setStatus("已提交登录，正在等课表页…");
            }
        });
    }

    private static int parseInt(String value) {
        try {
            return Integer.parseInt(String.valueOf(value).trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private void loadNextKb() {
        if (kbIndex < 0) kbIndex = 0;
        if (kbIndex >= KB_URLS.length) {
            waitingKb = false;
            kbIndex = -1;
            if (autoMode) {
                failAuto(ERR_NO_TIMETABLE);
                return;
            }
            setStatus("没能自动打开课表页。请用左侧菜单进入「课表查询」，看到课表后点右上角「抓取课表」。");
            return;
        }
        waitingKb = true;
        probeRetry = 0;
        String url = KB_URLS[kbIndex];
        kbIndex += 1;
        setStatus("正在打开课表查询…（" + kbIndex + "/" + KB_URLS.length + "）");
        web.loadUrl(url);
    }

    /* ------------------------------------------------------------ 抓取 */

    /**
     * 抓取入口。
     *
     * 优先走**异步**脚本 `window.__buptCapture()`：它除了收课表 HTML，
     * 还会同源 fetch 一次学生首页，把「当前第 N 周」一并带回来（用于反推开学日），
     * 完事通过 {@link CaptureBridge#deliver} 回调。3 秒内必有结果（脚本内部兜底）。
     *
     * 老脚本 / 异常时退回**同步**路径：直接取脚本返回值（没有首页信号，但课表照抓）。
     */
    private void capture() {
        if (capturing) return;
        capturing = true;
        setStatus("正在读取课表页面（含当前周次）…");
        grabBtn.setEnabled(false);

        handler.postDelayed(captureTimeout, CAPTURE_TIMEOUT_MS);

        // ★ 先注入脚本再问它有没有异步入口：
        //   以前是"先问 __buptCapture 在不在"——脚本根本没执行过，永远是 sync 路径，
        //   于是永远取不到周次/周历信号（自动导入识别不出起始周的真正原因）。
        web.evaluateJavascript(captureJs, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String syncValue) {
                final String syncJson = unwrapJsString(syncValue);
                web.evaluateJavascript(
                        "(function(){try{if(typeof window.__buptCapture==='function'){window.__buptCapture();return 'async';}}catch(e){}return 'sync';})()",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String mode) {
                                if ("\"async\"".equals(String.valueOf(mode))) return; // 等 Bridge 回调
                                onCaptureDelivered(syncJson); // 老脚本兜底：没有周次信号，但课表照抓
                            }
                        });
            }
        });
    }

    /** 异步脚本回传的 JSON（已经是裸字符串，不需要再解一层）。 */
    private void onCaptureDelivered(String json) {
        if (!capturing) return; // 已超时或已处理过
        handler.removeCallbacks(captureTimeout);
        handler.removeCallbacks(autoDeadline);
        capturing = false;
        grabBtn.setEnabled(true);

        if (json == null || json.length() < 20 || !json.contains("\"candidates\"")) {
            setStatus("没读到课表内容。请先进入「课表查询」页面（能看到整周课表），再点抓取。");
            Toast.makeText(JwglActivity.this, "没有可抓取的课表", Toast.LENGTH_SHORT).show();
            return;
        }

        File out = new File(getCacheDir(), "jwgl-capture.json");
        try {
            FileOutputStream fos = new FileOutputStream(out);
            fos.write(json.getBytes(Charset.forName("UTF-8")));
            fos.close();
        } catch (IOException e) {
            setStatus("写入抓取结果失败：" + e.getMessage());
            return;
        }

        Intent data = new Intent();
        data.putExtra(EXTRA_CAPTURE_PATH, out.getAbsolutePath());
        setResult(RESULT_OK, data);
        finish();
    }

    /** evaluateJavascript 返回的是「JSON 编码后的字符串」，这里还原成裸 JSON。 */
    private static String unwrapJsString(String value) {
        try {
            Object parsed = new JSONTokener(String.valueOf(value)).nextValue();
            if (parsed instanceof String) return (String) parsed;
        } catch (Exception ignored) {
            // 落到下面返回 null
        }
        return null;
    }

    /** 抓取脚本回调进来的入口（Android 侧线程）。 */
    private class CaptureBridge {
        @JavascriptInterface
        public void deliver(final String json) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    onCaptureDelivered(json);
                }
            });
        }
    }

    private final Runnable captureTimeout =
            new Runnable() {
                @Override
                public void run() {
                    if (!capturing) return;
                    capturing = false;
                    grabBtn.setEnabled(true);
                    setStatus("读取超时了。请确认已经看到整周课表，再点一次「抓取课表」。");
                }
            };

    /* ------------------------------------------------------------ 杂项 */

    private String readAsset(String path) {
        try {
            InputStream in = getAssets().open(path);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            return new String(out.toByteArray(), Charset.forName("UTF-8"));
        } catch (IOException e) {
            return "";
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.setWebChromeClient(null);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
