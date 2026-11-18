/**
 * 网络适配器 · 小程序端（微信云开发）
 *
 * ⚠️ 这个文件严格对齐 cloudfunctions/room/index.js 的实际约定：
 *    - 请求参数用 code（不是 roomCode）
 *    - 返回 { ok, msg, roomCode, seat, view, state, ops }
 *    - 座位是 seats[] 数组：[{idx, name, me, taken, ready, online}]
 *
 * 同时对外暴露 net/contract.js 要求的统一接口，内部做一次归一化，
 * 这样业务层（shared/app/lobby.js）两端代码完全一致。
 */
(function (root) {
  'use strict';

  var Base = require('./contract.js');

  function CloudAdapter(opts) {
    Base.call(this);
    this.opts = opts || {};
    this.fnName = this.opts.fnName || 'room';
    this.myName = this.opts.name || '房主';
    this._fails = 0;
  }
  CloudAdapter.prototype = Object.create(Base.prototype);
  CloudAdapter.prototype.constructor = CloudAdapter;

  // ---------------- 云函数调用 ----------------
  CloudAdapter.prototype._call = function (action, data) {
    var self = this;
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      return Promise.reject(new Error('云开发未初始化，请检查 app.js 里的 wx.cloud.init'));
    }
    return new Promise(function (resolve, reject) {
      wx.cloud.callFunction({
        name: self.fnName,
        data: Object.assign({ action: action }, data || {}),
        success: function (res) {
          var r = res.result || {};
          if (r.ok === false) {
            self.lastError = r.msg || '服务异常';
            reject(new Error(self.lastError));
            return;
          }
          self.lastError = '';
          resolve(r);
        },
        fail: function (err) {
          var msg = (err && err.errMsg) || '云函数调用失败';
          if (msg.indexOf('timeout') >= 0 || msg.indexOf('TIME_LIMIT') >= 0) msg = '网络超时，请检查网络';
          else if (msg.indexOf('env') >= 0) msg = '云开发环境未配置';
          else if (msg.indexOf('FunctionName') >= 0) msg = '云函数 room 未部署';
          self.lastError = msg;
          reject(new Error(msg));
        }
      });
    });
  };

  // ---------------- 视图归一化 ----------------
  // 把云函数的 view（seats 数组）转成 contract 约定的 {ready:{0,1}, online:{0,1}}
  CloudAdapter.prototype._norm = function (r) {
    if (!r) return null;
    var v = r.view || {};
    var seats = v.seats || [];
    var ready = { 0: false, 1: false };
    var online = { 0: false, 1: false };
    var players = [{ name: '', avatar: '', score: 0 }, { name: '', avatar: '', score: 0 }];

    for (var i = 0; i < 2; i++) {
      var s = seats[i];
      if (!s) continue;
      ready[i] = !!s.ready;
      online[i] = !!s.online;
      players[i] = { name: s.name || '', avatar: '', score: 0, taken: !!s.taken, me: !!s.me };
    }

    return {
      roomCode: v.code || this.roomCode,
      players: players,
      ready: ready,
      online: online,
      isHost: !!v.isHost,
      // 对局状态：云函数顶层给 state，view 里给 live/seed，这里合并
      state: r.state
        ? { live: !!r.state.live, seed: r.state.seed, snap: r.state.snap }
        : { live: !!v.live, seed: v.seed, snap: null },
      ops: r.ops || []
    };
  };

  // ---------------- 连接 ----------------
  // 云开发没有长连接，"连接"=云函数可用
  CloudAdapter.prototype.connect = function () { return Promise.resolve(); };
  CloudAdapter.prototype.isOpen = function () {
    return typeof wx !== 'undefined' && !!wx.cloud && !!wx.cloud.callFunction;
  };

  // ---------------- 房间 ----------------
  CloudAdapter.prototype.createRoom = function (meta) {
    var self = this;
    var name = (meta && meta.name) || this.myName;
    return this._call('create', { name: name }).then(function (r) {
      self.roomCode = r.roomCode;
      self.seat = typeof r.seat === 'number' ? r.seat : 0;
      self._status('online');
      return r.roomCode;
    });
  };

  CloudAdapter.prototype.joinRoom = function (code, meta) {
    var self = this;
    var name = (meta && meta.name) || '好友';
    this.myName = name;
    return this._call('join', { code: String(code), name: name }).then(function (r) {
      self.roomCode = r.roomCode || code;
      self.seat = typeof r.seat === 'number' ? r.seat : 1;
      self._status('online');
      return { roomCode: self.roomCode, seat: self.seat, view: self._norm(r) };
    });
  };

  CloudAdapter.prototype.setReady = function (ready) {
    return this._call('ready', { code: this.roomCode, ready: !!ready }).then(function () {
      return true;
    });
  };

  CloudAdapter.prototype.start = function (seed) {
    return this._call('start', { code: this.roomCode, seed: seed }).then(function () { return true; });
  };

  CloudAdapter.prototype.pushState = function (snap, ready) {
    // 云函数 state 接口收的是 {live, seed, snap}
    var live = !!(snap && snap.live !== false);
    return this._call('state', {
      code: this.roomCode,
      live: live,
      seed: snap && snap.seed,
      snap: snap && snap.snap
    }).catch(function () {});
  };

  // 拉快照 + 消费房主的 ops
  CloudAdapter.prototype.pullState = function () {
    var self = this;
    return this._call('pull', { code: this.roomCode }).then(function (r) {
      self._fails = 0;
      var v = self._norm(r);
      // 只有房主会收到 ops，取到就派发
      if (v.ops && v.ops.length) {
        v.ops.forEach(function (op) { self._emitOp(op); });
      }
      return v;
    }).catch(function (e) {
      self._fails++;
      if (self._fails === 3) self._status('offline');
      throw e;
    });
  };

  CloudAdapter.prototype.sendOp = function (op) {
    return this._call('op', { code: this.roomCode, op: op }).catch(function () {});
  };

  // ---------------- 断线重连 ----------------
  // 云开发没有连接可重连，等价于「重新 join 一次把状态接回来」
  CloudAdapter.prototype.reconnect = function () {
    var self = this;
    if (!this.roomCode) return Promise.resolve(false);
    return this._call('join', { code: this.roomCode, name: this.myName })
      .then(function (r) {
        self.seat = typeof r.seat === 'number' ? r.seat : self.seat;
        self._fails = 0;
        self._status('online');
        return true;
      })
      .catch(function (e) {
        self.lastError = (e && e.message) || '重连失败';
        return false;
      });
  };

  CloudAdapter.prototype.leave = function () {
    var self = this;
    var code = this.roomCode;
    this.roomCode = null;
    if (!code) return Promise.resolve();
    return this._call('leave', { code: code }).catch(function () {});
  };

  module.exports = CloudAdapter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
