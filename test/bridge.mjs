/**
 * 导航脚本（app/src/main/assets/keynav-web.js）的浏览器端契约测试。
 *
 * Android 端按键最终就是调 window.__kbTV.key(动作)，这里用真实 Chromium 把这套
 * 契约跑一遍：按键有没有被页面吃掉、确定键有没有点中元素、返回键的分层逻辑、
 * 长按有没有变成 kb-longpress、链接是不是开成新标签页、选中项的悬停/位置
 * 有没有报给原生、viewport 有没有按"外站桌面宽度 / 本地首屏屏幕宽度"分别处理、
 * 重复注入会不会挂两遍。
 *
 *   $env:NODE_PATH="C:\nvm4w\nodejs\node_modules"; node test/bridge.mjs
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
let chromium = null;
for (const m of [process.env.PW_MODULE, '@playwright/test', 'playwright', 'playwright-core'].filter(Boolean)) {
  try { ({ chromium } = require(m)); if (chromium) break; } catch { /* next */ }
}
if (!chromium) {
  console.error('加载不到 playwright；设 PW_MODULE 或在 NODE_PATH 里放全局 node_modules');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const assetDir = join(root, 'app', 'src', 'main', 'assets');

const KEYNAV_WEB = await readFile(join(assetDir, 'keynav-web.js'), 'utf8');
const EARLY_JS = await readFile(join(assetDir, 'early.js'), 'utf8');

const PAGE_CSS = `
  body { font-family: sans-serif; background:#18191c; color:#eee; margin:0; padding:24px; }
  .card, button, a { display:block; margin:12px 0; padding:18px 24px; font-size:18px;
      background:#2b2d33; color:#fff; border:1px solid #3b3d44; border-radius:8px;
      width:320px; text-decoration:none; box-sizing:border-box; }
  #overlay { position:fixed; inset:0; background:rgba(0,0,0,.7); z-index:10; }
`;

const PAGE_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>测试页</title><style>${PAGE_CSS}</style></head><body>
  <button id="b1" type="button">第一个</button>
  <button id="b2" type="button">第二个</button>
  <a id="blank" href="/target" target="_blank">_blank 链接</a>
  <input id="q" type="text" placeholder="输入点什么">
  <div class="card" id="listen" tabindex="0">长按我</div>
  <script>
    window.__clicks = [];
    for (const id of ['b1', 'b2', 'blank']) {
      document.getElementById(id).addEventListener('click', () => window.__clicks.push(id));
    }
    window.__longPresses = 0;
    window.__backHits = 0;
    document.getElementById('listen').addEventListener('kb-longpress', (e) => {
      window.__longPresses++; e.preventDefault();
    });
    // 页面自己接住返回键（首页的弹菜单就是这么做的）
    window.__swallowBack = false;
    document.addEventListener('kb-back', (e) => {
      if (!window.__swallowBack) return;
      window.__backHits++; e.preventDefault();
    }, true);
  </script>
</body></html>`;

const OVERLAY_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>有弹层</title><style>${PAGE_CSS}
  #overlay { display:flex; align-items:center; justify-content:center; }
  #overlay .panel { width:60%; height:60%; background:#22262e; border-radius:12px;
      display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; }
</style></head><body>
  <button id="behind" type="button">底下的按钮</button>
  <div id="overlay" role="dialog" aria-modal="true">
    <div class="panel">
      <div>登录一下才能继续</div>
      <button id="inside" type="button">关闭</button>
    </div>
  </div>
  <script>window.__closed = 0;
    document.getElementById('inside').addEventListener('click', () => {
      window.__closed++;
      document.getElementById('overlay').style.display = 'none';
    });
  </script>
</body></html>`;

const TARGET_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>到了</title></head>
<body style="background:#111;color:#eee;font-family:sans-serif"><h1 id="arrived">目标页</h1></body></html>`;

/**
 * 一个只占屏幕一角的下拉菜单，压在一大块页面内容上 ——
 * 用来验"方向键不该从菜单漏到下面那一层"。
 *
 * 关键在几处尺寸：菜单项之间留了 24px 间距，而 page1 又高又大、中心点露在菜单
 * 外面（所以它不会被 collectTargets 当成"被完全遮住"滤掉）。这样一来，从菜单项一
 * 按 ↓ 时，page1 在几何上比菜单项二更近 —— 正是要修的那个"漏到下一层"。
 */
const DROPDOWN_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>下拉菜单</title><style>${PAGE_CSS}
  #menu { position:absolute; top:40px; left:24px; width:320px; z-index:50;
      background:#22262e; border:1px solid #3b3d44; border-radius:10px; padding:8px; }
  #menu a { display:block; margin:0 0 24px; width:auto; padding:14px 16px;
      color:#fff; text-decoration:none; border-radius:8px; }
  #page1 { height:600px; }
</style></head><body>
  <a class="card" id="page1" href="#">页面内容（很高，被菜单压住一半）</a>
  <div id="menu">
    <a id="m1" href="#">菜单项一</a>
    <a id="m2" href="#">菜单项二</a>
    <a id="m3" href="#">菜单项三</a>
  </div>
</body></html>`;

/**
 * 顶栏 + 飘在空白上的浮窗 —— 复刻 B 站头像浮窗那个场景。
 *
 * 三个要点，缺一个就测不出东西：
 *   1. 顶栏是 "absolute + 高 z-index + 贴顶 + 又宽又扁" 的常驻横条，不是浮层；
 *   2. 浮窗挂在顶栏的 DOM 子树**外面**，它下面是一片没有链接的空白，
 *      所以"压住了别的候选"这条判据在它身上算出来是 0；
 *   3. 浮窗两项之间留了很大的间距，而斜下方有个 #e1 —— 从浮窗第一项按 ↓ 时，
 *      #e1 在几何上比浮窗第二项更近。没有"层内优先"的话就会跳到 #e1 去，
 *      这正是"浮窗里只能走前几项、再往下就跳到别处"。
 */
const TOPBAR_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>顶栏与浮窗</title><style>${PAGE_CSS}
  #bar { position:absolute; top:0; left:0; width:100%; height:56px; z-index:100;
      background:#22262e; border-bottom:1px solid #3b3d44;
      display:flex; align-items:center; padding:0 16px; box-sizing:border-box; }
  #bar a { width:auto; margin:0 8px 0 0; padding:12px 16px; }
  #popup { position:absolute; top:60px; left:24px; width:220px; z-index:99;
      background:#2a2f3a; border:1px solid #3b3d44; border-radius:10px; padding:8px; }
  #popup a { display:block; width:auto; margin:0 0 152px; padding:12px 14px; }
  #popup a:last-child { margin-bottom:0; }
</style></head><body>
  <div id="bar">
    <a id="home" href="#">首页</a>
    <a id="avatar" href="#">头像</a>
  </div>
  <div id="popup">
    <a id="p1" href="#">个人中心</a>
    <a id="p2" href="#">退出登录</a>
  </div>
  <a class="card" id="e1" href="#"
     style="position:absolute; left:200px; top:130px; width:200px; margin:0;">斜下方的内容</a>
  <a class="card" id="c1" href="#"
     style="position:absolute; left:24px; top:420px; width:320px; margin:0;">更下方的内容</a>
  <div style="height:2000px;"></div>
</body></html>`;

const ROUTES = {
  '/': ['text/html; charset=utf-8', PAGE_HTML],
  '/overlay': ['text/html; charset=utf-8', OVERLAY_HTML],
  '/dropdown': ['text/html; charset=utf-8', DROPDOWN_HTML],
  '/topbar': ['text/html; charset=utf-8', TOPBAR_HTML],
  '/target': ['text/html; charset=utf-8', TARGET_HTML],
  '/keynav-web.js': ['application/javascript; charset=utf-8', KEYNAV_WEB],
  '/early.js': ['application/javascript; charset=utf-8', EARLY_JS],
};

const server = createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  const hit = ROUTES[path];
  if (!hit) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': hit[0], 'Cache-Control': 'no-store' });
  res.end(hit[1]);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------- 测试框架 -- */

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : `  → ${detail}`}`);
}

/** 装上假的 kbHost 与导航脚本，等它真正挂好 */
async function boot(page, url = `${BASE}/`) {
  await page.addInitScript(() => {
    window.__readyCalls = 0;
    window.__newTabs = [];
    window.__hovers = [];
    window.__selects = [];
    window.kbHost = {
      ready() { window.__readyCalls++; },
      newTab(url) { window.__newTabs.push(url); },
      hover(x, y) { window.__hovers.push([x, y]); },
      select(x, y, w, h, label) { window.__selects.push([x, y, w, h, label]); },
      toast() {},
      log() {},
    };
  });
  await page.goto(url);
  await page.addScriptTag({ content: KEYNAV_WEB });
  await page.waitForFunction(() => window.__kbTV && window.__kbTV.__mounted, null, { timeout: 5000 });
  // 等自动挂载完成（DOM 就绪后 boot 才会成功）
  await page.waitForFunction(() => !!window.__kb, null, { timeout: 5000 });
}

const key = (page, action) => page.evaluate((a) => window.__kbTV.key(a), action);

/* ------------------------------------------------------------------ 跑 -- */

const browser = await chromium.launch();
try {
  /* ------------------------------------------- early.js：PC 特征伪装 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });
    });
    await page.goto(`${BASE}/target`);
    await page.addScriptTag({ content: EARLY_JS });
    const probe = await page.evaluate(() => ({
      platform: navigator.platform,
      touch: navigator.maxTouchPoints,
      uaData: navigator.userAgentData,
    }));
    check('early.js 把 navigator.platform 伪装成 Win32', probe.platform === 'Win32', JSON.stringify(probe));
    check('early.js 把 maxTouchPoints 归零（不暴露是触屏盒子）', probe.touch === 0, String(probe.touch));
    check('early.js 摘掉 userAgentData（让站点回落到 UA 判断）', probe.uaData === undefined, String(probe.uaData));
    await page.close();
  }

  /* ------------------------------------------------------ 挂载与就绪 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);
    await page.waitForTimeout(200);

    const ready = await page.evaluate(() => window.__readyCalls);
    check('桥挂好后会调用 kbHost.ready()', ready > 0, `readyCalls=${ready}`);

    const mounted = await page.evaluate(() => !!(window.__kbTV && window.__kbTV.__mounted && window.__kb));
    check('__kbTV 与导航控制器都已就位（原生的就绪探测就靠这两个）', mounted);

    const boxes = await page.locator('#kb-box').count();
    check('高亮框只挂一个', boxes === 1, `count=${boxes}`);
    await page.close();
  }

  /* ---------------------------------------------------------- 方向键 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);

    const handled = await key(page, 'down');
    check('方向键返回 true（说明网页吃下了这次按键）', handled === true, String(handled));

    const boxOn = await page.evaluate(() => document.getElementById('kb-box').classList.contains('kb-on'));
    check('方向键之后高亮框出现', boxOn);

    const first = await page.evaluate(() => window.__kb.currentLabel());
    await key(page, 'down');
    const second = await page.evaluate(() => window.__kb.currentLabel());
    check('再按一次会换一个目标', first !== second, `${first} → ${second}`);

    const selects = await page.evaluate(() => window.__selects.length);
    check('选中项的位置报给了原生（原生拿它补悬停/兜底点击）', selects > 0, String(selects));

    const hovers = await page.evaluate(() => window.__hovers.length);
    check('选中项的中心点报给了原生（CSS :hover 靠它）', hovers > 0, String(hovers));
    await page.close();
  }

  /* ---------------------------------------------- 页面接管方向键 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);

    // 页面主动接管（首屏的"移动收藏"模式就是这么干的）
    await page.evaluate(() => {
      window.__kbKeys = [];
      document.addEventListener('kb-key', (e) => {
        window.__kbKeys.push(e.detail.action);
        e.preventDefault();
      }, true);
    });

    const handled = await key(page, 'down');
    const seen = await page.evaluate(() => window.__kbKeys);
    check('页面能通过 kb-key 把方向键接管过去', handled === true && seen.length === 1,
      JSON.stringify({ handled, seen }));

    const boxOn = await page.evaluate(() =>
      document.getElementById('kb-box').classList.contains('kb-on'));
    check('接管之后空间导航不再去挪选中框', boxOn === false, String(boxOn));

    await key(page, 'ok');
    const afterOk = await page.evaluate(() => window.__kbKeys);
    check('确定键也一样能被接管', afterOk.length === 2, JSON.stringify(afterOk));
    await page.close();
  }

  {
    // 没人接的时候一切照旧：事件照样派发，但按键还是走空间导航
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);

    await page.evaluate(() => {
      window.__kbKeys = [];
      document.addEventListener('kb-key', (e) => { window.__kbKeys.push(e.detail.action); });
    });

    const handled = await key(page, 'down');
    const boxOn = await page.evaluate(() =>
      document.getElementById('kb-box').classList.contains('kb-on'));
    const seen = await page.evaluate(() => window.__kbKeys);

    check('没人 preventDefault 时，方向键照常换选中项', handled === true && boxOn === true,
      JSON.stringify({ handled, boxOn }));
    check('事件照常派发出来（页面只是没接）', seen.length === 1, JSON.stringify(seen));
    await page.close();
  }

  /* ---------------------------------------------------------- 确定键 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);

    await key(page, 'down');
    const label = await page.evaluate(() => window.__kb.currentLabel());
    await key(page, 'ok');
    const clicks = await page.evaluate(() => window.__clicks);
    check('确定键点中了选中的那个元素', clicks.length === 1, JSON.stringify({ label, clicks }));
    await page.close();
  }

  /* ---------------------------------------------------------- 返回键 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);

    const free = await key(page, 'back');
    check('页面没什么可退的时候返回键交给原生（false）', free === false, String(free));

    await page.evaluate(() => { window.__swallowBack = true; });
    const swallowed = await key(page, 'back');
    const hits = await page.evaluate(() => window.__backHits);
    check('页面自己的浮层能接住返回键（首屏关菜单就靠这个）', swallowed === true && hits === 1,
      JSON.stringify({ swallowed, hits }));
    await page.close();
  }

  /* -------------------------------------------- 返回键先取消选中 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);

    await key(page, 'down');
    const selected = await page.evaluate(() => !!window.__kb.state.current);
    check('先选中了某个元素', selected);

    const handled = await key(page, 'back');
    check('有选中项时返回键先取消选中，不是急着退页面', handled === true, String(handled));

    const boxOn = await page.evaluate(() =>
      document.getElementById('kb-box').classList.contains('kb-on'));
    check('选中框收掉了', boxOn === false);

    const again = await key(page, 'back');
    check('第二次返回才交给原生（退上一页 / 关标签页）', again === false, String(again));
    await page.close();
  }

  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);

    // 测试页的顺序：第一个 → 第二个 → _blank 链接 → 输入框 → 长按我
    await key(page, 'down');
    await key(page, 'down');
    const before = await page.evaluate(() => window.__kb.currentLabel());
    check('先选到了「第二个」', before === '第二个', before);

    await key(page, 'back');          // 取消选中，但记住位置
    await key(page, 'down');          // 应该从「第二个」接着往下走一步

    const after = await page.evaluate(() => window.__kb.currentLabel());
    check('取消选中之后按方向键从原位置接着走（不是从页面顶部重来）',
      after === '_blank 链接', `${before} → ${after}`);
    await page.close();
  }

  /* -------------------------------------------------------- 有弹层时 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page, `${BASE}/overlay`);

    const back = await key(page, 'back');
    check('页面上有遮罩层时返回键先关弹层', back === true, String(back));
    await page.close();
  }

  /* ------------------------------------------------------------ 长按 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);

    // 先把选中项走到那个监听了 kb-longpress 的元素上
    let onListen = false;
    for (let i = 0; i < 8 && !onListen; i++) {
      await key(page, 'down');
      onListen = await page.evaluate(() =>
        !!(window.__kb.state.current && window.__kb.state.current.el.id === 'listen'));
    }
    check('能选中监听长按的那个元素', onListen);

    const handled = await key(page, 'longok');
    const presses = await page.evaluate(() => window.__longPresses);
    check('长按确定在选中项上派发 kb-longpress', presses === 1, JSON.stringify({ handled, presses }));

    // 没人接的时候必须如实返回 false，不能假装处理掉了
    await key(page, 'down');
    const stray = await key(page, 'longok');
    check('选中项没接长按事件时返回 false', stray === false, String(stray));
    await page.close();
  }

  /* -------------------------------------------------- 链接开成新标签页 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);

    // 走到 _blank 链接上再按确定
    let ok = false;
    for (let i = 0; i < 8 && !ok; i++) {
      await key(page, 'down');
      ok = await page.evaluate(() => window.__kb.state.current && window.__kb.state.current.el.id === 'blank');
    }
    check('能选中 _blank 链接', ok);

    await key(page, 'ok');
    const tabs = await page.evaluate(() => window.__newTabs);
    check('_blank 链接交给了原生开新标签页（不是整页跳转）',
      tabs.length === 1 && tabs[0].endsWith('/target'), JSON.stringify(tabs));

    const stillHere = page.url().startsWith(BASE) && !page.url().endsWith('/target');
    check('当前页没有被顶掉', stillHere, page.url());
    await page.close();
  }

  /* ------------------------------------------------------ 输入框里 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);

    await page.evaluate(() => document.getElementById('q').focus());
    await page.waitForTimeout(120);

    // 软键盘弹不弹是 WebView 和系统输入法的事，脚本只管把按键正确地交还过去
    const typing = await page.evaluate(() => window.__kb.isTyping());
    check('输入框里方向键归还给输入框（isTyping 为真）', typing === true, String(typing));

    const handled = await key(page, 'right');
    check('输入框里按方向键仍然返回 true（合成键盘事件发过去了）', handled === true, String(handled));
    await page.close();
  }

  /* ------------------------------------------ 内容叠加时留在本层 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page, `${BASE}/dropdown`);

    const selectId = (id) => page.evaluate((wanted) => {
      const list = window.__kb.refresh();
      const i = list.findIndex((t) => t.el && t.el.id === wanted);
      if (i < 0) return -1;
      window.__kb.selectAt(i);
      return i;
    }, id);
    const currentId = () => page.evaluate(() =>
      window.__kb.state.current && window.__kb.state.current.el.id);

    check('能选中下拉菜单里的项', (await selectId('m1')) >= 0);
    check('起点是菜单项一', (await currentId()) === 'm1', await currentId());

    await key(page, 'down');
    check('按 ↓ 走菜单项二，没有漏到下面那层页面内容',
      (await currentId()) === 'm2', `现在在 ${await currentId()}`);

    await key(page, 'down');
    check('再按 ↓ 走菜单项三', (await currentId()) === 'm3', `现在在 ${await currentId()}`);

    await key(page, 'down');
    check('菜单走到底之后再按 ↓ 可以走到页面内容（不把人关在层里）',
      (await currentId()) === 'page1', `现在在 ${await currentId()}`);

    await key(page, 'up');
    const back = await currentId();
    check('按 ↑ 能回到菜单里', ['m1', 'm2', 'm3'].includes(back), `现在在 ${back}`);
    await page.close();
  }

  /* ------------------------------ 顶栏不是浮层（B 站头像浮窗那个场景）-- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page, `${BASE}/topbar`);

    const selectId = (id) => page.evaluate((wanted) => {
      const list = window.__kb.refresh();
      const i = list.findIndex((t) => t.el && t.el.id === wanted);
      if (i < 0) return -1;
      window.__kb.selectAt(i);
      return i;
    }, id);
    const currentId = () => page.evaluate(() =>
      window.__kb.state.current && window.__kb.state.current.el.id);

    check('能选中顶栏里的头像', (await selectId('avatar')) >= 0);

    await key(page, 'down');
    check('从顶栏的头像按 ↓，能进到挂在它外面的浮窗里（没被顶栏挡住）',
      (await currentId()) === 'p1', `现在在 ${await currentId()}`);

    await key(page, 'down');
    check('浮窗里继续往下走（斜下方那块内容更近，但不该被它抢走）',
      (await currentId()) === 'p2', `现在在 ${await currentId()}`);

    await key(page, 'down');
    const afterPopup = await currentId();
    check('浮窗走完之后能落到页面内容上（也不会被关在浮窗里）',
      afterPopup === 'c1', `现在在 ${afterPopup}`);

    await key(page, 'up');
    const backIn = await currentId();
    check('按 ↑ 能回到浮窗里', ['p1', 'p2'].includes(backIn), `现在在 ${backIn}`);

    /*
     * 在浮层里上下走，绝对不能把整个页面滚走 ——
     * 以前浮层内找不到下一个目标时会去"翻一屏"（一次最多 4 屏），
     * 表现就是在浮出层里按上下键、页面自己跑掉了。
     */
    const scrollTop = () => page.evaluate(() => {
      const se = document.scrollingElement;
      return se ? se.scrollTop : 0;
    });

    const before = await scrollTop();
    await key(page, 'up');
    await key(page, 'down');
    await key(page, 'up');
    await key(page, 'down');
    const after = await scrollTop();
    check('在浮层里上下走不会滚动整个页面', after === before, `${before} → ${after}`);

    // 把层外的内容藏掉：这时层内已经到底，按 ↓ 该停住，而不是去翻屏找视口外的东西
    await page.evaluate(() => {
      const c = document.getElementById('c1');
      if (c) c.style.display = 'none';
    });
    await page.waitForTimeout(120);
    const before2 = await scrollTop();
    await key(page, 'down');
    await key(page, 'down');
    const after2 = await scrollTop();
    check('浮层里走到头了也不翻屏滚页面', after2 === before2, `${before2} → ${after2}`);
    await page.close();
  }

  {
    // 对照：没有叠加内容时，方向键该照常跨区域走，不能因为加了"层"的判断就困住
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);

    await key(page, 'down');
    const first = await page.evaluate(() => window.__kb.currentLabel());
    await key(page, 'down');
    const second = await page.evaluate(() => window.__kb.currentLabel());
    check('普通页面里方向键照旧换目标（层判断没有误伤）', first !== second,
      `${first} → ${second}`);
    await page.close();
  }

  /* -------------------------------------------------- 触屏长按 = 悬停 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);

    // 长按在原生那边被接成了"鼠标悬停"，所以页面这一侧要把右键菜单收掉
    const prevented = await page.evaluate(() => {
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    check('长按的右键菜单被收掉了（长按留给悬停）', prevented === true, String(prevented));
    await page.close();
  }

  /* ---------------------------------------------------------- viewport -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);
    const content = await page.evaluate(() =>
      document.querySelector('meta[name="viewport"]').getAttribute('content'));
    check('外部网站按桌面宽度排版（电脑版页面铺满电视屏）',
      content.includes('width=1440'), content);
    await page.close();
  }

  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const homeUrl = pathToFileURL(join(assetDir, 'home.html')).href;
    await boot(page, homeUrl);
    const content = await page.evaluate(() =>
      document.querySelector('meta[name="viewport"]').getAttribute('content'));
    check('本地首屏按屏幕宽度排版（不跟着缩放，否则栅格列数会乱）',
      content.includes('device-width'), content);
    await page.close();
  }

  /* ------------------------------------------------------ 重复注入 -- */
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await boot(page);
    await page.addScriptTag({ content: KEYNAV_WEB });
    await page.addScriptTag({ content: KEYNAV_WEB });
    await page.waitForTimeout(150);

    const boxes = await page.locator('#kb-box').count();
    check('重复注入不会挂两套高亮框', boxes === 1, `count=${boxes}`);

    const handled = await key(page, 'down');
    check('重复注入之后遥控器仍然好用', handled === true, String(handled));
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

/* ------------------------------------------------------------ 结果 -- */

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  console.log('失败：');
  for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
  process.exit(1);
}
