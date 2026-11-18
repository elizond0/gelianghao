const { chromium } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 780 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8790/index.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.evaluate(() => { window.GLH.startSolo(); });
  await p.waitForTimeout(500);
  const result = await p.evaluate(() => {
    return new Promise((resolve) => {
      const g = window.GLH.game;
      const seen = [];
      const prev = g.onEvent;
      g.onEvent = function (t, d) { seen.push(t); if (t === 'rescue') window.__r17rescue = true; try { prev && prev(t, d); } catch (e) {} };
      g.obstacles = []; g.winds = [];
      const A = g.monkeys[0], B = g.monkeys[1];
      const plat = g.platforms.find(pp => pp.w >= 120);
      B.x = plat.x + plat.w / 2; B.y = plat.y; B.grounded = true; B.wetT = 0; B.stunT = 0; B.charging = true;
      A.x = plat.x + plat.w / 2; A.y = plat.y - 80; A.grounded = false; A.wetT = 5.5;
      A.wetRescueDelay = 999; A.vx = 0; A.vy = 30; A.stunT = 0; A.charging = false;
      let frames = 0;
      const iv = setInterval(() => {
        frames++;
        if ((window.__r17rescue && frames > 25) || frames > 300) {
          clearInterval(iv);
          resolve({ rescueEv: !!window.__r17rescue, frames, seen: seen.slice(0, 30),
            aGrounded: A.grounded, aX: Math.round(A.x), aY: Math.round(A.y), rescues: g.rescues, bCharging: B.charging });
        }
      }, 16);
    });
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: '/tmp/r17_visual.png' });
  console.log(JSON.stringify(Object.assign({ pageerrors: errs }, result)));
  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
