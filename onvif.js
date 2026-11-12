'use strict';
// Small ONVIF client without extra packages: WS-Discovery, stream URIs and PTZ.
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

const NS = {
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
};
const ACT = {
  time: NS.tds + '/GetSystemDateAndTime',
  caps: NS.tds + '/GetCapabilities',
  profiles: NS.trt + '/GetProfiles',
  stream: NS.trt + '/GetStreamUri',
  move: NS.tptz + '/ContinuousMove',
  stop: NS.tptz + '/Stop',
};

// ---------- tiny XML helpers ----------
const unesc = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function tags(xml, name) {
  const re = new RegExp('<(?:\\w+:)?' + name + '\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?' + name + '>)', 'g');
  const out = []; let m;
  while ((m = re.exec(xml || ''))) out.push({ attrs: m[1] || '', inner: m[2] || '' });
  return out;
}
function raw(xml, name) { const t = tags(xml, name)[0]; return t ? t.inner : ''; }
function tag(xml, name) { return unesc(raw(xml, name).trim()); }

// ---------- SOAP ----------
function security(user, pass, offsetMs) {
  const nonce = crypto.randomBytes(16);
  const created = new Date(Date.now() + (offsetMs || 0)).toISOString().replace(/\.\d+Z$/, 'Z');
  const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(String(pass || ''))])).digest('base64');
  return '<s:Header><wsse:Security s:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' +
    '<wsse:UsernameToken><wsse:Username>' + esc(user) + '</wsse:Username>' +
    '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' + digest + '</wsse:Password>' +
    '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' + nonce.toString('base64') + '</wsse:Nonce>' +
    '<wsu:Created>' + created + '</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>';
}
const envelope = (body, header) => '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' + (header || '') + '<s:Body>' + body + '</s:Body></s:Envelope>';

function post(url, xml, action, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8; action="' + action + '"', 'Content-Length': Buffer.byteLength(xml) },
      timeout: timeout || 8000, rejectUnauthorized: false,
    }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer')));
    req.on('error', reject);
    req.end(xml);
  });
}

async function call(url, action, body, auth) {
  const header = auth && auth.user ? security(auth.user, auth.pass, auth.offset) : '';
  let r;
  try { r = await post(url, envelope(body, header), action, 8000); } catch (e) {
    const err = new Error('Cannot reach the camera at ' + url.replace(/^https?:\/\//, '').split('/')[0] + ' (' + e.message + '). Check the IP address and ONVIF port.');
    err.network = true; throw err;
  }
  const denied = /NotAuthorized|not authorized|Sender not/i.test(r.body);
  if (r.status === 401 || denied) throw new Error('Wrong username or password (or ONVIF is turned off in the camera).');
  if (/<(?:\w+:)?Fault\b/.test(r.body)) throw new Error('Camera error: ' + (tag(r.body, 'Text') || 'unknown'));
  if (r.status >= 400) throw new Error('The camera answered with HTTP ' + r.status + '.');
  return r.body;
}

// The camera clock may differ from this PC; WS-Security needs the camera time.
async function getOffset(xaddr) {
  try {
    const x = await call(xaddr, ACT.time, '<tds:GetSystemDateAndTime xmlns:tds="' + NS.tds + '"/>', null);
    const u = raw(x, 'UTCDateTime'); if (!u) return 0;
    const g = (n) => parseInt(tag(u, n), 10);
    const t = Date.UTC(g('Year'), g('Month') - 1, g('Day'), g('Hour'), g('Minute'), g('Second'));
    return isNaN(t) ? 0 : t - Date.now();
  } catch (e) { if (e.network) throw e; return 0; }
}

function fixHost(rawUrl, ip) { try { const u = new URL(rawUrl); u.hostname = ip; return u.toString(); } catch (e) { return rawUrl; } }
function fixStream(rawUrl, ip) { try { const u = new URL(rawUrl); u.hostname = ip; u.username = ''; u.password = ''; return u.toString(); } catch (e) { return rawUrl; } }
function codecOf(s) { const c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return c === 'HEVC' ? 'H265' : c; }

// ---------- inspect a camera: find streams and PTZ ----------
async function inspect(o) {
  const ip = o.ip;
  const xaddr = o.xaddr || ('http://' + ip + ':' + (o.port || 80) + '/onvif/device_service');
  const base = xaddr.split('/').slice(0, 3).join('/');
  const offset = await getOffset(xaddr);
  const auth = { user: o.user, pass: o.pass, offset };

  let mediaX = '', ptzX = '';
  try {
    const caps = await call(xaddr, ACT.caps, '<tds:GetCapabilities xmlns:tds="' + NS.tds + '"><tds:Category>All</tds:Category></tds:GetCapabilities>', auth);
    mediaX = tag(raw(caps, 'Media'), 'XAddr'); ptzX = tag(raw(caps, 'PTZ'), 'XAddr');
  } catch (e) { if (e.network || /password/i.test(e.message)) throw e; }
  mediaX = mediaX ? fixHost(mediaX, ip) : base + '/onvif/media_service';
  ptzX = ptzX ? fixHost(ptzX, ip) : '';

  const pr = await call(mediaX, ACT.profiles, '<trt:GetProfiles xmlns:trt="' + NS.trt + '"/>', auth);
  let profiles = tags(pr, 'Profiles').map((p) => {
    const v = raw(p.inner, 'VideoEncoderConfiguration'), res = raw(v, 'Resolution');
    const m = /\btoken\s*=\s*["']([^"']+)["']/.exec(p.attrs);
    return {
      token: m ? m[1] : '', name: tag(p.inner, 'Name'), width: parseInt(tag(res, 'Width'), 10) || 0, height: parseInt(tag(res, 'Height'), 10) || 0,
      codec: codecOf(tag(v, 'Encoding')), ptz: /<(?:\w+:)?PTZConfiguration\b/.test(p.inner),
    };
  }).filter((p) => p.token && p.width);
  if (!profiles.length) throw new Error('The camera has no video profiles.');
  const good = profiles.filter((p) => p.codec === 'H264' || p.codec === 'H265');
  if (good.length) profiles = good;
  profiles.sort((a, b) => b.width * b.height - a.width * a.height);

  async function streamOf(p) {
    const body = '<trt:GetStreamUri xmlns:trt="' + NS.trt + '"><trt:StreamSetup><tt:Stream xmlns:tt="' + NS.tt + '">RTP-Unicast</tt:Stream><tt:Transport xmlns:tt="' + NS.tt + '"><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>' + esc(p.token) + '</trt:ProfileToken></trt:GetStreamUri>';
    const x = await call(mediaX, ACT.stream, body, auth);
    const uri = tag(raw(x, 'MediaUri'), 'Uri') || tag(x, 'Uri');
    if (!uri) throw new Error('The camera did not give a stream address.');
    return { token: p.token, uri: fixStream(uri, ip), width: p.width, height: p.height, codec: p.codec };
  }
  const main = await streamOf(profiles[0]);
  const last = profiles[profiles.length - 1];
  const sub = profiles.length > 1 && last.token !== profiles[0].token ? await streamOf(last) : null;
  const pp = profiles.find((p) => p.ptz);
  return { xaddr, main, sub, hasPtz: !!(ptzX && pp), ptzXaddr: ptzX, ptzToken: pp ? pp.token : '' };
}

// ---------- PTZ ----------
const offsets = new Map();
async function ptzAuth(cam) {
  const x = cam.onvif.xaddr || cam.onvif.ptz;
  if (!offsets.has(x)) offsets.set(x, await getOffset(x));
  return { user: cam.user, pass: cam.pass, offset: offsets.get(x) };
}
async function ptzMove(cam, x, y, z) {
  const n = (v) => Number(v).toFixed(2);
  const body = '<tptz:ContinuousMove xmlns:tptz="' + NS.tptz + '" xmlns:tt="' + NS.tt + '"><tptz:ProfileToken>' + esc(cam.onvif.token) + '</tptz:ProfileToken><tptz:Velocity><tt:PanTilt x="' + n(x) + '" y="' + n(y) + '"/><tt:Zoom x="' + n(z) + '"/></tptz:Velocity></tptz:ContinuousMove>';
  await call(cam.onvif.ptz, ACT.move, body, await ptzAuth(cam));
}
async function ptzStop(cam) {
  const body = '<tptz:Stop xmlns:tptz="' + NS.tptz + '"><tptz:ProfileToken>' + esc(cam.onvif.token) + '</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>';
  await call(cam.onvif.ptz, ACT.stop, body, await ptzAuth(cam));
}

// ---------- WS-Discovery ----------
function localIPv4s() {
  const out = [];
  Object.values(os.networkInterfaces()).forEach((list) => (list || []).forEach((i) => { if ((i.family === 'IPv4' || i.family === 4) && !i.internal) out.push(i.address); }));
  return out.length ? out : ['0.0.0.0'];
}
function discover(opts) {
  opts = opts || {};
  const timeout = opts.timeout || 3000, addr = opts.address || '239.255.255.250', port = opts.port || 3702;
  const probe = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:' + crypto.randomUUID() + '</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>');
  return new Promise((resolve) => {
    const found = new Map(), socks = [];
    (opts.interfaces || localIPv4s()).forEach((ip) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socks.push(s);
      s.on('error', () => {});
      s.on('message', (msg) => {
        const xml = msg.toString('utf8');
        const url = (tag(xml, 'XAddrs').split(/\s+/).filter((x) => /^https?:\/\/[^[]/.test(x))[0]) || '';
        if (!url) return;
        let u; try { u = new URL(url); } catch (e) { return; }
        if (found.has(u.hostname)) return;
        const scopes = tag(xml, 'Scopes'), pick = (k) => { const m = new RegExp('onvif://www\\.onvif\\.org/' + k + '/(\\S+)').exec(scopes); try { return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return m ? m[1] : ''; } };
        found.set(u.hostname, { ip: u.hostname, port: parseInt(u.port, 10) || 80, xaddr: url, name: pick('name'), hardware: pick('hardware') });
      });
      s.bind(0, ip, () => { try { s.setMulticastInterface(ip); } catch (e) { /* ignore */ } try { s.send(probe, port, addr); } catch (e) { /* ignore */ } });
    });
    setTimeout(() => { socks.forEach((s) => { try { s.close(); } catch (e) { /* ignore */ } }); resolve(Array.from(found.values())); }, timeout);
  });
}

module.exports = { inspect, ptzMove, ptzStop, discover };
