/*!
 * PC 特征伪装（Android WebView 注入，越早跑越好）
 *
 * WebView 的 UA 已经在 WebSettings 里换成了 Windows 版 Chrome，
 * 这里再补几处 JS 层能看出来的"这不是手机/平板"：
 *   - navigator.platform 在 Android 上是 "Linux armv8l" 之类
 *   - navigator.maxTouchPoints 在带触摸的盒子上不是 0
 *   - User-Agent Client Hints（userAgentData）会自报 Android，摘掉它让站点回落到 UA 判断
 *
 * 所有改动都做了 try/catch：改不动也不能影响页面本身。
 */
(function () {
  'use strict';
  try {
    Object.defineProperty(navigator, 'platform', {
      get: function () { return 'Win32'; },
      configurable: true,
    });
  } catch (e) { /* ignore */ }

  try {
    Object.defineProperty(navigator, 'maxTouchPoints', {
      get: function () { return 0; },
      configurable: true,
    });
  } catch (e) { /* ignore */ }

  try {
    if ('userAgentData' in navigator) {
      Object.defineProperty(navigator, 'userAgentData', {
        get: function () { return undefined; },
        configurable: true,
      });
    }
  } catch (e) { /* ignore */ }
})();
