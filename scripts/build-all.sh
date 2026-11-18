#!/bin/bash
# 哥俩好一键构建+全量测试管线（sync → bundle → static → mp/lobby/render-smoke 测试 → standalone）
# 用法：bash scripts/build-all.sh
set -e
# 目录自推导：任何 checkout 路径都能跑（r27：原来硬编码 /workspace/gelianghao，
# 在别的目录执行会静默去构建另一份代码，是"复现不了"的头号原因）
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "cwd=$(pwd)"
npm run sync 2>&1 | tail -1
node scripts/build-web-bundle.js 2>&1 | tail -1
node scripts/build-static.js 2>&1 | tail -2
npm run test:mp 2>&1 | tail -1
node tests/lobby-state.js 2>&1 | tail -1
node tests/render-smoke.js 2>&1 | tail -1
node -e "
const fs=require('fs');
const D=process.cwd()+'/dist';
let h=fs.readFileSync(D+'/index.html','utf8');
const css=fs.readFileSync(D+'/style.css','utf8');
const bundle=fs.readFileSync(D+'/app.bundle.js','utf8');
h=h.replace('<link rel=\"stylesheet\" href=\"style.css\" />','<style>\n'+css+'\n</style>');
h=h.replace('<script src=\"app.bundle.js\"></script>','<script>\n'+bundle+'\n</script>');
fs.writeFileSync(D+'/gelianghao-standalone.html',h);
console.log('standalone KB:', Math.round(fs.statSync(D+'/gelianghao-standalone.html').size/1024));
"
