package com.bupt.schedule;

import android.app.Activity;
import android.os.Handler;
import android.util.Log;
import android.os.Looper;
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

/**
 * HomeworkGrabber —— 「一键获取作业」的后台引擎。
 *
 * 和 {@link AutoGrabber} 是同一套路子（隐藏 WebView + 注入 JS），但目标系统完全不同：
 *
 * | | 教务 (jsxsd) | 云邮教学空间 (ucloud) |
 * |---|---|---|
 * | 页面 | 服务端渲染的 HTML 表格 | Vue 单页应用，HTML 里没有数据 |
 * | 数据 | 解析 DOM | **调 JSON 接口** |
 * | 登录 | 表单 POST 到 jsxsd | 统一身份认证 (CAS)，再跳回 ucloud |
 *
 * 【为什么还是要 WebView】
 * CAS 登录是「表单 + JSESSIONID + 跳转链」，还可能要验证码。用 OkHttp 手搓要复刻
 * 一整套流程，学校一改就废。而 WebView 就是用户的浏览器，怎么改都跟得上。
 *
 * 【两条关键事实（2026-10-28 真机验证）】
 * ① 接口域名是 `apiucloud.bupt.edu.cn`，和页面**不同域**，但 CORS 全开
 *    （`Access-Control-Allow-Origin: *`），所以可以在 ucloud 页面上下文里直接 fetch。
 * ② 鉴权靠 cookie 里的 JWT：`iClass-token` 放进 `Blade-Auth`（**不能加 bearer 前缀**），
 *    `iClass-identity` 放进 `identity` 头。少一个就是 401/404。
 *
 * 【三条硬约束（沿用 AutoGrabber 的经验）】
 * ① 必须 attach 到窗口，否则部分 ROM 不执行 JS → 1×1 + alpha=0；
 * ② 每次新建、用完销毁，避免带着上一个人的 cookie；
 * ③ 任何失败都要有结论（超时/无网/密码错/验证码），绝不无限转圈。
 */
public final class HomeworkGrabber {

    private static final String TAG = "HomeworkGrabber";

    /**
     * 排障开关：打开后可以用 `adb forward` + chrome://inspect 看隐藏 WebView 的内部状态。
     * ★ 上线前必须改成 false —— 调试端口不该留在正式包里。
     */
    private static final boolean DEBUG_WEBVIEW = false;

    public interface Listener {
        void onProgress(String text);

        void onResult(String json);

        void onError(String code, String detail);
    }

    /* 失败码（与 src/ui/homework.js 的 HOMEWORK_ERRORS 一一对应） */
    static final String ERR_NO_NETWORK = "no_network";
    static final String ERR_BAD_CREDENTIALS = "bad_credentials";
    static final String ERR_CAPTCHA = "captcha";
    static final String ERR_NO_FORM = "no_form";
    static final String ERR_TIMEOUT = "timeout";
    static final String ERR_CANCELLED = "cancelled";
    static final String ERR_BUSY = "busy";
    static final String ERR_UNKNOWN = "unknown";
    /** CAS 登录成功、但云邮页面没把会话 cookie 建起来（SPA 在我们这里会反复跳转）。 */
    static final String ERR_SESSION = "session_stuck";

    /**
     * ★ service 参数**不能带末尾斜杠**。
     *
     * 云邮后端拿 ticket 去 CAS 校验时用的是 `https://ucloud.bupt.edu.cn/uclass`（无斜杠），
     * 而 CAS 的 ticket 是**按 service 逐字绑定**的。带斜杠的票拿去验会得到
     * `{"error":"invalid_grant","error_description":"ticket获取用户账号失败"}` → 400，
     * 前端于是又跳回 CAS，形成无限循环（2026-10-28 用 CDP 抓到，实测两个 URL 对照验证）。
     */
    private static final String CAS_URL =
            "https://auth.bupt.edu.cn/authserver/login?service="
                    + "https%3A%2F%2Fucloud.bupt.edu.cn%2Fuclass";
    private static final String UCLOUD_HOST = "ucloud.bupt.edu.cn";
    private static final String CAS_HOST = "auth.bupt.edu.cn";
    private static final String API_BASE = "https://apiucloud.bupt.edu.cn";
    /** 冒充桌面 Chrome：见 buildHiddenWebView 里的说明。 */
    private static final String CHROME_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    /** 最多抓多少条详情（正文是 HTML，多了会明显拖慢）。与 src/ui/homework.js 的 DETAIL_LIMIT 对齐。 */
    private static final int DETAIL_LIMIT = 20;
    private static final long DEADLINE_MS = 90000L;

    private final Activity host;
    private final FrameLayout container;
    private final Listener listener;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private WebView web;
    private String[] creds;
    private boolean running;
    private boolean loginSubmitted;
    private boolean fetching;
    /** cookie 是否已经能读到 iClass-token（见 probeCookie）。 */
    private boolean cookieReady;

    public HomeworkGrabber(Activity host, FrameLayout container, Listener listener) {
        this.host = host;
        this.container = container;
        this.listener = listener;
    }

    public boolean isRunning() {
        return running;
    }

    /* ------------------------------------------------------------ 启动 */

    public boolean start(String account, String password) {
        // ★ 用户再点一次 = "重来"。以前这里回 ERR_BUSY，结果上一轮卡住（比如登录页
        //   一直没跳转）时，用户反复点都只会看到"上一次还在跑"，永远退不出来。
        if (running) {
            Log.d(TAG, "restart：上一轮还在跑，先静默收掉");
            cleanup();
        }

        String acc = String.valueOf(account == null ? "" : account).trim();
        String pwd = String.valueOf(password == null ? "" : password);

        // 网页没给密码（只填了学号，或压根没填）→ 用 Keystore 里存着的那份。
        // ★ 读的是**作业槽**，不是教务槽：两边密码不一样（见 Credentials 类注释）。
        if (pwd.length() == 0) {
            String[] saved = Credentials.loadHomework(host);
            if (saved != null && (acc.length() == 0 || acc.equals(saved[0]))) {
                acc = saved[0];
                pwd = saved[1];
            }
        }
        if (acc.length() == 0 || pwd.length() == 0) {
            emitError(ERR_BAD_CREDENTIALS, "缺少学号或密码");
            return false;
        }

        creds = new String[] {acc, pwd};
        running = true;
        loginSubmitted = false;
        fetching = false;
        cookieReady = false;

        if (DEBUG_WEBVIEW) {
            try {
                WebView.setWebContentsDebuggingEnabled(true);
            } catch (Throwable ignored) {
                // 打不开就算了，不影响抓取
            }
        }

        if (!buildHiddenWebView()) {
            fail(ERR_NO_FORM, "无法创建后台浏览器");
            return false;
        }

        Log.d(TAG, "start: account=" + acc + " 开始加载 CAS");
        emitProgress("正在连接统一身份认证…");
        handler.postDelayed(deadline, DEADLINE_MS);
        web.loadUrl(CAS_URL);
        return true;
    }

    public void cancel() {
        if (!running) return;
        cleanup();
        emitError(ERR_CANCELLED, "");
    }

    private final Runnable deadline = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            fail(ERR_TIMEOUT, "超过 " + (DEADLINE_MS / 1000) + " 秒没拿到数据");
        }
    };

    /* ------------------------------------------------------------ 隐藏 WebView */

    private boolean buildHiddenWebView() {
        try {
            WebView w = new WebView(host);
            WebSettings s = w.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setDatabaseEnabled(true);
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
            s.setSupportMultipleWindows(false);
            s.setJavaScriptCanOpenWindowsAutomatically(false);
            s.setCacheMode(WebSettings.LOAD_DEFAULT);
            // ★ 用桌面 Chrome UA，不用 WebView 默认值：
            //   WebView 的 UA 里带 "; wv" 标记，云邮的 SPA 会走「内嵌浏览器」分支，
            //   表现为登录后不断在 CAS 和 ucloud 之间来回跳、cookie 一直不落地。
            s.setUserAgentString(CHROME_UA);
            w.setWebViewClient(new Client());
            w.setWebChromeClient(new Chrome());
            w.addJavascriptInterface(new Bridge(), "BuptHomework");

            // 1×1 + alpha 0：看得见的是"没有"，但它在窗口里，JS 照常跑
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
            if (!running || url == null) return;

            Log.d(TAG, "onPageFinished: " + url);
            if (url.contains(CAS_HOST)) {
                if (!loginSubmitted) submitLogin();
                return;
            }
            if (url.contains(UCLOUD_HOST)) {
                // ★ 不能直接 fetchData：ucloud 是单页应用，跳回来时它自己还在
                //   "用 ticket 换 token → 落 cookie" 的过程中，而且页面可能重载好几次
                //   （每次重载都会换一张新 ticket）。所以先轮询探测 cookie，
                //   等 iClass-token 真出现了再取数（2026-10-28 真机复现的重载循环）。
                if (!fetching && !cookieReady) probeCookie(0);
            }
        }

        @Override
        public void onReceivedError(
                WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (!running) return;
            if (request == null || !request.isForMainFrame()) return;
            int code = error == null ? 0 : error.getErrorCode();
            // 最常见：云邮也只在内网解析，公网直接连不上
            if (code == WebViewClient.ERROR_HOST_LOOKUP
                    || code == WebViewClient.ERROR_CONNECT
                    || code == WebViewClient.ERROR_TIMEOUT
                    || code == WebViewClient.ERROR_IO) {
                fail(ERR_NO_NETWORK, "errorCode=" + code);
            }
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
            // 排障用：云邮的 SPA 报错只在控制台里，不接出来就永远是黑盒
            if (m != null) {
                Log.d(TAG, "console: " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
            }
            return true;
        }

        @Override
        public boolean onJsAlert(
                WebView view, String url, String message, android.webkit.JsResult result) {
            result.confirm();
            return true;
        }

        @Override
        public boolean onJsConfirm(
                WebView view, String url, String message, android.webkit.JsResult result) {
            result.cancel();
            return true;
        }
    }

    /* ------------------------------------------------------------ 登录 */

    private void submitLogin() {
        loginSubmitted = true;
        Log.d(TAG, "submitLogin：注入填表脚本");
        emitProgress("正在登录…");

        String js =
                "(function(){"
                        + "var u=document.querySelector('input[name=username]');"
                        + "var p=document.querySelector('input[name=password]');"
                        + "var e=document.querySelector('input[name=execution]');"
                        + "var cap=document.getElementById('captchaParent');"
                        + "var needCap=cap&&cap.style.display!=='none';"
                        + "if(needCap){BuptHomework.error('captcha');return;}"
                        + "if(!u||!p||!e){BuptHomework.error('no_form');return;}"
                        + "u.value=" + JSONObject.quote(creds[0]) + ";"
                        + "p.value=" + JSONObject.quote(creds[1]) + ";"
                        + "var f=u.form;"
                        + "if(!f){BuptHomework.error('no_form');return;}"
                        // ★ 不能直接 f.submit()：CAS 认的是**按钮**上的 _eventId=submit，
                        //   而 form.submit() 不会带上被点按钮的 name/value，
                        //   结果就是"提交了但页面原地不动"（2026-10-28 真机复现）。
                        //   优先点按钮，点不到再补一个隐藏字段兜底。
                        + "var b=f.querySelector('button[type=submit],input[type=submit],"
                        + "button[name=_eventId],#login_submit');"
                        + "if(b){b.click();return;}"
                        + "var h=document.createElement('input');"
                        + "h.type='hidden';h.name='_eventId';h.value='submit';f.appendChild(h);"
                        + "f.submit();"
                        + "})();";
        web.evaluateJavascript(js, null);

        // 登录失败时 CAS 会回到登录页并显示错误；这里不重复注入，交给页面里的
        // 错误文案判断（见 onPageFinished 之外的一次探测）
        handler.postDelayed(checkLoginError, 4000L);
    }

    private final Runnable checkLoginError = new Runnable() {
        @Override
        public void run() {
            if (!running || fetching) return;
            web.evaluateJavascript(
                    "(function(){"
                            + "var d=document.getElementById('errorDiv');"
                            + "if(d&&d.innerText&&d.innerText.indexOf('Invalid')>=0)return 'bad';"
                            + "var c=document.getElementById('captchaParent');"
                            + "if(c&&c.style.display!=='none')return 'captcha';"
                            + "return '';"
                            + "})()",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            if (!running) return;
                            if (value != null && value.contains("bad")) {
                                fail(ERR_BAD_CREDENTIALS, "CAS 返回 Invalid credentials");
                            } else if (value != null && value.contains("captcha")) {
                                fail(ERR_CAPTCHA, "登录页要求验证码");
                            }
                        }
                    });
        }
    };

    /* ------------------------------------------------------------ 取数据 */

    /**
     * 轮询等 cookie 落地。最多 30 次 × 800ms ≈ 24 秒，够 SPA 换完 token。
     * ★ 用原生轮询而不是在页面里 await：页面一重载，页面里的 JS 就没了，
     *   而原生的 handler 不受影响。
     */
    private void probeCookie(final int attempt) {
        if (!running || cookieReady) return;
        if (web == null) return;
        if (attempt > 30) {
            fail(ERR_SESSION, "CAS 已通过，但云邮页面没建立会话");
            return;
        }
        web.evaluateJavascript(
                "(function(){return document.cookie.indexOf('iClass-token')>=0?'1':'0';})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!running) return;
                        if (value != null && value.contains("1")) {
                            cookieReady = true;
                            Log.d(TAG, "cookie 就绪，开始取数（第 " + attempt + " 次探测）");
                            fetchData();
                        } else {
                            handler.postDelayed(
                                    new Runnable() {
                                        @Override
                                        public void run() {
                                            probeCookie(attempt + 1);
                                        }
                                    },
                                    800L);
                        }
                    }
                });
    }

    private void fetchData() {
        fetching = true;
        Log.d(TAG, "fetchData：已进入 ucloud，开始取数");
        emitProgress("正在读取作业列表…");

        String js =
                "(async function(){"
                        + "function ck(n){var m=document.cookie.match(new RegExp('(^|; )'+n+'=([^;]*)'));"
                        + "return m?decodeURIComponent(m[2]):'';}"
                        // ★ 刚跳回 ucloud 时 cookie 还没写完：SPA 要先拿 ticket 换 token 再落 cookie，
                        //   第一次 onPageFinished 就读会读到空 → 误报 bad_credentials（真机复现）。
                        //   所以这里轮询等最多 12 秒，等 token 出现再取数。
                        + "function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}"
                        + "var token='',ident='',uid='';"
                        + "for(var k=0;k<24;k++){"
                        + "token=ck('iClass-token');ident=ck('iClass-identity');"
                        + "var info={};try{info=JSON.parse(ck('iClass-user-info')||'{}');}catch(e){}"
                        + "uid=info.id||'';"
                        + "if(token&&uid)break;"
                        + "await sleep(500);"
                        + "}"
                        + "if(!token||!uid){BuptHomework.error('bad_credentials');return;}"
                        + "var H={'Authorization':'Basic c3dvcmQ6c3dvcmRfc2VjcmV0','Tenant-Id':'000000',"
                        + "'Blade-Auth':token,'identity':ident};"
                        + "var B='" + API_BASE + "';"
                        + "try{"
                        + "var lr=await fetch(B+'/ykt-site/site/student/undone?userId='+uid,{headers:H});"
                        + "var lj=await lr.json();"
                        + "if(!lj||!lj.data){BuptHomework.error('unknown');return;}"
                        + "var items=(lj.data.undoneList||[]).slice(0," + DETAIL_LIMIT + ");"
                        + "var out={list:lj.data,details:{}};"
                        + "for(var i=0;i<items.length;i++){"
                        + "try{"
                        + "var dr=await fetch(B+'/ykt-site/work/detail?assignmentId='+items[i].activityId,{headers:H});"
                        + "var dj=await dr.json();"
                        + "if(dj&&dj.data)out.details[items[i].activityId]=dj.data;"
                        + "}catch(e){}"
                        + "}"
                        // 课程 → 作业：列表接口（undone）不给课程名（siteId 恒为 -1），
                        // 但「我的课程」和「课程下的作业」两个接口是齐的：
                        //   ① GET  /ykt-site/site/list?userId=…                       → 课程（siteName）
                        //   ② POST /ykt-site/work/student/list?siteId=…&pageNum&pageSize
                        //      注意：参数必须放 query，放 body 会被忽略（实测回 size:10 空列表）
                        // 这里扫一遍课程，建 activityId → 课程名 的映射，回传给前端补标签。
                        + "out.courseMap={};"
                        + "try{"
                        + "var sit=await (await fetch(B+'/ykt-site/site/list?userId='+uid,{headers:H})).json();"
                        + "var sites=(sit&&sit.data&&sit.data.records)||[];"
                        + "var PH={'Authorization':H['Authorization'],'Tenant-Id':H['Tenant-Id'],"
                        + "'Blade-Auth':H['Blade-Auth'],'identity':H['identity'],'Content-Type':'application/json'};"
                        + "var lim=Math.min(sites.length,14);"
                        + "for(var si=0;si<lim;si++){"
                        + "try{"
                        + "var uq=B+'/ykt-site/work/student/list?siteId='+sites[si].id+'&pageNum=1&pageSize=50';"
                        + "var rq=await fetch(uq,{method:'POST',headers:PH,body:'{}'});"
                        + "var qj=await rq.json();"
                        + "var rows=(qj&&qj.data&&qj.data.records)||[];"
                        + "for(var ri=0;ri<rows.length;ri++){"
                        + "var aid=String(rows[ri].id==null?'':rows[ri].id);"
                        + "if(aid&&!out.courseMap[aid])out.courseMap[aid]=String(sites[si].siteName||'');"
                        + "}"
                        + "}catch(e){}"
                        + "}"
                        + "}catch(e){}"
                        + "BuptHomework.done(JSON.stringify(out));"
                        + "}catch(e){BuptHomework.error('unknown');}"
                        + "})();";
        web.evaluateJavascript(js, null);
    }

    /* ------------------------------------------------------------ 回传口 */

    private class Bridge {
        @JavascriptInterface
        public void done(final String json) {
            handler.post(
                    new Runnable() {
                        @Override
                        public void run() {
                            if (!running) return;
                            String payload = json == null ? "{}" : json;
                            cleanup();
                            if (listener != null) listener.onResult(payload);
                        }
                    });
        }

        @JavascriptInterface
        public void error(final String code) {
            handler.post(
                    new Runnable() {
                        @Override
                        public void run() {
                            fail(String.valueOf(code), "");
                        }
                    });
        }
    }

    /* ------------------------------------------------------------ 收尾 */

    private void emitProgress(String text) {
        if (listener != null) listener.onProgress(text);
    }

    private void emitError(String code, String detail) {
        if (listener != null) listener.onError(code, detail);
    }

    private void fail(String code, String detail) {
        Log.d(TAG, "fail: " + code + " " + detail);
        if (!running) return;
        cleanup();
        emitError(code, detail);
    }

    private void cleanup() {
        running = false;
        fetching = false;
        cookieReady = false;
        handler.removeCallbacks(deadline);
        handler.removeCallbacks(checkLoginError);
        if (web != null) {
            try {
                container.removeView(web);
                web.removeJavascriptInterface("BuptHomework");
                web.destroy();
            } catch (Throwable ignored) {
                // 销毁失败不影响结果
            }
            web = null;
        }
    }
}
