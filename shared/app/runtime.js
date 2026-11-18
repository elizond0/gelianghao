/**
 * 哥俩好 · 小程序端全局会话（跨页面存活的运行时状态）
 *
 * 小程序切页面时 Page 实例会被销毁，但 App 存活，所以这几样东西必须挂在 App 上：
 *   net   网络适配器（房间连接，切页面不能断）
 *   mode  solo | host | guest
 *   room  房间号
 *   sfx   音效器（AudioContext 重建成本高，且 iOS 要求在手势里解锁过一次）
 *   best  单人最高分
 *
 * ⚠️ 这里只做「状态仓」，不写业务逻辑 —— 大厅逻辑在 shared/app/lobby.js，
 *    游戏循环在 shared/app/session.js，网页端用的是同一份。
 */
(function (root) {
  'use strict';

  var env = require('../platform/env.js');
  var P = require('../platform/index.js');

  var STORE = {
    net: null,
    mode: 'solo',
    room: '',
    seat: 0,          // 房间座位号（房主 0 / 好友 1）
    reveal: '',       // 进房后自动填到输入框的 4 位房号
    _sfx: null,
    _best: -1,
    _unlocked: false
  };

  // ---------------- 网络 ----------------
  function getNet() { return STORE.net; }

  function bindNet(net) {
    STORE.net = net;
    return net;
  }

  function clearNet() {
    var n = STORE.net;
    STORE.net = null;
    STORE.mode = 'solo';
    STORE.room = '';
    STORE.seat = 0;
    if (n && n.leave) {
      try { n.leave(); } catch (e) {}
    }
  }

  function setMode(mode, room, seat) {
    STORE.mode = mode || 'solo';
    if (room !== undefined) STORE.room = room || '';
    if (seat !== undefined) STORE.seat = seat || 0;
  }

  function getMode() { return STORE.mode; }
  function getRoom() { return STORE.room; }

  /**
   * 新建一个适配器（网页走 WS、小程序走云函数，由 platform/index.js 决定）
   * 小程序端没有"连接"概念，createNet 不会失败；出错是后续请求的事。
   */
  function createNet(opts) {
    return P.createNet(opts || {});
  }

  // ---------------- 音效 ----------------
  // 全局只留一个实例：iOS 上重复 new AudioContext 会被静音
  function getSfx() {
    if (!STORE._sfx) STORE._sfx = P.createSfx();
    return STORE._sfx;
  }

  /**
   * 在用户手势回调里调一次，解锁音频。
   * 小程序端首次播放必须在 tap 事件里，否则整局都没声音（不报错，很隐蔽）。
   */
  function unlockAudio() {
    if (STORE._unlocked) {
      // 已经解锁过也要 resume 一下：切后台回来音频上下文会被挂起
      var s = STORE._sfx;
      if (s && s.resume) s.resume();
      return Promise.resolve(true);
    }
    var sfx = getSfx();
    var p = sfx.unlock ? sfx.unlock() : Promise.resolve(true);
    return Promise.resolve(p).then(function (ok) {
      STORE._unlocked = true;
      return ok;
    }).catch(function () { return false; });
  }

  // ---------------- 最高分 ----------------
  function getBest() {
    if (STORE._best < 0) STORE._best = Number(env.getStorage('best', 0)) || 0;
    return STORE._best;
  }

  function saveBest(score) {
    score = Math.floor(score || 0);
    if (score > getBest()) {
      STORE._best = score;
      env.setStorage('best', score);
    }
    return STORE._best;
  }

  // ---------------- 调试出口 ----------------
  // 小程序开发者工具控制台里打 __glh.state() 可以直接看运行时状态
  function dump() {
    return {
      kind: env.kind,
      mode: STORE.mode,
      room: STORE.room,
      seat: STORE.seat,
      hasNet: !!STORE.net,
      netRoom: STORE.net ? STORE.net.roomCode : null,
      best: getBest()
    };
  }

  module.exports = {
    createNet: createNet,
    getNet: getNet,
    bindNet: bindNet,
    clearNet: clearNet,
    setMode: setMode,
    getMode: getMode,
    getRoom: getRoom,
    getSfx: getSfx,
    unlockAudio: unlockAudio,
    getBest: getBest,
    saveBest: saveBest,
    dump: dump,

    // 进房后给首页输入框预填房号（从分享卡片点进来时用）
    setReveal: function (code) { STORE.reveal = code || ''; },
    takeReveal: function () { var c = STORE.reveal; STORE.reveal = ''; return c; },

    // 两个 4 位随机数，做房号/种子都够用
    newSeed: function () { return Math.floor(Math.random() * 1e9); },
    isValidCode: function (c) { return /^\d{4}$/.test(String(c || '')); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
