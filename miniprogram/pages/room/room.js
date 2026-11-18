/**
 * 房间页（大厅）
 *
 * 状态机全部交给 shared/app/lobby.js，本页只做三件事：
 *   1. 把 lobby 的状态画到界面上（renderSeats）
 *   2. 把点击转成 lobby 的方法调用（toggleReady）
 *   3. 开局时跳转到游戏页（router.go('game')）
 *
 * 这样网页端的房间逻辑和小程序端跑的是同一份代码，改一处两边都好。
 */
var RT = require('../../shared/app/runtime.js');
var env = require('../../shared/platform/env.js');
var Router = require('../../shared/platform/router.js');
var Lobby = require('../../shared/app/lobby.js');

Page({
  data: {
    code: '',
    isHost: false,
    netbar: '',          // 网络状态提示条
    netbarKind: '',      // warn | ok
    btnText: '我准备好了',
    btnDisabled: false,
    tip: '',
    // 座位按【房间座位号】排：0 = 房主，1 = 好友
    seats: [
      { name: '', taken: false, ready: false, online: false, me: false, status: '等好友进来…' },
      { name: '', taken: false, ready: false, online: false, me: false, status: '等好友进来…' }
    ]
  },

  onLoad: function (q) {
    this.mode = (q && q.mode) || RT.getMode() || 'host';
    var code = (q && q.code) || RT.getRoom() || '';
    this.leaving = false;
    this.beginPending = false;

    this.setData({ code: code, isHost: this.mode === 'host' });

    var net = RT.getNet();
    if (!net) {
      // 直接打开房间页（比如从开发者工具编译单页）：没有连接就没法继续
      wx.showModal({
        title: '房间已断开',
        content: '回首页重新开个房间吧',
        showCancel: false,
        success: function () { Router.replace('home'); }
      });
      return;
    }
    this.net = net;
    this.createLobby();
  },

  onUnload: function () {
    // 页面销毁必须停轮询，否则离开后还在后台打请求
    if (this.lobby) this.lobby.stopPoll();
    this.lobby = null;
  },

  onHide: function () {
    // 切后台/被弹层盖住时暂停轮询，省流量也省电
    if (this.lobby) this.lobby.stopPoll();
  },

  onShow: function () {
    // 只有从"别的页面回来"才恢复；已经开局跳走的不恢复
    if (this.lobby && !this.leaving && !this.beginPending && this.lobby.phase === 'lobby') {
      this.lobby.startPoll();
      this.lobby.pullNow();
    }
  },

  // ---------------- 建立状态机 ----------------
  createLobby: function () {
    var self = this;

    this.lobby = new Lobby({
      net: this.net,
      mode: this.mode,
      pollMs: 1000,
      ui: {
        renderSeats: function (snap) { self.renderSeats(snap); },
        onNetbar: function (msg, kind, ms) { self.setNetbar(msg, kind, ms); },
        onToast: function (msg, ms) { self.toast(msg, ms); },
        onBegin: function (seed) { self.gotoGame(seed); },
        onBail: function () { self.bail(); }
      }
    });

    // 首次进入立刻拉一次，别让用户干等 1 秒
    this.lobby.startPoll();
    this.lobby.pullNow();
  },

  // ---------------- 渲染 ----------------
  renderSeats: function (snap) {
    var v = snap.view || {};
    var myRoomSeat = snap.myRoomSeat;         // 房主 0 / 好友 1
    var other = 1 - myRoomSeat;

    // 云函数给 seats 数组，WS 给 players 数组，这里统一成两个座位
    var seats = this.normalizeSeats(v, myRoomSeat);

    // 自己那一格：状态取 lobby 的 readyMe（已和服务端对齐），不取可能过期的视图
    seats[myRoomSeat].ready = snap.readyMe;
    seats[myRoomSeat].status = snap.readyMe ? '已准备' : '未准备';

    var otherSeat = seats[other];
    if (!otherSeat.taken) {
      otherSeat.status = '等好友进来…';
    } else if (!snap.onlinePeer) {
      otherSeat.status = '掉线了，等他回来';
    } else {
      otherSeat.status = otherSeat.ready ? '已准备' : '还没准备';
    }

    // 按钮文案
    var btnText = snap.readyMe ? '已准备（点一下取消）' : '我准备好了';
    var tip = '';
    if (snap.readyMe) {
      if (snap.mode === 'host') {
        tip = otherSeat.taken
          ? (otherSeat.ready ? '准备开局…' : '等好友点准备')
          : '好友还没进来，把房号发给他';
      } else {
        tip = '等房主开局，双方都准备好后自动开始';
      }
    } else {
      tip = snap.mode === 'host' ? '双方都准备后自动开局' : '';
    }

    this.setData({
      seats: seats,
      btnText: btnText,
      tip: tip,
      btnDisabled: this.beginPending
    });
  },

  // 把两端不同的视图结构统一成 2 个座位
  normalizeSeats: function (v, myRoomSeat) {
    var out = [
      { name: '', taken: false, ready: false, online: false, me: false, isHost: true, status: '' },
      { name: '', taken: false, ready: false, online: false, me: false, isHost: false, status: '' }
    ];

    // 1) 云函数风格：seats: [{idx,name,me,taken,ready,online}]
    if (v.seats && v.seats.length) {
      for (var i = 0; i < 2; i++) {
        var s = v.seats[i];
        if (!s) continue;
        out[i] = {
          name: s.name || '',
          taken: !!s.taken,
          ready: !!s.ready,
          online: !!s.online,
          me: !!s.me,
          isHost: i === 0,        // 座位 0 恒为房主位（云函数建房时就把房主放在 0）
          status: ''
        };
      }
      return out;
    }

    // 2) WS 风格：players / ready:{0,1} / online:[bool,bool]
    var players = v.players || [];
    for (var j = 0; j < 2; j++) {
      var p = players[j];
      out[j].name = (p && p.name) || '';
      out[j].taken = !!p;
      out[j].ready = !!(this.net && this.net.isReady ? this.net.isReady(v, j) : (v.ready && v.ready[j]));
      out[j].online = !!(this.net && this.net.isOnline ? this.net.isOnline(v, j) : false);
      out[j].me = (j === myRoomSeat);
      out[j].isHost = (j === 0);
    }
    // 房主名字兜底（服务端可能没传 meta）
    if (!out[0].name && out[0].taken) out[0].name = '房主';
    if (!out[1].name && out[1].taken) out[1].name = '好友';
    return out;
  },

  setNetbar: function (msg, kind, ms) {
    var self = this;
    this.setData({ netbar: msg || '', netbarKind: kind || 'warn' });
    if (this._netbarTimer) clearTimeout(this._netbarTimer);
    if (!msg) return;
    // 'ok' 类提示 2 秒后自动消失；warn 一直留着直到网络恢复
    if (kind === 'ok') {
      this._netbarTimer = setTimeout(function () {
        self.setData({ netbar: '' });
      }, ms || 2000);
    }
  },

  toast: function (msg, ms) {
    wx.showToast({ title: String(msg), icon: 'none', duration: ms || 1800 });
  },

  // ---------------- 交互 ----------------
  onReady: function () {
    var self = this;
    if (!this.lobby || this.beginPending) return;
    RT.unlockAudio();

    this.setData({ btnDisabled: true });
    this.lobby.toggleReady().then(function (ready) {
      self.setData({ btnDisabled: false });
      // 房主刚点了准备：立刻回读一次，双方都好了就开局
      if (ready && self.lobby.mode === 'host') self.lobby.pullNow();
    }).catch(function () {
      self.setData({ btnDisabled: false });
    });
  },

  onCopy: function () {
    var code = this.data.code;
    wx.setClipboardData({
      data: code,
      success: function () { wx.showToast({ title: '房号已复制', icon: 'none' }); }
    });
  },

  onBack: function () {
    var self = this;
    wx.showModal({
      title: '离开房间？',
      content: this.data.isHost
        ? '你是房主，走了房间就散了，好友也会被请出去'
        : '退出后要重新输房号才能回来',
      confirmText: '离开',
      success: function (res) {
        if (!res.confirm) {
          // 取消离开：把刚才暂停的轮询恢复回来
          if (self.lobby && self.lobby.phase === 'lobby') self.lobby.startPoll();
          return;
        }
        self.leaving = true;
        if (self.lobby) self.lobby.leave();
        RT.clearNet();
        Router.back('home');
      }
    });
  },

  // ---------------- 跳转游戏 ----------------
  gotoGame: function (seed) {
    if (this.beginPending) return;
    this.beginPending = true;
    if (this.lobby) this.lobby.stopPoll();
    RT.unlockAudio();

    // 联机模式：mode 决定了我控哪只猴子（房主控前排、好友控后排）
    var mode = this.lobby && this.lobby.mode ? this.lobby.mode : this.mode;
    Router.go('game', { mode: mode, seed: seed || RT.newSeed() });
  },

  // 房间彻底没了（服务重启等），给条活路
  bail: function () {
    this.leaving = true;
    RT.clearNet();
    Router.replace('home');
  },

  // ---------------- 分享 ----------------
  // 分享卡片直接带房号，好友点进来首页会自动填好房号。
  // 注意：房间号必须给好友，所以这里用 path 带参数，不用 query。
  onShareAppMessage: function () {
    var code = this.data.code;
    return {
      title: '来跟我玩哥俩好，房号 ' + code,
      path: '/pages/index/index?room=' + code
    };
  }
});
