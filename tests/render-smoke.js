/**
 * 渲染层冒烟测试：mock Canvas 2D ctx，真实跑 draw() 若干帧。
 * 目的：core 测试不跑渲染，r16b 曾因渲染层变量缺失在线上每帧报错——
 * 这份测试保证渲染代码路径至少能无异常跑通。
 * 跑法：node tests/render-smoke.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const Core = require(path.join(ROOT, 'shared/core/core.js'));
const Renderer = require(path.join(ROOT, 'shared/core/render.js'));   // module.exports = Renderer

let pass = 0, fail = 0;
function chk(label, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  ' + extra : '')); }
}

// 找 Renderer 导出
let R = null;
try { R = require(path.join(ROOT, 'shared/core/render.js')); } catch (e) {}

// mock ctx：所有方法空实现、属性可写、返回值足够用
function mockCtx() {
  const handler = {
    get(t, k) {
      if (k in t) return t[k];
      return function () { return mockCtx(); };
    },
    set(t, k, v) { t[k] = v; return true; }
  };
  const base = {
    canvas: { width: 375, height: 667 },
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: [] })
  };
  return new Proxy(base, handler);
}

(function main() {
  if (!R) { console.log('  FAIL 导出 Renderer 失败'); process.exit(1); }
  const g = new Core.Game({ seed: 99 });
  g.start();
  const r = new R(mockCtx());
  let threw = null;
  try {
    for (let i = 0; i < 120; i++) {
      g.update(1 / 60);
      r.draw(g, 1 / 60, null);
      if (i === 30) { g.pressStart(); }        // 起飞
      if (i === 90) { g.pressEnd(); }
      if (i === 60) g._respawnAt({ x: g.monkeys[0].x });  // 传送（绳重排路径）
    }
  } catch (e) { threw = e; }
  chk('渲染 120 帧无异常（含起跳/传送/绳重排）', !threw, threw && threw.stack);
  chk('Verlet 绳节点已建且数量正确', Array.isArray(r._ropePts) && r._ropePts.length === 9,
    r._ropePts && r._ropePts.length);
  chk('绳节点坐标无 NaN', r._ropePts.every(p => isFinite(p.x) && isFinite(p.y)));

  // ---- r21：两猴离远时的自动缩放分支（zoom<1 路径真跑 draw）----
  {
    g._genUntil(g.camX + 4000);
    const A = g.monkeys[0], B = g.monkeys[1];
    A.grounded = true; A.wetT = 0; A.stunT = 0; A.charging = false;
    B.grounded = true; B.wetT = 0; B.stunT = 0; B.charging = false;
    A.x = A.x; B.x = A.x + 700;   // 水平拉开 700px > 屏宽 375 -> 应触发缩放
    threw = null;
    try {
      for (let i = 0; i < 30; i++) { g.update(1 / 60); r.draw(g, 1 / 60, null); }
    } catch (e) { threw = e; }
    chk('缩放分支 30 帧无异常', !threw, threw && threw.stack);
    chk('缩放已生效（_zoom < 1）', r._zoom !== undefined && r._zoom < 0.99, r._zoom && r._zoom.toFixed(3));
    chk('缩放视野坐标有限', isFinite(r._viewL) && isFinite(r._viewR) && r._viewR > r._viewL,
      { viewL: r._viewL && r._viewL.toFixed(0), viewR: r._viewR && r._viewR.toFixed(0) });
    // r23 回归：缩小时世界空间必须铺满整屏背景，否则天地错位、露出深色空带
    chk('缩放时世界背景铺满可视野', r._backdropCalls > 0, r._backdropCalls);
    chk('世界背景填充区域覆盖整个视野', r._backdropRect &&
      r._backdropRect.w >= (r._viewR - r._viewL) - 1 && r._backdropRect.h > 0,
      r._backdropRect);
  }
  console.log('\nrender-smoke: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fail > 0) process.exit(1);
})();
