/**
 * 哥俩好 · 网页端入口
 *
 * 启动方式：先让 loader 把 shared/ 下的依赖全部拉下来，
 * 依赖就绪后在回调里再同步 require —— 这样业务代码写法和小程序一模一样。
 */
(function () {
  'use strict';

  // 需要预加载的共用模块（顺序无所谓，loader 会按依赖拓扑排序）
  var DEPS = [
    '/shared/core/core.js',
    '/shared/core/render.js',
    '/shared/platform/env.js',
    '/shared/platform/routes.js',
    '/shared/platform/router.js',
    '/shared/platform/sfx-base.js',
    '/shared/platform/sfx.web.js',
    '/shared/platform/sfx.mp.js',
    '/shared/platform/canvas.web.js',
    '/shared/platform/canvas.mp.js',
    '/shared/platform/index.js',
    '/shared/net/contract.js',
    '/shared/net/ws.js',
    '/shared/net/cloud.js',
    '/shared/app/lobby.js',
    '/shared/app/session.js'
  ];

  require.boot(DEPS, function () {
    boot();
  });

  function boot() {

  // ---- 统一从 shared/ 取（两端唯一真源）----
  var Core = require('/shared/core/core.js');
  var Renderer = require('/shared/core/render.js');
  var Sfx = require('/shared/platform/sfx.web.js');
  var NetWs = require('/shared/net/ws.js');
  var env = require('/shared/platform/env.js');
  var Router = require('/shared/platform/router.js');

  var CFG = Core.CFG;
  // 兼容老代码里的 Net.WsAdapter 写法
  var Net = { WsAdapter: NetWs, CloudAdapter: require('/shared/net/cloud.js') };
  var SfxCtor = Sfx;

  var cv = document.getElementById('cv');
  var ctx = cv.getContext('2d');
  var sfx = new SfxCtor();
  var renderer = new Renderer(ctx);
  var game = null;
  var scale = 1;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var lastT = 0;

  var state = {
    mode: 'solo',      // solo | host | guest
    seat: 0,           // 联机时我坐哪只猴子（0 / 1）
    phase: 'home',     // home | lobby | playing | over
    readyMe: false,
    readyPeer: false,
    onlinePeer: false,
    seed: 1
  };

  var adapter = null;
  var lobbyTimer = null;
  var syncTimer = null;
  var pushAcc = 0;
  var started = false;
  var peerStarted = false;

  // 调试出口：浏览器控制台里可直接看 __debug.state() / __debug.pull() 排查联机问题
  window.__debug = {
    state: function () { return JSON.parse(JSON.stringify(state)); },
    pull: function () { return adapter ? adapter.pullState() : Promise.resolve(null); },
    adapter: function () { return adapter; }
  };

  var $ = function (id) { return document.getElementById(id); };
  var SCREENS = ['scrHome', 'scrRoom', 'scrOver', 'scrHow'];

  function show(id) {
    SCREENS.forEach(function (s) {
      var el = $(s);
      if (s === id) { el.style.display = 'flex'; el.classList.add('show'); }
      else { el.style.display = 'none'; el.classList.remove('show'); }
    });
    var hud = $('hud');
    if (id === null) { hud.classList.add('show'); hud.style.opacity = '1'; }
    else { hud.classList.remove('show'); hud.style.opacity = '0'; }
  }
  function hideScreens() {
    show(null);
    $('btnQuit').classList.add('show');   // 进游戏才显示退出按钮
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 1500);
  }

  // ---------------- 移动端手势防护 ----------------
  // 目标：双击不放大、双指不缩放、长按不弹菜单、下滑不刷新、左右滑不回退。
  (function guardGestures() {
    // 双指/多指：直接拦掉（Safari 的双指缩放、Chrome 的 pinch-zoom）
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('gesturechange', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('gestureend', function (e) { e.preventDefault(); }, { passive: false });

    // touchmove：多指一律拦；单指只在"可滚区域"放行，其余拦掉（防橡皮筋/下拉刷新）
    document.addEventListener('touchmove', function (e) {
      if (e.touches && e.touches.length > 1) { e.preventDefault(); return; }
      var t = e.target;
      var scrollable = t && t.closest && t.closest('.scrollable');
      if (!scrollable && e.cancelable) e.preventDefault();
    }, { passive: false });

    // 双击缩放：记录上一次点击时间，300ms 内的第二次 taps 拦掉
    var lastTap = 0;
    document.addEventListener('touchend', function (e) {
      var now = Date.now();
      if (now - lastTap < 300) { e.preventDefault(); }
      lastTap = now;
    }, { passive: false });

    // 长按弹菜单（图片/链接被长按会弹"存储/打开"）
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // 触屏设备上补一条：某些安卓浏览器只认 meta 更新时才生效，这里再压一次
    function lockZoom() {
      var vp = document.querySelector('meta[name=viewport]');
      if (!vp) return;
      vp.setAttribute('content',
        'width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover');
    }
    lockZoom();
    window.addEventListener('orientationchange', function () {
      lockZoom();
      setTimeout(fit, 250);   // 转屏后重新量尺寸
    });
  })();

  // 横屏提示：只有手机横过来才提示（平板/桌面不管）
  function checkOrientation() {
    var tip = document.getElementById('rotateTip');
    if (!tip) return;
    var isPhone = Math.min(window.innerWidth, window.innerHeight) < 600;
    var landscape = window.innerWidth > window.innerHeight;
    tip.classList.toggle('show', isPhone && landscape);
  }
  window.addEventListener('resize', checkOrientation);
  window.addEventListener('orientationchange', function () { setTimeout(checkOrientation, 200); });
  checkOrientation();

  // ---------------- 画布 ----------------
  function fit() {
    var rect = cv.parentElement.getBoundingClientRect();
    cv.width = Math.round(rect.width * dpr);
    cv.height = Math.round(rect.height * dpr);
    scale = Math.min(rect.width / CFG.W, rect.height / CFG.H);
    if (renderer.resize) renderer.resize(scale);
  }
  window.addEventListener('resize', fit);

  // ---------------- 游戏生命周期 ----------------
  // 这里有【两套编号】，很容易混，写清楚：
  //   房间座位号 roomSeat：房主 0、好友 1   —— 服务端 ready/online 数组用的就是它
  //   游戏内猴子号 gameSeat：房主 1（前排）、好友 0（后排）—— 和渲染顺序/标签对应
  function myRoomSeat() { return state.mode === 'host' ? 0 : 1; }
  function mySeat() { return state.mode === 'host' ? 1 : 0; }

  function newGame(seed) {
    game = new Core.Game({ seed: seed || Math.floor(Math.random() * 1e9) });
    game.onEvent = onGameEvent;
    // reset() 会把 netMode/seat 清空，所以必须在这里重新绑定
    if (state.mode === 'host') game.setNet('host', 1);
    if (state.mode === 'guest') game.setNet('guest', 0);
    state.seat = game.seat;
    fit();
  }

  function onGameEvent(type, d) {
    switch (type) {
      case 'jump': sfx.play('jump'); break;
      case 'land': sfx.play('land'); break;
      case 'wet': sfx.play('wet'); toast('掉坑里了！换另一只跳过坑，把它钓上来', 1700); break;
      case 'rescue': sfx.play('rescue'); toast('哥俩好！把伙伴钓上来了 +30', 1400); break;
      case 'coin': sfx.play('coin'); break;
      case 'hit': sfx.play('hit'); break;
      case 'switch': sfx.play('switch'); break;
      case 'perfect': sfx.play('perfect'); break;
      case 'gold': sfx.play('gold'); toast('金香蕉 +50！', 1200); break;
      case 'checkpoint': sfx.play('checkpoint'); toast('到达存档点！掉下去也能从这儿接着来', 1500); break;
      case 'respawn': sfx.play('respawn'); break;
      case 'spring': sfx.play('spring'); break;
      case 'gameover': onGameOver(d); break;
    }
    if (location.search.indexOf('dbg=1') >= 0) console.log('ev', type, JSON.stringify(d));
  }

  function onGameOver(d) {
    sfx.play('over');
    state.phase = 'over';
    var best = Number(localStorage.getItem('glh_best') || 0);
    if (d.score > best) { best = d.score; localStorage.setItem('glh_best', String(best)); }
    $('ovScore').textContent = d.score;
    $('ovDist').textContent = d.distance;
    $('ovCoin').textContent = d.coins;
    $('ovRescue').textContent = d.rescues;
    $('ovPerfect').textContent = d.perfects || 0;
    $('ovGold').textContent = d.golds || 0;
    $('ovCombo').textContent = d.bestCombo || 0;
    $('ovFalls').textContent = d.falls || 0;
    $('ovBest').textContent = best;
    $('ovTime').textContent = fmtTime(d.time || 0);
    $('overReason').textContent = overReasonText(d);
    $('btnQuit').classList.remove('show');     // 结算页不需要退出按钮
    setTimeout(function () { show('scrOver'); }, 600);
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }

  // 每日挑战：seed 由当天日期决定（全球同图）；换日自动换图
  function dailySeed() {
    var d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  // 结算文案：双落水 vs 同一存档点连摔 3 次的卡关，说清楚区别
  function overReasonText(d) {
    if (d.reason === 'stuck') return '同一面旗子连掉 ' + (d.falls || 3) + ' 次，这关先饶过你们';
    if (d.rescues >= 3) return '你俩互相拉上来 ' + d.rescues + ' 次，最后还是双双落水';
    return '两只猴子一起掉进了水里';
  }

  // ---------------- 主循环 ----------------
  function loop(now) {
    requestAnimationFrame(loop);
    var dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0.016;
    lastT = now;
    if (!game) return;

    if (state.mode !== 'guest') {
      game.update(dt);
      if (state.mode === 'host' && adapter) {
        pushAcc += dt;
        if (pushAcc > 0.1) { pushAcc = 0; pushHostState(); }
      }
    } else if (game.tickVisual) {
      // 客人端不跑物理（位置由房主快照驱动），但要推进粒子和地形生成，画面才不会僵住
      game.tickVisual(dt);
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.scale(dpr, dpr);
    var w = cv.width / dpr, h = cv.height / dpr;
    ctx.translate((w - CFG.W * scale) / 2, (h - CFG.H * scale) / 2);
    ctx.scale(scale, scale);
    renderer.draw(game, dt, { aiming: true, names: seatNames() });
    ctx.restore();

    updateHud();
  }

  // 联机时在猴子头上显示"谁在操控"
  function seatNames() {
    if (state.mode === 'solo') return null;
    var mine = game ? game.seat : mySeat();
    var names = ['好友', '好友'];
    names[mine] = '我';
    return names;
  }

  var lastCombo = -1;
  function updateHud() {
    $('hudDist').textContent = game.distance;
    $('hudScore').textContent = game.score;
    $('hudCoin').textContent = game.coins;
    var turn;
    if (state.mode === 'solo') turn = '你';
    else turn = (game.active === game.seat) ? '你' : '好友';
    $('hudTurn').textContent = turn;
    // 连击 pill：>=2 才亮，数字变了补一个弹跳动
    var combo = game.combo || 0;
    $('comboPill').classList.toggle('show', combo >= 2);
    if (combo !== lastCombo) {
      lastCombo = combo;
      $('hudCombo').textContent = 'x' + combo;
      if (combo >= 2) {
        var el = $('comboPill');
        el.classList.remove('pop');
        void el.offsetWidth;   // 强制重排，让动画能重放
        el.classList.add('pop');
      }
    }
    $('hudFalls').textContent = game.falls || 0;
    var tEl = $('hudTime');
    if (tEl) tEl.textContent = fmtTime(game.time || 0);
  }

  // ---------------- 输入 ----------------
  var pressing = false;
  function canPress() {
    if (!game) return false;
    if (state.mode !== 'solo' && game.active !== game.seat) return false;
    return game.state === 'playing' || game.state === 'ready';
  }
  function onDown(e) {
    if (!game) return;
    if (game.state === 'ready') { game.pressStart(); return; }
    if (!canPress()) {
      toast('这一只不归你管，等你的猴子起跳');
      return;
    }
    pressing = true;
    var seat = game.active;
    game.pressStart();
    if (state.mode !== 'solo') sendOp({ t: 'down', m: seat });
  }
  function onUp() {
    if (!pressing || !game) return;
    pressing = false;
    game.pressEnd();
    var op = game.lastOpOut;
    if (state.mode !== 'solo' && op) sendOp({ t: 'up', m: op.m, p: op.p });
  }
  function onCancel() { if (pressing && game) { pressing = false; game.pressEnd(); } }

  cv.addEventListener('touchstart', function (e) { e.preventDefault(); onDown(e); }, { passive: false });
  cv.addEventListener('touchend', function (e) { e.preventDefault(); onUp(); }, { passive: false });
  cv.addEventListener('touchcancel', onCancel);
  cv.addEventListener('mousedown', function (e) { e.preventDefault(); onDown(e); });
  window.addEventListener('mouseup', onUp);

  // ---------------- 网络状态提示 ----------------
  var netTimer = null;
  function netbar(msg, kind, ms) {
    var el = $('netbar');
    if (!el) return;
    clearTimeout(netTimer);
    if (!msg) { el.classList.remove('show'); return; }
    el.textContent = msg;
    el.className = 'netbar show' + (kind ? ' ' + kind : '');
    if (ms) netTimer = setTimeout(function () { el.classList.remove('show'); }, ms);
  }

  // 统一的重试包装：网络抖动时自动重试几次，仍失败才报错给用户看
  function retry(fn, times, gap) {
    times = times || 3; gap = gap || 800;
    return new Promise(function (resolve, reject) {
      var left = times;
      function attempt() {
        fn().then(resolve).catch(function (err) {
          left--;
          if (left <= 0) { reject(err); return; }
          setTimeout(attempt, gap);
        });
      }
      attempt();
    });
  }

  // ---------------- 联机 ----------------
  function wsUrl() {
    // 静态托管（GitHub Pages / surge 等）上跑不了 Node 联机服务，
    // 这时联机按钮会连不上。判定方法：页面被嵌入 file:// / 或 window.__GLH_OFFLINE__ 标记。
    if (window.__GLH_OFFLINE__) return '';
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host + '/ws';
  }

  function bindAdapter(a) {
    adapter = a;
    a.onOp(function (op) {
      if (state.mode === 'host' && game) game.queueRemote(op);
    });
    a.onStatus(function (s) {
      if (s === 'online') { netbar('', null); }
      if (s === 'offline') { netbar('连不上服务器，正在重试…', 'warn'); }
      if (s === 'lost') {
        netbar('网络断了，正在重连…', 'warn');
        tryReconnect();
      }
      if (s === 'peer-left') {
        state.onlinePeer = false;
        renderSeats();
        if (state.phase === 'lobby') toast('好友离开 / 掉线了，等他回来', 2200);
        else if (state.phase === 'playing') toast('好友掉线了，3 秒后自动接管他的猴子', 2600);
      }
      if (s === 'peer-join') {
        state.onlinePeer = true;
        renderSeats();
        netbar('好友已连接', 'ok', 1600);
      }
    });
  }

  // 房间没了（服务器重启过），好友这边救不回来 —— 只能回首页并说清楚
  function bailOutRoomGone() {
    if (state.phase === 'home') return;
    if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    netbar('房间已失效，请让房主重新建房', 'warn');
    toast('和房间断开太久了，接不回来了。让房主重新建个房间，再把房号发你', 4500);
    try { adapter && adapter.leave(); } catch (e) {}
    state.phase = 'home'; state.mode = 'solo'; started = false;
    show('scrHome');
  }

  // 断线重连：退避重试，成功后把房间状态接回来
  var reconnecting = false;
  function tryReconnect() {
    if (reconnecting || !adapter || !adapter.reconnect) return;
    reconnecting = true;
    var tries = 0;
    (function attempt() {
      tries++;
      netbar('网络断了，正在重连…（第 ' + tries + '/5 次）', 'warn');
      adapter.reconnect().then(function (ok) {
        if (ok) {
          reconnecting = false;
          netbar('已重新连接', 'ok', 2000);
          if (state.phase === 'lobby') { startLobbyPoll(); if (state.mode === 'host') scheduleHostStart(); }
          return;
        }
        if (tries >= 5) {
          reconnecting = false;
          var why = (adapter && adapter.lastError) || '';
          if (why.indexOf('房间不存在') >= 0) {
            bailOutRoomGone();
          } else {
            netbar('连不上服务器，请检查网络后重开房间', 'warn');
            toast('网络一直连不上，只能先重开房间了', 3000);
          }
          return;
        }
        setTimeout(attempt, 1200 * tries);
      });
    })();
  }

  function resetLobbyUI() {
    state.readyMe = false;
    state.readyPeer = false;
    state.onlinePeer = false;
    applyReadyButton();
    renderSeats();
  }

  function renderSeats() {
    var hostMine = state.mode === 'host';
    $('st0').textContent = hostMine ? (state.readyMe ? '已准备' : '未准备') : (state.readyPeer ? '已准备' : '未准备');
    $('st1').textContent = hostMine ? (state.readyPeer ? '已准备' : '等待好友…') : (state.readyMe ? '已准备' : '未准备');
    $('seat0').classList.toggle('ready', hostMine ? state.readyMe : state.readyPeer);
    $('seat1').classList.toggle('ready', hostMine ? state.readyPeer : state.readyMe);
    $('seat0').querySelector('.nm').textContent = hostMine ? '猴哥（我）' : '猴哥';
    $('seat1').querySelector('.nm').textContent = hostMine ? (state.onlinePeer ? '好友' : '等待好友…') : '好友（我）';
  }

  function enterLobby(code) {
    state.seat = mySeat();          // 座位只由"我是房主/客人"决定，不再用服务端返回的 index
    state.phase = 'lobby';
    state.started = false;
    started = false;
    $('lobby').style.display = 'flex';
    $('roomCode').textContent = code;
    resetLobbyUI();
    show('scrRoom');
    startLobbyPoll();
  }

  // 统一的开局条件：房间里两个座位都 ready 才算真的可以开。
  // 只看对方是常见错误 —— 房主自己没点准备也会被开了。
  function bothReady(v) {
    if (!v || !v.ready) return false;
    return !!(v.ready[0] && v.ready[1]);
  }

  function startLobbyPoll() {
    if (lobbyTimer) clearInterval(lobbyTimer);
    var polling = false;       // 防止请求重叠堆积（网络慢时会雪崩）
    var fails = 0;
    lobbyTimer = setInterval(function () {
      if (!adapter || state.phase !== 'lobby') return;
      if (polling) return;     // 上一个还没回来，这轮跳过
      polling = true;
      adapter.pullState().then(function (v) {
        polling = false;
        fails = 0;
        if (!v) return;
        // 注意：这里必须用【房间座位号】去读，不能用 state.seat（那是游戏内猴子号）
        var otherRoomSeat = 1 - myRoomSeat();
        state.onlinePeer = !!(v.online && v.online[otherRoomSeat]);
        state.readyPeer = !!(v.ready && v.ready[otherRoomSeat]);
        renderSeats();
        // 新一局从"非 live"开始，只有房主真正点开始后才变 live
        if (!v.state || !v.state.live) peerStarted = false;
        if (v.state && v.state.live && !started && state.mode === 'guest') {
          started = true;
          clearInterval(lobbyTimer); lobbyTimer = null;
          beginPlayFromNet(v.state.seed);
        }
        // 房主：双方都准备好了就在这里直接开局（不依赖按钮那次请求）。
        // 必须同时检查【房主自己】和【好友】的 ready —— 只检查好友的话，
        // 好友一点准备房主就被拽进游戏了，体验很莫名其妙。
        if (state.mode === 'host' && !started && bothReady(v)) {
          beginPlayFromNetHost();
        }
      }).catch(function () {
        polling = false;
        fails++;
        // 一直拉不到状态就必须让用户看见，绝不能静默卡在房间里
        if (fails >= 3) {
          var why = (adapter && adapter.lastError) || '';
          if (why.indexOf('房间不存在') >= 0) {
            netbar('房间已失效（服务器重启过）', 'warn');
          } else if (!reconnecting) {
            netbar('网络不稳定，正在重试…（第 ' + fails + ' 次）', 'warn');
          }
        }
        // 断线后自己起不来就主动重连；好友端房间失效则直接给出口
        if (fails === 4 && adapter && adapter.reconnect) tryReconnect();
        // 好友端连续拉不到（多半是服务重启、房间没了）—— 别让人干等，超时就说明白
        if (state.mode === 'guest' && fails === 12 && state.phase === 'lobby') {
          bailOutRoomGone();
        }
      });
    }, 1000);
  }

  function sendOp(op) {
    if (!adapter) return;
    op.seq = ++opSeq;
    adapter.sendOp(op);
  }
  var opSeq = 0;

  function pushHostState() {
    if (!adapter) return;
    if (typeof game.hasBegun !== 'function' ? false : !game.hasBegun()) return;
    adapter.pushState({
      live: true, seed: game.seed, s: 2, snap: game.snapshot()
    }, true);
  }

  function beginPlayFromNet(seed) {
    state.phase = 'playing';
    newGame(seed);
    hideScreens();
    game.start();
    sfx.play('ready');
    toast('开局！看准自己头上带"我"标的那只', 2000);
    if (state.mode === 'guest') startGuestSync();
  }

  function startGuestSync() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(function () {
      if (!adapter || state.mode !== 'guest') return;
      adapter.pullState().then(function (v) {
        if (!v) return;
        // 房主主动退出了这一局：把我一起带回首页，别把我挂在半局里
        if (v.state && v.state.quit) {
          stopNet();
          state.mode = 'solo'; state.phase = 'home';
          show('scrHome');
          toast('房主退出了这一局', 2000);
          return;
        }
        if (v.state && v.state.snap) game.applySnapshot(v.state.snap);
      }).catch(function () {});
    }, 180);
  }

  function stopNet() {
    if (lobbyTimer) clearInterval(lobbyTimer); lobbyTimer = null;
    if (syncTimer) clearInterval(syncTimer); syncTimer = null;
    if (adapter) { try { adapter.leave(); } catch (e) {} adapter = null; }
    started = false;
    $('lobby').style.display = 'none';
  }

  // ---------------- 按钮 ----------------
  function startSoloGame(seed, daily) {
    stopNet();
    state.mode = 'solo';
    state.phase = 'playing';
    newGame(seed);
    hideScreens();
    game.start();
    sfx.play('ready');
    if (daily) toast('每日挑战 · 今天这座山全球同图，加油！', 2200);
  }

  $('btnSolo').onclick = function () { startSoloGame(); };
  $('btnDaily').onclick = function () { startSoloGame(dailySeed(), true); };
  $('btnRoom').onclick = function () {
    $('lobby').style.display = 'none';
    $('inpCode').value = (location.search.match(/[?&]room=(\d{4})/) || [])[1] || '';
    show('scrRoom');
  };
  $('btnHow').onclick = function () { show('scrHow'); };
  $('btnHowBack').onclick = function () { show('scrHome'); };
  $('btnRoomBack').onclick = function () { stopNet(); state.mode = 'solo'; show('scrHome'); };

  $('btnCreate').onclick = function () {
    stopNet();
    bindAdapter(new Net.WsAdapter(wsUrl()));
    adapter.createRoom({ name: '猴哥' }).then(function (code) {
      state.mode = 'host';
      enterLobby(code);
      toast('房间建好了，把房号发给好友');
    }).catch(function (e) {
      toast('建房失败：' + e.message, 2500);
    });
  };

  $('btnJoin').onclick = function () {
    var code = ($('inpCode').value || '').trim();
    if (!/^\d{4}$/.test(code)) { toast('请输入 4 位房号'); return; }
    stopNet();
    bindAdapter(new Net.WsAdapter(wsUrl()));
    adapter.joinRoom(code, { name: '好友' }).then(function (d) {
      state.mode = 'guest';
      enterLobby(d.roomCode);
      if (d.view) {
        // 用【房间座位号】反推对手座位，别写死 0 —— 详见 myRoomSeat() 的注释
        state.onlinePeer = !!(d.view.online && d.view.online[1 - myRoomSeat()]);
        state.readyPeer = !!(d.view.ready && d.view.ready[1 - myRoomSeat()]);
        renderSeats();
      }
      toast('进房了，等房主开局');
    }).catch(function (e) {
      toast(e.message, 2200);
    });
  };

  // 准备状态可切换：点了变"已准备（点一下取消）"，再点取消
  var readyBusy = false;
  $('btnReady').onclick = function () {
    if (!adapter || readyBusy) return;
    var next = !state.readyMe;
    readyBusy = true;
    $('btnReady').disabled = true;
    adapter.setReady(next).then(function () {
      readyBusy = false;
      state.readyMe = next;
      applyReadyButton();
      renderSeats();
      if (next) {
        if (state.mode === 'host') {
          // 房主也准备后，立刻看看对方是不是也好了
          checkStartAsHost();
        } else {
          toast('已准备，等房主开局…', 1800);
        }
      } else {
        toast('已取消准备', 1400);
      }
    }).catch(function () {
      readyBusy = false;
      // 失败时把状态还原，别让按钮显示和真实状态不一致
      applyReadyButton();
      toast('操作失败，请检查网络后重试', 2000);
    });
  };

  function applyReadyButton() {
    var b = $('btnReady');
    b.disabled = false;
    if (state.readyMe) {
      b.textContent = '已准备（点一下取消）';
      b.classList.add('is-ready');
    } else {
      b.textContent = '我准备好了';
      b.classList.remove('is-ready');
    }
  }

  $('btnLeaveRoom').onclick = function () {
    stopNet();
    state.mode = 'solo';
    state.phase = 'home';
    $('bestScore').textContent = localStorage.getItem('glh_best') || 0;
    show('scrHome');
    toast('已离开房间', 1400);
  };

  /**
   * 房主开局。
   * 老版本的坑：只查一次、而且没有 catch —— 网络抖一下 promise 就静默 reject，
   * 结果"好友已准备但游戏开不起来"，还得手动重按一次（有时网络好就成）。
   * 现在：带重试 + 失败可见 + 轮询兜底，只要对方准备好了就一定会开局。
   */
  var startChecking = false;
  var startRetry = 0;

  function checkStartAsHost() {
    if (!adapter || state.mode !== 'host' || state.phase !== 'lobby') return;
    if (startChecking) return;
    startChecking = true;
    retry(function () { return adapter.pullState(); }, 3, 700).then(function (v) {
      startChecking = false;
      startRetry = 0;
      netbar('', null);
      if (v && bothReady(v)) {
        beginPlayFromNetHost();
      } else {
        // 对方还没准备 —— 提示一次就好，不用反复催
        if (startRetry++ === 0) toast('等好友准备好就能开始', 1800);
      }
    }).catch(function (e) {
      startChecking = false;
      // 网络真的不通：明确告诉用户，并继续后台重试，网络恢复后会自动开局
      if (startRetry++ % 3 === 0) {
        netbar('网络不稳定，正在重试开局…', 'warn');
        toast('网络不太好，正在重试…（可以先让对方再点一下准备）', 2400);
      }
      setTimeout(function () {
        if (state.phase === 'lobby') checkStartAsHost();
      }, 1500);
    });
  }

  // 房主真正开始一局
  function beginPlayFromNetHost() {
    if (started) return;
    started = true;
    if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
    state.phase = 'playing';
    newGame(Math.floor(Math.random() * 1e9));
    hideScreens();
    game.start();
    sfx.play('ready');
    toast('开局！看准自己头上带"我"标的那只', 2000);
    pushHostState();
  }

  // 房主：轮询里发现对方已准备也自动开局（双保险，不依赖上面那次请求成功）
  function scheduleHostStart() {
    // 已经由轮询触发，这里只是复位标记，避免重复开局
    if (state.mode === 'host' && state.phase === 'lobby') startRetry = 0;
  }

  $('btnCopy').onclick = function () {
    var code = $('roomCode').textContent;
    var url = location.origin + location.pathname + '?room=' + code;
    var text = '来打一局「哥俩好」！房号 ' + code + ' → ' + url;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('邀请文案已复制'); },
        function () { window.prompt('复制这条邀请发给好友', text); });
    } else {
      window.prompt('复制这条邀请发给好友', text);
    }
  };

  $('btnAgain').onclick = function () {
    $('btnQuit').classList.remove('show');
    if (state.mode === 'solo') { startSoloGame(); return; }
    if (state.mode === 'host') {
      state.phase = 'lobby';
      started = false;
      resetLobbyUI();
      state.readyMe = true;
      $('btnReady').disabled = true;
      $('btnReady').textContent = '已准备';
      show('scrRoom');
      $('lobby').style.display = 'flex';
      startLobbyPoll();
      if (adapter) adapter.setReady(true);
      checkStartAsHost();
      return;
    }
    show('scrRoom');
    $('lobby').style.display = 'flex';
  };

  $('btnHome').onclick = function () {
    stopNet();
    state.mode = 'solo';
    state.phase = 'home';
    $('btnQuit').classList.remove('show');
    $('bestScore').textContent = localStorage.getItem('glh_best') || 0;
    show('scrHome');
  };

  // ---------------- 游戏中退出 ----------------
  $('btnQuit').onclick = function () {
    if (state.phase !== 'playing' && state.phase !== 'ready') return;
    var online = state.mode !== 'solo';
    var msg = online
      ? '退出这一局？房间会解散，好友也会被带回首页。'
      : '退出这一局？本局分数不会记录。';
    if (!window.confirm(msg)) return;
    quitGame();
  };

  function quitGame() {
    // 联机：先把"我退了"告诉对方，让对面也能退出，别卡在半局
    if (adapter && state.mode !== 'solo') {
      try { adapter.pushState({ live: false, s: 0, quit: true }, false); } catch (e) {}
    }
    stopNet();
    state.mode = 'solo';
    state.phase = 'home';
    $('btnQuit').classList.remove('show');
    $('bestScore').textContent = localStorage.getItem('glh_best') || 0;
    show('scrHome');
    toast('已退出本局', 1400);
  }

  // ---------------- 启动 ----------------
  var mRoom = location.search.match(/[?&]room=(\d{4})/);
  $('bestScore').textContent = localStorage.getItem('glh_best') || 0;
  if ($('verText')) $('verText').textContent = Core.VERSION || '';
  newGame();
  fit();
  if (mRoom) {
    $('inpCode').value = mRoom[1];
    show('scrRoom');
  } else {
    show('scrHome');
  }
  requestAnimationFrame(loop);

  // 调试 / 自动化测试接口
  window.GLH = {
    get game() { return game; },
    get state() { return state; },
    canPress: canPress,
    startSolo: startSoloGame,
    pressStart: function () { if (game) game.pressStart(); },
    pressEnd: function () { if (game) game.pressEnd(); },
    jump: function (dist) {
      if (!game || game.state !== 'playing') return;
      game.pressStart();
      var m = game.monkeys[game.active];
      m.chargeT = game.chargeFor(dist);
      game.pressEnd();
    }
  };

  }  // boot()
})();
