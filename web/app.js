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
  var cams = [], slots = [], sel = -1, page = 0, players = [], timer = null, sig = '', editing = null, soundOn = false;

  function loadCred() { try { return JSON.parse(store.get('evo_cred') || '{}'); } catch (e) { return {}; } }
  function saveCred(u, p) { store.set('evo_cred', JSON.stringify({ u: u || '', p: p || '' })); }
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
    $('#lerr').style.color = 'var(--red)';
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

  // ---------- forgot password ----------
  function srvInput() {
    if (!NATIVE) return '';
    var s = $('#l-srv').value.trim().replace(/\/+$/, '');
    if (s && !/^https?:\/\//.test(s)) s = 'http://' + s;
    return s;
  }
  function rmsg(t, good) { var e = $('#rec-msg'); e.style.color = good ? 'var(--ok)' : 'var(--red)'; e.textContent = t; }
  function post(path, body) {
    return fetch(srvInput() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); });
  }
  $('#l-forgot').onclick = function () {
    if (NATIVE && !srvInput()) { $('#lerr').style.color = 'var(--red)'; $('#lerr').textContent = 'Enter the server address first.'; return; }
    $('#rec-pc').style.display = window.evotronDesktop ? 'block' : 'none';
    $('#rec-s1').style.display = ''; $('#rec-s2').style.display = 'none'; rmsg('');
    $('#rec-code').value = ''; $('#rec-pw').value = '';
    $('#rec').showModal();
  };
  $('#rec-close').onclick = function () { $('#rec').close(); };
  $('#rec-desk').onclick = function () {
    window.evotronDesktop.resetPassword().then(function (done) {
      if (!done) return;
      $('#rec').close(); $('#lerr').style.color = 'var(--ok)'; $('#lerr').textContent = 'Password reset. Sign in with: admin';
    });
  };
  $('#rec-send').onclick = function () {
    rmsg('Sending...', true);
    post('/api/recover/request').then(function (r) {
      if (r.error) { rmsg(r.error); return; }
      $('#rec-s2').style.display = ''; rmsg('A code was sent to ' + r.to + '. It is valid for 10 minutes. Check the spam folder too.', true);
    }).catch(function () { rmsg('Cannot reach the server.'); });
  };
  $('#rec-go').onclick = function () {
    post('/api/recover/confirm', { code: $('#rec-code').value, password: $('#rec-pw').value }).then(function (r) {
      if (r.error) { rmsg(r.error); return; }
      $('#rec').close(); $('#lerr').style.color = 'var(--ok)'; $('#lerr').textContent = 'Password changed. Sign in with the new password.';
    }).catch(function () { rmsg('Cannot reach the server.'); });
  };
  function loadRecovery() {
    api('/api/recovery').then(function (r) {
      $('#r-smtp').style.display = r.managed ? 'none' : '';
      $('#r-email').value = r.email || ''; $('#r-host').value = r.host || ''; $('#r-port').value = r.port || 587; $('#r-user').value = r.user || '';
      $('#r-pass').value = ''; $('#r-pass').placeholder = r.hasPass ? '(saved)' : '';
      $('#r-prov').value = ['smtp.gmail.com', 'smtp.office365.com'].indexOf(r.host) >= 0 ? r.host : '';
    }).catch(function () { /* ignore */ });
  }
  $('#r-prov').onchange = function () { if (this.value) { $('#r-host').value = this.value; $('#r-port').value = 587; } };
  $('#r-save').onclick = function () {
    api('/api/recovery', 'POST', { email: $('#r-email').value, host: $('#r-host').value, port: +$('#r-port').value || 587, user: $('#r-user').value, pass: $('#r-pass').value })
      .then(function (r) { $('#r-msg').textContent = r.error || 'Saved. Press Send test email to check it.'; }).catch(function () { /* ignore */ });
  };
  $('#r-test').onclick = function () {
    $('#r-msg').textContent = 'Sending...';
    api('/api/recovery/test', 'POST', {}).then(function (r) { $('#r-msg').textContent = r.error || 'Test email sent. Check the inbox and the spam folder.'; }).catch(function () { /* ignore */ });
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
    return '<div class="tile' + (on ? '' : ' off') + '" data-i="' + i + '"><video muted playsinline autoplay></video>' +
      '<div class="nosig"><img src="logo.png" alt=""><b>' + (on ? 'Connecting...' : 'No signal') + '</b><small>' + (on ? 'Please wait' : 'Check power and network') + '</small></div>' +
      '<span class="name">' + ch + ' ' + esc(c.name) + '</span><span class="rec"><i></i>' + (on ? (c.recording ? 'REC' : 'LIVE') : 'OFFLINE') + '</span></div>';
  }
  function updSnd() { $('#snd').textContent = 'Sound: ' + (soundOn ? 'on' : 'off'); }
  // Starts playback; sound is only played in the single camera view and only after the user turned it on.
  function go(v) {
    v.muted = !(soundOn && sel >= 0);
    v.play().catch(function () { v.muted = true; soundOn = false; updSnd(); v.play().catch(function () { /* ignore */ }); });
  }
  function showSig(v, show, title, sub) {
    var t = v.parentNode && v.parentNode.querySelector('.nosig'); if (!t) return;
    t.style.display = show ? '' : 'none';
    if (show) { t.querySelector('b').textContent = title; t.querySelector('small').textContent = sub; }
  }
  function play(v, c, q) {
    var fail = function () { if (document.body.contains(v)) showSig(v, true, 'No signal', 'Check power and network'); };
    v.addEventListener('playing', function () { v.__ok = true; showSig(v, false); });
    v.addEventListener('error', fail);
    setTimeout(function () { if (!v.__ok) fail(); }, 20000);
    api('/api/cameras/' + c.id + '/start?q=' + q, 'POST').then(function (r) {
      if (!document.body.contains(v)) return;
      if (!r.ok) { fail(); return; }
      var url = API + r.path;
      if (window.Hls && Hls.isSupported()) {
        var h = new Hls({ liveSyncDurationCount: 2, maxBufferLength: 8 });
        players.push(h); h.loadSource(url); h.attachMedia(v);
        h.on(Hls.Events.MANIFEST_PARSED, function () { go(v); });
        h.on(Hls.Events.ERROR, function (e, d) { if (d.fatal) { try { h.destroy(); } catch (x) { /* ignore */ } fail(); } });
      } else { v.src = url; go(v); }
    }).catch(fail);
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
    var cur = sel >= 0 ? slots[sel] : null;
    $('#ctl').style.display = cur ? 'flex' : 'none';
    $('#ptzbox').style.display = (cur && cur.ptz) ? 'flex' : 'none';
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
    var cr = c ? {} : loadCred();
    $('#f-user').value = c ? (d.user || '') : (cr.u || d.user || ''); $('#f-pass').value = cr.p || ''; $('#f-pass').placeholder = c ? '(unchanged)' : '';
    $('#f-path').value = d.path || ''; $('#f-spath').value = d.subPath || ''; $('#f-url').value = d.url || ''; $('#f-surl').value = d.subUrl || '';
    $('#f-rec').checked = !!d.record; $('#f-tc').checked = !!d.transcode; $('#f-audio').checked = d.audio !== false;
    $('#dtitle').textContent = c ? 'Edit camera' : 'Add camera';
    onv = c && c.onvif ? c.onvif : null;
    var op = 80; try { if (onv && onv.xaddr) op = parseInt(new URL(onv.xaddr).port, 10) || 80; } catch (e) { /* ignore */ }
    $('#f-oport').value = op; $('#omsg').textContent = ''; $('#found').innerHTML = '';
    $('#f-search').style.display = c ? 'none' : 'block';
    $('#dlg').classList.toggle('single', !!c);
    $('#save').textContent = 'Save camera'; $('#save').disabled = false; $('#cancel').textContent = 'Cancel'; found = [];
    $('#dlg').showModal();
  }
  $('#add').onclick = function () { openForm(null); };
  $('#cancel').onclick = function () { $('#dlg').close(); };
  $('#save').onclick = function () {
    var b = {
      ch: +$('#f-ch').value, name: $('#f-name').value.trim(), ip: $('#f-ip').value.trim(), port: +$('#f-port').value || 554,
      user: $('#f-user').value, pass: $('#f-pass').value, path: $('#f-path').value.trim(), subPath: $('#f-spath').value.trim(),
      url: $('#f-url').value.trim(), subUrl: $('#f-surl').value.trim(), record: $('#f-rec').checked, audio: $('#f-audio').checked, transcode: $('#f-tc').checked, onvif: onv
    };
    var detectErr = '';
    function warn() { return 'Saved, but ONVIF did not answer (' + detectErr + '), so the default stream path is used. Check the password, then use Edit > Auto detect streams.'; }
    function send() {
      api(editing ? '/api/cameras/' + editing : '/api/cameras', editing ? 'PUT' : 'POST', b).then(function (r) {
        if (r.error) { $('#err').textContent = r.error; return; }
        if (!editing) saveCred(b.user, b.pass);
        refresh(true).then(function () { $('#dlg').close(); if (detectErr) toast(warn(), 10000); });
      }).catch(function () { /* ignore */ });
    }
    // No stream address yet: ask the camera over ONVIF automatically, so "Auto detect" does not need a click.
    // If ONVIF does not answer, the camera is still saved with the default stream paths.
    if (!onv && !b.url && b.ip) {
      $('#err').textContent = ''; omsg('Detecting camera streams...');
      api('/api/onvif/probe', 'POST', { id: editing, ip: b.ip, port: +$('#f-oport').value || 80, user: b.user, pass: b.pass }).then(function (r) {
        if (!r.error) {
          b.url = r.main.uri; b.subUrl = r.sub ? r.sub.uri : '';
          b.onvif = { xaddr: r.xaddr, token: r.ptzToken || '', ptz: r.ptzXaddr || '', hasPtz: !!r.hasPtz };
          if (r.main.codec !== 'H264' || (r.sub && r.sub.codec !== 'H264')) b.transcode = true;
        } else detectErr = r.error;
        omsg(''); send();
      }).catch(function () { detectErr = 'no answer'; omsg(''); send(); });
    } else send();
  };

  // ---------- ONVIF: search, auto detect ----------
  var onv = null, found = [];
  function omsg(t, bad) { var e = $('#omsg'); e.textContent = t; e.style.color = bad ? 'var(--red)' : ''; }
  var autoName = '';
  function renderFound() {
    if (!found.length) { $('#found').innerHTML = '<div class="note">No ONVIF cameras found. Enter the IP address yourself.</div>'; return; }
    var have = {}; cams.forEach(function (c) { have[c.ip] = 1; });
    $('#found').innerHTML = found.map(function (d, i) {
      var dup = have[d.ip];
      return '<button class="ci' + (dup ? ' done' : '') + '" type="button" data-i="' + i + '"' + (dup ? ' disabled' : '') + '><span class="cn">' + esc(d.ip) + ' ' + esc(d.name) +
        '<small>' + (dup ? 'Already added' : 'ONVIF port ' + d.port + (d.hardware ? ' - ' + esc(d.hardware) : '')) + '</small></span></button>';
    }).join('');
  }
  $('#f-search').onclick = function () {
    $('#found').innerHTML = '<div class="note">Searching the network (about 4 seconds)...</div>';
    omsg('');
    api('/api/onvif/discover', 'POST', {}).then(function (list) { found = list; renderFound(); omsg(list.length ? 'Click the camera you want to add.' : ''); }).catch(function () { /* ignore */ });
  };
  function pick(i) {
    var d = found[i]; if (!d) return;
    document.querySelectorAll('#found .ci').forEach(function (x) { x.classList.toggle('on', +x.dataset.i === i); });
    $('#f-ip').value = d.ip; $('#f-oport').value = d.port; onv = null; $('#f-url').value = ''; $('#f-surl').value = '';
    if (!$('#f-name').value || $('#f-name').value === autoName) { autoName = d.name || ('Camera ' + d.ip); $('#f-name').value = autoName; }
    $('#err').textContent = '';
    omsg($('#f-pass').value ? 'The last used password is filled in. If this camera has no password, clear the Password box. Then press Auto detect streams.'
      : 'Enter the camera username and password (leave the password empty if the camera has none), then press Auto detect streams.');
    $('#f-detect').focus();
  }
  $('#found').onclick = function (e) { var b = e.target.closest('.ci'); if (!b || b.disabled) return; pick(+b.dataset.i); };
  $('#f-detect').onclick = function () {
    var ip = $('#f-ip').value.trim();
    if (!ip) { omsg('Enter the camera IP address first.'); return; }
    omsg('Detecting...');
    api('/api/onvif/probe', 'POST', { id: editing, ip: ip, port: +$('#f-oport').value || 80, user: $('#f-user').value, pass: $('#f-pass').value }).then(function (r) {
      if (r.error) { omsg(r.error + ($('#f-pass').value ? ' If this camera has no password, clear the Password box.' : ''), true); return; }
      $('#f-url').value = r.main.uri; $('#f-surl').value = r.sub ? r.sub.uri : '';
      onv = { xaddr: r.xaddr, token: r.ptzToken || '', ptz: r.ptzXaddr || '', hasPtz: !!r.hasPtz };
      var tc = r.main.codec !== 'H264' || (r.sub && r.sub.codec !== 'H264');
      if (tc) $('#f-tc').checked = true;
      var msg = 'Found ' + (r.sub ? '2 streams' : '1 stream') + ' (main ' + r.main.width + 'x' + r.main.height + ' ' + r.main.codec + '). PTZ: ' + (r.hasPtz ? 'yes' : 'no') + (tc ? '. H.265 conversion turned on.' : '.');
      omsg(msg + ' Press Save camera.');
    }).catch(function () { omsg('Detection failed.', true); });
  };

  // ---------- PTZ ----------
  var ptzT = null;
  function ptzSend(act, x, y, z) {
    var c = slots[sel]; if (!c) return;
    api('/api/cameras/' + c.id + '/ptz', 'POST', { action: act, x: x, y: y, z: z }).catch(function () { /* ignore */ });
  }
  function ptzEnd() { if (!ptzT) return; clearInterval(ptzT); ptzT = null; ptzSend('stop'); }
  ['#ptz', '#zoom'].forEach(function (id) {
    $(id).addEventListener('pointerdown', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      e.preventDefault();
      var x = +b.dataset.x || 0, y = +b.dataset.y || 0, z = +b.dataset.z || 0;
      ptzSend('move', x, y, z); clearInterval(ptzT);
      ptzT = setInterval(function () { ptzSend('move', x, y, z); }, 2000);
    });
  });
  window.addEventListener('pointerup', ptzEnd); window.addEventListener('pointercancel', ptzEnd);
  window.addEventListener('blur', ptzEnd);

  // ---------- sound ----------
  $('#snd').onclick = function () {
    soundOn = !soundOn; updSnd();
    var v = document.querySelector('#grid video'), c = slots[sel];
    if (v) { v.muted = !soundOn; v.play().catch(function () { /* ignore */ }); }
    if (soundOn && c && c.audio === false) toast('Audio is turned off for this camera. Edit the camera to turn it on.');
    else if (soundOn) toast('Sound on. If you hear nothing, the camera microphone may be off in the camera settings.');
  };

  // ---------- snapshot ----------
  var toastT;
  function toast(m, ms) { var t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = 'none'; }, ms || 2800); }
  function nowText() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function saveSnap(blob, name) {
    var P = window.Capacitor && window.Capacitor.Plugins;
    if (NATIVE && P && P.Filesystem && P.Share) {
      var fr = new FileReader();
      fr.onload = function () {
        P.Filesystem.writeFile({ path: name, data: String(fr.result).split(',')[1], directory: 'CACHE' })
          .then(function (r) { return P.Share.share({ title: name, url: r.uri }); })
          .catch(function () { toast('Could not save the snapshot.'); });
      };
      fr.readAsDataURL(blob);
    } else {
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); toast('Snapshot saved.');
    }
  }
  $('#snap').onclick = function () {
    var v = document.querySelector('#grid video'), c = slots[sel];
    if (!v || !c || !v.videoWidth) { toast('The video is not playing yet.'); return; }
    try {
      var cv = document.createElement('canvas'); cv.width = v.videoWidth; cv.height = v.videoHeight;
      var ctx = cv.getContext('2d'); ctx.drawImage(v, 0, 0, cv.width, cv.height);
      var fs = Math.max(14, Math.round(cv.height / 36)), hb = fs * 1.9, label = 'CH' + pad(c.ch) + ' ' + c.name + '   ' + nowText();
      ctx.font = '600 ' + fs + 'px sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(8, cv.height - hb - 8, ctx.measureText(label).width + 16, hb);
      ctx.fillStyle = '#fff'; ctx.fillText(label, 16, cv.height - hb / 2 - 8);
      cv.toBlob(function (b) {
        if (!b) { toast('Snapshot failed.'); return; }
        saveSnap(b, 'EvoTron_CH' + pad(c.ch) + '_' + nowText().replace(/[-: ]/g, '') + '.jpg');
      }, 'image/jpeg', 0.92);
    } catch (e) { toast('Snapshot failed.'); }
  };

  // ---------- playback ----------
  function resetPlayer() {
    var v = $('#pvid'), p = $('#pph');
    v.pause(); v.removeAttribute('src'); v.load();
    p.style.display = ''; p.querySelector('b').textContent = 'Select a recording'; p.querySelector('small').textContent = 'Choose a time from the list';
    $('#pnote').textContent = '';
  }
  function loadRecs() {
    var id = $('#pcam').value, d = $('#pdate').value;
    resetPlayer();
    if (!id || !d) { $('#rlist').innerHTML = ''; $('#rcount').textContent = ''; return; }
    api('/api/cameras/' + id + '/recordings?date=' + d).then(function (r) {
      $('#rcount').textContent = r.length ? r.length + (r.length === 1 ? ' file' : ' files') : '';
      $('#rlist').innerHTML = r.length ? r.map(function (f) {
        return '<button class="ci" type="button" data-u="' + f.url + '" data-t="' + f.time + '"><span class="cn">' + f.time + '<small>' + f.mb + ' MB</small></span></button>';
      }).join('') : '<div class="note" style="padding:8px">No recordings for this day.</div>';
    }).catch(function () { /* ignore */ });
  }
  $('#pcam').onchange = loadRecs; $('#pdate').onchange = loadRecs;
  $('#rlist').onclick = function (e) {
    var b = e.target.closest('.ci'); if (!b) return;
    document.querySelectorAll('#rlist .ci').forEach(function (x) { x.classList.toggle('on', x === b); });
    var v = $('#pvid'); v.src = API + b.dataset.u; $('#pph').style.display = 'none';
    v.play().catch(function () { /* ignore */ });
    var cam = $('#pcam').selectedOptions[0];
    $('#pnote').textContent = (cam ? cam.textContent : '') + ', ' + $('#pdate').value + ' ' + b.dataset.t;
  };
  $('#pvid').addEventListener('error', function () {
    if (!this.getAttribute('src')) return;
    var p = $('#pph'); p.style.display = ''; p.querySelector('b').textContent = 'Cannot play this recording';
    p.querySelector('small').textContent = 'The file may still be recording. Try again in a moment.';
  });

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
    if (v === 'set') loadRecovery();
  }
  $('#nav').onclick = function (e) { var b = e.target.closest('#nav > button'); if (b) showView(b.dataset.v); };
  $('#pwtop').onclick = function () { showView('set'); };
  $('#s-save').onclick = function () {
    api('/api/password', 'POST', { password: $('#s-pw').value }).then(function (r) {
      $('#s-msg').textContent = r.error || 'Password changed.';
      if (r.ok) { $('#s-pw').value = ''; $('#pwtop').style.display = 'none'; }
    }).catch(function () { /* ignore */ });
  };
  $('#s-forget').onclick = function () { store.set('evo_cred', ''); $('#s-msg').textContent = 'The remembered camera password was removed.'; };
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
  // show the real version and build number (written by the GitHub build)
  fetch('version.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) {
    var t = 'EvoTron v' + v.version + (v.build && v.build !== 'local' ? ' (build ' + v.build + ')' : '');
    $('#ver').textContent = t; $('#ver2').textContent = t;
  }).catch(function () { /* keep the default text */ });
  if (token) start(); else showLogin();
})();
