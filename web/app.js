(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var store = {
    get: function (k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };
  var API = NATIVE ? store.get('evo_server') : '';
  var token = store.get('evo_token');
  var cams = [], slots = [], sel = -1, page = 0, players = [], timer = null, sig = '', editing = null;

  function pad(x) { return (x < 10 ? '0' : '') + x; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  function api(p, method, body) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    return fetch(API + p, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      if (r.status === 401) { token = ''; store.set('evo_token', ''); showLogin(); throw new Error('auth'); }
      return r.json();
    });
  }

  // ---------- login ----------
  function showLogin() {
    stopPlayers(); clearInterval(timer);
    $('#srvrow').style.display = NATIVE ? '' : 'none';
    if (NATIVE) $('#l-srv').value = API;
    $('#lerr').textContent = '';
    if (!$('#login').open) $('#login').showModal();
  }
  $('#login').addEventListener('cancel', function (e) { e.preventDefault(); });
  $('#l-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#l-go').click(); });
  $('#l-go').onclick = function () {
    var srv = '';
    if (NATIVE) {
      srv = $('#l-srv').value.trim().replace(/\/+$/, '');
      if (!srv) { $('#lerr').textContent = 'Enter the server address.'; return; }
      if (!/^https?:\/\//.test(srv)) srv = 'http://' + srv;
    }
    fetch(srv + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#l-pass').value }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { $('#lerr').textContent = 'Wrong password.'; return; }
        API = srv; token = x.j.token; store.set('evo_server', srv); store.set('evo_token', token);
        $('#l-pass').value = ''; $('#login').close(); start();
      })
      .catch(function () { $('#lerr').textContent = 'Cannot reach the server.'; });
  };

  // ---------- data ----------
  function load() {
    return api('/api/cameras').then(function (r) {
      cams = r; slots = [];
      for (var i = 0; i < 32; i++) slots.push(null);
      cams.forEach(function (c) { if (c.ch >= 1 && c.ch <= 32) slots[c.ch - 1] = c; });
    });
  }
  function sorted() { return cams.slice().sort(function (a, b) { return a.ch - b.ch; }); }
  function refresh(force) {
    return load().then(function () {
      var s = cams.map(function (c) { return c.id + c.status + c.recording; }).join();
      drawDev(); drawList();
      if ((force || s !== sig) && $('#live').classList.contains('on')) drawGrid();
      sig = s;
      return api('/api/events').then(drawEvents);
    }).catch(function () { /* offline or auth handled in api() */ });
  }

  // ---------- live view ----------
  function stopPlayers() { players.forEach(function (h) { try { h.destroy(); } catch (e) { /* ignore */ } }); players = []; }
  function tile(c, i) {
    var ch = 'CH' + pad(i + 1);
    if (!c) return '<div class="tile empty" data-i="' + i + '"><span class="name">' + ch + '</span><div class="offmsg">No device<small>Click to add</small></div></div>';
    var on = c.status === 'online';
    return '<div class="tile' + (on ? '' : ' off') + '" data-i="' + i + '"><video muted playsinline autoplay></video><span class="name">' + ch + ' ' + esc(c.name) +
      '</span><span class="rec"><i></i>' + (on ? (c.recording ? 'REC' : 'LIVE') : 'OFFLINE') + '</span>' +
      (on ? '' : '<div class="offmsg">No signal<small>Check power and network</small></div>') + '</div>';
  }
  function play(v, c, q) {
    api('/api/cameras/' + c.id + '/start?q=' + q, 'POST').then(function (r) {
      if (!r.ok || !document.body.contains(v)) return;
      var url = API + r.path;
      if (window.Hls && Hls.isSupported()) {
        var h = new Hls({ liveSyncDurationCount: 2, maxBufferLength: 8 });
        players.push(h); h.loadSource(url); h.attachMedia(v);
        h.on(Hls.Events.MANIFEST_PARSED, function () { v.play().catch(function () { /* autoplay blocked */ }); });
        h.on(Hls.Events.ERROR, function (e, d) { if (d.fatal) { try { h.destroy(); } catch (x) { /* ignore */ } } });
      } else { v.src = url; v.play().catch(function () { /* ignore */ }); }
    }).catch(function () { /* ignore */ });
  }
  function drawGrid() {
    stopPlayers();
    var n = +$('#layout .on').dataset.n, g = $('#grid'), idx = [], pages = Math.ceil(32 / n);
    if (page >= pages) page = 0;
    if (sel >= 0) { idx = [sel]; g.className = 'grid g1'; }
    else { g.className = 'grid g' + n; for (var i = page * n; i < Math.min(32, (page + 1) * n); i++) idx.push(i); }
    $('#pg').style.display = (sel < 0 && pages > 1) ? '' : 'none';
    $('#pg').textContent = 'Page ' + (page + 1) + ' of ' + pages;
    g.innerHTML = idx.map(function (i) { return tile(slots[i], i); }).join('');
    var q = (sel >= 0 || n <= 4) ? 'main' : 'sub';
    g.querySelectorAll('.tile').forEach(function (t) {
      var c = slots[+t.dataset.i];
      if (c && c.status === 'online') play(t.querySelector('video'), c, q);
    });
    drawList();
  }
  function drawList() {
    $('#clist').innerHTML = '<button class="ci' + (sel < 0 ? ' on' : '') + '" data-i="-1"><span class="cn">All cameras<small>' + cams.length + ' of 32 channels</small></span></button>' +
      sorted().map(function (c) {
        return '<button class="ci' + (sel === c.ch - 1 ? ' on' : '') + '" data-i="' + (c.ch - 1) + '"><span class="dot' + (c.status === 'online' ? '' : ' off') + '"></span><span class="cn">CH' + pad(c.ch) + ' ' + esc(c.name) + '<small>' + esc(c.ip || 'RTSP URL') + '</small></span></button>';
      }).join('');
  }
  $('#clist').onclick = function (e) { var b = e.target.closest('.ci'); if (!b) return; sel = +b.dataset.i; showView('live'); };
  $('#grid').onclick = function (e) {
    var t = e.target.closest('.tile'); if (!t) return;
    var i = +t.dataset.i;
    if (!slots[i]) { openForm(null, i + 1); return; }
    sel = sel === i ? -1 : i; drawGrid();
  };
  $('#layout').onclick = function (e) {
    var b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#layout button').forEach(function (x) { x.classList.remove('on'); });
    b.classList.add('on'); sel = -1; page = 0; drawGrid();
  };
  $('#pg').onclick = function () { page++; drawGrid(); };

  // ---------- cameras table and form ----------
  function drawDev() {
    $('#tb').innerHTML = sorted().map(function (c) {
      var on = c.status === 'online';
      return '<tr><td>CH' + pad(c.ch) + '</td><td>' + esc(c.name) + '</td><td>' + esc(c.ip || 'RTSP URL') + '</td><td><span class="dot' + (on ? '' : ' off') + '"></span>' + (on ? 'Online' : 'Offline') + '</td><td>' + (c.record ? 'Continuous' : 'Off') +
        '</td><td style="white-space:nowrap"><button class="btn ghost sm" data-act="edit" data-id="' + c.id + '">Edit</button> <button class="btn ghost sm" data-act="del" data-id="' + c.id + '">Remove</button></td></tr>';
    }).join('') || '<tr><td colspan="6">No cameras yet. Click "Add camera".</td></tr>';
    var cur = $('#pcam').value;
    $('#pcam').innerHTML = sorted().map(function (c) { return '<option value="' + c.id + '">CH' + pad(c.ch) + ' ' + esc(c.name) + '</option>'; }).join('');
    if (cur) $('#pcam').value = cur;
  }
  $('#tb').onclick = function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var c = cams.filter(function (x) { return x.id === b.dataset.id; })[0]; if (!c) return;
    if (b.dataset.act === 'edit') openForm(c);
    else if (confirm('Remove ' + c.name + '? Its recordings stay on disk.')) api('/api/cameras/' + c.id, 'DELETE').then(function () { sel = -1; refresh(true); });
  };
  function openForm(c, ch) {
    editing = c ? c.id : null;
    var used = {}; cams.forEach(function (x) { if (!c || x.id !== c.id) used[x.ch] = 1; });
    var o = ''; for (var i = 1; i <= 32; i++) if (!used[i]) o += '<option value="' + i + '">CH' + pad(i) + '</option>';
    $('#f-ch').innerHTML = o;
    $('#err').textContent = (!o && !c) ? 'All 32 channels are in use. Remove a camera first.' : '';
    var d = c || { port: 554, user: 'admin', path: '/cam/realmonitor?channel=1&subtype=0', subPath: '/cam/realmonitor?channel=1&subtype=1', record: true };
    if (c) $('#f-ch').value = c.ch; else if (ch && !used[ch]) $('#f-ch').value = ch;
    $('#f-name').value = d.name || ''; $('#f-ip').value = d.ip || ''; $('#f-port').value = d.port || 554;
    $('#f-user').value = d.user || ''; $('#f-pass').value = ''; $('#f-pass').placeholder = c ? '(unchanged)' : '';
    $('#f-path').value = d.path || ''; $('#f-spath').value = d.subPath || ''; $('#f-url').value = d.url || ''; $('#f-surl').value = d.subUrl || '';
    $('#f-rec').checked = !!d.record; $('#f-tc').checked = !!d.transcode;
    $('#dtitle').textContent = c ? 'Edit camera' : 'Add camera';
    $('#dlg').showModal();
  }
  $('#add').onclick = function () { openForm(null); };
  $('#cancel').onclick = function () { $('#dlg').close(); };
  $('#save').onclick = function () {
    var b = {
      ch: +$('#f-ch').value, name: $('#f-name').value.trim(), ip: $('#f-ip').value.trim(), port: +$('#f-port').value || 554,
      user: $('#f-user').value, pass: $('#f-pass').value, path: $('#f-path').value.trim(), subPath: $('#f-spath').value.trim(),
      url: $('#f-url').value.trim(), subUrl: $('#f-surl').value.trim(), record: $('#f-rec').checked, transcode: $('#f-tc').checked
    };
    api(editing ? '/api/cameras/' + editing : '/api/cameras', editing ? 'PUT' : 'POST', b).then(function (r) {
      if (r.error) { $('#err').textContent = r.error; return; }
      $('#dlg').close(); refresh(true);
    }).catch(function () { /* ignore */ });
  };

  // ---------- playback ----------
  function loadRecs() {
    var id = $('#pcam').value, d = $('#pdate').value;
    if (!id || !d) { $('#rlist').innerHTML = ''; return; }
    api('/api/cameras/' + id + '/recordings?date=' + d).then(function (r) {
      $('#rlist').innerHTML = r.length ? r.map(function (f) { return '<button class="ci" data-u="' + f.url + '"><span class="cn">' + f.time + '<small>' + f.mb + ' MB</small></span></button>'; }).join('') : '<div class="note">No recordings for this day.</div>';
    }).catch(function () { /* ignore */ });
  }
  $('#pcam').onchange = loadRecs; $('#pdate').onchange = loadRecs;
  $('#rlist').onclick = function (e) {
    var b = e.target.closest('.ci'); if (!b) return;
    var v = $('#pvid'); v.src = API + b.dataset.u; v.play().catch(function () { /* ignore */ });
    $('#pnote').textContent = 'Playing the recording from ' + b.querySelector('.cn').firstChild.textContent;
  };

  // ---------- alerts ----------
  function drawEvents(ev) {
    $('#al').innerHTML = ev.length ? ev.map(function (e) {
      var d = new Date(e.t), off = e.type === 'offline';
      return '<div class="alert"><span class="tag ' + (off ? 'r' : '') + '">' + (off ? 'Camera offline' : 'Back online') + '</span><span>CH' + pad(e.ch) + ' ' + esc(e.name) + '</span><span class="t">' + d.toLocaleDateString() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + '</span></div>';
    }).join('') : '<div class="alert">No alerts yet.</div>';
  }

  // ---------- navigation, settings, theme ----------
  function showView(v) {
    document.querySelectorAll('#nav > button').forEach(function (x) { x.classList.toggle('on', x.dataset.v === v); });
    document.querySelectorAll('.view').forEach(function (s) { s.classList.toggle('on', s.id === v); });
    if (v === 'live') drawGrid(); else stopPlayers();
    if (v === 'play') { if (!$('#pdate').value) $('#pdate').value = today(); loadRecs(); }
  }
  $('#nav').onclick = function (e) { var b = e.target.closest('#nav > button'); if (b) showView(b.dataset.v); };
  $('#pwtop').onclick = function () { showView('set'); };
  $('#s-save').onclick = function () {
    api('/api/password', 'POST', { password: $('#s-pw').value }).then(function (r) {
      $('#s-msg').textContent = r.error || 'Password changed.';
      if (r.ok) { $('#s-pw').value = ''; $('#pwtop').style.display = 'none'; }
    }).catch(function () { /* ignore */ });
  };
  $('#s-out').onclick = function () { token = ''; store.set('evo_token', ''); showLogin(); };
  $('#theme').onclick = function () {
    var r = document.documentElement;
    var dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    r.dataset.theme = dark ? 'light' : 'dark';
  };
  function clock() { var d = new Date(); $('#clock').textContent = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  setInterval(clock, 1000); clock();

  function start() {
    clearInterval(timer);
    api('/api/info').then(function (r) { $('#pwtop').style.display = r.defaultPassword ? 'block' : 'none'; }).catch(function () { /* ignore */ });
    refresh(true);
    timer = setInterval(function () { refresh(false); }, 10000);
  }
  if (token) start(); else showLogin();
})();
