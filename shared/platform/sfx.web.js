/**
 * 音效 · 网页端
 * 用浏览器原生 AudioContext。
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
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    return new AC();
  };

  module.exports = Sfx;
})(typeof globalThis !== 'undefined' ? globalThis : this);
