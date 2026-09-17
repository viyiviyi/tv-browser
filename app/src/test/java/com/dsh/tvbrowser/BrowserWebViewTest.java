package com.dsh.tvbrowser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.os.Looper;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.webkit.WebSettings;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowSystemClock;
import org.robolectric.shadows.ShadowWebView;

import java.time.Duration;

/**
 * 在 JVM 上跑真实的 Android 类（Robolectric），验证套壳浏览器真正在做的事：
 * UA 有没有伪装成 PC、脚本有没有尽早注入、遥控器按键有没有转成网页动作、
 * 首屏会不会被顶掉、确定的短按/长按分不分得开、
 * 返回键的分层（退上一页 → 关标签页 → 退出确认，以及长按/连按两下直接关标签页）。
 *
 * 这些正是"只能装到电视上才看得出来"的胶水代码，用 shadow 提前钉住，
 * 不需要真机也不需要模拟器。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class BrowserWebViewTest {

    private static final String SITE = "https://www.bilibili.com/";

    private static MainActivity activity() {
        return Robolectric.buildActivity(MainActivity.class).setup().get();
    }

    /** 走一遍"页面开始加载"，让 currentUrl / bridge 的首页标记都就位 */
    private static void loadHome(BrowserWebView home) {
        shadowOf(home).getWebViewClient().onPageStarted(home, MainActivity.HOME_URL, null);
        shadowOf(Looper.getMainLooper()).idle();
    }

    private static KeyEvent down(int keyCode) {
        return new KeyEvent(KeyEvent.ACTION_DOWN, keyCode);
    }

    private static KeyEvent up(int keyCode) {
        return new KeyEvent(KeyEvent.ACTION_UP, keyCode);
    }

    private static String lastJs(BrowserWebView web) {
        String js = shadowOf(web).getLastEvaluatedJavascript();
        return js == null ? "" : js;
    }

    /* ------------------------------------------------------------ 基本配置 -- */

    @Test
    public void userAgentPretendsToBeDesktopChrome() {
        MainActivity a = activity();
        WebSettings s = a.homeTab().getSettings();
        assertTrue("要拿到电脑版页面", s.getUserAgentString().contains("Windows NT 10.0"));
        assertTrue(s.getUserAgentString().contains("Chrome/"));
        assertFalse("不能自报 Android", s.getUserAgentString().contains("Android"));
    }

    @Test
    public void webViewIsConfiguredForTv() {
        MainActivity a = activity();
        WebSettings s = a.homeTab().getSettings();
        assertTrue("不执行 JS 就没有导航脚本", s.getJavaScriptEnabled());
        assertTrue("多窗口要开：_blank 才能变成标签页", s.supportMultipleWindows());
        assertFalse("电视上没人会去点播放键", s.getMediaPlaybackRequiresUserGesture());
        // useWideViewPort / loadWithOverviewMode 的读值接口是隐藏的，只能设不能读，
        // 它们的效果由 test/bridge.mjs 那边验（外站的 viewport 会被钉成 width=1440）
    }

    @Test
    public void appStartsAtTheLocalHomePage() {
        MainActivity a = activity();
        assertEquals(1, a.tabCount());
        assertEquals(MainActivity.HOME_URL, shadowOf(a.homeTab()).getLastLoadedUrl());
        assertEquals("file:///android_asset/home.html", MainActivity.HOME_URL);
    }

    @Test
    public void navigationScriptIsInjectedOnPageStarted() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        shadowOf(home).getWebViewClient().onPageStarted(home, MainActivity.HOME_URL, null);
        String js = lastJs(home);
        assertTrue("要注入导航脚本主体", js.contains("__kbTV"));
        assertTrue("没有它遥控器就用不了", js.contains("kb-longpress"));
    }

    @Test
    public void clientAndChromeAreInstalled() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        assertNotNull(shadowOf(home).getWebViewClient());
        assertNotNull(shadowOf(home).getWebChromeClient());
    }

    /* ------------------------------------------------------------ 遥控器 -- */

    @Test
    public void directionKeysBecomePageActions() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.setBridgeReady(true);

        home.handleRemoteKey(down(KeyEvent.KEYCODE_DPAD_LEFT));
        assertTrue(lastJs(home).contains("__kbTV.key('left')"));

        home.handleRemoteKey(down(KeyEvent.KEYCODE_DPAD_DOWN));
        assertTrue(lastJs(home).contains("__kbTV.key('down')"));
    }

    @Test
    public void keysAreGivenBackToTheWebViewBeforeTheScriptIsReady() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.setBridgeReady(false);

        // false = 交回 WebView 原生处理：脚本没挂上时遥控器也不该彻底失灵
        assertFalse(home.handleRemoteKey(down(KeyEvent.KEYCODE_DPAD_DOWN)));
    }

    @Test
    public void tappingOkSendsOkOnReleaseOnly() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.setBridgeReady(true);

        home.handleRemoteKey(down(KeyEvent.KEYCODE_DPAD_CENTER));
        assertFalse("按下就发确定的话，长按根本来不及识别",
                lastJs(home).contains("__kbTV.key('ok')"));

        home.handleRemoteKey(up(KeyEvent.KEYCODE_DPAD_CENTER));
        assertTrue("抬手才把这次点击兑现", lastJs(home).contains("__kbTV.key('ok')"));
    }

    @Test
    public void holdingOkSendsLongOk() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.setBridgeReady(true);

        home.handleRemoteKey(down(KeyEvent.KEYCODE_DPAD_CENTER));
        assertTrue(home.isOkDown());

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(BrowserWebView.LONG_OK_MS + 100));
        assertTrue("按住不放要弹收藏/删除菜单", lastJs(home).contains("__kbTV.key('longok')"));
        assertFalse("长按不能再顺带点一次", lastJs(home).contains("__kbTV.key('ok')"));

        home.handleRemoteKey(up(KeyEvent.KEYCODE_DPAD_CENTER));
        assertFalse("抬手时不该再补一次短按", lastJs(home).contains("__kbTV.key('ok')"));
        assertFalse(home.isOkDown());
    }

    @Test
    public void quickTapNeverBecomesALongPress() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.setBridgeReady(true);

        home.handleRemoteKey(down(KeyEvent.KEYCODE_DPAD_CENTER));
        home.handleRemoteKey(up(KeyEvent.KEYCODE_DPAD_CENTER));
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(BrowserWebView.LONG_OK_MS + 500));

        assertFalse("抬手之后计时器必须被撤掉", lastJs(home).contains("__kbTV.key('longok')"));
    }

    /* -------------------------------------------------------------- url -- */

    @Test
    public void httpLinksOnTheHomePageOpenANewTab() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        assertEquals(1, a.tabCount());

        assertTrue("首页里的跳转必须被拦下", home.handleUrl(SITE));
        assertEquals(2, a.tabCount());
        assertEquals(SITE, shadowOf(a.tabAt(1)).getLastLoadedUrl());
        assertEquals("首屏留在最底下，没有被顶掉",
                MainActivity.HOME_URL, shadowOf(home).getLastLoadedUrl());
    }

    @Test
    public void httpLinksInsideASiteStayInTheSameTab() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.handleUrl(SITE);
        BrowserWebView site = a.tabAt(1);

        // 站内跳转就走本标签页：这样返回键是"退上一页"，符合浏览器的习惯
        assertFalse(site.handleUrl("https://www.bilibili.com/video/BV1"));
        assertEquals(2, a.tabCount());
    }

    @Test
    public void localFilesAreBlockedForRemotePages() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.handleUrl(SITE);
        BrowserWebView site = a.tabAt(1);

        assertTrue("网页不能把用户导到本地文件", site.handleUrl("file:///sdcard/secret.txt"));
        assertFalse("首屏自己要用 file:// 加载 assets", home.handleUrl(MainActivity.HOME_URL));
    }

    @Test
    public void otherSchemesAreBlocked() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        assertTrue(home.handleUrl("intent://scan/#Intent;scheme=zxing;end"));
        assertTrue(home.handleUrl("market://details?id=com.example"));
        assertTrue(home.handleUrl("tel:10086"));
        assertTrue(home.handleUrl("weixin://dl/business"));
    }

    /* ------------------------------------------------------------ 标签页 -- */

    @Test
    public void backClosesTheTopTabWhenThereIsNoHistory() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.handleUrl(SITE);
        BrowserWebView site = a.tabAt(1);
        assertTrue(a.isActiveTab(site));
        assertFalse("刚打开的页面没有可退的历史", site.canGoBack());

        a.onNativeBack(site, false);

        assertEquals("没有上一页了才关标签页", 1, a.tabCount());
        assertSame("回到首屏，而且是原来那个实例", home, a.activeTab());
    }

    @Test
    public void shortBackGoesToThePreviousPageBeforeClosingTheTab() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.handleUrl(SITE);
        BrowserWebView site = a.tabAt(1);

        // 这个标签页里还有上一页：短按返回要先退回去（浏览器的习惯），而不是关掉标签页
        shadowOf(site).setCanGoBack(true);
        a.onNativeBack(site, false);

        assertEquals("短按返回先退这个标签页里的上一页", 1, shadowOf(site).getGoBackInvocations());
        assertEquals("标签页不能被关掉", 2, a.tabCount());

        // 没有上一页了，短按返回才关标签页
        shadowOf(site).setCanGoBack(false);
        a.onNativeBack(site, false);
        assertEquals(1, a.tabCount());
        assertSame(home, a.activeTab());
    }

    @Test
    public void longPressBackClosesTheTabInsteadOfQuitting() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.handleUrl(SITE);
        assertEquals(2, a.tabCount());

        a.onExitRequest(true);

        assertEquals("长按返回 = 关掉当前标签页，不是退出应用", 1, a.tabCount());
        assertSame(home, a.activeTab());
        assertFalse(a.isFinishing());
    }

    @Test
    public void twoQuickBackPressesCloseTheTabLikeALongPress() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.handleUrl(SITE);
        BrowserWebView site = a.tabAt(1);
        // 就算这个标签页里有上一页，连按两下返回也是"关标签页"（等同长按）
        shadowOf(site).setCanGoBack(true);

        // 桥没就绪时返回键处理是同步的，正好用来验"连按两下"
        assertTrue(site.handleRemoteKey(down(KeyEvent.KEYCODE_BACK)));
        assertTrue(site.handleRemoteKey(down(KeyEvent.KEYCODE_BACK)));

        assertEquals("第一下是普通返回（退了一页）", 1, shadowOf(site).getGoBackInvocations());
        assertEquals("第二下紧跟其后 = 连按两下返回 → 关掉这个标签页", 1, a.tabCount());
        assertSame(home, a.activeTab());
    }

    @Test
    public void backPressesFarApartAreNotADoublePress() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.handleUrl(SITE);
        BrowserWebView site = a.tabAt(1);
        shadowOf(site).setCanGoBack(true);

        site.handleRemoteKey(down(KeyEvent.KEYCODE_BACK));
        // Robolectric 里 SystemClock 是模拟时钟，得手动往前推，Thread.sleep 不管用
        ShadowSystemClock.advanceBy(Duration.ofMillis(BrowserWebView.DOUBLE_BACK_MS + 80));
        shadowOf(site).setCanGoBack(true);      // shadow 退一次历史后就不再认为能退
        site.handleRemoteKey(down(KeyEvent.KEYCODE_BACK));

        assertEquals("隔得久的两次返回只是两次普通返回：标签页还在", 2, a.tabCount());
        assertEquals(2, shadowOf(site).getGoBackInvocations());
    }

    @Test
    public void resetBackPressForgetsThePreviousBackDown() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        assertEquals("还没按过返回", 0L, home.lastBackAt());

        home.handleRemoteKey(down(KeyEvent.KEYCODE_BACK));
        assertTrue("按过之后要记下时刻（双击判定全靠它）", home.lastBackAt() != 0L);

        home.resetBackPress();
        assertEquals("换页之后必须能忘掉，否则第二下会被误判成连按两下", 0L, home.lastBackAt());
    }

    @Test
    public void closingATabForgetsTheBackTimerOfThePageBelow() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        // 先在首屏上按一次返回：首屏记下了这次按下的时刻
        home.handleRemoteKey(down(KeyEvent.KEYCODE_BACK));
        assertTrue(home.lastBackAt() != 0L);

        // 紧接着打开一个网站，再按一次返回把这页关掉、露出首屏
        home.handleUrl(SITE);
        BrowserWebView site = a.tabAt(1);
        site.handleRemoteKey(down(KeyEvent.KEYCODE_BACK));
        assertEquals("这一下关掉了网站标签页", 1, a.tabCount());
        assertSame(home, a.activeTab());

        assertEquals("关标签页时要顺手把下面那页的计时清掉，"
                + "否则下一次返回会被误判成连按两下", 0L, home.lastBackAt());
    }

    @Test
    public void backOnTheHomePageAsksToExit() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        // 首屏没有可退的历史，也没有可关的标签页 → 退出确认
        a.onNativeBack(home, false);
        assertEquals("首屏不能被关掉", 1, a.tabCount());
        assertSame(home, a.activeTab());
        assertFalse(a.isFinishing());
    }

    @Test
    public void homeTabSurvivesTabRecycling() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        for (int i = 0; i < 10; i++) {
            a.openTabFromWeb(a.activeTab(), "https://site" + i + ".example.com");
        }

        assertTrue("标签页要有上限，电视盒子内存吃不住", a.tabCount() <= 5);
        assertSame("首屏永远不被回收，否则用户回不到搜索框", home, a.tabAt(0));
        assertEquals("最后一个打开的要在最上面",
                "https://site9.example.com", shadowOf(a.activeTab()).getLastLoadedUrl());
    }

    @Test
    public void closingTabsStopsAtTheHomePage() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.handleUrl(SITE);

        for (int i = 0; i < 5; i++) {
            a.onNativeBack(a.activeTab(), false);
        }
        assertEquals(1, a.tabCount());
        assertSame(home, a.activeTab());
    }

    /* ------------------------------------------------------ 浏览记录与悬停 -- */

    @Test
    public void visitingASiteIsRemembered() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);
        home.handleUrl(SITE);
        BrowserWebView site = a.tabAt(1);

        shadowOf(site).getWebViewClient().onPageStarted(site, SITE, null);

        assertTrue("访问过的网站要进最近打开",
                a.siteStore().recent().contains("https://www.bilibili.com"));
    }

    @Test
    public void theHomePageItselfIsNotARecentEntry() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        assertFalse("本地首屏不该出现在最近打开里",
                a.siteStore().recent().contains(MainActivity.HOME_URL));
    }

    @Test
    public void hoverAndSelectionAreForwardedToThePage() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        home.setSelection(100, 200, 80, 40, "百度");
        assertEquals(0, home.getHoverCount());
        assertEquals("还没悬停过", -1f, home.getLastHoverX(), 0.01f);

        home.hoverAt(100, 200);
        assertEquals(1, home.getHoverCount());
        assertEquals(100f, home.getLastHoverX(), 0.01f);
        assertEquals(200f, home.getLastHoverY(), 0.01f);
        assertEquals("百度", home.getSelectionLabel());

        home.hoverAt(-1, -1);
        assertEquals(2, home.getHoverCount());
        assertEquals(-1f, home.getLastHoverX(), 0.01f);
    }

    @Test
    public void fallbackClickIsSkippedWhenNothingIsSelected() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        home.clearSelection();
        assertFalse("没有选中框时不该凭空点一下", home.clickAtSelection());
    }

    /* ------------------------------------------------------ 触屏长按悬停 -- */

    private static MotionEvent touch(int action, float x, float y) {
        return MotionEvent.obtain(0L, 0L, action, x, y, 0);
    }

    @Test
    public void longPressOnATouchscreenSendsAHover() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        home.onTouchEvent(touch(MotionEvent.ACTION_DOWN, 120f, 240f));
        assertEquals("还没按够时间，不该有悬停", 0, home.getHoverCount());

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(BrowserWebView.TOUCH_HOVER_MS + 60));

        assertEquals("长按要派发一次真实悬停（网页的 :hover 靠它）", 1, home.getHoverCount());
        assertEquals("悬停点就是手指按住的位置", 120f, home.getLastHoverX(), 0.01f);
        assertEquals(240f, home.getLastHoverY(), 0.01f);
        assertTrue(home.isTouchHoverActive());
    }

    @Test
    public void liftingTheFingerKeepsTheHover() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        home.onTouchEvent(touch(MotionEvent.ACTION_DOWN, 120f, 240f));
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(BrowserWebView.TOUCH_HOVER_MS + 60));
        home.onTouchEvent(touch(MotionEvent.ACTION_UP, 120f, 240f));

        // 松手之后悬停得留着：用户还要去点 hover 出来的那个按钮
        assertEquals(1, home.getHoverCount());
        assertTrue(home.isTouchHoverActive());
        assertEquals(120f, home.getLastHoverX(), 0.01f);
    }

    @Test
    public void theNextTouchClearsThePreviousHover() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        home.onTouchEvent(touch(MotionEvent.ACTION_DOWN, 120f, 240f));
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(BrowserWebView.TOUCH_HOVER_MS + 60));
        home.onTouchEvent(touch(MotionEvent.ACTION_UP, 120f, 240f));
        assertTrue(home.isTouchHoverActive());

        // 再按下去：上一次的悬停先收掉，免得残留
        home.onTouchEvent(touch(MotionEvent.ACTION_DOWN, 50f, 60f));

        assertFalse(home.isTouchHoverActive());
        assertEquals(-1f, home.getLastHoverX(), 0.01f);
    }

    @Test
    public void quickTapLeavesNoHoverBehind() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        home.onTouchEvent(touch(MotionEvent.ACTION_DOWN, 120f, 240f));
        home.onTouchEvent(touch(MotionEvent.ACTION_UP, 120f, 240f));
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(BrowserWebView.TOUCH_HOVER_MS + 300));

        assertEquals("普通点一下不该留下悬停", 0, home.getHoverCount());
        assertFalse(home.isTouchHoverActive());
    }

    @Test
    public void movingTheFingerCancelsTheLongPress() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        home.onTouchEvent(touch(MotionEvent.ACTION_DOWN, 100f, 100f));
        home.onTouchEvent(touch(MotionEvent.ACTION_MOVE, 400f, 500f));
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(BrowserWebView.TOUCH_HOVER_MS + 60));

        assertEquals("手指挪开就去滚动页面了，不算长按", 0, home.getHoverCount());
        assertFalse(home.isTouchHoverActive());
    }

    @Test
    public void aCancelEventStopsTheTimerToo() {
        MainActivity a = activity();
        BrowserWebView home = a.homeTab();
        loadHome(home);

        home.onTouchEvent(touch(MotionEvent.ACTION_DOWN, 120f, 240f));
        home.onTouchEvent(touch(MotionEvent.ACTION_CANCEL, 120f, 240f));
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(BrowserWebView.TOUCH_HOVER_MS + 60));

        assertEquals("取消掉的手势不该再补一次悬停", 0, home.getHoverCount());
    }
}
