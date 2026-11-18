#!/usr/bin/env node
/**
 * 把 shared/ 同步一份到 miniprogram/shared/
 *
 * 为什么需要这一步：
 *   微信开发者工具只认 project.config.json 里 miniprogramRoot 指定的目录，
 *   require 不能跨出这个目录。而网页端要能直接访问 /shared/*.js。
 *   所以 shared/ 是唯一真源，miniprogram/shared/ 是构建产物。
 *
 * 用法：
 *   node scripts/sync-shared.js          同步一次
 *   node scripts/sync-shared.js --watch  改一个文件同步一次
 *
 * 约定：只同步 .js，跳过 loader.js（那是网页专用，小程序用不到，白占体积）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'shared');
const DST = path.join(ROOT, 'miniprogram', 'shared');

// 小程序端用不到的文件（网页专用）
// 说明：网页实现也一起搬过去，因为 platform/index.js 里两端实现都是静态
//      require 的写法，少一个文件 Analyze 阶段就报 Module not found。
//      代价只有几 KB，换编译期零报警，划算。
const SKIP_FILES = new Set([
  'loader.js'             // 浏览器 fetch+Function 加载器，小程序有自己的 require
]);

function walk(dir, rel, out) {
  rel = rel || '';
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const r = rel ? rel + '/' + name : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, r, out);
    else if (name.endsWith('.js') && !SKIP_FILES.has(r)) out.push(r);
  }
  return out;
}

function copyOne(rel) {
  const from = path.join(SRC, rel);
  const to = path.join(DST, rel);
  const buf = fs.readFileSync(from);
  // 内容没变就不写，避免 watch 模式下的写入风暴
  if (fs.existsSync(to) && fs.readFileSync(to).equals(buf)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, buf);
  return true;
}

function cleanStale(keep) {
  const keepSet = new Set(keep);
  let removed = 0;
  (function walkDst(dir, rel) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const r = rel ? rel + '/' + name : name;
      if (fs.statSync(abs).isDirectory()) walkDst(abs, r);
      else if (name.endsWith('.js') && !keepSet.has(r)) {
        fs.unlinkSync(abs);
        removed++;
      }
    }
  })(DST, '');
  return removed;
}

function sync() {
  const files = walk(SRC);
  let changed = 0;
  for (const f of files) if (copyOne(f)) changed++;
  const removed = cleanStale(files);
  return { total: files.length, changed, removed };
}

function main() {
  const watch = process.argv.includes('--watch');
  const run = () => {
    try {
      const r = sync();
      const t = new Date().toTimeString().slice(0, 8);
      console.log(`[${t}] shared -> miniprogram/shared：${r.total} 个文件，更新 ${r.changed}，清理 ${r.removed}`);
    } catch (e) {
      console.error('[sync-shared] 同步失败：', e.message);
    }
  };

  run();
  if (!watch) return;

  console.log('[sync-shared] 监听中…（Ctrl+C 退出）');
  let timer = null;
  fs.watch(SRC, { recursive: true }, () => {
    // 编辑器保存经常连发几次事件，合并成一次
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 120);
  });
}

main();
