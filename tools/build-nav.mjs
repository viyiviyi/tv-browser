/**
 * 把 bili-keynav 的导航引擎打包成电视浏览器用的注入脚本。
 *
 *   node tools/build-nav.mjs
 *
 * 输入：
 *   ../bili-keynav/src/core.js      空间导航算法（通用，原样复用）
 *   ../bili-keynav/src/app.js       导航控制器（通用，两处定点适配，见下）
 *   ../src-web/web-bridge.js        遥控器桥接层（这个项目自己的）
 *
 * 输出：
 *   app/src/main/assets/keynav-web.js
 *
 * 对 app.js 的两处适配都是**定点文本替换**，替换不到就直接报错退出 ——
 * 宁可构建失败，也不要打出一个悄悄坏掉的脚本。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const engineDir = resolve(root, '..', 'bili-keynav');
const outFile = join(root, 'app', 'src', 'main', 'assets', 'keynav-web.js');

/* ---------------------------------------------------------- 定点适配 -- */

/**
 * 适配一：播放器容器的选择器。
 *
 * 原版只认 B 站自己的播放器；浏览器要逛任意网站，所以补上 <video> ——
 * 绝大多数第三方播放器（video.js / dplayer / plyr / artplayer …）内部
 * 都还有真的 <video> 元素，命中它就能用上"确定=播放/暂停、双击=全屏"。
 */
const PLAYER_REPLACE = {
  from: "const PLAYER_SELECTOR = '.bpx-player-container, .bilibili-player, #bilibili-player';",
  to: "const PLAYER_SELECTOR = '.bpx-player-container, .bilibili-player, #bilibili-player, video';",
};

/**
 * 适配二：videoOf 要认得"容器本身就是 <video>"。
 *
 * app.js 里原本是 container.querySelector('video')，而它接的容器在 B 站上
 * 永远是 .bpx-player-container 这类外层 div。选择器补上 video 之后，
 * 容器可能**就是**那个 <video>，而 querySelector 不会匹配自身，
 * 于是播放/暂停会静默失效，所以这里补一个自身判断。
 */
const VIDEO_OF_REPLACE = {
  from: [
    'function videoOf(container) {',
    '  if (!container || !container.querySelector) return null;',
    '  try {',
    "    return container.querySelector('video');",
    '  } catch {',
    '    return null;',
    '  }',
    '}',
  ].join('\n'),
  to: [
    'function videoOf(container) {',
    '  if (!container || !container.querySelector) return null;',
    '  try {',
    "    if (container.tagName === 'VIDEO') return container;",
    "    return container.querySelector('video');",
    '  } catch {',
    '    return null;',
    '  }',
    '}',
  ].join('\n'),
};

function applyOnce(source, rule, label) {
  const at = source.indexOf(rule.from);
  if (at < 0) {
    throw new Error(
      `app.js 里找不到要替换的片段（${label}），说明它已经被改过：\n`
      + rule.from.split('\n').slice(0, 2).join('\n'),
    );
  }
  if (source.indexOf(rule.from, at + 1) >= 0) {
    throw new Error(`app.js 里要替换的片段（${label}）出现了多次，无法确定改哪一个`);
  }
  return source.slice(0, at) + rule.to + source.slice(at + rule.from.length);
}

/* ------------------------------------------------------------ 打包 -- */

/** 去掉 ESM 语法，得到可以直接塞进普通函数体里的源码 */
function stripModule(src) {
  return src
    .replace(/^export\s*\{[^}]*\}\s*;?/gm, '')
    .replace(/^export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, '$1 $2')
    .trim();
}

async function readEngine(file) {
  try {
    return await readFile(join(engineDir, file), 'utf8');
  } catch (e) {
    throw new Error(`读不到导航引擎 ${join(engineDir, file)}\n先确认 ../bili-keynav 还在原位`);
  }
}

const coreRaw = await readEngine(join('src', 'core.js'));
let appRaw = await readEngine(join('src', 'app.js'));
const bridgeRaw = await readFile(join(root, 'src-web', 'web-bridge.js'), 'utf8');

appRaw = applyOnce(appRaw, PLAYER_REPLACE, 'PLAYER_SELECTOR');
appRaw = applyOnce(appRaw, VIDEO_OF_REPLACE, 'videoOf');

/** 去掉 import 行（这些模块被拍平到同一个作用域里了） */
function dropImports(src) {
  return src.replace(/^import\s*\{[^}]*\}\s*from\s*'[^']*';?\s*$/gm, '').trim();
}

const header = [
  '/* 夜间模式：浏览器要忠实呈现网站，不注入任何站点专属主题 */',
  "const DARK_THEME_CSS = '';",
].join('\n');

const body = [
  header,
  `/* ===================== bili-keynav/src/core.js ===================== */\n${stripModule(coreRaw)}`,
  `/* ===================== bili-keynav/src/app.js ====================== */\n${stripModule(dropImports(appRaw))}`,
  `/* ===================== src-web/web-bridge.js ======================= */\n${bridgeRaw.trim()}`,
].join('\n\n');

const bundle = `/*!
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

${body}

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
`;

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, bundle, 'utf8');

console.log(`built ${outFile}`);
console.log(`  ${(bundle.length / 1024).toFixed(1)} KB / ${bundle.split('\n').length} 行`);
console.log('  引擎来源 ../bili-keynav（core.js + app.js，已做 2 处定点适配）');
