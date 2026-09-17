/*!
 * tv-browser v1.0.0 — 电视浏览器遥控器导航（Android WebView 内注入）
 *
 * 导航引擎来自 bili-keynav（空间导航：↑↓←→ 选元素、确定点击），
 * 遥控器桥接层来自 src-web/web-bridge.js。
 *
 * 本文件是 tools/build-nav.mjs 的产物，不要手改。
 * 许可：MIT
 */
(function () {
'use strict';

/* 夜间模式：浏览器要忠实呈现网站，不注入任何站点专属主题 */
const DARK_THEME_CSS = '';

/* ===================== bili-keynav/src/core.js ===================== */
/*!
 * bili-keynav — core engine
 *
 * Pure-ish DOM module: collects keyboard-navigable targets on a Bilibili page and
 * answers spatial queries ("which target is to the right/below the current one?"),
 * plus activation and back-navigation helpers.
 *
 * No framework, no network, no globals beyond the ones it is handed.
 * Loaded by the userscript bundle; also importable from node tests.
 */

/** Rect helpers ----------------------------------------------------------- */

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function center(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function overlap1d(a1, aLen, b1, bLen) {
  // length of the overlap between [a1,a1+aLen] and [b1,b1+bLen]
  const lo = Math.max(a1, b1);
  const hi = Math.min(a1 + aLen, b1 + bLen);
  const over = hi - lo;
  return Number.isFinite(over) ? Math.max(0, over) : 0;
}

/**
 * Score a candidate as a directional neighbour of `base`.
 * Returns null when the candidate is not in the requested direction.
 *
 * Model: a "beam" leaving the base rect on the requested side.
 *   - moving along the axis (dist) must be > 0
 *   - candidates overlapping the beam's cross-section are strongly preferred
 *   - other candidates are still allowed, penalised by how far off-axis they are
 *     and by extra travel distance, so grids/rows/columns behave predictably.
 */
function scoreCandidate(base, cand, dir, opts = {}) {
  const maxAnglePenalty = opts.maxAnglePenalty ?? 0.25;
  const sideBias = opts.sideBias ?? 0.02;
  /** 垂直方向至少要重叠候选高度/宽度的这个比例，才算"同一行 / 同一列" */
  const alignRatio = opts.alignRatio ?? 0.25;

  const b = center(base);
  const c = center(cand);
  const dx = c.x - b.x;
  const dy = c.y - b.y;
  // distance between rects along the axis (0 when they overlap / are side by side)
  const axisGapX = dir === 'left' ? base.x - (cand.x + cand.w)
    : dir === 'right' ? cand.x - (base.x + base.w)
      : 0;
  const axisGapY = dir === 'up' ? base.y - (cand.y + cand.h)
    : dir === 'down' ? cand.y - (base.y + base.h)
      : 0;

  const horizontal = dir === 'left' || dir === 'right';
  const vertical = dir === 'up' || dir === 'down';

  let dist, perp, travel;
  if (dir === 'left') {
    if (dx >= 0) return null;
    dist = Math.max(0, axisGapX);
  } else if (dir === 'right') {
    if (dx <= 0) return null;
    dist = Math.max(0, axisGapX);
  } else if (dir === 'up') {
    if (dy >= 0) return null;
    dist = Math.max(0, axisGapY);
  } else if (dir === 'down') {
    if (dy <= 0) return null;
    dist = Math.max(0, axisGapY);
  } else {
    return null;
  }

  /*
   * "同一行 / 同一列"的判据：垂直于行进方向的投影要有实质重叠。
   *
   * 只要有一点点重叠（哪怕 2px）就算同行的话，下一行里稍微往上冒头的
   * 那张卡也会被判成"右边的目标"，于是按 → 就跳到下面一行去了 ——
   * 这正是一直"选不准"的原因，所以这里要求重叠达到较小边长的 25%。
   */
  const overlap = horizontal
    ? overlap1d(base.y, base.h, cand.y, cand.h)
    : overlap1d(base.x, base.w, cand.x, cand.w);
  const minSpan = horizontal ? Math.min(base.h, cand.h) : Math.min(base.w, cand.w);
  const aligned = minSpan > 0 && overlap >= Math.max(2, minSpan * alignRatio);

  if (vertical) {
    perp = aligned ? 0 : Math.abs(dx);
    travel = dist + Math.abs(dx) * 0.5;
  } else {
    perp = aligned ? 0 : Math.abs(dy);
    travel = dist + Math.abs(dy) * 0.5;
  }

  const diag = Math.hypot(dx, dy) || 1;
  const angle = Math.min(1, Math.abs(perp) / diag);
  const score = travel * (1 + maxAnglePenalty * (angle / 0.7071)) + sideBias * dist;
  return { dir, dist, perp, travel, angle, aligned, score };
}

/** Candidate collection --------------------------------------------------- */

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  '[onclick]',
].join(',');

const DEFAULT_OPTS = {
  /** elements that must never become targets */
  skipSelector: '[data-kb-skip], .kb-hint, #kb-hud',
  /** extra selectors that are treated as targets even without aria/role/tabindex */
  extraSelector: '[data-kb-target]',
  /** smallest clickable area to consider (filters decorative 1px links) */
  minArea: 100,
  /** reject candidates wider/taller than this fraction of the viewport */
  maxViewportFraction: 0.92,
  /** how deep a scroll container may nest before we stop ascending */
  maxScrollAncestors: 24,
};

function isVisible(el, win) {
  if (el.hidden) return false;
  const view = win || el.ownerDocument.defaultView;
  const cs = view.getComputedStyle(el);
  if (!cs) return false;
  if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
  if (cs.opacity !== '' && Number(cs.opacity) === 0) return false;
  if (cs.display === 'none') return false;
  if (cs.pointerEvents === 'none') return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return true;
}

function isTopmostClickable(el, doc) {
  // the element (or one of its descendants) must own the point at its centre
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > doc.documentElement.clientWidth || y > doc.documentElement.clientHeight) {
    return true; // cannot test; assume ok (scrolled out of view is handled elsewhere)
  }
  const top = doc.elementFromPoint(x, y);
  if (!top) return true;
  return top === el || el.contains(top) || top.contains(el);
}

/**
 * Walk up from a raw element to the element that should actually receive the click.
 * Bilibili wraps cards in <div class="bili-video-card"><a href=...>, but also uses
 * cursor:pointer divs; we resolve both.
 */
function resolveClickable(el, win) {
  const doc = el.ownerDocument;
  const view = win || doc.defaultView;
  let node = el;
  for (let i = 0; node && i < 6; i++) {
    if (node.nodeType !== 1) break;
    const cs = view.getComputedStyle(node);
    if (node.matches('a[href]') || /^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(node.tagName)) return node;
    if (node.getAttribute('role') === 'button' || node.hasAttribute('onclick')) return node;
    if (cs && cs.cursor === 'pointer') return node;
    node = node.parentElement;
  }
  return el;
}

/**
 * 文本输入类控件：可以成为导航目标（这样方向键能选中搜索框、按 Enter 进去打字），
 * 但一旦它拿到焦点，方向键就归还给它用于移动光标。
 */
function isTextField(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return ['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date',
    'datetime-local', 'month', 'week', 'time'].includes(type);
}

/**
 * Collect navigable targets.
 * @param {Document} doc
 * @param {object} [opts]
 */
function collectTargets(doc, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const view = doc.defaultView;
  const vw = doc.documentElement.clientWidth || view.innerWidth;
  const vh = doc.documentElement.clientHeight || view.innerHeight;
  const selector = `${INTERACTIVE_SELECTOR},${o.extraSelector}`;

  let nodes;
  try {
    nodes = [...doc.querySelectorAll(selector)];
  } catch {
    nodes = [];
  }
  const raw = [];
  const seen = new Set();
  for (const node of nodes) {
    if (node.closest(o.skipSelector)) continue;
    if (node.disabled) continue;
    if (node.getAttribute('aria-hidden') === 'true') continue;
    if (node.tabIndex < 0 && !node.hasAttribute('data-kb-target') && !node.hasAttribute('onclick')) continue;
    if (!isVisible(node, view)) continue;
    const el = resolveClickable(node, view);
    if (el.closest(o.skipSelector)) continue;
    if (!isVisible(el, view)) continue;
    if (seen.has(el)) continue;
    const r = rectOf(el);
    if (r.w * r.h < o.minArea) continue;
    // 整屏元素（弹层遮罩等）不应该成为目标，否则会把卡片全挡住。
    // 例外是显式标了 data-kb-target 的：视频窗口本来就可能占满整个屏幕
    //（播放器一进全屏就是整屏），那是用户真要选的东西，不能按遮罩滤掉。
    const explicit = el.hasAttribute('data-kb-target') || node.hasAttribute('data-kb-target');
    if (!explicit && r.w > vw * o.maxViewportFraction && r.h > vh * o.maxViewportFraction) continue;
    if (!isTopmostClickable(el, doc)) continue;
    seen.add(el);
    raw.push({ el, rect: r, cursor: cursorOf(el, view), stuck: isStuck(el, view, r, vh) });
  }
  return collapseContained(raw);
}

/**
 * 是否是"吸附在视口顶部"的导航元素。
 * 判据是**它的容器被钉在视口顶部**（sticky/fixed 且 top≈0），
 * 而不是元素自己贴顶 —— 吸顶栏里的链接通常位于 y=16 左右。
 * 这类元素在页面滚下去之后仍然停在原地，会一直参与方向判断并"截胡"。
 */
function isStuck(el, view, r, vh) {
  const container = findStickyContainer(el, view, vh);
  if (!container) return false;
  // 判据是"容器被钉在视口顶部"，不是元素自己贴顶：
  // B 站顶栏 64px 高，里面的链接在 y=16、搜索框在 y=12，
  // 只要容器钉住了，它们都属于吸顶区。
  const cr = rectOf(container);
  if (cr.y > 8) return false;
  // 输入框（搜索框）除外：它是用户真正想选的目标，不该被当成"导航栏"挡掉。
  // 它在向下方向上的循环问题由调用方的方向规则处理。
  return !isTextField(el);
}

function positionOf(el, view) {
  try {
    return view.getComputedStyle(el).position || '';
  } catch {
    return '';
  }
}

function findStickyContainer(el, view, vh) {
  let node = el;
  for (let i = 0; node && i < 8; i++) {
    const pos = positionOf(node, view);
    const r = rectOf(node);
    const isWide = r.w > 200 || node === el;
    if (pos === 'fixed') {
      if (isWide && r.h < vh * 0.6 && r.y <= 8) return node;
      return null;
    }
    if (pos === 'sticky') {
      if (isWide && r.h > 16 && r.h < vh * 0.6 && r.y <= 8) return node;
      return null;
    }
    node = node.parentElement;
  }
  return null;
}

function cursorOf(el, view) {
  try {
    return view.getComputedStyle(el).cursor || '';
  } catch {
    return '';
  }
}

/**
 * 折叠嵌套候选：B 站很多卡片是 <a> 套 <div class="bili-video-card"> 这种结构，
 * 两者矩形几乎重合，只保留最外层（且最好带 pointer 光标）的那个，
 * 否则同一张卡片会出现两个候选，方向键要在里面多按一次。
 */
function collapseContained(list) {
  if (list.length < 2) return list;
  const sorted = [...list].sort((a, b) => {
    const da = depthOf(a.el);
    const db = depthOf(b.el);
    if (da !== db) return da - db;                       // 外层优先
    return (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h);
  });
  const kept = [];
  for (const cand of sorted) {
    let swallowed = false;
    for (let i = 0; i < kept.length; i++) {
      const outer = kept[i];
      if (!isVisualDuplicate(outer.rect, cand.rect)) continue;
      if (isAncestorOf(outer.el, cand.el)) {
        swallowed = true;       // 真·祖先关系：外层就是用户真正点在的那张卡片
        break;
      }
      // 不是父子关系却视觉重合（浮层/重复节点）：优先保留带 pointer 光标的
      if (cand.cursor === 'pointer' && outer.cursor !== 'pointer') kept[i] = cand;
      swallowed = true;
      break;
    }
    if (!swallowed) kept.push(cand);
  }
  return kept;
}

/** 元素在 DOM 中的嵌套深度（只用于“外层优先”的取舍） */
function depthOf(el) {
  let d = 0;
  let node = el && el.parentElement;
  while (node && d < 64) { d++; node = node.parentElement; }
  return d;
}

/** a 是否是 b 的祖先（b 自身不算） */
function isAncestorOf(a, b) {
  let node = b ? b.parentElement : null;
  while (node) {
    if (node === a) return true;
    node = node.parentElement;
  }
  return false;
}

function containsRect(outer, inner) {
  const tol = 1.5;
  return inner.x >= outer.x - tol
    && inner.y >= outer.y - tol
    && inner.x + inner.w <= outer.x + outer.w + tol
    && inner.y + inner.h <= outer.y + outer.h + tol;
}

/**
 * 视觉上"就是同一个东西"：内层被外层包住，且两个方向都覆盖了 90% 以上。
 * 用于区分「<a> 套卡片 div」（同一张卡片，要合并）和
 * 「卡片里的小按钮」（点赞/三连，不能合并）。
 */
function isVisualDuplicate(outer, inner) {
  if (!containsRect(outer, inner)) return false;
  const wRatio = outer.w > 0 ? inner.w / outer.w : 1;
  const hRatio = outer.h > 0 ? inner.h / outer.h : 1;
  return wRatio >= 0.9 && hRatio >= 0.9;
}

/** Geometry for beams ----------------------------------------------------- */

function rectUnion(rects) {
  if (!rects.length) return null;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Scroll containers ------------------------------------------------------ */

function isScrollable(el, view) {
  if (!el || el.nodeType !== 1) return false;
  if (el === el.ownerDocument.scrollingElement) return true;
  const cs = view.getComputedStyle(el);
  if (!cs) return false;
  const oy = cs.overflowY;
  const ox = cs.overflowX;
  const canY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
  const canX = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && el.scrollWidth > el.clientWidth + 1;
  return canY || canX;
}

function scrollAncestors(el, view) {
  const chain = [];
  let node = el;
  while (node && chain.length < DEFAULT_OPTS.maxScrollAncestors) {
    if (isScrollable(node, view)) chain.push(node);
    node = node.parentElement;
  }
  const se = el.ownerDocument.scrollingElement;
  if (se && !chain.includes(se)) chain.push(se);
  return chain;
}

/** Directional search ----------------------------------------------------- */

const DELTA = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };

/**
 * Best neighbour of `base` (a {el,rect}) among `targets` in direction `dir`.
 * `region` optionally widens the beam (used to treat visually grouped items as one).
 */
function findNeighbour(targets, base, dir, opts = {}) {
  const d = DELTA[dir];
  if (!d) return null;
  const baseRect = opts.baseRect || base.rect;
  const accept = opts.accept; // (cand) => boolean
  const exclude = opts.exclude; // Set<Element>
  let best = null;
  let bestAligned = null;
  for (const cand of targets) {
    if (cand.el === base.el) continue;
    if (exclude && exclude.has(cand.el)) continue;
    if (accept && !accept(cand)) continue;
    const s = scoreCandidate(baseRect, cand.rect, dir, opts);
    if (!s) continue;
    const entry = { ...s, target: cand };
    if (!best || s.score < best.score) best = entry;
    if (s.aligned && (!bestAligned || s.score < bestAligned.score)) bestAligned = entry;
  }
  /*
   * 整行/整列优先：只要"同一行里右边还有东西"，就选它。
   *
   * 只按距离打分时会出现这种情况：一个按钮就在右边，但它的横向间距比
   * 下一行那张卡的纵向间距大，于是按 → 反而跳到了下面一行。空间导航的
   * 直觉是"同一排里最近的"，所以先在同一排（同行/同列）里挑，
   * 那一排没人可用时才放宽到斜着走。
   */
  return bestAligned || best;
}

/**
 * 朝某个方向走一步。
 * 返回与 findNeighbour 相同形状的 { target, score, ... }，没有则返回 null。
 * 若第一候选完全在视口外（例如被滚过去的一屏），沿同一条光束继续往后找。
 */
function nextInDirection(targets, base, dir, opts = {}) {
  const first = findNeighbour(targets, base, dir, opts);
  if (!first) return null;
  const hit = first.target;
  const visible = hit.rect.y + hit.rect.h > 0
    && hit.rect.y < (opts.viewportHeight ?? Infinity)
    && hit.rect.x + hit.rect.w > 0
    && hit.rect.x < (opts.viewportWidth ?? Infinity);
  if (visible || opts.allowOffscreen) return first;
  const exclude = new Set([hit.el, ...(opts.exclude || [])]);
  return nextInDirection(targets, base, dir, { ...opts, exclude, allowOffscreen: true });
}

/** Activation -------------------------------------------------------------- */

function describe(el) {
  const text = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    tag: el.tagName.toLowerCase(),
    href: el.getAttribute('href') || '',
    text: text.slice(0, 80),
  };
}

/* ===================== bili-keynav/src/app.js ====================== */
/*!
 * bili-keynav — main script
 *
 * 可插拔的按键导航层：只在按键按下时才去查询页面里的可点元素，
 * 上下左右选择、回车点击、ESC 回退。
 */


const STORE_KEY = 'bili-keynav:settings';

const DEFAULT_SETTINGS = {
  /** 关闭后所有按键行为恢复原生（默认开，也随时能用 Esc/控制台改回来） */
  enabled: true,
  /** 顺带注入夜间模式（bilibili-dark-theme.css，打包时已嵌进脚本，见 build/bundle.mjs） */
  darkTheme: true,
  /** 鼠标悬停在播放器上时放行方向键（交给 B 站自己的快退/快进） */
  playerPassthrough: true,
  /** ESC 兜底：历史里没有可回退的 B 站页面时，回到首页 */
  escFallbackHome: true,
  /** 候选元素最小面积，过滤装饰性小链接 */
  minArea: 100,
  /** 高亮框距离视口边缘的最小留白 */
  scrollMargin: 24,
  /** 提示条停留时间 (ms) */
  hintDuration: 2200,
  /** 播放器上"单击/双击"的判定窗口 (ms)：在这个时间内按第二下算双击（=全屏） */
  doublePressMs: 300,
};

const SETTINGS = loadSettings();

function loadSettings() {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings() {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(SETTINGS));
  } catch { /* ignore */ }
  return SETTINGS;
}

const BILI_HOST = /(^|\.)bilibili\.com$|(^|\.)b23\.tv$/;

function isEditable(el) {
  return isTextField(el);
}

function isPlayerZone(el) {
  return !!(el && el.closest && el.closest('.bpx-player-container, .bilibili-player, #bilibili-player, .bpx-player-video-wrap'));
}

/* ------------------------------------------------------------ 播放器 -- */
/*
 * 播放器这块的规则（和遥控器/键盘都对得上）：
 *   选中播放器   → 确定 = 播放/暂停（双击 = 全屏）
 *   全屏播放中   → 方向键归播放器（快退快进 / 音量），确定仍然是播放/暂停、双击退出全屏
 *   全屏时不再给页面打悬停、也不再画选中框 —— B 站的控制栏是靠 :hover 撑着的，
 *   一直悬停它就永远缩不回去，这就是"全屏时进度条浮层赖着不走"的原因。
 */

const PLAYER_SELECTOR = '.bpx-player-container, .bilibili-player, #bilibili-player, video';

function nativeFullscreenElement(doc) {
  try {
    return doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || null;
  } catch {
    return null;
  }
}

function playerContainer(doc) {
  try {
    return doc.querySelector(PLAYER_SELECTOR);
  } catch {
    return null;
  }
}

function videoOf(container) {
  if (!container || !container.querySelector) return null;
  try {
    if (container.tagName === 'VIDEO') return container;
    return container.querySelector('video');
  } catch {
    return null;
  }
}

/**
 * 播放器当前的全屏状态：
 *   'native' 浏览器原生全屏；'full' B 站的"全屏"；'web' B 站的"网页全屏"；null 没全屏
 */
function playerScreenMode(doc, container) {
  if (nativeFullscreenElement(doc)) return 'native';
  const c = container || playerContainer(doc);
  if (!c) return null;
  try {
    const flag = (c.getAttribute('data-screen') || '').toLowerCase();
    if (flag === 'full' || flag === 'web') return flag;
  } catch { /* ignore */ }
  // 兜底：B 站的网页全屏就是把播放器钉成整屏，这里按几何判断
  try {
    const view = doc.defaultView;
    const pos = view.getComputedStyle(c).position;
    if (pos !== 'fixed' && pos !== 'absolute') return null;
    const r = c.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth || 0;
    const vh = doc.documentElement.clientHeight || 0;
    if (vw > 0 && vh > 0 && r.width >= vw * 0.95 && r.height >= vh * 0.95) return 'web';
  } catch { /* ignore */ }
  return null;
}

/** 页面是不是处在"播放器全屏"状态：这时候方向键/回车归播放器 */
function isFullscreen(doc) {
  return playerScreenMode(doc) !== null;
}

/** 让播放器容器成为可选目标（遥控器方向键能选到视频窗口） */
function markPlayerTarget(doc) {
  const c = playerContainer(doc);
  if (!c) return null;
  try {
    if (!c.hasAttribute('data-kb-target')) c.setAttribute('data-kb-target', '');
  } catch { /* ignore */ }
  return c;
}

/** 元素自身是否“可点”（不含从父级继承来的 pointer 光标） */
function isClickableElement(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.matches('a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick]')) return true;
  return el.hasAttribute('data-kb-target');
}

/** 元素中心点最上层真正接收点击的元素 */
function topElementAt(el, doc) {
  const r = rectOf(el);
  const x = Math.min(Math.max(r.x + r.w / 2, 0), (doc.documentElement.clientWidth || 1) - 1);
  const y = Math.min(Math.max(r.y + r.h / 2, 0), (doc.documentElement.clientHeight || 1) - 1);
  return doc.elementFromPoint(x, y);
}

/** 命中该点、且属于目标元素的可点击元素 */
function hitTest(el, doc) {
  const top = topElementAt(el, doc);
  if (!top) return null;
  let node = top;
  while (node && node !== doc.documentElement) {
    if (el === node || el.contains(node)) return resolveClickable(node, doc.defaultView);
    node = node.parentElement;
  }
  return null;
}

/* ------------------------------------------------------------------ HUD -- */

const CSS = `
#kb-root, #kb-root * { box-sizing: border-box; }
#kb-root { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
#kb-box { position: absolute; top: 0; left: 0; border: 2px solid #00aeec; border-radius: 8px; box-shadow: 0 0 0 1px rgba(0,174,236,.35), 0 0 18px rgba(0,174,236,.35); background: rgba(0,174,236,.10); transition: all .07s ease-out; opacity: 0; }
#kb-box.kb-on { opacity: 1; }
#kb-hint { position: absolute; top: 0; left: 0; padding: 7px 10px; border-radius: 8px; background: rgba(24,25,28,.94); color: #fff; font-size: 12px; line-height: 1.5; max-width: 78vw; word-break: break-all; box-shadow: 0 6px 20px rgba(0,0,0,.35); opacity: 0; transform: translateY(-4px); transition: opacity .15s, transform .15s; }
#kb-hint.kb-on { opacity: 1; transform: translateY(0); }
#kb-hint .kb-k { display: inline-block; padding: 0 5px; margin: 0 1px; border-radius: 4px; background: #33363d; color: #b8e6ff; font-family: ui-monospace, Consolas, monospace; }
#kb-hint .kb-lbl { color: #ffd666; }
#kb-hint .kb-dim { color: #9aa0a6; }
`;

function mountUI(doc) {
  const root = doc.createElement('div');
  root.id = 'kb-root';
  root.innerHTML = `
    <div id="kb-box" data-kb-skip></div>
    <div id="kb-hint" data-kb-skip></div>`;

  const style = doc.createElement('style');
  style.textContent = CSS;
  const host = doc.head || doc.documentElement;
  host.appendChild(style);
  mountDarkTheme(doc);
  (doc.body || doc.documentElement).appendChild(root);

  return {
    root,
    box: root.querySelector('#kb-box'),
    hint: root.querySelector('#kb-hint'),
  };
}

/**
 * 夜间模式：把 bilibili-dark-theme.css 注进页面。
 *
 * CSS 内容在打包时就嵌进了脚本（见 build/bundle.mjs），所以油猴脚本不用额外
 * 声明 @resource、也不发额外网络请求。文件本身用
 * `@media (prefers-color-scheme: dark)` 包着：系统/浏览器是深色时才生效。
 * 想去掉这个限制就改那个 CSS 文件（把 @media 那两行去掉）。
 *
 * 不要了就把设置里的 darkTheme 改成 false：
 *   __KB__.SETTINGS.darkTheme = false; location.reload();
 */
function mountDarkTheme(doc) {
  const css = typeof DARK_THEME_CSS === 'string' ? DARK_THEME_CSS : '';
  if (!css || !SETTINGS.darkTheme) return null;
  if (doc.querySelector('style[data-kb-dark]')) return null;   // 重复注入只留一份
  const host = doc.head || doc.documentElement;
  if (!host) return null;          // 文档才刚开始，连 <html> 都没有
  const style = doc.createElement('style');
  style.id = 'kb-dark';
  style.setAttribute('data-kb-dark', '');
  style.textContent = css;
  host.appendChild(style);
  return style;
}

/*
 * 脚本一被求值就把夜间模式挂上 —— 不等 DOMContentLoaded、不等 body 出来。
 *
 * 这样"注入脚本"和"样式生效"是同一时刻，页面还没按浅色画第一帧就已经是深色了，
 * 不会先闪一下白底。
 *
 * 极端情况：Android 的"文档开始脚本"是在**文档刚建好、连 documentElement 都还没有**
 * 的时候执行的，所以这里还要盯着它出现，一出现就挂（仍然早于首帧）。
 */
function mountDarkThemeEarly() {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return;
  const css = typeof DARK_THEME_CSS === 'string' ? DARK_THEME_CSS : '';
  if (!css || !SETTINGS.darkTheme) return;

  const done = () => !!mountDarkTheme(doc) || !!doc.querySelector('style[data-kb-dark]');
  if (done()) return;

  let tries = 0;
  const timer = setInterval(() => {
    if (done() || ++tries > 500) clearInterval(timer);
  }, 1);
  try {
    doc.addEventListener('DOMContentLoaded', () => { done(); clearInterval(timer); }, { once: true });
  } catch { /* ignore */ }
}

mountDarkThemeEarly();

/* ------------------------------------------------------------- controller - */

function createController(win) {
  const doc = win.document;
  const state = {
    active: false,
    current: null,
    /** 被"取消选中"记住的那个目标：下次按方向键从这里接着走 */
    lastTarget: null,
    targets: null,
    targetsAt: 0,
    index: 0,
    hintTimer: 0,
    activating: false,
  };
  const ui = mountUI(doc);
  let dirty = true;

  const invalidate = () => { dirty = true; };

  function targetList(force) {
    const now = Date.now();
    const needCollect = force || dirty || !state.targets || now - state.targetsAt > 800;
    if (needCollect) {
      markPlayerTarget(doc);          // 视频窗口也要能被选中
      state.targets = collectTargets(doc, { minArea: SETTINGS.minArea });
      state.targetsAt = now;
      dirty = false;
      state.rectsAt = now;
    } else if (now - (state.rectsAt || 0) > 60) {
      // 重新测量坐标：页面的懒加载/调整会移动元素，过期坐标会让方向判断失灵
      refreshRects();
    }
    return state.targets;
  }

  function findTargetFor(el) {
    if (!el) return null;
    const list = targetList();
    const hit = list.find((t) => t.el === el || t.el.contains(el));
    if (hit) return hit;
    let node = el.parentElement;
    for (let i = 0; node && i < 6; i++) {
      const up = list.find((t) => t.el === node);
      if (up) return up;
      node = node.parentElement;
    }
    return null;
  }

  /** 目标内部的更深一层可点元素（例如卡片里的三连按钮） */
  function innerTargetOf(t, x, y) {
    let best = null;
    for (const cand of targetList()) {
      if (cand.el === t.el || !t.el.contains(cand.el)) continue;
      const r = cand.rect;
      if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
      if (!isClickableElement(cand.el)) continue;
      if (!best || cand.rect.w * cand.rect.h < best.rect.w * best.rect.h) best = cand;
    }
    return best;
  }

  /** 第一次按键时挑一个合理的起点：视口内、靠上、靠左的第一个卡片 */
  function pickInitialTarget() {
    const list = targetList(true);
    if (!list.length) return null;
    const vh = doc.documentElement.clientHeight || win.innerHeight;
    const inView = list.filter((t) => t.rect.y + t.rect.h > 40 && t.rect.y < vh * 0.9);
    const pool = inView.length ? inView : list;
    let best = null;
    for (const t of pool) {
      if (t.rect.w < 80 || t.rect.h < 40) continue;   // 跳过导航小链接
      if (isTextField(t.el)) continue;                // 也不要把输入框当起点
      if (!best || t.rect.y < best.rect.y - 4 || (Math.abs(t.rect.y - best.rect.y) <= 4 && t.rect.x < best.rect.x)) best = t;
    }
    if (best) return best;
    // 整页只有输入框之类的情况：退而求其次
    return pool.find((t) => t.rect.w >= 80 && t.rect.h >= 40) || pool[0];
  }

  function markDirtyOnMutations() {
    const obs = new win.MutationObserver(() => {
      invalidate();
      // 播放器进出全屏是靠 data-screen 属性变的（不是 fullscreenchange 事件），
      // 这里顺手把选中框/悬停同步一次
      syncFullscreenVisuals();
    });
    obs.observe(doc.body || doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'href', 'data-screen'] });
    return obs;
  }

  function showHint(html, duration = SETTINGS.hintDuration) {
    ui.hint.innerHTML = html;
    ui.hint.classList.add('kb-on');
    clearTimeout(state.hintTimer);
    if (duration > 0) {
      state.hintTimer = win.setTimeout(() => ui.hint.classList.remove('kb-on'), duration);
    }
    positionHint();
  }

  function positionHint() {
    const rect = state.current ? state.current.rect : null;
    const vh = doc.documentElement.clientHeight || win.innerHeight;
    const vw = doc.documentElement.clientWidth || win.innerWidth;
    const below = !rect || rect.y + rect.h + 70 < vh;
    const top = rect ? (below ? rect.y + rect.h + 12 : Math.max(8, rect.y - 52)) : 16;
    const left = rect ? Math.min(Math.max(rect.x, 8), Math.max(8, vw - 300)) : 16;
    ui.hint.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function drawBox(animate = false) {
    syncFullscreenVisuals();
    // 全屏看片时不画选中框、不显示提示条：屏幕上只剩视频，
    // 而且此时也不该再给页面打悬停（否则控制栏会一直赖着不缩回去）
    if (isPlayerFullscreen()) {
      ui.box.classList.remove('kb-on');
      ui.hint.classList.remove('kb-on');
      return;
    }
    if (!state.current) {
      ui.box.classList.remove('kb-on');
      return;
    }
    const r = rectOf(state.current.el);
    state.current.rect = r;
    ui.box.style.transform = `translate(${Math.round(r.x - 3)}px, ${Math.round(r.y - 3)}px)`;
    ui.box.style.width = `${Math.round(r.w + 6)}px`;
    ui.box.style.height = `${Math.round(r.h + 6)}px`;
    ui.box.classList.add('kb-on');
    void animate;
    positionHint();
    syncHover();
  }

  function label(t) {
    const d = describe(t.el);
    const text = d.text || d.href || d.tag;
    return text.length > 42 ? `${text.slice(0, 42)}…` : text;
  }

  /* --------------------------------------------------------------- hover -- */
  /*
   * 选中某个元素时，让它进入"被鼠标悬停"的状态：
   *
   *  B 站的卡片、按钮大量依赖 hover 才看得出反馈（封面放大、"立即播放"浮层、
   *  预览、下拉菜单展开……）。遥控器没有鼠标，只是画一个蓝框的话，用户根本
   *  看不出来选中的是什么，所以这里补两件事：
   *
   *   1. 派发 pointerover / mouseover / mouseenter / mousemove —— 页面用 JS
   *      绑定的 hover 逻辑会跑起来；
   *   2. 通过 win.__kbOnHover 把选中框的中心点报给外面（电视端交给 Android
   *      补一个真实的鼠标悬停事件，让 CSS :hover 也生效）。
   */

  let hoveredEl = null;
  let hoverAtX = -9999;
  let hoverAtY = -9999;

  function fireMouse(el, type, x, y, bubbles) {
    try {
      el.dispatchEvent(new win.MouseEvent(type, {
        bubbles, cancelable: true, view: win, clientX: x, clientY: y,
      }));
    } catch { /* ignore */ }
  }

  function notifyHover(info) {
    try {
      if (typeof win.__kbOnHover === 'function') win.__kbOnHover(info);
    } catch { /* ignore */ }
  }

  function leaveElement(el) {
    fireMouse(el, 'pointerout', hoverAtX, hoverAtY, true);
    fireMouse(el, 'mouseout', hoverAtX, hoverAtY, true);
    fireMouse(el, 'mouseleave', hoverAtX, hoverAtY, false);
    fireMouse(el, 'pointerleave', hoverAtX, hoverAtY, false);
  }

  function clearHover() {
    if (!hoveredEl) return;
    leaveElement(hoveredEl);
    hoveredEl = null;
    hoverAtX = -9999;
    hoverAtY = -9999;
    notifyHover({ el: null });
  }

  /** 把"悬停"同步到当前选中项（坐标变了就重新触发一次） */
  function syncHover() {
    // 全屏看片：把悬停收干净，让 B 站的控制栏自己缩回去
    if (isPlayerFullscreen()) { dropHover(); return; }
    const t = state.current;
    if (!t) { clearHover(); return; }
    const r = rectOf(t.el);
    const x = Math.round(r.x + r.w / 2);
    const y = Math.round(r.y + r.h / 2);
    const moved = Math.abs(x - hoverAtX) > 2 || Math.abs(y - hoverAtY) > 2;
    if (hoveredEl === t.el && !moved) return;
    if (hoveredEl && hoveredEl !== t.el) leaveElement(hoveredEl);
    if (hoveredEl !== t.el) {
      fireMouse(t.el, 'pointerover', x, y, true);
      fireMouse(t.el, 'pointerenter', x, y, false);
      fireMouse(t.el, 'mouseover', x, y, true);
      fireMouse(t.el, 'mouseenter', x, y, false);
    }
    fireMouse(t.el, 'pointermove', x, y, true);
    fireMouse(t.el, 'mousemove', x, y, true);
    hoveredEl = t.el;
    hoverAtX = x;
    hoverAtY = y;
    notifyHover({ el: t.el, x, y, w: Math.round(r.w), h: Math.round(r.h), label: label(t) });
  }

  /* --------------------------------------------------------- 播放器 --- */

  function playerEl() {
    return playerContainer(doc);
  }

  /** 当前选中的就是那个视频窗口（不是它里面的按钮） */
  function isPlayerSelected() {
    const c = playerEl();
    return !!(c && state.current && state.current.el === c);
  }

  function isPlayerFullscreen() {
    return playerScreenMode(doc, playerEl()) !== null;
  }

  /** 无条件把悬停收回来（进入全屏时必须做：B 站的控制栏是靠 :hover 撑住的） */
  function dropHover() {
    if (hoveredEl) leaveElement(hoveredEl);
    hoveredEl = null;
    hoverAtX = -9999;
    hoverAtY = -9999;
    notifyHover({ el: null });
  }

  /**
   * 全屏状态变了就调整显示：全屏时把选中框/提示条收掉、悬停也收干净
   *（B 站的控制栏是靠鼠标悬停撑着的，悬停不收它就永远缩不回去）。
   * 只在"状态真的变了"时动手，避免反复发悬停事件。
   */
  let lastFullscreenMode = 'init';

  function syncFullscreenVisuals() {
    const mode = playerScreenMode(doc, playerEl()) || '';
    if (mode === lastFullscreenMode) return;
    lastFullscreenMode = mode;
    if (mode) {
      ui.box.classList.remove('kb-on');
      ui.hint.classList.remove('kb-on');
      dropHover();
    } else if (state.current) {
      drawBox();          // 退出全屏：把选中框按当前布局画回来
    }
  }

  /** 唤醒播放器的控制栏（B 站靠 mousemove 唤醒，几秒没人动自己缩回去） */
  function showPlayerControls() {
    const c = playerEl();
    if (!c) return;
    const r = rectOf(c);
    const x = Math.round(r.x + r.w / 2);
    const y = Math.round(r.y + r.h / 2);
    let target = c;
    try {
      target = doc.elementFromPoint(x, y) || c;
    } catch { /* ignore */ }
    fireMouse(target, 'mouseover', x, y, true);
    fireMouse(target, 'mousemove', x, y, true);
  }

  /** 播放 / 暂停 */
  function togglePlay() {
    const v = videoOf(playerEl());
    if (!v) return false;
    try {
      if (v.paused) {
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } else {
        v.pause();
      }
    } catch {
      return false;
    }
    showPlayerControls();
    invalidate();
    return true;
  }

  /** 进全屏 / 退全屏 */
  function toggleFullscreen() {
    if (isPlayerFullscreen()) return exitFullscreen();
    return enterFullscreen();
  }

  function enterFullscreen() {
    const c = playerEl();
    if (!c) return false;
    // 优先点 B 站自己的全屏按钮：尺寸、快捷键、控制栏状态都由它摆好。
    // 注意别点到"网页全屏"那个按钮（它也带"全屏"两字）。
    const btn = c.querySelector('.bpx-player-ctrl-full')
      || c.querySelector('.bilibili-player-video-btn-fullscreen')
      || [...c.querySelectorAll('[aria-label*="全屏"], [title*="全屏"]')].find((b) => {
        const text = `${b.getAttribute('aria-label') || ''}${b.getAttribute('title') || ''}${b.className || ''}`;
        return !/web|网页/i.test(text);
      });
    if (btn && typeof btn.click === 'function') {
      btn.click();
      dropHover();
      invalidate();
      return true;
    }
    const target = c.querySelector('.bpx-player-video-wrap') || videoOf(c) || c;
    try {
      const req = target.requestFullscreen || target.webkitRequestFullscreen;
      if (req) {
        const p = req.call(target);
        if (p && typeof p.catch === 'function') p.catch(() => {});
        dropHover();
        invalidate();
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  /** 退出全屏（原生全屏 / B 站全屏 / 网页全屏都认） */
  function exitFullscreen() {
    const c = playerEl();
    const mode = playerScreenMode(doc, c);
    if (!mode) return false;
    if (mode === 'native') {
      try {
        const ex = doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen;
        if (ex) {
          const p = ex.call(doc);
          if (p && typeof p.catch === 'function') p.catch(() => {});
          return true;
        }
      } catch { /* ignore */ }
    }
    // B 站自己的全屏 / 网页全屏：点"当时进去的那一个"按钮退出
    //（querySelector 的多选择器是按文档顺序命中的，不能把两个按钮一起写进选择器）
    const primary = mode === 'web' ? '.bpx-player-ctrl-web' : '.bpx-player-ctrl-full';
    const spare = mode === 'web' ? '.bpx-player-ctrl-full' : '.bpx-player-ctrl-web';
    const btn = c && (c.querySelector(primary) || c.querySelector(spare));
    if (btn && typeof btn.click === 'function') {
      btn.click();
      invalidate();
      return true;
    }
    return false;
  }

  /**
   * 播放器上的"确定"：单击播放/暂停，双击全屏。
   * 同一个键既要单击又要双击，就只能等一下 —— 双击窗口内没有第二下，
   * 才把单击兑现（默认 300ms）。
   */
  let pendingPlayTimer = 0;

  function playerActivate() {
    if (pendingPlayTimer) {
      win.clearTimeout(pendingPlayTimer);
      pendingPlayTimer = 0;
      const wantFull = !isPlayerFullscreen();
      const ok = toggleFullscreen();
      if (ok) showHint(wantFull ? '全屏' : '已退出全屏');
      return true;
    }
    pendingPlayTimer = win.setTimeout(() => {
      pendingPlayTimer = 0;
      togglePlay();
    }, Math.max(120, SETTINGS.doublePressMs || 300));
    return true;
  }

  /** 撤掉还没兑现的"单击"（比如接着按了返回键） */
  function cancelPendingPlay() {
    if (!pendingPlayTimer) return;
    win.clearTimeout(pendingPlayTimer);
    pendingPlayTimer = 0;
  }

  function setCurrent(target, force = false) {
    if (!target) return false;
    if (target.el === state.current?.el && !force) return true;
    state.current = target;
    const list = targetList();
    const i = list.findIndex((t) => t.el === target.el);
    state.index = i >= 0 ? i : state.index;
    drawBox();
    return true;
  }

  /* --------------------------------------------- 取消选中 / 记住位置 --- */
  /*
   * 返回键的第一层是"取消选中"：把框收掉，但**记住刚才在哪**。
   * 这样下一次按方向键是从原来那个位置接着走，而不是从页面顶部重新开始。
   */

  /** 取消选中但记住位置（返回键用）。本来就没选中返回 false */
  function dismissSelection() {
    if (!state.current) return false;
    state.lastTarget = state.current;
    state.active = false;
    state.current = null;
    ui.box.classList.remove('kb-on');
    ui.hint.classList.remove('kb-on');
    clearHover();
    invalidate();
    return true;
  }

  /** 把上次取消掉的那个选中项捡回来（还在页面上才有效） */
  function resumeRemembered() {
    const t = state.lastTarget;
    if (!t || !t.el) return false;
    // 元素可能已经被页面删掉了（换页、刷新、懒加载回收）
    if (t.el.isConnected === false || !doc.contains(t.el)) { state.lastTarget = null; return false; }
    state.lastTarget = null;
    state.active = true;
    setCurrent(t, true);
    ensureVisible(t);
    return true;
  }

  /**
   * 把选中项滚进视口。
   * 关键点：
   *  1. 每次都用 getBoundingClientRect 的实时坐标，不能拿采集时的快照
   *     （快照和实时位置差了一次滚动的距离，会导致滚过去又被滚回来）
   *  2. 对每个滚动容器（从外到内）都在它自己的坐标系里判断，
   *     元素已经在容器可视区内就完全不动，避免反复"对齐"造成抖动
   *  3. 容器顶部有吸顶头（B 站顶栏）时预留遮挡高度
   */
  function scrollIntoView(target) {
    const el = target.el;
    const m = SETTINGS.scrollMargin;
    const chain = scrollAncestors(el, win).reverse();   // 从最外层开始
    for (const sc of chain) {
      const r = rectOf(el);          // 每次滚动后重新取，坐标会变
      const isRoot = sc === doc.scrollingElement || sc === doc.documentElement || sc === doc.body;
      const box = isRoot
        ? { top: 0, left: 0, right: doc.documentElement.clientWidth || win.innerWidth, bottom: doc.documentElement.clientHeight || win.innerHeight }
        : { top: rectOf(sc).y, left: rectOf(sc).x, right: rectOf(sc).x + rectOf(sc).w, bottom: rectOf(sc).y + rectOf(sc).h };
      // 吸顶头（B 站顶栏）会挡住选中项，顶部留白要把它算进去
      const topGap = box.top + m + (isRoot ? stickyTopOffset() : 0);
      let deltaY = 0;
      if (r.y < topGap) deltaY = r.y - topGap;
      else if (r.y + r.h + m > box.bottom) deltaY = r.y + r.h + m - box.bottom;
      if (deltaY) sc.scrollTop = sc.scrollTop + deltaY;

      let deltaX = 0;
      if (r.x - m < box.left) deltaX = r.x - m - box.left;
      else if (r.x + r.w + m > box.right) deltaX = r.x + r.w + m - box.right;
      if (deltaX) sc.scrollLeft = sc.scrollLeft + deltaX;
    }
    refreshRects();          // 页面/容器滚过了，候选坐标全部作废
    drawBox();
  }

  /** 视口顶部被吸顶/固定元素遮挡的高度（B 站顶栏大约 64px） */
  function stickyTopOffset() {
    if (stickyOffset !== null) return stickyOffset;
    stickyOffset = 0;
    try {
      const nodes = [...doc.querySelectorAll('.bili-header, .mini-header, .international-header, #biliMainHeader, header')];
      for (const node of nodes) {
        const pos = win.getComputedStyle(node).position;
        if (pos !== 'fixed' && pos !== 'sticky') continue;
        const r = rectOf(node);
        if (r.y <= 2 && r.h > 8 && r.h < 200 && r.w > 200) stickyOffset = Math.max(stickyOffset, Math.round(r.h));
      }
    } catch { /* ignore */ }
    return stickyOffset;
  }
  let stickyOffset = null;

  function ensureVisible(target) {
    const r = rectOf(target.el);
    const vh = doc.documentElement.clientHeight || win.innerHeight;
    const vw = doc.documentElement.clientWidth || win.innerWidth;
    const outside = r.y < 0 || r.y + r.h > vh || r.x < 0 || r.x + r.w > vw;
    if (outside) scrollIntoView(target);
  }

  function move(dir) {
    if (!state.current) {
      // 上一次被返回键取消掉的选中项还在：从它那儿接着走，
      // 而不是从页面最上面重新开始
      if (resumeRemembered()) {
        // 落回原来的位置之后，继续按这次的方向走一步
      } else {
        const first = pickInitialTarget();
        if (!first) { showHint('<span class="kb-dim">这一页没有可导航的元素</span>'); return; }
        setCurrent(first, true);
        ensureVisible(first);
        return;
      }
    }
    const list = targetList();
    const base = findTargetFor(state.current.el) || state.current;
    const vw = doc.documentElement.clientWidth || win.innerWidth;
    const vh = doc.documentElement.clientHeight || win.innerHeight;
    const vertical = dir === 'down' || dir === 'up';
    const hintEdge = () => showHint(dir === 'down' ? '已经到底了' : '已经到顶了');

    /**
     * 找下一步。
     *
     * 位置识别的关键：先判断这次按键是不是"同一行里的横向移动"，
     * 判断依据是两个元素在纵向是否有重叠（同行 → 横向移动）。
     *
     * 规则：
     *  - 横向移动（← →）时，吸顶顶栏里的元素正常参与：所以从"收藏夹"
     *    按 → 就能走到同一行的搜索框，而不是掉到下面的分区按钮。
     *  - 纵向移动（↑ ↓）时，吸顶顶栏只在"向上走"的时候参与：
     *    它贴在视口顶上，页面滚到下方后仍悬在上边，
     *    如果向下也认它，它就成了下方的目标，会把页面来回拽。
     *  - 搜索框、分区按钮这类浮在上边的输入框，同样只在 ↑ 和 ← → 时参与。
     */
    const findNext = (allowOffscreen, allowStuck = false) => {
      const baseStuck = base.stuck === true;
      const baseRect = rectOf(base.el);
      const overTop = (c) => c.rect.y < 64;                        // 贴在视口顶部
      const sidewaysMove = (c) => {                                 // 同一行里的横向移动
        const overlap = Math.min(baseRect.y + baseRect.h, c.rect.y + c.rect.h)
          - Math.max(baseRect.y, c.rect.y);
        return overlap > 1;
      };
      const accept = (cand) => {
        if (cand.el === state.current.el) return false;
        const candStuck = cand.stuck === true;
        const isInput = isTextField(cand.el);
        const sameRow = sidewaysMove(cand);

        if (candStuck && !baseStuck && !allowStuck) {
          // 从内容进入顶栏：只允许"向上走"或"同一行的横向移动"
          return dir === 'up' || sameRow;
        }
        if (isInput && overTop(cand) && !sameRow && dir !== 'up') {
          // 悬在顶部的输入框：向下走时不认它
          return false;
        }
        return true;
      };
      return nextInDirection(list, base, dir, {
        viewportWidth: vw, viewportHeight: vh,
        baseRect,
        allowOffscreen,
        accept,
      });
    };

    // 已经站在顶部悬浮输入框（搜索框）上：向上就到头了，不要再绕回下面的内容
    let next = findNext(false);

    // 视野里没有：纵向的话先自己翻一屏（最多 4 屏），再看新视野
    if (!next && vertical) {
      for (let i = 0; i < 4 && !next; i++) {
        if (!scrollPage(dir)) break;
        next = findNext(false);
      }
    }

    // 还是没有：允许选视口外的元素（选中后会被滚进视口），
    // 但"操作方向那一侧"的约束仍然生效：向下走不去选上方的元素，
    // 否则会把页面拽回去，来回抖（这是之前页面滚不动的根源）。
    if (!next) {
      next = nextInDirection(list, base, dir, {
        viewportWidth: vw,
        viewportHeight: vh,
        baseRect: rectOf(base.el),
        allowOffscreen: true,
        accept: (cand) => {
          if (cand.el === state.current.el) return false;
          if (dir === 'down' && cand.rect.y + cand.rect.h < 0) return false;
          if (dir === 'up' && cand.rect.y > vh) return false;
          if (dir !== 'up' && isTextField(cand.el) && cand.rect.y < 64) return false;
          // 顶栏元素仍然只在"向上走"时参与（从内容深处按 ↓ 不该掉回顶栏）
          if (cand.stuck === true && base.stuck !== true && dir !== 'up') return false;
          return true;
        },
      });
    }

    // 纵向实在没去处：在同一行里横向挪一下，免得按键完全没反应。
    // 但当前已经贴在顶栏上时不这样做：那会在顶栏各项之间绕圈，
    // 也绕开了"顶栏只在向上时参与"的规则；用户想横着走可以自己按 ← →。
    const inTopBar = base.stuck === true || (isTextField(base.el) && rectOf(base.el).y < 64);
    if (!next && vertical && !inTopBar) {
      const baseIsStuck = base.stuck === true;
      const sideways = (d) => nextInDirection(list, base, d, {
        viewportWidth: vw, viewportHeight: vh, baseRect: rectOf(base.el),
        accept: (cand) => cand.el !== state.current.el && (cand.stuck === true) === baseIsStuck,
      });
      next = sideways('left') || sideways('right');
    }

    if (!next) {
      if (vertical) hintEdge();
      return;
    }

    state.current = next.target;
    // 选中项若在视口外，ensureVisible 会把它滚进来（滚动方向自然与它所在的位置一致）
    ensureVisible(next.target);
    refreshRects();          // 页面可能滚过了，坐标要重新测
    drawBox();
    const i = list.findIndex((t) => t.el === next.target.el);
    if (i >= 0) state.index = i;
    showHint(`<span class="kb-lbl">${label(next.target)}</span> <span class="kb-dim">${state.index + 1}/${list.length}</span>`, 1200);
  }

  /** 这个方向还能不能继续滚页面 */
  function canScroll(dir) {
    const sc = doc.scrollingElement || doc.documentElement;
    if (dir === 'down') return sc.scrollTop < sc.scrollHeight - sc.clientHeight - 2;
    if (dir === 'up') return sc.scrollTop > 2;
    return false;
  }

  /** 手动翻页：只走根滚动条（普通滚动容器交给 ensureVisible 处理） */
  function scrollPage(dir) {
    if (dir !== 'down' && dir !== 'up') return false;
    const sc = doc.scrollingElement || doc.documentElement;
    const vh = doc.documentElement.clientHeight || win.innerHeight;
    const before = sc.scrollTop;
    const step = Math.max(80, Math.round(vh * 0.75));
    sc.scrollTop = before + (dir === 'down' ? step : -step);
    const after = sc.scrollTop;
    if (Math.abs(after - before) < 2) return false;
    // 位置变了，所有候选的矩形都要重新测量，否则后面的方向判断会用过期坐标
    refreshRects();
    return true;
  }

  /** 重新测量所有候选的矩形（滚动之后必须做） */
  function refreshRects() {
    if (!state.targets) return;
    const view = win;
    const vh = doc.documentElement.clientHeight || win.innerHeight;
    for (const t of state.targets) {
      t.rect = rectOf(t.el);
      // 吸顶状态会随滚动变化（滚到下面时导航栏被钉在顶上），必须一起重算
      t.stuck = isStuck(t.el, view, t.rect, vh);
    }
    state.rectsAt = Date.now();
  }

  /* ---------------------------------------------------------- activation -- */

  function activate(mods = {}) {
    // 视频窗口：确定 = 播放/暂停，双击 = 全屏（不点它本身，是直接控播放器）
    if (isPlayerSelected() || (isPlayerFullscreen() && !state.current)) return playerActivate();
    if (!state.current) return false;
    const el = state.current.el;
    const isAnchor = el.tagName === 'A' && el.getAttribute('href');
    const href = isAnchor ? el.href : '';
    const d = describe(el);

    if (mods.ctrl || mods.meta) {
      if (href) {
        win.open(href, '_blank', 'noopener');
        showHint(`<span class="kb-k">Ctrl+Enter</span> 新标签打开：<span class="kb-lbl">${d.text || href}</span>`);
        return true;
      }
      mods = { ...mods, ctrl: false, meta: false };
    }

    // 输入框：只聚焦不点击，聚焦后方向键归还给它（按 Esc 收回导航）
    if (isTextField(el)) {
      try { el.focus({ preventScroll: false }); } catch { /* ignore */ }
      showHint(`<span class="kb-k">Enter</span> 已进入输入框，按 <span class="kb-k">Esc</span> 退出输入`);
      invalidate();
      return true;
    }

    // 点击前先把光标放在元素上：B 站部分卡片依赖 hover/active 事件
    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    } catch { /* ignore */ }

    const point = clickPoint(state.current, el);
    const node = targetAtPoint(state.current, el, point);
    if (!clickAtPoint(node, point)) return false;

    showHint(`<span class="kb-k">Enter</span> → <span class="kb-lbl">${d.text || d.href || d.tag}</span>`);
    // 页面可能立刻发生变化（SPA 路由），下一次按键重新收集
    invalidate();
    win.setTimeout(invalidate, 60);
    return true;
  }

  /**
   * 要点的位置：选中项（或者它内部那个更小的可点目标）的中心。
   *
   * 以前是直接 el.click() —— 那是"按元素触发"。它的问题是：有些东西的点击处理
   * 绑在更里面的元素上，或者干脆看事件坐标，直接给外层派发 click 是点不动的
   * （鼠标点得动、按确定没反应）。所以现在按坐标点：找那个坐标上真正最上层的
   * 元素，像鼠标一样派发一整套事件。
   */
  function clickPoint(target, el) {
    const r = rectOf(el);
    let px = r.x + r.w / 2;
    let py = r.y + r.h / 2;
    let node = el;
    const inner = innerTargetOf(target, px, py);
    if (inner) {
      const ir = inner.rect;
      px = ir.x + ir.w / 2;
      py = ir.y + ir.h / 2;
      node = inner.el;
    }
    return { x: px, y: py, node };
  }

  /**
   * 坐标上真正该收到点击的元素。
   * 只在"点到的元素确实属于选中项"时才用坐标结果；点到别的东西（挡住它的浮层
   * 之类）就退回选中项本身，免得点飞。
   */
  function targetAtPoint(target, el, point) {
    let top = null;
    try {
      top = doc.elementFromPoint(point.x, point.y);
    } catch { /* ignore */ }
    if (!top || top === point.node) return point.node;
    if (top === el || el.contains(top) || point.node.contains(top)) return top;
    return point.node;
  }

  /** 在坐标处派发一整套鼠标事件（顺序和真鼠标点一下一样，坐标也带上） */
  function clickAtPoint(node, point) {
    const base = {
      bubbles: true, cancelable: true, view: win, detail: 1,
      clientX: point.x, clientY: point.y,
      screenX: point.x, screenY: point.y,
    };
    try {
      node.dispatchEvent(new win.MouseEvent('pointerover', base));
      node.dispatchEvent(new win.MouseEvent('pointerdown', { ...base, buttons: 1 }));
      node.dispatchEvent(new win.MouseEvent('mousedown', { ...base, buttons: 1 }));
      node.dispatchEvent(new win.MouseEvent('pointerup', { ...base, buttons: 0 }));
      node.dispatchEvent(new win.MouseEvent('mouseup', { ...base, buttons: 0 }));
      node.dispatchEvent(new win.MouseEvent('click', { ...base, buttons: 0 }));
      return true;
    } catch {
      return false;
    }
  }

  /* -------------------------------------------------------------- escape -- */

  function closeTopLayer() {
    const layers = [...doc.querySelectorAll(
      '.bili-modal, .bili-dialog, .bili-mini-mask, .vui_dialog, .bili-dialog-wrap, .login-sns-panel, .bili-login-card, .bili-comment-image-preview, [class*="modal"][class*="mask"], .bpx-player-sending-bar ~ .bpx-player-dm-setting-panel',
    )];
    for (const layer of layers) {
      const cs = win.getComputedStyle(layer);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const r = layer.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      const closer = layer.querySelector('.close, .bili-modal-close, .vui_dialog-close, [aria-label*="关闭"], .bpx-player-ctrl-setting-close')
        || [...layer.querySelectorAll('button, [role="button"], .btn, a')].find((b) => /关闭|取消|close/i.test(b.textContent || b.getAttribute('aria-label') || ''));
      if (closer) {
        closer.click();
        showHint('已关闭弹层');
        return true;
      }
    }
    // B 站原生弹层大多自己监听 ESC
    const active = doc.activeElement;
    if (active && active !== doc.body && active.closest && active.closest('[class*="modal"], [class*="dialog"], .bili-mini-mask')) {
      active.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      return true;
    }
    return false;
  }

  function canGoBack() {
    try {
      if (win.history.length > 1) {
        const ref = doc.referrer;
        if (!ref) return true; // 可能是 SPA 内部历史
        try {
          const u = new win.URL(ref);
          return BILI_HOST.test(u.hostname);
        } catch {
          return false;
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  function goBack() {
    if (canGoBack()) {
      win.history.back();
      showHint('← 返回上一页');
      return true;
    }
    if (SETTINGS.escFallbackHome) {
      win.location.href = 'https://www.bilibili.com';
      return true;
    }
    showHint('<span class="kb-dim">没有可返回的页面</span>');
    return false;
  }

  function escape() {
    cancelPendingPlay();
    const active = doc.activeElement;
    if (active && isEditable(active) && active !== doc.body) {
      active.blur();
      showHint('已退出输入');
      return true;
    }

    // 输入态：搜索框有内容时先清空
    const search = active && active.matches && active.matches('input[type="text"], input:not([type])');
    if (search && active.value) {
      active.value = '';
      active.dispatchEvent(new win.Event('input', { bubbles: true }));
      showHint('已清空搜索框');
      return true;
    }

    if (closeTopLayer()) return true;

    // 取消选中（记住位置）：再按方向键就从刚才那儿接着走
    if (dismissSelection()) {
      showHint('已取消选中，按方向键可从原位置继续');
      return true;
    }

    return goBack();
  }

  /* --------------------------------------------------------------- misc --- */

  function start() {
    state.active = true;
    showHint('键盘导航：<span class="kb-k">↑↓←→</span> 选择 · <span class="kb-k">Enter</span> 打开 · <span class="kb-k">Esc</span> 返回', 3200);
  }

  /* ------------------------------------------------------------ keydown --- */
  /* 只处理这 6 个键：↑ ↓ ← → / Enter / Esc。其它按键一律不碰。 */

  function onKeydown(e) {
    if (e.defaultPrevented) return;
    if (e.isComposing || e.keyCode === 229) return;   // 输入法组词中
    if (!SETTINGS.enabled) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;   // 带修饰键的都不拦

    const active = doc.activeElement;
    const typing = isEditable(active);
    const key = e.key;
    const dirMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

    // 页面正在全屏（HTML5 全屏 API）：方向键/回车归播放器（快退快进 / 暂停），
    // 电视上"全屏看片时按左右能快进"就靠这条；Esc 仍然可以退出全屏。
    if (key !== 'Escape' && isFullscreen(doc)) return;

    if (key === 'Escape') {
      if (typing) {
        // 在输入框里：有内容先清空，再按一次才退出输入（然后方向键恢复导航）
        if (active.value) {
          active.value = '';
          active.dispatchEvent(new win.Event('input', { bubbles: true }));
          e.preventDefault();
          showHint('已清空输入框');
          return;
        }
        active.blur();
        e.preventDefault();
        showHint('已退出输入');
        return;
      }
      e.preventDefault();
      escape();
      return;
    }

    // 光标在输入框里：方向键、回车都归它（移动光标 / 提交）
    if (typing) return;

    if (dirMap[key]) {
      // 带 Shift 的方向键（页面上常用作快进/快退等）完全不碰
      if (e.shiftKey) return;
      // 鼠标在播放器上时把方向键让给 B 站（快退/快进）
      const overPlayer = SETTINGS.playerPassthrough
        && (isPlayerZone(doc.elementFromPoint(lastMouse.x, lastMouse.y)) || isPlayerZone(active));
      if (overPlayer) return;
      e.preventDefault();
      if (!state.active) start();
      move(dirMap[key]);
      return;
    }

    if (key === 'Enter') {
      if (!state.active) start();
      if (!state.current) return;
      e.preventDefault();
      activate();
    }
  }

  function start() {
    state.active = true;
    showHint('键盘导航：<span class="kb-k">↑↓←→</span> 选择 · <span class="kb-k">Enter</span> 打开 · <span class="kb-k">Esc</span> 返回', 3200);
  }

  /* ------------------------------------------------------------- events --- */

  const lastMouse = { x: -1, y: -1 };
  const onMouseMove = (e) => { lastMouse.x = e.clientX; lastMouse.y = e.clientY; };
  const onScrollLike = () => { if (state.current) drawBox(); };
  const onResize = () => { invalidate(); if (state.current) drawBox(); };

  win.addEventListener('keydown', onKeydown, true);
  win.addEventListener('mousemove', onMouseMove, { passive: true });
  win.addEventListener('scroll', onScrollLike, { passive: true, capture: true });
  win.addEventListener('resize', onResize);
  doc.addEventListener('click', (e) => {
    // 鼠标点进输入框：键盘要用来打字了，退出选择状态
    if (isEditable(e.target) || isEditable(doc.activeElement)) {
      if (state.current) {
        state.current = null;
        state.active = false;
        ui.box.classList.remove('kb-on');
        clearHover();
      }
      return;
    }
    // 鼠标点击后把选中框同步过去，键鼠混用不打架
    const t = findTargetFor(e.target);
    if (t) { state.current = t; drawBox(); }
  }, true);
  win.addEventListener('focus', invalidate, true);

  // 进出全屏：刷新布局、收掉/恢复选中框
  const onFullscreenChange = () => {
    invalidate();
    syncFullscreenVisuals();
  };
  for (const type of ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange']) {
    doc.addEventListener(type, onFullscreenChange, true);
  }

  const observer = markDirtyOnMutations();

  return {
    state,
    settings: SETTINGS,
    ui,
    move,
    activate,
    escape,
    /** 关掉最上层的弹窗/遮罩；没有弹层可关时返回 false（电视端"返回键"要用） */
    closeTopLayer,
    /** 浏览器历史里还有没有可回退的页面 */
    canGoBack,
    /** 回退到上一页（没有历史时按设置回首页） */
    goBack,
    /** 只清掉高亮框、不触发任何跳转（电视端页面切换后调用；顺手忘掉记住的位置） */
    clearSelection() {
      state.active = false;
      state.current = null;
      state.lastTarget = null;
      ui.box.classList.remove('kb-on');
      ui.hint.classList.remove('kb-on');
      clearHover();
      invalidate();
      return true;
    },
    /** 取消选中但记住位置（返回键第一层） */
    dismissSelection,
    /** 当前焦点是不是在输入框里 */
    isTyping: () => isEditable(doc.activeElement),
    /** 退出输入框（电视端返回键第一步） */
    blurInput() {
      const active = doc.activeElement;
      if (active && isEditable(active) && active !== doc.body) {
        if (active.value) {
          active.value = '';
          active.dispatchEvent(new win.Event('input', { bubbles: true }));
        }
        active.blur();
        return true;
      }
      return false;
    },
    refresh: () => { invalidate(); return targetList(true); },
    currentLabel: () => (state.current ? label(state.current) : null),
    currentIndex: () => (state.current ? targetList().findIndex((t) => t.el === state.current.el) : -1),
    selectAt: (i) => {
      const list = targetList();
      if (i < 0 || i >= list.length) return false;
      state.active = true;
      return setCurrent(list[i], true);
    },

    /* ------------------------------------------------------ 播放器 --- */
    /** 选中的是不是视频窗口 */
    isPlayerSelected,
    /** 播放器是不是处于全屏（原生全屏 / B 站全屏 / 网页全屏都算） */
    isPlayerFullscreen: () => isPlayerFullscreen(),
    /** 播放 / 暂停 */
    togglePlay,
    /** 全屏 ↔ 退出全屏 */
    toggleFullscreen,
    /** 退出全屏；本来就没全屏时返回 false（电视端返回键要用） */
    exitFullscreen,
    /** 撤掉还没兑现的"单击播放/暂停" */
    cancelPendingPlay,

    destroy() {
      win.removeEventListener('keydown', onKeydown, true);
      observer.disconnect();
      clearHover();
      ui.root.remove();
    },
  };
}

/* ------------------------------------------------------------- bootstrap -- */

let controller = null;

function boot(win = globalThis) {
  if (controller) return controller;
  const doc = win && win.document;
  if (!doc) return null;
  if (!doc.body) {
    // 文档还没解析出 body：挂上 DOMContentLoaded，别缓存失败的启动
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => boot(win), { once: true });
    return null;
  }
  controller = createController(win);
  controller.__mounted = true;
  try { win.__KB__ = Object.assign(win.__KB__ || {}, { __mounted: true }); } catch { /* ignore */ }
  if (SETTINGS.debug) console.log('[bili-keynav] ready', SETTINGS);
  return controller;
}

function autoBoot(win = globalThis) {
  const doc = win && win.document;
  if (!doc) return null;
  if (!doc.body && doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', () => boot(win), { once: true });
    return null;
  }
  return boot(win);
}

/** 彻底卸载（测试用；正常使用不需要） */
function unmount() {
  if (controller && typeof controller.destroy === 'function') controller.destroy();
  controller = null;
}

/* ===================== src-web/web-bridge.js ======================= */
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

const __kbApi = {
  boot,
  autoBoot,
  unmount,
  createController,
  SETTINGS,
  DEFAULT_SETTINGS,
};

(function tvStart() {
  if (typeof window === 'undefined' || !window.document) return;
  window.__KB__ = __kbApi;

  if (!window.__KB_BOOTED__) {
    window.__KB_BOOTED__ = true;
    let tries = 0;
    const attach = () => {
      const c = __kbApi.boot(window);
      if (c) { __kbApi.controller = c; window.__kb = c; return true; }
      return false;
    };
    attach();
    const timer = window.setInterval(() => {
      if (attach() || ++tries > 200) window.clearInterval(timer);
    }, 50);
  }

  tvBoot(window);
})();
})();
