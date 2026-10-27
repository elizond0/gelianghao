/**
 * 哥俩好 · 游戏会话（两端共用）
 *
 * 把 web/app.js 里「跟玩法有关但与界面无关」的部分抽出来：
 * 主循环、输入、HUD 数据、事件音效、房主/客人同步。
 * UI 只负责把 hud() 返回的数据画到自己的组件上。
 */
(function (root) {
  'use strict';

  var Core = require('../core/core.js');
  var Renderer = require('../core/render.js');

  var CFG = Core.CFG;

  /**
   * @param {Object} opts
   *   opts.ctx         CanvasRenderingContext2D
   *   opts.canvasInfo  createCanvas 的返回值（含 raf/cancelRaf 就用它）
   *   opts.sfx         音效器（可为 null）
   *   opts.net         网络适配器（联机时传，单人不传）
   *   opts.mode        'solo' | 'host' | 'guest'
   *   opts.seed        number
   *   opts.ui          { onHud, onOver, onToast }
   */
  function Session(opts) {
    this.ctx = opts.ctx;
    this.canvasInfo = opts.canvasInfo || {};
    this.sfx = opts.sfx || null;
    this.net = opts.net || null;
    this.mode = opts.mode || 'solo';
    this.seed = opts.seed || Math.floor(Math.random() * 1e9);
    this.ui = opts.ui || {};

    this.renderer = new Renderer(this.ctx);
    this.game = new Core.Game(this.seed);
    // 所有事件（含 gameover）都走 onEvent；core 没有 onOver 回调，别挂
    this.game.onEvent = this._onEvent.bind(this);

    this.pressing = false;
    this.running = false;
    this.raf = null;
    this._lastT = 0;
    this._acc = 0;
    this._hudAcc = 0;
    this._pushAcc = 0;
    this._syncTimer = null;
    this._destroyed = false;
    this._opSeq = 0;
  }

  // ---------------- 生命周期 ----------------
  Session.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.game.start();

    var self = this;
    // 小程序用 canvas.requestAnimationFrame，网页用全局
    var raf = this.canvasInfo.raf
      ? function (cb) { return self.canvasInfo.raf(cb); }
      : function (cb) { return (root.requestAnimationFrame || setTimeout)(cb); };

    function loop(now) {
      if (self._destroyed || !self.running) return;
      var t = typeof now === 'number' ? now : Date.now();
      var dt = self._lastT ? Math.min((t - self._lastT) / 1000, 0.05) : 0.016;
      self._lastT = t;
      self._tick(dt);
      self.raf = raf(loop);
    }
    this.raf = raf(loop);

    // 联机：客人端定期拉房主快照
    if (this.mode === 'guest' && this.net) this._startGuestSync();
  };

  Session.prototype._tick = function (dt) {
    var g = this.game;

    if (this.mode === 'guest') {
      // 客人端：位置由快照驱动，本地只跑视觉
      g.tickVisual(dt);
    } else {
      g.update(dt);
      // 房主：定期把状态推给对方
      if (this.net && this.mode === 'host') {
        this._pushAcc += dt;
        if (this._pushAcc >= 0.12) {
          this._pushAcc = 0;
          this._pushHostState();
        }
      }
    }

    this.renderer.draw(g, dt);

    // HUD 每 100ms 同步一次，别每帧都写，省性能
    this._hudAcc += dt;
    if (this._hudAcc >= 0.1) {
      this._hudAcc = 0;
      if (this.ui.onHud) this.ui.onHud(this.hud());
    }
  };

  Session.prototype.stop = function () {
    this.running = false;
    this._stopGuestSync();
    if (this.raf && this.canvasInfo.cancelRaf) {
      try { this.canvasInfo.cancelRaf(this.raf); } catch (e) {}
    }
    this.raf = null;
  };

  Session.prototype.destroy = function () {
    this._destroyed = true;
    this.stop();
    // Game 内核没有 stop()，只有 reset() —— 直接调 stop 会抛 TypeError
    if (this.game && typeof this.game.reset === 'function') {
      try { this.game.reset(); } catch (e) {}
    }
    if (this.game) this.game.onEvent = null;
    if (this.net && this.net.onOp) {
      try { this.net.onOp(null); } catch (e) {}
    }
  };

  // ---------------- 输入 ----------------
  Session.prototype.pressStart = function () {
    if (this.mode === 'guest') return;      // 客人端不操作
    if (this.pressing) return;
    if (!this.canPress()) return;
    this.pressing = true;
    this.game.pressStart();
    this._sfx('charge');
    this._vibrate('light');
  };

  Session.prototype.pressEnd = function () {
    if (this.mode === 'guest') return;
    if (!this.pressing) return;
    this.pressing = false;
    this.game.pressEnd();
  };

  Session.prototype.pressCancel = function () {
    if (this.pressing) {
      this.pressing = false;
      this.game.pressEnd();
    }
  };

  Session.prototype.canPress = function () {
    var g = this.game;
    if (!g || g.over) return false;
    if (typeof g.canAct === 'function') return g.canAct();
    return true;
  };

  // ---------------- HUD 数据 ----------------
  Session.prototype.hud = function () {
    var g = this.game;
    var name = '你';
    if (this.mode !== 'solo') {
      var activeSeat = g.active;
      var mySeat = this.mode === 'host' ? 1 : 0;
      name = activeSeat === mySeat ? '你' : '好友';
    }
    return {
      dist: Math.floor(g.distance || 0),
      score: Math.floor(g.score || 0),
      coins: g.coins || 0,
      rescue: g.rescues || 0,
      combo: g.combo || 0,
      falls: g.falls || 0,
      turnName: name,
      over: g.state === 'over'
    };
  };

  // ---------------- 事件 ----------------
  // core 全部经 onEvent(type, data) 抛出；gameover 在这里转成 ui.onOver
  Session.prototype._onEvent = function (type, d) {
    d = d || {};
    // gameover 的音效键叫 'over'，其余事件名与音效键一致
    this._sfx(type === 'gameover' ? 'over' : type);
    if (type === 'coin' || type === 'rescue' || type === 'hit' ||
        type === 'perfect' || type === 'gold' || type === 'checkpoint' ||
        type === 'spring') {
      this._vibrate('light');
    }
    if (type === 'gameover') {
      this._vibrate('heavy');
      this._onOver(d);
      return;
    }
    if (type === 'spring' && this.ui.onToast) {
      this.ui.onToast('弹！蘑菇送你一程', 1300);
    }
    if (type === 'checkpoint' && this.ui.onToast) {
      this.ui.onToast('到达存档点！掉下去也能从这儿接着来', 1500);
    }
    if (type === 'gold' && this.ui.onToast) {
      this.ui.onToast('金香蕉 +50！', 1200);
    }
  };

  Session.prototype._onOver = function (d) {
    this.stop();
    if (!this.ui.onOver) return;
    var rescues = (d && d.rescues) || 0;
    this.ui.onOver({
      title: d && d.title ? d.title : '双双落水',
      reason: d && d.reason ? d.reason : '',
      score: Math.floor((d && d.score) || 0),
      dist: Math.floor((d && d.distance) || 0),
      coins: (d && d.coins) || 0,
      rescue: rescues,
      falls: (d && d.falls) || 0,
      bestCombo: (d && d.bestCombo) || 0,
      time: (d && d.time) || 0,
      perfects: (d && d.perfects) || 0,
      golds: (d && d.golds) || 0
    });
  };

  // ---------------- 联机同步 ----------------
  Session.prototype._pushHostState = function () {
    if (!this.net || !this.game) return;
    if (typeof this.game.hasBegun === 'function' && !this.game.hasBegun()) return;
    this.net.pushState({
      live: true,
      seed: this.game.seed,
      s: 2,
      snap: this.game.snapshot()
    }, true).catch(function () {});
  };

  Session.prototype._startGuestSync = function () {
    var self = this;
    if (this._syncTimer) clearInterval(this._syncTimer);
    this._syncTimer = setInterval(function () {
      if (self._destroyed || self.mode !== 'guest' || !self.net) return;
      self.net.pullState().then(function (v) {
        if (!v || !v.state || !v.state.snap) return;
        self.game.applySnapshot(v.state.snap);
      }).catch(function () {
        // 同步失败就多等一轮，别停
      });
    }, 200);
  };

  Session.prototype._stopGuestSync = function () {
    if (this._syncTimer) { clearInterval(this._syncTimer); this._syncTimer = null; }
  };

  // ---------------- 工具 ----------------
  Session.prototype._sfx = function (name) {
    if (this.sfx) this.sfx.play(name);
  };

  Session.prototype._vibrate = function (type) {
    var env = require('../platform/env.js');
    env.vibrate(type);
  };

  // 单人成绩存档
  Session.prototype.saveBest = function () {
    var env = require('../platform/env.js');
    var best = env.getStorage('best', 0) || 0;
    if (this.game.score > best) {
      env.setStorage('best', Math.floor(this.game.score));
      return Math.floor(this.game.score);
    }
    return best;
  };

  module.exports = Session;
})(typeof globalThis !== 'undefined' ? globalThis : this);
