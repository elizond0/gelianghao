/**
 * 哥俩好 · 大厅逻辑（两端共用）
 *
 * 从 web/app.js 里抽出来的平台无关部分：房间状态机、准备切换、
 * 开局判定、断线重连、轮询。UI 只负责把这里的状态画出来。
 *
 * 用法：
 *   var Lobby = require('../shared/app/lobby.js');
 *   var lobby = new Lobby({ net: adapter, ui: {...}, onBegin });
 */
(function (root) {
  'use strict';

  var env = require('../platform/env.js');

  /**
   * @param {Object} opts
   *   opts.net       网络适配器（满足 net/contract.js）
   *   opts.mode      'host' | 'guest' | 'solo'
   *   opts.ui        UI 回调：{ renderSeats, onStatus, onNetbar, onToast, onBegin, onBail }
   *   opts.pollMs    轮询间隔，默认 1000
   */
  function Lobby(opts) {
    this.net = opts.net;
    this.mode = opts.mode || 'solo';
    this.ui = opts.ui || {};
    this.pollMs = opts.pollMs || 1000;

    this.phase = 'lobby';       // lobby | playing | home
    this.readyMe = false;
    this.readyPeer = false;
    this.onlinePeer = false;
    this.view = null;

    this.started = false;
    this.bothReadyFired = false;

    this._timer = null;
    this._polling = false;
    this._fails = 0;

    this._bindNet();
  }

  // ---------------- 房间座位号（关键：别和游戏内猴子号混用） ----------------
  // 房间座位号：房主 0、好友 1  ← ready / online 数组用的就是它
  Lobby.prototype.myRoomSeat = function () {
    return this.mode === 'host' ? 0 : 1;
  };
  // 游戏内猴子号：房主 1（前排）、好友 0（后排）
  Lobby.prototype.myGameSeat = function () {
    return this.mode === 'host' ? 1 : 0;
  };
  Lobby.prototype.otherRoomSeat = function () {
    return 1 - this.myRoomSeat();
  };

  // ---------------- 状态解包 ----------------
  Lobby.prototype.applyView = function (v) {
    if (!v) return;
    this.view = v;
    var other = this.otherRoomSeat();
    // online 可能是数组（WS 服务端）也可能是对象（云函数归一化后），两种都吃
    this.onlinePeer = this.net && this.net.isOnline
      ? this.net.isOnline(v, other)
      : !!(v.online && v.online[other]);
    this.readyPeer = this.net && this.net.isReady
      ? this.net.isReady(v, other)
      : !!(v.ready && v.ready[other]);

    if (this.ui.renderSeats) {
      this.ui.renderSeats(this._snapshot());
    }
  };

  // 给 UI 的统一数据包（renderSeats 的入参，也是页面 setData 的来源）
  Lobby.prototype._snapshot = function () {
    return {
      mode: this.mode,
      readyMe: this.readyMe,
      readyPeer: this.readyPeer,
      onlinePeer: this.onlinePeer,
      myRoomSeat: this.myRoomSeat(),
      view: this.view
    };
  };

  // 双方都 ready 才算能开局 —— 只看对方是常见错误，房主自己没准备也会被开了
  Lobby.prototype.bothReady = function (v) {
    v = v || this.view;
    if (!v || !v.ready) return false;
    return !!(v.ready[0] && v.ready[1]);
  };

  // 客人端进入判断：房主宣布 live 才算
  Lobby.prototype.isLive = function (v) {
    v = v || this.view;
    return !!(v && v.state && v.state.live);
  };

  // ---------------- 网络事件 ----------------
  Lobby.prototype._bindNet = function () {
    var self = this;
    if (!this.net || !this.net.onStatus) return;

    this.net.onStatus(function (s) {
      if (s === 'online') {
        if (self.ui.onNetbar) self.ui.onNetbar('', null);
      }
      if (s === 'offline') {
        if (self.ui.onNetbar) self.ui.onNetbar('连不上服务器，正在重试…', 'warn');
      }
      if (s === 'lost') {
        if (self.ui.onNetbar) self.ui.onNetbar('网络断了，正在重连…', 'warn');
        self.tryReconnect();
      }
      if (s === 'peer-left') {
        self.onlinePeer = false;
        if (self.ui.renderSeats) self.ui.renderSeats(self._snapshot());
        if (self.ui.onToast) {
          if (self.phase === 'lobby') self.ui.onToast('好友离开 / 掉线了，等他回来', 2200);
          else if (self.phase === 'playing') self.ui.onToast('好友掉线了，3 秒后自动接管他的猴子', 2600);
        }
      }
      if (s === 'peer-join') {
        self.onlinePeer = true;
        if (self.ui.onNetbar) self.ui.onNetbar('好友已连接', 'ok', 1600);
        if (self.ui.renderSeats) self.ui.renderSeats(self._snapshot());
      }
      if (self.ui.onStatus) self.ui.onStatus(s);
    });
  };

  // ---------------- 轮询 ----------------
  Lobby.prototype.startPoll = function () {
    var self = this;
    if (this._timer) clearInterval(this._timer);
    this._polling = false;
    this._fails = 0;

    this._timer = setInterval(function () {
      if (self.phase !== 'lobby') return;
      if (self._polling) return;       // 上一个还没回来，跳过，避免请求雪崩
      if (!self.net) return;

      self._polling = true;
      self.net.pullState().then(function (v) {
        self._polling = false;
        self._fails = 0;
        if (!v) return;

        // 我自己的 ready 以服务端为准。
        // toggleReady 只发了请求没回读，如果中间请求丢了/被覆盖，
        // 本地会显示"已准备"而服务端是 false，双方就永远卡在房间里等开局。
        if (self.net.isReady) self.readyMe = self.net.isReady(v, self.myRoomSeat());

        self.applyView(v);

        // 客人端：房主宣布 live 就进游戏
        if (v.state && v.state.live && !self.started && self.mode === 'guest') {
          self.started = true;
          self.stopPoll();
          self.phase = 'playing';
          if (self.ui.onBegin) self.ui.onBegin(v.state.seed);
          return;
        }

        // 房主：双方都准备好了就自动开局
        if (self.mode === 'host' && !self.started && self.bothReady(v)) {
          self.startGameAsHost();
        }
      }).catch(function () {
        self._polling = false;
        self._fails++;

        // 一直拉不到就必须让用户看见，绝不能静默卡在房间里
        if (self._fails >= 3 && self.ui.onNetbar) {
          var why = (self.net && self.net.lastError) || '';
          if (why.indexOf('房间不存在') >= 0) {
            self.ui.onNetbar('房间已失效（服务器重启过）', 'warn');
          } else {
            self.ui.onNetbar('网络不稳定，正在重试…（第 ' + self._fails + ' 次）', 'warn');
          }
        }

        if (self._fails === 4 && self.net && self.net.reconnect) self.tryReconnect();

        // 好友端连续拉不到（多半服务重启、房间没了）—— 别让人干等
        if (self.mode === 'guest' && self._fails === 12) self.bailOut();
      });
    }, this.pollMs);
  };

  // 立刻拉一次（进页面、点完准备时别干等 1 秒）
  Lobby.prototype.pullNow = function () {
    var self = this;
    if (!this.net || this.phase !== 'lobby') return Promise.resolve(null);
    return this.net.pullState().then(function (v) {
      self._fails = 0;
      if (!v) return null;
      if (self.net.isReady) self.readyMe = self.net.isReady(v, self.myRoomSeat());
      self.applyView(v);
      if (v.state && v.state.live && !self.started && self.mode === 'guest') {
        self.started = true;
        self.stopPoll();
        self.phase = 'playing';
        if (self.ui.onBegin) self.ui.onBegin(v.state.seed);
      } else if (self.mode === 'host' && !self.started && self.bothReady(v)) {
        self.startGameAsHost();
      }
      return v;
    }).catch(function () { return null; });
  };

  Lobby.prototype.stopPoll = function () {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._polling = false;
  };

  // ---------------- 准备 / 取消 ----------------
  Lobby.prototype.toggleReady = function () {
    var self = this;
    if (!this.net) return Promise.reject(new Error('未连接'));
    var next = !this.readyMe;

    return this.net.setReady(next).then(function () {
      self.readyMe = next;
      if (self.ui.renderSeats) self.ui.renderSeats(self._snapshot());
      if (next) {
        if (self.mode === 'host') {
          // 房主自己也准备好了，立刻检查对方
          self.checkStart();
        } else if (self.ui.onToast) {
          self.ui.onToast('已准备，等房主开局…', 1800);
        }
      } else if (self.ui.onToast) {
        self.ui.onToast('已取消准备', 1400);
      }
      return next;
    }).catch(function (e) {
      // 失败不改变 UI 状态，避免显示与真实不一致
      if (self.ui.onToast) self.ui.onToast('操作失败，请检查网络后重试', 2000);
      throw e;
    });
  };

  // 房主检查能否开局（带重试，网络抖动不静默失败）
  Lobby.prototype.checkStart = function () {
    var self = this;
    if (this.mode !== 'host' || this.phase !== 'lobby') return;
    if (this._checking) return;
    this._checking = true;

    this._retry(function () { return self.net.pullState(); }, 3, 700)
      .then(function (v) {
        self._checking = false;
        self.applyView(v);
        if (self.bothReady(v)) self.startGameAsHost();
        else if (self.ui.onToast) self.ui.onToast('等好友准备好就能开始', 1600);
      })
      .catch(function () {
        self._checking = false;
        if (self.ui.onNetbar) self.ui.onNetbar('网络不稳定，正在重试开局…', 'warn');
        setTimeout(function () {
          if (self.phase === 'lobby') self.checkStart();
        }, 1500);
      });
  };

  Lobby.prototype.startGameAsHost = function () {
    if (this.started) return;
    this.started = true;
    this.stopPoll();
    this.phase = 'playing';
    var seed = Math.floor(Math.random() * 1e9);
    var self = this;

    // 先告诉服务端"开局了"，客人端靠 live 字段感知
    var p = this.net.start ? this.net.start(seed) : Promise.resolve();
    p.catch(function () {}).then(function () {
      if (self.ui.onBegin) self.ui.onBegin(seed);
    });
  };

  // ---------------- 断线重连 ----------------
  Lobby.prototype.tryReconnect = function () {
    var self = this;
    if (this._reconnecting || !this.net || !this.net.reconnect) return;
    this._reconnecting = true;
    var tries = 0;

    (function attempt() {
      tries++;
      if (self.ui.onNetbar) {
        self.ui.onNetbar('网络断了，正在重连…（第 ' + tries + '/5 次）', 'warn');
      }
      self.net.reconnect().then(function (ok) {
        if (ok) {
          self._reconnecting = false;
          if (self.ui.onNetbar) self.ui.onNetbar('已重新连接', 'ok', 2000);
          if (self.phase === 'lobby') self.startPoll();
          return;
        }
        if (tries >= 5) {
          self._reconnecting = false;
          var why = (self.net.lastError || '');
          if (why.indexOf('房间不存在') >= 0) self.bailOut();
          else if (self.ui.onNetbar) {
            self.ui.onNetbar('连不上服务器，请检查网络后重开房间', 'warn');
            if (self.ui.onToast) self.ui.onToast('网络一直连不上，只能先重开房间了', 3000);
          }
          return;
        }
        setTimeout(attempt, 1200 * tries);
      });
    })();
  };

  // ---------------- 退出 ----------------
  Lobby.prototype.bailOut = function () {
    if (this.phase === 'home') return;
    this.stopPoll();
    this.phase = 'home';
    if (this.ui.onNetbar) this.ui.onNetbar('房间已失效，请让房主重新建房', 'warn');
    if (this.ui.onToast) {
      this.ui.onToast('和房间断开太久了，接不回来了。让房主重新建个房间，再把房号发你', 4500);
    }
    if (this.net && this.net.leave) this.net.leave().catch(function () {});
    if (this.ui.onBail) this.ui.onBail();
  };

  Lobby.prototype.leave = function () {
    this.stopPoll();
    this.phase = 'home';
    if (this.net && this.net.leave) return this.net.leave().catch(function () {});
    return Promise.resolve();
  };

  // ---------------- 工具：重试包装 ----------------
  Lobby.prototype._retry = function (fn, times, gap) {
    times = times || 3;
    gap = gap || 800;
    return new Promise(function (resolve, reject) {
      var left = times;
      (function attempt() {
        fn().then(resolve).catch(function (err) {
          left--;
          if (left <= 0) { reject(err); return; }
          setTimeout(attempt, gap);
        });
      })();
    });
  };

  module.exports = Lobby;
})(typeof globalThis !== 'undefined' ? globalThis : this);
