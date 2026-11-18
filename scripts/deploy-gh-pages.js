// GitHub Contents API 上传脚本（串行 + 重试）
// ⚠️ Token 不进源码（r27）：优先读环境变量 GH_TOKEN / GITHUB_TOKEN，
//    其次读项目根目录的 .gh-token（已在 .gitignore 里，不会被提交/推送）。
//    仓库是公开的，把 Token 写进代码会被 GitHub secret scanning 直接拒收（422），
//    也会让任何 clone 的人拿到你的推送权限。
// 用法：先把 dist/ 复制到 /tmp/gh-deploy（见 部署必读.md 第四章），再 node scripts/deploy-gh-pages.js
const fs = require('fs'), path = require('path'), https = require('https');

function readToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const f = path.join(__dirname, '..', '.gh-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
}
const TOKEN = readToken();
if (!TOKEN) {
  console.error('缺少 GitHub Token：请设置环境变量 GH_TOKEN，或在项目根目录写 .gh-token 文件。');
  console.error('（Token 需带 repo 权限；见 部署必读.md 第四章）');
  process.exit(1);
}
const REPO = process.env.GH_REPO || 'elizond0/gelianghao';
const ROOT = process.env.GH_DEPLOY_DIR || '/tmp/gh-deploy';

function listFiles(dir, base = '') {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out = out.concat(listFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path: urlPath, method,
      headers: {
        'User-Agent': 'deploy-script', Authorization: 'Bearer ' + TOKEN,
        Accept: 'application/vnd.github+json',
        'Content-Length': Buffer.byteLength(data || '')
      },
      timeout: 60000
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function put(rel) {
  const full = path.join(ROOT, rel);
  const content = fs.readFileSync(full).toString('base64');
  // 检查远端是否已有该文件（拿到 sha 才能更新）
  let sha;
  const r = await api('GET', `/repos/${REPO}/contents/${encodeURI(rel)}`);
  if (r.status === 200 && r.json && r.json.sha) sha = r.json.sha;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await api('PUT', `/repos/${REPO}/contents/${encodeURI(rel)}`, {
        message: 'deploy: ' + rel, content, branch: 'main', ...(sha ? { sha } : {})
      });
      if (res.status === 201 || res.status === 200) return 'OK';
      throw new Error(`HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
    } catch (e) {
      if (i === 3) return 'FAIL: ' + e.message;
      await new Promise(r2 => setTimeout(r2, 3000));
    }
  }
}

(async () => {
  const files = listFiles(ROOT);
  console.log('待上传 ' + files.length + ' 个文件');
  let fails = [];
  for (const f of files) {
    const r = await put(f);
    console.log(new Date().toISOString().slice(11, 19), r, f);
    if (r.startsWith('FAIL')) fails.push(f);
  }
  console.log('==== 完成，失败 ' + fails.length + ' ====');
  if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
})();
