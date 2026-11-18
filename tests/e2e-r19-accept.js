/** r19 本地视觉验收：1) A站台B湿挂不被自动拉上来 2) 跳跃把B甩上台判救援 3) 检查点空中经过不触发 */
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:8790/index.html', { waitUntil: 'networkidle' });
  await page.evaluate(() => window.GLH.startSolo());
  await page.waitForTimeout(800);

  const r = await page.evaluate(async () => {
    const DT = 1 / 60;
    const g = window.GLH.game;
    const out = {};
    // —— 场景1：A 站台，B 湿挂 4 秒，不自动救援 ——
    {
      const A = g.monkeys[0], B = g.monkeys[1];
      const plat = g.platformAt(A.x) || g.platforms[1];
      A.x = plat.x + plat.w / 2; A.y = plat.y; A.grounded = true; A.wetT = 0; A.stunT = 0; A.vx = 0; A.vy = 0;
      B.grounded = false; B.wetT = 5.5; B.wetRescueDelay = 99;
      B.x = plat.x + 30; B.y = plat.y + 120; B.vx = 0; B.vy = 0;
      let minY = B.y;
      for (let i = 0; i < 240; i++) { g.update(DT); minY = Math.min(minY, B.y); }
      out.s1 = { rescued: B.grounded && B.wetT <= 0, wetStill: B.wetT > 0, minYAbovePlat: minY < plat.y - 7 };
    }
    // —— 场景2：跳跃把湿猴甩上台 → 救援判定 ——
    {
      const A = g.monkeys[0], B = g.monkeys[1];
      const plat = g.platformAt(A.x);
      // 让 B 从台下方荡上来，身体从上往下穿过台面
      B.grounded = false; B.wetT = 5.5; B.wetRescueDelay = 999;
      B.x = A.x; B.y = plat.y - 80; B.vy = 30; B.vx = 0;
      let rescued = false;
      const prev = g.onEvent;
      g.onEvent = function (t, d) { if (t === 'rescue') rescued = true; prev && prev(t, d); };
      for (let i = 0; i < 180 && !rescued; i++) g.update(DT);
      out.s2 = { rescued, Bgrounded: B.grounded };
    }
    // —— 场景3：检查点，猴从平台上空飞过不触发，站台面才触发 ——
    {
      const cp = g.checkpoints.find(c => !c.passed) || g.checkpoints[0];
      const plat = g.platformAt(cp.x);
      const A = g.monkeys[0], B = g.monkeys[1];
      A.grounded = false; A.wetT = 0; A.stunT = 0;
      A.x = cp.x - 40; A.y = plat.y - 60; A.vx = 420; A.vy = -60;   // 低速掠过台面上空、落到台子另一边水里（不会落回台上）
      B.grounded = true; B.x = cp.x - 200; B.y = plat.y; B.wetT = 0; B.stunT = 0;
      let fired = false, firedInAir = false;
      const prev2 = g.onEvent;
      g.onEvent = function (t, d) { if (t === 'checkpoint') fired = true; prev2 && prev2(t, d); };
      g.maxX = Math.max(g.maxX, cp.x + 1);
      for (let i = 0; i < 90; i++) {
        g.update(DT);
        if (fired && !A.grounded) firedInAir = true;   // 关键断言：猴还在空中时就触发了 = 旧 bug
        if (fired) break;
      }
      const notFiredInAir = !firedInAir;
      // A 站上台面 → 触发
      A.wetT = 0; A.grounded = true; A.x = cp.x + 10; A.y = plat.y; A.vx = 0; A.vy = 0; A.stunT = 0;
      for (let i = 0; i < 10 && !fired; i++) g.update(DT);
      out.s3 = { notFiredInAir, firedOnLand: cp.passed, Aended: { grounded: A.grounded, x: Math.round(A.x), wet: A.wetT > 0 } };
    }
    out.version = g.VERSION;
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  console.log('pageerror:', errors.length ? errors : 0);
  await b.close();
  const ok = !r.s1.rescued && r.s1.wetStill && !r.s1.minYAbovePlat &&
             r.s2.rescued && r.s2.Bgrounded &&
             r.s3.notFiredInAir && r.s3.firedOnLand && errors.length === 0;
  console.log(ok ? 'R19 LOCAL ACCEPT: ALL PASS' : 'R19 LOCAL ACCEPT: FAIL');
  process.exit(ok ? 0 : 1);
})();
