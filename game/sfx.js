/**
 * 哥俩好 · 音效（WebAudio 现场合成，无需任何音频素材）
 */
(function (root) {
  'use strict';
  function Sfx() {
    this.ctx = null;
    this.enabled = true;
  }

  Sfx.prototype._ac = function () {
    if (!this.enabled) return null;
    if (!this.ctx) {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      try { this.ctx = new AC(); } catch (e) { return null; }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  };

  Sfx.prototype._tone = function (freq, dur, type, gain, delay, slideTo) {
    var ac = this._ac();
    if (!ac) return;
    var t0 = ac.currentTime + (delay || 0);
    var o = ac.createOscillator();
    var g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain || 0.12, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  };

  Sfx.prototype.play = function (name) {
    switch (name) {
      case 'charge':
        this._tone(220, 0.09, 'triangle', 0.05, 0, 320);
        break;
      case 'jump':
        this._tone(420, 0.16, 'triangle', 0.1, 0, 760);
        break;
      case 'land':
        this._tone(180, 0.1, 'sine', 0.08, 0, 110);
        break;
      case 'coin':
        this._tone(880, 0.09, 'square', 0.05);
        this._tone(1320, 0.12, 'square', 0.045, 0.07);
        break;
      case 'wet':
        this._tone(300, 0.28, 'sine', 0.1, 0, 90);
        break;
      case 'rescue':
        this._tone(523, 0.1, 'triangle', 0.09);
        this._tone(659, 0.1, 'triangle', 0.09, 0.09);
        this._tone(784, 0.18, 'triangle', 0.09, 0.18);
        break;
      case 'hit':
        this._tone(160, 0.18, 'sawtooth', 0.08, 0, 70);
        break;
      case 'switch':
        this._tone(600, 0.06, 'sine', 0.05);
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

  root.GLHSfx = Sfx;
  if (typeof module === 'object' && module.exports) module.exports = Sfx;
})(typeof globalThis !== 'undefined' ? globalThis : this);
