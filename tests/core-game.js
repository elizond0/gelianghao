/**
 * 面包和年糕式玩法机制测试（tests/core-game.js）
 *
 * 直接驱动 Game 内核验证五件事：
 *   1. 完美着陆：落平台中心 -> 连击 + 加分；落偏 -> 连击断
 *   2. 连击 >=3 时每跳追加 COMBO_BONUS
 *   3. 金香蕉 / 高处香蕉：跳起来擦到边就算吃到（不再要求 grounded）
 *   4. 存档点：打卡 -> 双落水回检查点续跳；同点连摔 3 次 -> 卡关结算；无存档点 -> 直接结算
 *   5. 荡绳助力：绷紧 + 下落 -> 上悠 + 前送（抵消绳子回拽）
 *   6. 快照往返：新字段不丢
 *
 * 跑法：node tests/core-game.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const Core = require(path.join(ROOT, 'shared/core/core.js'));

let pass = 0, fail = 0;
function chk(label, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

const DT = 1 / 60;
/** 取游戏里某类事件是否发生过（配合 makeGame 的 events 不方便穿透时用） */
function g2Events(g, type) {
  return !!(g._testEvents && g._testEvents.some(e => e.type === type));
}

/** 建一局，挂事件记录器，清掉障碍物（测试只关心机制，不想被熊撞） */
function makeGame(seed) {
  const events = [];
  const g = new Core.Game({
    seed: seed,
    onEvent: function (type, d) { events.push({ type: type, d: d || {} }); }
  });
  g._testEvents = events;
  g.start();
  g.obstacles = [];
  return { g: g, events: events };
}

/** 把另一只猴"停泊"到远处水里，避免绳子/双落水干扰本猴 */
function parkOther(g, i) {
  const m = g.monkeys[i];
  m.x = -400; m.y = 600; m.vx = 0; m.vy = 0;
  m.grounded = false; m.wetT = 999; m.stunT = 0; m.charging = false;
}

/**
 * 把两只猴都扔进旗子平台右边的坑里（真实"双落水"姿势：
 * 不 grounded、泡在水里、下方无平台——免得触发绳子救援把谁钓上去）
 */
function dropBothInPit(g, cpX) {
  const plat = g.platformAt(cpX);
  const pitX = plat.x + plat.w + 12;      // 平台右边缘外就是坑（gap >= 40，安全）
  for (let i = 0; i < 2; i++) {
    const m = g.monkeys[i];
    m.x = pitX + (i === 0 ? -15 : 15);
    // y 必须低于所有台面（平台最低 ≈ GROUND_Y+34，这里取 WATER_Y-80）：
    // r17 甩上台救援会判"身体从上往下穿台面"，摆位高于低邻台台面会误触发
    m.y = Core.CFG.WATER_Y - 80;
    m.vx = 0; m.vy = 0;
    m.grounded = false; m.wetT = 5; m.stunT = 0; m.charging = false;
  }
  g._bothWetT = 0;
  g.pickups = [];
}

/** 让猴子从高度 h 自由落体到平台上，跑最多 maxF 帧 */
function dropOnto(g, m, plat, fromY, maxF) {
  m.x = plat.x + plat.w / 2;
  m.y = fromY;
  m.vx = 0; m.vy = 100;
  m.grounded = false;
  m.wetT = 0; m.stunT = 0;
  for (let i = 0; i < (maxF || 120) && !m.grounded; i++) g.update(DT);
}

// --------------------------------------------------
async function main() {
  // ========== 1. 完美着陆与连击 ==========
  console.log('\n[1] 完美着陆 / 连击');
  {
    const { g, events } = makeGame(12345);
    parkOther(g, 1);
    const plat = g.platforms.filter(p => p.type !== 'start')[0];
    const m = g.monkeys[0];

    // 第一次：落平台正中心 -> 完美
    dropOnto(g, m, plat, plat.y - 60);
    chk('落中心触发完美着陆', g.perfects === 1 && g.combo === 1, { perfects: g.perfects, combo: g.combo });
    chk('完美基础分 +15', g.bonus === Core.CFG.PERFECT_BONUS, { bonus: g.bonus });
    chk('抛出 perfect 事件', events.some(e => e.type === 'perfect' && e.d.combo === 1));

    // 第二次：故意落偏（靠左缘）-> 连击断
    m.x = plat.x + 6; m.y = plat.y - 60; m.vy = 100; m.grounded = false;
    for (let i = 0; i < 120 && !m.grounded; i++) g.update(DT);
    chk('落偏连击清零', g.combo === 0, { combo: g.combo });
    chk('最高连击保留', g.bestCombo === 1, { bestCombo: g.bestCombo });
    chk('完美次数不重复计', g.perfects === 1, { perfects: g.perfects });
  }

  // ========== 2. 连击 >=3 追加分 ==========
  console.log('\n[2] 连击追加分');
  {
    const { g } = makeGame(12345);
    parkOther(g, 1);
    const plat = g.platforms.filter(p => p.type !== 'start')[0];
    const m = g.monkeys[0];
    for (let k = 0; k < 3; k++) dropOnto(g, m, plat, plat.y - 60);
    // 15 + 15 + (15 + 15) = 60
    chk('三连击总分 60', g.bonus === 60, { bonus: g.bonus, combo: g.combo });
    chk('最高连击 = 3', g.bestCombo === 3, { bestCombo: g.bestCombo });
    chk('连击计数 = 3', g.combo === 3, { combo: g.combo });
  }

  // ========== 3. 高处道具：跳起来擦边就算吃到 ==========
  console.log('\n[3] 金香蕉 / 高处香蕉');
  {
    // 扫种子找一颗生成出来的金香蕉
    let g = null, gold = null;
    for (let seed = 1; seed <= 60 && !gold; seed++) {
      const t = makeGame(seed);
      t.g._genUntil(5000);
      gold = t.g.pickups.filter(p => p.gold && !p.taken)[0] || null;
      if (gold) { g = t.g; }
    }
    chk('能找到金香蕉（生成逻辑生效）', !!gold);
    if (gold) {
      parkOther(g, 1);
      g.pickups = [gold];           // 只留目标，别的币不算分
      const m = g.monkeys[0];
      // 从金香蕉下方 40px 处往上迎（手在金香蕉中心下方 10px，判定框 66 内）
      m.x = gold.x; m.y = gold.y + 40; m.vx = 0; m.vy = -200;
      m.grounded = false; m.wetT = 0;
      g.update(DT);
      chk('空中可以吃到金香蕉', g.golds === 1 && gold.taken === true, { golds: g.golds, taken: gold.taken });
      chk('金香蕉 +50 分', g.bonus === Core.CFG.GOLD_BONUS, { bonus: g.bonus });
    }

    // 普通香蕉（-82 高度）同样跳起来能吃
    const t2 = makeGame(777);
    t2.g._genUntil(5000);
    const high = t2.g.pickups.filter(p => !p.gold && !p.taken)[0] || null;
    if (high) {
      parkOther(t2.g, 1);
      t2.g.pickups = [high];
      const m2 = t2.g.monkeys[0];
      m2.x = high.x; m2.y = high.y + 40; m2.vx = 0; m2.vy = -200;
      m2.grounded = false; m2.wetT = 0;
      t2.g.update(DT);
      chk('空中可以吃到高处香蕉', t2.g.coins === 1 && high.taken === true, { coins: t2.g.coins });
    } else {
      chk('空中可以吃到高处香蕉', false, '种子 777 没生成普通香蕉');
    }
  }

  // ========== 4. 存档点与防卡关 ==========
  console.log('\n[4] 存档点 / 续跳 / 防卡关');
  {
    // 回归：以前旗子要求平台正好盖住固定网格点，一落进坑整局无旗（且后续全堵死）
    let zeroSeeds = 0;
    for (let s = 1; s <= 20; s++) {
      const t = new Core.Game({ seed: s }); t.start(); t._genUntil(3000);
      if (t.checkpoints.length === 0) zeroSeeds++;
    }
    chk('20 个种子都刷得出检查点（不再整局无旗）', zeroSeeds === 0, { zeroSeeds: zeroSeeds });

    const { g, events } = makeGame(4242);
    g._genUntil(3000);
    const cp = g.checkpoints[0];
    chk('生成了检查点', !!cp, { n: g.checkpoints.length });
    // 旗必须落在某块平台表面上（不掉坑里）
    const onPlat = g.platforms.some(p => cp.x >= p.x && cp.x <= p.x + p.w);
    chk('旗面落在平台上', onPlat, { x: cp.x });

    // 把猴0送到旗子右边 -> 打卡
    g.monkeys[0].x = cp.x + 20; g.monkeys[0].y = 460; g.monkeys[0].grounded = true;
    g.monkeys[1].x = cp.x - 20; g.monkeys[1].y = 460; g.monkeys[1].grounded = true;
    g.update(DT);
    chk('越过旗面打卡', cp.passed === true && g._lastCPIdx >= 0, { passed: cp.passed, idx: g._lastCPIdx });
    chk('抛出 checkpoint 事件', events.some(e => e.type === 'checkpoint'));

    // r21：打卡即过关（检查点旗升级为过关旗）
    chk('打卡后 level+1', g.level === 2 && g._levelStartX === cp.x,
      { level: g.level, startX: g._levelStartX });
    chk('抛出 levelClear 事件', events.some(e => e.type === 'levelClear' && e.d.level === 1));
    chk('过关奖励分 +100', g.bonus >= 100, g.bonus);

    // r26（用户规则）：双落水 = 回最近存档点（本关起点/过关旗）重打本关；每关 3 次后结算
    // （物理摆位下湿猴可能被绳荡上台获救=有猴存活不结算，属涌现行为；重开逻辑用单元契约测）
    const scoreBefore = g.score;
    g._onBothWet();
    chk('双落水重打本关而非结算', g.state === 'playing' && g.falls === 1, { state: g.state, falls: g.falls });
    chk('重开后两只猴都不湿了', g.monkeys[0].wetT <= 0 && g.monkeys[1].wetT <= 0);
    chk('重开回到本关起点附近', Math.abs(g.monkeys[0].x - g._levelStartX) < 260,
      { x: g.monkeys[0].x, startX: g._levelStartX });
    chk('分数保留（不因重开清零）', g.score >= scoreBefore, { before: scoreBefore, after: g.score });
    chk('抛出 respawn 事件', events.some(e => e.type === 'respawn'));

    // 1、2 次仍重打本关；第 3 次结算（this.fallsSinceCP 过关清零 = "每关 3 次"）
    g._onBothWet();
    chk('重打后计数 fallsSinceCP=2', g.fallsSinceCP === 2, g.fallsSinceCP);
    chk('第 2 次双落水仍重打不结算', g.state === 'playing', { state: g.state });
    chk('回档落点仍在存档平台上', !!g.platformAt(g.monkeys[0].x));

    g._onBothWet();   // ← 本关第 3 次
    chk('本关第 3 次双落水 → 结算，不再重打', g.state === 'over', { state: g.state, falls: g.falls });
    const go = events.find(e => e.type === 'gameover');
    chk('抛出 gameover 且 reason=falls-limit', !!go && go.d.reason === 'falls-limit',
      go ? go.d : null);
    chk('结算带上关卡号（面板要用）', !!go && typeof go.d.level === 'number', go ? go.d.level : null);
    chk('结算时分数/距离保留给面板', !!go && typeof go.d.score === 'number' && typeof go.d.distance === 'number');
    // 结算后不再被继续触发（幂等）
    const fallsAfter = g.falls;
    g._onBothWet();
    chk('已结算后重复调用不再计数', g.falls === fallsAfter, { falls: g.falls });

    // 过关 → 计数清零：下一关重新拥有 3 次机会
    {
      const g2 = makeGame(31337).g;
      g2.fallsSinceCP = 2;
      g2.level = 4; g2._levelStartX = g2.checkpoints.length ? g2.checkpoints[0].x : 0;
      g2.fallsSinceCP = 0;                       // 过关分支里的那句清零
      chk('过关后 fallsSinceCP 清零', g2.fallsSinceCP === 0);
      g2._onBothWet();
      chk('新的一关重新拥有 3 次机会（第 1 次不结算）', g2.state === 'playing', { state: g2.state });
    }
  }

  // ========== 5. 无存档点双落水：第 1 次回起始平台重打（r26 起每关 3 次） ==========
  console.log("\n[5] 无存档点双落水（r26：第 1 次回起始平台重打）");
  {
    const { g, events } = makeGame(777);
    const sp = g.platforms[0];
    const spx = sp.x + sp.w / 2;
    // 不推进 maxX，旗都没打过；直接触发双落水重开（r21：回起始平台）
    g._onBothWet();
    chk('没打过旗也不结算（回起始平台）', g.state === 'playing',
      { state: g.state });
    chk('抛出 respawn 事件', events.some(e => e.type === 'respawn'));
    chk('双猴回到起始平台且站稳',
      g.monkeys.every(m => m.grounded && m.wetT <= 0 && Math.abs(m.x - spx) < sp.w),
      { x0: g.monkeys[0].x, x1: g.monkeys[1].x, spx: spx.toFixed(0) });
    chk('没打过旗也没有 gameover', !events.some(e => e.type === 'gameover'));
  }

  // ========== 5.2 r25：推进多屏后双落水，重打起点平台必须还在 ==========
  // 线上实测（用户视频）：_genUntil 会清 camX-700 之前的平台，双落水传回很前面的
  // _levelStartX 时那里已无平台 -> 猴悬空 -> 再落水 -> 再传回，死循环。
  console.log('\n[5.2] 远途回档后重打起点地形仍在（r25）');
  {
    const { g } = makeGame(4242);
    g._genUntil(3200);              // 先生成到第一面旗（~2400）之后
    const cp = g.checkpoints[0];
    const cpX = cp.x;
    // 打卡过关：_levelStartX = cp.x（很前面的存档）
    const cpPlat = g.platformAt(cpX);
    const m0 = g.monkeys[0];
    m0.x = cpX; m0.y = cpPlat.y; m0.vx = 0; m0.vy = 0;
    m0.grounded = true; m0.wetT = 0; m0.stunT = 0;
    g.maxX = Math.max(g.maxX, cpX + 1);
    g.update(DT);
    if (g._levelStartX !== cpX) {   // 兜底：若打卡未触发则直接设（不掩盖后续断言）
      g._levelStartX = cpX;
    }
    // 模拟往前打了很多屏：camX 推远并触发地形清理
    g.camX = cpX + 6000;
    g._genUntil(g.camX + Core.CFG.W * 2);
    chk('回档起点平台未被清理', !!g.platformAt(g._levelStartX),
      { platforms: g.platforms.length, startX: g._levelStartX });
    // 双落水重开：猴必须落在真实平台面上（而不是悬空兜底点）
    dropBothInPit(g, cpX);
    g._onBothWet();
    chk('重开后两猴都站稳在真实平台上',
      g.monkeys.every(m => m.grounded && m.wetT <= 0 && !!g.platformAt(m.x)),
      { x0: g.monkeys[0].x.toFixed(0), x1: g.monkeys[1].x.toFixed(0),
        g0: g.monkeys[0].grounded, g1: g.monkeys[1].grounded });
    chk('重开后起点平台仍存在（可反复重打）', !!g.platformAt(g._levelStartX));
  }

  // ========== 5.5 r20 绳子绝对最大长度 ==========
  console.log('\n[5.5] r20 绳长绝对上限（硬投影）');
  {
    const Core2 = Core;
    const { g } = makeGame(2020);
    g.obstacles = []; g.winds = [];
    const A = g.monkeys[0], B = g.monkeys[1];
    // B 以接近终端速度下坠，绳的另一端锚在 A（悬空）
    A.grounded = false; A.wetT = 0; A.charging = false; A.stunT = 0;
    A.x = 300; A.y = 300; A.vx = 0; A.vy = 0;
    B.grounded = false; B.wetT = 0; B.charging = false; B.stunT = 0;
    B.x = 300; B.y = 300; B.vx = 0; B.vy = Core2.CFG.VY_MAX;   // 全速下坠
    const lim = Math.min(g.ropeRest() * Core2.CFG.ROPE_STRETCH, Core2.CFG.ROPE_MAX);
    let maxD = 0;
    for (let i = 0; i < 120; i++) {
      // 先积分重力（模拟 update 的下坠），再跑绳约束（与游戏帧序一致），约束后测绳长
      B.vy += Core2.CFG.GRAVITY * DT; B.y += B.vy * DT;
      g._rope(DT);
      maxD = Math.max(maxD, Math.hypot(B.x - A.x, B.y - A.y));
    }
    chk('高速下坠绳长也绝不超上限', maxD <= lim + 1, { maxD: maxD.toFixed(0), lim: lim.toFixed(0) });
  }

  // ========== 6. 弹性绳（r14：弹簧张力 + 拉起伙伴 + 硬收边界） ==========
  console.log('\n[6] 弹性绳');
  {
    const { g } = makeGame(99);
    const a = g.monkeys[0], b = g.monkeys[1];
    // 双悬空拉开 400px（rest 150 + 松弛带 90 → 真绷紧）
    a.x = 550; a.y = 300; a.vx = 0; a.vy = 0; a.grounded = false; a.wetT = 0; a.charging = false;
    b.x = 150; b.y = 300; b.vx = 0; b.vy = 0; b.grounded = false; b.wetT = 0; b.charging = false;
    g._rope(DT);
    const over = 400 - g.ropeRest() - Core.CFG.ROPE_SLACK;
    const F = Math.min(over * Core.CFG.ROPE_K, Core.CFG.ROPE_F_MAX);
    chk('绷紧出力：互相拉向对方', a.vx < 0 && b.vx > 0, { a: a.vx.toFixed(1), b: b.vx.toFixed(1) });
    chk('非按住方吃满张力', Math.abs(Math.abs(a.vx / DT) - F) < 1, (a.vx / DT).toFixed(1));

    // 松弛带内不出力（绳子是软的）
    a.x = 380; a.vx = 0; b.x = 150; b.vx = 0;   // 相距 230 < rest+slack
    g._rope(DT);
    chk('松弛带内不出力', a.vx === 0 && b.vx === 0, { a: a.vx, b: b.vx });

    // 拉起伙伴：b 站台上，a 起飞满按飞远 → 绳子绷紧把 b 拽离平台
    const g2 = makeGame(100).g;
    g2.obstacles = []; g2.winds = []; g2.pickups = [];
    const a2 = g2.monkeys[0], b2 = g2.monkeys[1];
    const p0 = g2.platforms.find(p => p.w >= 90);
    const p1 = g2.nextPlatform(p0.x + p0.w);
    b2.x = p0.x + p0.w / 2; b2.y = p0.y; b2.grounded = true; b2.wetT = 0; b2.stunT = 0; b2.hasJumped = true;
    a2.x = p1.x + p1.w / 2; a2.y = p1.y; a2.grounded = true; a2.wetT = 0; a2.stunT = 0; a2.hasJumped = true;
    g2.active = 0; g2.begun = true; g2.time = 1;
    g2.pressStart();                        // a2 起飞并一直按住（飞行拉远绳子）
    let lifted = false;
    for (let i = 0; i < 200 && !lifted; i++) { g2.update(DT); if (!b2.grounded && b2.wetT <= 0) lifted = true; }
    chk('飞高拉远把伙伴拽离平台（原版标志手感）', lifted, lifted);
    chk('抛出 lift 事件', g2Events(g2, 'lift'), g2Events(g2, 'lift'));

    // r16→r20 约束：超限后绳长被硬投影拉回上限圆（切向保留），拉力恒为张力上限
    const g3 = makeGame(101).g;
    const a3 = g3.monkeys[0], b3 = g3.monkeys[1];
    a3.x = 500; a3.y = 300; a3.vx = 0; a3.vy = 0; a3.grounded = false; a3.wetT = 0; a3.charging = false;
    b3.x = -100; b3.y = 300; b3.vx = 0; b3.vy = 0; b3.grounded = false; b3.wetT = 0; b3.charging = false;
    const d0 = Math.hypot(b3.x - a3.x, b3.y - a3.y);
    g3._rope(DT);
    const d1 = Math.hypot(b3.x - a3.x, b3.y - a3.y);
    const hardPull = Math.abs(a3.vx) / DT;
    chk('拉伸超限软约束：绳长回弹且拉力封顶',
      d1 < d0 && hardPull <= Core.CFG.ROPE_F_MAX * 1.05,
      { d0: d0.toFixed(0), d1: d1.toFixed(0), pull: hardPull.toFixed(0) });
  }

  // ========== 7. 快照往返 ==========
  console.log('\n[7] 快照往返');
  {
    const { g } = makeGame(555);
    g.falls = 2; g.bestCombo = 4; g.perfects = 5; g.golds = 3; g.combo = 2;
    g.coins = 7; g.rescues = 1; g.score = 123; g.distance = 45;
    const snap = g.snapshot();

    const g2 = new Core.Game({ seed: 555 });
    g2.applySnapshot(snap);
    chk('falls 同步', g2.falls === 2, g2.falls);
    chk('bestCombo 同步', g2.bestCombo === 4, g2.bestCombo);
    chk('perfects 同步', g2.perfects === 5, g2.perfects);
    chk('golds 同步', g2.golds === 3, g2.golds);
    chk('combo 同步', g2.combo === 2, g2.combo);
    chk('coins/rescues 同步', g2.coins === 7 && g2.rescues === 1);
  }

  // ========== 8. 二期：弹跳蘑菇 ==========
  console.log('\n[8] 弹跳蘑菇');
  {
    let g = null, sp = null, events = null;
    for (let seed = 1; seed <= 60 && !sp; seed++) {
      const t = makeGame(seed);
      t.g._genUntil(9000);
      sp = t.g.platforms.find(p => p.type === 'spring') || null;
      if (sp) { g = t.g; events = t.events; }
    }
    chk('60 个种子内能生成弹跳蘑菇', !!sp);
    if (sp) {
      // 伙伴要站在【相机能看到】的平台上：猴0 瞬移到蘑菇处后相机会跟过去，
      // 远处的起始平台会被裁剪掉，伙伴站在上面就会悬空落水（_wet 清连击搅浑现场）
      const nearPlat = g.platformAt(sp.x - sp.w - 10) || g.platformAt(sp.x + sp.w + 10);
      const m1 = g.monkeys[1];
      m1.x = nearPlat.x + nearPlat.w / 2; m1.y = nearPlat.y; m1.grounded = true;
      m1.wetT = 0; m1.stunT = 0; m1.charging = false; m1.hasJumped = true;
      g.obstacles = [];
      g.winds = [];   // 隔离变量：自由落体 0.6s 会被顺风吹出蘑菇台，这里只测蘑菇本身
      const m = g.monkeys[0];
      const comboBefore = 2;   // 先造一个连击，验证蘑菇不清零
      g.combo = comboBefore; g.bestCombo = comboBefore;
      // 断言窗口 = spring 事件发生那一瞬（事件回调里抓现场）。
      // 不能跑完整个 update 再看：弹起后猴子会飞去下一块平台，而
      // 被钓上来又落水的伙伴触发 _wet 会全局断连击（既有设计），会把水搅浑
      m.x = sp.x + sp.w / 2; m.y = sp.y - 60; m.vx = 0; m.vy = 100;
      m.grounded = false; m.wetT = 0; m.stunT = 0;
      const prevEmit = g.onEvent;
      let atSpring = null;
      g.onEvent = function (t, d) {
        if (t === 'spring') atSpring = { grounded: m.grounded, vy: m.vy, combo: g.combo, perfects: g.perfects };
        prevEmit(t, d);
      };
      let springFired = false;
      for (let i = 0; i < 120 && !springFired; i++) {
        g.update(DT);
        if (atSpring) springFired = true;
      }
      g.onEvent = prevEmit;
      chk('踩蘑菇抛出 spring 事件', springFired);
      chk('踩蘑菇自动弹起（不再 grounded）', !!atSpring && atSpring.grounded === false && atSpring.vy < -300,
        atSpring);
      // r13 契约：弹跳力度自适应——落在下一块平台中心附近，"踩垫=前进"，绝不陷阱
      const sp2 = g.platforms.find(q => q.type === 'spring');
      const nq = sp2 && g.nextPlatform(sp2.x + sp2.w);
      chk('弹跳力度=自适应落下一台', !!nq, nq ? 'ok' : 'no next');
      // 全程验证：弹起后继续跑，弹的那只猴必须落在下一块台上（不能掉水）。
      // 伙伴停泊成幽灵锚点（wetT=999 不参与物理），排除绳子互拽的干扰
      if (nq) {
        const o = g.monkeys[1];   // 伙伴固定停 1 号（active 此刻可能已切给 1）
        o.x = -800; o.y = 600; o.vx = 0; o.vy = 0; o.grounded = false; o.wetT = 999; o.stunT = 0; o.charging = false;
        // 注意抓"弹跳的那只猴"（m），弹起后 _autoSwitch 会把 active 切给伙伴
        const b = m;
        let done = false;
        for (let i = 0; i < 300 && !done; i++) {
          g.update(DT);
          if (b.grounded || b.wetT > 0) done = true;
        }
        chk('蘑菇弹跳落在下一块台上（不再陷阱）',
          b.grounded && b.x >= nq.x - 8 && b.x <= nq.x + nq.w + 8,
          { x: Math.round(b.x), wet: b.wetT > 0, nx: Math.round(nq.x), nw: nq.w });
      }
      chk('连击不被蘑菇清零', !!atSpring && atSpring.combo === comboBefore, atSpring && atSpring.combo);
      chk('不算完美着陆（不涨 combo）', !!atSpring && atSpring.combo === comboBefore && atSpring.perfects >= 0);
    }

    // 蘑菇上不刷障碍
    let bad = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const t = makeGame(seed);
      t.g._genUntil(9000);
      for (const p of t.g.platforms) {
        if (p.type !== 'spring') continue;
        if (t.g.obstacles.some(o => !o.dead && o.x >= p.x && o.x <= p.x + p.w)) bad++;
      }
    }
    chk('蘑菇平台上不刷障碍（60 种子）', bad === 0, { bad: bad });
  }

  // ========== 9. 二期：移动浮台 ==========
  console.log('\n[9] 移动浮台');
  {
    let g = null, fl = null;
    for (let seed = 1; seed <= 60 && !fl; seed++) {
      const t = makeGame(seed);
      t.g._genUntil(12000);
      fl = t.g.platforms.find(p => p.type === 'float') || null;
      if (fl) g = t.g;
    }
    chk('60 个种子内能生成移动浮台', !!fl);
    if (fl) {
      // 确定性巡逻：位置是时间的三角波，同种子同时间位置一致
      const t1 = makeGame(4321); t1.g._genUntil(12000); t1.g.start();
      const t2 = makeGame(4321); t2.g._genUntil(12000); t2.g.start();
      const f1 = t1.g.platforms.find(p => p.type === 'float');
      const f2 = t2.g.platforms.find(p => p.type === 'float');
      for (let i = 0; i < 200; i++) { t1.g.update(DT); t2.g.update(DT); }
      chk('浮台位置确定（同种子一致）', Math.abs(f1.x - f2.x) < 0.01,
        { x1: f1.x, x2: f2.x });
      chk('浮台在巡逻范围内', Math.abs(f1.x - f1.x0) <= f1.amp + 1,
        { dx: f1.x - f1.x0, amp: f1.amp });

      // 站在浮台上的猴子被载着走
      parkOther(g, 1);
      const m = g.monkeys[0];
      const f3 = g.platforms.find(p => p.type === 'float');
      m.x = f3.x0; m.y = f3.y; m.grounded = true; m.wetT = 0; m.stunT = 0; m.charging = false;
      m.progressX = m.x;
      g.active = 0;
      const mx0 = m.x;
      for (let i = 0; i < 90; i++) g.update(DT);
      chk('猴子跟着浮台一起移动', Math.abs(m.x - mx0) > 2,
        { moved: m.x - mx0 });
      // 兜底：浮台挪走后脚下没台子要开始下坠，不能悬空站着
      chk('脚下没台子会下坠（不会悬空挂机）', !m.grounded || !!g.platformAt(m.x));
    }
  }

  // ========== 10. 二期：山口阵风 ==========
  console.log('\n[10] 山口阵风');
  {
    let g = null, w = null;
    for (let seed = 1; seed <= 60 && !w; seed++) {
      const t = makeGame(seed);
      t.g._genUntil(12000);
      w = t.g.winds[0] || null;
      if (w) g = t.g;
    }
    chk('60 个种子内能生成阵风区', !!w);
    if (w) {
      // 空中受风：把猴放进风区自由落体，vx 朝风向漂
      // （先调成"常开"风，阵风节律本身在 [12] 单测）
      w.ph = 0; w.tOn = 99; w.tOff = 0.1;
      g.time = 1;
      parkOther(g, 1);
      const m = g.monkeys[0];
      m.x = (w.x0 + w.x1) / 2; m.y = Core.CFG.GROUND_Y - 120;
      m.vx = 0; m.vy = 20; m.grounded = false; m.wetT = 0; m.stunT = 0; m.charging = false;
      // 别让它落到平台上：挂在水面上方且不让 update 把它判湿（只跑少量帧）
      for (let i = 0; i < 40 && !m.grounded; i++) {
        m.y = Math.min(m.y, Core.CFG.GROUND_Y - 100);
        m.vy = Math.min(m.vy, 20);
        g.update(DT);
        m.grounded = false; m.wetT = 0;
      }
      chk('空中被风吹动（vx 朝风向）', Math.sign(m.vx) === Math.sign(w.fx) && Math.abs(m.vx) > 1,
        { vx: m.vx, fx: w.fx });

      // 落地无风：地面上不受力（vx 不变）
      // 注意：相机跟飞后起始平台可能被清理，必须放到现存平台上
      const gPlat = g.platforms.find(pp => pp.x + pp.w > g.camX + 60) || g.platforms[0];
      m.x = gPlat.x + gPlat.w / 2; m.y = gPlat.y; m.vx = 0; m.vy = 0;
      m.grounded = true; m.wetT = 0;
      const vxBefore = m.vx;
      for (let i = 0; i < 30; i++) g.update(DT);
      chk('地面不受风', m.vx === vxBefore, { vx: m.vx });

      // 瞄准线不骗人：projectLanding 数字积分含风，风区内外落点应有差异
      const g2 = makeGame(424242).g;
      g2._genUntil(12000);
      const w2 = g2.winds[0];
      if (w2) {
        const fromX = (w2.x0 + w2.x1) / 2, fromY = Core.CFG.GROUND_Y;
        const inWind = g2.projectLanding(fromX, 0.8, fromY);
        const saved = g2.winds; g2.winds = [];
        const noWind = g2.projectLanding(fromX, 0.8, fromY);
        g2.winds = saved;
        chk('有风/无风落点不同（瞄准线含风）', Math.abs(inWind - noWind) > 1,
          { inWind: inWind, noWind: noWind });
      }
    }
  }

  // ========== 11. 二期：结算带用时 + 山体主题 ==========
  console.log('\n[11] 用时统计 / 山体主题');
  {
    const { g, events } = makeGame(8080);
    for (let i = 0; i < 60; i++) g.update(DT);
    g._gameOver('both-wet');
    const overEv = events.filter(e => e.type === 'gameover').pop();
    chk('结算带用时（约 1s）', !!overEv && typeof overEv.d.time === 'number' && overEv.d.time >= 1,
      overEv && overEv.d.time);
    chk('主题表齐 5 档', Array.isArray(Core.THEMES) && Core.THEMES.length === 5,
      Core.THEMES && Core.THEMES.length);
    chk('主题带飘雪标记', Core.THEMES[4].snow === 1 && Core.THEMES[0].snow === 0);
  }

  // ========== 12. 七期：阵风节律 / 尖刺边缘 / 崖下垂荡 / 关卡差异化 ==========
  console.log('\n[12] 阵风节律 / 尖刺 / 垂荡 / 关卡差异化');
  {
    // 阵风节律：刮-停-刮，风力随时间变化
    const t1 = makeGame(9); t1.g._genUntil(9000);
    const w1 = t1.g.winds[0];
    chk('风区带节律字段（tOn/tOff/ph）', !!w1 && typeof w1.tOn === 'number' && typeof w1.tOff === 'number');
    if (w1) {
      w1.ph = 0;
      const wx = (w1.x0 + w1.x1) / 2;
      t1.g.time = 1;  const during = t1.g._windAt(wx);   // 刮风中段 = 全力
      t1.g.time = w1.tOn + w1.tOff / 2; const duringOff = t1.g._windAt(wx); // 停风 = 0
      t1.g.time = w1.tOn + w1.tOff + 3; const again = t1.g._windAt(wx);     // 下一轮又刮
      chk('刮风时有全力', Math.abs(during) > Core.CFG.WIND_F_MIN * 0.5, during);
      chk('停风时风力为 0', duringOff === 0, duringOff);
      chk('停完再次起风（循环节律）', Math.abs(again) > Core.CFG.WIND_F_MIN * 0.5, again);
    }

    // 尖刺只在平台外侧（落中间 = 安全）
    let midSpike = 0, totSpike = 0;
    for (let sd = 1; sd <= 40; sd++) {
      const t = new Core.Game({ seed: sd }); t.start(); t._genUntil(9000);
      for (const o of t.obstacles) {
        if (o.kind !== 'spike') continue;
        totSpike++;
        const pl = t.platforms.find(p => o.x >= p.x && o.x <= p.x + p.w);
        if (pl && (o.x - pl.x) / pl.w < Core.CFG.SPIKE_EDGE - 0.04) midSpike++;
      }
    }
    chk('尖刺全部在平台外侧 28%（40 种子）', totSpike > 0 && midSpike === 0,
      { totSpike, midSpike });

    // 撞尖刺扣分
    {
      const { g } = makeGame(31337);
      parkOther(g, 1);
      g.obstacles = [{ kind: 'spike', x: g.monkeys[0].x + 8, y: g.monkeys[0].y, w: 22, h: 12, dead: false }];
      g.bonus = 100;
      g.update(DT);
      chk('撞尖刺扣 20 分', g.bonus === 100 - Core.CFG.HIT_PENALTY, g.bonus);
      chk('撞尖刺短晕（0.3s，不再 0.55s）', g.monkeys[0].stunT > 0 && g.monkeys[0].stunT <= 0.35,
        g.monkeys[0].stunT);
    }

    // 崖下垂荡：湿猴不沉底，贴水面荡
    {
      const { g } = makeGame(4141);
      parkOther(g, 1);
      const m = g.monkeys[0];
      // 让猴0落水且无人能救（伙伴被远远停泊）
      m.x = 500; m.y = Core.CFG.GROUND_Y - 100; m.vx = 0; m.vy = 200;
      m.grounded = false; m.wetT = 0;
      // 移走 500 附近的平台，让它真落水
      g.platforms = g.platforms.filter(p => !(500 >= p.x - 20 && 500 <= p.x + p.w + 20) || p.type === 'start');
      let wet = false;
      for (let i = 0; i < 240 && !wet; i++) { g.update(DT); if (m.wetT > 0) wet = true; }
      chk('落水进入湿状态', wet);
      if (wet) {
        let minSunk = 1e9, maxSunk = -1e9;
        for (let i = 0; i < 120; i++) {   // 漂 2 秒
          g.update(DT);
          const sunk = m.y - Core.CFG.WATER_Y;
          if (m.wetT > 0) { minSunk = Math.min(minSunk, sunk); maxSunk = Math.max(maxSunk, sunk); }
        }
        chk('湿猴挂绳吊在伙伴下方（水面 -70 ~ +20px 内），不再无限下沉',
          minSunk > -70 && maxSunk < 32, { min: minSunk.toFixed(1), max: maxSunk.toFixed(1) });
        // 单摆特性：与锚点（伙伴）距离不超过绳长
        const other = g.monkeys[1];
        const dd = Math.hypot(m.x - other.x, m.y - other.y);
        chk('绳长约束生效（距锚点 ≤ ROPE_REST + 4）',
          dd <= Core.CFG.ROPE_REST + 4, dd.toFixed(1));
      }
    }

    // 关卡差异化：空档/宽度方差变大 + 可达性硬顶
    const gaps = [], pws = [];
    for (let sd = 1; sd <= 20; sd++) {
      const t = new Core.Game({ seed: sd }); t.start(); t._genUntil(15000);
      for (let i = 2; i < t.platforms.length; i++) {
        gaps.push(t.platforms[i].x - (t.platforms[i - 1].x + t.platforms[i - 1].w));
        pws.push(t.platforms[i].w);
      }
    }
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const sdN = a => Math.sqrt(a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / a.length);
    chk('空档差异化（标准差 > 30，旧版 ≈17）', sdN(gaps) > 30, Math.round(sdN(gaps)));
    chk('平台宽度差异化（标准差 > 22，旧版 ≈16）', sdN(pws) > 22, Math.round(sdN(pws)));
    chk('可达性硬顶：空档 ≤ 150（r12 收紧）', Math.max(...gaps) <= 150, Math.max(...gaps));

    // r14 飞行燃料：按住时长封顶 FLY_TIME，不再有蓄力回滚
    {
      const { g } = makeGame(606);
      const m = g.monkeys[g.active];
      g.winds = [];
      m.charging = true; m.chargeT = 1.65;   // 远超 FLY_TIME
      chk('飞行燃料封顶不回滚', g._effPower(m) === 1, g._effPower(m).toFixed(3));
      m.chargeT = Core.CFG.FLY_TIME / 2;
      chk('半程燃料 = 0.5', Math.abs(g._effPower(m) - 0.5) < 0.01, g._effPower(m).toFixed(3));
      m.charging = false;
    }

    // r14 按下即起飞 / 按住上升 / 松手快落
    {
      const { g } = makeGame(607);
      g.obstacles = []; g.winds = []; g.pickups = [];
      const m = g.monkeys[g.active];
      const o = g.monkeys[1 - g.active];
      o.x = -800; o.y = 600; o.vx = 0; o.vy = 0; o.grounded = false; o.wetT = 999; o.stunT = 0; o.charging = false;
      m.grounded = true; m.wetT = 0; m.stunT = 0;
      const y0 = m.y;
      g.pressStart();                        // 按下：立刻起飞
      chk('按下立刻起飞', !m.grounded && m.vy < 0, { grounded: m.grounded, vy: m.vy.toFixed(0) });
      for (let i = 0; i < 24; i++) g.update(DT);   // 按住 0.4s
      chk('按住持续上升', m.charging && m.vy < 0, { vy: m.vy.toFixed(0) });
      chk('上升高度超过起跳点', m.y < y0 - 40, Math.round(y0 - m.y));
      const vyHold = m.vy;
      g.pressEnd();                          // 松手
      chk('松手停止上升', !m.charging, m.charging);
      for (let i = 0; i < 12; i++) g.update(DT);
      chk('松手进入快速下落', m.vy > 100, m.vy.toFixed(0));
    }

    // r14 按多久飞多远：点按 vs 满按的水平位移差
    {
      const g = makeGame(608).g;
      const dTap = g.projectLanding(300, 0.05, Core.CFG.GROUND_Y, Core.CFG.WATER_Y) - 300;
      const dFull = g.projectLanding(300, Core.CFG.FLY_TIME, Core.CFG.GROUND_Y, Core.CFG.WATER_Y) - 300;
      chk('按多久飞多远（满按比点按远一倍以上）', dFull > dTap * 2, { tap: Math.round(dTap), full: Math.round(dFull) });
      chk('满按位移覆盖最大坑距（>150）', dFull > 150, Math.round(dFull));
    }

    // 落点预测与实际一致（风区里也要准：预测的风必须随飞行时间演进）
    {
      const { g } = makeGame(777);
      g._genUntil(9000);
      g.winds = [];
      const plat = g.platforms[1];
      const other = g.monkeys[1];
      other.grounded = false; other.wetT = 999;   // 幽灵锚点：绳子/拉起逻辑都不干扰这一跳
      other.x = plat.x - 400; other.y = plat.y;
      const m = g.monkeys[0];
      m.grounded = true; m.wetT = 0; m.stunT = 0;
      m.x = plat.x + plat.w / 2; m.y = plat.y; m.vx = 0; m.vy = 0;
      // 手工造一个常开强风区盖住跳跃路径
      g.winds = [{ x0: plat.x + plat.w, x1: plat.x + plat.w + 600, fx: 170, tOn: 99, tOff: 0.1, ph: 0 }];
      const hold = 0.72;
      const predicted = g.projectLanding(m.x, hold, m.y);
      g.active = m.idx;                      // pressStart 打的是 active 猴，别打到泊远的伙伴
      g.pressStart();                        // 起飞并按住 hold 秒
      // 用 autoFly 让飞行在 hold 秒后自动松手（与 pressStart 同一物理）
      g.monkeys[g.active].autoFly = hold;
      // 落台或落水都算"落点"：预测的终止条件就是水面，两者一致才说明瞄准线不骗人
      let landed = null;
      g.onEvent = function (t, d) {
        if ((t === 'land' || t === 'wet') && landed == null) landed = d.x;
      };
      for (let i = 0; i < 900 && landed == null; i++) g.update(DT);
      chk('落点预测可执行（落到了某处）', landed != null, landed);
      if (landed != null) {
        const err = Math.abs(landed - predicted);
        chk('落点预测与实际一致（风区，误差 < 20px）', err < 20, err.toFixed(1));
      }
    }

    // 平台边缘容差：中心略出边缘也能落住
    {
      const { g } = makeGame(808);
      const m = g.monkeys[0];
      const plat = g.platformAt(g.monkeys[0].x) || g.platforms[0];
      m.x = plat.x - 4;                 // 中心在平台左缘外 4px（容差 7 内）
      m.y = plat.y - 40; m.vx = 0; m.vy = 60;
      m.grounded = false; m.wetT = 0;
      for (let i = 0; i < 60 && !m.grounded; i++) g.update(DT);
      chk('边缘着陆容差生效（中心出缘 4px 仍落住）', m.grounded, { x: m.x.toFixed(1), y: m.y.toFixed(1) });
    }

    // r21：耐心机制废除——湿猴挂绳等救永不超时（另一只存活就不结算）
    {
      const { g, events } = makeGame(909);
      g._genUntil(3200);   // r21：旗间距 2200，先生成地形才有旗和平台
      const cp0 = g.checkpoints[0];
      const m = g.monkeys[0];
      const other = g.monkeys[1];
      const p0 = g.platformAt(cp0.x);
      other.grounded = true; other.x = cp0.x + 10; other.y = p0.y;
      other.wetT = 0; other.stunT = 0;
      g.maxX = cp0.x + 1; g.update(DT);    // 打卡（顺带验证 level+1）
      chk('站台面越旗过关：level+1', cp0.passed && g.level === 2, { passed: cp0.passed, level: g.level });
      m.grounded = false; m.x = p0.x + p0.w + 30; m.y = Core.CFG.WATER_Y - 30;
      m.vx = 0; m.vy = 0; m.wetT = 5; m.wetRescueDelay = 99;
      g.winds = [];
      for (let i = 0; i < 600; i++) g.update(DT);   // 挂绳 10 秒
      chk('湿猴挂绳 10 秒仍在等救（永不耗尽）',
        m.wetT > 0 && !m.grounded && g.state === 'playing',
        { wetT: m.wetT, grounded: m.grounded, state: g.state });
      chk('期间没有任何 respawn/gameover', !events.some(e => e.type === 'respawn' || e.type === 'gameover'));
    }

    // r14：空中按下不再触发任何动作（无蓄力/缓冲，防误触）
    {
      const { g } = makeGame(1101);
      const m = g.monkeys[g.active];
      g.winds = [];
      m.grounded = false; m.vx = 0; m.vy = 300; m.wetT = 0; m.charging = false;
      g.pressStart();
      chk('空中按下不触发起飞', !m.charging, m.charging);
    }

    // r14：落地瞬间地面按下立即再起飞（连按节奏流畅）
    {
      const { g } = makeGame(1202);
      const m = g.monkeys[g.active];
      g.winds = [];
      const plat = g.platformAt(m.x) || g.platforms[0];
      m.x = plat.x + plat.w / 2; m.y = plat.y - 20;
      m.grounded = false; m.vx = 0; m.vy = 150; m.wetT = 0; m.charging = false;
      let landed = false;
      for (let i = 0; i < 120 && !landed; i++) { g.update(DT); if (m.grounded) landed = true; }
      chk('落地成功', landed, m.grounded);
      const m2 = g.monkeys[g.active];   // 落地后 _autoSwitch 可能换人，抓当前的
      g.pressStart();
      chk('落地后按下立即再起飞', !m2.grounded && m2.vy < 0, { grounded: m2.grounded, vy: m2.vy.toFixed(0) });
    }

    // 回归(r11→r14)：按住飞行中的 A 不许被 _autoSwitch 抢棒
    {
      const { g } = makeGame(1303);
      g.obstacles = []; g.winds = []; g.pickups = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      const place = (m, p) => { m.x = p.x + p.w / 2; m.y = p.y; m.vx = 0; m.vy = 0;
        m.grounded = true; m.wetT = 0; m.stunT = 0; m.charging = false; };
      place(A, g.platforms[5]); place(B, g.platforms[1]);
      A.hasJumped = true; B.hasJumped = true;
      A.progressX = A.x; B.progressX = B.x;
      g.active = 0; g.begun = true;
      const startX = A.x;                    // 起跳前取起点（按住飞行本身就是前进过程）
      g.pressStart();                        // A 起飞并按住
      let stolen = false;
      for (let i = 0; i < 60; i++) { g.update(DT); if (g.active !== 0) { stolen = true; break; } }
      chk('r14 按住飞行中不被抢棒', !stolen, { active: g.active });
      chk('r14 飞行仍在进行', A.charging && A.chargeT > 0, A.chargeT.toFixed(2));
      g.pressEnd();
      // 前猴正常起跳前冲（固定落点会被地形坑掉，断言"起跳且前冲"）
      let maxX = startX, flew = false;
      for (let i = 0; i < 300; i++) {
        g.update(DT);
        if (!A.grounded) flew = true;
        maxX = Math.max(maxX, A.x);
      }
      chk('r14 前猴起跳正常前冲', flew && maxX > startX + 100,
        { flew: flew, adv: Math.round(maxX - startX) });
    }

    // r14：绳子张力有上限（直接测 _rope 单步，排除硬收瞬移的位移量）
    {
      const { g } = makeGame(1404);
      g.obstacles = []; g.winds = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      A.grounded = false; A.x = 900; A.y = 400; A.vx = 0; A.vy = 0; A.wetT = 0; A.charging = false;
      B.grounded = false; B.x = 200; B.y = 400; B.vx = 0; B.vy = 0; B.wetT = 0; B.charging = false;
      g._rope(DT);
      const pull = Math.abs(A.vx) / DT;
      chk('绳子张力不超过绝对上限', pull <= 2000 * 1.05, pull.toFixed(0));
      // 锚定阶段：伙伴还在地面，飞行猴只感受"能拽起伙伴"的小力
      B.grounded = true; B.x = 200; B.y = 400; B.vx = 0; B.vy = 0;
      A.x = 640; A.y = 300; A.vx = 0; A.vy = 0; A.charging = true;   // d=440，不超弹性上限
      g._rope(DT);
      const pull2 = Math.abs(A.vx) / DT;
      chk('锚定期按住方只吃小份额张力', pull2 <= Core.CFG.LIFT_T * 1.5 * Core.CFG.ROPE_FLYER_SHARE + 1, pull2.toFixed(0));
    }

    // ---- r15：水面乌龟浮台 ----
    {
      // 生成契约：够宽的坑里会刷乌龟，位置在坑中间、贴水面
      let total = 0, shapeOK = true;
      for (let sd = 1; sd <= 6; sd++) {
        const { g } = makeGame(sd * 77);
        g._genUntil(g.camX + 4200);
        for (const tp of g.platforms.filter(pp => pp.type === 'turtle')) {
          total++;
          if (Math.abs(tp.y0 - (Core.CFG.WATER_Y - 12)) > 1) shapeOK = false;
          if (tp.w !== Core.CFG.TURTLE_W) shapeOK = false;
        }
      }
      chk('乌龟会在宽坑里生成', total >= 1, total);
      chk('乌龟属性正确（贴水面/龟背宽）', shapeOK);
    }
    {
      // 落龟背：下落到乌龟上方 -> 站住且跟着起伏
      const { g } = makeGame(1515);
      g.obstacles = []; g.winds = [];
      parkOther(g, 1);
      const m = g.monkeys[0];
      const tur = { x: 700, w: Core.CFG.TURTLE_W, y: Core.CFG.WATER_Y - 12, y0: Core.CFG.WATER_Y - 12, type: 'turtle', bobA: 5, bobSpd: 1.2, ph: 0 };
      g.platforms.push(tur);
      m.x = tur.x + tur.w / 2; m.y = tur.y - 80; m.vx = 0; m.vy = 0;
      m.grounded = false; m.wetT = 0; m.stunT = 0; m.charging = false;
      g.active = m.idx;
      let landed = false;
      for (let i = 0; i < 120; i++) {
        g.update(DT);
        if (m.grounded) { landed = true; break; }
      }
      const under = g.platformAt(m.x, 7);
      chk('跳短了能落上乌龟救生台', landed && under && under.type === 'turtle',
        { landed: landed, under: under && under.type });
      // 起伏：乌龟 y 随时间变化，站着的猴贴着台面
      const y1 = tur.y;
      for (let i = 0; i < 30; i++) g.update(DT);
      chk('乌龟随波起伏', Math.abs(tur.y - y1) > 0.5, Math.abs(tur.y - y1).toFixed(2));
      chk('站龟猴贴台面', m.grounded && Math.abs(m.y - tur.y) < 1.5,
        { my: m.y.toFixed(1), ty: tur.y.toFixed(1) });
    }

    // ---- r15：关卡里程碑（每 500m 进一关）----
    {
      const { g, events } = makeGame(1616);
      g.obstacles = []; g.winds = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      A.grounded = false; B.grounded = false; A.wetT = 999; B.wetT = 999;
      A.charging = B.charging = false; A.stunT = B.stunT = 0;
      A.x = B.x = 1400; A.y = B.y = 300; A.vx = B.vx = 0; A.vy = B.vy = 0;
      // r21：里程碑换关已废除——过关只由过关旗驱动；纯距离推进不再触发任何换关事件
      g.update(DT); g.update(DT);
      chk('纯距离推进不再触发 milestone', !events.some(e => e.type === 'milestone'),
        events.map(e => e.type));
      chk('关卡数只由过关旗驱动（仍为 1）', g.level === 1, g.level);
    }

    // ---- r15 实机视频修复回归 ----
    {
      // 修复C：浮台/乌龟上不刷障碍（台子移走后障碍会悬空）
      let bad = 0;
      for (let sd = 1; sd <= 8; sd++) {
        const { g } = makeGame(sd * 313);
        g._genUntil(g.camX + 6000);
        for (const o of g.obstacles) {
          const under = g.platformAt(o.x);
          if (!under || (under.type !== 'normal' && under.type !== 'ice' && under.type !== 'start')) bad++;
        }
      }
      chk('障碍只刷在静态平台上（浮台/乌龟不刷）', bad === 0, bad);
    }
    {
      // 修复D：两猴远距时相机聚焦操作猴（不再被裁出屏幕左缘）
      const { g } = makeGame(1717);
      g.obstacles = []; g.winds = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      A.grounded = true; A.x = 400; A.y = Core.CFG.GROUND_Y; A.vx = A.vy = 0;
      A.wetT = 0; A.stunT = 0; A.charging = false;
      B.grounded = true; B.x = 1400; B.y = Core.CFG.GROUND_Y; B.vx = B.vy = 0;
      B.wetT = 0; B.stunT = 0; B.charging = false;
      g.active = 0;          // 操作的是落后猴 A，两猴距 1000px 超过屏宽 375
      for (let i = 0; i < 90; i++) g.update(DT);
      const rel = A.x - g.camX;
      chk('大差距时操作猴留在画面内', rel > 20 && rel < Core.CFG.W - 20,
        { rel: rel.toFixed(0), W: Core.CFG.W });
    }
    {
      // 修复E：同刻多条浮字往上错位，不叠成一坨
      const { g } = makeGame(1818);
      g._float(500, 300, '甲', '#fff');
      g._float(500, 300, '乙', '#fff');
      g._float(500, 300, '丙', '#fff');
      const ys = g.floatTexts.slice(-3).map(f => f.y);
      chk('浮字同刻自动错位', ys[0] === 300 && ys[1] === 274 && ys[2] === 248, ys);
    }

    // ---- r16：绳子物理对标原版 ----
    {
      // 软绳长约束：绷满后位置拉回圆上，切向速度保留（荡而不是对撞）
      const { g } = makeGame(1919);
      g.obstacles = []; g.winds = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      const rest = g.ropeRest(), smax = rest * Core.CFG.ROPE_STRETCH;
      A.grounded = false; B.grounded = false; A.wetT = B.wetT = 0;
      A.stunT = B.stunT = 0; A.charging = B.charging = false;
      A.x = 100; A.y = 400; A.vx = 0; A.vy = 0;
      B.x = 100 + smax + 120; B.y = 400; B.vx = 0; B.vy = 0;
      // B 带纯切向速度（垂直于绳），约束后应保留
      B.vx = 0; B.vy = -200;
      // r20 硬投影：本帧内即收回限内
      for (let i = 0; i < 30; i++) g._rope(DT);
      const d1 = Math.sqrt((B.x - A.x) ** 2 + (B.y - A.y) ** 2);
      chk('绷满后绳长约束回弹性上限内', d1 <= smax + 1, { d: d1.toFixed(0), smax: smax.toFixed(0) });
      chk('切向速度保留（能荡起来）', Math.abs(B.vy) > 50, B.vy.toFixed(0));
      // 纯径向向外速度应被消掉（摆位以 A 当前位置为基准，保证真的绷满）
      B.x = A.x + smax + 60; B.y = A.y; B.vy = 0;
      B.vx = 300;   // 沿绳向外（B 在 A 右侧，+x 向外）
      g._rope(DT);
      chk('向外径向速度被消掉', B.vx <= 1, B.vx.toFixed(1));
    }
    {
      // lift 甩出：被拽起的猴获得朝前进方向（+x）的切向速度
      const { g } = makeGame(2020);
      g.obstacles = []; g.winds = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      const rest = g.ropeRest();
      A.grounded = true; A.x = 200; A.y = 430; A.vx = A.vy = 0; A.wetT = 0; A.stunT = 0;
      B.grounded = false; B.x = 200 + rest + 60; B.y = 430 - 260; B.vx = 0; B.vy = 0;
      B.wetT = 0; B.stunT = 0; B.charging = false;
      g._rope(DT);
      chk('张力把地面伙伴拽起（lift）', g2Events(g, 'lift') && !A.grounded);
      chk('被拽起的猴朝前甩（vx>0）', A.vx > 0, A.vx.toFixed(0));
    }
    {
      // 确定性：同 seed 同输入序列，两实例逐帧状态完全一致（联机两端一致的前提）
      const inputs = [];
      for (let f = 0; f < 300; f++) {
        if (f % 40 === 0) inputs.push(f % 80 === 0 ? 'down' : 'up');
      }
      const run = () => {
        const { g } = makeGame(4242);
        for (let f = 0; f < 300; f++) {
          const op = inputs[f];
          if (op === 'down') g.pressStart();
          if (op === 'up') g.pressEnd();
          g.update(DT);
        }
        return g.monkeys.map(m => Math.round(m.x * 10) + ',' + Math.round(m.y * 10)).join('|') + '#' + g.distance;
      };
      chk('同 seed 同输入逐帧一致（确定性）', run() === run());
    }

    // ---- r16b：实机视频修复回归 ----
    {
      // 修复A/C：respawn 两猴错开 + 落点附近障碍清掉
      const { g } = makeGame(2121);
      g.obstacles = []; g.winds = [];
      g.obstacles.push({ kind: 'piranha', x: g.monkeys[0].x + 20, y: 430, w: 26, h: 26, dead: false });
      g.obstacles.push({ kind: 'bear', x: g.monkeys[0].x + 300, y: 430, w: 26, h: 26, dead: false });
      const cpX = g.monkeys[0].x;
      g._respawnAt({ x: cpX });
      const ms2 = g.monkeys;
      chk('respawn 两猴错开', Math.abs(ms2[0].x - ms2[1].x) >= 40, Math.abs(ms2[0].x - ms2[1].x));
      chk('落点 ±90 内障碍已清除',
        g.obstacles[0].dead === true && g.obstacles[1].dead === false);
      chk('respawn 后两猴站稳', ms2[0].grounded && ms2[1].grounded);
    }
    {
      // r19：自动收绳废除——A 站台不动，B 挂绳吊着，永远不会被"自动拉上岸"（救援只能靠跳跃带上台）
      const { g } = makeGame(2222);
      g.obstacles = []; g.winds = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      const plat = g.platforms.find(pp => pp.x + pp.w > 400 && pp.w >= 90);
      B.x = plat.x + plat.w / 2; B.y = plat.y; B.grounded = true; B.wetT = 0;
      A.x = B.x; A.y = plat.y + 100; A.grounded = false; A.wetT = 5.5;
      A.wetRescueDelay = 0; A.vx = A.vy = 0; A.stunT = 0; A.charging = false;
      B.stunT = 0; B.charging = false;
      g.active = B.idx;
      let minY = 1e9, rescued = false;
      for (let i = 0; i < 240; i++) {   // 4s < PATIENCE 5.5s
        g.update(DT);
        minY = Math.min(minY, A.y);
        if (A.grounded && A.wetT <= 0) rescued = true;
      }
      chk('自动收绳已废除（站着不动不会把湿猴拉上岸）', !rescued && A.wetT > 0 && !A.grounded,
        { rescued: rescued, wetT: A.wetT.toFixed(1) });
      chk('挂绳期间湿猴从未被拉到台面上方', minY > plat.y, (minY - plat.y).toFixed(1));
    }

    // ---- r16c：救援去重叠 + 落地保护 ----
    {
      // 救援后两猴错开、都在台上（不再"猴消失"）
      const { g } = makeGame(2323);
      g.obstacles = []; g.winds = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      const plat = g.platforms.find(pp => pp.x + pp.w > 400 && pp.w >= 110);
      B.x = plat.x + plat.w / 2; B.y = plat.y; B.grounded = true; B.wetT = 0; B.stunT = 0; B.charging = false;
      A.x = B.x; A.y = plat.y - 80; A.grounded = false; A.wetT = 5.5;   // r19：被跳跃甩到台上空再落下
      A.wetRescueDelay = 999; A.vx = 0; A.vy = 30; A.stunT = 0; A.charging = false;
      g.active = B.idx;
      let rescued = false;
      for (let i = 0; i < 400 && !rescued; i++) {
        g.update(DT);
        rescued = A.grounded && A.wetT <= 0;
      }
      const sep = Math.abs(A.x - B.x);
      const onPlat = [A, B].every(m => g.platformAt(m.x) === plat);
      chk('救援后两猴错开（不再叠成一只）', rescued && sep >= 30, { rescued: rescued, sep: Math.round(sep) });
      chk('救援后两猴都在台上', onPlat, onPlat);
      chk('被救猴带落地保护', A.rescueGuard > 0 || rescued, A.rescueGuard && A.rescueGuard.toFixed(2));
      // 保护期内按下不起飞（防"钓上来就飞出去"循环）
      g.active = A.idx;
      const y0 = A.y;
      g.pressStart();
      let flew = !A.grounded;
      chk('保护期内按下不起飞', !flew && A.y === y0, { flew: flew });
      // 保护期过后恢复
      for (let i = 0; i < 70; i++) g.update(DT);
      g.pressStart();
      chk('保护期后恢复正常起跳', !A.grounded, A.grounded);
      g.pressEnd();
    }
    {
      // 单人模式救援时强制松手（玩家按着钓猴不放的场景）
      const { g } = makeGame(2424);
      g.obstacles = []; g.winds = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      B.charging = true;   // 玩家钓猴时按着屏
      g._rescued(A, g.platforms[1]);
      chk('救援时强制断开按住状态', !A.charging && !B.charging);
    }

    // ---- r17：被伙伴带着甩上台也算救援（实机视频：台上猴起跳把湿猴荡上台，却没判救援） ----
    {
      // 场景1：湿猴被甩到台顶上方后落下来 —— 穿过台面那一刻判救援，落在哪站哪
      const { g } = makeGame(3434);
      g.obstacles = []; g.winds = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      const plat = g.platforms.find(pp => pp.w >= 120);
      B.x = plat.x + plat.w / 2; B.y = plat.y; B.grounded = true; B.wetT = 0; B.stunT = 0;
      B.charging = true;   // 玩家还按着屏（正在飞、带着 A 甩的动作本身），r17 不许被掐断
      A.x = plat.x + plat.w / 2; A.y = plat.y - 80; A.grounded = false; A.wetT = 5.5;
      A.wetRescueDelay = 999; A.vx = 0; A.vy = 30; A.stunT = 0; A.charging = false;
      const rescues0 = g.rescues;
      let rescued = false;
      for (let i = 0; i < 120 && !rescued; i++) { g.update(DT); rescued = A.grounded && A.wetT <= 0; }
      chk('被甩上台=判定救援（不用收绳，+30）', rescued && g.rescues === rescues0 + 1,
        { rescued: rescued, rescues: g.rescues - rescues0 });
      chk('被救猴落在目标台上', g.platformAt(A.x) === plat && Math.abs(A.y - plat.y) < 1,
        { x: Math.round(A.x), y: Math.round(A.y) });
      chk('甩上台救援也带落地保护', A.rescueGuard > 0, A.rescueGuard && A.rescueGuard.toFixed(2));
      chk('伙伴正在飞的按住状态不被打断', B.charging === true, B.charging);
    }
    {
      // 场景2：从台面下往上穿（荡过头）不判救援；荡回来落上台面才判
      const { g } = makeGame(3535);
      g.obstacles = []; g.winds = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      const plat = g.platforms.find(pp => pp.w >= 120);
      B.x = plat.x + plat.w / 2; B.y = plat.y + 110; B.grounded = true; B.wetT = 0; B.stunT = 0; B.charging = false;
      A.x = plat.x + plat.w / 2; A.y = plat.y + 15; A.grounded = false; A.wetT = 5.5;
      A.wetRescueDelay = 999; A.vx = 0; A.vy = -1200; A.stunT = 0; A.charging = false;
      g._rope(DT);
      chk('从下往上穿台面不判救援（还在荡）', A.wetT > 0 && !A.grounded, { y: Math.round(A.y), wetT: A.wetT.toFixed(1) });
      let rescued = false;
      for (let i = 0; i < 240 && !rescued; i++) { g._rope(DT); rescued = A.grounded && A.wetT <= 0; }
      chk('荡回来落到台面那一刻判救援', rescued, { grounded: A.grounded, wetT: A.wetT.toFixed(1), y: Math.round(A.y) });
    }
    {
      // 场景3：差一点落在台缘外 —— 不算救援，继续湿挂等收绳
      const { g } = makeGame(3636);
      g.obstacles = []; g.winds = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      const plat = g.platforms.find(pp => pp.w >= 120);
      const ax0 = plat.x - 30;
      B.x = ax0; B.y = plat.y + 110; B.grounded = true; B.wetT = 0; B.stunT = 0; B.charging = false;
      A.x = ax0; A.y = plat.y - 40; A.grounded = false; A.wetT = 5.5;
      A.wetRescueDelay = 999; A.vx = 60; A.vy = 100; A.stunT = 0; A.charging = false;
      for (let i = 0; i < 60; i++) g._rope(DT);
      chk('落在台缘外不算救援（继续荡）', A.wetT > 0 && !A.grounded, { x: Math.round(A.x), y: Math.round(A.y) });
    }

    // ---- r19：检查点必须"站上台面"才打卡 + 生成频率减半 ----
    {
      // 场景1：两猴在平台上空飞过旗面（上升段，不会落地）——不触发
      const { g } = makeGame(3838);
      g.obstacles = []; g.winds = [];
      g._genUntil(3200);   // r21：旗间距 2200，先生成地形
      const cp = g.checkpoints[0];
      const A = g.monkeys[0], B = g.monkeys[1];
      A.grounded = false; A.wetT = 0; A.stunT = 0; A.charging = false;
      A.x = cp.x + 10; A.y = 430; A.vx = 0; A.vy = -300;
      B.grounded = false; B.wetT = 0; B.stunT = 0; B.charging = false;
      B.x = cp.x + 30; B.y = 430; B.vx = 0; B.vy = -300;
      g.update(DT);
      chk('平台上空越过旗面不触发检查点', !cp.passed, cp.passed);
      // 站上台面（旗子所在平台）越过旗位——触发
      const plat = g.platformAt(cp.x);
      A.x = cp.x + 10; A.y = plat.y; A.grounded = true;
      g.update(DT);
      chk('站上台面越过旗位才触发检查点', cp.passed, cp.passed);
    }
    {
      // 场景2：湿挂（即将落水）越过旗面——不触发
      const { g } = makeGame(3939);
      g.obstacles = []; g.winds = [];
      g._genUntil(3200);   // r21：旗间距 2200，先生成地形
      const cp = g.checkpoints[0];
      const A = g.monkeys[0], B = g.monkeys[1];
      const plat = g.platformAt(cp.x);
      B.grounded = true; B.wetT = 0; B.stunT = 0; B.charging = false;
      B.x = plat.x + 12; B.y = plat.y;   // 旗子前站位（x < cp.x），不构成触发
      A.grounded = false; A.wetT = 5.5; A.stunT = 0; A.charging = false;
      A.wetRescueDelay = 999; A.x = cp.x + 10; A.y = plat.y + 100; A.vx = 0; A.vy = 0;
      g.update(DT);
      chk('湿挂状态下越过旗面不触发检查点', !cp.passed, cp.passed);
      chk('检查点间距 ≥ 480px（频率减半）', Core.CFG.CP_SPACING >= 480, Core.CFG.CP_SPACING);
    }

    // 版本号
    chk('导出版本号', typeof Core.VERSION === 'string' && /^v\d{4}/.test(Core.VERSION), Core.VERSION);
  }

  console.log('\n========================================');
  console.log('core-game: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
