'use strict';
// Password recovery by email: a 6-digit code (valid 10 minutes, 5 tries) is mailed to the saved recovery address.
const crypto = require('crypto');

function mask(email) {
  const p = String(email).split('@');
  return (p[0] ? p[0][0] : '') + '***@' + (p[1] || '');
}

async function sendMail(smtp, to, subject, text) {
  let nm;
  try { nm = require('nodemailer'); } catch (e) { throw new Error('Email support is not installed (nodemailer is missing).'); }
  const port = parseInt(smtp.port, 10) || 587;
  const t = nm.createTransport({
    host: smtp.host, port, secure: port === 465, auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
  try { await t.sendMail({ from: smtp.from || smtp.user, to, subject, text }); } catch (e) { throw new Error('Could not send the email: ' + e.message); }
}

// deps: getCfg(), save(), hashPassword(p), clearTokens(), sendMail(smtp, to, subject, text), getSmtp() (optional)
function createRecovery(deps) {
  let pending = null;
  const sent = [];
  const sha = (c) => crypto.createHash('sha256').update('evotron-code:' + c).digest('hex');
  return {
    async request() {
      const r = deps.getCfg().recovery || {};
      const smtp = deps.getSmtp ? deps.getSmtp() : r.smtp;
      if (!r.email || !smtp || !smtp.host) throw new Error('Recovery email is not set up. Reset the password on the PC instead.');
      const now = Date.now();
      while (sent.length && now - sent[0] > 15 * 60e3) sent.shift();
      if (sent.length >= 3) throw new Error('Too many requests. Try again in 15 minutes.');
      sent.push(now);
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await deps.sendMail(smtp, r.email, 'EvoTron password reset code',
        'Your EvoTron reset code is ' + code + '.\nIt is valid for 10 minutes. If you did not ask for it, ignore this email.');
      pending = { hash: sha(code), expires: now + 10 * 60e3, tries: 0 };
      return mask(r.email);
    },
    confirm(code, password) {
      if (!pending || Date.now() > pending.expires) { pending = null; throw new Error('The code has expired. Ask for a new one.'); }
      if (String(password || '').length < 6) throw new Error('Use at least 6 characters for the password.');
      pending.tries++;
      const ok = crypto.timingSafeEqual(Buffer.from(sha(String(code || '').trim())), Buffer.from(pending.hash));
      if (!ok) { if (pending.tries >= 5) pending = null; throw new Error('Wrong code.'); }
      pending = null;
      const cfg = deps.getCfg();
      cfg.password = deps.hashPassword(password); cfg.defaultPw = false;
      deps.save(); deps.clearTokens();
    },
  };
}

module.exports = { createRecovery, sendMail, mask };
