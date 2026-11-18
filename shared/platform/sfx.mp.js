/**
 * 音效 · 小程序端
 * 基础库 2.19.0+ 提供 wx.createWebAudioContext，接口与 W3C WebAudio 一致。
 * 低版本或部分机型不支持时静音降级 —— 玩法完全不受影响。
 */
(function (root) {
  'use strict';

  var Base = require('./sfx-base.js');

  function Sfx() {
    Base.call(this);
  }
  Sfx.prototype = Object.create(Base.prototype);
  Sfx.prototype.constructor = Sfx;

  Sfx.prototype._createAC = function () {
    if (typeof wx === 'undefined') return null;
    if (!wx.createWebAudioContext) return null;   // 基础库过低，静音
    return wx.createWebAudioContext();
  };

  module.exports = Sfx;
})(typeof globalThis !== 'undefined' ? globalThis : this);
