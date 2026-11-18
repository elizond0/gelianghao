/**
 * 哥俩好 · 路由表
 *
 * 业务代码只说「去 game 页」，不说具体 URL / 页面路径，
 * 由这里按环境翻译成真实地址。加页面只改这一处。
 */

// 逻辑页面名 → 两端实现
var ROUTES = {
  home: {
    mp: '/pages/index/index',
    web: 'home',          // 网页多屏切换，对应 #scrHome
    title: '哥俩好'
  },
  room: {
    mp: '/pages/room/room',
    web: 'room',          // #scrRoom
    title: '房间'
  },
  game: {
    mp: '/pages/game/game',
    web: 'game',          // 画布本身，无独立屏
    title: '游戏中'
  },
  how: {
    // 小程序里玩法说明是首页的弹层，没有独立页面；取 mp 字段前先看 isOverlay
    mp: '/pages/index/index',
    web: 'how',           // #scrHow
    title: '玩法说明',
    overlay: true         // 形态差异：小程序用弹层，网页用独立屏
  },
  over: {
    mp: '/pages/game/game',   // 小程序里结算也是游戏页内的弹层
    web: 'over',              // #scrOver
    title: '本局结束',
    overlay: true
  }
};

// 小程序里这些页面用 redirectTo（不留返回栈）
var REDIRECT_PAGES = { game: true, home: true };

// 小程序里是"弹层"而非"页面"的路线：go() 不跳转，交给页面自己开弹层
var OVERLAY_ROUTES = { how: true, over: true };

function get(name, env) {
  var r = ROUTES[name];
  if (!r) return null;
  return env.isMiniProgram ? r.mp : r.web;
}

function buildMpUrl(name, params) {
  var r = ROUTES[name];
  if (!r) return null;
  var qs = Object.keys(params || {}).map(function (k) {
    return k + '=' + encodeURIComponent(params[k]);
  }).join('&');
  return r.mp + (qs ? '?' + qs : '');
}

function isRedirect(name) { return !!REDIRECT_PAGES[name]; }

// 该路线在当前环境是弹层（只有小程序端成立，网页端都是独立屏）
function isOverlay(name, env) {
  if (!env || !env.isMiniProgram) return false;
  return !!OVERLAY_ROUTES[name];
}

function title(name) {
  var r = ROUTES[name];
  return r ? r.title : '哥俩好';
}

/**
 * 判断网页端是否从邀请链接进来
 * 支持 ?room=1234 或 #room=1234
 */
function readInviteCode(search) {
  if (!search) return '';
  var m = String(search).match(/[?&#]room=(\d{4})/);
  return m ? m[1] : '';
}

module.exports = {
  ROUTES: ROUTES,
  get: get,
  buildMpUrl: buildMpUrl,
  isRedirect: isRedirect,
  isOverlay: isOverlay,
  title: title,
  readInviteCode: readInviteCode
};
