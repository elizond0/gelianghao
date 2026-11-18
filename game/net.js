/**
 * 哥俩好 · 网络层抽象（网页 / 小程序共用同一套接口）
 *
 * 接口：
 *   connect()                 -> Promise
 *   createRoom(meta)          -> Promise<roomCode>
 *   joinRoom(code, meta)      -> Promise<{roomCode, seat, host, state}>
 *   setReady(ready)           -> Promise
 *   pushState(snap, ready)    -> Promise
 *   pullState()               -> Promise<{players, state, startSeed, startedAt, tick}>
 *   sendOp(op)                -> Promise    (WebSocket 实时下发；轮询模式下随 state 带回)
 *   onOp(cb)                  订阅对手操作
 *   onStatus(cb)              连接状态回调
 *   leave()
 *
 * 两种实现：
 *   WebSocketAdapter —— 网页版 / 自建服务端，实时
 *   CloudAdapter     —— 微信小程序云开发，用云函数 + 1s 轮询
 */
(function (root) {
  'use strict';

  // ---------------- WebSocket 版 ----------------
  function WsAdapter(url, opts) {
    this.url = url;
    this.opts = opts || {};
    this.ws = null;
    this.opCb = null;
    this.statusCb = null;
    this.roomCode = null;
    this.seat = 0;
    this._pending = {};
    this._reqId = 1;
    this._queue = [];
    this.everOpened = false;   // 是否成功连上过（用来区分"首次连不上"和"连过又断"）
    this.closedByMe = false;   // 主动离开时不触发"掉线"提示
    this.lastError = '';       // 最近一次失败原因，给上层写提示用
  }

  WsAdapter.prototype.onOp = function (cb) { this.opCb = cb; };
  WsAdapter.prototype.onStatus = function (cb) { this.statusCb = cb; };

  WsAdapter.prototype._status = function (s) { if (this.statusCb) this.statusCb(s); };

  WsAdapter.prototype.connect = function () {
    var self = this;
    if (this.ws && this.ws.readyState === 1) return Promise.resolve();    return new Promise(function (resolve, reject) {
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
        if (msg.t === 'op' && self.opCb) self.opCb(msg.data);
        if (msg.t === 'peer') self._status(msg.data === 'join' ? 'peer-join' : 'peer-left');
      };
      ws.onclose = function () {
        clearTimeout(connTimer);
        // 区分"从没连上"和"连着连着断了"，前端提示文案不一样；主动离开不算掉线
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

  WsAdapter.prototype._send = function (payload, timeoutMs) {
    var self = this;
    // 断线了不要傻等 8 秒，直接失败让调用方重试
    if (!this.isOpen() && this._queue.length === 0 && this.roomCode) {
      // 还在建连阶段就排队；已连过又断了就快速失败
    }
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
      else if (!self.everOpened) self._queue.push(raw);
      else {
        // 连过又断了：不再排队（排了也没人发），立刻报错，交给上层重试/重连
        done = true;
        clearTimeout(timer);
        reject(new Error('连接已断开'));
      }
    });
  };

  WsAdapter.prototype.createRoom = function (meta) {
    var self = this;
    return this.connect().then(function () {
      return self._send({ t: 'create', meta: meta || {} });
    }).then(function (d) {
      self.roomCode = d.roomCode; self.seat = 0; return d.roomCode;
    });
  };

  WsAdapter.prototype.joinRoom = function (code, meta) {
    var self = this;
    return this.connect().then(function () {
      return self._send({ t: 'join', roomCode: code, meta: meta || {} });
    }).then(function (d) {
      self.roomCode = d.roomCode; self.seat = d.seat; return d;
    });
  };

  WsAdapter.prototype.setReady = function (ready) {
    return this._send({ t: 'ready', roomCode: this.roomCode, ready: ready }).catch(function () {});
  };

  WsAdapter.prototype.pushState = function (snap, ready) {
    return this._send({ t: 'state', roomCode: this.roomCode, state: snap, ready: ready }).catch(function () {});
  };

  WsAdapter.prototype.pullState = function () {
    return this._send({ t: 'pull', roomCode: this.roomCode }).then(function (d) { return d; });
  };

  WsAdapter.prototype.sendOp = function (op) {
    // 实时模式：直接下发，不需要往返
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ t: 'op', roomCode: this.roomCode, data: op }));
    }
    return Promise.resolve();
  };

  WsAdapter.prototype.leave = function () {
    this.closedByMe = true;
    try { this.ws && this.ws.close(); } catch (e) {}
    this.ws = null;
  };

  /**
   * 断线重连：网络抖动后把 socket 重新拉起来，并重新进房。
   * 返回 Promise<boolean>，true 表示恢复成功。
   */
  WsAdapter.prototype.reconnect = function () {
    var self = this;
    var code = this.roomCode;
    var meta = this.opts.meta || {};
    if (!code) return Promise.resolve(false);

    // 关键：不要相信旧 socket 的 readyState。
    // 断网时浏览器可能还报 readyState=1（假活），connect() 里的
    // `if (this.ws && readyState === 1) return Promise.resolve()` 会直接短路，
    // 于是"重连"实际上啥也没干，join 也发不出去 —— 之前重连一直失败的根因。
    // 做法：先把旧 socket 摘下来并彻底废掉，再建新连接。
    var old = this.ws;
    this.ws = null;
    this.closedByMe = true;              // 旧连接关闭不算掉线
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;  // 摘掉回调，防止它回头改写状态
      try { old.close(); } catch (e) {}
    }
    this._queue = [];
    this._pending = {};
    this.closedByMe = false;
    this.everOpened = false;             // 新一轮建连，重新计

    return this.connect().then(function () {
      // asHost：房主重连时告诉服务端"房间没了就重建"（重启后房间数据会丢）
      return self._send({ t: 'join', roomCode: code, meta: meta, asHost: self.seat === 0 }, 8000);
    }).then(function (d) {
      self.seat = d && typeof d.seat === 'number' ? d.seat : self.seat;
      self._status('online');
      return true;
    }).catch(function (e) {
      // 记下失败原因，上层好给用户一句人话
      self.lastError = (e && e.message) || '网络异常';
      return false;
    });
  };
  // ---------------- 微信云开发版 ----------------
  function CloudAdapter(opts) {
    this.env = opts.env;
    this.opCb = null;
    this.statusCb = null;
    this.roomCode = null;
    this.seat = 0;
    this._fn = null;
  }

  CloudAdapter.prototype._call = function (action, data) {
    if (!root.wx || !root.wx.cloud) return Promise.reject(new Error('请先在 app.js 中初始化 wx.cloud'));
    var fn = this._fn || (this._fn = root.wx.cloud.init ? root.wx.cloud : null);
    if (!root.wx.cloud.callFunction) return Promise.reject(new Error('云开发未初始化'));
    return new Promise(function (resolve, reject) {
      root.wx.cloud.callFunction({
        name: 'room',
        data: Object.assign({ action: action }, data || {}),
        success: function (res) {
          var r = res.result || {};
          if (r.err) reject(new Error(r.err)); else resolve(r.data);
        },
        fail: function (err) { reject(new Error((err && err.errMsg) || '云函数调用失败')); }
      });
    });
  };

  CloudAdapter.prototype.onOp = function (cb) { this.opCb = cb; };
  CloudAdapter.prototype.onStatus = function (cb) { this.statusCb = cb; };
  CloudAdapter.prototype.connect = function () { return Promise.resolve(); };

  CloudAdapter.prototype.createRoom = function (meta) {
    var self = this;
    return this._call('create', { meta: meta }).then(function (d) {
      self.roomCode = d.roomCode; self.seat = 0; return d.roomCode;
    });
  };

  CloudAdapter.prototype.joinRoom = function (code, meta) {
    var self = this;
    return this._call('join', { roomCode: code, meta: meta }).then(function (d) {
      self.roomCode = d.roomCode; self.seat = d.seat; return d;
    });
  };

  CloudAdapter.prototype.setReady = function (ready) {
    return this._call('ready', { roomCode: this.roomCode, ready: ready });
  };

  CloudAdapter.prototype.pushState = function (snap, ready) {
    return this._call('state', { roomCode: this.roomCode, state: snap, ready: ready });
  };

  CloudAdapter.prototype.pullState = function () {
    return this._call('pull', { roomCode: this.roomCode });
  };

  CloudAdapter.prototype.sendOp = function (op) {
    return this._call('op', { roomCode: this.roomCode, data: op });
  };

  CloudAdapter.prototype.leave = function () { this.roomCode = null; };

  root.GLHNet = { WsAdapter: WsAdapter, CloudAdapter: CloudAdapter };
})(typeof globalThis !== 'undefined' ? globalThis : this);
