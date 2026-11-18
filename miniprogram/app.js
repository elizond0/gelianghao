/**
 * 哥俩好 · 小程序端应用入口
 *
 * 这里只做三件事：
 *   1. 初始化云开发（联机用）
 *   2. 把跨页面的运行时状态挂到 globalData（见 shared/app/runtime.js）
 *   3. 提供 __glh 调试出口，方便在开发者工具控制台看状态
 *
 * 注意：业务逻辑一律不放这儿，大厅在 shared/app/lobby.js，
 *      游戏循环在 shared/app/session.js，网页端跑的是同一份。
 */
(function () {
  'use strict';

  // require 必须在文件顶层（小程序不支持运行时动态 require）
  var RT = require('./shared/app/runtime.js');

  App({
    globalData: {
      // 云开发环境 ID：在这里或 project.config.json 里改，不要写进业务代码
      envId: 'glh-game',
      // 运行时状态都在 runtime.js 里，这里只留个引用方便老代码过渡
      runtime: RT,
      cloudReady: false
    },

    onLaunch: function () {
      // ---------- 云开发 ----------
      if (typeof wx === 'undefined' || !wx.cloud) {
        // 基础库 2.2.3 以下没有云能力：单机照常玩，联机不可用
        console.error('[app] 当前基础库不支持云开发（需 ≥2.2.3），联机功能不可用');
      } else {
        try {
          wx.cloud.init({ env: this.globalData.envId, traceUser: true });
          this.globalData.cloudReady = true;
        } catch (e) {
          console.error('[app] 云开发初始化失败，检查 envId 是否正确', e);
        }
      }

      // ---------- 调试出口 ----------
      // 开发者工具 Console 里敲 __glh.state() / __glh.clearNet() 排查联机
      if (typeof globalThis !== 'undefined') {
        globalThis.__glh = {
          state: function () { return RT.dump(); },
          clearNet: function () { RT.clearNet(); return '已清空网络状态'; },
          best: function () { return RT.getBest(); },
          env: function () { return RT.dump().kind; }
        };
      }
    },

    onError: function (err) {
      console.error('[app] 未捕获错误：', err);
    }
  });
})();
