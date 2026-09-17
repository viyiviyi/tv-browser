/*!
 * 电视浏览器 — 首屏
 *
 * 三件事：
 *   1. 按屏幕尺寸算出栅格（一个格子多大、一排能放几个），
 *      收藏超过一排就折叠出「更多」，最近打开只显示一排。
 *   2. 把 URL 变成"图标 + 名称"：图标在线抓站点自己的 favicon，
 *      失败就回落到首字母色块；常见站点配了中文名和品牌色。
 *   3. 长按确定键弹出「收藏 / 删除」菜单（原生识别长按，页面接事件）。
 *
 * 数据由原生推过来（window.tvHome.setData），这里只负责显示和交互。
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------ 搜索引擎 -- */

  var ENGINES = [
    { id: 'baidu', name: '百度', prefix: 'https://www.baidu.com/s?wd=' },
    { id: 'bing', name: '必应', prefix: 'https://cn.bing.com/search?q=' },
    { id: 'sogou', name: '搜狗', prefix: 'https://www.sogou.com/web?query=' },
    { id: 'google', name: '谷歌', prefix: 'https://www.google.com/search?q=' },
  ];

  /* -------------------------------------------------- 常见站点的名字与颜色 -- */

  /** 主域名 → 中文名（不在这张表里的就用域名本身当名字） */
  var NAMES = {
    'bilibili.com': '哔哩哔哩',
    'baidu.com': '百度',
    'weibo.com': '微博',
    'zhihu.com': '知乎',
    'taobao.com': '淘宝',
    'tmall.com': '天猫',
    'jd.com': '京东',
    'qq.com': '腾讯',
    'v.qq.com': '腾讯视频',
    'iqiyi.com': '爱奇艺',
    'youku.com': '优酷',
    'ixigua.com': '西瓜视频',
    'douban.com': '豆瓣',
    '163.com': '网易',
    'music.163.com': '网易云音乐',
    'cctv.com': '央视网',
    'tv.cctv.com': '央视影音',
    'sina.com.cn': '新浪',
    'sohu.com': '搜狐',
    'toutiao.com': '今日头条',
    'douyin.com': '抖音',
    'ximalaya.com': '喜马拉雅',
    'kuaishou.com': '快手',
    '12306.cn': '铁路12306',
    'amap.com': '高德地图',
    'github.com': 'GitHub',
    'youtube.com': 'YouTube',
    'wikipedia.org': '维基百科',
    'smzdm.com': '什么值得买',
    'zhihuishu.com': '智慧树',
  };

  /** 主域名 → 品牌色（没有的按域名哈希生成一个稳定的颜色） */
  var TINTS = {
    'bilibili.com': '#fb7299',
    'baidu.com': '#2932e1',
    'weibo.com': '#e6162d',
    'zhihu.com': '#0084ff',
    'taobao.com': '#ff5000',
    'tmall.com': '#ff0036',
    'jd.com': '#e1251b',
    'qq.com': '#12b7f5',
    'v.qq.com': '#ff7700',
    'iqiyi.com': '#00be06',
    'youku.com': '#1eb8ff',
    'ixigua.com': '#fa2a2a',
    'douban.com': '#2e963d',
    '163.com': '#c20c0c',
    'music.163.com': '#c20c0c',
    'cctv.com': '#c7000b',
    'tv.cctv.com': '#c7000b',
    'sina.com.cn': '#e6162d',
    'sohu.com': '#f5b800',
    'toutiao.com': '#f04142',
    'douyin.com': '#161823',
    'ximalaya.com': '#f86442',
    'kuaishou.com': '#ff5000',
    '12306.cn': '#3b7ede',
    'amap.com': '#00a6fb',
    'github.com': '#24292f',
    'youtube.com': '#ff0000',
    'wikipedia.org': '#636466',
    'smzdm.com': '#d93b3b',
  };

  /* ------------------------------------------------------------ DOM 引用 -- */

  var favGrid = document.getElementById('fav-grid');
  var favEmpty = document.getElementById('fav-empty');
  var recentGrid = document.getElementById('recent-grid');
  var recentEmpty = document.getElementById('recent-empty');
  var enginesBox = document.getElementById('engines');
  var form = document.getElementById('search');
  var input = document.getElementById('q');
  var sheet = document.getElementById('sheet');
  var sheetMask = document.getElementById('sheet-mask');
  var sheetTitle = document.getElementById('sheet-title');
  var sheetSite = document.getElementById('sheet-site');
  var sheetActions = document.getElementById('sheet-actions');

  /* -------------------------------------------------------------- 状态 -- */

  var S = {
    favorites: [],
    recent: [],
    engine: 'baidu',
    expanded: false,
    layout: { cell: 104, gap: 18, cols: 6 },
  };

  /* ------------------------------------------------------------ 小工具 -- */

  function clamp(lo, v, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /** 主域名：去掉 www. 之类的常见前缀，用来查名字/颜色/图标 */
  function hostOf(url) {
    try {
      var u = new URL(url);
      return u.hostname.replace(/^(www|m|mobile|wap)\./i, '') || u.hostname;
    } catch (e) {
      return '';
    }
  }

  function matchTable(table, host) {
    if (!host) return null;
    if (Object.prototype.hasOwnProperty.call(table, host)) return table[host];
    var parts = host.split('.');
    // 逐级往上找：v.qq.com → qq.com
    for (var i = 1; i < parts.length - 1; i++) {
      var key = parts.slice(i).join('.');
      if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    }
    return null;
  }

  function nameFor(url) {
    var host = hostOf(url);
    return matchTable(NAMES, host) || host || String(url || '').replace(/^https?:\/\//i, '');
  }

  function tintFor(url) {
    var host = hostOf(url);
    var t = matchTable(TINTS, host);
    if (t) return t;
    // 没有品牌色：按域名算一个稳定的颜色，同一个站点每次都是同一个色
    var n = 0;
    for (var i = 0; i < host.length; i++) n = (n * 31 + host.charCodeAt(i)) >>> 0;
    return 'hsl(' + (n % 360) + ', 42%, 40%)';
  }

  function initialFor(url) {
    var host = hostOf(url);
    var name = matchTable(NAMES, host);
    if (name) return name.slice(0, 1);
    return (host.replace(/^\W+/, '').slice(0, 1) || '?');
  }

  function normalize(url) {
    var s = String(url || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s;
  }

  /** 用户input 里打的是网址还是关键词 */
  function asUrl(text) {
    var t = String(text || '').trim();
    if (!t || /\s/.test(t)) return null;
    if (/^https?:\/\/\S+$/i.test(t)) return t;
    // example.com / example.com/path / 192.168.1.1:8080 —— 有域名形状就直接当网址
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t)) return 'https://' + t;
    if (/^localhost(:\d+)?(\/\S*)?$/.test(t)) return 'http://' + t;
    return null;
  }

  function engineById(id) {
    for (var i = 0; i < ENGINES.length; i++) {
      if (ENGINES[i].id === id) return ENGINES[i];
    }
    return ENGINES[0];
  }

  function isFavorite(url) {
    var u = normalize(url);
    for (var i = 0; i < S.favorites.length; i++) {
      if (normalize(S.favorites[i]) === u) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ 原生桥 -- */

  function native(method, arg) {
    try {
      if (window.kbHost && typeof window.kbHost[method] === 'function') {
        window.kbHost[method](arg);
        return true;
      }
    } catch (e) { /* 桥不在（比如用浏览器打开调试）时静默降级 */ }
    return false;
  }

  /** 打开一个网页：交给原生开新标签页，普通浏览器里就退化成新窗口 */
  function openUrl(url) {
    if (!/^https?:\/\//i.test(url)) return;
    if (!native('newTab', url)) {
      try { window.open(url, '_blank', 'noopener'); } catch (e) { /* ignore */ }
    }
  }

  /* -------------------------------------------------------------- 尺寸 -- */
  /*
   * 电视的逻辑分辨率差得很远（1080p 常见 960×540，也有 1920×1080），
   * 所以格子大小按"屏高的一小部分"来定，再受屏宽和上下限约束。
   */

  /** 图标格子的大小 = 算出来的基准值 × 这个比例（0.75 就是缩到四分之三） */
  var ICON_SCALE = 0.75;

  function applyLayout() {
    var W = document.documentElement.clientWidth || window.innerWidth || 960;
    var H = document.documentElement.clientHeight || window.innerHeight || 540;

    var cell = Math.round(clamp(84, Math.min(W * 0.155, H * 0.19), 168) * ICON_SCALE);
    var gap = Math.round(clamp(12, cell * 0.17, 26));
    var nameSize = Math.round(clamp(13, cell * 0.16, 22));

    /*
     * 一排能放几个：两边各让出一个图标的宽度当边距，
     * 剩下的宽度里能塞下几个格子就是几列。
     */
    var usable = W - cell * 2;
    var cols = Math.max(1, Math.floor((usable + gap) / (cell + gap)));

    var root = document.documentElement.style;
    root.setProperty('--cell', cell + 'px');
    root.setProperty('--gap', gap + 'px');
    root.setProperty('--name-size', nameSize + 'px');
    root.setProperty('--title-size', Math.round(clamp(15, cell * 0.19, 24)) + 'px');
    root.setProperty('--search-font', Math.round(clamp(17, cell * 0.22, 28)) + 'px');
    root.setProperty('--search-h', Math.round(clamp(46, cell * 0.58, 76)) + 'px');
    root.setProperty('--search-w', Math.round(clamp(320, W * 0.62, 760)) + 'px');

    S.layout = { cell: cell, gap: gap, cols: cols };
    return S.layout;
  }

  /* -------------------------------------------------------------- 卡片 -- */

  var FAVICON_CANDIDATES = ['/favicon.ico', '/favicon.png'];

  function loadFavicon(img, host) {
    if (!host) { img.remove(); return; }
    var tried = 0;
    function next() {
      if (tried >= FAVICON_CANDIDATES.length) { img.remove(); return; }
      var url = 'https://' + host + FAVICON_CANDIDATES[tried++];
      img.onerror = next;
      img.onload = function () {
        // 有的站点拿"找不到页"当 200 返回，解码不出图的时候自然尺寸是 0
        if (img.naturalWidth > 1 && img.naturalHeight > 1) {
          if (img.parentNode) img.parentNode.classList.add('has-icon');
        } else {
          next();
        }
      };
      img.src = url;
    }
    next();
  }

  /**
   * 一个网站卡片：图标 + 名称。
   * @param {string} url
   * @param {'fav'|'recent'} kind  长按菜单按它决定能做什么
   */
  function makeCard(url, kind) {
    var host = hostOf(url);

    var a = document.createElement('a');
    a.className = 'site';
    a.href = normalize(url);
    a.target = '_blank';          // 交给注入脚本变成"新标签页"
    a.rel = 'noopener';
    a.dataset.url = normalize(url);
    a.dataset.kind = kind;

    var icon = document.createElement('span');
    icon.className = 'icon';
    icon.style.setProperty('--tint', tintFor(url));

    var initial = document.createElement('span');
    initial.className = 'initial';
    initial.textContent = initialFor(url);

    var img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';

    icon.appendChild(initial);
    icon.appendChild(img);

    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = nameFor(url);

    a.appendChild(icon);
    a.appendChild(name);

    loadFavicon(img, host);
    return a;
  }

  var SVG_MORE = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round">'
    + '<path d="M6 9l6 6 6-6"></path></svg>';
  var SVG_LESS = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round">'
    + '<path d="M6 15l6-6 6 6"></path></svg>';

  function makeMoreButton(expanded) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'site';
    b.dataset.more = '1';

    var icon = document.createElement('span');
    icon.className = 'icon plain';
    icon.innerHTML = expanded ? SVG_LESS : SVG_MORE;

    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = expanded ? '收起' : '更多';

    b.appendChild(icon);
    b.appendChild(name);

    b.addEventListener('click', function (e) {
      e.preventDefault();
      S.expanded = !S.expanded;
      renderFavorites();
      // 折叠/展开会挪动后面的元素，把选中框重新画一下
      try { if (window.__kb && window.__kb.refresh) window.__kb.refresh(); } catch (err) { /* ignore */ }
    });
    return b;
  }

  /* -------------------------------------------------------------- 渲染 -- */

  function renderFavorites() {
    var cols = S.layout.cols;
    var list = S.favorites;

    favGrid.textContent = '';
    favEmpty.hidden = list.length > 0;
    if (!list.length) return;

    // 一排放不下就折叠：留出最后一个位置给「更多」
    var needMore = list.length > cols;
    var shown = (!needMore || S.expanded) ? list : list.slice(0, Math.max(1, cols - 1));

    for (var i = 0; i < shown.length; i++) {
      favGrid.appendChild(makeCard(shown[i], 'fav'));
    }
    if (needMore) favGrid.appendChild(makeMoreButton(S.expanded));
  }

  function renderRecent() {
    var cols = S.layout.cols;

    recentGrid.textContent = '';
    recentEmpty.hidden = S.recent.length > 0;
    if (!S.recent.length) return;

    // 最多只显示一排
    var shown = S.recent.slice(0, cols);
    for (var i = 0; i < shown.length; i++) {
      recentGrid.appendChild(makeCard(shown[i], 'recent'));
    }
  }

  function renderEngines() {
    enginesBox.textContent = '';
    for (var i = 0; i < ENGINES.length; i++) {
      (function (engine) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'engine' + (engine.id === S.engine ? ' on' : '');
        b.dataset.engine = engine.id;
        b.textContent = engine.name;
        b.addEventListener('click', function (e) {
          e.preventDefault();
          S.engine = engine.id;
          renderEngines();
          native('setEngine', engine.id);
          try { input.focus(); } catch (err) { /* ignore */ }
        });
        enginesBox.appendChild(b);
      })(ENGINES[i]);
    }
  }

  function renderAll() {
    renderFavorites();
    renderRecent();
    renderEngines();
  }

  /* ---------------------------------------------------------- 长按菜单 -- */

  function addAction(label, danger, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'act' + (danger ? ' danger' : '');
    b.textContent = label;
    b.addEventListener('click', function (e) {
      e.preventDefault();
      fn();
    });
    sheetActions.appendChild(b);
  }

  function openMenu(url, kind) {
    sheetTitle.textContent = normalize(url);
    sheetSite.textContent = nameFor(url);
    sheetActions.textContent = '';

    if (kind === 'recent') {
      if (isFavorite(url)) {
        addAction('取消收藏', false, function () {
          native('unfavorite', url);
          closeMenu();
        });
      } else {
        addAction('收藏这个网站', false, function () {
          native('favorite', url);
          closeMenu();
        });
      }
      addAction('从「最近打开」中删除', true, function () {
        native('forget', url);
        closeMenu();
      });
    } else {
      addAction('从收藏中移除', true, function () {
        native('unfavorite', url);
        closeMenu();
      });
    }

    sheet.hidden = false;

    // 清掉原来的选中框：菜单一盖上，方向键就该在菜单里走
    try { if (window.__kb && window.__kb.clearSelection) window.__kb.clearSelection(); } catch (e) { /* ignore */ }
  }

  function closeMenu() {
    if (sheet.hidden) return false;
    sheet.hidden = true;
    sheetActions.textContent = '';
    try { if (window.__kb && window.__kb.refresh) window.__kb.refresh(); } catch (e) { /* ignore */ }
    return true;
  }

  function menuOpen() {
    return !sheet.hidden;
  }

  // 长按确定键：原生识别长按，脚本在选中项上派发这个事件
  document.addEventListener('kb-longpress', function (e) {
    if (menuOpen()) return;
    var card = e.target && e.target.closest ? e.target.closest('.site') : null;
    if (!card || !card.dataset.url) return;
    e.preventDefault();
    openMenu(card.dataset.url, card.dataset.kind || 'recent');
  }, true);

  // 返回键：菜单开着就关菜单，别让它一路退到关标签页
  document.addEventListener('kb-back', function (e) {
    if (!menuOpen()) return;
    e.preventDefault();
    closeMenu();
  }, true);

  sheetMask.addEventListener('click', function () { closeMenu(); });

  /* ------------------------------------------------------------ 搜索 -- */

  function doSearch() {
    var text = input.value.trim();
    if (!text) return;

    var direct = asUrl(text);
    if (direct) {
      openUrl(direct);
    } else {
      var engine = engineById(S.engine);
      openUrl(engine.prefix + encodeURIComponent(text));
    }

    input.value = '';
    try { input.blur(); } catch (e) { /* ignore */ }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    doSearch();
  });

  input.addEventListener('keydown', function (e) {
    // 输入框里回车就搜（和提交表单是同一条路）
    if (e.key === 'Enter') {
      e.preventDefault();
      doSearch();
    }
  });

  /* -------------------------------------------------------- 原生推数据 -- */

  window.tvHome = {
    /**
     * @param {string|object} payload
     *   {
     *     favorites: ["https://...", ...],
     *     recent:    ["https://...", ...],
     *     engine:    "baidu" | "bing" | "sogou" | "google"
     *   }
     */
    setData: function (payload) {
      var d = payload;
      try {
        if (typeof payload === 'string') d = JSON.parse(payload);
      } catch (e) {
        return { ok: false, error: 'payload 不是合法 JSON' };
      }
      if (!d || typeof d !== 'object') return { ok: false, error: 'payload 不是对象' };

      if (Object.prototype.toString.call(d.favorites) === '[object Array]') {
        S.favorites = d.favorites.map(normalize).filter(Boolean);
      }
      if (Object.prototype.toString.call(d.recent) === '[object Array]') {
        S.recent = d.recent.map(normalize).filter(Boolean);
      }
      if (typeof d.engine === 'string' && d.engine) S.engine = d.engine;

      renderAll();
      return { ok: true, favorites: S.favorites.length, recent: S.recent.length };
    },

    /** 一排能放几个（测试用） */
    layout: function () {
      return { cell: S.layout.cell, gap: S.layout.gap, cols: S.layout.cols };
    },

    state: function () {
      return {
        favorites: S.favorites.slice(),
        recent: S.recent.slice(),
        engine: S.engine,
        expanded: S.expanded,
        cols: S.layout.cols,
      };
    },
  };

  /* -------------------------------------------------------------- 启动 -- */

  function focusSearch() {
    var tries = 0;
    var timer = setInterval(function () {
      var c = window.__kb;
      if (c && typeof c.refresh === 'function' && typeof c.selectAt === 'function') {
        clearInterval(timer);
        try {
          var list = c.refresh();
          for (var i = 0; i < list.length; i++) {
            if (list[i].el === input) { c.selectAt(i); return; }
          }
        } catch (e) { /* ignore */ }
      } else if (++tries > 40) {
        clearInterval(timer);
      }
    }, 100);
  }

  function onResize() {
    var before = S.layout.cols;
    applyLayout();
    if (S.layout.cols !== before) renderAll();
  }

  window.addEventListener('resize', onResize);

  applyLayout();
  renderAll();
  focusSearch();
})();
