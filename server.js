'use strict';
// EvoTron server: connects to IP cameras over RTSP (using FFmpeg), serves live video
// as HLS, records to disk, and exposes a small API used by the desktop and mobile apps.
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const onvif = require('./onvif');
const { createRecovery, sendMail } = require('./recovery');

const MAX_CH = 32;

// Camera microphones usually send G.711 audio, which browsers cannot play: convert it to AAC.
function audioArgs(enabled) {
  return enabled ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '48k', '-ar', '16000', '-ac', '1', '-af', 'aresample=async=1'] : ['-an'];
}

function createServer(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir || path.join(__dirname, 'data');
  const ffmpeg = opts.ffmpegPath || 'ffmpeg';
  const webDir = opts.webDir || path.join(__dirname, 'web');
  const port = opts.port || 8080;
  const hlsDir = path.join(dataDir, 'hls');
  const recDir = path.join(dataDir, 'recordings');
  const cfgFile = path.join(dataDir, 'config.json');
  [dataDir, hlsDir, recDir].forEach((d) => fs.mkdirSync(d, { recursive: true }));

  // ---------- config ----------
  let cfg = { salt: '', password: '', defaultPw: true, retentionDays: 7, cameras: [] };
  try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); } catch (e) { /* first run */ }
  if (!cfg.salt) cfg.salt = crypto.randomBytes(16).toString('hex');
  const hash = (p) => crypto.scryptSync(String(p), cfg.salt, 32).toString('hex');
  if (!cfg.password) { cfg.password = hash('admin'); cfg.defaultPw = true; }
  const save = () => fs.writeFileSync(cfgFile, JSON.stringify(cfg, (k, v) => (k[0] === '_' ? undefined : v), 2));
  save();
  const find = (id) => cfg.cameras.find((c) => c.id === id);

  // ---------- auth (single admin password, bearer tokens) ----------
  const tokens = new Map();
  const tokOk = (t) => { const e = tokens.get(t); return !!e && e > Date.now(); };
  const tok = (req) => (req.headers.authorization || '').slice(7);
  const auth = (req, res, next) => {
    const t = req.params.token || tok(req);
    if (tokOk(t)) return next();
    res.status(401).json({ error: 'auth' });
  };

  // ---------- helpers ----------
  const events = [];
  const addEvent = (c, type) => { events.unshift({ t: Date.now(), ch: c.ch, name: c.name, type }); events.length = Math.min(events.length, 200); };

  // Adds the camera username and password to an RTSP URL that has none.
  function withCreds(rawUrl, c) {
    try {
      const u = new URL(rawUrl);
      if (!u.username && c.user) { u.username = c.user; u.password = c.pass || ''; }
      return u.toString();
    } catch (e) { return rawUrl; }
  }
  function rtsp(c, sub) {
    if (c.url) return withCreds(sub && c.subUrl ? c.subUrl : c.url, c);
    const p = (sub && c.subPath) || c.path || '/';
    return 'rtsp://' + encodeURIComponent(c.user || '') + ':' + encodeURIComponent(c.pass || '') + '@' + c.ip + ':' + (c.port || 554) + p;
  }
  const FIELDS = ['ch', 'name', 'ip', 'port', 'user', 'pass', 'path', 'subPath', 'url', 'subUrl', 'transcode', 'record', 'audio'];
  const TEXT = ['name', 'ip', 'user', 'pass', 'path', 'subPath', 'url', 'subUrl'];
  function pick(b, old) {
    const o = Object.assign({}, old || {});
    FIELDS.forEach((k) => {
      if (b[k] === undefined) return;
      if (k === 'pass' && b[k] === '' && old) return; // blank = keep existing password
      o[k] = TEXT.indexOf(k) >= 0 ? String(b[k]) : b[k];
    });
    if (b.onvif !== undefined) {
      const v = b.onvif;
      const okUrl = (x) => (/^https?:\/\//i.test(String(x || '')) ? String(x) : '');
      o.onvif = v && typeof v === 'object' ? { xaddr: okUrl(v.xaddr), token: String(v.token || ''), ptz: okUrl(v.ptz), hasPtz: !!(v.hasPtz && okUrl(v.ptz)) } : undefined;
    }
    o.ch = parseInt(o.ch, 10); o.port = parseInt(o.port, 10) || 554;
    o.transcode = !!o.transcode; o.record = !!o.record; o.audio = o.audio === undefined ? true : !!o.audio;
    ['path', 'subPath'].forEach((k) => { if (o[k] && o[k][0] !== '/') o[k] = '/' + o[k]; });
    return o;
  }
  function validate(o, id) {
    if (!o.name || o.name.length > 40) return 'Enter a camera name (max 40 characters).';
    if (!(o.ch >= 1 && o.ch <= MAX_CH)) return 'Channel must be between 1 and ' + MAX_CH + '.';
    if (cfg.cameras.some((c) => c.ch === o.ch && c.id !== id)) return 'That channel is already used.';
    if (o.url) { if (!/^rtsps?:\/\//i.test(o.url)) return 'The RTSP URL must start with rtsp://'; }
    else if (!o.ip || !/^[A-Za-z0-9.\-]+$/.test(o.ip)) return 'Enter a valid IP address or host name.';
    if (o.subUrl && !/^rtsps?:\/\//i.test(o.subUrl)) return 'The sub stream URL must start with rtsp://';
    return null;
  }
  const pub = (c) => ({
    id: c.id, ch: c.ch, name: c.name, ip: c.ip || '', port: c.port, user: c.user || '', path: c.path || '', subPath: c.subPath || '',
    url: c.url || '', subUrl: c.subUrl || '', transcode: !!c.transcode, record: !!c.record,
    status: c._on ? 'online' : 'offline', recording: recs.has(c.id), audio: c.audio !== false,
    ptz: !!(c.onvif && c.onvif.hasPtz), onvif: c.onvif || null,
  });
  const waitFor = (f, ms) => new Promise((resolve) => {
    const t0 = Date.now();
    (function chk() { if (fs.existsSync(f)) return resolve(true); if (Date.now() - t0 > ms) return resolve(false); setTimeout(chk, 250); })();
  });

  // ---------- live streams (RTSP -> HLS, started on demand) ----------
  const streams = new Map();
  function startStream(c, q) {
    const key = c.id + '_' + q;
    let s = streams.get(key);
    if (s) { s.last = Date.now(); return s; }
    const dir = path.join(hlsDir, key);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // sound only on the main stream (grid tiles use the light sub stream)
    const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', rtsp(c, q === 'sub'), '-map', '0:v:0']
      .concat(audioArgs(c.audio !== false && q === 'main'));
    if (c.transcode) args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-vf', 'scale=-2:' + (q === 'sub' ? 360 : 720), '-g', '25');
    else args.push('-c:v', 'copy');
    args.push('-f', 'hls', '-hls_time', '2', '-hls_list_size', '4', '-hls_flags', 'delete_segments',
      '-hls_segment_filename', path.join(dir, 's%d.ts'), path.join(dir, 'index.m3u8'));
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    s = { proc, last: Date.now(), err: '' };
    streams.set(key, s);
    proc.stderr.on('data', (d) => { s.err = String(d).slice(-300); });
    const gone = () => { if (streams.get(key) === s) streams.delete(key); };
    proc.on('exit', gone); proc.on('error', (e) => { s.err = e.message; gone(); });
    return s;
  }
  function reap() {
    const now = Date.now();
    streams.forEach((s, k) => {
      if (now - s.last > 30000) { s.proc.kill(); streams.delete(k); fs.rm(path.join(hlsDir, k), { recursive: true, force: true }, () => {}); }
    });
  }
  function stopStreamsOf(id) {
    ['main', 'sub'].forEach((q) => { const s = streams.get(id + '_' + q); if (s) { s.proc.kill(); streams.delete(id + '_' + q); } });
  }

  // ---------- continuous recording (10 minute mp4 files) ----------
  const recs = new Map();
  let running = false;
  function startRec(c) {
    if (!c.record || !running || recs.has(c.id)) return;
    const dir = path.join(recDir, c.id);
    fs.mkdirSync(dir, { recursive: true });
    const rargs = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', rtsp(c, false), '-map', '0:v:0']
      .concat(audioArgs(c.audio !== false), ['-c:v', 'copy',
        '-f', 'segment', '-segment_time', '600', '-reset_timestamps', '1', '-strftime', '1', '-segment_format', 'mp4',
        '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof', path.join(dir, '%Y%m%d_%H%M%S.mp4')]);
    const p = spawn(ffmpeg, rargs, { windowsHide: true });
    recs.set(c.id, p);
    const done = () => {
      if (recs.get(c.id) !== p) return;
      recs.delete(c.id);
      if (!p.stopped) setTimeout(() => { const cur = find(c.id); if (cur) startRec(cur); }, 10000);
    };
    p.on('exit', done); p.on('error', done);
  }
  function stopRec(id) { const p = recs.get(id); if (p) { p.stopped = true; p.kill(); recs.delete(id); } }
  function cleanup() {
    const cut = Date.now() - cfg.retentionDays * 864e5;
    try {
      fs.readdirSync(recDir).forEach((d) => {
        const dir = path.join(recDir, d);
        fs.readdirSync(dir).forEach((f) => { const p = path.join(dir, f); try { if (fs.statSync(p).mtimeMs < cut) fs.unlinkSync(p); } catch (e) { /* ignore */ } });
      });
    } catch (e) { /* ignore */ }
  }

  // ---------- online / offline detection ----------
  function target(c) {
    try { if (c.ip) return [c.ip, c.port || 554]; const u = new URL(c.url); return [u.hostname, parseInt(u.port, 10) || 554]; } catch (e) { return null; }
  }
  const probe = (c) => new Promise((resolve) => {
    const t = target(c); if (!t) return resolve(false);
    const s = net.connect({ host: t[0], port: t[1], timeout: 1500 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
  function probeAll() {
    return Promise.all(cfg.cameras.map(async (c) => {
      const on = await probe(c);
      if (c._on !== on) { if (c._on !== undefined || !on) addEvent(c, on ? 'online' : 'offline'); c._on = on; }
    }));
  }

  // ---------- http api ----------
  const app = express();
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '50kb' }));

  app.post('/api/login', (req, res) => {
    const given = Buffer.from(hash((req.body || {}).password || ''), 'hex');
    const real = Buffer.from(cfg.password, 'hex');
    if (given.length === real.length && crypto.timingSafeEqual(given, real)) {
      const t = crypto.randomBytes(24).toString('hex');
      tokens.set(t, Date.now() + 30 * 864e5);
      return res.json({ token: t, defaultPassword: cfg.defaultPw });
    }
    setTimeout(() => res.status(401).json({ error: 'Wrong password' }), 800);
  });
  // Optional mail account supplied with the installer (mail-default.json) or by environment variables.
  // When present, users only enter their recovery email and never see the sending account.
  let defMail = null;
  try { defMail = JSON.parse(fs.readFileSync(path.join(__dirname, 'mail-default.json'), 'utf8')); } catch (e) { /* none */ }
  if (!defMail && process.env.EVOTRON_SMTP_USER) {
    defMail = { host: process.env.EVOTRON_SMTP_HOST || 'smtp.gmail.com', port: parseInt(process.env.EVOTRON_SMTP_PORT, 10) || 587, user: process.env.EVOTRON_SMTP_USER, pass: process.env.EVOTRON_SMTP_PASS };
  }
  const managed = !!(defMail && defMail.host && defMail.user && defMail.pass);
  const smtpNow = () => (managed ? { host: defMail.host, port: defMail.port || 587, user: defMail.user, pass: defMail.pass, from: defMail.from || defMail.user } : (cfg.recovery || {}).smtp);
  const recovery = createRecovery({ getCfg: () => cfg, save, hashPassword: hash, clearTokens: () => tokens.clear(), sendMail, getSmtp: smtpNow });
  const slow = (res, code, body) => setTimeout(() => res.status(code).json(body), 800); // slows down guessing
  app.post('/api/recover/request', async (req, res) => {
    try { res.json({ ok: true, to: await recovery.request() }); } catch (e) { slow(res, 400, { error: e.message }); }
  });
  app.post('/api/recover/confirm', (req, res) => {
    const b = req.body || {};
    try { recovery.confirm(b.code, b.password); res.json({ ok: true }); } catch (e) { slow(res, 400, { error: e.message }); }
  });
  app.get('/api/recovery', auth, (req, res) => {
    const r = cfg.recovery || {}, m = r.smtp || {};
    res.json({ managed, email: r.email || '', host: managed ? '' : m.host || '', port: m.port || 587, user: managed ? '' : m.user || '', hasPass: !managed && !!m.pass });
  });
  app.post('/api/recovery', auth, (req, res) => {
    const b = req.body || {}, old = (cfg.recovery && cfg.recovery.smtp) || {};
    const email = String(b.email || '').trim(), host = String(b.host || '').trim(), port = parseInt(b.port, 10) || 587;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid recovery email address.' });
    if (managed) { cfg.recovery = { email, smtp: old }; save(); return res.json({ ok: true }); }
    if (!/^[A-Za-z0-9.\-]+$/.test(host) || port < 1 || port > 65535) return res.status(400).json({ error: 'Enter a valid SMTP server and port.' });
    const user = String(b.user || '').trim();
    cfg.recovery = { email, smtp: { host, port, user, pass: b.pass ? String(b.pass) : old.pass || '', from: user } };
    save(); res.json({ ok: true });
  });
  app.post('/api/recovery/test', auth, async (req, res) => {
    const r = cfg.recovery || {};
    const smtp = smtpNow();
    if (!r.email || !smtp || !smtp.host) return res.status(400).json({ error: 'Save the email settings first.' });
    try { await sendMail(smtp, r.email, 'EvoTron test email', 'This is a test email from EvoTron. Password recovery by email is working.'); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/info', auth, (req, res) => res.json({ defaultPassword: cfg.defaultPw, maxChannels: MAX_CH }));
  app.post('/api/password', auth, (req, res) => {
    const p = String((req.body || {}).password || '');
    if (p.length < 6) return res.status(400).json({ error: 'Use at least 6 characters.' });
    cfg.password = hash(p); cfg.defaultPw = false; save(); res.json({ ok: true });
  });

  app.get('/api/cameras', auth, (req, res) => res.json(cfg.cameras.map(pub)));
  app.post('/api/cameras', auth, (req, res) => {
    const o = pick(req.body || {}); o.id = crypto.randomBytes(4).toString('hex');
    const err = validate(o, o.id); if (err) return res.status(400).json({ error: err });
    cfg.cameras.push(o); save(); startRec(o); probeAll(); res.json(pub(o));
  });
  app.put('/api/cameras/:id', auth, (req, res) => {
    const old = find(req.params.id); if (!old) return res.status(404).json({ error: 'No such camera' });
    const o = pick(req.body || {}, old); const err = validate(o, old.id); if (err) return res.status(400).json({ error: err });
    cfg.cameras[cfg.cameras.indexOf(old)] = o; save();
    stopStreamsOf(o.id); stopRec(o.id); startRec(o); probeAll(); res.json(pub(o));
  });
  app.delete('/api/cameras/:id', auth, (req, res) => {
    const c = find(req.params.id); if (!c) return res.status(404).json({ error: 'No such camera' });
    stopStreamsOf(c.id); stopRec(c.id);
    cfg.cameras = cfg.cameras.filter((x) => x !== c); save(); res.json({ ok: true });
  });
  app.post('/api/cameras/:id/start', auth, async (req, res) => {
    const c = find(req.params.id); if (!c) return res.status(404).json({ error: 'No such camera' });
    const q = req.query.q === 'sub' ? 'sub' : 'main';
    const s = startStream(c, q);
    const ok = await waitFor(path.join(hlsDir, c.id + '_' + q, 'index.m3u8'), 15000);
    res.json(ok ? { ok: true, path: '/s/' + tok(req) + '/' + c.id + '_' + q + '/index.m3u8' } : { ok: false, error: s.err || 'No video from this camera.' });
  });
  app.get('/api/cameras/:id/recordings', auth, (req, res) => {
    const c = find(req.params.id); if (!c) return res.status(404).json({ error: 'No such camera' });
    const d = String(req.query.date || '').replace(/-/g, '');
    if (!/^\d{8}$/.test(d)) return res.json([]);
    const dir = path.join(recDir, c.id); let out = [];
    try {
      out = fs.readdirSync(dir).filter((f) => f.startsWith(d) && f.endsWith('.mp4')).sort().map((f) => ({
        file: f, time: f.slice(9, 11) + ':' + f.slice(11, 13) + ':' + f.slice(13, 15),
        mb: (fs.statSync(path.join(dir, f)).size / 1048576).toFixed(1), url: '/r/' + tok(req) + '/' + c.id + '/' + f,
      }));
    } catch (e) { /* no recordings yet */ }
    res.json(out);
  });
  // ONVIF: find cameras on the network, read their streams, and control PTZ
  app.post('/api/onvif/discover', auth, async (req, res) => {
    try { res.json(await onvif.discover({ timeout: 3500 })); } catch (e) { res.json([]); }
  });
  app.post('/api/onvif/probe', auth, async (req, res) => {
    const b = req.body || {};
    const ip = String(b.ip || '').trim();
    if (!/^[A-Za-z0-9.\-]+$/.test(ip)) return res.status(400).json({ error: 'Enter a valid IP address first.' });
    let pass = String(b.pass || '');
    const old = b.id ? find(String(b.id)) : null;
    if (!pass && old) pass = old.pass || '';
    try {
      res.json(await onvif.inspect({ ip, port: parseInt(b.port, 10) || 80, user: String(b.user || ''), pass }));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  const ptzTimers = new Map();
  app.post('/api/cameras/:id/ptz', auth, async (req, res) => {
    const c = find(req.params.id);
    if (!c || !c.onvif || !c.onvif.hasPtz) return res.status(400).json({ error: 'PTZ is not available for this camera.' });
    const b = req.body || {};
    const n = (v) => Math.max(-1, Math.min(1, Number(v) || 0));
    clearTimeout(ptzTimers.get(c.id));
    try {
      if (b.action === 'move') {
        await onvif.ptzMove(c, n(b.x), n(b.y), n(b.z));
        ptzTimers.set(c.id, setTimeout(() => { onvif.ptzStop(c).catch(() => {}); }, 4000)); // safety stop
      } else await onvif.ptzStop(c);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/events', auth, (req, res) => res.json(events));

  // media (token is part of the path so <video> and native HLS players can load it)
  app.use('/s/:token', auth, (req, res, next) => {
    const s = streams.get(req.path.split('/')[1]); if (s) s.last = Date.now(); next();
  }, express.static(hlsDir, { etag: false, setHeaders: (r) => r.setHeader('Cache-Control', 'no-store') }));
  app.use('/r/:token', auth, express.static(recDir));

  app.get('/vendor/hls.js', (req, res) => res.sendFile(require.resolve('hls.js/dist/hls.min.js')));
  app.use(express.static(webDir));

  let server;
  const timers = [];
  return {
    port,
    start() {
      running = true; server = http.createServer(app);
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          cfg.cameras.forEach(startRec); probeAll(); cleanup();
          timers.push(setInterval(probeAll, 15000), setInterval(reap, 10000), setInterval(cleanup, 3600e3));
          resolve();
        });
      });
    },
    // Used by the desktop app menu (not reachable over the network): back to the default password "admin".
    resetPassword() { cfg.password = hash('admin'); cfg.defaultPw = true; save(); tokens.clear(); },
    stop() {
      running = false; timers.forEach(clearInterval);
      streams.forEach((s) => s.proc.kill()); recs.forEach((p) => { p.stopped = true; p.kill(); });
      if (server) server.close();
    },
  };
}

module.exports = { createServer, audioArgs };

if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 8080;
  createServer({ port }).start().then(() => console.log('EvoTron server running on http://localhost:' + port + '  (default password: admin)'));
}
