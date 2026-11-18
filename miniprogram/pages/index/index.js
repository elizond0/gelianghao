/**
 * 首页
 *
 * 职责：只画界面 + 把点击转成「创建/加入房间」的意图。
 * 房间状态机、开局判定、断线重连全在 shared/app/lobby.js 里，
 * 这里只管跳转到房间页，并把适配器交给全局（跨页面存活）。
 */
var RT = require('../../shared/app/runtime.js');
var Core = require('../../shared/core/core.js');
var env = require('../../shared/platform/env.js');
var routes = require('../../shared/platform/routes.js');

Page({
  data: {
    best: 0,
    version: (Core && Core.VERSION) || '',
    showHow: false,
    code: ''            // 从分享卡片带进来的房号，自动填到输入框
  },

  onLoad: function (q) {
    // 分享卡片 / 小程序码带进来的房号，例如 ?room=1234
    var invite = (q && q.room) || '';
    if (!RT.isValidCode(invite)) invite = RT.takeReveal();
    if (RT.isValidCode(invite)) this.setData({ code: invite });
  },

  onShow: function () {
    this.setData({ best: RT.getBest(), version: (Core && Core.VERSION) || '' });
    // 从房间页返回首页（点返回/被踢）时把残留连接清掉，避免下局串房间
    if (env.isMiniProgram && RT.getNet() && RT.getMode() === 'solo') RT.clearNet();
  },

  noop: function () {},

  // ---------------- 玩法说明 ----------------
  // 小程序里「玩法说明」是弹层而不是独立页面，路由层会调到这里（见 setOverlayHandler）
  onHow: function () { this.setData({ showHow: true }); },
  closeHow: function () { this.setData({ showHow: false }); },

  // ---------------- 单人 ----------------
  onSolo: function () {
    // 进游戏前先在手势里解锁音频，否则整局没声音且不报错
    RT.unlockAudio();
    RT.clearNet();
    RT.setMode('solo', '');
    wx.navigateTo({ url: routes.buildMpUrl('game', { mode: 'solo', seed: RT.newSeed() }) });
  },

  // ---------------- 建房 ----------------
  onCreate: function () {
    var self = this;
    RT.unlockAudio();
    RT.clearNet();                    // 已有房间先离开，避免串房间

    wx.showLoading({ title: '开房间…', mask: true });
    var net = RT.createNet({ name: '房主' });

    net.createRoom({ name: '房主' })
      .then(function (code) {
        wx.hideLoading();
        // 房主的房间座位号固定为 0（好友是 1）—— 别和游戏内猴子号混用
        RT.bindNet(net);
        RT.setMode('host', code, 0);
        self.gotoRoom(code, 'host');
      })
      .catch(function (e) {
        wx.hideLoading();
        wx.showModal({
          title: '开房失败',
          content: (e && e.message) || '检查一下网络，或云开发是否已部署 room 云函数',
          showCancel: false
        });
      });
  },

  // ---------------- 进房 ----------------
  onJoin: function () {
    if (!this.data.code) { this.promptCode(); return; }
    this.joinWith(this.data.code);
  },

  // 手输房号
  promptCode: function () {
    var self = this;

    // editable 需要基础库 2.17.1+，低版本给替代路径
    if (wx.canIUse && !wx.canIUse('showModal.object.editable')) {
      wx.showModal({
        title: '微信版本有点旧',
        content: '升级微信后可以直接输入房号；也可以让好友把房间分享给你，点卡片进入',
        showCancel: false
      });
      return;
    }

    wx.showModal({
      title: '输入房号',
      editable: true,
      placeholderText: '好友发你的 4 位数字',
      success: function (res) {
        if (!res.confirm) return;
        var code = String(res.content || '').trim();
        if (!RT.isValidCode(code)) {
          wx.showToast({ title: '房号是 4 位数字', icon: 'none' });
          return;
        }
        self.setData({ code: code });
        self.joinWith(code);
      }
    });
  },

  onCodeInput: function (e) {
    var v = String(e.detail.value || '').replace(/\D/g, '').slice(0, 4);
    this.setData({ code: v });
    return v;
  },

  joinWith: function (code) {
    RT.unlockAudio();
    RT.clearNet();

    wx.showLoading({ title: '进房间…', mask: true });
    var net = RT.createNet({ name: '好友' });

    net.joinRoom(code, { name: '好友' })
      .then(function (r) {
        wx.hideLoading();
        // 座位以服务端返回为准：有人先退了，座位可能要换
        RT.bindNet(net);
        RT.setMode('guest', r.roomCode || code, r.seat);
        wx.redirectTo({
          url: routes.buildMpUrl('room', { code: r.roomCode || code, mode: 'guest' })
        });
      })
      .catch(function (e) {
        wx.hideLoading();
        wx.showModal({
          title: '进不去',
          content: (e && e.message) || '房号对不对？让好友确认一下',
          showCancel: false
        });
      });
  },

  gotoRoom: function (code, mode) {
    wx.navigateTo({ url: routes.buildMpUrl('room', { code: code, mode: mode }) });
  },

  // ---------------- 分享 ----------------
  onShareAppMessage: function () {
    return {
      title: '哥俩好：一根绳上的两只猴，来跟我搭个伙',
      path: '/pages/index/index'
    };
  },

  onShareTimeline: function () {
    return { title: '哥俩好：一根绳上的两只猴' };
  }
});
