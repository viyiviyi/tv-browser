package com.dsh.tvbrowser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.view.KeyEvent;

import org.junit.Test;

/**
 * 遥控器按键 / 按键文字 → 动作名。
 *
 * 纯逻辑，不需要 Robolectric：KeyEvent 的键码都是编译期常量，
 * 直接调 RemoteKey.actionFor(int) 就够了。
 */
public class RemoteKeyTest {

    @Test
    public void dpadMapsToDirections() {
        assertEquals(RemoteKey.UP, RemoteKey.actionFor(KeyEvent.KEYCODE_DPAD_UP));
        assertEquals(RemoteKey.DOWN, RemoteKey.actionFor(KeyEvent.KEYCODE_DPAD_DOWN));
        assertEquals(RemoteKey.LEFT, RemoteKey.actionFor(KeyEvent.KEYCODE_DPAD_LEFT));
        assertEquals(RemoteKey.RIGHT, RemoteKey.actionFor(KeyEvent.KEYCODE_DPAD_RIGHT));
    }

    @Test
    public void channelKeysAreAlsoDirections() {
        // 很多电视/盒子的遥控器发的是频道加减键
        assertEquals(RemoteKey.UP, RemoteKey.actionFor(KeyEvent.KEYCODE_CHANNEL_UP));
        assertEquals(RemoteKey.DOWN, RemoteKey.actionFor(KeyEvent.KEYCODE_CHANNEL_DOWN));
    }

    @Test
    public void everyOkKeyCodeIsRecognised() {
        assertEquals(RemoteKey.OK, RemoteKey.actionFor(KeyEvent.KEYCODE_DPAD_CENTER));
        assertEquals(RemoteKey.OK, RemoteKey.actionFor(KeyEvent.KEYCODE_ENTER));
        assertEquals(RemoteKey.OK, RemoteKey.actionFor(KeyEvent.KEYCODE_NUMPAD_ENTER));
        assertEquals(RemoteKey.OK, RemoteKey.actionFor(KeyEvent.KEYCODE_BUTTON_A));
        assertEquals(RemoteKey.OK, RemoteKey.actionFor(KeyEvent.KEYCODE_NUMPAD_5));
    }

    @Test
    public void backAndEscapeBothMeanBack() {
        assertEquals(RemoteKey.BACK, RemoteKey.actionFor(KeyEvent.KEYCODE_BACK));
        assertEquals(RemoteKey.BACK, RemoteKey.actionFor(KeyEvent.KEYCODE_ESCAPE));
    }

    @Test
    public void volumeAndMenuAreLeftToTheSystem() {
        // 音量/菜单/数字这些一概不拦，交给电视系统
        assertNull(RemoteKey.actionFor(KeyEvent.KEYCODE_VOLUME_UP));
        assertNull(RemoteKey.actionFor(KeyEvent.KEYCODE_VOLUME_DOWN));
        assertNull(RemoteKey.actionFor(KeyEvent.KEYCODE_MENU));
        assertNull(RemoteKey.actionFor(KeyEvent.KEYCODE_1));
        assertNull(RemoteKey.actionFor(KeyEvent.KEYCODE_HOME));
    }

    @Test
    public void unknownKeyCodeFallsBackToTheCharacter() {
        // 老盒子发 KEYCODE_UNKNOWN + '\n' 表示确定
        assertEquals(RemoteKey.OK, RemoteKey.actionForChar('\n'));
        assertEquals(RemoteKey.OK, RemoteKey.actionForChar('\r'));
        assertEquals(RemoteKey.BACK, RemoteKey.actionForChar(27));
        assertEquals(RemoteKey.BACK, RemoteKey.actionForChar(8));
        assertEquals(RemoteKey.BACK, RemoteKey.actionForChar(127));
        assertNull(RemoteKey.actionForChar('a'));
    }

    @Test
    public void onlyDirectionsRepeatWhenHeld() {
        assertTrue(RemoteKey.isRepeatable(RemoteKey.UP));
        assertTrue(RemoteKey.isRepeatable(RemoteKey.DOWN));
        assertTrue(RemoteKey.isRepeatable(RemoteKey.LEFT));
        assertTrue(RemoteKey.isRepeatable(RemoteKey.RIGHT));
        // 确定键按住不发连击：长按另有含义（弹收藏/删除菜单）
        assertFalse(RemoteKey.isRepeatable(RemoteKey.OK));
        assertFalse(RemoteKey.isRepeatable(RemoteKey.BACK));
    }

    @Test
    public void longOkIsItsOwnActionName() {
        // 长按确定是应用识别出来的，不是遥控器发出来的键
        assertEquals("longok", RemoteKey.LONG_OK);
        // 不要和普通确定撞名，否则网页区分不出来
        assertFalse(RemoteKey.LONG_OK.equals(RemoteKey.OK));
    }
}
