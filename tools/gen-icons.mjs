/**
 * 生成电视桌面用的横幅和图标（Playwright 渲染 HTML → PNG）。
 *
 *   $env:NODE_PATH="C:\nvm4w\nodejs\node_modules"; node tools/gen-icons.mjs
 *
 * 只在改了图标设计之后需要跑；生成结果已经提交在 res/ 里。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

// playwright 装在全局 node_modules 里（ESM 不认 NODE_PATH，得手动解析）
const require = createRequire(import.meta.url);
let chromium = null;
for (const m of [process.env.PW_MODULE, 'playwright', '@playwright/test', 'playwright-core'].filter(Boolean)) {
  try { ({ chromium } = require(m)); if (chromium) break; } catch { /* try next */ }
}
if (!chromium) {
  console.error('加载不到 playwright，设 PW_MODULE 指向可解析的模块名');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const res = join(root, 'app', 'src', 'main', 'res');

/** 一个地球仪：圆的边框 + 一条竖椭圆 + 一条赤道 */
const globe = (size, stroke) => `<svg viewBox="0 0 100 100" width="${size}" height="${size}" fill="none"
    stroke="${stroke}" stroke-width="7" stroke-linecap="round">
    <circle cx="50" cy="50" r="30"></circle>
    <ellipse cx="50" cy="50" rx="14" ry="30"></ellipse>
    <path d="M20 50h60"></path>
  </svg>`;

const iconHtml = (size) => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${size}px; height:${size}px; overflow:hidden;
         background:linear-gradient(135deg,#3b82f6 0%,#6d5efc 100%);
         display:flex; align-items:center; justify-content:center; }
</style></head><body>${globe(Math.round(size * 0.68), '#ffffff')}</body></html>`;

const bannerHtml = (w, h) => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${w}px; height:${h}px; overflow:hidden;
         background:linear-gradient(135deg,#10131b 0%,#151b2d 55%,#1d2340 100%);
         font-family:"Microsoft YaHei","Segoe UI",sans-serif; color:#fff;
         display:flex; align-items:center; justify-content:center; gap:${Math.round(h * 0.13)}px; }
  .mark { width:${Math.round(h * 0.56)}px; height:${Math.round(h * 0.56)}px; border-radius:${Math.round(h * 0.18)}px;
          background:linear-gradient(135deg,#3b82f6 0%,#6d5efc 100%);
          display:flex; align-items:center; justify-content:center;
          box-shadow:0 6px 24px rgba(76,124,255,.45); }
  .txt { display:flex; flex-direction:column; gap:${Math.round(h * 0.05)}px; }
  .t1 { font-size:${Math.round(h * 0.23)}px; font-weight:700; letter-spacing:2px; }
  .t2 { font-size:${Math.round(h * 0.11)}px; color:#9aa4b2; letter-spacing:1px; }
  .keys { display:flex; gap:${Math.round(h * 0.04)}px; margin-top:${Math.round(h * 0.03)}px; }
  .k { font-size:${Math.round(h * 0.1)}px; padding:2px ${Math.round(h * 0.05)}px; border-radius:6px;
       background:rgba(255,255,255,.10); color:#b8d4ff; }
</style></head><body>
  <div class="mark">${globe(Math.round(h * 0.36), '#ffffff')}</div>
  <div class="txt">
    <div class="t1">电视浏览器</div>
    <div class="t2">遥控器就能上的网页</div>
    <div class="keys"><span class="k">↑</span><span class="k">↓</span><span class="k">←</span><span class="k">→</span><span class="k">OK</span><span class="k">返回</span></div>
  </div>
</body></html>`;

const browser = await chromium.launch();
try {
  const targets = [
    { html: bannerHtml(320, 180), w: 320, h: 180, dir: join(res, 'drawable'), name: 'app_banner.png' },
    { html: iconHtml(48), w: 48, h: 48, dir: join(res, 'mipmap-mdpi'), name: 'ic_launcher.png' },
    { html: iconHtml(72), w: 72, h: 72, dir: join(res, 'mipmap-hdpi'), name: 'ic_launcher.png' },
    { html: iconHtml(96), w: 96, h: 96, dir: join(res, 'mipmap-xhdpi'), name: 'ic_launcher.png' },
    { html: iconHtml(144), w: 144, h: 144, dir: join(res, 'mipmap-xxhdpi'), name: 'ic_launcher.png' },
    { html: iconHtml(192), w: 192, h: 192, dir: join(res, 'mipmap-xxxhdpi'), name: 'ic_launcher.png' },
  ];
  for (const t of targets) {
    await mkdir(t.dir, { recursive: true });
    const page = await browser.newPage({ viewport: { width: t.w, height: t.h }, deviceScaleFactor: 1 });
    await page.setContent(t.html, { waitUntil: 'load' });
    const buf = await page.screenshot({ type: 'png' });
    await writeFile(join(t.dir, t.name), buf);
    await page.close();
    console.log(`wrote ${join(t.dir, t.name)}  ${t.w}x${t.h}  ${(buf.length / 1024).toFixed(1)} KB`);
  }
} finally {
  await browser.close();
}
