#!/usr/bin/env node
/**
 * 哥俩好 · 网页端单文件打包（build-web-bundle）
 *
 * 把 shared/ 的 14 个 CommonJS 模块 + web/app.js 打进一个 web/app.bundle.js：
 *   - 浏览器一次请求加载全部模块，不走 loader 的十几次 fetch
 *   - 免费隧道 / 弱网下每个请求固定 4~5s 延迟，17 个请求就是 20s+，单文件直接根治
 *   - 模块源码原样内联，逻辑与小程序端 require 的同一份文件零差异
 *
 * 小程序端不受影响：继续用微信的 require + scripts/sync-shared.js。
 * 产物缺失时 index.html 自动回退 loader 模式（本地开发不构建也能跑）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'web', 'app.bundle.js');

// 与 web/app.js 的 DEPS 保持一致（顺序无所谓，运行时按依赖懒加载）
const MODULES = [
  'shared/core/core.js',
  'shared/core/render.js',
  'shared/platform/env.js',
  'shared/platform/routes.js',
  'shared/platform/router.js',
  'shared/platform/sfx-base.js',
  'shared/platform/sfx.web.js',
  'shared/platform/sfx.mp.js',
  'shared/platform/canvas.web.js',
  'shared/platform/canvas.mp.js',
  'shared/net/contract.js',
  'shared/net/ws.js',
  'shared/net/cloud.js',
  'shared/app/lobby.js',
  'shared/app/session.js',
  'web/app.js'
];

/**
 * 把模块里的相对 require 改写成绝对路径：
 *   require('../platform/env.js') -> require('/shared/platform/env.js')
 * 绝对路径的 require 和小程序里的写法原样保留。
 */
function rewriteRequires(src, fromFile) {
  const dir = path.dirname(fromFile); // 相对仓库根，如 'shared/core'
  return src.replace(/require\(\s*(['"])([^'"]+)\1\s*\)/g, function (m, q, spec) {
    if (spec.charAt(0) !== '.') return m;
    const abs = '/' + path.posix.normalize(path.posix.join(dir, spec));
    return 'require(' + q + abs + q + ')';
  });
}

let totalBytes = 0;
const parts = [];

parts.push('/* eslint-disable */');
parts.push('/* 哥俩好 · 网页端单文件打包产物 —— 由 scripts/build-web-bundle.js 自动生成，请勿手改 */');
parts.push('/* 生成时间：' + new Date().toISOString() + ' */');
parts.push('(function () {');
parts.push("  'use strict';");
parts.push('  var __mods = {};');
parts.push('  var __cache = {};');
parts.push('  function __def(p, fn) { __mods[p] = fn; }');
parts.push('  function __req(p) {');
parts.push('    if (__cache[p]) return __cache[p].exports;');
parts.push("    var fn = __mods[p];");
parts.push("    if (!fn) throw new Error('[bundle] 模块未找到: ' + p);");
parts.push('    var mod = { exports: {} };');
parts.push('    __cache[p] = mod;            // 先占位，防循环依赖');
parts.push('    fn(__req, mod, mod.exports);');
parts.push('    return mod.exports;');
parts.push('  }');
parts.push('  // app.js 用 require.boot(DEPS, cb) 启动；bundle 里模块随用随取，直接回调');
parts.push('  __req.boot = function (deps, main) { if (main) main(__req); };');
parts.push('  __req.__glhBundle = true;');
parts.push('  window.require = __req;');
parts.push('');

for (const rel of MODULES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error('[build-web-bundle] 缺文件: ' + rel);
    process.exit(1);
  }
  const src = rewriteRequires(fs.readFileSync(abs, 'utf8'), rel);
  totalBytes += Buffer.byteLength(src);
  parts.push("  __def('/" + rel + "', function (require, module, exports) {");
  parts.push(src.replace(/\n$/, ''));
  parts.push('  });');
  parts.push('');
}

// app.js 顶层就会跑（脚本在 </body> 前，DOM 已就绪）
parts.push("  __req('/web/app.js');");
parts.push('  window.__glhBundled = true;');
parts.push('})();');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, parts.join('\n'));

const kb = (Buffer.byteLength(fs.readFileSync(OUT)) / 1024).toFixed(1);
console.log('[build-web-bundle] ' + MODULES.length + ' 个模块 -> web/app.bundle.js（' + kb + ' KB）');
