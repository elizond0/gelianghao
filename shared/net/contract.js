/**
 * 网络适配器 · 契约与公用基类
 *
 * 两端实现（net/ws.js、net/cloud.js）都必须满足这套接口。
 * 业务代码只依赖这套接口，换实现不用改业务代码。
 *
 * ============ 契约 ============
 *
 * 状态类
 *   connect()                  → Promise          建立连接（云开发可直接 resolve）
 *   isOpen()                   → boolean          当前是否连得上
 *   reconnect()                → Promise<boolean>  断线重连，成功 true
 *   leave()                    → Promise          离开房间
 *
 * 房间类
 *   createRoom(meta)           → Promise<roomCode>
 *   joinRoom(code, meta)       → Promise<{roomCode, seat, view}>
 *   setReady(bool)             → Promise          准备 / 取消（可反复切换）
 *   start(seed)                → Promise          房主宣布开局
 *
 * 同步类
 *   pullState()                → Promise<view>    拉房间快照
 *   pushState(state, ready)    → Promise          房主推状态
 *   sendOp(op)                 → Promise          发操作
 *
 * 事件
 *   onOp(cb)                   cb(op)             收到对方操作
 *   onStatus(cb)               cb(status)         online | offline | lost | peer-left | peer-join
 *
 * ============ view 结构（归一化后） ============
 *   {
 *     roomCode: '1234',
 *     players: [{name, avatar, score}, {name, avatar, score}],  // 按房间座位号索引
 *     ready:  {0: bool, 1: bool},    // 房间座位号：房主 0、好友 1
 *     online: {0: bool, 1: bool},
 *     isHost: bool,
 *     state:  {live, seed, s, snap} | null,
 *     ops:    [op]                   // 待消费的操作（云开发用）
 *   }
 *
 *   注意：两端底层返回的 online 可能是数组 [bool,bool]，isOnline() 两种都兼容。
 *
 * ⚠️ 两套座位编号，务必分清：
 *     房间座位号 roomSeat：房主 0、好友 1  ← ready / online / players 用它
 *     游戏内猴子号 gameSeat：房主 1（前排）、好友 0（后排）← 渲染和标签用它
 *     读 ready/online 一律用 1 - myRoomSeat()
 */
(function (root) {
  'use strict';

  function NetBase() {
    this.roomCode = null;
    this.seat = 0;          // 房间座位号（0 房主 / 1 好友）
    this.opCb = null;
    this.statusCb = null;
    this.lastError = '';
  }

  NetBase.prototype.onOp = function (cb) { this.opCb = cb; };
  NetBase.prototype.onStatus = function (cb) { this.statusCb = cb; };
  NetBase.prototype._status = function (s) { if (this.statusCb) this.statusCb(s); };
  NetBase.prototype._emitOp = function (op) { if (this.opCb && op) this.opCb(op); };

  // 我的房间座位号
  NetBase.prototype.myRoomSeat = function () { return this.seat; };
  // 房间座位号 → 游戏内猴子号（房主 1、好友 0）
  NetBase.prototype.roomSeatToGameSeat = function (roomSeat) {
    return roomSeat === 0 ? 1 : 0;
  };

  // 从 view 里安全读某座位是否 ready（对象或数组都兼容）
  NetBase.prototype.isReady = function (view, roomSeat) {
    if (!view || !view.ready) return false;
    return !!view.ready[roomSeat];
  };

  // 在线状态：服务端用数组 [bool,bool]，云函数归一化成对象 {0,1}，两种都吃
  NetBase.prototype.isOnline = function (view, roomSeat) {
    if (!view || view.online == null) return false;
    var o = view.online;
    if (Array.isArray(o)) return !!o[roomSeat];
    return !!o[roomSeat];
  };

  // 双方都准备好了才算能开局
  NetBase.prototype.bothReady = function (view) {
    return this.isReady(view, 0) && this.isReady(view, 1);
  };

  if (typeof module === 'object' && module.exports) module.exports = NetBase;
  root.GLHNetBase = NetBase;
})(typeof globalThis !== 'undefined' ? globalThis : this);
