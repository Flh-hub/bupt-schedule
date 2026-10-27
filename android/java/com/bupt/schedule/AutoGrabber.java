package com.bupt.schedule;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;

/**
 * AutoGrabber —— 「给了学号密码，就把课表抓回来」的后台引擎。
 *
 * 【和 JwglActivity 的分工】
 * JwglActivity 是**看得见**的登录窗口（用户自己操作，验证码 / 学校改版时用它兜底）；
 * 本类是**看不见**的：它自己在后台开一个 1×1 的 WebView，跑完整条
 * 「打开登录页 → 填表提交 → 找到课表页 → 读取 HTML」，全程只把**进度**报给网页层。
 * 用户在 App 里看到的是自己的课表界面和一根进度条，不会看到学校页面跳来跳去。
 *
 * 【为什么必须真的跑一个 WebView】
 * 强智 jsxsd 的登录是表单 POST + JSESSIONID，课表页还有 frameset 和 JS 渲染。
 * 用 OkHttp 手搓请求要复刻加密、跳转与 cookie 链，学校一改就全废；
 * 而 WebView 就是用户自己的浏览器，学校怎么改它都跟得上。
 *
 * 【三条硬约束】
 * ① **必须 attach 到窗口**：游离的 WebView 在部分 ROM 上不执行 JS。
 *    做法是塞进一个 1×1 的容器、alpha=0——看得见的是"没有"，跑得动的是"有"。
 * ② **每次新建、用完销毁**：不复用 cookie，避免换个账号还登着上一个人的态。
 * ③ **任何失败都要有结论**：超时、连不上、验证码、找不到表单、找不到课表，
 *    一律回调 onError(code) 并且**不动本地数据**，绝不无限转圈。
 */
public final class AutoGrabber {

    /** 进度 / 结果 / 失败的回调（都在主线程）。 */
    public interface Listener {
        void onProgress(String id, String step, int percent, String text);

        void onResult(String id, String json);

        void onError(String id, String code, String detail);
    }

    /* ------------------------------------------------------------ 失败码（与 src/grab.js 一一对应） */

    static final String ERR_NO_NETWORK = "no_network";
    static final String ERR_BAD_CREDENTIALS = "bad_credentials";
    static final String ERR_CAPTCHA = "captcha";
    static final String ERR_NO_FORM = "no_form";
    static final String ERR_NO_TIMETABLE = "no_timetable";
    static final String ERR_TIMEOUT = "timeout";
    static final String ERR_READ_FAILED = "read_failed";
    static final String ERR_CANCELLED = "cancelled";
    static final String ERR_BUSY = "busy";

    private static final String LOGIN_URL = "https://jwgl.bupt.edu.cn/jsxsd/";
    /** 不同年份的强智模板课表路径不一样，按顺序试。 */
    private static final String[] KB_URLS = {
        "https://jwgl.bupt.edu.cn/jsxsd/kbcx/kbxx_xskb",
        "https://jwgl.bupt.edu.cn/jsxsd/xskb/xskb_list.do?Ves632DSdyV=NEW_XSD_XKB",
        "https://jwgl.bupt.edu.cn/jsxsd/xskb/xskb_list.do",
        "https://jwgl.bupt.edu.cn/jsxsd/framework/xsMain_bjyddx.jsp"
    };

    /** 数「看起来像课表的 table」有几张（周一到周日出现 ≥2 次才算）。 */
    private static final String PROBE_JS =
            "(function(){"
            + "function cnt(doc){var n=0;try{var ts=doc.getElementsByTagName('table');"
            + "for(var i=0;i<ts.length;i++){var t=ts[i].textContent||'';"
            + "if(((t.match(/(?:星期|周)[一二三四五六日天]/g)||[]).length)>=2)n++;}}catch(e){}return n;}"
            + "var total=0;try{total+=cnt(document);}catch(e){}"
            + "try{var fs=window.frames||[];for(var j=0;j<fs.length;j++){try{total+=cnt(fs[j].document);}catch(e){}}}catch(e){}"
            + "return total;})()";

    /** 登录页是否有可填的表单（没表单 = 已登录，或页面改版）。 */
    private static final String FORM_JS =
            "(function(){try{"
            + "var u=document.querySelector('#userAccount')||document.querySelector('input[type=password]');"
            + "return u?1:0;}catch(e){return 0}})()";

    /** 登录页是否带验证码（只在"提交过又回到登录页"时才问，避免误判把自动登录一棍子打死）。 */
    private static final String CAPTCHA_JS =
            "(function(){try{"
            + "var sels=['#captcha','input[name=RANDOMCODE]','input[name=verifyCode]',"
            + "'input[name=checkCode]','input[id*=yzm]','img[src*=captcha]','img[src*=kaptcha]','img[id*=captcha]'];"
            + "for(var i=0;i<sels.length;i++){try{if(document.querySelector(sels[i]))return 1;}catch(e){}}"
            + "return 0;}catch(e){return 0}})()";

    /** 登录 + 抓取的硬超时：到点就认输，别让用户盯着进度条等。 */
    private static final long DEADLINE_MS = 60000L;
    private static final long CAPTURE_TIMEOUT_MS = 12000L;

    private final Activity host;
    private final ViewGroup container;
    private final Listener listener;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private WebView web;
    private String taskId = "";
    private String[] creds;
    private String captureJs = "";

    private boolean running = false;
    private boolean loginSubmitted = false;
    private boolean kbJumped = false;
    private boolean waitingKb = false;
    private boolean capturing = false;
    private int kbIndex = -1;
    private int probeAttempt = 0;

    public AutoGrabber(Activity host, ViewGroup container, Listener listener) {
        this.host = host;
        this.container = container;
        this.listener = listener;
        try {
            this.captureJs = readAsset("native/capture.js");
        } catch (Exception e) {
            this.captureJs = "";
        }
    }

    public boolean isRunning() {
        return running;
    }

    /* ------------------------------------------------------------ 入口 */

    /**
     * 开始一次抓取。
     *
     * @param id 任务号（原生会原样带回，网页据此丢弃上一次的迟到事件）
     * @param account 学号
     * @param password 密码；**传空串表示用已保存的那份**（网页永远读不到明文密码）
     * @return 是否真的开始了
     */
    public boolean start(String id, String account, String password) {
        if (running) {
            if (listener != null) listener.onError(String.valueOf(id), ERR_BUSY, "上一次抓取还没结束");
            return false;
        }

        String acc = String.valueOf(account == null ? "" : account).trim();
        String pwd = String.valueOf(password == null ? "" : password);

        // 网页没给密码（用户只填了学号，或压根没填）→ 用 Keystore 里存着的那份
        if (pwd.length() == 0) {
            String[] saved = Credentials.load(host);
            if (saved != null && (acc.length() == 0 || acc.equals(saved[0]))) {
                acc = saved[0];
                pwd = saved[1];
            }
        }
        if (acc.length() == 0 || pwd.length() == 0) {
            if (listener != null) listener.onError(String.valueOf(id), ERR_BAD_CREDENTIALS, "缺少学号或密码");
            return false;
        }

        taskId = String.valueOf(id == null ? "" : id);
        creds = new String[] {acc, pwd};
        running = true;
        loginSubmitted = false;
        kbJumped = false;
        waitingKb = false;
        capturing = false;
        kbIndex = -1;
        probeAttempt = 0;

        if (!buildHiddenWebView()) {
            fail(ERR_NO_FORM, "无法创建后台浏览器");
            return false;
        }

        emit("connect", 4, "正在连接教务系统…");
        handler.postDelayed(deadline, DEADLINE_MS);
        web.loadUrl(LOGIN_URL);
        return true;
    }

    /** 用户点了「取消」：立刻停，并给一个明确的终态。 */
    public void cancel() {
        if (!running) return;
        String id = taskId;
        cleanup();
        if (listener != null) listener.onError(id, ERR_CANCELLED, "");
    }

    /* ------------------------------------------------------------ 隐藏 WebView */

    private boolean buildHiddenWebView() {
        try {
            WebView w = new WebView(host);
            WebSettings s = w.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setDatabaseEnabled(true);
            s.setUseWideViewPort(true);
            s.setLoadWithOverviewMode(true);
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
            s.setSupportMultipleWindows(false);
            s.setJavaScriptCanOpenWindowsAutomatically(false);
            s.setCacheMode(WebSettings.LOAD_DEFAULT);
            s.setUserAgentString(s.getUserAgentString() + " BUPT-Schedule-Grabber");

            w.setWebViewClient(new Client());
            w.setWebChromeClient(new Chrome());
            // 抓取脚本里 __buptCapture() 的异步回传口（只收课表 JSON）
            w.addJavascriptInterface(new Bridge(), "BuptCapture");

            // ★ 1×1 + alpha 0：看得见的是"没有"，但它是真的在窗口里，JS 照常跑
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(1, 1);
            w.setAlpha(0f);
            w.setEnabled(false);
            w.setFocusable(false);
            container.addView(w, lp);
            web = w;
            return true;
        } catch (Exception e) {
            web = null;
            return false;
        }
    }

    private class Client extends WebViewClient {
        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (url == null) return;
            if (!isSchoolUrl(url)) return;
            probe(url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (!running) return;
            if (request == null || !request.isForMainFrame()) return;
            int code = error == null ? 0 : error.getErrorCode();
            if (isNetworkDown(code)) {
                // 最常见的一种失败：教务系统只在内网解析，公网根本连不上
                fail(ERR_NO_NETWORK, "errorCode=" + code);
                return;
            }
            if (waitingKb) loadNextKb(); // 这个课表地址打不开，试下一个
        }
    }

    /** 浏览器从内层抛出来的原生弹窗一律不弹（后台窗口弹了会挡住用户的课表界面）。 */
    private class Chrome extends WebChromeClient {
        @Override
        public boolean onJsAlert(WebView view, String url, String message, android.webkit.JsResult result) {
            result.confirm();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, android.webkit.JsResult result) {
            result.cancel();
            return true;
        }
    }

    private class Bridge {
        @JavascriptInterface
        public void deliver(final String json) {
            handler.post(new Runnable() {
                @Override
                public void run() {
                    onCaptureDelivered(json);
                }
            });
        }
    }

    private static boolean isSchoolUrl(String url) {
        return url.startsWith("https://jwgl.bupt.edu.cn") || url.startsWith("http://jwgl.bupt.edu.cn");
    }

    /** 这些错误码基本等于"根本没连上"，和"页面 404"要分开报。 */
    private static boolean isNetworkDown(int code) {
        return code == WebViewClient.ERROR_HOST_LOOKUP
                || code == WebViewClient.ERROR_CONNECT
                || code == WebViewClient.ERROR_TIMEOUT
                || code == WebViewClient.ERROR_IO
                || code == WebViewClient.ERROR_UNKNOWN;
    }

    /* ------------------------------------------------------------ 状态机 */

    private void probe(final String url) {
        if (!running || web == null) return;
        web.evaluateJavascript(PROBE_JS, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if (!running) return;
                int tables = toInt(value);
                if (tables > 0) {
                    waitingKb = false;
                    kbIndex = -1;
                    probeAttempt = 0;
                    emit("find", 56, "找到课表了，正在读取…");
                    capture();
                    return;
                }

                if (waitingKb) {
                    // 课表页常是 frameset：主页的 onPageFinished 可能早于子 frame 渲染完
                    if (probeAttempt < 2) {
                        probeAttempt += 1;
                        handler.postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                probe(url);
                            }
                        }, 1200);
                        return;
                    }
                    probeAttempt = 0;
                    loadNextKb();
                    return;
                }

                if (kbJumped) return;

                web.evaluateJavascript(FORM_JS, new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String hasForm) {
                        if (!running) return;
                        boolean loginPage = "1".equals(String.valueOf(hasForm).trim());
                        if (loginPage) {
                            if (loginSubmitted) {
                                // 提交过又回到登录页：先看是不是验证码挡的，再怪账号密码
                                explainLoginRejection();
                                return;
                            }
                            emit("login", 14, "正在填写登录信息…");
                            tryLogin();
                            return;
                        }
                        // 没有登录表单 = 已经登录了
                        kbJumped = true;
                        probeAttempt = 0;
                        emit("find", 36, "登录成功，正在打开课表…");
                        kbIndex = 0;
                        loadNextKb();
                    }
                });
            }
        });
    }

    /**
     * 自动填表提交。**不写死选择器**：强智各校字段名不统一，按"常见 id/name + type=password"逐个试；
     * 找不到就认 no_form，绝不瞎点页面上的其它按钮。
     */
    private void tryLogin() {
        if (web == null || creds == null) return;
        loginSubmitted = true;

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

        // ★ 用 JSONObject.quote 转义：密码里出现引号 / 反斜杠时，裸拼字符串会把 JS 打断
        js = js.replace("__ACC__", JSONObject.quote(creds[0])).replace("__PWD__", JSONObject.quote(creds[1]));

        emit("login", 20, "正在登录…");
        web.evaluateJavascript(js, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                String r = String.valueOf(value);
                if (r.contains("no_form")) {
                    fail(ERR_NO_FORM, "登录表单选择器全部未命中");
                    return;
                }
                emit("login", 28, "已提交登录，正在等课表页…");
            }
        });
    }

    /** 登录被退回：先排查验证码（这是唯一"看起来像密码错"但其实不是的情况）。 */
    private void explainLoginRejection() {
        if (web == null) return;
        web.evaluateJavascript(CAPTCHA_JS, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                boolean hasCaptcha = "1".equals(String.valueOf(value).trim());
                fail(hasCaptcha ? ERR_CAPTCHA : ERR_BAD_CREDENTIALS, hasCaptcha ? "登录页含验证码元素" : "提交后回到登录页");
            }
        });
    }

    private void loadNextKb() {
        if (!running || web == null) return;
        if (kbIndex < 0) kbIndex = 0;
        if (kbIndex >= KB_URLS.length) {
            waitingKb = false;
            kbIndex = -1;
            fail(ERR_NO_TIMETABLE, "候选课表地址都没命中");
            return;
        }
        waitingKb = true;
        probeAttempt = 0;
        String url = KB_URLS[kbIndex];
        kbIndex += 1;
        emit("find", 40 + Math.min(kbIndex * 4, 12), "正在打开课表页…（" + kbIndex + "/" + KB_URLS.length + "）");
        web.loadUrl(url);
    }

    /* ------------------------------------------------------------ 读取 */

    /**
     * 读取课表：优先异步脚本 `__buptCapture()`（顺带取到"当前第 N 周"），
     * 老脚本 / 异常时退回同步返回值（没有周次信号，但课表照抓）。
     */
    private void capture() {
        if (!running || web == null || capturing) return;
        capturing = true;
        emit("read", 62, "正在读取课表内容…");
        handler.postDelayed(captureTimeout, CAPTURE_TIMEOUT_MS);

        // ★ 先注入脚本，再问它有没有异步入口（原因见 JwglActivity.capture 的注释）：
        //   以前没注入就问，永远走 sync 路径 → 周次/周历信号永远取不到。
        web.evaluateJavascript(captureJs, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String syncValue) {
                if (!running || web == null) return;
                final String syncJson = unwrapJsString(syncValue);
                web.evaluateJavascript(
                        "(function(){try{if(typeof window.__buptCapture==='function'){window.__buptCapture();return 'async';}}catch(e){}return 'sync';})()",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String mode) {
                                if (!running || web == null) return;
                                if ("\"async\"".equals(String.valueOf(mode))) return; // 等 Bridge 回调
                                onCaptureDelivered(syncJson);
                            }
                        });
            }
        });
    }

    private final Runnable captureTimeout = new Runnable() {
        @Override
        public void run() {
            if (!running || !capturing) return;
            fail(ERR_READ_FAILED, "读取课表超时");
        }
    };

    private void onCaptureDelivered(String json) {
        if (!running || !capturing) return;
        capturing = false;
        handler.removeCallbacks(captureTimeout);

        if (json == null || json.length() < 20 || !json.contains("\"candidates\"")) {
            fail(ERR_READ_FAILED, "抓取结果为空或缺少 candidates");
            return;
        }

        emit("read", 82, "读取完成，正在解析…");
        String id = taskId;
        cleanup();
        if (listener != null) listener.onResult(id, json);
    }

    /* ------------------------------------------------------------ 终止 */

    private final Runnable deadline = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            fail(ERR_TIMEOUT, "超过 " + (DEADLINE_MS / 1000) + " 秒仍未拿到课表");
        }
    };

    private void fail(String code, String detail) {
        if (!running) return;
        String id = taskId;
        cleanup();
        if (listener != null) listener.onError(id, code, detail == null ? "" : detail);
    }

    private void cleanup() {
        running = false;
        capturing = false;
        handler.removeCallbacks(deadline);
        handler.removeCallbacks(captureTimeout);
        final WebView w = web;
        web = null;
        if (w == null) return;
        // ★ 延后一帧再销毁：可能正处在 WebView 自己的回调栈里，当场 destroy 会崩
        handler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    container.removeView(w);
                } catch (Exception ignored) {
                    // 已经不在容器里
                }
                try {
                    w.destroy();
                } catch (Exception ignored) {
                    // 已经销毁
                }
            }
        });
    }

    /** 主 Activity 销毁时调用（不必回调任何东西）。 */
    public void release() {
        running = false;
        cleanup();
    }

    /* ------------------------------------------------------------ 小工具 */

    private void emit(String step, int percent, String text) {
        if (listener == null || !running) return;
        listener.onProgress(taskId, step, percent, text);
    }

    private static int toInt(String value) {
        try {
            return Integer.parseInt(String.valueOf(value).trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** evaluateJavascript 返回的是「JSON 编码后的字符串」，这里还原成裸 JSON。 */
    private static String unwrapJsString(String value) {
        try {
            Object parsed = new JSONTokener(String.valueOf(value)).nextValue();
            if (parsed instanceof String) return (String) parsed;
        } catch (Exception ignored) {
            // 落到 null
        }
        return null;
    }

    private String readAsset(String path) {
        InputStream in = null;
        try {
            in = host.getAssets().open(path);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), Charset.forName("UTF-8"));
        } catch (IOException e) {
            return "";
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // 忽略
                }
            }
        }
    }
}
