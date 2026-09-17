package com.dsh.tvbrowser;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

/**
 * 网页 → 原生 的窄接口，注入到 JS 里叫 window.kbHost。
 *
 * 每个标签页一个实例：网页只能影响"自己所在的这个 WebView"。
 *
 * 权限分两档：
 *   浏览类（ready / newTab / hover / select / toast / log）
 *     任意 http(s) 页面都能用 —— 浏览器本来就要让网页能开链接、能弹输入法。
 *   首屏类（favorite / unfavorite / forget / setEngine / saveFavorites）
 *     只有本地首页能调。外面随便一个网页都改不了用户的收藏。
 *
 * 注意：这些方法是在 WebView 的 JS 线程上被调用的，所有 UI 操作都要转回主线程。
 */
public class BrowserBridge {

    private final MainActivity activity;
    private final BrowserWebView web;
    private final Handler main = new Handler(Looper.getMainLooper());

    /** 页面是不是本地首屏（只有它有权改收藏） */
    private volatile boolean isHome = false;

    BrowserBridge(MainActivity activity, BrowserWebView web) {
        this.activity = activity;
        this.web = web;
    }

    /* -------------------------------------------------------- 浏览类 -- */

    /** 注入的脚本挂载完成后会调这个，之后遥控器按键就交给网页处理 */
    @JavascriptInterface
    public void ready() {
        main.post(() -> web.markBridgeReady());
    }

    /**
     * 网页要开新标签页（点击 _blank 链接 / window.open，以及首屏里点网站卡片）。
     *
     * 电视上没有浏览器的标签栏，但"新标签页"本身很有用：返回键就是关掉它，
     * 原来那一页原地还原，不会重新加载，滚动位置也还在。
     */
    @JavascriptInterface
    public void newTab(String url) {
        if (!SiteStore.isHttpUrl(url)) return;
        main.post(() -> activity.openTabFromWeb(web, url));
    }

    /** 选中项的中心点（CSS 像素）：原生补一个真实的鼠标悬停，让 CSS :hover 生效 */
    @JavascriptInterface
    public void hover(final int x, final int y) {
        main.post(() -> {
            if (web.isActiveIn(activity)) web.hoverAt(x, y);
        });
    }

    /** 选中框（CSS 像素）：确定键没点中时，原生拿它在中心补一次真实点击 */
    @JavascriptInterface
    public void select(final int x, final int y, final int w, final int h, final String label) {
        main.post(() -> web.setSelection(x, y, w, h, label));
    }

    @JavascriptInterface
    public void toast(final String message) {
        if (message == null) return;
        main.post(() -> {
            try {
                Toast.makeText(activity, message, Toast.LENGTH_SHORT).show();
            } catch (Throwable ignored) {
            }
        });
    }

    @JavascriptInterface
    public void log(String message) {
        if (message != null) Log.i(MainActivity.TAG, "web: " + message);
    }

    /* -------------------------------------------------------- 首屏类 -- */

    @JavascriptInterface
    public void favorite(String url) {
        if (!isHome || !SiteStore.isHttpUrl(url)) return;
        main.post(() -> activity.favoriteFromHome(url));
    }

    @JavascriptInterface
    public void unfavorite(String url) {
        if (!isHome || !SiteStore.isHttpUrl(url)) return;
        main.post(() -> activity.unfavoriteFromHome(url));
    }

    @JavascriptInterface
    public void forget(String url) {
        if (!isHome || !SiteStore.isHttpUrl(url)) return;
        main.post(() -> activity.forgetFromHome(url));
    }

    @JavascriptInterface
    public void setEngine(String id) {
        if (!isHome || id == null || id.isEmpty()) return;
        main.post(() -> activity.setEngineFromHome(id));
    }

    /** 首屏把收藏重新排好之后，整份顺序交回来 */
    @JavascriptInterface
    public void saveFavorites(String json) {
        if (!isHome || json == null || json.isEmpty()) return;
        main.post(() -> activity.saveFavoritesFromHome(json));
    }

    /* ------------------------------------------------------------ 内部 -- */

    void setHome(boolean value) {
        isHome = value;
    }
}
