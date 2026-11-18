/**
 * 极简 CommonJS 加载器（仅浏览器用）
 *
 * shared/ 下的文件都写成 CommonJS（小程序要 require），浏览器原生没有 require。
 * 这里用 fetch 拉源码 + new Function 包装的方式把它跑起来，不引入 webpack/vite。
 *
 * 做法：
 *   1. 首次 require 某模块时 fetch 该文件源码
 *   2. 用 new Function('require','module','exports','window','global', src) 包一层
 *   3. 源码里的 module.exports / require('./x') 都能正常工作
 *
 * 因为拉取是异步的，用法分两步：
 *   - require.boot([依赖列表], function(){ 这里可以同步 require })   ← 启动用
 *   - require('/shared/xxx.js')                                       ← 已加载后同步取
 */
(function (global) {
  'use strict';

  if (global.require && global.require.__glhLoader) return;

  var cache = {};      // 绝对路径 -> module.exports
  var loading = {};    // 绝对路径 -> Promise
  var FILES = {};      // 绝对路径 -> 源码（按需拉取）

  function norm(p) {
    var parts = String(p).split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg === '' || seg === '.') continue;   // 多余斜杠 / 当前目录
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
    return '/' + out.join('/');
  }

  function resolve(from, to) {
    if (to.charAt(0) === '/') return norm(to);
    var base = from.split('/').slice(0, -1).join('/');
    return norm(base + '/' + to);
  }

  // 剥掉注释，避免把注释里的 require 示例当成真依赖
  // （踩过：lobby.js 的文档注释里写了 require('../shared/app/lobby.js')，
  //   结果被扫描成 /shared/shared/app/lobby.js，一路 404）
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');   // 行注释（排除 http:// 这类）
  }

  // 扫源码里的 require('...')，得到依赖的绝对路径
  function scanDeps(src, from) {
    var out = [];
    var clean = stripComments(src);
    var re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    var m;
    while ((m = re.exec(clean))) out.push(resolve(from, m[1]));
    return out;
  }

  // 求值一个模块（依赖必须已就绪）
  function evalModule(path, src) {
    var mod = { exports: {} };
    cache[path] = mod.exports;   // 先占位，防循环依赖

    var fn;
    try {
      fn = new Function('require', 'module', 'exports', 'window', 'global',
        src + '\n//# sourceURL=' + path);
    } catch (e) {
      throw new Error('[loader] 语法错误 ' + path + '：' + e.message);
    }

    var req = function (t) {
      var p = resolve(path, t);
      if (cache[p]) return cache[p];
      throw new Error('[loader] 依赖未就绪：' + p + '（被 ' + path + ' 引用）');
    };

    fn(req, mod, mod.exports, global, global);
    cache[path] = mod.exports;
    return mod.exports;
  }

  // 依赖就绪前不能求值，所以要按依赖顺序排一排
  function plan(path, src, stack, order) {
    stack = stack || {};
    order = order || [];
    if (order.indexOf(path) >= 0) return order;
    if (stack[path]) return order;   // 循环依赖，跳过
    stack[path] = true;

    var deps = scanDeps(src, path);
    for (var i = 0; i < deps.length; i++) {
      var d = deps[i];
      if (cache[d]) continue;
      // 依赖的源码还没拉，得等
      if (!FILES[d]) continue;
      plan(d, FILES[d], stack, order);
    }
    order.push(path);
    return order;
  }

  // ---- 弱网/隧道三保险：并发上限 + 超时 + 自动重试 ----
  // 踩过：免费隧道（pinggy）下十几个模块同时 fetch，会有人"发出请求但永远收不到响应"，
  // 整个 boot 链挂死、页面卡在首页点不动。真机 4G 弱网同样会踩。
  var MAX_INFLIGHT = 4;      // 同时最多 4 个 fetch，不给连接池添堵
  var FETCH_TIMEOUT = 12000; // 单个请求 12s 没响应就当失败，走重试
  var MAX_ATTEMPT = 2;       // 每个模块最多尝试 2 次（网络类错误才重试）

  var inflight = 0;
  var waiters = [];

  function pump() {
    while (inflight < MAX_INFLIGHT && waiters.length) {
      var w = waiters.shift();
      inflight++;
      var done = function () { inflight--; pump(); };
      w(done);
    }
  }

  // 把"发 fetch"这件事排进队：只在拿到槽位时执行，不持有槽位等待依赖
  function schedule(fn) {
    return new Promise(function (resolve, reject) {
      waiters.push(function (done) {
        var settled = false;
        var finish = function (err, val) {
          if (settled) return;
          settled = true;
          done();
          err ? reject(err) : resolve(val);
        };
        try { fn(finish); } catch (e) { finish(e); }
      });
      pump();
    });
  }

  function fetchSrc(path) {
    return schedule(function (done) {
      var timer = setTimeout(function () { done(new Error('timeout')); }, FETCH_TIMEOUT);
      fetch(path, { cache: 'no-cache' }).then(function (res) {
        clearTimeout(timer);
        if (!res.ok) return done(new Error('[loader] 拉取失败 ' + path + '（HTTP ' + res.status + '）'));
        res.text().then(function (t) { done(null, t); }, function (e) { done(e); });
      }, function (e) { clearTimeout(timer); done(e); });
    });
  }

  function load(path, attempt) {
    path = norm(path);
    if (cache[path]) return Promise.resolve(cache[path]);
    if (loading[path]) return loading[path];
    attempt = attempt || 0;

    loading[path] = fetchSrc(path)
      .then(function (src) {
        FILES[path] = src;
        // 递归拉依赖（每个依赖各自排队，不会把槽位攥死）
        var deps = scanDeps(src, path).filter(function (d) { return !cache[d] && !FILES[d]; });
        return Promise.all(deps.map(function (d) { return load(d); })).then(function () {
          // 依赖齐了，按拓扑序求值
          var order = plan(path, src);
          for (var i = 0; i < order.length; i++) {
            var p = order[i];
            if (!cache[p]) evalModule(p, FILES[p]);
          }
          return cache[path];
        });
      })
      .catch(function (e) {
        delete loading[path];
        var isLoaderErr = String(e.message).indexOf('[loader]') === 0;
        // 网络类错误（挂死/超时/连接重置）重试一次；代码错误重试没意义
        if (!isLoaderErr && attempt + 1 < MAX_ATTEMPT) {
          return new Promise(function (r) { setTimeout(r, 500); })
            .then(function () { return load(path, attempt + 1); });
        }
        if (isLoaderErr) throw e;
        throw new Error('[loader] 加载失败 ' + path + '：' + e.message);
      });

    return loading[path];
  }

  /**
   * 启动：并发拉齐依赖，全部就绪后回调里可以同步 require
   */
  function boot(deps, main) {
    var list = (deps || []).map(norm);
    var jobs = list.map(function (p) {
      if (cache[p]) return null;
      return load(p).catch(function (e) { console.error(e.message); });
    }).filter(Boolean);

    return Promise.all(jobs).then(function () {
      main(requireSync);
    });
  }

  function requireSync(t) {
    var p = norm(t);
    if (cache[p]) return cache[p];
    throw new Error('[loader] 模块未预加载：' + p + '\n  把它加到 require.boot() 的依赖列表里');
  }

  requireSync.boot = boot;
  requireSync.load = load;
  requireSync.resolve = resolve;
  requireSync.norm = norm;
  requireSync.cache = cache;
  requireSync.__glhLoader = true;

  global.require = requireSync;
})(typeof window !== 'undefined' ? window : globalThis);
