/**
 * 站内自托管的前端计数脚本（放到主题 source/js/ 下，由页面在 load 后引入）
 *
 * 策略：自建 Worker 优先；未配置或请求失败时自动回退到 Vercount。
 * 无论走哪条路，最终都是往主题原有的 busuanzi_value_* / busuanzi_container_* 上填数字，
 * 所以主题模板一行都不用改。
 */
(function () {
  'use strict';

  // ===== 配置 =====
  var WORKER_API = 'https://counter.systemic-playground.ccwu.cc/count'; // ← 自建 Cloudflare Worker（自定义域名，国内可达）
  var VERCENT_JS = 'https://events.vercount.one/js';    // 回退用
  var TIMEOUT = 6000;                                   // 自建后端超时（毫秒）
  var VID_KEY = 'counter_vid';
  // ================

  var KEYS = ['site_pv', 'page_pv', 'site_uv'];

  function container(k) { return document.getElementById('busuanzi_container_' + k); }
  function value(k) { return document.getElementById('busuanzi_value_' + k); }

  function hideAll() {
    KEYS.forEach(function (k) { var e = container(k); if (e) { e.style.display = 'none'; } });
  }
  function showAll() {
    KEYS.forEach(function (k) { var e = container(k); if (e) { e.style.display = 'inline'; } });
  }
  function fill(d) {
    var map = { site_pv: d.site_pv, page_pv: d.page_pv, site_uv: d.site_uv };
    var any = false;
    KEYS.forEach(function (k) {
      var el = value(k);
      if (el && map[k] != null) { el.innerHTML = String(map[k]); any = true; }
    });
    if (any) { showAll(); }
  }

  function getVid() {
    try {
      var v = localStorage.getItem(VID_KEY);
      if (!v) {
        v = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
        localStorage.setItem(VID_KEY, v);
      }
      return v;
    } catch (e) { return ''; }
  }

  function fallbackVercount() {
    var s = document.createElement('script');
    s.src = VERCENT_JS;
    s.async = true;
    document.head.appendChild(s);
  }

  function start() {
    hideAll();
    if (!WORKER_API) { fallbackVercount(); return; }

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    fetch(WORKER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: location.pathname, vid: getVid() }),
      signal: ctrl.signal,
      keepalive: true
    }).then(function (r) {
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      return r.json();
    }).then(function (res) {
      clearTimeout(timer);
      var d = res && res.data;
      if (!d) { throw new Error('bad payload'); }
      fill(d);
    }).catch(function () {
      clearTimeout(timer);
      fallbackVercount();
    });
  }

  if (document.readyState === 'complete') { start(); }
  else { window.addEventListener('load', start); }
})();
