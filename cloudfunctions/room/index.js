/**
 * 云函数 room：哥俩好 · 联机房间服务
 *
 * 设计：房主权威（host authoritative）
 *  - 房主跑物理，定期把整局快照 push 到房间文档；
 *  - 好友只发操作（op），拉快照做插值，不做物理；
 *  - 双端同 seed，各自本地生成同一套地形。
 *
 * 集合：glh_rooms
 * 文档结构：
 *   { code, createdAt, updatedAt,
 *     seats: [ {openid, name, ready, online, lastSeen}, {...} ],
 *     hostOpenid, seed, live, snap, ops: [ ... ], ver }
 *
 * 部署：微信开发者工具 -> cloudfunctions/room -> 右键"上传并部署（云端安装依赖）"
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const COL = 'glh_rooms';

const ROOM_TTL_MS = 3 * 60 * 60 * 1000;   // 房间 3 小时后可回收
const ONLINE_MS = 12 * 1000;              // 12 秒没心跳算离线
const MAX_OPS = 40;                       // 每次最多回给房主多少条操作

function now() { return Date.now(); }

function emptySeat() {
  return { openid: '', name: '', ready: false, online: false, lastSeen: 0 };
}

function newRoom(code, hostOpenid, name) {
  const seats = [emptySeat(), emptySeat()];
  seats[0] = { openid: hostOpenid, name: name || '房主', ready: false, online: true, lastSeen: now() };
  return {
    code,
    createdAt: now(),
    updatedAt: now(),
    seats,
    hostOpenid,
    seed: 0,
    live: false,
    snap: null,
    ops: [],
    ver: 1
  };
}

/** 对外视图：不要把别人的 openid 暴露出去 */
function viewOf(room, myOpenid) {
  const t = now();
  const seats = (room.seats || []).map((s, i) => ({
    idx: i,
    name: s.openid ? s.name : '',
    me: s.openid === myOpenid,
    taken: !!s.openid,
    ready: !!s.ready,
    online: !!s.online && (t - (s.lastSeen || 0) < ONLINE_MS)
  }));
  return {
    code: room.code,
    seats,
    hostOpenid: room.hostOpenid,
    isHost: room.hostOpenid === myOpenid,
    live: !!room.live,
    seed: room.seed,
    ver: room.ver
  };
}

async function getRoom(code) {
  try {
    const r = await db.collection(COL).where({ code }).limit(1).get();
    return r.data && r.data[0] ? r.data[0] : null;
  } catch (e) {
    if (e && /collection not exists|not exist/i.test(e.message || '')) return null;
    throw e;
  }
}

async function touch(docId, patch) {
  await db.collection(COL).doc(docId).update({
    data: Object.assign({ updatedAt: now() }, patch)
  });
}

/** 找一个没被占用的 4 位房号 */
async function allocCode() {
  for (let i = 0; i < 12; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const exists = await getRoom(code);
    if (!exists) return code;
    // 老房间已过期就回收
    if (now() - (exists.updatedAt || 0) > ROOM_TTL_MS) {
      try { await db.collection(COL).doc(exists._id).remove(); } catch (e) {}
      return code;
    }
  }
  return String(Math.floor(1000 + Math.random() * 9000));
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event && event.action;

  try {
    switch (action) {
      // ---------------- 建房 ----------------
      case 'create': {
        const code = await allocCode();
        const room = newRoom(code, OPENID, event.name);
        const res = await db.collection(COL).add({ data: room });
        room._id = res._id;
        return { ok: true, roomCode: code, seat: 0, view: viewOf(room, OPENID) };
      }

      // ---------------- 进房 ----------------
      case 'join': {
        const code = String(event.code || '').trim();
        const room = await getRoom(code);
        if (!room) return { ok: false, msg: '房间不存在，检查一下房号' };

        const seats = room.seats || [emptySeat(), emptySeat()];
        let seat = seats.findIndex((s) => s.openid === OPENID);
        if (seat < 0) {
          seat = seats.findIndex((s) => !s.openid);
          if (seat < 0) return { ok: false, msg: '房间满了（最多两个人）' };
        }
        const t = now();
        const wasHere = !!seats[seat].openid;
        seats[seat] = {
          openid: OPENID,
          name: event.name || (seat === 0 ? '房主' : '好友'),
          ready: wasHere ? !!seats[seat].ready : false,   // 重新进房要重新准备
          online: true,
          lastSeen: t
        };
        if (seat === 0 && !room.hostOpenid) room.hostOpenid = OPENID;
        await touch(room._id, { seats, hostOpenid: room.hostOpenid });
        room.seats = seats;
        return { ok: true, roomCode: code, seat, view: viewOf(room, OPENID) };
      }

      // ---------------- 轮询状态（大厅 + 客人拉快照） ----------------
      case 'pull': {
        const room = await getRoom(String(event.code || ''));
        if (!room) return { ok: false, msg: '房间已关闭' };
        const seats = room.seats || [];
        const myIdx = seats.findIndex((s) => s.openid === OPENID);
        if (myIdx >= 0) {
          seats[myIdx].online = true;
          seats[myIdx].lastSeen = now();
          await touch(room._id, { seats });
        }
        const out = {
          ok: true,
          view: viewOf(Object.assign({}, room, { seats }), OPENID),
          state: {
            live: !!room.live,
            seed: room.seed,
            snap: room.snap || null
          }
        };
        // 房主取操作队列（取完清空）
        if (room.hostOpenid === OPENID && room.ops && room.ops.length) {
          out.ops = room.ops.slice(0, MAX_OPS);
          const rest = room.ops.slice(MAX_OPS);
          await touch(room._id, { ops: rest });
        }
        return out;
      }

      // ---------------- 准备 / 取消准备 ----------------
      case 'ready': {
        const room = await getRoom(String(event.code || ''));
        if (!room) return { ok: false, msg: '房间已关闭' };
        const seats = room.seats || [];
        const i = seats.findIndex((s) => s.openid === OPENID);
        if (i < 0) return { ok: false, msg: '你不在这个房间里' };
        seats[i].ready = !!event.ready;
        seats[i].online = true;
        seats[i].lastSeen = now();
        await touch(room._id, { seats });
        return { ok: true, view: viewOf(Object.assign({}, room, { seats }), OPENID) };
      }

      // ---------------- 房主开局 ----------------
      case 'start': {
        const room = await getRoom(String(event.code || ''));
        if (!room) return { ok: false, msg: '房间已关闭' };
        if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主能开局' };
        await touch(room._id, {
          live: true,
          seed: event.seed || Math.floor(Math.random() * 1e9),
          snap: null,
          ops: [],
          ver: _.inc(1)
        });
        return { ok: true };
      }

      // ---------------- 房主推送快照 ----------------
      case 'state': {
        const room = await getRoom(String(event.code || ''));
        if (!room) return { ok: false, msg: '房间已关闭' };
        if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主能推状态' };
        await touch(room._id, {
          live: !!event.live,
          snap: event.snap || null,
          seed: event.seed || room.seed
        });
        return { ok: true };
      }

      // ---------------- 客人发操作 ----------------
      case 'op': {
        const room = await getRoom(String(event.code || ''));
        if (!room) return { ok: false, msg: '房间已关闭' };
        const myIdx = (room.seats || []).findIndex((s) => s.openid === OPENID);
        if (myIdx < 0) return { ok: false, msg: '你不在这个房间里' };
        const op = Object.assign({}, event.op, { m: myIdx, at: now() });
        const ops = (room.ops || []).concat([op]).slice(-MAX_OPS * 2);
        await touch(room._id, { ops });
        return { ok: true };
      }

      // ---------------- 离开 ----------------
      case 'leave': {
        const room = await getRoom(String(event.code || ''));
        if (!room) return { ok: true };
        const seats = room.seats || [];
        const i = seats.findIndex((s) => s.openid === OPENID);
        if (i >= 0) {
          seats[i] = { openid: '', name: '', ready: false, online: false, lastSeen: 0 };
          const patch = { seats, live: false };
          // 房主走了：把房主身份交给还在房间里的人，房间不至于直接作废
          if (room.hostOpenid === OPENID) {
            const heir = seats.findIndex((s) => !!s.openid);
            patch.hostOpenid = heir >= 0 ? seats[heir].openid : '';
          }
          await touch(room._id, patch);
        }
        return { ok: true };
      }

      default:
        return { ok: false, msg: '未知操作：' + action };
    }
  } catch (e) {
    return { ok: false, msg: (e && e.message) || '服务器开小差了' };
  }
};
