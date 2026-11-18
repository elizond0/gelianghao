#!/usr/bin/env node
/**
 * 构建静态发布目录 dist/
 *
 * 产物（bundle 时代）：
 *   dist/
 *   ├── index.html        改写：绝对路径 → 相对路径；注入离线配置 + 联机拦截
 *   ├── app.bundle.js     单文件打包产物（16 个模块合一，首选加载路径）
 *   ├── app.js            兜底：bundle 没构建时走 loader 模式
 *   ├── style.css
 *   └── shared/...        loader 模式才用得上（含 shared/loader.js）
 *
 * 两种打开方式都能玩：
 *   1. 任意静态托管（GitHub Pages / surge / Netlify / 对象存储）——上传整个 dist/
 *   2. 本地双击 index.html——bundle 是普通 <script>，不走 fetch，file:// 也能跑
 *
 * 联机说明：静态托管上跑不了 Node WebSocket 服务。
 *   构建时注入 window.__GLH_OFFLINE__ = true，并用捕获阶段监听拦掉联机按钮，
 *   点击给明确提示，不会静默连不上、也不会无限重连。
 *
 * 用法：
 *   node scripts/build-static.js              默认离线版
 *   node scripts/build-static.js --ws=wss://xxx 指定联机服务地址（进阶）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const wsArg = (process.argv.find(a => a.startsWith('--ws=')) || '').split('=')[1] || '';

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name);
    const b = path.join(to, name);
    if (fs.statSync(a).isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

// ---------------- 0. 依赖检查：bundle 必须是最新的 ----------------
const BUNDLE = path.join(ROOT, 'web', 'app.bundle.js');
if (!fs.existsSync(BUNDLE)) {
  console.error('找不到 web/app.bundle.js，先跑：npm run build:bundle');
  process.exit(1);
}

// ---------------- 1. 清空 + 复制资源 ----------------
rmrf(DIST);
fs.mkdirSync(DIST, { recursive: true });

// 网页壳：bundle 优先，loader 兜底，外加样式
for (const f of ['app.bundle.js', 'app.js', 'style.css']) {
  fs.copyFileSync(path.join(ROOT, 'web', f), path.join(DIST, f));
}

// shared：保持内部相对层级，require('../platform/env.js') 不用改（loader 模式用）
copyDir(path.join(ROOT, 'shared'), path.join(DIST, 'shared'));

// GitHub Pages：标记跳过 Jekyll 处理（否则下划线开头文件会被忽略，且构建慢）
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

// ---------------- 2. 改写 index.html ----------------
let html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

// 绝对路径 → 相对路径（静态托管在子路径下也能用；file:// 打开同样成立）
// 注意：document.write 里的兜底 src 也要一并改写
html = html
  .replace(/src="\/app\.bundle\.js"/g, 'src="app.bundle.js"')
  .replace(/src="\/loader\.js"/g, 'src="shared/loader.js"')
  .replace(/src="\/app\.js"/g, 'src="app.js"')
  .replace(/href="\/style\.css"/g, 'href="style.css"');

// ---------------- 3. 注入离线配置 + 联机拦截 ----------------
// 拦截用捕获阶段监听：app.js（或 loader）什么时候绑 onclick 都能盖住，
// stopPropagation 之后元素自己的 handler 根本不会触发。
const inject = wsArg
  ? `<script>window.__GLH_WS__ = ${JSON.stringify(wsArg)};</script>`
  : `<script>
  // 静态托管：没有 Node WebSocket 服务，联机不可用。
  window.__GLH_OFFLINE__ = true;
  window.__GLH_STATIC__ = true;
</script>
<script>
(function () {
  if (!window.__GLH_OFFLINE__) return;
  var MSG = '静态版没有联机服务，只能单人玩。要联机请用完整版（自建服务器）';
  var timer = null;
  function say() {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = MSG;
    t.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(function () { t.classList.remove('show'); }, 3600);
  }
  // 捕获阶段比目标元素的 onclick 更早，拦住即生效
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.id === 'btnRoom' || el.id === 'btnCreate' || el.id === 'btnJoin') {
        e.preventDefault();
        e.stopPropagation();
        say();
        return;
      }
      el = el.parentElement;
    }
  }, true);
})();
</script>`;

// 插在 </body> 前：此时 DOM 已解析完，且排在 bundle/兜底脚本之后
html = html.replace('</body>', inject + '\n</body>');

fs.writeFileSync(path.join(DIST, 'index.html'), html);

// ---------------- 4. 校验：不能有绝对路径残留 ----------------
const leftovers = [];
(function scan(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { scan(p); continue; }
    if (!/\.(js|html|css)$/.test(name)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const m = src.match(/(?:src|href)="\/[^"]+"|fetch\('\/[^']+'\)/g);
    if (m) leftovers.push(path.relative(DIST, p) + ' → ' + m.slice(0, 3).join(', '));
  }
})(DIST);

console.log('构建完成 → dist/');
console.log('  文件数：' + (function count(d) {
  let n = 0;
  for (const x of fs.readdirSync(d)) {
    const p = path.join(d, x);
    n += fs.statSync(p).isDirectory() ? count(p) : 1;
  }
  return n;
})(DIST));
console.log('  联机：' + (wsArg ? '指向 ' + wsArg : '离线模式（单机可玩）'));
if (leftovers.length) {
  console.log('\n⚠️ 以下文件仍有根绝对路径，子路径部署时可能 404：');
  leftovers.forEach(l => console.log('  ' + l));
} else {
  console.log('  ✅ 无根绝对路径残留');
}
