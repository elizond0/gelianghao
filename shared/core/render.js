/**
 * 哥俩好 · 渲染层
 * 只依赖 Canvas 2D 的 ctx 与游戏状态对象，网页 / 小程序共用。
 */
(function (root) {
  'use strict';
  // 小程序里通过 CommonJS 引入；网页里读 window.GLHCore
  var Core = root.GLHCore;
  if (!Core && typeof module === 'object' && module.exports && typeof require === 'function') {
    Core = require('./core.js');
    root.GLHCore = Core;
  }
  var CFG = (Core || {}).CFG;
  var THEMES = (Core || {}).THEMES || [];

  // 各档位配色（和 core 的 LEVELS/THEMES 一一对应：山脚→针叶林→碎石坡→雪线→暴风雪山顶）
  var THEME_COL = [
    { skyTop: '#bfe7ff', skyBottom: '#ffeccf', hillFar: '#a7d8c3', hillNear: '#7cc7a5', grass: '#63b96b', grassLight: '#8ed77b', dirt: '#8a5a3b' },
    { skyTop: '#aee2f5', skyBottom: '#ffe4c4', hillFar: '#8fc7ae', hillNear: '#63b58c', grass: '#4fa85e', grassLight: '#7cc86e', dirt: '#7d5138' },
    { skyTop: '#a4d4e8', skyBottom: '#e8d8c8', hillFar: '#a9a29a', hillNear: '#8a8378', grass: '#9b937f', grassLight: '#b5ac93', dirt: '#6f5643' },
    { skyTop: '#8fb8d8', skyBottom: '#d8e4ee', hillFar: '#b8c4cf', hillNear: '#93a3b3', grass: '#dfe8ef', grassLight: '#f4f9fc', dirt: '#5f6b78' },
    { skyTop: '#6d8fb3', skyBottom: '#c2d2e2', hillFar: '#93a5bb', hillNear: '#6e8299', grass: '#eef4fa', grassLight: '#ffffff', dirt: '#4e5a68' }
  ];
  function themeMix(i) { return THEME_COL[Math.max(0, Math.min(THEME_COL.length - 1, i))]; }

  // hex 混色：#rrggbb x t -> #rrggbb（昼夜渐变用）
  function mixHex(a, b, t) {
    var pa = [parseInt(a.substr(1, 2), 16), parseInt(a.substr(3, 2), 16), parseInt(a.substr(5, 2), 16)];
    var pb = [parseInt(b.substr(1, 2), 16), parseInt(b.substr(3, 2), 16), parseInt(b.substr(5, 2), 16)];
    var r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
    var g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
    var bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }

  // 昼夜四相：清晨 -> 正午 -> 黄昏 -> 雪夜（距离驱动，1600m 一整个昼夜）
  // 每相给出天空顶/底色；正午相用主题色（和山体配色联动），其余相叠加
  var DAY_PHASES = [
    { top: '#ffcf9e', bottom: '#ffe9cf' },   // 清晨
    null,                                     // 正午：用主题 TC
    { top: '#ff9d72', bottom: '#ffd9b3' },   // 黄昏
    { top: '#2c3d6b', bottom: '#50639a' }    // 雪夜
  ];
  function dayNight(g, TC) {
    var dayT = (((g.distance || 0) % 1600) / 1600) * 4;   // 0..4
    var k = Math.floor(dayT) % 4, f = dayT - Math.floor(dayT);
    // 相位边缘 20% 内做平滑过渡
    f = f < 0.8 ? f / 0.8 : 1;
    var c0 = DAY_PHASES[k] || { top: TC.skyTop, bottom: TC.skyBottom };
    var c1 = DAY_PHASES[(k + 1) % 4] || { top: TC.skyTop, bottom: TC.skyBottom };
    return {
      top: mixHex(c0.top, c1.top, f),
      bottom: mixHex(c0.bottom, c1.bottom, f),
      night: (k === 3 ? f : (k === 2 ? 0 : 0)) * 0 + (k === 3 ? f : (k === 2 && f > 0 ? f * 0.3 : 0)),
      phase: k, frac: f
    };
  }

  var COL = {
    skyTop: '#bfe7ff',
    skyBottom: '#ffeccf',
    sun: '#ffd066',
    hillFar: '#a7d8c3',
    hillNear: '#7cc7a5',
    water: '#4fb6e8',
    waterDark: '#2f92c9',
    dirt: '#8a5a3b',
    dirtDark: '#6d4229',
    grass: '#63b96b',
    grassLight: '#8ed77b',
    ice: '#cdefff',
    iceEdge: '#9fd8f5',
    ink: '#4a3226',
    rope: '#f2c078',
    ropeDark: '#c9954f'
  };

  function r2(x) { return Math.round(x * 10) / 10; }

  var Renderer = function (ctx, opts) {
    this.ctx = ctx;
    this.opts = opts || {};
    this.t = 0;
    this.clouds = [];
    this.snow = [];
    this.trail = [[], []];   // 空中拖尾采样：[猴0, 猴1] 各自的 {x,y,t}
    for (var i = 0; i < 60; i++) {
      this.snow.push({ x: Math.random() * 400, y: Math.random() * 700, r: 1 + Math.random() * 2.2, sp: 22 + Math.random() * 40, drift: Math.random() * 6.28 });
    }
    for (var i = 0; i < 7; i++) {
      this.clouds.push({ x: i * 240 + Math.random() * 120, y: 40 + Math.random() * 130, s: 0.6 + Math.random() * 0.7, sp: 4 + Math.random() * 8 });
    }
  };

  Renderer.prototype.resize = function (scale) { this.scale = scale; };

  Renderer.prototype.draw = function (g, dt, ui) {
    var ctx = this.ctx;
    var W = CFG.W, H = CFG.H;
    this.t += dt;
    var t = this.t;

    var shakeX = 0, shakeY = 0;
    if (g.shake > 0) {
      shakeX = (Math.random() - 0.5) * g.shake * 10;
      shakeY = (Math.random() - 0.5) * g.shake * 10;
    }

    ctx.save();
    // ---------- 天空（按所在山体档位换配色：越往上越冷、越接近山顶越昏暗）----------
    // 主题下标：中心视线落在第几档地形（LEVELS[i].until 是该档右边界）
    var ti = 0;
    var midX = g.camX + W / 2;
    var lvlArr = Core.LEVELS || [];
    for (var li = 0; li < lvlArr.length; li++) {
      if (midX >= lvlArr[li].until) ti = Math.min(li + 1, lvlArr.length - 1);
    }
    var TC = themeMix(ti);
    var dn = dayNight(g, TC);
    var sky = ctx.createLinearGradient ? ctx.createLinearGradient(0, 0, 0, H) : null;
    if (sky) {
      sky.addColorStop(0, dn.top);
      sky.addColorStop(1, dn.bottom);
      ctx.fillStyle = sky;
    } else {
      ctx.fillStyle = dn.top;
    }
    ctx.fillRect(0, 0, W, H);

    // 太阳 / 月亮：随昼夜相位切换（黄昏同框淡出，夜晚换月牙）
    var sunA = dn.phase === 3 ? 0 : (dn.phase === 2 ? 0.45 : (ti >= 4 ? 0.35 : 1));
    if (sunA > 0) {
      ctx.globalAlpha = sunA;
      ctx.fillStyle = COL.sun;
      circle(ctx, 318, 150, 34);
      ctx.globalAlpha = sunA * 0.25;
      circle(ctx, 318, 150, 48);
    }
    if (dn.phase === 3 || (dn.phase === 2 && dn.frac > 0.6)) {
      var moonA = dn.phase === 3 ? 1 : (dn.frac - 0.6) / 0.4;
      ctx.globalAlpha = moonA * 0.95;
      ctx.fillStyle = '#f4f1e0';
      circle(ctx, 318, 150, 26);
      ctx.fillStyle = dn.top;   // 用天空色咬掉一块 = 月牙
      circle(ctx, 328, 144, 22);
    }
    ctx.globalAlpha = 1;

    // 云
    ctx.fillStyle = '#ffffff';
    for (var i = 0; i < this.clouds.length; i++) {
      var c = this.clouds[i];
      var cx = ((c.x + t * c.sp - g.camX * 0.12) % 1700 + 1700) % 1700 - 200;
      this._cloud(cx, c.y, c.s);
    }

    // 远山（视差）
    this._hills(g.camX * 0.25, 300, TC.hillFar, 120);
    this._hills(g.camX * 0.45 + 90, 350, TC.hillNear, 100);

    // 飘雪（雪线以上才下；屏幕空间粒子，不进世界坐标）
    var snowAmt = THEMES[ti] ? THEMES[ti].snow : 0;
    if (snowAmt > 0) this._snow(g, t, snowAmt);

    // ---------- 世界 ----------
    ctx.save();
    ctx.translate(-g.camX + shakeX, shakeY);

    this._water(g, t);
    this._platforms(g, t);
    this._decals(g, t);
    this._rope(g, t);
    this._monkeys(g, t, ui);
    // 层次感：荡在平台下方的猴子画在柱子"后面"——
    // 这里把柱子/蘑菇杆再叠一层半透明，跨过柱子的落水猴会被罩上柱色
    this._pillarOverlay(g);
    this._particles(g);
    this._floats(g);

    ctx.restore();
    ctx.restore();

    // r15 顶部关卡进度条（屏幕空间，最后画保证在最上层）
    this._progress(g);
  };

  Renderer.prototype._cloud = function (x, y, s) {
    var ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, 22 * s, 0, Math.PI * 2);
    ctx.arc(x + 24 * s, y - 10 * s, 28 * s, 0, Math.PI * 2);
    ctx.arc(x + 56 * s, y, 20 * s, 0, Math.PI * 2);
    ctx.arc(x + 28 * s, y + 10 * s, 22 * s, 0, Math.PI * 2);
    ctx.fill();
  };

  Renderer.prototype._hills = function (offset, baseY, color, h) {
    var ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-100, CFG.WATER_Y + 12);
    var span = 220;
    var start = Math.floor(offset / span) * span - span;
    for (var x = start; x <= start + CFG.W + span * 2; x += span) {
      var sx = x - offset;
      ctx.moveTo(sx, CFG.WATER_Y + 12);
      ctx.quadraticCurveTo(sx + span / 2, baseY - h, sx + span, CFG.WATER_Y + 12);
      ctx.lineTo(sx, CFG.WATER_Y + 12);
    }
    ctx.fill();
  };

  // 飘雪：屏幕空间循环下落 + 随风漂移（山顶暴风雪里风是把猴子吹走的元凶，雪跟着一起飘才像）
  Renderer.prototype._snow = function (g, t, amt) {
    var ctx = this.ctx;
    var windAll = 0;
    for (var i = 0; i < (g.winds || []).length; i++) {
      var w = g.winds[i];
      if (g.camX + CFG.W / 2 >= w.x0 && g.camX + CFG.W / 2 <= w.x1) windAll = w.fx * (g._gustAt ? g._gustAt(w) : 1);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    var n = Math.round(this.snow.length * amt);
    for (var j = 0; j < n; j++) {
      var f = this.snow[j];
      var sy = (f.y + t * f.sp) % (CFG.H + 40) - 20;
      var sx = (f.x + t * (8 + f.r * 4) + windAll * 0.12 + Math.sin(t + f.drift) * 8) % (CFG.W + 40);
      if (sx < 0) sx += CFG.W + 40;
      ctx.globalAlpha = 0.4 + 0.5 * (f.r / 3.2);
      circle(ctx, sx - 20, sy - 20, f.r);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype._water = function (g, t) {
    var ctx = this.ctx;
    var left = g.camX - 40, right = g.camX + CFG.W + 40;
    var y = CFG.WATER_Y;   // 水面在画面最底部
    ctx.fillStyle = COL.water;
    ctx.fillRect(left, y, right - left, CFG.H - y + 200);
    ctx.fillStyle = COL.waterDark;
    for (var i = 0; i < 40; i++) {
      var wx = Math.floor(left / 46) * 46 + i * 46;
      var wy = y + 16 + Math.sin(t * 1.6 + i) * 5 + (i % 3) * 22;
      ctx.beginPath();
      ctx.ellipse ? ctx.ellipse(wx, wy, 16, 3.2, 0, 0, Math.PI * 2) : ctx.arc(wx, wy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // 水面高光
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var x = Math.floor(left / 30) * 30; x < right; x += 30) {
      var yy = y + Math.sin(t * 2 + x * 0.05) * 2.2;
      if (x === Math.floor(left / 30) * 30) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  Renderer.prototype._platforms = function (g, t) {
    var ctx = this.ctx;
    var left = g.camX - 80, right = g.camX + CFG.W + 80;
    for (var i = 0; i < g.platforms.length; i++) {
      var p = g.platforms[i];
      if (p.x + p.w < left || p.x > right) continue;
      var bottom = CFG.WATER_Y + 30;   // 柱子插进水里即可，不再直通屏外
      if (p.type === 'spring') {
        // r13：蘑菇台 = 石板桥 + 中段蘑菇垫（pad0~pad1）。
        // 垫外是普通石板可正常着陆（可以主动避开蘑菇），
        // 蘑菇伞只罩住垫区，白杆立在平台中线，一眼分清"哪段能踩哪段别踩"
        this._slabPillars(p, bottom, COL.dirt, COL.grass, 22, true);
        var padL = p.pad0 === undefined ? p.x + p.w * 0.30 : p.pad0;
        var padR = p.pad1 === undefined ? p.x + p.w * 0.70 : p.pad1;
        var pcx = (padL + padR) / 2;
        ctx.fillStyle = '#f1e8d8';
        ctx.fillRect(pcx - 7, p.y - 12, 14, bottom - p.y);
        ctx.fillStyle = '#e0524d';
        ctx.beginPath();
        ctx.moveTo(padL + 2, p.y);
        ctx.quadraticCurveTo(pcx, p.y - 34, padR - 2, p.y);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#b03a36';
        ctx.lineWidth = 2;
        ctx.stroke();
        // 伞面白色描边高光，草地上也醒目
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(padL + 4, p.y - 2);
        ctx.quadraticCurveTo(pcx, p.y - 32, padR - 4, p.y - 2);
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        circle(ctx, padL + (padR - padL) * 0.22, p.y - 10, 3.4);
        ctx.fill();
        circle(ctx, padL + (padR - padL) * 0.72, p.y - 14, 2.6);
        ctx.fill();
        circle(ctx, pcx, p.y - 5, 2.2);
        ctx.fill();
        // 弹跳预兆：伞面呼吸
        ctx.globalAlpha = 0.35 + 0.2 * Math.sin(t * 5 + p.x);
        ctx.strokeStyle = '#ffd8d6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(padL + 2, p.y);
        ctx.quadraticCurveTo(pcx, p.y - 34, padR - 2, p.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (p.type === 'float') {
        // 移动浮台：木板 + 底部两只浮筒 + 两端箭头提示巡逻方向
        ctx.fillStyle = '#9c6b43';
        roundRect(ctx, p.x, p.y, p.w, 16, 6);
        ctx.fill();
        ctx.fillStyle = '#b98355';
        roundRect(ctx, p.x + 2, p.y + 2, p.w - 4, 6, 3);
        ctx.fill();
        ctx.fillStyle = '#7d5433';
        roundRect(ctx, p.x + 6, p.y + 16, 18, 10, 4);
        ctx.fill();
        roundRect(ctx, p.x + p.w - 24, p.y + 16, 18, 10, 4);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        var dir = Math.cos((g.time || 0) * (p.spd || 0.3) + (p.ph || 0)) >= 0 ? 1 : -1;
        var acx = p.x + p.w / 2;
        ctx.beginPath();
        ctx.moveTo(acx + dir * 12, p.y - 8);
        ctx.lineTo(acx + dir * 3, p.y - 13);
        ctx.lineTo(acx + dir * 3, p.y - 3);
        ctx.closePath();
        ctx.fill();
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('浮台', acx, p.y - 18);
      } else if (p.type === 'ice') {
        this._slabPillars(p, bottom, COL.ice, COL.iceEdge, 12);
      } else if (p.type === 'turtle') {
        // r15 水面乌龟：随波起伏的救生台——龟壳 + 甲纹 + 探头 + 水纹
        var tcx = p.x + p.w / 2;
        ctx.save();
        ctx.translate(tcx, p.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (ctx.ellipse) ctx.ellipse(0, 7, p.w * 0.62, 5, 0, 0, Math.PI * 2); else ctx.arc(0, 7, p.w * 0.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#5da96b';
        circle(ctx, p.w / 2 + 7, -3, 6.5);
        ctx.fill();
        ctx.fillStyle = '#22301f';
        circle(ctx, p.w / 2 + 9.5, -5, 1.4);
        ctx.fill();
        ctx.fillStyle = '#2e7d46';
        ctx.beginPath();
        if (ctx.ellipse) ctx.ellipse(0, 0, p.w / 2, 11, 0, 0, Math.PI * 2); else ctx.arc(0, 0, p.w * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#1d5a30';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1.5;
        for (var hx = -p.w / 2 + 12; hx < p.w / 2 - 6; hx += 14) {
          ctx.beginPath(); ctx.moveTo(hx, -8); ctx.lineTo(hx + 4, 8); ctx.stroke();
        }
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        if (ctx.ellipse) ctx.ellipse(-6, -5, p.w * 0.2, 3.2, -0.2, 0, Math.PI * 2); else ctx.arc(-6, -5, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        // 石板 + 柱状支撑：平台是"桥板"，下面留出空间让落水的猴子在柱子间飘荡
        this._slabPillars(p, bottom, COL.dirt, COL.grass, 22, true);
      }
      // 完美着陆靶圈：平台正中央的浅色圆环，提示"踩这里有连击分"
      if (p.type !== 'start' && p.w >= 60) {
        var pr = p.w * 0.16;
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.setLineDash && ctx.setLineDash([4, 4]);
        ctx.beginPath();
        if (ctx.ellipse) ctx.ellipse(p.x + p.w / 2, p.y - 1, pr, pr * 0.42, 0, 0, Math.PI * 2);
        else ctx.arc(p.x + p.w / 2, p.y - 1, pr * 0.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  };

  // 石板平台 + 柱状支撑：板厚 slabH，柱子等分布 2~3 根，插到水里
  // 柱子半透明叠层：落水猴荡过柱子前面时被柱色罩住，"在柱子间飘荡"的层次感
  Renderer.prototype._pillarOverlay = function (g) {
    var ctx = this.ctx;
    var left = g.camX - 80, right = g.camX + CFG.W + 80;
    var bottom = CFG.WATER_Y + 30;
    // 有没有湿猴需要罩色？没有就完全跳过，省一层绘制
    var wet = g.monkeys && g.monkeys.filter(function (m) { return m.wetT > 0 && m.wetT < 100; });
    if (!wet.length) return;
    ctx.save();
    ctx.globalAlpha = 0.55;
    for (var i = 0; i < g.platforms.length; i++) {
      var p = g.platforms[i];
      if (p.x + p.w < left || p.x > right) continue;
      if (p.type === 'spring') {
        var slabH2 = 22;
        ctx.fillStyle = COL.dirtDark;
        var pn2 = p.w >= 110 ? 3 : 2;
        for (var pi2 = 0; pi2 < pn2; pi2++) {
          var px2 = p.x + (p.w / pn2) * (pi2 + 0.5) - 9;
          ctx.fillRect(px2, p.y + slabH2 - 4, 18, bottom - p.y - slabH2 + 4);
        }
        var pcx2 = (p.pad0 === undefined ? p.x + p.w * 0.30 : p.pad0) + ((p.pad1 === undefined ? p.x + p.w * 0.70 : p.pad1) - (p.pad0 === undefined ? p.x + p.w * 0.30 : p.pad0)) / 2;
        ctx.fillStyle = '#f1e8d8';
        ctx.fillRect(pcx2 - 7, p.y - 12, 14, bottom - p.y);
      } else if (p.type === 'float' || p.type === 'turtle') {
        continue;   // 浮台悬空、乌龟浮在水面，都没有柱子
      } else {
        var slabH = p.type === 'ice' ? 12 : 22;
        ctx.fillStyle = p.type === 'ice' ? COL.ice : COL.dirtDark;
        var pn = p.w >= 110 ? 3 : 2;
        for (var pi = 0; pi < pn; pi++) {
          var px = p.x + (p.w / pn) * (pi + 0.5) - 9;
          ctx.fillRect(px, p.y + slabH - 4, 18, bottom - p.y - slabH + 4);
        }
      }
    }
    ctx.restore();
  };

  Renderer.prototype._slabPillars = function (p, bottom, col, topCol, slabH, grassTop) {
    var ctx = this.ctx;
    var pn = p.w >= 110 ? 3 : 2;
    var top = p.y;

    // ---- 柱子（先画，垫在石板后面）----
    for (var pi = 0; pi < pn; pi++) {
      var px = p.x + (p.w / pn) * (pi + 0.5) - 9;
      var pw = 18;
      var py = top + slabH - 6;
      var ph = bottom - py;
      // 柱身：左亮右暗的横向渐变 = 圆柱感
      var pg = ctx.createLinearGradient(px, 0, px + pw, 0);
      pg.addColorStop(0, '#8a5f3d');
      pg.addColorStop(0.35, '#a5744a');
      pg.addColorStop(1, '#5f3f28');
      ctx.fillStyle = pg;
      ctx.fillRect(px, py, pw, ph);
      // 柱帽：比柱身略宽的石头横条
      ctx.fillStyle = '#937053';
      roundRect(ctx, px - 3, py, pw + 6, 7, 3);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      roundRect(ctx, px - 3, py, pw + 6, 2.6, 2);
      ctx.fill();
      // 柱底入水渐隐：水色盖住柱脚，柱子像真的插进水里
      var fadeH = 16;
      var fg = ctx.createLinearGradient(0, bottom - fadeH, 0, bottom);
      fg.addColorStop(0, 'rgba(122,180,225,0)');
      fg.addColorStop(1, 'rgba(122,180,225,0.75)');
      ctx.fillStyle = fg;
      ctx.fillRect(px - 2, bottom - fadeH, pw + 4, fadeH);
    }

    // ---- 石板（顶面亮、下缘暗的厚度感）----
    var bg = ctx.createLinearGradient(0, top, 0, top + slabH);
    bg.addColorStop(0, '#c49a6c');
    bg.addColorStop(0.55, col);
    bg.addColorStop(1, '#7c5636');
    ctx.fillStyle = bg;
    roundRect(ctx, p.x, top, p.w, slabH, 8);
    ctx.fill();
    // 砖缝：斜浅线点缀"石板拼接"感
    ctx.strokeStyle = 'rgba(0,0,0,0.14)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    var seams = Math.max(1, Math.round(p.w / 56));
    for (var si = 1; si <= seams; si++) {
      var sx = p.x + (p.w / (seams + 1)) * si;
      ctx.moveTo(sx - 3, top + 5);
      ctx.lineTo(sx + 3, top + slabH - 3);
    }
    ctx.stroke();

    if (grassTop) {
      // 草皮：包住石板上沿 + 底部垂坠弧（像盖上去的一层毯子）
      var gh = 15;
      ctx.fillStyle = COL.grass;
      roundRect(ctx, p.x - 2, top - 3, p.w + 4, gh, 9);
      ctx.fill();
      ctx.fillStyle = COL.grass;
      var dropN = Math.floor(p.w / 22);
      for (var di = 0; di < dropN; di++) {
        var dx = p.x + 8 + di * 22;
        ctx.beginPath();
        ctx.arc(dx, top + gh - 6, 4.5, 0, Math.PI);
        ctx.fill();
      }
      // 顶面高光
      ctx.fillStyle = COL.grassLight;
      roundRect(ctx, p.x + 1, top - 3, p.w - 2, 6.5, 4);
      ctx.fill();
      // 草尖
      ctx.fillStyle = COL.grass;
      for (var j = 0; j < Math.floor(p.w / 16); j++) {
        var gx = p.x + 8 + j * 16;
        ctx.beginPath();
        ctx.moveTo(gx, top - 2);
        ctx.lineTo(gx + 3, top - 11);
        ctx.lineTo(gx + 6, top - 2);
        ctx.fill();
      }
    } else {
      // 冰台：顶部亮冰层 + 冷光边
      ctx.fillStyle = topCol;
      roundRect(ctx, p.x - 1, top - 2, p.w + 2, 9, 6);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      roundRect(ctx, p.x + 2, top - 2, p.w - 4, 3, 2);
      ctx.fill();
    }
  };

  Renderer.prototype._decals = function (g, t) {
    var ctx = this.ctx;
    var left = g.camX - 80, right = g.camX + CFG.W + 80;
    // 检查点旗
    for (var q = 0; q < g.checkpoints.length; q++) {
      var cp = g.checkpoints[q];
      if (cp.x < left || cp.x > right) continue;
      this._flag(cp.x, this._cpY(g, cp.x), t + q, cp.passed);
    }
    // 金币 / 金香蕉
    for (var i = 0; i < g.pickups.length; i++) {
      var c = g.pickups[i];
      if (c.taken || c.x < left || c.x > right) continue;
      if (c.gold) this._goldBanana(c.x, c.y + Math.sin(t * 3 + c.t) * 5, t + c.t);
      else this._coin(c.x, c.y + Math.sin(t * 3 + c.t) * 4, t + c.t);
    }
    // 障碍
    for (var j = 0; j < g.obstacles.length; j++) {
      var o = g.obstacles[j];
      if (o.dead || o.x < left || o.x > right) continue;
      if (o.kind === 'bear') this._bear(o.x, o.y, t);
      else if (o.kind === 'piranha') this._piranha(o.x, o.y, t);
      else this._spike(o.x, o.y);
    }
    // 阵风区：斜向风线 + 起点风牌（看不见风就没法打，必须可视化）
    for (var wi = 0; wi < (g.winds || []).length; wi++) {
      var wnd = g.winds[wi];
      var wl = Math.max(wnd.x0, left), wr = Math.min(wnd.x1, right);
      if (wr <= wl) continue;
      var dirw = wnd.fx >= 0 ? 1 : -1;
      // 风线强度跟随阵风节律：停风时风线消失（和实际受力一致，不然玩家被画面骗）
      var gust = g._gustAt ? g._gustAt(wnd) : 1;
      if (gust <= 0.02) continue;
      ctx.save();
      ctx.globalAlpha = 0.12 + 0.26 * gust;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      for (var ln = 0; ln < 8; ln++) {
        var ly = 140 + ln * 42 + Math.sin(t * 2 + ln) * 6;
        var lx = wl + ((t * 260 * dirw + ln * 97) % (wr - wl) + (wr - wl)) % (wr - wl);
        var llen = 26 + (ln % 3) * 12;
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(lx + llen * dirw, ly + 4);
        ctx.stroke();
      }
      ctx.restore();
      // 风牌
      var signY = this._cpY(g, wnd.x0);
      ctx.save();
      ctx.translate(wnd.x0, signY);
      ctx.fillStyle = '#8a6d4f';
      ctx.fillRect(-2, -46, 4, 46);
      ctx.fillStyle = '#f5ecd7';
      roundRect(ctx, -20, -70, 40, 26, 5);
      ctx.fill();
      ctx.strokeStyle = '#8a6d4f';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.fillStyle = '#4a6fa5';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(dirw >= 0 ? '风→' : '←风', 0, -57);
      ctx.restore();
    }
    // 树 / 灌木
    for (var d = 0; d < g.decos.length; d++) {
      var e = g.decos[d];
      if (e.x < left || e.x > right) continue;
      if (e.kind === 'tree') this._tree(e.x, e.y, e.s);
      else this._bush(e.x, e.y, e.s);
    }
  };

  // 检查点旗面高度：找旗杆处的地面（没有就用地平线）
  Renderer.prototype._cpY = function (g, x) {
    var ps = g.platforms;
    for (var i = 0; i < ps.length; i++) {
      if (x >= ps[i].x && x <= ps[i].x + ps[i].w) return ps[i].y;
    }
    return CFG.GROUND_Y;
  };

  Renderer.prototype._flag = function (x, y, t, passed) {
    var ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    // 旗杆
    ctx.fillStyle = passed ? '#1864ab' : '#adb5bd';
    ctx.fillRect(-2, -66, 4, 66);
    // 旗面（飘动）
    var wave = Math.sin(t * 3) * 3;
    ctx.fillStyle = passed ? '#339af0' : '#ced4da';
    ctx.beginPath();
    ctx.moveTo(2, -64);
    ctx.quadraticCurveTo(20, -60 + wave, 38, -52);
    ctx.quadraticCurveTo(20, -50 + wave, 2, -42);
    ctx.closePath();
    ctx.fill();
    if (passed) {
      // 已打卡：旗面上画个勾
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(11, -54);
      ctx.lineTo(17, -47);
      ctx.lineTo(28, -59);
      ctx.stroke();
    }
    ctx.restore();
  };

  // 金香蕉：大一号 + 星星闪光，挂在跳跃顶点高度
  Renderer.prototype._goldBanana = function (x, y, t) {
    var ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(t * 2) * 0.12);
    ctx.fillStyle = '#f7b731';
    ctx.beginPath();
    ctx.moveTo(-13, 4);
    ctx.quadraticCurveTo(-16, -12, 0, -13);
    ctx.quadraticCurveTo(16, -12, 13, 4);
    ctx.quadraticCurveTo(0, 10, -13, 4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffd43b';
    ctx.beginPath();
    ctx.moveTo(-9, 3);
    ctx.quadraticCurveTo(-11, -9, 0, -10);
    ctx.quadraticCurveTo(11, -9, 9, 3);
    ctx.quadraticCurveTo(0, 8, -9, 3);
    ctx.closePath();
    ctx.fill();
    // 闪光
    var tw = (Math.sin(t * 4) + 1) / 2;
    ctx.globalAlpha = 0.35 + tw * 0.5;
    ctx.fillStyle = '#fff3bf';
    star(ctx, 0, -14, 5, 4.5, 1.8);
    ctx.fill();
    ctx.restore();
  };

  Renderer.prototype._coin = function (x, y, t) {
    var ctx = this.ctx;
    var sq = Math.abs(Math.cos(t * 2.2));
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(0.35 + sq * 0.65, 1);
    ctx.fillStyle = '#f7b731';
    circle(ctx, 0, 0, 13);
    ctx.fill();
    ctx.fillStyle = '#ffd93d';
    circle(ctx, 0, 0, 9.5);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#c98b19';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('¥', x, y + 0.5);
  };

  Renderer.prototype._bear = function (x, y, t) {
    var ctx = this.ctx;
    var bob = Math.sin(t * 2.4) * 1.2;
    ctx.save();
    ctx.translate(x, y + bob);
    ctx.fillStyle = '#8d6e63';
    circles(ctx, [-9, -22, 7, 9, -22, 7]);
    ctx.fill();
    ctx.fillStyle = '#a1887f';
    circle(ctx, 0, -14, 15);
    ctx.fill();
    ctx.fillStyle = '#4e342e';
    circles(ctx, [-5, -17, 2.2, 5, -17, 2.2]);
    ctx.fill();
    ctx.fillStyle = '#5d4037';
    circle(ctx, 0, -9, 3.4);
    ctx.fill();
    ctx.restore();
  };

  Renderer.prototype._piranha = function (x, y, t) {
    var ctx = this.ctx;
    var yy = y + 4 + Math.sin(t * 3) * 3;   // r15 实机：+26 会画到平台底下悬空，贴台面站
    ctx.save();
    ctx.translate(x, yy);
    ctx.fillStyle = '#ef5350';
    ctx.beginPath();
    if (ctx.ellipse) ctx.ellipse(0, 0, 17, 11, 0, 0, Math.PI * 2);
    else ctx.arc(0, 0, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c62828';
    ctx.beginPath();
    ctx.moveTo(-14, -2); ctx.lineTo(-24, -12); ctx.lineTo(-12, -9); ctx.fill();
    ctx.fillStyle = '#fff';
    circle(ctx, 6, -3, 3.6);
    ctx.fill();
    ctx.fillStyle = '#000';
    circle(ctx, 7, -3, 1.7);
    ctx.fill();
    ctx.restore();
  };

  Renderer.prototype._spike = function (x, y) {
    var ctx = this.ctx;
    ctx.fillStyle = '#b0bec5';
    for (var i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * 10 - 5, y);
      ctx.lineTo(x + i * 10, y - 15);
      ctx.lineTo(x + i * 10 + 5, y);
      ctx.closePath();
      ctx.fill();
    }
  };

  Renderer.prototype._tree = function (x, y, s) {
    var ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.fillStyle = '#8d6e63';
    ctx.fillRect(-3, -32, 6, 32);
    ctx.fillStyle = '#4caf50';
    circle(ctx, 0, -44, 17);
    ctx.fill();
    ctx.fillStyle = '#66bb6a';
    circle(ctx, -8, -40, 12);
    circle(ctx, 9, -42, 11);
    ctx.fill();
    ctx.restore();
  };

  Renderer.prototype._bush = function (x, y, s) {
    var ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.fillStyle = '#4caf50';
    circles(ctx, [-8, -6, 9, 8, -6, 9, 0, -11, 11]);
    ctx.fill();
    ctx.restore();
  };

  // r16 Verlet 软绳：8 节点质点链，每帧 verlet 积分 + 距离约束——
  // 松弛自然下垂、绷紧拉直、甩动有尾劲（原版绳子观感）。纯渲染层，不影响判定
  Renderer.prototype._rope = function (g, t) {
    var ctx = this.ctx;
    var a = g.monkeys[0], b = g.monkeys[1];
    var ax = a.x, ay = a.y + 8, bx = b.x, by = b.y + 8;   // r16b: 连在腰后，松弛绳不再绕过头顶堆圈
    var N = 8;   // r16b 修复：锚点替换时误删了这行，导致线上每帧 N is not defined
    if (!this._ropePts || this._ropePts.length !== N + 1) {
      this._ropePts = [];
      for (var i0 = 0; i0 <= N; i0++) {
        var u0 = i0 / N;
        var x0 = ax + (bx - ax) * u0, y0 = ay + (by - ay) * u0;
        this._ropePts.push({ x: x0, y: y0, px: x0, py: y0 });
      }
    }
    var pts = this._ropePts;
    var rest = g.ropeRest();
    var segLen = rest / N;
    // 猴被传送（回检查点/ respawn）时绳子直接重排，不横跨整屏甩
    var spanNow = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
    if (spanNow > rest * 4.5) {
      for (var r0 = 0; r0 <= N; r0++) {
        var u1 = r0 / N;
        pts[r0].x = pts[r0].px = ax + (bx - ax) * u1;
        pts[r0].y = pts[r0].py = ay + (by - ay) * u1;
      }
    }
    // verlet 步进：中间节点受重力下垂 + 阻尼
    for (var j = 1; j < N; j++) {
      var p2 = pts[j];
      var vx2 = (p2.x - p2.px) * 0.96, vy2 = (p2.y - p2.py) * 0.96;
      p2.px = p2.x; p2.py = p2.y;
      p2.x += vx2;
      p2.y += vy2 + 0.55;
    }
    pts[0].x = ax; pts[0].y = ay; pts[N].x = bx; pts[N].y = by;
    // 距离约束 3 轮：绳只能拉不能推，每段最多微拉伸 25%（软弹不钢丝）
    for (var it = 0; it < 3; it++) {
      for (var s2 = 0; s2 < N; s2++) {
        var pA = pts[s2], pB = pts[s2 + 1];
        var dx2 = pB.x - pA.x, dy2 = pB.y - pA.y;
        var dd2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
        if (dd2 <= segLen) continue;
        var diff = Math.min(dd2 - segLen, segLen * 0.25) / dd2;
        var wA = (s2 === 0) ? 0 : 0.5, wB = (s2 + 1 === N) ? 0 : 0.5;
        var wsum = wA + wB;
        if (wsum <= 0) continue;
        pA.x += dx2 * diff * (wA / wsum); pA.y += dy2 * diff * (wA / wsum);
        pB.x -= dx2 * diff * (wB / wsum); pB.y -= dy2 * diff * (wB / wsum);
      }
      pts[0].x = ax; pts[0].y = ay; pts[N].x = bx; pts[N].y = by;
    }
    // 张力可视化：两端距离 / 弹性上限 -> 越绷越细越红（沿用 r15 配色映射）
    var stretchT = Math.max(0, Math.min(1, spanNow / (rest * ((CFG.ROPE_STRETCH || 3.4) - 1))));
    // 平滑折线：过相邻中点的二次贝塞尔
    function strokePath() {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var k = 1; k < N; k++) {
        var mx = (pts[k].x + pts[k + 1].x) / 2, my = (pts[k].y + pts[k + 1].y) / 2;
        ctx.quadraticCurveTo(pts[k].x, pts[k].y, mx, my);
      }
      ctx.lineTo(pts[N].x, pts[N].y);
      ctx.stroke();
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = mixHex(COL.ropeDark, '#c92a2a', stretchT);
    ctx.lineWidth = 6.5 - stretchT * 2.2;
    strokePath();
    ctx.strokeStyle = stretchT > 0.04 ? mixHex(COL.rope, '#ff8787', stretchT) : COL.rope;
    ctx.lineWidth = Math.max(1.6, 4 - stretchT * 2);
    strokePath();
  };

  Renderer.prototype._progress = function (g) {
    var ctx = this.ctx;
    var M = CFG.MILESTONE || 500;
    var dist = g.distance || 0;
    var lv = Math.floor(dist / M) + 1;
    var frac = (dist % M) / M;
    var bw = 150, bh = 7, bx = (CFG.W - bw) / 2, by = 78;   // r15 实机：DOM HUD 约占画布顶部 70px，下移避让
    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    roundRect(ctx, bx - 6, by - 6, bw + 12, bh + 12, 9);
    ctx.fill();
    ctx.fillStyle = '#ffd43b';
    roundRect(ctx, bx, by, Math.max(bw * frac, 4), bh, 4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bx + bw - 1.5, by - 4, 3, bh + 8);
    ctx.beginPath();
    ctx.moveTo(bx + bw + 1.5, by - 4);
    ctx.lineTo(bx + bw + 12, by - 0.5);
    ctx.lineTo(bx + bw + 1.5, by + 3);
    ctx.closePath();
    ctx.fill();
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(60,40,20,0.55)';   // r16b: 白字压白云看不清，加深色描边
    ctx.strokeText('第 ' + lv + ' 关 · ' + dist + 'm', CFG.W / 2, by + bh + 17);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('第 ' + lv + ' 关 · ' + dist + 'm', CFG.W / 2, by + bh + 17);
    ctx.restore();
  };

  // 卡通小猴
  Renderer.prototype._monkeys = function (g, t, ui) {
    var names = (ui && ui.names) || null;
    for (var i = 0; i < 2; i++) {
      var m = g.monkeys[i];
      var isActive = g.active === i;
      var canOp = g.netMode ? (g.netMode === 'host' && g.seat === i && isActive) : isActive;

      // ---- 跳跃拖尾：空中采样历史位置，先画残影再画本体 ----
      var ctx = this.ctx;
      var tr = this.trail[i];
      if (!m.grounded && m.wetT <= 0) {
        tr.push({ x: m.x, y: m.y - 20, t: t });
        if (tr.length > 12) tr.shift();
      } else {
        if (tr.length) tr.length = 0;
      }
      for (var ti2 = 0; ti2 < tr.length - 1; ti2++) {
        var sm = tr[ti2];
        var age = t - sm.t;
        if (age > 0.26) continue;
        var al = 0.16 * (1 - age / 0.26);
        ctx.globalAlpha = al;
        ctx.fillStyle = i === 0 ? '#c68642' : '#d19a5e';
        circle(ctx, sm.x, sm.y, 9);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      this._monkey(m, t, {
        idx: i,
        active: isActive,
        canOp: canOp,
        charging: m.charging,
        charge: m.charging ? Math.min(1, m.chargeT / CFG.FLY_TIME) : 0,
        wet: m.wetT > 0,
        stun: m.stunT > 0,
        ghost: m.wetT < -1,
        opName: names ? names[i] + '的猴' : null
      }, ui);
    }
  };

  Renderer.prototype._monkey = function (m, t, st, ui) {
    var ctx = this.ctx;
    if (st.ghost) return;
    var body = st.idx === 0 ? '#c68642' : '#d19a5e';
    var face = '#f3d9b1';
    var sq = m.squash || 1;
    // 落水的猴子：半沉在水面，露出脑袋和爪子，别沉到看不见
    var sink = st.wet ? 12 : 0;
    var bob = m.grounded && !st.wet ? Math.sin(t * 5 + st.idx) * 1.4 : 0;
    var x = m.x, y = m.y + bob;

    ctx.save();
    ctx.translate(x, y - 20 + sink);
    ctx.scale(1 / sq, sq);

    // 影子
    if (m.grounded && !st.wet) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      if (ctx.ellipse) ctx.ellipse(0, 21, 15, 5, 0, 0, Math.PI * 2); else ctx.arc(0, 21, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 耳朵
    ctx.fillStyle = body;
    circles(ctx, [-15, -12, 7, 15, -12, 7]);
    ctx.fill();
    ctx.fillStyle = '#e8b98f';
    circles(ctx, [-15, -12, 4, 15, -12, 4]);
    ctx.fill();

    // 头（加一圈深棕描边，立绘感）
    ctx.fillStyle = body;
    circle(ctx, 0, -8, 17);
    ctx.fill();
    ctx.strokeStyle = '#6b4a2c';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 脸
    ctx.fillStyle = face;
    ctx.beginPath();
    if (ctx.ellipse) ctx.ellipse(0, -4, 12, 11, 0, 0, Math.PI * 2); else ctx.arc(0, -4, 11, 0, Math.PI * 2);
    ctx.fill();

    // 头发
    ctx.strokeStyle = '#6d4c33';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-3, -24); ctx.lineTo(-2, -30); ctx.lineTo(2, -26); ctx.lineTo(4, -31);
    ctx.stroke();

    // 眼睛（左右严格对称）。
    // 注意：circle() 内部会 beginPath()，连续调两次再 fill() 会把第一只眼睛的路径冲掉
    // —— 这就是之前"只剩一只右眼"的原因。必须每只眼睛单独 buildPath + fill。
    // ---- 微表情 ----
    // 眨眼节奏随机化：每只猴周期不同（3.1~4.5s），且每第 4 个周期改成"双连眨"
    var bc = 3.1 + ((st.idx * 0.77) % 1.4);
    var ph = m.blink % bc;
    var nth = Math.floor(m.blink / bc);
    var blinking = ph > bc - 0.14;
    if (nth % 4 === 3) {
      blinking = (ph > bc - 0.34 && ph < bc - 0.2) || ph > bc - 0.14;
    }
    // 蓄力时瞪大眼（专注），瞳孔和高光一起放大
    var er = st.charging ? 3.4 : 2.7;
    var hl = st.charging ? 1.25 : 0.95;
    ctx.fillStyle = COL.ink;
    if (st.stun) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = COL.ink;
      cross(ctx, -4.6, -8, 2.6); cross(ctx, 4.6, -8, 2.6);
    } else if (blinking) {
      ctx.fillRect(-7, -8.8, 4.6, 1.8);
      ctx.fillRect(2.4, -8.8, 4.6, 1.8);
    } else {
      [-4.6, 4.6].forEach(function (ex) {
        ctx.beginPath(); ctx.arc(ex, -8, er, 0, Math.PI * 2); ctx.fill();
      });
      ctx.fillStyle = '#fff';
      [-5.4, 3.8].forEach(function (ex) {
        ctx.beginPath(); ctx.arc(ex, -9, hl, 0, Math.PI * 2); ctx.fill();
      });
      if (st.charging) {
        // 蓄力挑眉：两道小弧线，"我憋足了劲"的表情
        ctx.strokeStyle = '#6b4a2c';
        ctx.lineWidth = 1.8;
        ctx.lineCap = 'round';
        [-4.6, 4.6].forEach(function (ex) {
          ctx.beginPath(); ctx.arc(ex, -12.6, 3.2, Math.PI, Math.PI * 2); ctx.stroke();
        });
      }
    }

    // 嘴
    ctx.strokeStyle = COL.ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    if (st.wet) { ctx.arc(0, 2, 3.4, 0, Math.PI * 2); }
    else if (st.charging) { ctx.arc(0, 0, 2.6, 0, Math.PI * 2); }
    else if (!m.grounded) { ctx.arc(0, -0.5, 2.8, 0, Math.PI * 2); }   // 空中：张嘴"哇"
    else { ctx.arc(0, -1, 4, 0.25 * Math.PI, 0.75 * Math.PI); }
    ctx.stroke();

    // 腮红
    ctx.fillStyle = 'rgba(255,138,128,0.45)';
    circles(ctx, [-10, 0, 3.2, 10, 0, 3.2]);
    ctx.fill();

    // 尾巴：身后翘起的卷尾（先画，垫在身体后面）
    ctx.strokeStyle = body;
    ctx.lineWidth = 4.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(7, 22);
    ctx.quadraticCurveTo(21, 26, 23, 14);
    ctx.quadraticCurveTo(24, 7, 18.5, 8);
    ctx.stroke();
    ctx.strokeStyle = '#6b4a2c';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // 身体（顶部受光的径向渐变 + 深棕描边）
    var hi = st.idx === 0 ? '#e2a866' : '#eec28a';
    var bgd = ctx.createRadialGradient(-3, 12, 3, 0, 18, 16);
    bgd.addColorStop(0, hi);
    bgd.addColorStop(1, body);
    ctx.fillStyle = bgd;
    ctx.beginPath();
    if (ctx.ellipse) ctx.ellipse(0, 18, 12, 13, 0, 0, Math.PI * 2); else ctx.arc(0, 18, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#6b4a2c';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 围巾：猴哥红 / 二猴蓝（联机一眼分清谁是谁）
    var scarf = st.idx === 0 ? '#e0524d' : '#4a90d9';
    ctx.fillStyle = scarf;
    roundRect(ctx, -8, 7, 16, 5.5, 2.5);
    ctx.fill();
    var flutter = Math.sin(t * 6 + st.idx * 2) * 2;
    ctx.beginPath();
    ctx.moveTo(-6, 8.5);
    ctx.lineTo(-14 - flutter, 11.5);
    ctx.lineTo(-12.5, 15);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = face;
    ctx.beginPath();
    if (ctx.ellipse) ctx.ellipse(0, 20, 7.5, 8, 0, 0, Math.PI * 2); else ctx.arc(0, 20, 7, 0, Math.PI * 2);
    ctx.fill();

    // 手臂（蓄力时举起）
    ctx.strokeStyle = body;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    var armUp = st.charging ? -1 : 0;
    ctx.beginPath();
    ctx.moveTo(-10, 14); ctx.lineTo(-15, 14 + armUp * 9);
    ctx.moveTo(10, 14); ctx.lineTo(15, 14 + armUp * 9);
    ctx.stroke();

    ctx.restore();

    // ------- 状态标记 -------
    var topY = m.y - 60;

    if (st.wet) {
      ctx.save();
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = '#1e88e5';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('救我！', m.x, m.y - 6);
      ctx.restore();
      // 气泡
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      circle(ctx, m.x - 16, m.y + 4, 3);
      circle(ctx, m.x - 22, m.y - 4, 2);
      ctx.fill();
    }

    // 玩家标签
    if (st.opName) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      var label = st.opName;
      var wl = label.length * 10 + 12;
      roundRect(ctx, m.x - wl / 2, topY - 30, wl, 15, 7);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, m.x, topY - 19);
    }

    // 箭头 / 蓄力条
    if (st.canOp) {
      var bounce = Math.sin(t * 6) * 3;
      ctx.fillStyle = '#ff7043';
      ctx.beginPath();
      ctx.moveTo(m.x, topY + 8 + bounce);
      ctx.lineTo(m.x - 9, topY - 6 + bounce);
      ctx.lineTo(m.x + 9, topY - 6 + bounce);
      ctx.closePath();
      ctx.fill();

      if (st.charging) {
        var bw = 46, bh = 7;
        var bx = m.x - bw / 2, by = topY + 14;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        roundRect(ctx, bx, by, bw, bh, 3.5);
        ctx.fill();
        var ratio = st.charge;   // r14：飞行燃料余量（1=刚起飞，0=油尽开始下落）
        ctx.fillStyle = ratio > 0.7 ? '#66bb6a' : (ratio > 0.3 ? '#ffb300' : '#ff5252');
        roundRect(ctx, bx + 1, by + 1, (bw - 2) * ratio, bh - 2, 2.5);
        ctx.fill();
      }
    }
  };

  Renderer.prototype._particles = function (g) {
    var ctx = this.ctx;
    for (var i = 0; i < g.particles.length; i++) {
      var p = g.particles[i];
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
      ctx.fillStyle = p.color;
      circle(ctx, p.x, p.y, p.r);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype._floats = function (g) {
    var ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.font = 'bold 15px sans-serif';
    for (var i = 0; i < g.floatTexts.length; i++) {
      var f = g.floatTexts[i];
      ctx.globalAlpha = Math.min(1, f.life);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#fff';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  };

  // ---------- 绘制工具 ----------
  function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }

  // 五角星路径（调用方负责 fill/stroke）
  function star(ctx, cx, cy, spikes, outerR, innerR) {
    var rot = -Math.PI / 2;
    var step = Math.PI / spikes;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
    for (var i = 0; i < spikes; i++) {
      rot += step;
      ctx.lineTo(cx + Math.cos(rot) * innerR, cy + Math.sin(rot) * innerR);
      rot += step;
      ctx.lineTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
    }
    ctx.closePath();
  }
  // 一次填充多个圆：每个圆各自 beginPath + fill，避免后一个 beginPath 把前一个路径冲掉
  function circles(ctx, list) {
    for (var i = 0; i < list.length; i += 3) {
      ctx.beginPath();
      ctx.arc(list[i], list[i + 1], list[i + 2], 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function cross(ctx, x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
    ctx.stroke();
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  Renderer.circle = circle;
  Renderer.roundRect = roundRect;
  root.GLHRender = Renderer;
  if (typeof module === 'object' && module.exports) module.exports = Renderer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
