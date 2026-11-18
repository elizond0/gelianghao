/**
 * 哥俩好 · 房间服务（零依赖：Node 内置 http + 手写 WebSocket）
 * 同时托管 ../web 静态页面，所以部署一个单端口即可：网页试玩 + 好友联机。
 *
 * 协议（JSON）：
 *   客户端 -> 服务端
 *     {t:'create', meta}                     建房，返回 4 位房号
 *     {t:'join', roomCode, meta}             加入
 *     {t:'ready', roomCode, ready}           准备
 *     {t:'state', roomCode, state, ready}    主机推送游戏快照
 *     {t:'pull', roomCode}                   拉取对手状态
 *     {t:'op', roomCode, data}               操作转发（实时）
 *     {t:'ping'}                             心跳
 *   服务端 -> 客户端
 *     {rid, data} / {rid, err}               请求应答
 *     {t:'op', data}                         收到对手操作
 *     {t:'peer', data:'join'|'left'}
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const ROOT = path.join(__dirname, '..');
// shared 是两端共用内核（唯一真源），game 保留是为了兼容旧引用
const PUBLIC_DIRS = ['web', 'shared', 'game'];

// ---------------- 手写 WebSocket（RFC6455，够用即可） ----------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x81; // text + fin
  return Buffer.concat([header, payload]);
}

function decodeFrames(buf, onMessage, onClose) {
  let offset = 0;
  while (buf.length - offset >= 2) {
    const b0 = buf[offset], b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) === 0x80;
    let len = b1 & 0x7f;
    let cursor = offset + 2;
    if (len === 126) {
      if (buf.length - cursor < 2) break;
      len = buf.readUInt16BE(cursor); cursor += 2;
    } else if (len === 127) {
      if (buf.length - cursor < 8) break;
      len = Number(buf.readBigUInt64BE(cursor)); cursor += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - cursor < maskLen + len) break;
    let payload = buf.slice(cursor + maskLen, cursor + maskLen + len);
    if (masked) {
      const mask = buf.slice(cursor, cursor + 4);
      payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    }
    offset = cursor + maskLen + len;

    if (opcode === 0x8) { onClose(); return buf.slice(offset); }
    if (opcode === 0x9) continue; // ping：忽略，靠应用层心跳
    if (opcode === 0x1) onMessage(payload.toString('utf8'));
  }
  return buf.slice(offset);
}

const clients = new Map(); // socket -> {send, meta}
const rooms = new Map();   // code -> { code, host:conn, guest:conn|null, state, ready:{0:bool,1:bool}, createdAt, lastActive }

function newRoomCode() {
  for (let i = 0; i < 200; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-4);
}

function roomView(room) {
  return {
    roomCode: room.code,
    players: [
      room.host ? room.host.meta : null,
      room.guest ? room.guest.meta : null
    ],
    ready: room.ready,
    state: room.state,
    online: [!!room.host, !!room.guest]
  };
}

function safeSend(conn, obj) {
  if (!conn) return;
  try { conn.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

// ---------------- 静态文件 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function resolveFile(urlPath) {
  // URL -> 相对路径：先去掉开头的 /，再抹掉目录痕迹
  const clean = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  for (const dir of PUBLIC_DIRS) {
    // 支持两种写法：
    //   /core.js          -> <dir>/core.js
    //   /shared/core/x.js -> <dir>/core/x.js（当 dir 是 shared 时，去掉前缀）
    let rel = clean;
    const seg = clean.split(/[/\\]/)[0];
    if (seg === dir) rel = clean.slice(seg.length).replace(/^[/\\]+/, '');

    const candidate = path.join(ROOT, dir, rel);
    if (candidate.startsWith(path.join(ROOT, dir)) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = resolveFile(urlPath);
  if (!filePath) {
    if (!path.extname(urlPath)) {
      fs.readFile(path.join(ROOT, 'web', 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('not found'); }
        else { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(d2); }
      });
      return;
    }
    res.writeHead(404); res.end('not found');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  serveStatic(req, res);
});

// ---------------- WebSocket 握手 + 消息处理 ----------------
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  const conn = {
    socket,
    meta: null,
    room: null,
    seat: 0,
    lastSeen: Date.now(),
    send: (str) => { try { socket.write(encodeFrame(str)); } catch (e) {} }
  };
  clients.set(socket, conn);

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    conn.lastSeen = Date.now();   // 任何数据都算活着（含浏览器自动回的 pong）
    buffer = Buffer.concat([buffer, chunk]);
    buffer = decodeFrames(buffer, (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      try { handle(conn, msg); } catch (e) { safeSend(conn, { rid: msg.rid, err: '服务器处理失败' }); }
    }, () => { try { socket.end(); } catch (e) {} });
  });

  socket.on('close', () => cleanup(conn));
  socket.on('error', () => cleanup(conn));
});

function log() { console.log.apply(console, ['[room]'].concat([].slice.call(arguments))); }

function cleanup(conn) {
  clients.delete(conn.socket);
  const room = conn.room;
  if (!room) return;
  // 先算出"对手"是谁，再清自己——顺序反了 peer 就永远是 null（之前就是这个 bug）
  const peer = room.host === conn ? room.guest : room.host;
  if (room.host === conn) room.host = null;
  if (room.guest === conn) room.guest = null;
  if (peer) safeSend(peer, { t: 'peer', data: 'left' });
  // 空房间立刻回收
  if (!room.host && !room.guest) rooms.delete(room.code);
  conn.room = null;
}

function handle(conn, msg) {
  const rid = msg.rid;

  switch (msg.t) {
    case 'ping':
      if (rid) safeSend(conn, { rid, data: { pong: Date.now() } });
      return;

    case 'create': {
      const code = newRoomCode();
      const room = {
        code,
        host: conn,
        guest: null,
        state: null,
        ready: { 0: false, 1: false },
        createdAt: Date.now(),
        lastActive: Date.now()
      };
      rooms.set(code, room);
      conn.room = room;
      conn.seat = 0;
      conn.meta = normalizeMeta(msg.meta, '我');
      console.log('[create]', code, 'from', conn.socket.remoteAddress);
      safeSend(conn, { rid, data: { roomCode: code, seat: 0 } });
      return;
    }

    case 'join': {
      let room = rooms.get(String(msg.roomCode || '').trim());

      // 房间不见了（服务重启 / 6 小时清理）：房主重连时自动把房间重新立起来，
      // 否则房主会一直卡在"房间不存在"，只能重新建房，房间号也变了 —— 非常烦。
      if (!room && msg.asHost) {
        room = { code: String(msg.roomCode || '').trim(), host: null, guest: null,
                 ready: { 0: false, 1: false }, state: null, lastActive: Date.now() };
        rooms.set(room.code, room);
        log('rehost ' + room.code + '（服务重启后房主重连，房间已重建）');
      }
      if (!room) { safeSend(conn, { rid, err: '房间不存在或已失效' }); return; }

      // 断线重连：若原座位对应的 socket 已经死了，把座位还回来
      const isDead = (c) => {
        if (!c || !c.socket) return true;
        if (c.socket.destroyed) return true;
        // readyState: 3 = CLOSED（0 CONNECTING / 1 OPEN / 2 CLOSING）
        return c.socket.readyState === 3;
      };
      const reclaim = (seatKey) => {
        const old = room[seatKey];
        if (old && old !== conn && isDead(old)) { room[seatKey] = null; return true; }
        return false;
      };
      reclaim('host'); reclaim('guest');

      // 已经在房间里了（重复 join / 重连到自己）
      if (room.host === conn) { safeSend(conn, { rid, data: { roomCode: room.code, seat: 0, view: roomView(room) } }); return; }
      if (room.guest === conn) { safeSend(conn, { rid, data: { roomCode: room.code, seat: 1, view: roomView(room) } }); return; }

      if (room.guest && room.guest !== conn) { safeSend(conn, { rid, err: '房间已满（最多 2 人）' }); return; }
      room.guest = conn;
      room.lastActive = Date.now();
      conn.room = room;
      conn.seat = 1;
      conn.meta = normalizeMeta(msg.meta, '好友');
      safeSend(conn, { rid, data: { roomCode: room.code, seat: 1, view: roomView(room) } });
      safeSend(room.host, { t: 'peer', data: 'join' });
      log('join ' + room.code + ' seat=' + conn.seat);
      return;
    }

    case 'ready': {
      const room = conn.room;
      if (!room) { safeSend(conn, { rid, err: '不在房间中' }); return; }
      room.ready[conn.seat] = !!msg.ready;
      room.lastActive = Date.now();
      safeSend(conn, { rid, data: true });
      return;
    }

    case 'state': {
      const room = conn.room;
      if (!room) { safeSend(conn, { rid, err: '不在房间中' }); return; }
      room.state = msg.state || null;
      log('state ' + room.code + ' live=' + (msg.state && msg.state.live));
      if (typeof msg.ready === 'boolean') room.ready[conn.seat] = msg.ready;
      room.lastActive = Date.now();
      safeSend(conn, { rid, data: true });
      return;
    }

    case 'pull': {
      const room = conn.room;
      if (!room) { safeSend(conn, { rid, err: '不在房间中' }); return; }
      safeSend(conn, { rid, data: roomView(room) });
      return;
    }

    case 'op': {
      const room = conn.room;
      if (!room) return;
      const peer = room.host === conn ? room.guest : room.host;
      safeSend(peer, { t: 'op', data: msg.data });
      if (rid) safeSend(conn, { rid, data: true });
      return;
    }

    case 'leave': {
      const room = conn.room;
      if (room) {
        if (room.host === conn) room.host = null;
        if (room.guest === conn) room.guest = null;
        const peer = room.host === conn ? room.guest : room.host;
        safeSend(peer, { t: 'peer', data: 'left' });
        if (!room.host && !room.guest) rooms.delete(room.code);
      }
      conn.room = null;
      safeSend(conn, { rid, data: true });
      return;
    }
  }
  if (rid) safeSend(conn, { rid, err: '未知指令' });
}

function normalizeMeta(meta, fallback) {
  const m = meta || {};
  return {
    name: String(m.name || fallback).slice(0, 12),
    avatar: String(m.avatar || '').slice(0, 200),
    score: Number(m.score) || 0
  };
}

// 清理 6 小时无活动房间
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActive > 6 * 3600 * 1000) rooms.delete(code);
  }
}, 10 * 60 * 1000);

// 心跳：30 秒没收到任何消息的连接先 ping，再 20 秒还没动静就断开，
// 这样对端掉线后座位能尽快释放，重连也不会被"房间已满"挡住。
//
// 坑：ping 帧必须写成 Buffer，不能写字符串 —— socket.write('\x89\x00') 会按 utf8 编码，
//     0x89 变成 0xc2 0x89（3 字节），浏览器解析成畸形帧并直接断开连接
//     （报 "Invalid frame header" / "server must not mask any frames"）。
const PING_FRAME = Buffer.from([0x89, 0x00]);   // FIN + opcode=ping, payload len=0
setInterval(() => {
  const now = Date.now();
  for (const conn of clients.values()) {
    if (!conn.socket) continue;
    if (now - (conn.lastSeen || 0) > 50000) {
      try { conn.socket.destroy(); } catch (e) {}
      cleanup(conn);
      continue;
    }
    // 应用层 ping（浏览器端会自动回 pong，我们只在意"有没有任何数据回来"）
    try { conn.socket.write(PING_FRAME); } catch (e) {}
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log('[哥俩好] 服务已启动 http://' + HOST + ':' + PORT);
});
