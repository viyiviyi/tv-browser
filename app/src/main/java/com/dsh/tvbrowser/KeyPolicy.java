package com.dsh.tvbrowser;

import android.view.KeyEvent;

/**
 * 遥控器按键该由谁来处理 —— 纯逻辑，不碰任何 Android 运行时对象，
 * 所以能直接在普通 JVM 单元测试里跑（见 app/src/test/.../KeyPolicyTest.java）。
 *
 * 规则：
 *   方向键  按下、且网页脚本已就绪  → 立刻交给网页（按住不放要连发）
 *   方向键  按下、但脚本还没就绪    → 交回 WebView 原生处理（至少还能滚动/走焦点）
 *   确定键  按下和抬起              → 都交给 WebView 的长按状态机（见 PRESS_OK）
 *   返回键  按下                    → 分层处理：退输入 → 关弹层 → 上一页 → 退出确认
 *   返回键  长按                    → 直接退出应用
 *   其它键（音量/菜单/数字…）        → 一概不拦
 *
 * 确定键为什么不像方向键那样按下就发：
 * 要区分"短按 = 点开"和"长按 = 弹菜单"（首屏的收藏/删除就是长按），
 * 就不能在按下的一瞬间把动作兑现掉 —— 那样用户还没按住，网页已经把页面打开了。
 * 所以按下一律吃掉，抬手才发；中间超过阈值由 WebView 改发"长按"。
 */
public final class KeyPolicy {

    /** 按住返回键到第几次重复算"长按" */
    public static final int LONG_PRESS_REPEAT = 2;

    public enum Decision {
        /** 不是遥控器六键之一：完全不拦，交给系统 */
        IGNORE,
        /** 是六键之一，但网页还没接管：交回 WebView 原生处理 */
        DELEGATE,
        /** 合成键盘事件发给网页 */
        SEND_TO_PAGE,
        /** 确定键的按下/抬起：交给 WebView 的长按状态机 */
        PRESS_OK,
        /** 返回键：分层处理（退输入 → 关弹层 → 退上一页 → 退出确认） */
        HANDLE_BACK,
        /** 长按返回键：直接退出应用 */
        EXIT_APP,
        /** 已经处理过按下动作，抬起动作要一起吃掉，避免系统再处理一次 */
        CONSUME,
    }

    private KeyPolicy() {
    }

    public static Decision decide(int keyCode, int keyEventAction, int repeatCount, boolean bridgeReady) {
        return decideFor(RemoteKey.actionFor(keyCode), keyEventAction, repeatCount, bridgeReady);
    }

    /**
     * 已经认出来的动作（键码认不出时由按键文字得到）走这里。
     *
     * @param action         RemoteKey 的动作名，null 表示这按键不归我们管
     * @param keyEventAction KeyEvent.ACTION_DOWN / ACTION_UP / ACTION_MULTIPLE
     */
    public static Decision decideFor(String action, int keyEventAction, int repeatCount, boolean bridgeReady) {
        if (action == null) return Decision.IGNORE;

        boolean back = RemoteKey.BACK.equals(action);
        boolean ok = RemoteKey.OK.equals(action);

        if (keyEventAction == KeyEvent.ACTION_DOWN) {
            if (back) {
                return repeatCount >= LONG_PRESS_REPEAT ? Decision.EXIT_APP : Decision.HANDLE_BACK;
            }
            if (!bridgeReady) return Decision.DELEGATE;
            // 确定键：按下时不动手，等抬手（或按住超时）再由 WebView 决定
            if (ok) return Decision.PRESS_OK;
            if (repeatCount == 0 || RemoteKey.isRepeatable(action)) return Decision.SEND_TO_PAGE;
            return Decision.CONSUME;
        }

        // ACTION_UP / ACTION_MULTIPLE
        if (back) return Decision.CONSUME;                        // 返回键的 DOWN 已经处理过了
        if (!bridgeReady) return Decision.DELEGATE;               // 没接管时 DOWN 交给了 WebView，UP 也要给它
        if (ok) return Decision.PRESS_OK;
        return Decision.CONSUME;
    }
}
