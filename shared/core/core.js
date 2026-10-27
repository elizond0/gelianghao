/**
 * 哥俩好 · 游戏内核（纯逻辑，无渲染 / 无平台 API）
 * 网页版与微信小程序共用同一份文件。
 *
 * 玩法：
 *  - 两只猴子被一根有弹性的绳子拴在一起，一前一后。
 *  - 有<箭头>的那只可起跳：按住蓄力，松手起跳，按得越久跳得越远（受绳子长度限制）。
 *  - 一只掉进坑里不会立刻输：另一只往前跳 / 站稳在岸上，就能把它从坑里"钓"上来。
 *  - 两只同时落水 -> 本局结束。
 */
(function (root, factory) {
  var core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  root.GLHCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CFG = {
    W: 375,
    H: 667,
    GROUND_Y: 470,
    GRAVITY: 1250,
    MIN_JUMP: 24,
    JUMP_RANGE: 150,      // 满蓄力相对最小跳多飞 150px：要覆盖后期最大 gap(185) - 平台半宽
    MAX_POWER_MS: 1100,   // 蓄力慢一点，落点更好拿捏
    ROPE_REST: 150,
    PATIENCE: 1.5,
    CAM_LERP: 0.12,
    // ---- 面包和年糕式丰富（均不增加按键，仍只靠长按跳跃）----
    CP_SPACING: 260,      // 检查点旗间距（世界 px）
    PERFECT_RATIO: 0.16,  // 落点距平台中心 < 宽*此值 算完美着陆
    PERFECT_BONUS: 15,    // 完美着陆基础分
    COMBO_BONUS: 15,      // 连击 >=3 时每跳追加
    GOLD_CHANCE: 0.13,    // 金香蕉生成概率（挂在跳跃顶点高度，要跳起来才吃得到）
    GOLD_BONUS: 50,
    SWING_LIFT: 2.6,      // 绳子绷紧且下方那只下落时，把它往上悠的加速度系数
    MAX_FALLS_PER_CP: 3,  // 同一检查点连续坠落 3 次 -> 判定卡关，结算（防焊死）
    BOTH_WET_DELAY: 0.9   // 双落水后停顿这么久再回检查点/结算（给"完蛋感"留表演时间）
  };

  var LEVELS = [
    { until: 900,  gapMin: 55,  gapMax: 105, platMin: 80,  platMax: 128, obs: 0,    spike: false, ice: false },
    { until: 2000, gapMin: 70,  gapMax: 130, platMin: 70,  platMax: 118, obs: 0.35, spike: false, ice: false },
    { until: 3400, gapMin: 85,  gapMax: 155, platMin: 64,  platMax: 108, obs: 0.55, spike: true,  ice: false },
    { until: 5200, gapMin: 90,  gapMax: 152, platMin: 58,  platMax: 100, obs: 0.7,  spike: true,  ice: true  },
    { until: 1e9,  gapMin: 95,  gapMax: 162, platMin: 54,  platMax: 96,  obs: 0.85, spike: true,  ice: true  }
  ];

  // 抛射参数：水平 vx 决定落点，竖直 vy 决定弧高（蓄力越大跳得越高）
  CFG.JUMP_VX = 2.6;
  CFG.JUMP_VY = 3.1;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function levelAt(x) {
    for (var i = 0; i < LEVELS.length; i++) if (x < LEVELS[i].until) return LEVELS[i];
    return LEVELS[LEVELS.length - 1];
  }

  function Monkey(idx) {
    this.idx = idx;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.grounded = true;
    this.charging = false;
    this.chargeT = 0;
    this.power = 0;
    this.squash = 1;
    this.wetT = 0;
    this.stunT = 0;
    this.hasJumped = false;   // 本局是否真正起跳过（开局不换人用）
    this.progressX = 0;       // 它自己已经推进到的最远落点：落后的一方一定推进得少
    this.blink = Math.random() * 3;
  }

  function Game(opts) {
    opts = opts || {};
    this.seed = opts.seed || 1;
    this.onEvent = opts.onEvent || function () {};
    this.reset();
  }

  Game.prototype.emit = function (type, data) { this.onEvent(type, data || {}); };

  Game.prototype.reset = function () {
    this.netMode = null;
    this.seat = 0;
    this.rng = mulberry32(this.seed);
    this.time = 0;
    this.state = 'ready';
    this.distance = 0;
    this.maxX = 0;
    this.coins = 0;
    this.rescues = 0;
    this.score = 0;
    // 面包和年糕式新状态
    this.checkpoints = [];    // [{x, passed}] 位置由种子决定，两端一致
    this._nextCPX = 200 + CFG.CP_SPACING;
    this._lastCPIdx = -1;     // 最后越过的检查点下标
    this.falls = 0;           // 累计回检查点次数
    this.fallsSinceCP = 0;    // 当前检查点上已坠落几次（防卡关）
    this.combo = 0;           // 当前完美连击
    this.bestCombo = 0;
    this.perfects = 0;
    this.golds = 0;
    this.bonus = 0;           // 完美/金香蕉累加分
    this._bothWetT = 0;       // 双落水计时
    this.camX = -100;
    this.shake = 0;
    this.platforms = [];
    this.obstacles = [];
    this.pickups = [];
    this.decos = [];
    this.particles = [];
    this.floatTexts = [];

    // 起始平台：右边留出足够"助跑距离"，否则两只猴满蓄力都够不着下一块地
    this.platforms.push({ x: -260, w: 470, y: CFG.GROUND_Y, type: 'start' });
    this._genUntil(1600);

    this.monkeys = [new Monkey(0), new Monkey(1)];
    this.monkeys[0].x = 200;
    this.monkeys[1].x = 148;
    this.monkeys[0].y = this.monkeys[1].y = CFG.GROUND_Y;
    this.monkeys[0].progressX = this.monkeys[0].x;
    this.monkeys[1].progressX = this.monkeys[1].x;
    this.active = 1;
    this._lastSwitch = -1;
    this._autoSince = 0;
    this._lastCmdSeq = 0;
    this.netMode = null;
    this.seat = 0;
    this.cmdQueue = [];
    this.state = 'ready';
    this.begun = false;
  };

  Game.prototype.start = function () {
    this.state = 'playing';
    this.begun = true;
    if (this.netMode) {
      // 联机：开局先轮到房主，避免"第一个人没事干"
      this.active = this.seat;
      this.emit('switch', { idx: this.active });
    }
    this.emit('start');
  };

  // 真正开跳了没有（联机里用来区分"开房等好友"和"正在玩"）
  Game.prototype.hasBegun = function () {
    return this.state === 'playing' || this.state === 'over';
  };

  Game.prototype.setActive = function (i, silent) {
    if (this.active === i) return false;
    this.active = i;
    if (!silent) this.emit('switch', { idx: i });
    return true;
  };

  // ---------- 地形生成 ----------
  Game.prototype._genUntil = function (targetX) {
    var last = this.platforms[this.platforms.length - 1];
    var guard = 0;
    while (last.x + last.w < targetX && guard++ < 200) {
      var L = levelAt(last.x + last.w);
      var r = this.rng;
      var gap = Math.round(lerp(L.gapMin, L.gapMax, r()));
      var pw = Math.round(lerp(L.platMin, L.platMax, r()));
      var y = CFG.GROUND_Y + Math.round((r() * 2 - 1) * 10);
      var p = { x: last.x + last.w + gap, w: pw, y: y, type: 'normal' };
      if (L.ice && r() < 0.22) p.type = 'ice';

      if (r() < L.obs && pw > 86) {
        this.obstacles.push({
          kind: r() < 0.55 ? 'bear' : 'piranha',
          x: Math.round(p.x + pw * (0.4 + r() * 0.25)),
          y: y, w: 26, h: 26, dead: false
        });
      }
      if (L.spike && r() < 0.28 && pw > 80) {
        this.obstacles.push({ kind: 'spike', x: Math.round(p.x + pw * 0.55), y: y, w: 22, h: 12, dead: false });
      }
      if (r() < 0.7 && pw > 84) this.pickups.push({ x: Math.round(p.x + pw * 0.5), y: y - 48, taken: false, t: r() * 6 });
      if (r() < 0.45) this.pickups.push({ x: Math.round(p.x + pw * 0.78), y: y - 82, taken: false, t: r() * 6 });
      // 金香蕉：稀有，挂在跳跃顶点附近的高度——必须跳起来才吃得到（风险回报）
      if (r() < CFG.GOLD_CHANCE && pw > 90) {
        this.pickups.push({ x: Math.round(p.x + pw * 0.5), y: y - 104, taken: false, t: r() * 6, gold: true });
      }
      // 检查点旗：间距 CP_SPACING，挂在"够到目标点的第一块够宽平台"上。
      // 旗面 x 吸附到平台内（留 20px 边距），不掉坑里、不挂墙外。
      // 早先要求平台正好盖住固定网格点，目标点一落进坑/窄台这面旗就永久刷不出，
      // 且 _nextCPX 不前进会把后面所有旗一起堵死（整局无存档点），已修正。
      if (this._nextCPX >= 0 && p.x + p.w >= this._nextCPX && pw >= 64) {
        var flagX = clamp(Math.round(this._nextCPX), p.x + 20, p.x + p.w - 20);
        this.checkpoints.push({ x: flagX, passed: false });
        this._nextCPX += CFG.CP_SPACING;
      }

      for (var d = 0; d < 2; d++) {
        this.decos.push({ x: Math.round(p.x + r() * pw), y: y, kind: r() < 0.5 ? 'tree' : 'bush', s: 0.7 + r() * 0.6 });
      }
      this.platforms.push(p);
      last = p;
    }
    var cut = this.camX - 700;
    if (this.platforms.length > 10) {
      this.platforms = this.platforms.filter(function (p) { return p.x + p.w > cut; });
      this.obstacles = this.obstacles.filter(function (o) { return o.x > cut; });
      this.pickups = this.pickups.filter(function (o) { return o.x > cut; });
      this.decos = this.decos.filter(function (o) { return o.x > cut; });
    }
  };

  Game.prototype.platformAt = function (x) {
    var ps = this.platforms;
    for (var i = ps.length - 1; i >= 0; i--) {
      if (x >= ps[i].x && x <= ps[i].x + ps[i].w) return ps[i];
    }
    return null;
  };

  Game.prototype.nextPlatform = function (x) {
    var best = null;
    for (var i = 0; i < this.platforms.length; i++) {
      var p = this.platforms[i];
      if (p.x > x && (!best || p.x < best.x)) best = p;
    }
    return best;
  };

  Game.prototype._surfaceNear = function (x, fallbackY) {
    var best = null, bd = 1e9;
    for (var i = 0; i < this.platforms.length; i++) {
      var p = this.platforms[i];
      var d = x < p.x ? p.x - x : (x > p.x + p.w ? x - (p.x + p.w) : 0);
      if (d < bd) { bd = d; best = p; }
    }
    return best ? best.y : fallbackY;
  };

  Game.prototype.ropeRest = function () {
    return CFG.ROPE_REST + Math.min(36, this.distance * 0.02);
  };

  // ---------- 输入 ----------
  Game.prototype.canIOperate = function () {
    if (!this.netMode) return true;
    // 联机时：轮到我这只（seat 对应）就可以起跳；主机负责执行、客人负责把操作发上去
    return this.seat === this.active;
  };

  Game.prototype.pressStart = function () {
    if (this.state === 'ready') { this.start(); return; }
    if (this.state !== 'playing') return;
    if (!this.canIOperate()) return;
    var m = this.monkeys[this.active];
    if (!m.grounded || m.stunT > 0 || m.wetT > 0) return;
    m.charging = true;
    m.chargeT = 0;
    this.lastOpOut = { t: 'down', m: m.idx };
  };

  Game.prototype.pressEnd = function () {
    if (this.state === 'ready') { this.start(); return; }
    if (this.state !== 'playing') return;
    if (!this.canIOperate()) return;
    var m = this.monkeys[this.active];
    if (!m.charging) return;
    m.charging = false;
    this._launch(m, m.chargeT / (CFG.MAX_POWER_MS / 1000));
    this.lastOpOut = { t: 'up', m: this.active, p: m.power };
    this.emit('jump', { idx: m.idx, power: m.power, from: m.x });
  };

  Game.prototype._launch = function (m, t) {
    t = clamp(t, 0, 1);
    m.power = t;
    var dist = CFG.MIN_JUMP + t * CFG.JUMP_RANGE;
    m.vx = dist * CFG.JUMP_VX;
    m.vy = -dist * CFG.JUMP_VY;
    m.grounded = false;
    m.squash = 0.78;
    m.hasJumped = true;
    this.active = m.idx;
    this._lastSwitch = this.time;
  };

  Game.prototype.chargeFor = function (dist) {
    return clamp((dist - CFG.MIN_JUMP) / CFG.JUMP_RANGE, 0, 1) * CFG.MAX_POWER_MS / 1000;
  };

  // 落点预测：和 update() 里的物理保持一致（含水平空气阻尼），否则瞄准线会骗人
  // 水平：vx(t) = vx0 * e^(-DRAG*t)  →  x(t) = x0 + vx0 * (1 - e^(-DRAG*t)) / DRAG
  // 竖直：y(t) = y0 + vy0*t + 0.5*G*t^2（无阻尼）
  var DRAG = 0.25;
  Game.prototype.projectLanding = function (fromX, power, fromY) {
    var dist = CFG.MIN_JUMP + clamp(power, 0, 1) * CFG.JUMP_RANGE;
    var vx = dist * CFG.JUMP_VX, vy = -dist * CFG.JUMP_VY;
    var drop = Math.max(0, (fromY || CFG.GROUND_Y) - CFG.GROUND_Y);
    var t = (-vy + Math.sqrt(vy * vy + 2 * CFG.GRAVITY * drop)) / CFG.GRAVITY;
    var travel = vx * (1 - Math.exp(-DRAG * t)) / DRAG;
    return fromX + travel;
  };

  Game.prototype.chargeRatio = function () {
    var m = this.monkeys[this.active];
    if (!m || !m.charging) return 0;
    return clamp(m.chargeT / (CFG.MAX_POWER_MS / 1000), 0, 1);
  };

  // ---------- 主循环 ----------
  Game.prototype.update = function (dt) {
    if (this.state === 'ready' || this.state === 'paused') { this._ambient(dt); return; }
    if (this.state === 'over') { this._fx(dt); return; }

    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    var ms = this.monkeys;

    for (var i = 0; i < 2; i++) {
      var m = ms[i];
      if (m.charging) { m.chargeT += dt; m.squash = 1 - clamp(m.chargeT / 0.9, 0, 1) * 0.24; }
      if (m.stunT > 0) m.stunT -= dt;
      if (m.wetT > 0) m.wetT -= dt;
      m.blink += dt;

      if (!m.grounded && m.wetT <= 0) {
        m.vy += CFG.GRAVITY * dt;
        var prevX = m.x, prevY = m.y;
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        if (m.vy > 0) {
          var hit = this._crossedSurface(prevX, prevY, m.x, m.y);
          if (hit) this._land(m, hit);
          else if (!this.platformAt(m.x) && m.y > CFG.GROUND_Y + 14) this._wet(m);
        }
        if (!m.grounded) m.vx *= (1 - 0.25 * dt);
      }
    }

    this._rope(dt);
    this._obstacles();
    this._pickups(dt);

    var lead = Math.max(ms[0].x, ms[1].x);
    if (lead > this.maxX) {
      this.maxX = lead;
      this.distance = Math.max(0, Math.floor((this.maxX - 200) / 2.2));
    }
    this.score = this.distance + this.coins * 10 + this.rescues * 30 + this.bonus;

    this._updateCamera(CFG.CAM_LERP);

    if (this.netMode) {
      this._net();
      this._rescueStalledTurn();   // 好友掉线/卡住时，别让整局停住
    }
    this._autoSwitch();     // 单人/联机都跑，保证接力轮换节奏一致（联机端由房主权威决定）

    this._genUntil(this.camX + CFG.W * 2);
    this._ambient(dt);
    this._fx(dt);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 3);

    // 双落水不再一掉到底：给 0.9s 表演时间，然后回检查点或结算
    var bothWet = ms[0].wetT > 0 && ms[1].wetT > 0;
    if (bothWet) {
      this._bothWetT += dt;
      if (this._bothWetT >= CFG.BOTH_WET_DELAY) this._onBothWet();
    } else if (this._bothWetT > 0) {
      this._bothWetT = 0;
    }

    // 检查点打卡：最远到达越过旗面就算
    for (var ci = 0; ci < this.checkpoints.length; ci++) {
      var cp = this.checkpoints[ci];
      if (cp.passed || this.maxX < cp.x) continue;
      cp.passed = true;
      this._lastCPIdx = ci;
      this.fallsSinceCP = 0;
      var cpy = this._surfaceNear(cp.x, CFG.GROUND_Y);
      this._float(cp.x, cpy - 100, '检查点！', '#1864ab');
      this._burst(cp.x, cpy - 56, 10, '#74c0fc');
      this.emit('checkpoint', { x: cp.x });
    }
  };

  Game.prototype._crossedSurface = function (x0, y0, x1, y1) {
    for (var i = 0; i < this.platforms.length; i++) {
      var p = this.platforms[i];
      if (y0 <= p.y + 1.5 && y1 >= p.y) {
        var xa = Math.min(x0, x1), xb = Math.max(x0, x1);
        if (xb >= p.x && xa <= p.x + p.w) return p;
      }
    }
    return null;
  };

  // 换人规则（单人/联机共用，保证"接力"节奏一致）：
  // 目标：两只像接力一样轮流往前挪，落后的那只优先被"带上来"，且绝不来回横跳。
  // 1) 当班猴落水/晕住 + 另一只稳稳站岸 → 立刻换人去救
  // 2) 这一棒还没落地 / 还没起跳过 → 保持，等它跳完
  // 3) 跳完落地 → 交给"落后的那只"。这正是"a 跳 5 步、b 才 1 步"要的结果：
  //    b 落后就轮到 b，b 连续追几棒；等 b 追上 a 了才会轮到 a
  // 4) 每次交棒后至少停留 SWITCH_HOLD 秒，杜绝同帧 A→B→A 的横跳
  // 5) 两只都动不了（都够不着下一块）超过 STUCK_T 秒 → 强制换手兜底
  var SWITCH_HOLD = 0.5;
  var STUCK_T = 1.5;
  Game.prototype._autoSwitch = function () {
    if (!this.begun) return;
    if (this.time - this._lastSwitch < SWITCH_HOLD) return;

    var cur = this.monkeys[this.active];
    var other = this.monkeys[1 - this.active];
    var otherReady = other.grounded && other.stunT <= 0 && other.wetT <= 0;
    var curBad = cur.wetT > 0 || cur.stunT > 0 || !cur.grounded;

    // ① 落水/被晕：换另一只来救
    if (curBad) {
      if (otherReady) { this._lastSwitch = this.time; this.setActive(1 - this.active); }
      return;
    }
    // ② 还没起跳过（刚开局），或这一棒还在空中 → 保持
    if (!cur.hasJumped) return;
    if (!otherReady) return;

    // ③ 这一棒跳完了吗？（progressX = 它站稳到过的最远处，落地时才更新）
    if (cur.progressX < cur.x - 0.5) return;

    // ④ 交棒：永远交给"推进得少的那只"。
    //    对方落后 → 轮到它追；对方已经追上/超车 → 说明它更需要支援，也一样交给它。
    var otherBehind = other.progressX < cur.progressX - 1;
    if (otherBehind) {
      this._lastSwitch = this.time;
      this.setActive(1 - this.active);
      this._autoSince = 0;
      return;
    }

    // ⑤ 对方不落后（通常是自己刚被手动跳过）：自己继续跳，但要留一个兜底，
    //    两只都够不着下一块地时别把局面焊死
    if (this._canHop(cur) || this._canHop(other)) { this._autoSince = 0; return; }
    this._autoSince += 0.016;
    if (this._autoSince > STUCK_T) {
      this._lastSwitch = this.time;
      this.setActive(1 - this.active);
      this._autoSince = 0;
    }
  };

  /**
   * 好友掉线兜底：轮到好友的猴子、但对面一直没动作超过 2 秒，
   * 就把操作权交回本端，别让整局卡死。
   * 由房主（权威端）每帧调用。
   */
  Game.prototype._rescueStalledTurn = function () {
    if (!this.netMode || this.state !== 'playing') return;
    if (this.active === this.seat) { this._idleSince = -1; return; }
    var cur = this.monkeys[this.active];
    if (!cur.grounded || cur.charging) { this._idleSince = -1; return; }
    if (this._idleSince === undefined || this._idleSince < 0) this._idleSince = this.time;
    if (this.time - this._idleSince > 2.0) {
      this._idleSince = -1;
      this.active = this.seat;
      this._lastSwitch = this.time;
      this.emit('switch', { idx: this.active, stall: true });
    }
  };

  /**
   * 相机：把两只猴都框在画面里，视野中心略偏向领跑的那只。
   * 房主每帧调用；客人端收到快照后也调用，保证两边构图一致。
   */
  Game.prototype._updateCamera = function (k) {
    var ms = this.monkeys;
    var lo = Math.min(ms[0].x, ms[1].x), hi = Math.max(ms[0].x, ms[1].x);

    // 蓄力瞄准时，把"按当前力度会落到哪"算进取景范围，否则瞄准线和落点圈会跑到屏幕外。
    // 只往后看到"当前力度落点 + 一点余量"，力度越大视野越远，角色不会被挤到边上。
    var aimRight = hi;
    var acting = ms[this.active];
    if (acting && acting.charging) {
      var pw = clamp(acting.chargeT / (CFG.MAX_POWER_MS / 1000), 0, 1);
      var reach = this.projectLanding(acting.x, pw, acting.y) + 40;
      if (reach > aimRight) aimRight = reach;
    }

    var mid = lo + (aimRight - lo) * 0.62;
    this.camX = lerp(this.camX, mid - CFG.W / 2, k == null ? CFG.CAM_LERP : k);

    // 安全区：屏幕左缘 = camX，右缘 = camX + W
    // 要求 lo - camX >= pad 且 camX + W - aimRight >= pad
    var pad = 46;
    var cMin = aimRight + pad - CFG.W, cMax = lo - pad;
    if (cMin <= cMax) this.camX = clamp(this.camX, cMin, cMax);
    else this.camX = lerp(this.camX, (lo + aimRight) / 2 - CFG.W / 2, (k == null ? CFG.CAM_LERP : k));
  };

  // 这只猴原地满蓄力起跳，能不能摸到下一块平台
  Game.prototype._canHop = function (m) {
    if (!m.grounded) return false;
    var p = this.platformAt(m.x);
    var edge = p ? p.x + p.w : m.x;
    var q = this.nextPlatform(edge);
    if (!q) return false;
    // 用"满蓄力的真实落点"判断，而不是平台左缘距离（落点会超过平台左缘很多）
    // 注意：绳子只在"两只都在空中"时才互相牵扯，另一只站在地上不会缩短这一跳，不用修正
    var land = this.projectLanding(m.x, 1, m.y);
    return land >= q.x - 4;
  };

  Game.prototype._land = function (m, plat) {
    m.y = plat.y;
    m.vy = 0;
    m.vx = 0;
    m.grounded = true;
    m.squash = 1.18;
    // 记录"站稳过的最远位置"：换人时用它判断谁落后、这一棒是否已经跳完
    if (m.progressX < m.x) m.progressX = m.x;
    this._burst(m.x, plat.y, 5, plat.type === 'ice' ? '#bdf1ff' : '#d8e3a8');
    // 完美着陆：落在平台正中央 -> 连击加分（蓄力精准度的回报，不新增按键）
    var center = plat.x + plat.w / 2;
    if (plat.type !== 'start' && Math.abs(m.x - center) < plat.w * CFG.PERFECT_RATIO) {
      this.combo++;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      this.perfects++;
      var add = CFG.PERFECT_BONUS + (this.combo >= 3 ? CFG.COMBO_BONUS : 0);
      this.bonus += add;
      this._float(m.x, plat.y - 88,
        this.combo >= 3 ? '火热 x' + this.combo + '！+' + add : '完美！+' + add,
        this.combo >= 3 ? '#e8590c' : '#2f9e44');
      this._burst(m.x, plat.y - 6, 9, '#ffd43b');
      this.emit('perfect', { idx: m.idx, combo: this.combo, add: add });
    } else if (plat.type !== 'start') {
      this.combo = 0;
    }
    this.emit('land', { idx: m.idx, x: m.x, y: plat.y });
  };

  Game.prototype._wet = function (m) {
    m.y = CFG.GROUND_Y + 14;
    m.vx = 0; m.vy = 0;
    m.grounded = false;
    m.wetT = CFG.PATIENCE;
    this.combo = 0;
    m.squash = 0.7;
    this.shake = 0.6;
    this._burst(m.x, CFG.GROUND_Y + 2, 10, '#7fd4ff');
    this.emit('wet', { idx: m.idx });
  };

  // ---------- 绳子：哥俩好的灵魂 ----------
  Game.prototype._rope = function (dt) {
    var ms = this.monkeys, a = ms[0], b = ms[1];
    var dx = b.x - a.x, dy = b.y - a.y;
    var d = Math.sqrt(dx * dx + dy * dy) || 0.001;
    var rest = this.ropeRest();
    var over = d - rest;

    // 两端都在空中：绳子绷紧互相牵扯。
    // 这里直接把位置往回拽 25% 是"瞬移"，会把抛物线打乱、玩家按同样久却跳到别处；
    // 改成作用在速度上（限幅），手感更可预测。
    if (!a.grounded && !b.grounded && a.wetT <= 0 && b.wetT <= 0 && over > 0) {
      var nx = dx / d, ny = dy / d;
      var pull = Math.min(over * 6, 260) * dt;
      a.vx += nx * pull; a.vy += ny * pull;
      b.vx -= nx * pull; b.vy -= ny * pull;

      // 摆荡助力（面包和年糕的"悠起来"）：绳子绷紧、下面那只正在下落时，
      // 像秋千一样把它往上悠一把，并顺着前进方向往前送——制造"借绳发力"的手感。
      // 水平推力与绳回拽反向，用途是"抵消回拽、把跳距送出去"，不是加速器；
      // 只加在速度上、幅度受限，不破坏"按多久跳多远"的可预测性。
      // 注意：水平推力恒为 +x（前进方向）。早先按"远离锚点"给方向，
      // 后排猴下落时会被往后推，与"接力前进"的玩法相悖，已修正。
      var lower = a.y >= b.y ? a : b;
      if (lower.vy > 0 && over > 6) {
        lower.vy -= Math.min(over * CFG.SWING_LIFT, 110) * dt;
        lower.vx += Math.min(over * 1.2, 110) * dt;
      }
    }

    for (var i = 0; i < 2; i++) {
      var m = ms[i];
      if (m.wetT <= 0) continue;
      var other = ms[1 - i];

      if (other.grounded) {
        // 伙伴站稳在岸上 -> 绳子把落水的这只往回、往上"钓"
        var k = Math.min(1, dt * 4.5);
        var pHome = this.platformAt(other.x);
        var baseY = pHome ? pHome.y : other.y;
        var inward = other.x > m.x ? -1 : 1;
        var tx = other.x + inward * Math.min(rest * 0.72, 108);
        var ty = this._surfaceNear(tx, baseY) - 34;
        m.x = lerp(m.x, tx, k);
        m.y = lerp(m.y, ty, k);

        var pHere = this.platformAt(m.x);
        if (pHere && m.y >= pHere.y - 40) { this._rescued(m, pHere); continue; }
      } else if (other.y < m.y - 24) {
        // 伙伴正往前上方跃过 -> 把他带一带
        m.x = lerp(m.x, other.x - rest * 0.35, Math.min(1, dt * 2.4));
        m.y = lerp(m.y, other.y, Math.min(1, dt * 1.6));
        var p2 = this.platformAt(m.x);
        if (p2 && m.y >= p2.y - 40) { this._rescued(m, p2); continue; }
      }

      if (m.wetT <= 0) {
        m.y += 160 * dt;
        if (m.y > CFG.H + 260) m.wetT = -1;
      }
    }
  };

  Game.prototype._rescued = function (m, p) {
    m.y = p.y;
    m.vy = 0; m.vx = 0;
    m.grounded = true;
    m.wetT = 0;
    m.squash = 1.28;
    if (m.progressX < m.x) m.progressX = m.x;
    this.rescues++;
    this._float(m.x, p.y - 78, '哥俩好！+30', '#2f9e44');
    this._burst(m.x, p.y - 18, 12, '#69db7c');
    this.emit('rescue', { idx: m.idx });
  };

  Game.prototype._obstacles = function () {
    var ms = this.monkeys;
    for (var i = 0; i < this.obstacles.length; i++) {
      var o = this.obstacles[i];
      if (o.dead) continue;
      for (var j = 0; j < 2; j++) {
        var m = ms[j];
        if (!m.grounded || m.wetT > 0 || m.stunT > 0) continue;
        if (Math.abs(m.x - o.x) < o.w * 0.85 && Math.abs(m.y - o.y) < o.h + 16) {
          m.x = o.x - (m.x >= o.x ? 1 : -1) * (o.w * 1.0);
          m.stunT = 0.55;
          m.squash = 0.8;
          this.combo = 0;
          o.dead = true;
          this.shake = 0.8;
          this._burst(o.x, o.y - 12, 8, '#ff6b6b');
          this._float(o.x, o.y - 56, o.kind === 'spike' ? '扎到啦！' : '小心！', '#e03131');
          this.emit('hit', { idx: j, kind: o.kind });
          var p = this.platformAt(m.x);
          if (p) { m.y = p.y; m.grounded = true; } else this._wet(m);
          break;
        }
      }
    }
  };

  Game.prototype._pickups = function (dt) {
    for (var i = 0; i < this.pickups.length; i++) {
      var c = this.pickups[i];
      if (c.taken) continue;
      c.t += dt;
      for (var j = 0; j < 2; j++) {
        var m = this.monkeys[j];
        // 不要求 grounded：高处的香蕉/金香蕉本来就设计成"跳起来擦到边才算吃到"
        // （早先限定 grounded 导致 -82/-104 高度的道具永远够不着，已修复）。
        // 但掉水里的不算——它正在被绳子往上钓，别让它顺手捡币。
        if (m.wetT > 0) continue;
        var reachY = c.gold ? 66 : 44;   // 金香蕉挂得高，判定框放宽
        if (Math.abs(m.x - c.x) < 24 && Math.abs((m.y - 30) - c.y) < reachY) {
          c.taken = true;
          if (c.gold) {
            this.golds++;
            this.bonus += CFG.GOLD_BONUS;
            this._burst(c.x, c.y, 14, '#ffd43b');
            this._float(c.x, c.y - 30, '金香蕉 +' + CFG.GOLD_BONUS, '#f08c00');
            this.emit('gold', { n: this.golds });
          } else {
            this.coins++;
            this._burst(c.x, c.y, 7, '#ffd43b');
            this._float(c.x, c.y - 18, '+10', '#f08c00');
            this.emit('coin', { n: this.coins });
          }
          break;
        }
      }
    }
  };

  Game.prototype._gameOver = function (reason) {
    if (this.state === 'over') return;
    this.state = 'over';
    this.emit('gameover', {
      score: this.score, distance: this.distance,
      coins: this.coins, rescues: this.rescues,
      falls: this.falls, bestCombo: this.bestCombo,
      perfects: this.perfects, golds: this.golds,
      reason: reason || 'both-wet'
    });
  };

  /**
   * 双落水总入口（面包和年糕式检查点续跳）：
   *  - 已越过检查点、且没在同一检查点连续摔 MAX_FALLS_PER_CP 次 -> 回检查点继续
   *  - 还没走到任何一个检查点就双落 -> 直接结算（开局不给兜底）
   *  - 同一检查点连摔 3 次 -> 判定卡关，结算（防止被地形焊死）
   */
  Game.prototype._onBothWet = function () {
    if (this.state !== 'playing') return;
    var cp = this.checkpoints[this._lastCPIdx];
    if (cp && cp.passed && this.fallsSinceCP < CFG.MAX_FALLS_PER_CP) {
      this._respawnAt(cp);
    } else {
      this._gameOver(this.fallsSinceCP >= CFG.MAX_FALLS_PER_CP ? 'stuck' : 'both-wet');
    }
  };

  /** 两只猴 + 绳子整体复位到检查点；距离/分数/金香蕉都保留（分是"到过的高度"） */
  Game.prototype._respawnAt = function (cp) {
    var ms = this.monkeys;
    var y = this._surfaceNear(cp.x, CFG.GROUND_Y);
    var p = this.platformAt(cp.x);
    var lo = p ? p.x + 12 : cp.x - 70;
    var hi = p ? p.x + p.w - 12 : cp.x + 70;
    for (var i = 0; i < 2; i++) {
      var m = ms[i];
      m.x = clamp(cp.x + (i === 0 ? -36 : 36), Math.min(lo, hi), Math.max(lo, hi));
      m.y = y;
      m.vx = 0; m.vy = 0;
      m.grounded = true;
      m.wetT = 0; m.stunT = 0; m.charging = false;
      m.squash = 1.12;
      m.hasJumped = true;
    }
    this.falls++;
    this.fallsSinceCP++;
    this.combo = 0;
    this._bothWetT = 0;
    // 联机时把操作权还给本端 seat（主机权威，客人跟快照）；单人给落后的那只
    this.active = this.netMode ? this.seat : (ms[0].progressX <= ms[1].progressX ? 0 : 1);
    this._lastSwitch = this.time;
    this.camX = (ms[0].x + ms[1].x) / 2 - CFG.W / 2;   // 相机直接切过去，不从原地滑
    this.shake = 0.5;
    this._float(cp.x, y - 124, '掉回检查点（第 ' + this.falls + ' 次）', '#e8590c');
    this._burst(cp.x, y - 30, 12, '#ffa94d');
    this.emit('respawn', { falls: this.falls, cp: cp.x });
  };

  // ---------- 特效 ----------
  Game.prototype._burst = function (x, y, n, color) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, s = 40 + Math.random() * 120;
      this.particles.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, life: 0.5 + Math.random() * 0.4, color: color, r: 1.5 + Math.random() * 3 });
    }
  };
  Game.prototype._float = function (x, y, text, color) {
    this.floatTexts.push({ x: x, y: y, text: text, color: color, life: 1.2 });
  };
  Game.prototype._fx = function (dt) {
    for (var i = this.particles.length - 1; i >= 0; i--) {
      var p = this.particles[i];
      p.life -= dt; p.vy += 420 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
    for (var j = this.floatTexts.length - 1; j >= 0; j--) {
      var f = this.floatTexts[j];
      f.life -= dt; f.y -= 32 * dt;
      if (f.life <= 0) this.floatTexts.splice(j, 1);
    }
  };
  Game.prototype._ambient = function (dt) {
    for (var i = 0; i < 2; i++) {
      var m = this.monkeys[i];
      if (!m.charging) m.squash = lerp(m.squash, 1, Math.min(1, dt * 10));
    }
  };

  // ---------- 联机（主机权威 + 客人回放快照） ----------
  Game.prototype.setNet = function (mode, seat) {
    this.netMode = mode;
    this.seat = seat || 0;
    this.cmdQueue = [];
    this._lastCmdSeq = 0;
  };

  Game.prototype.queueRemote = function (api) {
    if (!api) return;
    this.cmdQueue.push(api);
    this.cmdQueue.sort(function (a, b) { return a.seq - b.seq; });
  };

  Game.prototype._net = function () {
    if (this.netMode !== 'host') return;
    var guard = 0;
    while (this.cmdQueue.length && guard++ < 24) {
      var c = this.cmdQueue[0];
      this._lastCmdSeq = c.seq;
      this.cmdQueue.shift();
      this._applyRemote(c);
    }
  };

  Game.prototype._applyRemote = function (api) {
    var m = this.monkeys[api.m];
    if (!m || m.wetT > 0) return;
    if (api.t === 'down') {
      if (m.grounded && m.stunT <= 0 && !m.charging) { m.charging = true; m.chargeT = 0; }
    } else if (api.t === 'up' && m.charging) {
      m.charging = false;
      var ratio = m.chargeT / (CFG.MAX_POWER_MS / 1000);
      if (typeof api.p === 'number') ratio = api.p;
      this._launch(m, ratio);
      this.emit('jump', { idx: m.idx, power: m.power, from: m.x, remote: true });
    }
  };

  Game.prototype.snapshot = function () {
    var ms = this.monkeys;
    return {
      s: this.state === 'over' ? 0 : 1,
      a: this.active,
      m: [
        [Math.round(ms[0].x), Math.round(ms[0].y), ms[0].grounded ? 1 : 0, ms[0].wetT > 0 ? 1 : 0],
        [Math.round(ms[1].x), Math.round(ms[1].y), ms[1].grounded ? 1 : 0, ms[1].wetT > 0 ? 1 : 0]
      ],
      sc: this.score, co: this.coins, re: this.rescues,
      di: this.distance, mx: Math.round(this.maxX),
      cam: Math.round(this.camX),
      fa: this.falls, bc: this.bestCombo, pf: this.perfects,
      gd: this.golds, cb: this.combo
    };
  };

  Game.prototype.applySnapshot = function (snap) {
    if (!snap) return;
    if (!snap.s) { this._gameOver(); return; }
    var ms = this.monkeys;
    for (var i = 0; i < 2; i++) {
      var m = ms[i], s = snap.m[i];
      if (!s) continue;
      var dx = s[0] - m.x, dy = s[1] - m.y;
      // 小偏差做平滑（看着不抖），大偏差直接对齐（不然会越拖越远跑出画面）
      if (Math.abs(dx) > 26 || Math.abs(dy) > 60) { m.x = s[0]; m.y = s[1]; }
      else { m.x += dx * 0.7; m.y += dy * 0.7; }
      m.grounded = !!s[2];
      m.wetT = s[3] ? 0.8 : 0;
      m.charging = false;
    }
    this.active = snap.a;
    this.score = snap.sc || 0;
    this.coins = snap.co || 0;
    this.rescues = snap.re || 0;
    this.distance = snap.di || 0;
    this.falls = snap.fa || 0;
    this.bestCombo = snap.bc || 0;
    this.perfects = snap.pf || 0;
    this.golds = snap.gd || 0;
    this.combo = snap.cb || 0;
    if (typeof snap.mx === 'number') this.maxX = snap.mx;
    // 相机和地形生成交给 tickVisual 每帧处理（快照 200ms 才来一次，这里做会一顿一顿）
  };

  // 客人端每帧要做的事：相机跟随、地形生成、抖动/粒子，避免画面"冻住"或猴子跑出画面
  Game.prototype.tickVisual = function (dt) {
    this.time += dt;
    this._updateCamera(CFG.CAM_LERP * 1.6);   // 客人端稍微跟紧一点，抵消快照延迟
    this._genUntil(this.camX + CFG.W * 2);
    this._ambient(dt);
    this._fx(dt);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 3);
  };

  return { Game: Game, CFG: CFG, LEVELS: LEVELS, mulberry32: mulberry32 };
});
