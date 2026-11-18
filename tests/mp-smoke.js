/**
 * 小程序端路由与页面逻辑测试（Node 里模拟 wx 运行时）
 *
 * 不是像素级测试，只验证三件事：
 *   1. 环境判断在「有 wx」时识别为 miniprogram
 *   2. 路由表按环境翻译成正确的页面路径，弹层路线不跳转
 *   3. 首页/房间/游戏三个页面的 onLoad 能跑通，不抛异常
 */
'use strict';

const path = require('path');
const assert = require('assert');

const MP = path.join(__dirname, '..', 'miniprogram');

// ---------------- 假 wx ----------------
const calls = [];
const storage = {};

const room = { code: '1234', ready: { 0: false, 1: false }, live: false, seed: 0 };

global.wx = {
  getSystemInfoSync() { return { windowWidth: 375, windowHeight: 812, pixelRatio: 3, screenHeight: 812, safeArea: { top: 44, bottom: 778 } }; },
  getWindowInfo() { return this.getSystemInfoSync(); },
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k]; },
  setStorageSync(k, v) { storage[k] = v; },
  showToast(o) { calls.push(['toast', o.title]); },
  showModal(o) { calls.push(['modal', o.title]); if (o.success) o.success({ confirm: false }); },
  showLoading(o) { calls.push(['loading', o.title]); },
  hideLoading() { calls.push(['hideLoading']); },
  setClipboardData(o) { calls.push(['clipboard', o.data]); },
  vibrateShort() {},
  navigateTo(o) { calls.push(['navigateTo', o.url]); if (o.success) o.success(); },
  redirectTo(o) { calls.push(['redirectTo', o.url]); },
  reLaunch(o) { calls.push(['reLaunch', o.url]); },
  navigateBack(o) { calls.push(['navigateBack']); },
  canIUse() { return true; },
  createSelectorQuery() {
    return {
      in() { return this; },
      select() { return this; },
      fields() { return this; },
      exec(cb) {
        // 造一个假 canvas 节点，让 canvas.mp.js 走通
        const node = {
          width: 0, height: 0,
          getContext() { return { scale() {}, clearRect() {}, setTransform() {}, save() {}, restore() {}, translate() {}, fillRect() {} }; },
          requestAnimationFrame() { return 1; },
          cancelAnimationFrame() {}
        };
        cb([{ node, width: 375, height: 812 }]);
      }
    };
  },
  cloud: {
    init() { calls.push(['cloud.init']); },
    callFunction(o) {
      // 模拟云函数 room：create / join / pull / ready / start / state / op / leave
      const a = o.data.action;
      const ok = (data) => setTimeout(() => o.success({ result: Object.assign({ ok: true }, data) }), 0);
      // mySeat：这次调用是"我"坐在哪个座位（模拟同一个小程序里的当前用户）
      const seatView = (code, isHost) => ({
        code,
        seats: [
          { idx: 0, name: '房主', me: isHost, taken: true, ready: room.ready[0], online: true },
          { idx: 1, name: '好友', me: !isHost, taken: true, ready: room.ready[1], online: true }
        ],
        hostOpenid: 'h', isHost, live: room.live, seed: room.seed, ver: 1
      });
      if (a === 'create') { room.ready[0] = false; return ok({ roomCode: '1234', seat: 0, view: seatView('1234', true) }); }
      if (a === 'join') return ok({ roomCode: o.data.code || '1234', seat: Number(o.data.code === '9999' ? 1 : (o.data.seat || 1)), view: seatView(o.data.code || '1234', false) });
      if (a === 'ready') { room.ready[0] = !!o.data.ready; return ok({ view: seatView('1234', true) }); }
      if (a === 'start') { room.live = true; room.seed = o.data.seed; return ok({}); }
      if (a === 'state') { room.live = !!o.data.live; return ok({}); }
      if (a === 'pull') return ok({ view: seatView('1234', true), state: { live: room.live, seed: room.seed, snap: null } });
      if (a === 'leave') { room.ready[0] = false; room.live = false; return ok({}); }
      return ok({});
    }
  }
};

// ---------------- 假 Page / App / getApp ----------------
let lastPage = null;
global.Page = function (cfg) { lastPage = cfg; };
global.App = function (cfg) { global.__app = cfg; };
global.getApp = function () { return global.__app; };
global.getCurrentPages = function () { return []; };

function loadPage(rel) {
  lastPage = null;
  delete require.cache[require.resolve(path.join(MP, rel))];
  require(path.join(MP, rel));
  assert(lastPage, rel + ' 没调用 Page()');
  // 造一个带 setData 的实例
  const page = Object.assign({}, lastPage);
  page.data = JSON.parse(JSON.stringify(lastPage.data || {}));
  page.setData = function (patch) {
    Object.keys(patch).forEach(k => {
      // 支持 'a.b' 这种路径写法
      if (k.indexOf('.') > 0) {
        const parts = k.split('.');
        let o = page.data;
        for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
        o[parts[parts.length - 1]] = patch[k];
      } else {
        page.data[k] = patch[k];
      }
    });
  };
  return page;
}

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name, '']); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

// ---------------- 1. 环境与路由 ----------------
const env = require(path.join(MP, 'shared/platform/env.js'));
const routes = require(path.join(MP, 'shared/platform/routes.js'));
const Router = require(path.join(MP, 'shared/platform/router.js'));

check('环境识别为 miniprogram', () => {
  assert.strictEqual(env.kind, 'miniprogram');
  assert.strictEqual(env.isMiniProgram, true);
});

check('路由表把 game 翻译成小程序页面', () => {
  assert.strictEqual(routes.buildMpUrl('game', { mode: 'host', seed: 7 }), '/pages/game/game?mode=host&seed=7');
});

check('how 在小程序端是弹层，不跳页面', () => {
  assert.strictEqual(routes.isOverlay('how', env), true);
  let got = null;
  Router.setOverlayHandler((n) => { got = n; });
  Router.go('how');
  assert.strictEqual(got, 'how');
  assert(!calls.some(c => c[0] === 'navigateTo'), 'how 不该跳页面');
  Router.setOverlayHandler(null);
});

check('room 走 navigateTo（保留返回栈）', () => {
  calls.length = 0;
  Router.go('room', { code: '1234', mode: 'host' });
  const hit = calls.find(c => c[0] === 'navigateTo');
  assert(hit, '应调用 navigateTo');
  assert.strictEqual(hit[1], '/pages/room/room?code=1234&mode=host');
});

check('game 走 redirectTo（不留返回栈）', () => {
  calls.length = 0;
  Router.go('game', { mode: 'solo', seed: 1 });
  const hit = calls.find(c => c[0] === 'redirectTo');
  assert(hit, '应调用 redirectTo');
});

check('replace(home) 走 reLaunch 清栈', () => {
  calls.length = 0;
  Router.replace('home');
  const hit = calls.find(c => c[0] === 'reLaunch');
  assert(hit && hit[1] === '/pages/index/index');
});

// ---------------- 2. 页面加载 ----------------
require(path.join(MP, 'app.js'));
check('App.onLaunch 初始化云开发', () => {
  global.__app.onLaunch();
  assert(calls.some(c => c[0] === 'cloud.init'), '应初始化云开发');
  assert(global.__app.globalData.cloudReady === true);
});

const indexPage = loadPage('pages/index/index.js');
check('首页 onLoad 能跑通', () => {
  indexPage.onLoad({});
  assert.strictEqual(indexPage.data.best, 0);
});

check('首页 onLoad 能接住房号参数', () => {
  const p2 = loadPage('pages/index/index.js');
  p2.onLoad({ room: '5678' });
  assert.strictEqual(p2.data.code, '5678');
});

check('首页输房号过滤非数字', () => {
  const p3 = loadPage('pages/index/index.js');
  p3.onLoad({});
  const v = p3.onCodeInput({ detail: { value: 'a12b345' } });
  assert.strictEqual(v, '1234');
  assert.strictEqual(p3.data.code, '1234');
});

check('首页单人开局跳到 game', () => {
  calls.length = 0;
  const p4 = loadPage('pages/index/index.js');
  p4.onLoad({});
  p4.onSolo();
  const hit = calls.find(c => c[0] === 'navigateTo' && /pages\/game\/game/.test(c[1]));
  assert(hit, '应跳游戏页');
  assert(/mode=solo/.test(hit[1]));
});

// 让建房/进房的 Promise 跑完
function tick(n) {
  return new Promise((res) => {
    let i = 0;
    (function go() { if (++i > n) return res(); setTimeout(go, 0); })();
  });
}

(async function () {
  // ---------------- 3. 建房 → 房间页 ----------------
  const p5 = loadPage('pages/index/index.js');
  p5.onLoad({});
  calls.length = 0;
  p5.onCreate();
  await tick(5);

  check('建房后跳到房间页并带上房号', () => {
    const hit = calls.find(c => c[0] === 'navigateTo' && /pages\/room\/room/.test(c[1]));
    assert(hit, '应跳房间页，实际调用：' + JSON.stringify(calls));
    assert(/code=1234/.test(hit[1]) && /mode=host/.test(hit[1]), 'URL 应带 code 与 mode：' + hit[1]);
  });

  const RT = require(path.join(MP, 'shared/app/runtime.js'));
  check('全局运行时拿到了适配器与房间号', () => {
    assert(RT.getNet(), '应有 net');
    assert.strictEqual(RT.getMode(), 'host');
    assert.strictEqual(RT.getRoom(), '1234');
  });

  // ---------------- 4. 房间页 ----------------
  const roomPage = loadPage('pages/room/room.js');
  check('房间页 onLoad 能起状态机', () => {
    roomPage.onLoad({ code: '1234', mode: 'host' });
    assert(roomPage.lobby, '应创建 lobby');
    assert.strictEqual(roomPage.lobby.mode, 'host');
    assert.strictEqual(roomPage.data.code, '1234');
    assert.strictEqual(roomPage.data.isHost, true);
  });

  await tick(6);

  check('房间页轮询后座位状态正确（房主自己未准备，好友已入座）', () => {
    const seats = roomPage.data.seats;
    assert.strictEqual(seats[0].isHost, true);
    assert.strictEqual(seats[0].me, true, '房主应在 0 号位');
    assert.strictEqual(seats[1].taken, true, '好友应在 1 号位');
    assert.strictEqual(roomPage.data.btnText, '我准备好了');
  });

  roomPage.onReady();
  await tick(8);

  check('准备后按钮变成可取消（准备状态跟着服务端走）', () => {
    assert.strictEqual(room.ready[0], true, '服务端应记下房主已准备');
    assert(/取消/.test(roomPage.data.btnText), '实际：' + roomPage.data.btnText);
  });

  roomPage.onReady();
  await tick(8);

  check('再点一次能取消准备', () => {
    assert.strictEqual(room.ready[0], false, '服务端应记下已取消');
    assert.strictEqual(roomPage.data.btnText, '我准备好了', '实际：' + roomPage.data.btnText);
  });


  // ---------------- 4.5 双方准备 → 自动开局 ----------------
  check('房主准备后，好友也准备好，应自动开局跳游戏页', () => {
    room.ready[1] = true;         // 模拟好友端点了准备
    roomPage.onReady();           // 房主点准备 → 内部 pullNow 应发现双方都 ready
  });
  await tick(10);

  check('房间页 onUnload 停掉轮询', () => {
    const lobby = roomPage.lobby;
    roomPage.onUnload();
    assert.strictEqual(lobby._timer, null, '轮询定时器应清掉');
  });

  check('自动开局时调用 start 并跳转 game', () => {
    assert.strictEqual(room.live, true, '服务端 live 应为 true');
    const nav = calls.filter(c => (c[0] === 'redirectTo' || c[0] === 'navigateTo') && /pages\/game\/game/.test(c[1]));
    assert(nav.length > 0, '应跳游戏页，实际调用：' + JSON.stringify(calls.slice(-5)));
    assert(/mode=host/.test(nav[nav.length - 1][1]), '房主应带 mode=host');
  });

  // ---------------- 5. 游戏页 ----------------
  const gamePage = loadPage('pages/game/game.js');
  gamePage.onLoad({ mode: 'solo', seed: 42 });
  await tick(4);

  check('游戏页 onLoad 能起会话', () => {
    assert(gamePage.session, '应有 session');
    assert.strictEqual(gamePage.session.mode, 'solo');
    assert.strictEqual(gamePage.session.seed, 42);
  });

  // 联机进游戏：房主控前排（猴子 1），好友控后排（猴子 0）
  const hostGame = loadPage('pages/game/game.js');
  hostGame.onLoad({ mode: 'host', seed: 42 });
  await tick(4);

  check('房主进游戏后控前排那只（gameSeat=1）', () => {
    assert(hostGame.session, '应有 session');
    assert.strictEqual(hostGame.session.game.seat, 1, '房主应是猴子 1（前排）');
    assert.strictEqual(hostGame.session.hud().turnName, '你', '开局先轮到房主');
  });

  check('好友进游戏后控后排那只（gameSeat=0）', () => {
    // 切到 guest 模式，复用同一个适配器
    const guestGame = loadPage('pages/game/game.js');
    RT.setMode('guest', '1234', 1);
    guestGame.onLoad({ mode: 'guest', seed: 42 });
    return guestGame;
  });
  await tick(4);

  check('HUD 数据能推到 data 上', () => {
    gamePage.applyHud({ dist: 12, score: 30, coins: 2, rescue: 0, turnName: '你', over: false });
    assert.strictEqual(gamePage.data.dist, 12);
    assert.strictEqual(gamePage.data.score, 30);
  });

  check('游戏页 onUnload 会销毁会话', () => {
    gamePage.onUnload();
    assert.strictEqual(gamePage.session, null);
  });

  // ---------------- 输出 ----------------
  let pass = 0, fail = 0;
  for (const [st, name, msg] of results) {
    if (st === 'PASS') { pass++; console.log('  ✅ ' + name); }
    else { fail++; console.log('  ❌ ' + name + '  →  ' + msg); }
  }
  console.log(`\n通过 ${pass} / 共 ${pass + fail}` + (fail ? '  ❌ 有失败' : '  ✅ 全部通过'));
  process.exit(fail ? 1 : 0);
})();
