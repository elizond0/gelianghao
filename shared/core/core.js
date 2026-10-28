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
    GROUND_Y: 430,      // 平台基准高度（整体抬高，给下方荡猴留空间）
    WATER_Y: 630,       // 水面：贴着画面最底部（H=667）
    GRAVITY: 1250,
    MIN_JUMP: 24,
    JUMP_RANGE: 150,      // 满蓄力相对最小跳多飞 150px：要覆盖后期最大 gap(185) - 平台半宽
    MAX_POWER_MS: 1100,   // 蓄力慢一点，落点更好拿捏
    ROPE_REST: 150,
    // ---- r14 飞行模型（对标原版：按下即起跳、按住上升、松手快落，弃用蓄力）----
    FLY_VX: 250,          // 起飞水平速度（恒定，距离由按多久决定）
    JUMP_UP: 330,         // 起跳瞬间竖直速度
    FLY_THRUST: 1050,     // 按住期间上升推力
    FLY_VY_MAX: 430,      // 上升速度上限
    FLY_TIME: 1.05,       // 最长持飞时间（秒），耗尽后按住也开始下落
    FALL_MULT: 2.0,       // 松手后快速下落的重力倍率
    VY_MAX: 980,          // 下落终端速度
    // ---- r14 弹性绳（对标原版：绳子可拉长，飞高能把站着的伙伴拽起来）----
    ROPE_K: 6,            // 弹簧系数（张力 = (超长-松弛带) * K）
    ROPE_SLACK: 90,       // 松弛带：超出原长这么多才真正绷紧（绳子是软弹的，不是钢索）
    ROPE_F_MAX: 900,      // 张力上限
    LIFT_T: 200,          // 把地面伙伴拽离平台的张力阈值（低门槛：一起飞才有原版味）
    ROPE_FLYER_SHARE: 0.15, // 飞行猴自身感受到的张力比例（它在"拽人"，不被反向猛拽）
    ROPE_STRETCH: 3.4,    // 绳子最大拉伸倍数（rest 的倍数），超出硬收
    // ---- r15：水面乌龟浮台 + 关卡里程碑 ----
    TURTLE_CHANCE: 0.3,   // 够宽的坑里刷救生乌龟的概率
    TURTLE_W: 58,         // 龟背宽
    MILESTONE: 500,       // 每推进 500m 进入下一关（进度条 + 过关提示）
    COYOTE: 0.09,       // 土狼时间：离开平台后这么久内仍可起跳（秒）
    JUMP_BUFFER: 0.15,  // 跳跃缓冲：落地前这么久内按的键，落地立即开始蓄力（秒）
    PATIENCE: 5.5,      // 落水后挂在绳上能荡/被救的耐心时间（秒）
    RESCUE_DELAY: 1.2,  // 落水后先荡这么久，B 才开始收绳钓人（保住"荡"的观感）
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
    BOTH_WET_DELAY: 0.9,  // 双落水后停顿这么久再回检查点/结算（给"完蛋感"留表演时间）
    // ---- 二期：面包和年糕式地形 2.0 ----
    MV_CHANCE: 0.18,      // 移动浮台概率（仅山腰以上生成）
    MV_AMP_MIN: 26, MV_AMP_MAX: 44,   // 浮台水平巡逻幅度（半程）
    MV_PERIOD_MIN: 2.6, MV_PERIOD_MAX: 3.8, // 巡逻一个来回的秒数
    SPRING_CHANCE: 0.11,  // 弹跳蘑菇概率（山腰以上；上面不刷障碍）
    SPRING_POWER: 0.95,   // 蘑菇弹跳力度（相对满蓄力的比例）
    WIND_FROM: 2600,      // 阵风区从这段距离开始出现（进山了）
    WIND_SPACING: 720,    // 两个风区至少隔这么远
    WIND_CHANCE: 0.42,    // 满足间距后每个新坑位刷风的概率
    WIND_F_MIN: 115, WIND_F_MAX: 195, // 风力（水平加速度 px/s^2，方向随机；玩家要能明确感到被推）
    WIND_ON_MIN: 5, WIND_ON_MAX: 9,   // 阵风：刮这么久
    WIND_OFF_MIN: 2.5, WIND_OFF_MAX: 5, // 停这么久（呼吸式节律，顺风窗口要等）
    GUST_RAMP: 0.8,                   // 起风/停风各用这么久渐变（不是瞬间开关）
    HIT_PENALTY: 20,                  // 撞尖刺扣分
    SPIKE_EDGE: 0.72                  // 尖刺只放在平台外侧 28% 区域（落中间=安全）
  };

  // 版本号：日期 + 当日构建序号，首页展示
  var VERSION = 'v2026.10.28-r15';

  // 山体主题：由 levelAt() 的档位驱动，渲染层读同一个下标做配色/飘雪
  // （面包和年糕的"山脚 -> 雪线 -> 暴风雪山顶"爬升感）
  var THEMES = [
    { name: '山脚草坡', snow: 0 },
    { name: '针叶林带', snow: 0 },
    { name: '碎石坡',   snow: 0 },
    { name: '雪线以上', snow: 0.35 },
    { name: '暴风雪山顶', snow: 1 }
  ];

  // r12 实机反馈调参：平台整体加宽、间距收短（观感"平台过短、间距过长"），
  // 同时保留每档内部浮动（宽窄/长短错落，不做全窄全长）
  var LEVELS = [
    { until: 900,  gapMin: 48,  gapMax: 95,  platMin: 92,  platMax: 148, obs: 0,    spike: false, ice: false },
    { until: 2000, gapMin: 58,  gapMax: 112, platMin: 84,  platMax: 138, obs: 0.35, spike: false, ice: false },
    { until: 3400, gapMin: 66,  gapMax: 126, platMin: 78,  platMax: 128, obs: 0.55, spike: true,  ice: false },
    { until: 5200, gapMin: 72,  gapMax: 134, platMin: 72,  platMax: 118, obs: 0.7,  spike: true,  ice: true  },
    { until: 1e9,  gapMin: 78,  gapMax: 140, platMin: 66,  platMax: 110, obs: 0.85, spike: true,  ice: true  }
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

  function levelIdx(x) {
    for (var i = 0; i < LEVELS.length; i++) if (x < LEVELS[i].until) return i;
    return LEVELS.length - 1;
  }

  // 三角波（确定性巡逻：不积累误差，快照/联机两端时间略偏也只差一小格）
  // u ∈ [0,1) → -1 → +1 → -1
  function tri01(t) {
    var f = t - Math.floor(t);
    return f < 0.5 ? f * 4 - 1 : 3 - f * 4;
  }

  function Monkey(idx) {
    this.idx = idx;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.grounded = true;
    this.charging = false;   // r14 起改名为"按住飞行"语义（保留字段名兼容联机协议）
    this.chargeT = 0;        // 按住时长（秒）
    this.power = 0;
    this.squash = 1;
    this.wetT = 0;
    this.stunT = 0;
    this.hasJumped = false;   // 本局是否真正起跳过（开局不换人用）
    this.progressX = 0;       // 它自己已经推进到的最远落点：落后的一方一定推进得少
    this.blink = Math.random() * 3;
    this.coyoteT = 0;         // 土狼时间剩余
    this.jumpBufT = 0;        // 跳跃缓冲剩余
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
    this.milestone = 0;       // r15：已进入的关卡（每 MILESTONE 米 +1）
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
    this.winds = [];          // 阵风区 [{x0,x1,fx}]（确定性生成，两端一致）
    this._lastWindX = CFG.WIND_FROM;
    // 关卡分段风格：每 5-8 块换一种节奏，别一路均速匀距（相似度太高）
    this._segStyle = 'normal';
    this._segLeft = 0;
    this._segYDir = 1;
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
      var li = levelIdx(last.x + last.w);

      // ---- 分段风格：每段 5-8 块，给关卡"章节感" ----
      if (this._segLeft <= 0) {
        var styles = ['normal', 'normal', 'airy', 'steps', 'islands', 'wide'];
        this._segStyle = styles[Math.floor(r() * styles.length)];
        this._segLeft = 5 + Math.floor(r() * 4);
        this._segYDir = r() < 0.5 ? -1 : 1;
      }
      this._segLeft--;

      var gap = Math.round(lerp(L.gapMin, L.gapMax, r()));
      var pw = Math.round(lerp(L.platMin, L.platMax, r()));
      // 高度起伏随档位放开：山脚±10 → 高处±34（还是平台间跳，不是跳崖）
      var ySpan = Math.min(34, 10 + li * 6);
      var y = CFG.GROUND_Y + Math.round((r() * 2 - 1) * ySpan);
      var style = this._segStyle;
      if (style === 'airy') {
        // 大空档：比常规段远一截但留足余量（满蓄力实际水平位移 ≈300px，
        // 旧注释的"单跳极限 174"算的是起跳初速度口径，不是水平位移）。
        // r12 实机反馈：观感"间距过长"， airy 硬顶从 168 收到 150
        gap = Math.round(Math.min(150, gap * 1.45 + 24));
        pw = Math.max(pw, 96);
      } else if (style === 'steps') {
        // 台阶：坑短，但高度一上一下交错，节奏完全不同
        gap = Math.round(gap * 0.55);
        y += this._segYDir * Math.round(14 + r() * 14);
        this._segYDir *= -1;
      } else if (style === 'islands') {
        // 孤岛：平台窄，坑正常，容错低
        pw = Math.max(46, Math.round(pw * 0.6));
        gap = Math.round(gap * 1.1);
      } else if (style === 'wide') {
        // 宽台：喘息段，顺带刷币
        pw = Math.min(230, Math.round(pw * 1.7));
      }
      // 全局可达性护栏：任何风格组合出的空档都不得超过硬顶
      gap = Math.min(gap, 150);
      y = clamp(y, CFG.GROUND_Y - 44, CFG.GROUND_Y + 34);
      var p = { x: last.x + last.w + gap, w: pw, y: y, type: 'normal' };
      if (L.ice && r() < 0.22) p.type = 'ice';

      // r15 水面乌龟：够宽的坑里浮一只乌龟当救生台——跳短了落龟背还能再起跳，
      // "踩空必死"的大坑变成有第二次机会（进山脚第一档之后就刷）
      if (gap >= 80 && li >= 1 && r() < CFG.TURTLE_CHANCE) {
        this.platforms.push({
          x: Math.round(last.x + last.w + gap / 2 - CFG.TURTLE_W / 2),
          w: CFG.TURTLE_W, y: CFG.WATER_Y - 12, y0: CFG.WATER_Y - 12,
          type: 'turtle',
          bobA: 4 + r() * 3, bobSpd: 0.9 + r() * 0.8, ph: r() * 6.28
        });
      }

      // 移动浮台（山腰以上）：绕初始点做三角波巡逻，位置由时间决定、两端一致
      var li = levelIdx(p.x);
      if (li >= 3 && r() < CFG.MV_CHANCE && pw >= 60 && p.type !== 'ice') {
        p.type = 'float';
        p.x0 = p.x;
        p.amp = Math.round(lerp(CFG.MV_AMP_MIN, CFG.MV_AMP_MAX, r()));
        p.period = lerp(CFG.MV_PERIOD_MIN, CFG.MV_PERIOD_MAX, r());
        p.ph = r();
        p.spd = 1 / p.period;
      }
      // 弹跳蘑菇（山腰以上）：踩上去自动弹起，力度≈满蓄力，上面不放障碍
      var isSpring = false;
      if (li >= 2 && p.type === 'normal' && r() < CFG.SPRING_CHANCE && pw >= 64) {
        p.type = 'spring';
        isSpring = true;
        // 蘑菇垫只占平台中段（30%~70%）：垫外是普通石板，玩家可以主动避开或利用
        p.pad0 = Math.round(p.x + p.w * 0.30);
        p.pad1 = Math.round(p.x + p.w * 0.70);
      }

      // 阵风区（进山后）：挂在坑位上空，空中被水平吹；带风牌提示
      if (p.x > this._lastWindX + CFG.WIND_SPACING && r() < CFG.WIND_CHANCE) {
        var fx = (r() < 0.5 ? -1 : 1) * lerp(CFG.WIND_F_MIN, CFG.WIND_F_MAX, r());
        // 公平性护栏：空档本来就接近单跳极限时，风只准顺吹（帮玩家飞过去），
        // 否则顶风 + 大空档 = 又一个物理死局
        if (gap > 135) fx = Math.abs(fx);   // 空档偏大时风只准顺风（公平护栏）
        this.winds.push({
          x0: Math.round(last.x + last.w - 30),
          x1: Math.round(p.x + 30),
          fx: Math.round(fx),
          tOn: lerp(CFG.WIND_ON_MIN, CFG.WIND_ON_MAX, r()),   // 刮多久
          tOff: lerp(CFG.WIND_OFF_MIN, CFG.WIND_OFF_MAX, r()), // 停多久
          ph: r() * 8    // 节律相位（错开各个风区，别全图同呼吸）
        });
        this._lastWindX = p.x;
      }

      var staticPlat = p.type === 'normal' || p.type === 'ice';   // 浮台会巡逻移走、乌龟浮在水面，都不刷障碍（会悬空）
      if (staticPlat && !isSpring && r() < L.obs && pw > 86) {
        this.obstacles.push({
          kind: r() < 0.55 ? 'bear' : 'piranha',
          x: Math.round(p.x + pw * (0.4 + r() * 0.25)),
          y: y, w: 26, h: 26, dead: false
        });
      }
      // 尖刺只占平台外侧 28%（右缘朝坑方向）：落中间就绝对安全，看见尖刺就往中间瞄。
      // 旧版放在 0.55 处（平台中部），跟"完美着陆圈"抢地盘又躲不开，纯坑
      if (staticPlat && !isSpring && L.spike && r() < 0.24 && pw > 88) {
        this.obstacles.push({ kind: 'spike', x: Math.round(p.x + pw * (CFG.SPIKE_EDGE + r() * 0.16)), y: y, w: 22, h: 12, dead: false });
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

      // 装饰树/灌木：蘑菇台别挡住红伞（r13 实拍发现树正好盖住蘑菇垫，
      // 玩家看不见"哪段能弹"），垫区±10px 内不刷
      for (var d = 0; d < 2; d++) {
        var dx = Math.round(p.x + r() * pw);
        if (p.type === 'spring' && dx > p.pad0 - 12 && dx < p.pad1 + 12) continue;
        this.decos.push({ x: dx, y: y, kind: r() < 0.5 ? 'tree' : 'bush', s: 0.7 + r() * 0.6 });
      }
      this.platforms.push(p);
      last = p;
    }
    var cut = this.camX - 700;
    if (this.platforms.length > 10) {
      this.platforms = this.platforms.filter(function (p) { return p.x + p.w > cut; });
      this.obstacles = this.obstacles.filter(function (o) { return o.x > cut; });
      this.winds = this.winds.filter(function (w) { return w.x1 > cut; });
      this.pickups = this.pickups.filter(function (o) { return o.x > cut; });
      this.decos = this.decos.filter(function (o) { return o.x > cut; });
    }
  };

  Game.prototype.platformAt = function (x, tol) {
    var ps = this.platforms;
    tol = tol || 0;
    for (var i = ps.length - 1; i >= 0; i--) {
      if (x >= ps[i].x - tol && x <= ps[i].x + ps[i].w + tol) return ps[i];
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
    if (m.stunT > 0 || m.wetT > 0) return;
    if (!m.grounded) return;   // r14：按下只在地面生效（起跳即飞），空中无蓄力/缓冲
    // 原版手感：按下立刻起跳，按住持续上升（飞行），松手快速下落
    m.charging = true;
    m.chargeT = 0;
    this._launch(m);
    this.lastOpOut = { t: 'down', m: m.idx };
  };

  Game.prototype.pressEnd = function () {
    if (this.state === 'ready') { this.start(); return; }
    if (this.state !== 'playing') return;
    if (!this.canIOperate()) return;
    var m = this.monkeys[this.active];
    if (!m.charging) return;
    m.charging = false;      // 松手：停止上升，进入快速下落
    this.lastOpOut = { t: 'up', m: this.active };
    this.emit('jumpEnd', { idx: m.idx });
  };

  Game.prototype._launch = function (m) {
    m.vx = CFG.FLY_VX;
    m.vy = -CFG.JUMP_UP;
    m.grounded = false;
    m.squash = 0.78;
    m.hasJumped = true;
    this.active = m.idx;
    this._lastSwitch = this.time;
  };

  // r14：飞行有效时长 = 按住时长（封顶 FLY_TIME），不再有蓄力回滚
  Game.prototype._effPower = function (m) {
    return clamp(m.chargeT / CFG.FLY_TIME, 0, 1);
  };

  Game.prototype.chargeFor = function (holdSec) {
    return clamp(holdSec, 0, CFG.FLY_TIME);
  };

  // 落点预测：和 update() 里的物理保持一致（含水平空气阻尼），否则瞄准线会骗人
  // 水平：vx(t) = vx0 * e^(-DRAG*t)  →  x(t) = x0 + vx0 * (1 - e^(-DRAG*t)) / DRAG
  // 竖直：y(t) = y0 + vy0*t + 0.5*G*t^2（无阻尼）
  var DRAG = 0.25;

  // 阵风系数 0..1：刮 tOn 秒、停 tOff 秒，起/停各有 GUST_RAMP 渐变（呼吸式，不是电闸）
  Game.prototype._gustAt = function (w, now) {
    var on = w.tOn || 6, off = w.tOff || 3, ramp = CFG.GUST_RAMP;
    var t = (now == null ? this.time : now);
    var u = (t + (w.ph || 0)) % (on + off);
    if (u < on) return Math.max(0, Math.min(1, u / ramp, (on - u) / ramp));
    return 0;
  };

  // x 处的风力（不在任何风区返回 0；风区内乘阵风系数）。
  // 地形生成、主循环、落点预测共用，保证瞄准线不骗人
  Game.prototype._windAt = function (x, now) {
    for (var i = 0; i < this.winds.length; i++) {
      var w = this.winds[i];
      if (x >= w.x0 && x <= w.x1) return w.fx * this._gustAt(w, now);
    }
    return 0;
  };

  // 落点预测：数字积分，和 update() 的物理完全一致（阻尼 + 风），保证瞄准线可信。
  // 旧版闭式解没法算风，风区里"瞄哪落哪"会失灵，已改成 1/120s 步进积分。
  // r14 落点预测：按"按住 holdSec 秒"的飞行模拟（起跳→按住上升→松手快落），
  // 物理与 update() 一致（推力/快落/空气阻尼/阵风）。stopY 为落点判定高度。
  Game.prototype.projectLanding = function (fromX, holdSec, fromY, stopY) {
    var vx = CFG.FLY_VX, vy = -CFG.JUMP_UP;
    var x = fromX, y = fromY || CFG.GROUND_Y;
    var dt = 1 / 120;
    var t0 = this.time;
    var left = clamp(holdSec, 0, CFG.FLY_TIME);
    var sy = stopY == null ? CFG.WATER_Y : stopY;
    for (var i = 0; i < 1200; i++) {
      if (left > 0) {
        left -= dt;
        vy -= CFG.FLY_THRUST * dt;
        if (vy < -CFG.FLY_VY_MAX) vy = -CFG.FLY_VY_MAX;
      } else {
        vy += CFG.GRAVITY * (CFG.FALL_MULT - 1) * dt;
      }
      vx += this._windAt(x, t0 + i * dt) * dt;   // 风随飞行时间演进，预测才和实际一致
      vx *= (1 - DRAG * dt);
      vy += CFG.GRAVITY * dt;
      x += vx * dt;
      y += vy * dt;
      if (vy > 0 && y >= sy) break;
    }
    return x;
  };

  Game.prototype.chargeRatio = function () {
    var m = this.monkeys[this.active];
    if (!m || !m.charging) return 0;
    return this._effPower(m);   // r14：按住时长 / 最长飞行时间
  };

  // ---------- 主循环 ----------
  Game.prototype.update = function (dt) {
    if (this.state === 'ready' || this.state === 'paused') { this._ambient(dt); return; }
    if (this.state === 'over') { this._fx(dt); return; }

    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    var ms = this.monkeys;

    // 移动浮台：先记下每只猴站的台子，推台子，再带着猴一起走
    // （不载猴的话猴会悬在原地被台子甩出去，看着像 bug）
    for (var pi = 0; pi < this.platforms.length; pi++) {
      var pl = this.platforms[pi];
      if (pl.type === 'turtle') {
        // r15 乌龟浮台：随波上下起伏（站着的猴由下方"贴台"逻辑带着走）
        if (pl.y0 === undefined) pl.y0 = pl.y;
        pl.y = pl.y0 + Math.sin(this.time * (pl.bobSpd || 1.2) + (pl.ph || 0)) * (pl.bobA || 4);
        continue;
      }
      if (!pl.mv && pl.type !== 'float') continue;
      if (pl.x0 === undefined) { pl.x0 = pl.x; pl.amp = 30; pl.spd = 1 / 3; pl.ph = 0; }
      var nx = pl.x0 + pl.amp * tri01(this.time * pl.spd + pl.ph);
      pl._dx = nx - pl.x;
      pl.x = nx;
    }
    for (var mi = 0; mi < 2; mi++) {
      var mm = ms[mi];
      if (!mm.grounded || mm.wetT > 0) continue;
      var stand = this.platformAt(mm.x, 7);
      if (stand && stand.type === 'float' && stand._dx) mm.x += stand._dx;
      // 站着的台子被移走了/不在脚下 → 开始下坠（覆盖所有平台的兜底）
      var under = this.platformAt(mm.x, 7);
      if (!under) { mm.grounded = false; mm.coyoteT = CFG.COYOTE; }
      else if (Math.abs(mm.y - under.y) > 0.5) mm.y = under.y;
    }

    for (var i = 0; i < 2; i++) {
      var m = ms[i];
      if (m.charging) {
        m.chargeT += dt; m.squash = 0.9;   // r14：按住=飞行中
        if (m.autoFly > 0 && m.chargeT >= m.autoFly) { m.charging = false; m.autoFly = 0; }
      }
      if (m.stunT > 0) m.stunT -= dt;
      if (m.coyoteT > 0) m.coyoteT -= dt;
      if (m.jumpBufT > 0) m.jumpBufT -= dt;
      if (m.wetT > 0) {
        m.wetT -= dt;
        // 耐心耗尽还没被救上来 -> 别让它掉出世界（绳子拉长/猴子消失的 bug），
        // 按"连掉"判定回检查点或结算
        if (m.wetT <= 0 && !m.grounded) this._onWetExpired(m);
      }
      m.blink += dt;

      if (!m.grounded && m.wetT <= 0) {
        m.vy += CFG.GRAVITY * dt;
        // r14 飞行模型：按住期间持续上升推力（时长封顶），松手后快速下落
        if (m.charging && m.chargeT < CFG.FLY_TIME) {
          m.vy -= CFG.FLY_THRUST * dt;
          if (m.vy < -CFG.FLY_VY_MAX) m.vy = -CFG.FLY_VY_MAX;
        } else {
          m.vy += CFG.GRAVITY * (CFG.FALL_MULT - 1) * dt;
        }
        if (m.vy > CFG.VY_MAX) m.vy = CFG.VY_MAX;
        var prevX = m.x, prevY = m.y;
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        if (m.vy > 0) {
          var hit = this._crossedSurface(prevX, prevY, m.x, m.y);
          if (hit) this._land(m, hit);
          else if (!this.platformAt(m.x) && m.y > CFG.WATER_Y - 20) this._wet(m);
        }
        // 阵风：只在空中受力（地面无感，落地即安全），方向和强度由地形决定
        if (!m.grounded) {
          m.vx *= (1 - DRAG * dt);
          var wf = this._windAt(m.x);
          if (wf) m.vx += wf * dt;
        }
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
    // r15 关卡里程碑：每 MILESTONE 米进一关（过关浮字 + milestone 事件）
    var mile = Math.floor(this.distance / CFG.MILESTONE);
    if (mile > (this.milestone || 0)) {
      this.milestone = mile;
      this._float(this.camX + CFG.W / 2, 160, '第 ' + (mile + 1) + ' 关！', '#f08c00');
      this.emit('milestone', { level: mile + 1 });
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
        // 边缘容差 7px：猴子中心略出平台边缘（半个身子在外）也算踩到
        if (xb >= p.x - 7 && xa <= p.x + p.w + 7) return p;
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

    // ⓪ 正在按住飞行/蓄力的这一棒绝不抢（r14：飞行也在空中，必须先于 ① 判断，
    //    否则空中飞行会被 ① 当成"落水/被晕"抢棒，就是"顺序错乱"bug 的根源）
    if (cur.charging && cur.wetT <= 0 && cur.stunT <= 0) return;
    // ① 落水/被晕：换另一只来救
    if (curBad) {
      if (otherReady) { this._lastSwitch = this.time; this.setActive(1 - this.active); }
      return;
    }   // r14：按住飞行中不抢棒
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
    if (acting && acting.charging && !acting.grounded) {
      // r14：按住飞行时把"满按住时长的落点"算进取景，视野跟着飞
      var reach = this.projectLanding(acting.x, CFG.FLY_TIME, acting.y) + 40;
      if (reach > aimRight) aimRight = reach;
    }

    var pad = 46;
    var cMin = aimRight + pad - CFG.W, cMax = lo - pad;
    if (cMin <= cMax) {
      // 常规：两猴装得下屏幕，视野偏向前进方向（0.62 权重）
      var mid = lo + (aimRight - lo) * 0.62;
      this.camX = lerp(this.camX, mid - CFG.W / 2, k == null ? CFG.CAM_LERP : k);
      this.camX = clamp(this.camX, cMin, cMax);
    } else {
      // r15 实机反馈：两猴拉得太远屏幕装不下时，旧逻辑硬居中会把
      // "正在操作的猴"裁出屏幕左缘（玩家看不见自己的猴）。改为聚焦操作猴。
      // （注意这里不能再走上面的常规 lerp，双 lerp 会打架）
      var focus = acting ? acting.x : lo;
      this.camX = lerp(this.camX, focus - CFG.W * 0.35, k == null ? CFG.CAM_LERP : k);
    }
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
    var land = this.projectLanding(m.x, CFG.FLY_TIME, m.y);
    return land >= q.x - 4;
  };

  // 是否踩中蘑菇垫（老存档/测试造的 spring 平台没有 pad 字段时按整台算，向后兼容）
  Game.prototype._onSpringPad = function (x, plat) {
    if (plat.pad0 === undefined) return true;
    return x >= plat.pad0 && x <= plat.pad1;
  };

  // r14 弹跳自适应：扫描"自动按住时长"，找落点最接近下一块平台中心的值。
  // 积分物理与 update()/projectLanding() 一致（推力/快落 + 空气阻尼 + 阵风）。
  Game.prototype._springHold = function (fromX, plat) {
    var edge = plat.x + plat.w;
    var next = this.nextPlatform(edge);
    if (!next) return CFG.FLY_TIME * 0.9;
    var target = next.x + next.w / 2;
    var best = CFG.FLY_TIME * 0.9, bestErr = 1e9;
    for (var h = 0; h <= CFG.FLY_TIME + 0.001; h += 0.05) {
      var land = this.projectLanding(fromX, h, plat.y, next.y);
      var err = Math.abs(land - target);
      if (err < bestErr) { bestErr = err; best = h; }
    }
    return best;
  };

  Game.prototype._land = function (m, plat) {
    m.y = plat.y;
    m.vy = 0;
    m.vx = 0;
    m.grounded = true;
    m.squash = 1.18;
    // 弹跳蘑菇：只踩中平台中段的"蘑菇垫"才弹（垫外=普通着陆，可以主动避开），
    // 弹跳力度自适应——自动取"正好落到下一块平台中心"的力度，
    // 保证"踩垫=前进一格"，不再出现固定满力越过近台掉水的陷阱（r13 实机反馈）
    if (plat.type === 'spring' && m.vy >= 0 && this._onSpringPad(m.x, plat)) {
      // r14：蘑菇弹起 = 自动"按住飞行"，时长取"正落下一块平台中心"的值
      m.charging = true;
      m.chargeT = 0;
      m.autoFly = Math.max(0.12, this._springHold(m.x, plat));
      m.vx = CFG.FLY_VX * 0.92;
      m.vy = -CFG.JUMP_UP * 1.08;
      m.grounded = false;
      m.squash = 0.68;
      m.hasJumped = true;
      this._float(m.x, plat.y - 86, '弹！', '#7048e8');
      this._burst(m.x, plat.y, 9, '#d0bfff');
      this.emit('spring', { idx: m.idx });
      return;
    }
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
    m.y = CFG.WATER_Y - 8;
    m.vx = 0; m.vy = 0;
    m.grounded = false;
    m.wetT = CFG.PATIENCE;
    m.wetRescueDelay = CFG.RESCUE_DELAY;
    this.combo = 0;
    m.squash = 0.7;
    this.shake = 0.6;
    this._burst(m.x, CFG.WATER_Y - 4, 10, '#7fd4ff');
    this.emit('wet', { idx: m.idx, x: m.x });
  };

  // ---------- 绳子：哥俩好的灵魂 ----------
  Game.prototype._rope = function (dt) {
    var ms = this.monkeys, a = ms[0], b = ms[1];
    var dx = b.x - a.x, dy = b.y - a.y;
    var d = Math.sqrt(dx * dx + dy * dy) || 0.001;
    var rest = this.ropeRest();
    var over = d - rest;

    // ---- r14 弹性绳（对标原版）：超过原长按弹簧互相拉，张力可把地面伙伴拽离平台 ----
    if (over > 0) {
      var nx = dx / d, ny = dy / d;
      // 松弛带：绳子是软弹的，超出原长一段才真正绷紧出力
      var eff = over - CFG.ROPE_SLACK;
      if (eff > 0) {
        var F = Math.min(eff * CFG.ROPE_K, CFG.ROPE_F_MAX);   // 张力（加速度量纲）
        var stretchMax = rest * CFG.ROPE_STRETCH;
        // r16 对标原版：绳子是软绳不是钢弹簧。超过弹性上限后不再"更硬的弹簧"，
        // 而是绳长约束——位置投影回圆上、消掉向外径向速度、保留切向速度，
        // 双猴自然会像钟摆一样荡起来（甩猴手感的核心）
        var ropeTaut = d > stretchMax;
        if (ropeTaut) F = CFG.ROPE_F_MAX;
        // 空中的猴受张力（被拉向对方）；对方湿挂时由单摆处理，不出这个力
        for (var ri = 0; ri < 2; ri++) {
          var rm = ms[ri];
          if (rm.grounded || rm.wetT > 0 || ms[1 - ri].wetT > 0) continue;
          var share = rm.charging ? CFG.ROPE_FLYER_SHARE : 1;  // 按住飞行=主动拽人方，只吃小份额
          // 伙伴还锚在地上时，绳子只传"刚好能把人拽起来"的力，再多也传不过去
          var Fm = ms[1 - ri].grounded ? Math.min(F, CFG.LIFT_T * 1.5) : F;
          var dirX = (ri === 0 ? 1 : -1) * nx, dirY = (ri === 0 ? 1 : -1) * ny;
          rm.vx += dirX * Fm * share * dt;
          rm.vy += dirY * Fm * share * dt;
        }
        // r16 绳长软约束：绷满后把悬空猴拉回 stretchMax 圆上（切向速度保留 => 荡）
        if (ropeTaut) {
          var excess = d - stretchMax;
          for (var ci = 0; ci < 2; ci++) {
            var cm = ms[ci], co = ms[1 - ci];
            if (cm.grounded || cm.wetT > 0 || co.wetT > 0) continue;
            if (cm.charging) continue;   // r14 精神：按住飞行的是主动拽人方，绝不被绳拖垮
            var sgn = ci === 0 ? 1 : -1;                 // A 沿 +n 朝 B 收，B 反向
            var share = (co.grounded || co.wetT > 0) ? 1 : 0.5;   // 双悬空各收一半
            // 每帧修正量限幅 12px：温和拉回，不瞬移也不拖死跳跃（r11 教训）
            var pull = Math.min(excess * share, 12);
            cm.x += sgn * nx * pull;
            cm.y += sgn * ny * pull;
            // 消掉"向外"的径向速度（保留切向 => 摆而不是对撞）。
            // 注意向外方向：A 是 -n，B 是 +n（= -sgn * n）
            var vr2 = -sgn * (cm.vx * nx + cm.vy * ny);
            if (vr2 > 0) { cm.vx += sgn * vr2 * nx; cm.vy += sgn * vr2 * ny; }
          }
        }
        // 原版标志手感：飞高拉远后张力足够大，把站着的伙伴直接拽离平台
        for (var li = 0; li < 2; li++) {
          var gm = ms[li], fo = ms[1 - li];
          if (!gm.grounded || gm.wetT > 0 || gm.stunT > 0) continue;
          if (fo.grounded || fo.wetT > 0) continue;   // 对方悬空才可能绷出大张力
          var fy = (fo.y - gm.y) / d * F;             // 对方在我上方 → fy<0（向上拉）
          if (-fy > CFG.LIFT_T && fo.y < gm.y - 40) {
            gm.grounded = false;
            gm.squash = 1.12;
            // r16 原版手感：被拽起的猴沿绳的"切向"荡出去，不是直着吸向对方
            var ttx = -ny, tty = nx;                  // 切向单位向量
            if (ttx < 0) { ttx = -ttx; tty = -tty; }  // 恒朝前进方向（+x）
            gm.vx += ttx * 130;
            gm.vy += tty * 130 * 0.35 + fy * dt * 2 - 80;   // 拔离平台 + 向上初速 + 切向甩
            this.emit('lift', { idx: gm.idx, by: fo.idx });
          }
        }
      }
    }

    // ---- 落水的猴子：单摆物理 ----
    // A 落水后挂绳吊在伙伴 B 下面：重力把它往下拽，浮力让它半浸水面不沉底，
    // 绳长约束把位置拉回以 B 为圆心的圆上并消掉径向速度（真单摆特性）。
    // B 一动（跳/走/收绳），A 就会跟着物理地荡起来。
    for (var i = 0; i < 2; i++) {
      var m = ms[i];
      if (m.wetT <= 0 || m.wetT >= 100) continue;   // wetT>=100 是测试用的幽灵锚点，不参与物理
      var other = ms[1 - i];
      var ax = other.x, ay = other.y + 6;   // 锚点：伙伴身上

      // 1) 力：重力 + 浮力（只在水下生效：浸入越深往上推得越狠）
      m.vy += CFG.GRAVITY * dt;
      var depth = m.y - (CFG.WATER_Y - 10);
      if (depth > 0) m.vy -= depth * 30 * dt;
      m.vx *= 1 - Math.min(1, 1.1 * dt);    // 水平水阻

      m.x += m.vx * dt;
      m.y += m.vy * dt;

      // 2) 绳长约束：拉回半径 rest 的圆上，消掉径向外冲速度
      var dx = m.x - ax, dy = m.y - ay;
      var dd = Math.sqrt(dx * dx + dy * dy) || 1;
      if (dd > rest) {
        var nx = dx / dd, ny = dy / dd;
        m.x = ax + nx * rest;
        m.y = ay + ny * rest;
        var vr = m.vx * nx + m.vy * ny;
        if (vr > 0) { m.vx -= vr * nx; m.vy -= vr * ny; }
      }

      // 2.5) 水面钳制：半浸不沉底（绳子把它拽进水里也只没到胸口）
      if (m.y > CFG.WATER_Y + 26) {
        m.y = CFG.WATER_Y + 26;
        if (m.vy > 0) m.vy = 0;
      }

      // 3) 摆动阻尼：荡几下慢慢稳下来
      m.vx *= 1 - Math.min(1, 0.5 * dt);
      m.vy *= 1 - Math.min(1, 0.9 * dt);

      // 3.5) 刚落水先让他荡一会儿（RESCUE_DELAY），别一沾水就被钓上来
      if (m.wetRescueDelay > 0) m.wetRescueDelay -= dt;

      // 4) 伙伴站稳在岸上 -> 慢慢收绳往上钓，够到平台就拉上来
      if (other.grounded && m.wetRescueDelay <= 0) {
        var cur = Math.sqrt((m.x - ax) * (m.x - ax) + (m.y - ay) * (m.y - ay)) || 1;
        var reel = Math.min(1, dt * 1.8);
        var rx = (m.x - ax) / cur, ry = (m.y - ay) / cur;
        var target = rest * 0.42;
        m.x = lerp(m.x, ax + rx * target, reel);
        m.y = lerp(m.y, ay + ry * target, reel);
        var pHere = this.platformAt(m.x);
        if (pHere && m.y > pHere.y - 16) {
          // 收到平台高度了，直接托上岸
          m.y = lerp(m.y, pHere.y - 4, Math.min(1, dt * 6));
          if (Math.abs(m.y - (pHere.y - 4)) < 14) { this._rescued(m, pHere); continue; }
        }
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
          m.stunT = o.kind === 'spike' ? 0.3 : 0.55;   // 尖刺短晕（0.3s），别把节奏卡死
          m.squash = 0.8;
          this.combo = 0;
          o.dead = true;
          this.shake = 0.8;
          if (o.kind === 'spike') {
            this.bonus = Math.max(0, this.bonus - CFG.HIT_PENALTY);   // 扣分走 bonus（score 是派生值）
            this._burst(o.x, o.y - 12, 8, '#ff6b6b');
            this._float(o.x, o.y - 56, '扎到啦！-' + CFG.HIT_PENALTY, '#e03131');
          } else {
            this._burst(o.x, o.y - 12, 8, '#ff6b6b');
            this._float(o.x, o.y - 56, '小心！', '#e03131');
          }
          this.emit('hit', { idx: j, kind: o.kind, penalty: o.kind === 'spike' ? CFG.HIT_PENALTY : 0 });
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
      time: Math.round(this.time),
      reason: reason || 'both-wet'
    });
  };

  /**
   * 双落水总入口（面包和年糕式检查点续跳）：
   *  - 已越过检查点、且没在同一检查点连续摔 MAX_FALLS_PER_CP 次 -> 回检查点继续
   *  - 还没走到任何一个检查点就双落 -> 直接结算（开局不给兜底）
   *  - 同一检查点连摔 3 次 -> 判定卡关，结算（防止被地形焊死）
   */
  /** 单只湿猴耐心耗尽：救援失败，按连掉处理（回检查点或结算），不再无声下坠 */
  Game.prototype._onWetExpired = function (m) {
    if (this.state !== 'playing') return;
    this._float(m.x, CFG.WATER_Y - 64, '没抓稳…', '#e8590c');
    var cp = this.checkpoints[this._lastCPIdx];
    if (cp && cp.passed && this.fallsSinceCP < CFG.MAX_FALLS_PER_CP) {
      this._respawnAt(cp);
    } else {
      this._gameOver(this.fallsSinceCP >= CFG.MAX_FALLS_PER_CP ? 'stuck' : 'wet-out');
    }
  };

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
      m.wetT = 0; m.stunT = 0; m.charging = false; m.autoFly = 0;
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
    // r15 实机反馈：同一时刻多条浮字（完美+扎到+小心）叠成一坨，往上逐条错位
    var pile = 0;
    for (var fi = 0; fi < this.floatTexts.length; fi++) {
      if (this.floatTexts[fi].life > 0.85) pile++;
    }
    this.floatTexts.push({ x: x, y: y - pile * 26, text: text, color: color, life: 1.2 });
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
      if (m.grounded && m.stunT <= 0 && !m.charging) {
        m.charging = true; m.chargeT = 0;
        this._launch(m);
        this.emit('jump', { idx: m.idx, from: m.x, remote: true });
      }
    } else if (api.t === 'up' && m.charging) {
      m.charging = false;   // r14：松手=停止飞行
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

  return { Game: Game, CFG: CFG, VERSION: VERSION, LEVELS: LEVELS, THEMES: THEMES, mulberry32: mulberry32 };
});
