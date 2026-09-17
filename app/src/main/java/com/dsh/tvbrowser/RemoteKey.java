package com.dsh.tvbrowser;

import android.view.KeyEvent;

/**
 * 遥控器按键 → 动作名。
 *
 * 电视遥控器没有键盘：上面印的是「上 / 下 / 左 / 右 / 确定 / 返回」这些字，
 * 发出来的键码也五花八门 —— 同一台电视，DPAD_CENTER、ENTER、NUMPAD_ENTER、
 * BUTTON_A、甚至 KEYCODE_UNKNOWN + 一个 '\n' 字符都可能表示"确定"。
 * 所以这里做两件事：
 *
 *   1. 把能见到的遥控器键码都收进来（方向、确定、返回、频道加减、ESC、手柄 A 键…）；
 *   2. 键码认不出来时，再看按键带来的"按键文字"（getUnicodeChar / getCharacters），
 *      老盒子的 OK 键就是这么发的。
 *
 * 认出来的按键只有这几个动作：上 / 下 / 左 / 右 / 确定 / 返回。
 * 其它按键（音量、菜单、数字、播放控制…）一概不拦，交给电视系统。
 *
 * 这个类故意不碰任何 Android 运行时对象（只用到编译期常量），
 * 所以可以放在普通 JVM 单元测试里跑，见 app/src/test/。
 */
public final class RemoteKey {

    public static final String UP = "up";
    public static final String DOWN = "down";
    public static final String LEFT = "left";
    public static final String RIGHT = "right";
    public static final String OK = "ok";
    public static final String BACK = "back";

    /**
     * 长按确定键。不是遥控器发出来的键，是应用自己识别出来的"按住不放"，
     * 发进网页的动作名。网页那边用它派发 kb-longpress（首屏的收藏/删除菜单）。
     */
    public static final String LONG_OK = "longok";

    private RemoteKey() {
    }

    /** 键码 → 动作名；不归我们管的按键返回 null */
    public static String actionFor(int keyCode) {
        switch (keyCode) {
            // 方向键：DPAD 是标准，频道加减是很多盒子/电视遥控器在用的另一套
            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                return UP;
            case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                return DOWN;
            case KeyEvent.KEYCODE_DPAD_LEFT:
                return LEFT;
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                return RIGHT;

            // "确定"：遥控器中间的 OK 键，不同厂家发的码不一样
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A:
            case KeyEvent.KEYCODE_NUMPAD_5:
                return OK;

            // "返回"：遥控器上的返回/退出键
            case KeyEvent.KEYCODE_BACK:
            case KeyEvent.KEYCODE_ESCAPE:
                return BACK;

            default:
                return null;
        }
    }

    /**
     * 按键文字 → 动作名。
     *
     * 有些遥控器（尤其是老盒子）发的是 KEYCODE_UNKNOWN，真正的信息在
     * getUnicodeChar() 里：确定是 '\n' / '\r'，返回是 ESC(27) / 退格(8) / DEL(127)。
     */
    public static String actionForChar(int unicodeChar) {
        switch (unicodeChar) {
            case '\n':
            case '\r':
                return OK;
            case 27:    // ESC
            case 8:     // backspace
            case 127:   // DEL
                return BACK;
            default:
                return null;
        }
    }

    /** 整套判断：先看键码，再看按键文字 */
    public static String actionForEvent(KeyEvent event) {
        if (event == null) return null;
        String byCode = actionFor(event.getKeyCode());
        if (byCode != null) return byCode;

        String chars = null;
        try {
            chars = event.getCharacters();
        } catch (Throwable ignored) {
            // 老版本/异常输入：忽略
        }
        if (chars != null && chars.length() > 0) {
            String byChar = actionForChar(chars.charAt(chars.length() - 1));
            if (byChar != null) return byChar;
        }

        int unicode = 0;
        try {
            unicode = event.getUnicodeChar();
        } catch (Throwable ignored) {
            // 同上
        }
        if (unicode != 0) return actionForChar(unicode);
        return null;
    }

    /** 按住不放要不要连发（方向键要，确定/返回不要） */
    public static boolean isRepeatable(String action) {
        return UP.equals(action) || DOWN.equals(action) || LEFT.equals(action) || RIGHT.equals(action);
    }
}
