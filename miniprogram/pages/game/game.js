/**
 * 游戏页
 *
 * 页面只负责：拿画布 → 起会话 → 把 hud 数据画到 WXML 上。
 * 主循环、输入、音效、联机同步全在 shared/app/session.js，
 * 画布创建走 shared/platform/index.js（小程序端自动选 canvas.mp.js）。
 *
 * ⚠️ 座位映射（踩过的坑，别改）：
 *   房间座位号 roomSeat：房主 0、好友 1
 *   游戏内猴子号 gameSeat：房主 1（前排）、好友 0（后排）
 *   Session 内部按 mode 自己算，页面别传 seat 进去。
 */
var RT = require('../../shared/app/runtime.js');
var env = require('../../shared/platform/env.js');
var Router = require('../../shared/platform/router.js');
var P = require('../../shared/platform/index.js');
var Session = require('../../shared/app/session.js');

Page({
  data: {
    netMode: false,
    dist: 0,
    score: 0,
    coins: 0,
    combo: 0,
    comboPop: false,
    falls: 0,
    turnName: '你',
    tip: '',

    toast: '',
    toastShow: false,

    overShow: false,
    overTitle: '',
    overReason: '',
    overScore: 0,
    overDist: 0,
    overCoin: 0,
    overRescue: 0,
    overPerfect: 0,
    overGold: 0,
    overCombo: 0,
    overFalls: 0,
    best: 0,

    canQuit: true
  },

  onLoad: function (q) {
    var self = this;

    this.mode = (q && q.mode) || 'solo';
    this.seed = Number(q && q.seed) || RT.newSeed();
    this.destroyed = false;
    this.session = null;
    this.opSeq = 0;

    this.setData({
      netMode: this.mode !== 'solo',
      best: RT.getBest()
    });

    // 进游戏前先解锁音频（小程序必须在手势里解锁，否则整局没声音）
    RT.unlockAudio();

    // 画布创建是异步的（小程序要等节点就绪）
    P.createCanvas({ page: this, selector: '#cv' })
      .then(function (info) {
        if (self.destroyed) return;
        self.canvasInfo = info;
        self.startSession();
      })
      .catch(function (e) {
        console.error('[game] 画布初始化失败', e);
        wx.showModal({
          title: '画面加载失败',
          content: (e && e.message) || '重进一次试试',
          showCancel: false,
          success: function () { Router.replace('home'); }
        });
      });
  },

  onUnload: function () {
    this.destroyed = true;
    if (this.session) {
      this.session.destroy();
      this.session = null;
    }
    if (this._toastTimer) { clearTimeout(this._toastTimer); this._toastTimer = null; }
    if (this._overTimer) { clearTimeout(this._overTimer); this._overTimer = null; }
    if (this._comboPopTimer) { clearTimeout(this._comboPopTimer); this._comboPopTimer = null; }
  },

  // 切后台：停循环省电；回来时接着跑
  onHide: function () {
    if (this.session) this.session.stop();
  },

  onShow: function () {
    if (this.session && !this.session.running && !this.destroyed) this.session.start();
  },

  // ---------------- 会话 ----------------
  startSession: function () {
    var self = this;
    var net = this.mode === 'solo' ? null : RT.getNet();

    if (this.mode !== 'solo' && !net) {
      wx.showModal({
        title: '连接已断开',
        content: '房间没了，回首页重新开一局吧',
        showCancel: false,
        success: function () { Router.replace('home'); }
      });
      return;
    }

    this.session = new Session({
      ctx: this.canvasInfo.ctx,
      canvasInfo: this.canvasInfo,
      sfx: RT.getSfx(),
      net: net,
      mode: this.mode,
      seed: this.seed,
      ui: {
        onHud: function (h) { self.applyHud(h); },
        onOver: function (d) { self.onOver(d); },
        onToast: function (msg, ms) { self.toast(msg, ms); }
      }
    });

    // 座位映射：房主控前排（猴子 1）、好友控后排（猴子 0）。
    // Session 的 hud() 内部按 mode 算，但 Game 本身也得知道"我控谁"，
    // 否则按键判定会控到对手那只。
    if (this.session.game && this.mode !== 'solo') {
      this.session.game.setNet(this.mode, this.mode === 'host' ? 1 : 0);
    }

    // 房主：接收好友发来的操作（云开发走 pull 里的 ops，WS 走推送）
    if (net && this.mode === 'host' && net.onOp) {
      net.onOp(function (op) {
        if (self.session && self.session.game) self.session.game.queueRemote(op);
      });
    }

    // 联机断线提示
    if (net && net.onStatus) {
      net.onStatus(function (s) {
        if (s === 'peer-left') self.toast('好友掉线了，先接着打', 2200);
        if (s === 'peer-join') self.toast('好友回来了', 1600);
      });
    }

    this.session.start();
    if (this.session.sfx) this.session.sfx.play('ready');
  },

  // ---------------- HUD ----------------
  applyHud: function (h) {
    // 只传变化的字段，别整包 setData（高频调用，整包会明显掉帧）
    var patch = {};
    var self = this;
    if (this.data.dist !== h.dist) patch.dist = h.dist;
    if (this.data.score !== h.score) patch.score = h.score;
    if (this.data.coins !== h.coins) patch.coins = h.coins;
    if (this.data.turnName !== h.turnName) patch.turnName = h.turnName;
    if (this.data.falls !== h.falls) patch.falls = h.falls;
    if (this.data.combo !== h.combo) {
      patch.combo = h.combo;
      // 连击数变化时弹一下（pop 动画 400ms 后摘掉，别常驻）
      patch.comboPop = true;
      if (this._comboPopTimer) clearTimeout(this._comboPopTimer);
      this._comboPopTimer = setTimeout(function () {
        if (!self.destroyed) self.setData({ comboPop: false });
      }, 400);
    }
    if (Object.keys(patch).length) this.setData(patch);
  },

  // ---------------- 输入 ----------------
  onTouchStart: function (e) {
    if (!this.session) return;
    RT.unlockAudio();       // 每次按下都补一次，防止切后台后音频被挂起
    this.session.pressStart();
    this.syncOp('down');
  },

  onTouchEnd: function () {
    if (!this.session) return;
    this.session.pressEnd();
    this.syncOp('up');
  },

  onTouchCancel: function () {
    if (!this.session) return;
    this.session.pressCancel();
  },

  // 联机时把操作发给房主（只有客人端需要发）
  syncOp: function (t) {
    if (this.mode !== 'guest') return;
    var net = RT.getNet();
    var s = this.session;
    if (!net || !s || !s.game) return;

    var op = { t: t, m: s.game.seat, seq: ++this.opSeq };
    // 松手时把蓄力比例带上，房主端算出来的跳距才跟客人端看到的一致
    if (t === 'up' && s.game.lastOpOut && typeof s.game.lastOpOut.p === 'number') {
      op.p = s.game.lastOpOut.p;
    }
    net.sendOp(op);
  },

  // ---------------- 结算 ----------------
  onOver: function (d) {
    function fmtTime(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
    }
    var self = this;
    var best = RT.saveBest(d.score);

    // 房主告诉服务端"这局结束了"，好友端靠 live=false 同步结算
    if (this.mode === 'host') {
      var net = RT.getNet();
      if (net && net.pushState) net.pushState({ live: false, seed: this.seed, snap: null });
    }

    if (this._overTimer) clearTimeout(this._overTimer);
    this._overTimer = setTimeout(function () {
      if (self.destroyed) return;
      var reason = d.reason;
      if (!reason) {
        reason = d.rescue >= 3
          ? '你俩互相拉上来 ' + d.rescue + ' 次，最后还是没扛住'
          : '两只猴子一起掉进了水里';
      } else if (reason === 'stuck') {
        reason = '同一面旗子连掉 ' + (d.falls || 3) + ' 次，这关先饶过你们';
      } else if (reason === 'falls-limit') {
        reason = '第 ' + (d.level || 1) + ' 关连掉 ' + ((d.fallsSinceCP || 0) + 1) + ' 次都没起来，本局结束';
      }
      self.setData({
        overShow: true,
        overTitle: d.rescue >= 3 ? '好默契！' : '双双落水',
        overReason: reason,
        overScore: d.score,
        overDist: d.dist,
        overCoin: d.coins,
        overRescue: d.rescue,
        overPerfect: d.perfects || 0,
        overGold: d.golds || 0,
        overCombo: d.bestCombo || 0,
        overFalls: d.falls || 0,
        overTime: fmtTime(d.time || 0),
        best: best
      });
    }, 600);
  },

  // ---------------- 提示 ----------------
  toast: function (msg, ms) {
    // r15 实机反馈：同文案 3s 内不重复弹（回检查点循环会连触发）
    var now = Date.now();
    if (msg === this._lastToastMsg && now - (this._lastToastAt || 0) < 3000) return;
    this._lastToastMsg = msg; this._lastToastAt = now;
    var self = this;
    this.setData({ toast: msg, toastShow: true });
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function () {
      if (!self.destroyed) self.setData({ toastShow: false });
    }, ms || 1700);
  },

  // ---------------- 按钮 ----------------
  onAgain: function () {
    if (this.mode === 'solo') {
      // 单人：原地重开，不换页面（重开比 reLaunch 快得多）
      this.setData({ overShow: false });
      if (this.session) {
        this.session.destroy();
        this.session = null;
      }
      this.seed = RT.newSeed();
      this.startSession();
      return;
    }
    // 联机：回房间重新准备
    Router.go('room', { code: RT.getRoom(), mode: this.mode });
  },

  onHome: function () {
    this.quitToHome(true);
  },

  onQuit: function () {
    this.quitToHome(false);
  },

  quitToHome: function (silent) {
    var self = this;
    var net = this.mode === 'solo' ? null : RT.getNet();
    var done = function () {
      RT.clearNet();
      Router.replace('home');
    };

    if (!net) { done(); return; }

    // 房主退出要把 live 置回 false，否则好友端会一直等一个已经不存在的对局
    var p = this.mode === 'host' && net.pushState
      ? net.pushState({ live: false, seed: 0, snap: null })
      : Promise.resolve();

    Promise.resolve(p).catch(function () {}).then(function () {
      if (silent) return done();
      wx.showModal({
        title: '退出这一局？',
        content: self.mode === 'host' ? '你是房主，退出后好友也会被带回首页' : '退出后会回到首页',
        confirmText: '退出',
        success: function (res) {
          if (res.confirm) done();
        }
      });
    });
  },

  noop: function () {}
});
