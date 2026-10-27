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
    var sky = ctx.createLinearGradient ? ctx.createLinearGradient(0, 0, 0, H) : null;
    if (sky) {
      sky.addColorStop(0, TC.skyTop);
      sky.addColorStop(1, TC.skyBottom);
      ctx.fillStyle = sky;
    } else {
      ctx.fillStyle = TC.skyTop;
    }
    ctx.fillRect(0, 0, W, H);

    // 太阳（山顶档位被云遮住，画淡些）
    ctx.globalAlpha = ti >= 4 ? 0.35 : 1;
    ctx.fillStyle = COL.sun;
    circle(ctx, 300, 92, 34);
    ctx.globalAlpha = 0.25;
    circle(ctx, 300, 92, 48);
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
    this._aim(g, ui);

    ctx.restore();
    ctx.restore();
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
        // 弹跳蘑菇：红伞白点 + 白杆，一眼"踩我"
        ctx.fillStyle = '#f1e8d8';
        ctx.fillRect(p.x + p.w / 2 - 7, p.y - 12, 14, bottom - p.y);
        ctx.fillStyle = '#e0524d';
        ctx.beginPath();
        ctx.moveTo(p.x + 2, p.y);
        ctx.quadraticCurveTo(p.x + p.w / 2, p.y - 26, p.x + p.w - 2, p.y);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        circle(ctx, p.x + p.w * 0.32, p.y - 10, 3.4);
        ctx.fill();
        circle(ctx, p.x + p.w * 0.62, p.y - 14, 2.6);
        ctx.fill();
        circle(ctx, p.x + p.w * 0.5, p.y - 5, 2.2);
        ctx.fill();
        // 弹跳预兆：伞面呼吸
        ctx.globalAlpha = 0.35 + 0.2 * Math.sin(t * 5 + p.x);
        ctx.strokeStyle = '#ffd8d6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x + 2, p.y);
        ctx.quadraticCurveTo(p.x + p.w / 2, p.y - 26, p.x + p.w - 2, p.y);
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
        ctx.fillStyle = '#f1e8d8';
        ctx.fillRect(p.x + p.w / 2 - 7, p.y - 12, 14, bottom - p.y);
      } else if (p.type === 'float') {
        continue;   // 浮台悬空没有柱子
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
    var yy = y + 26 + Math.sin(t * 3) * 3;
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

  Renderer.prototype._rope = function (g, t) {
    var ctx = this.ctx;
    var a = g.monkeys[0], b = g.monkeys[1];
    var ax = a.x, ay = a.y - 26, bx = b.x, by = b.y - 26;
    var mx = (ax + bx) / 2, my = (ay + by) / 2;
    var sag = 16 + Math.sin(t * 3) * 2.5;
    var dx = bx - ax, dy = by - ay;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len;
    var taut = Math.max(0, len - g.ropeRest()) > 2;
    var wob = taut ? 0 : 1;
    var cxp = mx + nx * sag * wob, cyp = my + ny * sag * wob;

    ctx.strokeStyle = COL.ropeDark;
    ctx.lineWidth = taut ? 6.5 : 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(cxp, cyp, bx, by);
    ctx.stroke();
    // 绷紧（摆荡助力生效）时绳子提亮，给"借绳发力"一个视觉确认
    ctx.strokeStyle = taut ? '#ffe08a' : COL.rope;
    ctx.lineWidth = taut ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(cxp, cyp, bx, by);
    ctx.stroke();
  };

  // 卡通小猴
  Renderer.prototype._monkeys = function (g, t, ui) {
    var names = (ui && ui.names) || null;
    for (var i = 0; i < 2; i++) {
      var m = g.monkeys[i];
      var isActive = g.active === i;
      var canOp = g.netMode ? (g.netMode === 'host' && g.seat === i && isActive) : isActive;
      this._monkey(m, t, {
        idx: i,
        active: isActive,
        canOp: canOp,
        charging: m.charging,
        charge: m.charging ? Math.min(1, m.chargeT / (CFG.MAX_POWER_MS / 1000)) : 0,
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
    var blink = (m.blink % 3.4) > 3.25;
    ctx.fillStyle = COL.ink;
    if (st.stun) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = COL.ink;
      cross(ctx, -4.6, -8, 2.6); cross(ctx, 4.6, -8, 2.6);
    } else if (blink) {
      ctx.fillRect(-7, -8.8, 4.6, 1.8);
      ctx.fillRect(2.4, -8.8, 4.6, 1.8);
    } else {
      [-4.6, 4.6].forEach(function (ex) {
        ctx.beginPath(); ctx.arc(ex, -8, 2.7, 0, Math.PI * 2); ctx.fill();
      });
      ctx.fillStyle = '#fff';
      [-5.4, 3.8].forEach(function (ex) {
        ctx.beginPath(); ctx.arc(ex, -9, 0.95, 0, Math.PI * 2); ctx.fill();
      });
    }

    // 嘴
    ctx.strokeStyle = COL.ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    if (st.wet) { ctx.arc(0, 2, 3.4, 0, Math.PI * 2); }
    else if (st.charging) { ctx.arc(0, 0, 2.6, 0, Math.PI * 2); }
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
        var ratio = st.charge;
        ctx.fillStyle = ratio > 0.85 ? '#ff5252' : (ratio > 0.5 ? '#ffb300' : '#66bb6a');
        roundRect(ctx, bx + 1, by + 1, (bw - 2) * ratio, bh - 2, 2.5);
        ctx.fill();
      }
    }
  };

  Renderer.prototype._aim = function (g, ui) {
    if (!ui || !ui.aiming) return;
    var m = g.monkeys[g.active];
    if (!m || !m.charging) return;
    var ctx = this.ctx;
    var p = g.chargeRatio();
    var target = g.projectLanding(m.x, p, m.y);
    // 落点高度按真实平台算，别一律画在 GROUND_Y
    var plat = g.platformAt(target);
    var landY = plat ? plat.y : CFG.GROUND_Y;
    var hit = !!plat;

    // 目标平台上的"安全落点区间"：告诉玩家这一格该落在哪
    var here = g.platformAt(m.x);
    var edge = here ? here.x + here.w : m.x;
    var next = g.nextPlatform(edge);
    if (next) {
      var safeL = next.x + 6, safeR = next.x + next.w - 6;
      ctx.save();
      ctx.fillStyle = 'rgba(64,192,87,0.45)';
      roundRect(ctx, safeL, next.y - 12, safeR - safeL, 10, 5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    var dist = CFG.MIN_JUMP + p * CFG.JUMP_RANGE;
    var vx = dist * CFG.JUMP_VX, vy = -dist * CFG.JUMP_VY, gr = CFG.GRAVITY;
    ctx.save();
    // 采样到"落回平台/水面"为止。用 1/120s 数字积分（和 projectLanding/update 同一套物理），
    // 否则风区里瞄准线会"瞄 A 落 B"；落空时按水面再低 16px 算
    var missY = CFG.WATER_Y - 4;
    var targetDrop = m.y - (hit ? landY : missY);
    var sx0 = m.x, sy0 = m.y - 24, svx = vx, svy = vy;
    var pts = [[sx0, sy0]];
    var sdt = 1 / 120;
    for (var si = 0; si < 900; si++) {
      svx += (g._windAt ? g._windAt(sx0) : 0) * sdt;
      svx *= (1 - 0.25 * sdt);
      svy += gr * sdt;
      sx0 += svx * sdt;
      sy0 += svy * sdt;
      pts.push([sx0, sy0]);
      if (svy > 0 && sy0 - (m.y - 24) >= targetDrop) break;
    }
    function strokePath(color, w) {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      for (var j = 0; j < pts.length; j++) {
        if (j === 0) ctx.moveTo(pts[j][0], pts[j][1]); else ctx.lineTo(pts[j][0], pts[j][1]);
      }
      ctx.stroke();
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokePath('rgba(0,0,0,0.30)', 6);          // 外描边
    strokePath('rgba(0,0,0,0.55)', 3.2);        // 内芯
    if (ctx.setLineDash) ctx.setLineDash([6, 5]);
    strokePath(hit ? 'rgba(140,255,175,0.95)' : 'rgba(255,140,140,0.95)', 2.2);
    if (ctx.setLineDash) ctx.setLineDash([]);

    // 落点圈：命中绿 / 落水红，带白描边保证对比；不够远时给个文字提示
    ctx.beginPath();
    ctx.arc(target, landY - 3, 9, 0, Math.PI * 2);
    ctx.fillStyle = hit ? 'rgba(64,192,87,0.92)' : 'rgba(240,82,82,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    if (!hit) {
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      var tip = '再按久一点';
      var tw = ctx.measureText(tip).width;
      roundRect(ctx, target - tw / 2 - 7, landY - 34, tw + 14, 18, 9);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(tip, target, landY - 21);
    }
    ctx.restore();
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
