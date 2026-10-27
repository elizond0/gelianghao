/**
 * 哥俩好 · 路由层（按运行环境挑实现）
 *
 * 这是「一套代码两端跑」的调度中枢。业务代码只 require 这个文件，
 * 不直接 require 具体实现，这样新增一个平台只要在这里加一行。
 *
 * 分工：
 *   画布  Canvas  —— 网页拿 <canvas>，小程序走 SelectorQuery
 *   音效  Sfx     —— 网页 WebAudio，小程序 wx.createWebAudioContext（不支持则静音）
 *   网络  Net     —— 网页 WebSocket，小程序 wx.cloud
 *   存储  Storage —— env 里已统一
 */
(function (root) {
  'use strict';

  var env = require('./env.js');

  // ---------------- 按环境惰性加载实现 ----------------
  // 只 require 当前平台需要的那个，另一端的实现完全不加载
  // （小程序能少打包一半体积；网页也不会去拉 cloud.js）
  var CanvasAdapter = null;
  var SfxAdapter = null;
  var NetAdapter = null;
  var _loaded = false;

  function ensure() {
    if (_loaded) return;
    _loaded = true;
    if (env.isMiniProgram) {
      CanvasAdapter = require('./canvas.mp.js');
      SfxAdapter = require('./sfx.mp.js');
      NetAdapter = require('../net/cloud.js');
    } else if (env.isWeb) {
      CanvasAdapter = require('./canvas.web.js');
      SfxAdapter = require('./sfx.web.js');
      NetAdapter = require('../net/ws.js');
    }
  }

  /**
   * 创建画布
   * @param {Object} opts
   *   opts.page     小程序 Page 实例（必传，SelectorQuery 要用）
   *   opts.selector 画布选择器，默认 '#cv'
   *   opts.canvas   网页端可直接传 canvas 元素
   * @returns {Promise<{ctx, canvas, width, height, dpr}>}
   */
  function createCanvas(opts) {
    ensure();
    if (!CanvasAdapter) return Promise.reject(new Error('当前环境不支持画布'));
    return CanvasAdapter.init(opts || {});
  }

  /**
   * 创建音效器
   * @returns {Object} 至少含 play(name) / setEnabled(bool) / destroy()
   */
  function createSfx() {
    ensure();
    if (!SfxAdapter) return { play: function () {}, setEnabled: function () {}, destroy: function () {} };
    return new SfxAdapter();
  }

  /**
   * 创建网络适配器（两端契约一致，见 net/contract.js）
   * @param {Object} opts 网页端 {url}，小程序端 {fnName}
   */
  function createNet(opts) {
    ensure();
    if (!NetAdapter) throw new Error('当前环境不支持联机');
    // 网页端第一个参数是 url，小程序端是 opts 对象
    if (env.isWeb) return new NetAdapter(opts && opts.url ? opts.url : '', opts || {});
    return new NetAdapter(opts || {});
  }

  module.exports = {
    env: env,
    createCanvas: createCanvas,
    createSfx: createSfx,
    createNet: createNet,

    // 方便业务代码顺手取
    isMiniProgram: env.isMiniProgram,
    isWeb: env.isWeb
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
