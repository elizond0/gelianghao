/**
 * 画布适配 · 小程序端
 *
 * 小程序和网页最大的区别：canvas 不是 DOM 元素，必须用 SelectorQuery 拿到 node。
 * 注意：
 *   1. 必须用 type="2d"（基础库 2.9.0+），老的 wx.createCanvasContext 性能差且接口不同
 *   2. 动画要用 canvas.requestAnimationFrame，不能用全局 raf
 *   3. 尺寸同样按 pixelRatio 放大
 */
(function (root) {
  'use strict';

  function init(opts) {
    return new Promise(function (resolve, reject) {
      var page = opts.page;
      if (!page) { reject(new Error('小程序端创建画布必须传 page 实例')); return; }

      var selector = opts.selector || '#cv';

      wx.createSelectorQuery()
        .in(page)
        .select(selector)
        .fields({ node: true, size: true })
        .exec(function (res) {
          var r = res && res[0];
          if (!r || !r.node) {
            reject(new Error('找不到 canvas 节点：' + selector + '（检查 wxml 里是否写了 type="2d"）'));
            return;
          }

          var canvas = r.node;
          var ctx = canvas.getContext('2d');
          var dpr = Math.min((wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2, 3);

          // fields 拿到的 size 是 CSS 尺寸
          var w = r.width;
          var h = r.height;

          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
          ctx.scale(dpr, dpr);

          resolve({
            ctx: ctx,
            canvas: canvas,
            width: w,
            height: h,
            dpr: dpr,

            // 小程序端动画帧走 canvas 自己的 raf
            raf: function (cb) { return canvas.requestAnimationFrame(cb); },
            cancelRaf: function (id) { canvas.cancelAnimationFrame(id); },

            // 转成临时图片（分享/截图用，暂未用到）
            toTempFile: function () {
              return new Promise(function (res2) {
                wx.canvasToTempFilePath({ canvas: canvas, success: res2, fail: res2 });
              });
            }
          });
        });
    });
  }

  module.exports = { init: init };
})(typeof globalThis !== 'undefined' ? globalThis : this);
