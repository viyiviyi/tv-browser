package com.dsh.tvbrowser;

import static org.junit.Assert.assertEquals;

import android.view.KeyEvent;

import org.junit.Test;

/**
 * 按下 / 抬起 / 长按分别由谁处理。
 *
 * 纯逻辑，不需要 Robolectric。这里钉住的是几条容易改坏的规矩：
 *   - 脚本没就绪时按键要还给 WebView（否则遥控器整片失灵）
 *   - 确定键按下时**不能**动作，否则长按来不及识别就已经把页面点开了
 *   - 方向键按住要连发、确定键按住不连发
 */
public class KeyPolicyTest {

    private static final int DOWN = KeyEvent.ACTION_DOWN;
    private static final int UP = KeyEvent.ACTION_UP;

    private static KeyPolicy.Decision decide(String action, int eventAction, int repeat, boolean ready) {
        return KeyPolicy.decideFor(action, eventAction, repeat, ready);
    }

    @Test
    public void unknownKeyIsIgnored() {
        assertEquals(KeyPolicy.Decision.IGNORE, decide(null, DOWN, 0, true));
        assertEquals(KeyPolicy.Decision.IGNORE, decide(null, UP, 0, true));
    }

    @Test
    public void directionsGoToThePageWhenTheScriptIsReady() {
        assertEquals(KeyPolicy.Decision.SEND_TO_PAGE, decide(RemoteKey.DOWN, DOWN, 0, true));
        assertEquals(KeyPolicy.Decision.SEND_TO_PAGE, decide(RemoteKey.LEFT, DOWN, 0, true));
    }

    @Test
    public void directionsHeldDownRepeat() {
        // 按住方向键：第 3、第 9 次重复都要继续发，电视上要能连续选卡片
        assertEquals(KeyPolicy.Decision.SEND_TO_PAGE, decide(RemoteKey.RIGHT, DOWN, 3, true));
        assertEquals(KeyPolicy.Decision.SEND_TO_PAGE, decide(RemoteKey.UP, DOWN, 9, true));
    }

    @Test
    public void keysGoBackToTheWebViewBeforeTheScriptIsReady() {
        // 脚本还没挂上：吃掉按键的话遥控器就整片失灵了
        assertEquals(KeyPolicy.Decision.DELEGATE, decide(RemoteKey.DOWN, DOWN, 0, false));
        assertEquals(KeyPolicy.Decision.DELEGATE, decide(RemoteKey.OK, UP, 0, false));
    }

    @Test
    public void okKeyIsDecidedOnReleaseNotOnPress() {
        // 这是长按能成立的前提：按下的一瞬间不能动作
        assertEquals(KeyPolicy.Decision.PRESS_OK, decide(RemoteKey.OK, DOWN, 0, true));
        assertEquals(KeyPolicy.Decision.PRESS_OK, decide(RemoteKey.OK, UP, 0, true));
    }

    @Test
    public void okKeyHeldDownDoesNotRepeat() {
        // 按住确定的重复事件也交给状态机（由它判断到没到长按阈值），不能当连点
        assertEquals(KeyPolicy.Decision.PRESS_OK, decide(RemoteKey.OK, DOWN, 1, true));
        assertEquals(KeyPolicy.Decision.PRESS_OK, decide(RemoteKey.OK, DOWN, 7, true));
    }

    @Test
    public void backIsHandledInLayers() {
        assertEquals(KeyPolicy.Decision.HANDLE_BACK, decide(RemoteKey.BACK, DOWN, 0, true));
        assertEquals(KeyPolicy.Decision.HANDLE_BACK, decide(RemoteKey.BACK, DOWN, 0, false));
        assertEquals(KeyPolicy.Decision.HANDLE_BACK, decide(RemoteKey.BACK, DOWN, 1, true));
    }

    @Test
    public void longPressingBackExitsTheApp() {
        assertEquals(KeyPolicy.Decision.EXIT_APP, decide(RemoteKey.BACK, DOWN, KeyPolicy.LONG_PRESS_REPEAT, true));
        assertEquals(KeyPolicy.Decision.EXIT_APP, decide(RemoteKey.BACK, DOWN, 8, true));
    }

    @Test
    public void backReleaseIsSwallowed() {
        // 返回键的按下已经处理过了，抬起不能再让系统弹一次
        assertEquals(KeyPolicy.Decision.CONSUME, decide(RemoteKey.BACK, UP, 0, true));
        assertEquals(KeyPolicy.Decision.CONSUME, decide(RemoteKey.BACK, UP, 0, false));
    }

    @Test
    public void byKeyCodeWrapsTheSameRules() {
        assertEquals(KeyPolicy.Decision.HANDLE_BACK,
                KeyPolicy.decide(KeyEvent.KEYCODE_BACK, DOWN, 0, true));
        assertEquals(KeyPolicy.Decision.SEND_TO_PAGE,
                KeyPolicy.decide(KeyEvent.KEYCODE_DPAD_DOWN, DOWN, 0, true));
        assertEquals(KeyPolicy.Decision.PRESS_OK,
                KeyPolicy.decide(KeyEvent.KEYCODE_DPAD_CENTER, UP, 0, true));
        assertEquals(KeyPolicy.Decision.IGNORE,
                KeyPolicy.decide(KeyEvent.KEYCODE_VOLUME_UP, DOWN, 0, true));
    }
}
