package com.dsh.tvbrowser;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.SystemClock;
import android.util.Log;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * 电视用的 WebView（一个标签页一个）。六件事：
 *
 *  1. UA 伪装成 Windows 上的 Chrome —— 网站据此返回电脑版页面（而不是手机版）。
 *  2. 注入导航脚本：遥控器的方向键变成"选中网页上的卡片/按钮/链接"，
 *     确定键变成"点它"。
 *  3. 链接开在"新标签页"里：_blank 由注入脚本直接通知 Activity 开新 WebView，
 *     返回键就是关掉这个标签页，原来那页原地复活（不重新加载）。
 *  4. 选中项的位置会补一个真实的鼠标悬停事件，让 CSS :hover 生效。
 *  5. 首屏是本地页面，它发出的 http 跳转一律转成新标签页 —— 首页永远不被顶掉。
 *  6. 确定键分短按 / 长按：长按（500ms）发 longok，首屏用它弹"收藏 / 删除"菜单。
 */
public class BrowserWebView extends WebView {

    public interface Listener {
        /** 注入脚本挂载完成（遥控器按键从这一刻起交给网页） */
        void onBridgeReady(BrowserWebView web);

        /** 长按返回键：直接退出应用 */
        void onExitRequest(boolean longPress);

        /** 页面开始加载 / 加载结束（用来收放"正在加载"提示） */
        void onPageLoading(BrowserWebView web, boolean loading);

        /** 首屏内容已经可见：别再用加载提示挡着画面了 */
        void onPageVisible(BrowserWebView web);

        /** 访问了一个 http(s) 页面（记进"最近打开"） */
        void onPageVisited(BrowserWebView web, String url);

        void onPageError(BrowserWebView web, String message);

        /** 网页自己处理不了返回键了，由 Activity 决定：短按"退上一页 → 关标签页 → 退出确认"。
         *  doublePress=true 表示"连按两下返回"，按长按处理（直接关标签页 / 只剩首屏就退出） */
        void onNativeBack(BrowserWebView web, boolean doublePress);

        /** 网页请求开新窗口（_blank / window.open 漏网的），转成开一个新标签页 */
        void onNewWindowRequest(BrowserWebView web, Message resultMsg);

        /** 本地首屏里点了网站：不要覆盖首页，开一个新标签页 */
        void onNewTabRequest(BrowserWebView web, String url);

        void onFullscreen(BrowserWebView web, View view, WebChromeClient.CustomViewCallback callback);

        void onFullscreenExit(BrowserWebView web);
    }

    /** 冒充 Windows 上的 Chrome 122 */
    public static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/122.0.0.0 Safari/537.36";

    /** 按住确定键多久算长按 */
    public static final long LONG_OK_MS = 500L;

    /**
     * 两次返回键按下的间隔小于这个值就算"连按两下返回"（等同长按：直接关标签页）。
     * 很多红外遥控器的返回键发不出长按（只发一次按下、没有重复事件），所以留了这么个手势。
     */
    public static final long DOUBLE_BACK_MS = 500L;

    /**
     * 注入脚本就绪探测：页面脚本挂上之前遥控器按键只能交回 WebView 原生处理。
     * 返回布尔值（evaluateJavascript 会把字符串包一层引号，别用字符串判断）。
     */
    private static final String PROBE_JS =
            "!!(window.__kbTV && window.__kbTV.__mounted && window.__kb)";

    /**
     * 页面开始加载后，隔多久去确认/补一次注入（毫秒）。
     *
     * 前面几次排得很密：页面真正的文档是在"提交"那一刻才建好的，在那之前注入的脚本
     * 会随旧上下文一起丢掉。密一点才能在提交之后马上把脚本装进去，
     * 页面一有 DOM 遥控器就能用（大站很晚才 onPageFinished）。
     */
    private static final long[] INJECT_DELAYS = {0, 40, 90, 160, 260, 420, 700, 1200, 2000, 3000, 4500};

    private Listener listener;
    private BrowserBridge bridge;

    /** 注入脚本是否已经挂载好（挂好之前按键走 WebView 原生处理） */
    private volatile boolean bridgeReady = false;

    private String earlyJs = "";
    private String navJs = "";
    private String currentUrl = "";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private int injectAttempt = 0;

    /* 长按确定键的状态机 */
    private boolean okDown = false;
    private boolean okLongFired = false;

    /** 上一次按返回键的时间（用来判断"连按两下"） */
    private long lastBackAt = 0L;

    /* 选中框（CSS 像素，相对视口），由网页通过 kbHost.select 上报 */
    private volatile int selX = -1;
    private volatile int selY = -1;
    private volatile int selW = 0;
    private volatile int selH = 0;
    private volatile String selLabel = "";

    /* 最近一次原生悬停点（视图坐标），单元测试用它断言 */
    private float lastHoverX = -1f;
    private float lastHoverY = -1f;
    private int hoverCount = 0;

    /** 按住确定的计时器：到点了还没抬手就是长按 */
    private final Runnable okLongTask = new Runnable() {
        @Override
        public void run() {
            if (!okDown) return;
            okLongFired = true;
            sendKey(RemoteKey.LONG_OK);
        }
    };

    private final Runnable injectProbe = new Runnable() {
        @Override
        public void run() {
            if (bridgeReady) return;
            evaluateJavascript(PROBE_JS, value -> {
                if ("true".equals(value)) {
                    markBridgeReady();
                    return;
                }
                injectScripts();
                if (injectAttempt < INJECT_DELAYS.length - 1) {
                    injectAttempt++;
                    handler.postDelayed(injectProbe, INJECT_DELAYS[injectAttempt]);
                }
            });
        }
    };

    public BrowserWebView(Context context) {
        super(context);
        loadAssets();
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public void setBridge(BrowserBridge bridge) {
        this.bridge = bridge;
    }

    public void setBridgeReady(boolean ready) {
        this.bridgeReady = ready;
    }

    public BrowserBridge getBrowserBridge() {
        return bridge;
    }

    public boolean isBridgeReady() {
        return bridgeReady;
    }

    /** 这一页是不是本地首屏 */
    public boolean isHomePage() {
        return currentUrl != null && currentUrl.startsWith(MainActivity.HOME_URL);
    }

    /** 这个标签页是不是 Activity 当前正在显示的那个 */
    public boolean isActiveIn(MainActivity activity) {
        return activity != null && activity.isActiveTab(this);
    }

    /* ------------------------------------------------------------- assets -- */

    private void loadAssets() {
        earlyJs = readAsset("early.js");
        navJs = readAsset("keynav-web.js");
        Log.i(MainActivity.TAG, "assets: early.js=" + earlyJs.length() + "B, keynav-web.js=" + navJs.length() + "B");
    }

    private String readAsset(String name) {
        StringBuilder sb = new StringBuilder();
        try (InputStream in = getContext().getAssets().open(name);
             BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) sb.append(line).append('\n');
        } catch (IOException e) {
            Log.w(MainActivity.TAG, "读取 asset 失败: " + name, e);
        }
        return sb.toString();
    }

    /* ----------------------------------------------------------- settings -- */

    public void configure() {
        WebSettings s = getSettings();

        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // assets 里的首屏要用 file:///android_asset 加载；网页里的 file:// 导航在 handleUrl 里拦掉
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);

        // 电视上没人会去点播放键，视频要能自己播
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        // 开新窗口的能力要留着：_blank 由脚本通知 Activity 开新标签页，
        // 万一漏了（页面自己 window.open），onCreateWindow 也能兜住。
        s.setSupportMultipleWindows(true);

        // 电脑版页面按 1400px 上下排版，靠这两项 + 注入的 viewport 铺满电视屏幕
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);

        s.setUserAgentString(DESKTOP_UA);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(this, true);   // 登录状态要留着

        setBackgroundColor(Color.BLACK);
        setKeepScreenOn(true);
        setFocusable(true);
        setFocusableInTouchMode(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        }

        setWebViewClient(new TvClient());
        setWebChromeClient(new TvChrome());
    }

    /* -------------------------------------------------------- 遥控器按键 -- */

    /**
     * @return true 表示这次按键已经被应用消费，不要再交给系统
     */
    public boolean handleRemoteKey(KeyEvent event) {
        String action = RemoteKey.actionForEvent(event);
        KeyPolicy.Decision decision = KeyPolicy.decideFor(
                action, event.getAction(), event.getRepeatCount(), bridgeReady);

        // 返回键：记一下两次按下之间隔了多久。
        // 遥控器的返回键不一定发得出"长按"（很多红外遥控只发一次按键，没有重复事件），
        // 所以"连按两下返回"也算长按：直接关标签页。
        boolean doublePress = false;
        if (RemoteKey.BACK.equals(action) && event.getAction() == KeyEvent.ACTION_DOWN) {
            doublePress = noteBackDown();
        }

        switch (decision) {
            case IGNORE:
            case DELEGATE:
                // 交回 WebView：脚本没挂上时至少还能原生滚动/走焦点
                return false;
            case EXIT_APP:
                if (listener != null) listener.onExitRequest(true);
                return true;
            case HANDLE_BACK:
                return handleBack(doublePress);
            case PRESS_OK:
                return handleOkKey(event);
            case SEND_TO_PAGE:
                sendKey(action);
                return true;
            case CONSUME:
            default:
                return true;
        }
    }

    /** @return true 表示这次按下和上一次按下离得很近（= 双击返回） */
    private boolean noteBackDown() {
        long now = SystemClock.uptimeMillis();
        boolean doublePress = lastBackAt != 0L && (now - lastBackAt) <= DOUBLE_BACK_MS;
        lastBackAt = now;
        return doublePress;
    }

    /**
     * 忘掉"上一次按返回键的时间"。
     *
     * 换了个标签页（关掉一个、露出下面那个）时必须调用：否则用户"连按两下返回"
     * 的第一下已经把标签页关掉了，第二下会被当成双击、把下面那页也一起关掉。
     */
    public void resetBackPress() {
        lastBackAt = 0L;
    }

    /** 测试用：上一次按返回键的时刻（0 表示还没按过） */
    long lastBackAt() {
        return lastBackAt;
    }

    /**
     * 确定键的短按 / 长按。
     *
     * 按下时先不动手：要等抬手才知道是"点一下"还是"按住不放"。
     *   抬手时还没到阈值  → 发 ok（网页点击选中项）
     *   按住超过阈值      → 中途就发一次 longok，抬手时不再发 ok
     *
     * 阈值判断用计时器而不是按键重复计数：有些遥控器按住根本不发重复事件。
     */
    private boolean handleOkKey(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            if (event.getRepeatCount() == 0) {
                okDown = true;
                okLongFired = false;
                handler.removeCallbacks(okLongTask);
                handler.postDelayed(okLongTask, LONG_OK_MS);
            }
            return true;    // 按住的重复事件一律吃掉
        }

        // ACTION_UP
        handler.removeCallbacks(okLongTask);
        okDown = false;
        boolean longFired = okLongFired;
        okLongFired = false;
        if (!longFired) sendKey(RemoteKey.OK);
        return true;
    }

    /**
     * 返回键分层处理：
     *   页面自己的浮层 → 全屏 → 弹层 → 输入框里 → 取消选中
     *   都轮不上就交给 Activity（短按：退上一页 → 关标签页 → 退出确认）
     *
     * 长按返回（遥控器支持的话）或连按两下返回，都走"直接关标签页"那条路。
     */
    private boolean handleBack(boolean doublePress) {
        if (!bridgeReady) {
            if (listener != null) listener.onNativeBack(this, doublePress);
            return true;
        }
        evaluateJavascript("(window.__kbTV && window.__kbTV.key) ? __kbTV.key('back') : false",
                value -> {
                    if (!"true".equals(value) && listener != null) {
                        listener.onNativeBack(this, doublePress);
                    }
                });
        return true;
    }

    /**
     * 把遥控器动作发给网页。
     *
     * 确定键还要兜底：网页那边没点中（比如选中项刚好被脚本清掉了）时，
     * 应用自己在选中框中心补一次真实点击 —— 这样"选中了按一次确定"
     * 在任何情况下都成立。
     */
    private void sendKey(String action) {
        if (action == null) return;
        String js = "(window.__kbTV && window.__kbTV.key) ? window.__kbTV.key('" + action + "') : false";
        evaluateJavascript(js, value -> onKeyResult(action, value));
    }

    void onKeyResult(String action, String value) {
        if ("true".equals(value)) return;
        if (RemoteKey.OK.equals(action)) clickAtSelection();
    }

    /* -------------------------------------------------------- 悬停与点击 -- */

    /** 网页上报的选中框（CSS 像素） */
    public void setSelection(int x, int y, int w, int h, String label) {
        selX = x;
        selY = y;
        selW = w;
        selH = h;
        selLabel = label == null ? "" : label;
    }

    public void clearSelection() {
        selX = -1;
        selY = -1;
        selW = 0;
        selH = 0;
        selLabel = "";
    }

    public String getSelectionLabel() {
        return selLabel;
    }

    public float getLastHoverX() {
        return lastHoverX;
    }

    public float getLastHoverY() {
        return lastHoverY;
    }

    public int getHoverCount() {
        return hoverCount;
    }

    public boolean isOkDown() {
        return okDown;
    }

    /**
     * 在选中项上补一个真实的鼠标悬停事件。
     *
     * 这一步是给 CSS :hover 用的 —— JS 派发的 mouseover 事件改不了浏览器的
     * :hover 状态（卡片放大、"立即播放"浮层都是纯 CSS 的），只有真的把
     * 指针移到那里才行。传入 (-1,-1) 表示清掉悬停。
     *
     * @param cssX 视口坐标系里的 CSS 像素（就是 getBoundingClientRect 那套）
     */
    public void hoverAt(int cssX, int cssY) {
        float scale = 1f;
        try {
            scale = getScale();
        } catch (Throwable ignored) {
            // 页面还没排版时拿不到缩放，按 1 处理
        }
        if (!(scale > 0f)) scale = 1f;
        boolean leave = cssX < 0 || cssY < 0;
        float x = leave ? -1f : cssX * scale;
        float y = leave ? -1f : cssY * scale;
        lastHoverX = x;
        lastHoverY = y;
        hoverCount++;
        try {
            long now = SystemClock.uptimeMillis();
            int action = leave ? MotionEvent.ACTION_HOVER_EXIT : MotionEvent.ACTION_HOVER_MOVE;
            MotionEvent ev = MotionEvent.obtain(now, now, action, Math.max(0f, x), Math.max(0f, y), 0);
            ev.setSource(InputDevice.SOURCE_MOUSE);
            boolean handled = dispatchGenericMotionEvent(ev);
            ev.recycle();
            if (!handled) {
                MotionEvent hover = MotionEvent.obtain(now, now, action, Math.max(0f, x), Math.max(0f, y), 0);
                hover.setSource(InputDevice.SOURCE_MOUSE);
                onHoverEvent(hover);
                hover.recycle();
            }
        } catch (Throwable t) {
            Log.w(MainActivity.TAG, "派发悬停事件失败", t);
        }
    }

    /** 在选中框中心补一次真实点击（确定键的兜底） */
    public boolean clickAtSelection() {
        if (selX < 0 || selY < 0) return false;
        float scale = 1f;
        try {
            scale = getScale();
        } catch (Throwable ignored) {
            // 同上
        }
        if (!(scale > 0f)) scale = 1f;
        float x = (selX + selW / 2f) * scale;
        float y = (selY + selH / 2f) * scale;
        try {
            long now = SystemClock.uptimeMillis();
            MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0);
            down.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            dispatchTouchEvent(down);
            down.recycle();
            MotionEvent up = MotionEvent.obtain(now, now + 40, MotionEvent.ACTION_UP, x, y, 0);
            up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            dispatchTouchEvent(up);
            up.recycle();
            Log.i(MainActivity.TAG, "确定键兜底点击 " + selLabel + " @(" + x + "," + y + ")");
            return true;
        } catch (Throwable t) {
            Log.w(MainActivity.TAG, "兜底点击失败", t);
            return false;
        }
    }

    /* --------------------------------------------------------------- url -- */

    static String schemeOf(String url) {
        try {
            String s = Uri.parse(url).getScheme();
            return s == null ? null : s.toLowerCase();
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 处理一次跳转请求。
     *
     * @return true 表示这次跳转被我们处理掉了（拦下或转成新标签页），
     *         false 表示在当前 WebView 里打开
     */
    // 包级可见：单元测试要直接验它（见 BrowserWebViewTest）
    boolean handleUrl(String url) {
        if (url == null) return true;
        String scheme = schemeOf(url);
        if (scheme == null) return true;

        if ("http".equals(scheme) || "https".equals(scheme)) {
            // 首屏不能被顶掉：它里面的任何 http 跳转都开成新标签页
            if (isHomePage()) {
                if (listener != null) listener.onNewTabRequest(this, url);
                return true;
            }
            return false;   // 就在本标签页里打开
        }

        if ("about".equals(scheme)) return false;

        if ("file".equals(scheme)) {
            // 本地文件：只认首屏自己，网页不能把用户导到文件系统里去
            return !url.startsWith(MainActivity.HOME_URL);
        }

        // intent: / market: / tel: / weixin: 之类一律拦掉
        Log.i(MainActivity.TAG, "拦截跳转: " + url);
        return true;
    }

    // 包级可见：单元测试会直接调它验证"页面加载后脚本确实被注入"（见 BrowserWebViewTest）
    void injectScripts() {
        if (bridge == null) return;
        if (!earlyJs.isEmpty()) evaluateJavascript(earlyJs, null);
        if (!navJs.isEmpty()) evaluateJavascript(navJs, null);
    }

    /** 页面脚本确认挂载好了 */
    void markBridgeReady() {
        if (bridgeReady) return;
        bridgeReady = true;
        if (listener != null) listener.onBridgeReady(this);
    }

    void setCurrentUrl(String url) {
        currentUrl = url == null ? "" : url;
    }

    String getCurrentUrl() {
        return currentUrl;
    }

    @Override
    public void destroy() {
        handler.removeCallbacks(injectProbe);
        handler.removeCallbacks(okLongTask);
        okDown = false;
        super.destroy();
    }

    /* ------------------------------------------------------------ clients -- */

    private class TvClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUrl(request.getUrl() == null ? null : request.getUrl().toString());
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(url);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            currentUrl = url == null ? "" : url;
            bridgeReady = false;
            clearSelection();
            if (bridge != null) bridge.setHome(isHomePage());
            // 越早注入越好：navigator.platform 这类特征要在页面脚本跑之前摆好
            injectScripts();
            // 光在 onPageStarted 注入不够：这时候文档可能还没建好，
            // 注入的脚本会随上下文一起丢掉。之后按几个时间点边探测边补，
            // 这样页面一有 DOM 遥控器就能用（大站很晚才 onPageFinished）。
            injectAttempt = 0;
            handler.removeCallbacks(injectProbe);
            handler.post(injectProbe);
            if (listener != null) {
                listener.onPageLoading(BrowserWebView.this, true);
                if (SiteStore.isHttpUrl(currentUrl)) {
                    listener.onPageVisited(BrowserWebView.this, currentUrl);
                }
            }
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            // 首屏已经画出来了：把"正在加载"收掉，别挡着画面
            if (listener != null) listener.onPageVisible(BrowserWebView.this);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            currentUrl = url == null ? "" : url;
            injectScripts();
            if (listener != null) {
                listener.onPageVisible(BrowserWebView.this);
                listener.onPageLoading(BrowserWebView.this, false);
            }
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            // 历史更新 = 新文档已经建好了（比 onPageFinished 早得多）：
            // 这是能最早把脚本塞进新文档的时机
            if (!bridgeReady) {
                injectScripts();
                handler.removeCallbacks(injectProbe);
                handler.post(injectProbe);
            }
            // SPA 站内跳转：清掉上一页残留的高亮框
            if (!isReload) evaluateJavascript("window.__kbTV && __kbTV.key('reset')", null);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame() && listener != null) {
                listener.onPageError(BrowserWebView.this,
                        String.valueOf(error == null ? "未知错误" : error.getDescription()));
            }
        }
    }

    private class TvChrome extends WebChromeClient {

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            // 页面自己要开新窗口（脚本漏掉的 _blank / window.open）→ 开一个新标签页
            if (listener != null && resultMsg != null) {
                listener.onNewWindowRequest(BrowserWebView.this, resultMsg);
                return true;
            }
            return false;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (listener != null) listener.onFullscreen(BrowserWebView.this, view, callback);
        }

        @Override
        public void onHideCustomView() {
            if (listener != null) listener.onFullscreenExit(BrowserWebView.this);
        }

        @Override
        public boolean onConsoleMessage(android.webkit.ConsoleMessage msg) {
            if (BuildConfig.DEBUG && msg != null) {
                Log.d(MainActivity.TAG, "console: " + msg.message() + " @" + msg.sourceId() + ":" + msg.lineNumber());
            }
            return true;
        }
    }
}
