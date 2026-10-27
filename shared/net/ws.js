/**
 * 网络适配器 · 网页端（原生 WebSocket）
 *
 * 用于浏览器直连自建服务端，延迟最低（<100ms）。
 * 满足了 net/contract.js 里的全部接口。
 */
(function (root) {
  'use strict';

  var Base = require('./contract.js');

  function WsAdapter(url, opts) {
    Base.call(this);
    this.url = url;
    this.opts = opts || {};
    this.ws = null;
    this._pending = {};
    this._reqId = 1;
    this._queue = [];
    this.everOpened = false;   // 是否成功连上过（区分"首次连不上"和"连过又断"）
    this.closedByMe = false;   // 主动离开时不触发"掉线"提示
  }
  WsAdapter.prototype = Object.create(Base.prototype);
  WsAdapter.prototype.constructor = WsAdapter;

  // ---------------- 连接 ----------------
  WsAdapter.prototype.connect = function () {
    var self = this;
    if (this.ws && this.ws.readyState === 1) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(self.url); } catch (e) { reject(e); return; }
      self.ws = ws;
      var settled = false;

      // 连不上时给个上限，别让界面永远"正在连接"
      var connTimer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('连接服务器超时，请检查网络后重试'));
      }, 12000);

      ws.onopen = function () {
        settled = true;
        self.everOpened = true;
        clearTimeout(connTimer);
        self._status('online');
        while (self._queue.length) ws.send(self._queue.shift());
        resolve();
      };
      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.rid && self._pending[msg.rid]) {
          self._pending[msg.rid](msg.err ? Promise.reject(new Error(msg.err)) : msg.data);
          delete self._pending[msg.rid];
          return;
        }
        if (msg.t === 'op') self._emitOp(msg.data);
        if (msg.t === 'peer') self._status(msg.data === 'join' ? 'peer-join' : 'peer-left');
      };
      ws.onclose = function () {
        clearTimeout(connTimer);
        if (!self.closedByMe) self._status(settled && self.everOpened ? 'lost' : 'offline');
        if (!settled) { settled = true; reject(new Error('连不上服务器，请检查网络')); }
      };
      ws.onerror = function () {
        clearTimeout(connTimer);
        if (!settled) { settled = true; reject(new Error('连不上服务器，请检查网络')); }
      };
    });
  };

  WsAdapter.prototype.isOpen = function () {
    return !!(this.ws && this.ws.readyState === 1);
  };

  // ---------------- 消息收发 ----------------
  WsAdapter.prototype._send = function (payload, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      payload.rid = self._reqId++;
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        delete self._pending[payload.rid];
        reject(new Error('网络超时'));
      }, timeoutMs || 6000);

      self._pending[payload.rid] = function (v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };

      var raw = JSON.stringify(payload);
      if (self.isOpen()) self.ws.send(raw);
      else if (!self.everOpened) self._queue.push(raw);   // 还在建连，先排队
      else {
        // 连过又断了：不再排队（排了也没人发），立刻报错，交给上层重连
        done = true;
        clearTimeout(timer);
        reject(new Error('连接已断开'));
      }
    });
  };

  // ---------------- 视图归一化 ----------------
  // 服务端 roomView 返回 {roomCode, players, ready, state, online:[bool,bool]}
  // 这里补齐契约要求的字段，让业务层两端写法一致
  WsAdapter.prototype._norm = function (d) {
    if (!d) return null;
    var seats = d.seats;
    var ready = { 0: false, 1: false };
    var online = { 0: false, 1: false };

    if (seats && seats.length) {
      // 云开发式结构（理论上不会走到，防御性兼容）
      for (var i = 0; i < 2; i++) {
        var s = seats[i];
        if (!s) continue;
        ready[i] = !!s.ready;
        online[i] = !!s.online;
      }
    } else {
      ready = d.ready || ready;
      if (Array.isArray(d.online)) {
        online = { 0: !!d.online[0], 1: !!d.online[1] };
      } else if (d.online) {
        online = d.online;
      }
    }

    return {
      roomCode: d.roomCode || this.roomCode,
      players: d.players || [{ name: '', avatar: '', score: 0 }, { name: '', avatar: '', score: 0 }],
      ready: ready,
      online: online,
      isHost: this.seat === 0,
      state: d.state || null,
      ops: d.ops || []
    };
  };

  // ---------------- 房间 ----------------
  WsAdapter.prototype.createRoom = function (meta) {
    var self = this;
    return this.connect().then(function () {
      return self._send({ t: 'create', meta: meta || {} });
    }).then(function (d) {
      self.roomCode = d.roomCode;
      self.seat = 0;
      return d.roomCode;
    }).catch(function (e) {
      self.lastError = (e && e.message) || '建房失败';
      throw e;
    });
  };

  WsAdapter.prototype.joinRoom = function (code, meta) {
    var self = this;
    return this.connect().then(function () {
      return self._send({ t: 'join', roomCode: code, meta: meta || {} });
    }).then(function (d) {
      self.roomCode = d.roomCode;
      self.seat = d.seat;
      return { roomCode: d.roomCode, seat: d.seat, view: self._norm(d.view) };
    }).catch(function (e) {
      self.lastError = (e && e.message) || '进房失败';
      throw e;
    });
  };

  WsAdapter.prototype.setReady = function (ready) {
    return this._send({ t: 'ready', roomCode: this.roomCode, ready: !!ready }).catch(function () {});
  };

  WsAdapter.prototype.start = function (seed) {
    return this._send({ t: 'state', roomCode: this.roomCode, state: { live: true, seed: seed, s: 0 } });
  };

  WsAdapter.prototype.pushState = function (snap, ready) {
    return this._send({ t: 'state', roomCode: this.roomCode, state: snap, ready: ready }).catch(function () {});
  };

  WsAdapter.prototype.pullState = function () {
    var self = this;
    return this._send({ t: 'pull', roomCode: this.roomCode }).then(function (d) {
      return self._norm(d);
    });
  };

  WsAdapter.prototype.sendOp = function (op) {
    // 实时模式：直接下发，不需要往返
    if (this.isOpen()) {
      this.ws.send(JSON.stringify({ t: 'op', roomCode: this.roomCode, data: op }));
    }
    return Promise.resolve();
  };

  // ---------------- 断线重连 ----------------
  WsAdapter.prototype.reconnect = function () {
    var self = this;
    var code = this.roomCode;
    var meta = this.opts.meta || {};
    if (!code) return Promise.resolve(false);

    // 关键：不要相信旧 socket 的 readyState。
    // 断网时浏览器可能还报 readyState=1（假活），connect() 会直接短路，
    // 于是"重连"实际上啥也没干，join 也发不出去。
    var old = this.ws;
    this.ws = null;
    this.closedByMe = true;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;  // 摘掉回调，防它回头改写状态
      try { old.close(); } catch (e) {}
    }
    this._queue = [];
    this._pending = {};
    this.closedByMe = false;
    this.everOpened = false;

    return this.connect().then(function () {
      // asHost：房主重连时告诉服务端"房间没了就重建"（服务重启会丢房间）
      return self._send({ t: 'join', roomCode: code, meta: meta, asHost: self.seat === 0 }, 8000);
    }).then(function (d) {
      self.seat = d && typeof d.seat === 'number' ? d.seat : self.seat;
      self._status('online');
      return true;
    }).catch(function (e) {
      self.lastError = (e && e.message) || '网络异常';
      return false;
    });
  };

  WsAdapter.prototype.leave = function () {
    this.closedByMe = true;
    try { this.ws && this.ws.close(); } catch (e) {}
    this.ws = null;
    this.roomCode = null;
    return Promise.resolve();
  };

  module.exports = WsAdapter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
