/*!
 * tv-browser — 遥控器桥接层（浏览器版）
 *
 * 思路和 bili-keynav 的 tv-bridge.js 一样：Android 端把遥控器按键翻译成
 *   window.__kbTV.key('up' | 'down' | 'left' | 'right' | 'ok' | 'longok' | 'back')
 * 返回值 true 表示网页已经处理掉了，false 表示原生自己看着办。
 *
 * 和电视上刷 B 站那份的区别（因为这里要逛的是"任意网站"）：
 *
 *   1. viewport 只对**外部网站**钉成桌面宽度（1440）；本地首屏
 *      （file:///android_asset/home.html）按屏幕宽度排版，不参与缩放，
 *      否则首屏的栅格列数会被整体缩放搞乱。
 *   2. 不再限于某个站点：任何页面的 window.kbHost 都能用。
 *   3. 多了 longok：长按确定键。选中项上会派发一个可取消的
 *      kb-longpress 事件，首屏用它弹出"收藏 / 删除"菜单；普通网站没人
 *      接这个事件，于是长按确定键没有任何副作用。
 *   4. 多了 kb-back：返回键先问页面一次（首屏用它关掉弹出菜单），
 *      页面不接才轮到"退全屏 → 关弹层 → 退输入 → 取消选中 → 交给原生"。
 *      返回键真的落到原生头上时是：短按先退上一页、没有上一页才关标签页；
 *      长按或连按两下直接关标签页（很多红外遥控器发不出长按）。
 *
 * 输入框聚焦之后弹不弹软键盘不归这里管：那是 WebView 和系统输入法自己的事。
 */

const TV_PROFILE = {
  enabled: true,
  /** 返回键交给 Android 处理（关标签页 → 退上一页 → 退出确认），
   *  浏览器里不该"没历史就回首页"，否则电视上就退不出去了 */
  escFallbackHome: false,
  /** 遥控器没有鼠标，也就不存在"鼠标停在播放器上"这回事 */
  playerPassthrough: false,
  hintDuration: 2600,
  minArea: 100,
  debug: false,
  /** 播放器上"单击 = 播放/暂停、双击 = 全屏"的判定窗口 (ms) */
  doublePressMs: 300,
};

/** 方向/确定键在"交还给键盘语义"时用的键盘事件参数 */
const TV_KEYS = {
  up: ['ArrowUp', 'ArrowUp', 38],
  down: ['ArrowDown', 'ArrowDown', 40],
  left: ['ArrowLeft', 'ArrowLeft', 37],
  right: ['ArrowRight', 'ArrowRight', 39],
  ok: ['Enter', 'Enter', 13],
};

const DIRECTIONS = { up: true, down: true, left: true, right: true };

const TV_CSS = `
#kb-box { border-width: 3px; border-radius: 10px; }
#kb-hint { font-size: 18px; padding: 12px 16px; border-radius: 12px; max-width: 62vw; }
#kb-hint .kb-k { padding: 1px 8px; font-size: 17px; }
`;

/**
 * 外部网站按桌面宽度排版。
 *
 * 电视 WebView 的逻辑宽度通常只有 960 CSS px（1080p / densityDpi=320），
 * 网站据此会给出平板版甚至手机版布局。把 viewport 钉在 1440 之后配合
 * WebView 的 useWideViewPort + loadWithOverviewMode，浏览器会把整页缩放
 * 到正好铺满屏幕 —— 也就是"把电脑网页投到电视上"。
 */
const PAGE_WIDTH = 1440;

let installed = false;

function tvInstall(win) {
  const doc = win.document;
  if (!doc) return null;

  win.__kbTV = win.__kbTV || {};
  if (installed && win.__kbTV.__mounted) {
    return { api: win.__kbTV, notify: () => {}, fitViewport: () => {} };
  }
  installed = true;

  /* ---------------------------------------------------- 大屏提示条样式 -- */
  const style = doc.createElement('style');
  style.setAttribute('data-kb-tv', '');
  style.textContent = TV_CSS;
  (doc.head || doc.documentElement).appendChild(style);

  /* -------------------------------------------------------- 页面宽度 -- */

  /** 本地首屏（assets 里的 home.html）不参与桌面宽度缩放 */
  function isLocalPage() {
    try {
      const p = String(win.location.protocol || '').toLowerCase();
      return p === 'file:' || p === 'content:' || p === 'android_asset:';
    } catch {
      return false;
    }
  }

  function fitViewport() {
    try {
      const head = doc.head || doc.documentElement;
      if (!head) return;
      let meta = doc.querySelector('meta[name="viewport"]');
      if (!meta) {
        meta = doc.createElement('meta');
        meta.setAttribute('name', 'viewport');
        head.insertBefore(meta, head.firstChild);
      }
      const want = isLocalPage()
        ? 'width=device-width, initial-scale=1'
        : `width=${PAGE_WIDTH}, user-scalable=no`;
      if (meta.getAttribute('content') !== want) meta.setAttribute('content', want);
    } catch { /* ignore */ }
  }

  /* ------------------------------------------------------- 标签页打开 -- */
  /*
   * 电视上没有浏览器的标签栏，但"新标签页"这件事本身是好的：Android 那边
   * 会真的开一个 WebView 标签页，返回键就是关掉它 —— 原来那一页还活着，
   * 返回时不会重新加载，滚动位置也还在。
   */
  function absolute(url) {
    try {
      if (typeof url === 'string') return new win.URL(url, win.location.href).href;
      if (url && typeof url.href === 'string') return url.href;
    } catch { /* ignore */ }
    return typeof url === 'string' ? url : '';
  }

  const nativeOpen = typeof win.open === 'function' ? win.open.bind(win) : null;

  function routeNewTab(url) {
    const href = absolute(url);
    if (!/^https?:/i.test(href)) return false;
    try {
      if (win.kbHost && typeof win.kbHost.newTab === 'function') {
        win.kbHost.newTab(href);
        return true;
      }
    } catch { /* ignore */ }
    try {
      if (nativeOpen) { nativeOpen(href, '_blank', 'noopener'); return true; }
    } catch { /* ignore */ }
    return false;
  }

  function installTabs() {
    // 1) window.open → 新标签页
    try {
      win.open = function (url) {
        if (routeNewTab(url)) return null;
        return nativeOpen ? nativeOpen.apply(win, arguments) : null;
      };
    } catch { /* ignore */ }

    // 2) 点击 target=_blank / _new 的链接 → 新标签页
    doc.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[target]');
      if (!a) return;
      const target = (a.getAttribute('target') || '').toLowerCase();
      if (target !== '_blank' && target !== '_new' && target !== 'new') return;
      const href = a.href;
      if (!href || /^javascript:/i.test(href)) return;
      if (routeNewTab(href)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  /* --------------------------------------------------------- 按键分发 -- */

  /** 把按键还原成真正的键盘事件（只用于输入框 / 全屏播放器） */
  function synth(action) {
    const spec = TV_KEYS[action];
    if (!spec) return false;
    const [key, code, keyCode] = spec;
    let ev;
    try {
      ev = new win.KeyboardEvent('keydown', {
        key, code, keyCode, which: keyCode,
        bubbles: true, cancelable: true, composed: true,
      });
    } catch {
      ev = new win.KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
    }
    // 部分老代码读 keyCode/which，而它们在事件上是只读的，补一层定义
    for (const prop of ['keyCode', 'which']) {
      try {
        if (ev[prop] !== keyCode) Object.defineProperty(ev, prop, { get: () => keyCode });
      } catch { /* ignore */ }
    }
    const target = doc.activeElement && doc.activeElement.dispatchEvent ? doc.activeElement : doc;
    target.dispatchEvent(ev);
    return true;
  }

  function isTyping(c) {
    try {
      return !!(c.isTyping && c.isTyping());
    } catch {
      return false;
    }
  }

  function isPlayerFullscreen(c) {
    try {
      return !!(c.isPlayerFullscreen && c.isPlayerFullscreen());
    } catch {
      return false;
    }
  }

  /** 当前选中项（导航控制器自己知道，直接问它） */
  function currentElement() {
    try {
      const c = win.__kb;
      const t = c && c.state && c.state.current;
      if (t && t.el && t.el.isConnected !== false) return t.el;
    } catch { /* ignore */ }
    const a = doc.activeElement;
    return a && a !== doc.body ? a : null;
  }

  /**
   * 长按确定键：在选中项上派发一个可取消的 kb-longpress 事件。
   *
   * 首屏拿它做"收藏 / 删除"；普通网站不会监听，于是长按确定键什么也不发生
   * （比"默默地做了件意想不到的事"安全得多）。
   *
   * @return true 表示页面接住了（调了 preventDefault）
   */
  function longPress() {
    const el = currentElement();
    if (!el) return false;
    try {
      const ev = new win.CustomEvent('kb-longpress', { bubbles: true, cancelable: true });
      return el.dispatchEvent(ev) === false;
    } catch { /* ignore */ }
    return false;
  }

  /**
   * 按键分发。
   *
   *   ↑ ↓ ← →  换一个目标；全屏看视频时改成交给播放器（快退快进 / 音量）
   *   确定      点选中项；选中的是视频窗口时 = 播放/暂停，双击 = 全屏
   *   长按确定  只在页面上派发 kb-longpress（首屏的收藏/删除菜单用它）
   */
  function dispatchKey(action) {
    const c = win.__kb;
    if (!c) return false;

    if (action === 'longok') return longPress();

    if (!DIRECTIONS[action] && action !== 'ok') return false;

    // 输入框里：按键归输入框，用键盘语义发过去
    if (isTyping(c)) return synth(action);

    // 全屏看片：方向键（快退快进 / 音量）交还播放器，确定仍然由我们管
    if (isPlayerFullscreen(c)) {
      if (action === 'ok') {
        try { return c.activate() === true; } catch { return false; }
      }
      return synth(action);
    }

    try {
      if (DIRECTIONS[action]) {
        c.move(action);                      // 遥控器方向 = 换一个目标
        return true;
      }
      return c.activate() === true;          // 遥控器确定 = 点它
    } catch { /* ignore */ }
    return false;
  }

  /* ------------------------------------------------------ 通用弹层关闭 -- */
  /*
   * 导航引擎里那份 closeTopLayer 的选择器全是 B 站专属的（.bili-modal 之类），
   * 逛别的网站时它什么都找不到 —— 于是用户按返回想关掉一个登录框/广告遮罩，
   * 结果整个标签页被关掉了。这里补一个通用兜底。
   *
   * 宁可漏关也不误关：必须同时满足"盖住一大半屏幕"且"能找到写着关闭/取消的按钮"
   * 才动手，找不到就当没有弹层处理。
   */
  const LAYER_SELECTOR = [
    '[role="dialog"]',
    'dialog[open]',
    '[class*="modal"]', '[class*="Modal"]',
    '[class*="dialog"]', '[class*="Dialog"]',
    '[class*="overlay"]', '[class*="Overlay"]',
    '[class*="popup"]', '[class*="Popup"]',
    '[class*="mask"]', '[class*="Mask"]',
  ].join(',');

  const CLOSE_WORDS = /关闭|取消|关闭窗口|close|skip|稍后|以后再说/i;

  function closeGenericLayer() {
    let nodes;
    try {
      nodes = [...doc.querySelectorAll(LAYER_SELECTOR)];
    } catch {
      return false;
    }
    const vw = doc.documentElement.clientWidth || win.innerWidth || 0;
    const vh = doc.documentElement.clientHeight || win.innerHeight || 0;
    if (!vw || !vh) return false;

    for (const layer of nodes) {
      let cs;
      try { cs = win.getComputedStyle(layer); } catch { continue; }
      if (!cs) continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      if (cs.pointerEvents === 'none') continue;

      const r = layer.getBoundingClientRect();
      // 得盖住一大半才算弹层：小标签、角标、卡片上的提示条都不算
      if (r.width < vw * 0.5 || r.height < vh * 0.4) continue;

      let closer = null;
      try {
        closer = layer.querySelector('[aria-label*="关闭"], [title*="关闭"], .close, .btn-close');
        if (!closer) {
          closer = [...layer.querySelectorAll('button, [role="button"], a')].find((b) => {
            const text = (b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '');
            return CLOSE_WORDS.test(text);
          }) || null;
        }
      } catch { /* ignore */ }

      if (closer && typeof closer.click === 'function') {
        try {
          closer.click();
          return true;
        } catch { /* ignore */ }
      }
    }
    return false;
  }

  /**
   * 返回键：按电视上的习惯分层来
   *   0. 页面自己的弹出层（首屏的收藏/删除菜单）→ 页面接住就到此为止
   *   1. 正在全屏看视频 → 退出全屏（先做这个，别把标签页关掉）
   *   2. 页面上有弹层/遮罩 → 关掉弹层
   *   3. 光标在输入框里 → 退出输入
   *   4. 有选中的内容 → 取消选中，但记住位置（下次按方向键从那儿接着走）
   *   5. 都不是 → 交给 Android（短按：退上一页 → 关标签页 → 退出确认；
   *                              长按/连按两下：直接关标签页）
   *
   * 顺序说明：这里把"关弹层"排在"退输入"前面。浏览器里的大弹层多半是登录框、
   * 广告遮罩、Cookie 提示，按返回就是想把它关掉；先清空输入框反而要多按一次。
   */
  function back() {
    const c = win.__kb;
    if (!c) return false;

    // 页面自己的浮层优先：调了 preventDefault 就算页面处理掉了
    try {
      const ev = new win.CustomEvent('kb-back', { bubbles: true, cancelable: true });
      if (doc.dispatchEvent(ev) === false) return true;
    } catch { /* ignore */ }

    try {
      if (typeof c.cancelPendingPlay === 'function') c.cancelPendingPlay();
    } catch { /* ignore */ }
    try {
      if (typeof c.exitFullscreen === 'function' && c.exitFullscreen()) return true;
      if (typeof c.closeTopLayer === 'function' && c.closeTopLayer()) return true;
    } catch { /* ignore */ }
    if (closeGenericLayer()) return true;
    try {
      if (typeof c.blurInput === 'function' && c.blurInput()) return true;
    } catch { /* ignore */ }
    // 取消选中（记住位置）：再按方向键就从刚才那儿接着走
    try {
      if (typeof c.dismissSelection === 'function' && c.dismissSelection()) return true;
    } catch { /* ignore */ }
    return false;
  }

  /* --------------------------------------------------- 选中项位置上报 -- */
  /*
   * 每换一个选中项，就把它的中心点报给 Android：
   *   - hover：原生补一个真实的鼠标悬停事件，让 CSS :hover 也生效
   *   - select：记住这块矩形，Android 在"确定键没能点中"时拿它兜底
   */
  let lastHover = { x: -1, y: -1 };

  function onHover(info) {
    if (!info || !info.el) {
      lastHover = { x: -1, y: -1 };
      try { if (win.kbHost && win.kbHost.hover) win.kbHost.hover(-1, -1); } catch { /* ignore */ }
      return;
    }
    const x = Math.round(info.x);
    const y = Math.round(info.y);
    if (x === lastHover.x && y === lastHover.y) return;
    lastHover = { x, y };
    try {
      if (win.kbHost && win.kbHost.select) {
        win.kbHost.select(x, y, Math.round(info.w || 0), Math.round(info.h || 0), info.label || '');
      }
    } catch { /* ignore */ }
    try {
      if (win.kbHost && win.kbHost.hover) win.kbHost.hover(x, y);
    } catch { /* ignore */ }
  }

  try { win.__kbOnHover = onHover; } catch { /* ignore */ }

  const api = {
    version: 1,
    key(action) {
      try {
        if (action === 'back') return back() === true;
        if (action === 'reset') {
          const c = win.__kb;
          if (c && typeof c.clearSelection === 'function') c.clearSelection();
          fitViewport();
          return true;
        }
        if (action === 'ready') return !!win.__kb;
        return dispatchKey(action);
      } catch { /* ignore */ }
      return false;
    },
    /** 页面切换后清掉残留的高亮框 */
    reset() {
      const c = win.__kb;
      if (c && typeof c.clearSelection === 'function') c.clearSelection();
      fitViewport();
      return true;
    },
    /** 请 Android 开一个新标签页 */
    openTab(url) {
      return routeNewTab(url);
    },
    /** 选中项上派发 kb-longpress（首屏的收藏/删除菜单用它） */
    longPress,
    status() {
      const c = win.__kb;
      return c ? { ok: true, index: c.currentIndex(), label: c.currentLabel() } : { ok: false };
    },
  };

  // Object.assign 只复制"当时已有"的属性，所以 __mounted 要在赋值前就挂好
  api.__mounted = true;
  win.__kbTV = Object.assign(win.__kbTV, api);

  fitViewport();
  installTabs();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', fitViewport, { once: true });

  // 通知 Android 端：桥已经就绪，可以把遥控器按键交过来了
  const notify = () => {
    try {
      if (win.kbHost && typeof win.kbHost.ready === 'function') win.kbHost.ready();
    } catch { /* ignore */ }
  };

  return { api, notify, fitViewport };
}

/**
 * 电视端启动：先按电视的偏好改设置，再挂桥。
 * win.__kb 由 keynav 主体在 autoBoot 之后写入。
 */
function tvBoot(win) {
  if (win.__kbTV && win.__kbTV.__mounted) return win.__kbTV;

  const bridge = tvInstall(win);
  if (!bridge) return null;
  bridge.api.__mounted = true;
  win.__kbTV = bridge.api;

  /** 主体挂上之后把浏览器专用的设置盖上去（enabled 一定为 true） */
  let applied = false;
  const applyProfile = () => {
    const c = win.__kb;
    if (!c || !c.settings) return false;
    Object.assign(c.settings, TV_PROFILE);
    try { win.localStorage.setItem('bili-keynav:settings', JSON.stringify(c.settings)); } catch { /* ignore */ }
    applied = true;
    return true;
  };

  // 页面重新布局、懒加载内容进场之后 viewport 可能被页面自己改掉，多补几次
  for (const ms of [0, 60, 200, 600, 1500, 3000]) {
    win.setTimeout(() => {
      if (!applied) applyProfile();
      bridge.fitViewport();
      if (applied) bridge.notify();
    }, ms);
  }

  // 主体可能到很晚才挂载（DOM 没就绪时 autoBoot 会等 DOMContentLoaded）
  let tries = 0;
  const timer = win.setInterval(() => {
    if (applyProfile()) { bridge.notify(); win.clearInterval(timer); }
    else if (++tries > 200) win.clearInterval(timer);
  }, 100);

  return bridge.api;
}
