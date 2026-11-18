/**
 * 用假 adapter 验证 shared/app/lobby.js 的状态机
 * 完全不起服务，纯逻辑验证。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

const Lobby = require(path.join(ROOT, 'shared/app/lobby.js'));
const NetBase = require(path.join(ROOT, 'shared/net/contract.js'));

let pass = 0, fail = 0;
function chk(label, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

// ---- 假网络：模拟服务端的 ready/online 状态 ----
function FakeNet(seat) {
  NetBase.call(this);
  this.seat = seat;
  this.roomCode = '1234';
  this.ready = { 0: false, 1: false };
  this.online = { 0: true, 1: true };
  this.live = false;
  this.seed = 0;
  this.peer = null;      // 用来联动两端
}
FakeNet.prototype = Object.create(NetBase.prototype);
FakeNet.prototype.constructor = FakeNet;

FakeNet.prototype.pullState = function () {
  return Promise.resolve({
    roomCode: this.roomCode,
    ready: Object.assign({}, this.ready),
    online: Object.assign({}, this.online),
    state: { live: this.live, seed: this.seed, snap: null }
  });
};
FakeNet.prototype.setReady = function (v) {
  this.ready[this.seat] = !!v;
  if (this.peer) this.peer.ready = this.ready;
  return Promise.resolve(true);
};
FakeNet.prototype.start = function (seed) {
  this.live = true;
  this.seed = seed;
  if (this.peer) { this.peer.live = true; this.peer.seed = seed; }
  return Promise.resolve(true);
};
FakeNet.prototype.reconnect = function () { return Promise.resolve(true); };
FakeNet.prototype.leave = function () { return Promise.resolve(); };

async function main() {
  const hostNet = new FakeNet(0);
  const guestNet = new FakeNet(1);
  hostNet.peer = guestNet;
  guestNet.peer = hostNet;

  let hostBegin = null, guestBegin = null;
  let hostBail = false, guestBail = false;

  const host = new Lobby({
    net: hostNet, mode: 'host', pollMs: 40,
    ui: {
      renderSeats: () => {},
      onNetbar: () => {},
      onToast: () => {},
      onBegin: (seed) => { hostBegin = seed; },
      onBail: () => { hostBail = true; }
    }
  });
  const guest = new Lobby({
    net: guestNet, mode: 'guest', pollMs: 40,
    ui: {
      renderSeats: () => {},
      onNetbar: () => {},
      onToast: () => {},
      onBegin: (seed) => { guestBegin = seed; },
      onBail: () => { guestBail = true; }
    }
  });

  console.log('\n[1] 座位号约定');
  chk('房主 myRoomSeat=0', host.myRoomSeat() === 0);
  chk('好友 myRoomSeat=1', guest.myRoomSeat() === 1);
  chk('房主 myGameSeat=1', host.myGameSeat() === 1);
  chk('好友 myGameSeat=0', guest.myGameSeat() === 0);

  host.startPoll();
  guest.startPoll();
  await new Promise(r => setTimeout(r, 120));

  console.log('\n[2] 好友准备 → 房主应看到已准备，但绝不能开局');
  await guest.toggleReady();
  await new Promise(r => setTimeout(r, 250));
  chk('好友 readyMe=true', guest.readyMe === true);
  chk('房主 readyPeer=true', host.readyPeer === true, host.readyPeer);
  chk('房主没有开局', hostBegin === null && host.started === false, host.started);

  console.log('\n[3] 好友取消准备 → 房主应看到未准备');
  await guest.toggleReady();
  await new Promise(r => setTimeout(r, 250));
  chk('好友 readyMe=false', guest.readyMe === false);
  chk('房主 readyPeer=false', host.readyPeer === false, host.readyPeer);

  console.log('\n[4] 双方准备 → 应自动开局');
  await guest.toggleReady();
  await new Promise(r => setTimeout(r, 120));
  await host.toggleReady();
  await new Promise(r => setTimeout(r, 400));
  chk('房主触发开局', hostBegin !== null, hostBegin);
  chk('好友收到 live 并开局', guestBegin !== null, guestBegin);
  chk('两端 seed 一致', hostBegin === guestBegin, [hostBegin, guestBegin]);
  chk('全程没人被踢出', hostBail === false && guestBail === false);

  console.log('\n[5] 好友掉线 → 房主应感知');
  host.stopPoll(); guest.stopPoll();
  const host2 = new Lobby({
    net: hostNet, mode: 'host', pollMs: 40,
    ui: { renderSeats: () => {}, onNetbar: () => {}, onToast: () => {} }
  });
  hostNet.online[1] = false;
  host2.startPoll();
  await new Promise(r => setTimeout(r, 250));
  chk('房主 onlinePeer=false', host2.onlinePeer === false, host2.onlinePeer);
  host2.stopPoll();

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
