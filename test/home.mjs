/**
 * 首屏（app/src/main/assets/home.html + home.js + home.css）的浏览器端测试。
 *
 * 用真实 Chromium 打开 assets 里的 home.html，装上假的 kbHost 与导航脚本，
 * 把首屏真正承诺的东西跑一遍：一排能放几个随屏幕宽度变、收藏超一排会折出"更多"、
 * 最近打开只留一排、长按确定弹收藏/删除菜单、搜索和输网址都开新标签页、
 * favicon 抓不到时回落首字母。
 *
 *   $env:NODE_PATH="C:\nvm4w\nodejs\node_modules"; node test/home.mjs
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
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
const HOME_URL = pathToFileURL(join(assetDir, 'home.html')).href;
const KEYNAV_WEB = await readFile(join(assetDir, 'keynav-web.js'), 'utf8');

/** 12 个收藏（正好比一排放得下的多）+ 8 条最近浏览 */
const DATA = {
  favorites: [
    'https://www.bilibili.com', 'https://www.baidu.com', 'https://weibo.com',
    'https://www.zhihu.com', 'https://www.taobao.com', 'https://www.jd.com',
    'https://v.qq.com', 'https://www.iqiyi.com', 'https://www.youku.com',
    'https://www.douban.com', 'https://music.163.com', 'https://tv.cctv.com',
  ],
  recent: [
    'https://www.bilibili.com', 'https://www.zhihu.com', 'https://www.douban.com',
    'https://github.com', 'https://www.smzdm.com', 'https://www.12306.cn',
    'https://www.amap.com', 'https://www.sohu.com',
  ],
  engine: 'baidu',
};

/* ------------------------------------------------------------- 测试框架 -- */

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : `  → ${detail}`}`);
}

/**
 * 打开首屏：装假的 kbHost、把 favicon 请求全部掐掉（走首字母兜底）、
 * 推一份数据进去、挂上导航脚本。
 */
async function openHome(browser, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript(() => {
    window.__newTabs = [];
    window.__favCalls = [];
    window.__unfavCalls = [];
    window.__forgetCalls = [];
    window.__engines = [];
    window.__savedFavorites = [];
    window.__readyCalls = 0;
    window.kbHost = {
      ready() { window.__readyCalls++; },
      newTab(url) { window.__newTabs.push(url); },
      hover() {},
      select() {},
      toast() {},
      log() {},
      favorite(url) { window.__favCalls.push(url); },
      unfavorite(url) { window.__unfavCalls.push(url); },
      forget(url) { window.__forgetCalls.push(url); },
      setEngine(id) { window.__engines.push(id); },
      saveFavorites(json) { window.__savedFavorites.push(JSON.parse(json)); },
    };
  });
  // favicon 一律抓不到：验证"回落首字母色块"这条路径真的成立
  await page.route('**/favicon.*', (route) => route.abort());
  await page.goto(HOME_URL);
  await page.addScriptTag({ content: KEYNAV_WEB });
  await page.waitForFunction(() => window.__kbTV && window.__kbTV.__mounted, null, { timeout: 5000 });
  await page.waitForFunction(() => !!window.__kb, null, { timeout: 5000 });
  await page.evaluate((d) => window.tvHome.setData(d), DATA);
  return page;
}

/**
 * 把导航脚本的选中框挪到某个 URL 对应的卡片上。
 * 同一个网站在"收藏"和"最近打开"里各有一张卡，所以可以指定要哪一张。
 */
async function selectCard(page, url, kind) {
  return page.evaluate(([u, k]) => {
    const list = window.__kb.refresh();
    const i = list.findIndex((t) => t.el && t.el.dataset && t.el.dataset.url === u
      && (!k || t.el.dataset.kind === k));
    if (i < 0) return -1;
    window.__kb.selectAt(i);
    return i;
  }, [url, kind]);
}

const layoutOf = (page) => page.evaluate(() => window.tvHome.layout());

/* ------------------------------------------------------------------ 跑 -- */

const browser = await chromium.launch();
try {
  /* ------------------------------------------------------------ 版面 -- */
  {
    const page = await openHome(browser, 960, 540);

    const first = await page.locator('#fav-grid .name').first().innerText();
    check('收藏按域名换成了中文名', first === '哔哩哔哩', first);

    const recentNames = await page.locator('#recent-grid .name').allInnerTexts();
    check('最近打开也显示名称', recentNames.length > 0 && recentNames[0] === '哔哩哔哩',
      JSON.stringify(recentNames));

    // 折叠时只摆得下一排，所以按"实际摆出来的卡片数"核对
    const cards = await page.locator('#fav-grid .site[data-url]').count();
    const icons = await page.locator('#fav-grid .icon .initial').count();
    check('每个图标下面都垫着首字母（favicon 抓不到也不会空一块）', icons === cards && cards > 0,
      `首字母 ${icons} 个 / 卡片 ${cards} 个`);

    const imgs = await page.locator('#fav-grid .icon img').count();
    check('抓不到的 favicon 会被摘掉，不留下裂图', imgs === 0, `剩 ${imgs} 个 img`);

    // 收藏没展开时，整页必须正好放得下一屏：电视上没人愿意为了看"最近打开"去滚动
    const over = await page.evaluate(() =>
      document.documentElement.scrollHeight - window.innerHeight);
    check('首屏一屏放得下，不用滚动', over <= 4, `溢出 ${over}px`);

    // 需求写死的版面顺序：上面收藏、中间搜索框、下面最近打开
    const order = await page.evaluate(() => {
      const top = (sel) => document.querySelector(sel).getBoundingClientRect().top;
      const box = (sel) => document.querySelector(sel).getBoundingClientRect();
      const s = box('#search');
      return {
        fav: top('#fav-grid'),
        search: top('#search'),
        recent: top('#recent-grid'),
        searchCenterOff: Math.abs((s.left + s.right) / 2 - window.innerWidth / 2),
      };
    });
    check('版面顺序是：收藏 → 搜索框 → 最近打开',
      order.fav < order.search && order.search < order.recent,
      JSON.stringify(order));
    check('搜索框水平居中', order.searchCenterOff <= 1, `偏了 ${order.searchCenterOff}px`);

    const emph = await page.evaluate(() => {
      const g = document.getElementById('fav-grid').getBoundingClientRect();
      const r = document.getElementById('recent-grid').getBoundingClientRect();
      const s = document.getElementById('search').getBoundingClientRect();
      return { above: s.top - g.bottom, below: r.top - s.bottom, searchH: s.height };
    });
    check('搜索框不是贴着一堆卡片（上下都留了气口）',
      emph.above >= 8 && emph.below >= 8, JSON.stringify(emph));
    await page.close();
  }

  {
    // 大屏电视（1920×1080 逻辑分辨率）也要放得下
    const page = await openHome(browser, 1920, 1080);
    const over = await page.evaluate(() =>
      document.documentElement.scrollHeight - window.innerHeight);
    check('1920×1080 下首屏也一屏放得下', over <= 4, `溢出 ${over}px`);
    await page.close();
  }

  {
    // 小屏（720p 盒子常见）同样不能挤爆
    const page = await openHome(browser, 960, 540);
    const over = await page.evaluate(() => {
      document.documentElement.style.setProperty('--search-w', '600px');
      return document.documentElement.scrollHeight - window.innerHeight;
    });
    check('960×540 下首屏没有溢出', over <= 4, `溢出 ${over}px`);
    await page.close();
  }

  /* -------------------------------------------------- 一排能放几个 -- */
  {
    const page = await openHome(browser, 960, 540);
    const l = await layoutOf(page);

    // "两边各留一个图标的宽度"：可用宽度 = 屏宽 - 2 个格子
    const usable = 960 - l.cell * 2;
    const need = l.cols * l.cell + (l.cols - 1) * l.gap;
    check('列数是按"两边各留一个图标宽度"算出来的', need <= usable + 1,
      `cols=${l.cols} cell=${l.cell} gap=${l.gap} 用了 ${need} / 可用 ${usable}`);

    const gaps = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#recent-grid .site')];
      const firstCard = cards[0].getBoundingClientRect();
      const lastCard = cards[cards.length - 1].getBoundingClientRect();
      return {
        left: firstCard.left,
        right: window.innerWidth - lastCard.right,
        W: window.innerWidth,
      };
    });
    check('整排居中，两侧留白都不小于一个图标的宽度',
      gaps.left >= l.cell - 2 && gaps.right >= l.cell - 2,
      JSON.stringify({ ...gaps, cell: l.cell }));

    // 图标不能大到喧宾夺主，也不能小到看不清
    const iconH = await page.evaluate(() =>
      document.querySelector('#fav-grid .icon').getBoundingClientRect().height);
    const ratio = iconH / 540;
    check('图标大小落在电视上舒服的区间（屏高的 9%～16%）',
      ratio >= 0.09 && ratio <= 0.16,
      `图标 ${iconH}px，占屏高 ${(ratio * 100).toFixed(1)}%（一排 ${l.cols} 个）`);
    await page.close();
  }

  {
    // 屏幕越宽，一排能放的越多；越窄越少
    const wide = await openHome(browser, 1400, 800);
    const wideL = await layoutOf(wide);
    await wide.close();

    const narrow = await openHome(browser, 700, 420);
    const narrowL = await layoutOf(narrow);
    await narrow.close();

    check('屏幕越宽一排放得越多', wideL.cols > narrowL.cols,
      `1400 → ${wideL.cols} 列，700 → ${narrowL.cols} 列`);
    check('窄屏至少也能放下一列', narrowL.cols >= 1, String(narrowL.cols));
    check('格子大小随屏幕变（不是写死的像素）', wideL.cell !== narrowL.cell,
      `${wideL.cell} vs ${narrowL.cell}`);
  }

  /* ------------------------------------------------------ 收藏折叠 -- */
  {
    const page = await openHome(browser, 960, 540);
    const l = await layoutOf(page);

    const shown = await page.locator('#fav-grid .site').count();
    check('收藏比一排放得下的时候，只摆一排', shown === l.cols,
      `摆 ${shown} 个，一排是 ${l.cols}`);

    const more = page.locator('#fav-grid [data-more]');
    check('多出来的位置给了「更多」按钮', await more.count() === 1);
    check('「更多」按钮上写着更多', (await more.innerText()).includes('更多'), await more.innerText());

    await more.click();
    const expanded = await page.locator('#fav-grid .site').count();
    check('点「更多」之后显示全部收藏', expanded === DATA.favorites.length + 1,
      `${expanded} 个（含"收起"按钮）`);

    const lastLabel = await page.locator('#fav-grid .site').last().innerText();
    check('展开之后按钮变成「收起」', lastLabel.includes('收起'), lastLabel);

    await page.locator('#fav-grid [data-more]').click();
    const collapsed = await page.locator('#fav-grid .site').count();
    check('再点一次能收回去', collapsed === l.cols, String(collapsed));
    await page.close();
  }

  {
    // 收藏不超过一排时不该出现"更多"
    const page = await openHome(browser, 960, 540);
    await page.evaluate(() => window.tvHome.setData({
      favorites: ['https://www.bilibili.com', 'https://www.baidu.com', 'https://weibo.com'],
      recent: [],
      engine: 'baidu',
    }));
    check('收藏放得下时全部显示', (await page.locator('#fav-grid .site').count()) === 3);
    check('收藏放得下时不出现「更多」', (await page.locator('#fav-grid [data-more]').count()) === 0);
    await page.close();
  }

  /* ------------------------------------------------ 最近打开只留一排 -- */
  {
    const page = await openHome(browser, 960, 540);
    const l = await layoutOf(page);

    const count = await page.locator('#recent-grid .site').count();
    check('最近打开最多只显示一排', count === Math.min(DATA.recent.length, l.cols),
      `显示 ${count} 个，一排 ${l.cols} 个，记录共 ${DATA.recent.length} 条`);

    const rows = await page.evaluate(() => {
      const tops = new Set([...document.querySelectorAll('#recent-grid .site')]
        .map((el) => Math.round(el.getBoundingClientRect().top)));
      return tops.size;
    });
    check('最近打开确实只有一行', rows === 1, `${rows} 行`);

    check('最近打开区没有「更多」按钮（需求就是只留一排）',
      await page.locator('#recent-grid [data-more]').count() === 0);
    await page.close();
  }

  /* -------------------------------------------------------- 长按菜单 -- */
  {
    const page = await openHome(browser, 960, 540);

    check('平时不显示菜单', !(await page.locator('#sheet').isVisible()));

    const target = 'https://github.com';
    const idx = await selectCard(page, target);
    check('能把选中框挪到指定的那个网站卡片上', idx >= 0, String(idx));

    await page.evaluate(() => window.__kbTV.key('longok'));
    check('长按确定弹出菜单', await page.locator('#sheet').isVisible());

    const actions = await page.locator('#sheet-actions .act').allInnerTexts();
    check('菜单里有「收藏这个网站」', actions.some((t) => t.includes('收藏')), JSON.stringify(actions));
    check('菜单里有「从最近打开中删除」', actions.some((t) => t.includes('删除')), JSON.stringify(actions));

    await page.locator('#sheet-actions .act', { hasText: '收藏' }).first().click();
    await page.waitForTimeout(60);
    const favs = await page.evaluate(() => window.__favCalls);
    check('点「收藏这个网站」会通知原生', favs.includes(target), JSON.stringify(favs));
    check('动作做完菜单自己关掉', !(await page.locator('#sheet').isVisible()));
    await page.close();
  }

  {
    const page = await openHome(browser, 960, 540);
    // 只在"最近打开"那一排里选：一排只显示前几个，挑得靠前的才选得到
    const target = 'https://www.smzdm.com';
    const idx = await selectCard(page, target);
    check('能选中最近打开里的卡片', idx >= 0, String(idx));

    await page.evaluate(() => window.__kbTV.key('longok'));
    check('长按弹出菜单', await page.locator('#sheet').isVisible());

    await page.locator('#sheet-actions .act', { hasText: '删除' }).first().click();
    await page.waitForTimeout(60);
    const forgot = await page.evaluate(() => window.__forgetCalls);
    check('点「删除」会通知原生（从最近打开里去掉）', forgot.includes(target), JSON.stringify(forgot));
    await page.close();
  }

  {
    const page = await openHome(browser, 960, 540);
    const target = 'https://www.bilibili.com';   // 同时也在收藏里
    // 要点的是"最近打开"区里的那一张：菜单才能反映它已经收藏过了
    const idx = await selectCard(page, target, 'recent');
    check('选中了最近打开区里的那张卡', idx >= 0, String(idx));

    await page.evaluate(() => window.__kbTV.key('longok'));
    const actions = await page.locator('#sheet-actions .act').allInnerTexts();
    check('已经收藏过的网站，菜单里是「取消收藏」',
      actions.some((t) => t.includes('取消收藏')), JSON.stringify(actions));

    await page.locator('#sheet-actions .act', { hasText: '取消收藏' }).first().click();
    await page.waitForTimeout(60);
    const unfav = await page.evaluate(() => window.__unfavCalls);
    check('点「取消收藏」会通知原生', unfav.includes(target), JSON.stringify(unfav));
    await page.close();
  }

  {
    // 收藏区里的卡片长按 → 「移动位置」和「删除」，不带最近打开那一套
    const page = await openHome(browser, 960, 540);
    const target = 'https://www.taobao.com';
    const idx = await selectCard(page, target, 'fav');
    check('收藏区的卡片也能被选中', idx >= 0, String(idx));
    await page.evaluate(() => window.__kbTV.key('longok'));
    const actions = await page.locator('#sheet-actions .act').allInnerTexts();
    check('收藏项长按菜单里有「移动位置」',
      actions.some((t) => t.includes('移动位置')), JSON.stringify(actions));
    check('收藏项长按菜单里有「删除」',
      actions.some((t) => t === '删除'), JSON.stringify(actions));
    check('收藏项长按菜单里没有「从最近打开中删除」',
      !actions.some((t) => t.includes('最近打开')), JSON.stringify(actions));

    await page.locator('#sheet-actions .act', { hasText: '删除' }).first().click();
    await page.waitForTimeout(60);
    const unfav = await page.evaluate(() => window.__unfavCalls);
    check('点「删除」会通知原生', unfav.includes(target), JSON.stringify(unfav));
    await page.close();
  }

  /* ------------------------------------------------------ 移动收藏位置 -- */
  {
    const page = await openHome(browser, 960, 540);
    const before = await page.evaluate(() => window.tvHome.state().favorites);

    // 选中 3 号位（下标 2）的收藏，长按 → 移动位置
    const target = before[2];
    await selectCard(page, target, 'fav');
    await page.evaluate(() => window.__kbTV.key('longok'));
    await page.locator('#sheet-actions .act', { hasText: '移动位置' }).first().click();
    await page.waitForTimeout(80);

    check('点了「移动位置」之后菜单关掉', !(await page.locator('#sheet').isVisible()));
    const moving = await page.locator('#fav-grid .site.moving').count();
    check('正在移动的那一张会被标出来', moving === 1, String(moving));
    check('提示文字换成了移动模式的说明',
      (await page.locator('.hint').innerText()).includes('挪动'), await page.locator('.hint').innerText());

    // ← 往前挪一位
    await page.evaluate(() => window.__kbTV.key('left'));
    await page.waitForTimeout(60);
    let now = await page.evaluate(() => window.tvHome.state().favorites);
    check('按 ← 往前挪了一位', now[1] === target, JSON.stringify(now));

    // → 挪回去，再往后挪一位
    await page.evaluate(() => window.__kbTV.key('right'));
    await page.waitForTimeout(60);
    await page.evaluate(() => window.__kbTV.key('right'));
    await page.waitForTimeout(60);
    now = await page.evaluate(() => window.tvHome.state().favorites);
    check('按 → 往后挪了一位', now[3] === target, JSON.stringify(now));

    // ↑ ↓ 也能挪（一维顺序，只是方向不同）
    await page.evaluate(() => window.__kbTV.key('up'));
    await page.waitForTimeout(60);
    now = await page.evaluate(() => window.tvHome.state().favorites);
    check('按 ↑ 也是往前挪一位', now[2] === target, JSON.stringify(now));

    // 挪到最前面之后，再往前应该原地不动
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.__kbTV.key('left'));
    }
    await page.waitForTimeout(60);
    now = await page.evaluate(() => window.tvHome.state().favorites);
    check('挪到头就不动了（不会绕到末尾）', now[0] === target, JSON.stringify(now));

    // 确定键结束，把新顺序写回原生
    await page.evaluate(() => window.__kbTV.key('ok'));
    await page.waitForTimeout(80);
    check('确定之后退出移动模式', (await page.locator('#fav-grid .site.moving').count()) === 0);
    check('提示文字变回原来的', (await page.locator('.hint').innerText()).includes('长按'),
      await page.locator('.hint').innerText());

    const saved = await page.evaluate(() => window.__savedFavorites);
    check('把排好的顺序交给了原生', saved.length === 1, JSON.stringify(saved.length));
    check('交给原生的顺序就是挪完的顺序', saved[0] && saved[0][0] === target,
      JSON.stringify(saved[0] && saved[0].slice(0, 3)));

    // 交完之后导航脚本的选中框还在同一张卡上
    const stillSelected = await page.evaluate(() =>
      window.__kb.state.current && window.__kb.state.current.el.dataset.url);
    check('重排之后选中框还跟着那一张', stillSelected === target, String(stillSelected));
    await page.close();
  }

  {
    // 返回键也能结束移动（位置不回滚）
    const page = await openHome(browser, 960, 540);
    const before = await page.evaluate(() => window.tvHome.state().favorites);
    await selectCard(page, before[1], 'fav');
    await page.evaluate(() => window.__kbTV.key('longok'));
    await page.locator('#sheet-actions .act', { hasText: '移动位置' }).first().click();
    await page.waitForTimeout(80);

    await page.evaluate(() => window.__kbTV.key('left'));
    await page.waitForTimeout(60);
    const handled = await page.evaluate(() => window.__kbTV.key('back'));
    await page.waitForTimeout(60);

    check('移动模式下返回键被页面接住', handled === true, String(handled));
    check('返回键退出移动模式', (await page.locator('#fav-grid .site.moving').count()) === 0);
    const now = await page.evaluate(() => window.tvHome.state().favorites);
    check('已经挪过的位置保留下来', now[0] === before[1], JSON.stringify(now));
    const saved = await page.evaluate(() => window.__savedFavorites);
    check('返回键结束也会写回原生', saved.length === 1, String(saved.length));
    await page.close();
  }

  {
    // 不在移动模式时，方向键必须还给导航脚本（别把普通浏览也拦了）
    const page = await openHome(browser, 960, 540);
    await page.evaluate(() => window.__kbTV.key('down'));
    const selected = await page.evaluate(() => !!window.__kb.state.current);
    check('没在移动模式时方向键照常换选中项', selected === true);

    const history = await page.evaluate(() => window.tvHome.state().favorites);
    await page.evaluate(() => window.__kbTV.key('right'));
    const after = await page.evaluate(() => window.tvHome.state().favorites);
    check('没在移动模式时方向键不会改动收藏顺序',
      JSON.stringify(history) === JSON.stringify(after));
    await page.close();
  }

  {
    // 返回键要能关掉菜单，而不是一路退到关标签页
    const page = await openHome(browser, 960, 540);
    await selectCard(page, 'https://www.douban.com');
    await page.evaluate(() => window.__kbTV.key('longok'));
    check('菜单开着', await page.locator('#sheet').isVisible());

    const handled = await page.evaluate(() => window.__kbTV.key('back'));
    check('返回键被页面接住（不会去关标签页）', handled === true, String(handled));
    check('返回键关掉了菜单', !(await page.locator('#sheet').isVisible()));
    await page.close();
  }

  {
    // 空白的背景上长按不该弹菜单
    const page = await openHome(browser, 960, 540);
    await page.evaluate(() => { window.__kb.clearSelection(); });
    await page.evaluate(() => window.__kbTV.key('longok'));
    check('没选中任何卡片时，长按确定不会弹菜单', !(await page.locator('#sheet').isVisible()));
    await page.close();
  }

  /* ------------------------------------------------------------ 搜索 -- */
  {
    const page = await openHome(browser, 960, 540);

    await page.fill('#q', '电视浏览器');
    await page.press('#q', 'Enter');
    await page.waitForTimeout(60);
    let tabs = await page.evaluate(() => window.__newTabs);
    check('搜关键词会打开百度结果页',
      tabs.length === 1 && tabs[0].startsWith('https://www.baidu.com/s?wd='), JSON.stringify(tabs));
    check('关键词被正确编码', tabs[0].includes(encodeURIComponent('电视浏览器')), tabs[0]);

    await page.fill('#q', 'example.com');
    await page.press('#q', 'Enter');
    await page.waitForTimeout(60);
    tabs = await page.evaluate(() => window.__newTabs);
    check('输入网址直接打开（不会再拿去搜）', tabs[1] === 'https://example.com', tabs[1]);

    await page.fill('#q', 'https://www.zhihu.com/question/1');
    await page.press('#q', 'Enter');
    await page.waitForTimeout(60);
    tabs = await page.evaluate(() => window.__newTabs);
    check('带协议的完整网址原样打开', tabs[2] === 'https://www.zhihu.com/question/1', tabs[2]);

    check('搜索完输入框会清空', (await page.inputValue('#q')) === '');
    await page.close();
  }

  /* -------------------------------------------------------- 搜索引擎 -- */
  {
    const page = await openHome(browser, 960, 540);

    const names = await page.locator('.engine').allInnerTexts();
    check('可以切换多个搜索引擎', names.length >= 4, JSON.stringify(names));
    check('默认选中百度', (await page.locator('.engine.on').innerText()) === '百度');

    await page.locator('[data-engine="bing"]').click();
    await page.waitForTimeout(60);
    const engines = await page.evaluate(() => window.__engines);
    check('切换引擎会通知原生保存', engines.includes('bing'), JSON.stringify(engines));
    check('切换之后高亮跟过去', (await page.locator('.engine.on').innerText()) === '必应');

    await page.fill('#q', '电视');
    await page.press('#q', 'Enter');
    await page.waitForTimeout(60);
    const tabs = await page.evaluate(() => window.__newTabs);
    check('之后的搜索走新选的引擎', tabs[0].startsWith('https://cn.bing.com/search?q='), tabs[0]);
    await page.close();
  }

  /* ---------------------------------------------------- 原生推的新数据 -- */
  {
    const page = await openHome(browser, 960, 540);
    const res = await page.evaluate(() => window.tvHome.setData({
      favorites: ['https://github.com'],
      recent: ['https://github.com'],
      engine: 'google',
    }));
    check('setData 接受对象并返回结果', res && res.ok === true, JSON.stringify(res));
    check('收藏被换成新数据', (await page.locator('#fav-grid .site').count()) === 1);
    check('最近打开被换成新数据', (await page.locator('#recent-grid .site').count()) === 1);
    check('名字从域名推出来', (await page.locator('#fav-grid .name').first().innerText()) === 'GitHub');
    check('引擎跟着数据变', (await page.locator('.engine.on').innerText()) === '谷歌');
    check('一条收藏时不出现「更多」', (await page.locator('#fav-grid [data-more]').count()) === 0);

    const bad = await page.evaluate(() => window.tvHome.setData('{不是 json'));
    check('坏数据不会把首屏搞崩', bad && bad.ok === false, JSON.stringify(bad));
    await page.close();
  }

  {
    // 空数据：要给出提示，而不是一片空白
    const page = await openHome(browser, 960, 540);
    await page.evaluate(() => window.tvHome.setData({ favorites: [], recent: [], engine: 'baidu' }));
    check('没有收藏时给出提示', await page.locator('#fav-empty').isVisible());
    check('没有记录时给出提示', await page.locator('#recent-empty').isVisible());
    await page.close();
  }
} finally {
  await browser.close();
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
