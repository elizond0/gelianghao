/**
 * 哥俩好 · 环境判断层
 *
 * 全项目只有这里判断「我在哪跑」，其他任何文件都不许直接读 wx / window。
 * 所有平台差异都必须从这里拿，这样共用逻辑才能两端通用。
 *
 * 用法：
 *   var P = require('../shared/platform/env.js');
 *   if (P.isMiniProgram) { ... }
 */
(function (root) {
  'use strict';

  // ---------- 环境识别 ----------
  // wx 存在且有 getSystemInfoSync -> 微信小程序
  var hasWx = typeof wx !== 'undefined' && typeof wx.getSystemInfoSync === 'function';
  // 有 window + document -> 浏览器
  var hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';

  var kind = hasWx ? 'miniprogram' : (hasDom ? 'web' : 'unknown');

  // ---------- 屏幕信息 ----------
  function screenInfo() {
    if (hasWx) {
      var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      return {
        width: info.windowWidth || 375,
        height: info.windowHeight || 667,
        dpr: Math.min(info.pixelRatio || 2, 3),
        safeTop: (info.safeArea && info.safeArea.top) || 0,
        safeBottom: info.screenHeight && info.safeArea
          ? (info.screenHeight - info.safeArea.bottom)
          : 0
      };
    }
    if (hasDom) {
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
        safeTop: 0,
        safeBottom: 0
      };
    }
    return { width: 375, height: 667, dpr: 2, safeTop: 0, safeBottom: 0 };
  }

  // ---------- 存储 ----------
  // 统一成同步接口，key 前加前缀避免和其他数据打架
  var PREFIX = 'glh_';

  function getStorage(key, def) {
    try {
      if (hasWx) {
        var v = wx.getStorageSync(PREFIX + key);
        return (v === '' || v === undefined || v === null) ? def : v;
      }
      if (hasDom && window.localStorage) {
        var s = window.localStorage.getItem(PREFIX + key);
        return s === null ? def : JSON.parse(s);
      }
    } catch (e) {}
    return def;
  }

  function setStorage(key, val) {
    try {
      if (hasWx) { wx.setStorageSync(PREFIX + key, val); return true; }
      if (hasDom && window.localStorage) {
        window.localStorage.setItem(PREFIX + key, JSON.stringify(val));
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ---------- 提示与震动 ----------
  function toast(msg, ms) {
    if (hasWx) {
      wx.showToast({ title: String(msg), icon: 'none', duration: ms || 1800 });
      return;
    }
    // 网页端：由 router 注入的 UI 钩子接管（见 setToastHandler）
    if (toastHandler) toastHandler(String(msg), ms || 1800);
  }

  var toastHandler = null;
  function setToastHandler(fn) { toastHandler = fn; }

  function vibrate(type) {
    if (hasWx && wx.vibrateShort) {
      try { wx.vibrateShort({ type: type || 'light' }); } catch (e) {}
      return;
    }
    if (hasDom && navigator.vibrate) {
      try { navigator.vibrate(type === 'heavy' ? 30 : 12); } catch (e) {}
    }
  }

  // ---------- 分享 / 邀请 ----------
  // 返回一个「分享出去」的函数；网页和小程序的实现完全不同
  function shareRoom(roomCode, onWebShare) {
    if (hasWx) {
      // 小程序靠 onShareAppMessage 主动触发，见 pages/room
      return { needWxShare: true, roomCode: roomCode };
    }
    // 网页：拼一个带 ?room= 的链接
    var link = '';
    if (hasDom) {
      link = window.location.origin + window.location.pathname + '?room=' + roomCode;
    }
    if (onWebShare) onWebShare(link, roomCode);
    return { needWxShare: false, link: link, roomCode: roomCode };
  }

  // ---------- 剪贴板 ----------
  function copyText(text) {
    if (hasWx) {
      wx.setClipboardData({ data: String(text) });
      return Promise.resolve(true);
    }
    if (hasDom && navigator.clipboard) {
      return navigator.clipboard.writeText(String(text)).then(function () { return true; }).catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  // ---------- 页面跳转 ----------
  // 网页是多屏切换，小程序是页面栈，这里统一成一个出口
  var navHandler = null;
  function setNavHandler(fn) { navHandler = fn; }

  function go(page, params) {
    params = params || {};
    if (hasWx) {
      var qs = Object.keys(params).map(function (k) {
        return k + '=' + encodeURIComponent(params[k]);
      }).join('&');
      var url = '/pages/' + page + '/' + page + (qs ? '?' + qs : '');
      if (page === 'game') wx.redirectTo({ url: url });
      else wx.navigateTo({ url: url });
      return;
    }
    if (navHandler) navHandler(page, params);
  }

  // 直达某页并清掉返回栈（回首页、结算后重来都用它）
  function redirect(name, params) {
    params = params || {};
    if (hasWx) {
      var qs = Object.keys(params).map(function (k) {
        return k + '=' + encodeURIComponent(params[k]);
      }).join('&');
      wx.reLaunch({ url: '/pages/' + name + '/' + name + (qs ? '?' + qs : '') });
      return;
    }
    if (navHandler) navHandler(name, params);
  }

  function back(page) {
    if (hasWx) {
      wx.navigateBack({ delta: 1 });
      return;
    }
    if (navHandler) navHandler(page || 'home', {});
  }

  module.exports = {
    kind: kind,
    isMiniProgram: kind === 'miniprogram',
    isWeb: kind === 'web',
    isUnknown: kind === 'unknown',

    screenInfo: screenInfo,
    getStorage: getStorage,
    setStorage: setStorage,
    toast: toast,
    setToastHandler: setToastHandler,
    vibrate: vibrate,
    shareRoom: shareRoom,
    copyText: copyText,
    go: go,
    redirect: redirect,
    back: back,
    setNavHandler: setNavHandler
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
