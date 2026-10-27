/**
 * 哥俩好 · 统一导航
 *
 * 两端跳转差异全在这里消化：
 *   小程序：页面栈，navigateTo / redirectTo
 *   网页  ：单页多屏切换，回调给 app.js 处理
 *
 * 业务代码统一调 Router.go('game', {mode:'host', seed:123})。
 */
(function (root) {
  'use strict';

  var env = require('./env.js');
  var routes = require('./routes.js');

  // 网页端注入的屏幕切换函数
  var webHandler = null;

  function setWebHandler(fn) { webHandler = fn; }

  // 弹层类路线的接管者（小程序端由各页面自己注册，比如首页的玩法说明弹层）
  var overlayHandler = null;
  function setOverlayHandler(fn) { overlayHandler = fn; }

  function go(name, params) {
    params = params || {};

    if (env.isMiniProgram) {
      // 小程序里 how / over 是弹层而不是独立页面：不跳转，交给当前页面开弹层。
      // 没人接管就静默忽略 —— 硬跳 mp 路径会跳到首页，反而像"点了没反应"。
      if (routes.isOverlay(name, env)) {
        if (overlayHandler) overlayHandler(name, params);
        return;
      }
      var url = routes.buildMpUrl(name, params);
      if (!url) { console.warn('[router] 未知页面:', name); return; }
      var api = routes.isRedirect(name) ? wx.redirectTo : wx.navigateTo;
      api({
        url: url,
        fail: function (e) {
          // 页面栈满了（10 层）自动降级成 redirect
          if (e && /limit/.test(e.errMsg || '')) {
            wx.redirectTo({ url: url });
          } else {
            console.error('[router] 跳转失败', e);
          }
        }
      });
      return;
    }

    if (webHandler) webHandler(name, params);
  }

  // 清空返回栈直达（回首页、结算后重来）。小程序走 reLaunch，网页走屏切换。
  function replace(name, params) {
    params = params || {};
    if (env.isMiniProgram) {
      if (routes.isOverlay(name, env)) {
        if (overlayHandler) overlayHandler(name, params);
        return;
      }
      var url = routes.buildMpUrl(name, params);
      if (!url) return;
      wx.reLaunch({
        url: url,
        fail: function (e) { console.error('[router] reLaunch 失败', e); }
      });
      return;
    }
    if (webHandler) webHandler(name, params);
  }

  function back(fallback) {
    if (env.isMiniProgram) {
      wx.navigateBack({
        delta: 1,
        fail: function () {
          if (fallback) go(fallback);
          else wx.reLaunch({ url: '/pages/index/index' });
        }
      });
      return;
    }
    if (webHandler) webHandler(fallback || 'home', {});
  }

  // 网页端读写 URL 里的 ?room=xxx，小程序端返回空
  function getInviteCode() {
    if (env.isMiniProgram) return '';
    if (typeof location === 'undefined') return '';
    return routes.readInviteCode(location.search + location.hash);
  }

  function setInviteCode(code) {
    if (env.isMiniProgram || typeof history === 'undefined') return;
    try {
      var url = code
        ? location.pathname + '?room=' + code
        : location.pathname;
      history.replaceState({}, '', url);
    } catch (e) {}
  }

  module.exports = {
    go: go,
    replace: replace,
    back: back,
    setWebHandler: setWebHandler,
    setOverlayHandler: setOverlayHandler,
    isOverlay: function (name) { return routes.isOverlay(name, env); },
    getInviteCode: getInviteCode,
    setInviteCode: setInviteCode,
    routes: routes
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
