/**
 * 画布适配 · 网页端
 *
 * 网页上 <canvas> 已经在 HTML 里，直接拿来用。
 * 关键是按 devicePixelRatio 放大 backing store，否则高分屏画面发虚。
 */
(function (root) {
  'use strict';

  function init(opts) {
    return new Promise(function (resolve, reject) {
      var el = opts.canvas;
      if (!el && opts.selector) el = document.querySelector(opts.selector);
      if (!el) el = document.getElementById('cv');
      if (!el) { reject(new Error('找不到 canvas 元素')); return; }

      var ctx = el.getContext('2d');
      var dpr = Math.min(window.devicePixelRatio || 1, 2);

      // 画布铺满可视区
      var w = window.innerWidth;
      var h = window.innerHeight;
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      el.style.width = w + 'px';
      el.style.height = h + 'px';

      // 用 CSS 尺寸作为逻辑坐标系，绘制代码就完全不用管 dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      resolve({
        ctx: ctx,
        canvas: el,
        width: w,
        height: h,
        dpr: dpr,
        // 网页端 resize 时重建一次
        resize: function () {
          var nw = window.innerWidth, nh = window.innerHeight;
          el.width = Math.round(nw * dpr);
          el.height = Math.round(nh * dpr);
          el.style.width = nw + 'px';
          el.style.height = nh + 'px';
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          return { width: nw, height: nh, dpr: dpr };
        }
      });
    });
  }

  module.exports = { init: init };
})(typeof globalThis !== 'undefined' ? globalThis : this);
