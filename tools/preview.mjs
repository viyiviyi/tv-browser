/**
 * 把首屏渲染成预览图，不用装到电视上就能看版面对不对。
 *
 *   $env:NODE_PATH="C:\nvm4w\nodejs\node_modules"; node tools/preview.mjs
 *
 * 产物：dist/preview-960x540.png、dist/preview-960x540-expanded.png
 *       dist/preview-1920x1080.png
 */
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
let chromium = null;
for (const m of [process.env.PW_MODULE, 'playwright', '@playwright/test', 'playwright-core'].filter(Boolean)) {
  try { ({ chromium } = require(m)); if (chromium) break; } catch { /* next */ }
}
if (!chromium) {
  console.error('加载不到 playwright，设 PW_MODULE 指向可解析的模块名');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const assetDir = join(root, 'app', 'src', 'main', 'assets');
const outDir = join(root, 'dist');
const HOME_URL = pathToFileURL(join(assetDir, 'home.html')).href;
const KEYNAV_WEB = await readFile(join(assetDir, 'keynav-web.js'), 'utf8');

const DATA = {
  favorites: [
    'https://www.bilibili.com', 'https://www.baidu.com', 'https://weibo.com',
    'https://www.zhihu.com', 'https://www.taobao.com', 'https://www.jd.com',
    'https://v.qq.com', 'https://www.iqiyi.com', 'https://www.youku.com',
    'https://www.douban.com', 'https://music.163.com', 'https://tv.cctv.com',
  ],
  recent: [
    'https://www.bilibili.com', 'https://www.zhihu.com', 'https://www.douban.com',
    'https://github.com', 'https://www.12306.cn', 'https://www.amap.com',
  ],
  engine: 'baidu',
};

async function shoot(browser, w, h, name, expand) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.addInitScript(() => {
    window.kbHost = {
      ready() {}, newTab() {}, hover() {}, select() {}, showIme() {},
      toast() {}, log() {}, favorite() {}, unfavorite() {}, forget() {}, setEngine() {},
    };
  });
  // 抓不到 favicon 时会回落首字母色块，预览图里直接展示这个回落效果
  await page.route('**/favicon.*', (route) => route.abort());
  await page.goto(HOME_URL);
  await page.addScriptTag({ content: KEYNAV_WEB });
  await page.waitForFunction(() => window.__kbTV && window.__kbTV.__mounted, null, { timeout: 5000 });
  await page.evaluate((d) => window.tvHome.setData(d), DATA);
  if (expand) await page.locator('#fav-grid [data-more]').click();
  await page.waitForTimeout(250);
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, name);
  await page.screenshot({ path: file });
  // 顺手把量出来的版面数据打出来：光看图看不出"图标到底多大"
  const info = await page.evaluate(() => ({
    ...window.tvHome.layout(),
    icon: Math.round(document.querySelector('#fav-grid .icon').getBoundingClientRect().height),
    over: document.documentElement.scrollHeight - window.innerHeight,
  }));
  await page.close();
  console.log(`wrote ${file}  ${w}x${h}`);
  console.log(`     图标 ${info.icon}px（占屏高 ${(info.icon / h * 100).toFixed(1)}%）`
    + ` · 一排 ${info.cols} 个 · 间距 ${info.gap}px · 溢出 ${info.over}px`);
}

const browser = await chromium.launch();
try {
  await shoot(browser, 960, 540, 'preview-960x540.png', false);
  await shoot(browser, 960, 540, 'preview-960x540-expanded.png', true);
  await shoot(browser, 1920, 1080, 'preview-1920x1080.png', false);
} finally {
  await browser.close();
}
