/**
 * 音效 · 共用合成逻辑
 *
 * 网页和小程序的 WebAudio 接口几乎一致（小程序基础库 2.19+ 支持
 * wx.createWebAudioContext，接口照抄 W3C 标准），所以合成代码只写一份，
 * 差异只在「怎么拿到 AudioContext」。
 *
 * 子类只需实现 _createAC()。
 */
(function (root) {
  'use strict';

  function SfxBase() {
    this.ctx = null;
    this.enabled = true;
    this._tried = false;
  }

  // 子类覆盖
  SfxBase.prototype._createAC = function () { return null; };

  SfxBase.prototype._ac = function () {
    if (!this.enabled) return null;
    if (this._tried) return this.ctx;
    this._tried = true;
    try { this.ctx = this._createAC(); } catch (e) { this.ctx = null; }
    if (this.ctx && this.ctx.state === 'suspended' && this.ctx.resume) {
      try { this.ctx.resume(); } catch (e) {}
    }
    return this.ctx;
  };

  SfxBase.prototype._tone = function (freq, dur, type, gain, delay, slideTo) {
    var ac = this._ac();
    if (!ac) return;
    try {
      var t0 = ac.currentTime + (delay || 0);
      var o = ac.createOscillator();
      var g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo && o.frequency.exponentialRampToValueAtTime) {
        o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      }
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain || 0.12, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(ac.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    } catch (e) {
      // 某些机型 WebAudio 有限制，静默降级，不影响玩法
    }
  };

  // 音色表：只写一份，两端共用
  SfxBase.prototype.play = function (name) {
    switch (name) {
      case 'charge': this._tone(220, 0.09, 'triangle', 0.05, 0, 320); break;
      case 'jump': this._tone(420, 0.16, 'triangle', 0.1, 0, 760); break;
      case 'land': this._tone(180, 0.1, 'sine', 0.08, 0, 110); break;
      case 'coin':
        this._tone(880, 0.09, 'square', 0.05);
        this._tone(1320, 0.12, 'square', 0.045, 0.07);
        break;
      case 'wet': this._tone(300, 0.28, 'sine', 0.1, 0, 90); break;
      case 'rescue':
        this._tone(523, 0.1, 'triangle', 0.09);
        this._tone(659, 0.1, 'triangle', 0.09, 0.09);
        this._tone(784, 0.18, 'triangle', 0.09, 0.18);
        break;
      case 'hit': this._tone(160, 0.18, 'sawtooth', 0.08, 0, 70); break;
      case 'switch': this._tone(600, 0.06, 'sine', 0.05); break;
      case 'perfect':
        this._tone(523, 0.08, 'triangle', 0.07);
        this._tone(784, 0.15, 'triangle', 0.07, 0.07);
        break;
      case 'gold':
        this._tone(1046, 0.07, 'sine', 0.05);
        this._tone(1568, 0.18, 'sine', 0.05, 0.06);
        break;
      case 'respawn':
        this._tone(660, 0.22, 'sine', 0.08, 0, 180);
        break;
      case 'checkpoint':
        this._tone(392, 0.1, 'triangle', 0.08);
        this._tone(523, 0.18, 'triangle', 0.08, 0.09);
        break;
      case 'over':
        this._tone(523, 0.16, 'triangle', 0.09);
        this._tone(392, 0.16, 'triangle', 0.09, 0.15);
        this._tone(294, 0.3, 'triangle', 0.09, 0.3);
        break;
      case 'ready':
        this._tone(660, 0.1, 'sine', 0.07);
        this._tone(880, 0.14, 'sine', 0.07, 0.1);
        break;
    }
  };

  /**
   * 解锁音频。必须在用户手势回调里调一次。
   * iOS / 微信都要求音频在用户手势里"激活"过，否则首次 play 会被静音丢掉。
   * 返回 Promise(true) 表示可用。
   */
  SfxBase.prototype.unlock = function () {
    var ac = this._ac();
    if (!ac) return Promise.resolve(false);
    // 有些实现首次解锁时给了个空的 buffer source 才真正启动
    try {
      if (ac.state === 'suspended' && ac.resume) ac.resume();
    } catch (e) {}
    return Promise.resolve(true);
  };

  SfxBase.prototype.resume = function () {
    var ac = this.ctx;
    if (ac && ac.state === 'suspended' && ac.resume) {
      try { ac.resume(); } catch (e) {}
    }
  };

  SfxBase.prototype.setEnabled = function (on) {
    this.enabled = !!on;
    if (!on && this.ctx && this.ctx.suspend) {
      try { this.ctx.suspend(); } catch (e) {}
    }
  };

  SfxBase.prototype.destroy = function () {
    if (this.ctx && this.ctx.close) {
      try { this.ctx.close(); } catch (e) {}
    }
    this.ctx = null;
  };

  if (typeof module === 'object' && module.exports) module.exports = SfxBase;
  root.GLHSfxBase = SfxBase;
})(typeof globalThis !== 'undefined' ? globalThis : this);
