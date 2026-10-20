// ronw-planner — guild party planner
// Zero-dependency Node server. Serves the app, handles accounts, and keeps each guild's data in guilds/<id>/data.json.
// Usage: node server.js   (then open http://localhost:4747)
// Settings (environment variables):
//   PORT         port to listen on (default 4747)
//   HOST         address to listen on (default 127.0.0.1; use 0.0.0.0 on hosting platforms)
//   DATA_DIR     where users.json and guilds/ are kept (default: this folder; point it at a persistent volume when hosted)
//   TRUST_PROXY  set to 1 when a hosting platform's proxy sits in front, so real visitor IPs and HTTPS are seen

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 4747;
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || ROOT);
const GUILDS = path.join(DATA_DIR, 'guilds');
const ACCOUNTS = path.join(DATA_DIR, 'users.json');
const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());
const SESSION_DAYS = 30;
const COOKIE = 'ronw_sid';
const ROLES = { member: 1, officer: 2, leader: 3 };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- per-guild data ----------
const validGid = (id) => /^g[a-f0-9]{10}$/.test(String(id || ''));
const guildFile = (gid) => path.join(GUILDS, gid, 'data.json');

function readState(gid) {
  try { return JSON.parse(fs.readFileSync(guildFile(gid), 'utf8')); } catch { return null; }
}
function writeState(gid, obj) {
  fs.mkdirSync(path.join(GUILDS, gid), { recursive: true });
  writeJson(guildFile(gid), obj);
  liveNotify(gid, obj._rev || 0);
}

// ---------- live updates ----------
// Open pages keep one Server-Sent Events connection per guild. When the guild's data is saved, each one gets
// a tiny "changed" signal with the new revision (never the data itself) and re-fetches what it's allowed to see.
const live = new Map(); // guild id -> Set of open responses
let liveCount = 0;
const LIVE_MAX = 2000;
function liveSubscribe(req, res, gid) {
  if (liveCount >= LIVE_MAX) return send(res, 503, { error: 'Too many live connections. Refresh the page later.' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  if (!live.has(gid)) live.set(gid, new Set());
  live.get(gid).add(res); liveCount++;
  // A comment every 25 seconds keeps proxies from closing a quiet connection.
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    const set = live.get(gid); if (set && set.delete(res)) liveCount--;
    if (set && !set.size) live.delete(gid);
  });
}
function liveNotify(gid, rev) {
  const set = live.get(gid); if (!set) return;
  const msg = `data: ${JSON.stringify({ rev })}\n\n`;
  for (const res of set) { try { res.write(msg); } catch { /* closed; cleaned up on 'close' */ } }
}
// Keep one backup per hour, newest 48, per guild.
function backup(gid) {
  const file = guildFile(gid);
  if (!fs.existsSync(file)) return;
  const dir = path.join(GUILDS, gid, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 13).replace(/[:T]/g, '-');
  const out = path.join(dir, `data-${stamp}.json`);
  if (!fs.existsSync(out)) fs.copyFileSync(file, out);
  const all = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  all.slice(0, Math.max(0, all.length - 48)).forEach(f => fs.unlinkSync(path.join(dir, f)));
}

// Same name matching as the app: ignore case, spaces and symbols.
const normName = (s) => { const a = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); return a || String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); };
// A spot belongs to a roster member when it's linked to them, or (for spots added by name, like a pasted Discord list) has their name.
const owns = (e, m) => !!m && (e.memberId ? e.memberId === m.id : normName(e.name) === normName(m.name));
// Waiting reservations as shown publicly, each marked with whether the name is in the roster.
// For a logged-in member (me), their own spots also carry an id and mine: true so they can edit or remove them.
function publicEntries(s, me = null) {
  const ids = new Set((s.members || []).map(m => m.id));
  const names = new Set((s.members || []).map(m => normName(m.name)).filter(Boolean));
  return ((s.auction && s.auction.entries) || []).filter(e => e.status === 'waiting')
    .map(e => {
      const out = { catId: e.catId, name: e.name, item: e.item, pos: e.pos, inRoster: (e.memberId && ids.has(e.memberId)) || names.has(normName(e.name)) };
      if (owns(e, me)) Object.assign(out, { id: e.id, mine: true });
      return out;
    });
}
const waitingIn = (a, catId) => (a.entries || []).filter(e => e.catId === catId && e.status === 'waiting').sort((x, y) => x.pos - y.pos);
const nextPos = (a, catId) => (a.entries || []).filter(e => e.catId === catId).reduce((m, e) => Math.max(m, e.pos || 0), 0) + 1;
// Active roster members a guildmate can pick their name from.
const selfAddRoster = (s) => (s.members || []).filter(m => m.active !== false && m.name);

// Adds a member's own reservation at the end of a list. Returns { error } or { place }.
function addReservation(gid, s, member, catId, rawItem) {
  const a = s.auction;
  const cat = (a.categories || []).find(c => c.id === catId);
  const item = String(rawItem || '').trim().slice(0, 120);
  if (!cat) return { error: 'Pick a list.' };
  if (!item) return { error: 'Say what you want.' };
  a.entries = a.entries || [];
  // One spot per person per list.
  const line = waitingIn(a, cat.id); const had = line.findIndex(e => owns(e, member));
  if (had >= 0) return { error: `You already have a spot in ${cat.name} (#${had + 1}). Only one spot per list.`, code: 409 };
  if (s._officerRev == null) s._officerRev = s._rev || 0;
  const rev = (s._rev || 0) + 1;
  const pos = nextPos(a, cat.id);
  a.entries.push({ id: 'rs_' + crypto.randomBytes(6).toString('hex'), catId: cat.id, name: member.name, memberId: member.id, item, status: 'waiting', pos, addedAt: new Date().toISOString(), selfRev: rev });
  s._rev = rev; s._savedAt = new Date().toISOString();
  backup(gid);
  writeState(gid, s);
  return { place: a.entries.filter(e => e.catId === cat.id && e.status === 'waiting' && e.pos <= pos).length };
}

// A member edits or removes one of their own waiting spots. Returns { error } or {}.
function changeOwnReservation(gid, s, member, id, rawItem, remove) {
  const a = s.auction || {};
  const e = (a.entries || []).find(x => x.id === id && x.status === 'waiting');
  if (!e || !owns(e, member)) return { error: 'That spot isn’t yours, or it’s already gone.', code: 404 };
  const item = String(rawItem || '').trim().slice(0, 120);
  if (!remove && !item) return { error: 'Say what you want.' };
  if (s._officerRev == null) s._officerRev = s._rev || 0;
  const rev = (s._rev || 0) + 1;
  if (remove) {
    a.entries = a.entries.filter(x => x !== e);
    a.gone = [...(a.gone || []), { id: e.id, rev }].slice(-300);
  } else Object.assign(e, { item, selfRev: rev, editedAt: new Date().toISOString() });
  s._rev = rev; s._savedAt = new Date().toISOString();
  backup(gid);
  writeState(gid, s);
  return {};
}

// Finds which guild a share token belongs to.
function findShare(token) {
  if (!token) return null;
  for (const g of readDb().guilds) {
    const s = readState(g.id); if (!s) continue;
    if (s.auction && s.auction.shareToken === token) return { gid: g.id, s, auction: true };
    const ev = (s.events || []).find(e => e.shareToken && e.shareToken === token);
    if (ev) return { gid: g.id, s, ev };
  }
  return null;
}

// ---------- accounts, sessions and guild membership ----------
// users.json: { users: [{username, salt, hash, admin?, canCreateGuild?}], sessions: {sha(token): {user, exp, guild}},
//               guilds: [{id, name, invite, people: [{username, role, memberId}]}],
//               site: {inviteOnly}, starts: [{code, exp}] }. It is never served.
// The site admin (the first account) decides whether sign-up is invite-only and hands out new-guild links.
function readDb() {
  let d = {}; try { d = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); } catch {}
  const now = Date.now();
  return { users: d.users || [], sessions: d.sessions || {}, guilds: d.guilds || [], site: { inviteOnly: true, ...(d.site || {}) }, starts: (d.starts || []).filter(x => x.exp > now) };
}
function writeDb(d) {
  const now = Date.now();
  Object.keys(d.sessions).forEach(k => { if (d.sessions[k].exp < now) delete d.sessions[k]; });
  writeJson(ACCOUNTS, d);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newInvite = () => crypto.randomBytes(9).toString('base64url');
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
function checkPassword(user, pw) {
  const a = Buffer.from(hashPassword(pw, user.salt).hash, 'hex'), b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const findUser = (d, name) => d.users.find(x => same(x.username, name));
const personIn = (g, name) => g.people.find(p => same(p.username, name));
const guildsOf = (d, name) => d.guilds.filter(g => personIn(g, name));
const START_DAYS = 7;
const findStart = (d, code) => code && d.starts.find(x => x.code === code);
// Can this account start a guild? Only when it isn't in one, and the site is open or the admin allowed it.
const mayCreateGuild = (d, user) => !guildsOf(d, user.username).length && (!d.site.inviteOnly || !!user.admin || !!user.canCreateGuild);
function validNewUser(d, username, password) {
  if (!/^[\p{L}\p{N}_.\- ]{2,32}$/u.test(String(username || '').trim())) return 'Username must be 2–32 letters, numbers, spaces, dots, dashes or underscores.';
  if (findUser(d, username)) return 'That username is taken.';
  if (String(password || '').length < 8) return 'Password must be at least 8 characters.';
  return null;
}
function addUser(d, username, password) {
  const user = { username: String(username).trim(), ...hashPassword(password), createdAt: new Date().toISOString() };
  if (!d.users.length) user.admin = true;
  d.users.push(user);
  return user;
}
// Deleting an account removes the login, its sessions and its place in a guild. Guild data and roster entries stay.
// Returns an error message when it isn't allowed.
function accountDeleteProblem(d, username) {
  const user = findUser(d, username); if (!user) return 'No such account.';
  if (user.admin && d.users.filter(u => u.admin).length === 1) return 'This is the only site admin account. Make another admin first (node server.js make-admin <name>).';
  for (const g of guildsOf(d, user.username)) {
    const p = personIn(g, user.username);
    if (p.role === 'leader' && g.people.length > 1 && g.people.filter(x => x.role === 'leader').length === 1) return `${user.username} is the only leader of ${g.name}. Make someone else leader first.`;
  }
  return null;
}
function deleteAccount(d, username) {
  const user = findUser(d, username);
  const emptied = [];
  d.guilds.forEach(g => {
    if (!personIn(g, user.username)) return;
    g.people = g.people.filter(p => !same(p.username, user.username));
    if (!g.people.length) emptied.push(g.name);
  });
  Object.keys(d.sessions).forEach(k => { if (same(d.sessions[k].user, user.username)) delete d.sessions[k]; });
  d.users = d.users.filter(u => u !== user);
  return { emptied };
}
function createGuild(d, name, leader) {
  let id; do { id = 'g' + crypto.randomBytes(5).toString('hex'); } while (d.guilds.some(g => g.id === id));
  const g = { id, name: String(name).trim().slice(0, 60) || 'My Guild', createdAt: new Date().toISOString(), invite: newInvite(), people: leader ? [{ username: leader, role: 'leader', memberId: null }] : [] };
  d.guilds.push(g);
  writeState(id, { guild: { name: g.name }, _rev: 0, _officerRev: 0 });
  return g;
}

// Requests from this machine that did not come through a proxy (Caddy, nginx, cloudflared all add a header).
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const isDirectLocal = (req) => !TRUST_PROXY && isLoopback(req) && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'] && !req.headers['x-real-ip'];
// Proxy headers are only believed from a proxy we trust: one on this machine, or the hosting platform's when TRUST_PROXY is on.
const trusted = (req) => TRUST_PROXY || isLoopback(req);
// The proxy appends the real visitor IP last; earlier entries can be faked by the visitor.
const lastForwarded = (req) => String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean).pop();
const clientIp = (req) => (trusted(req) && (req.headers['cf-connecting-ip'] || req.headers['fly-client-ip'] || lastForwarded(req))) || req.socket.remoteAddress;
const isHttps = (req) => req.socket.encrypted || (trusted(req) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

function cookieToken(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return m ? m[1] : null;
}
// Who is calling, and their active guild and role in it. Null when not logged in.
function auth(req) {
  const t = cookieToken(req); if (!t) return null;
  const d = readDb(); const key = sha(t); const s = d.sessions[key];
  if (!s || s.exp < Date.now()) return null;
  const user = findUser(d, s.user); if (!user) return null;
  let g = d.guilds.find(x => x.id === s.guild && personIn(x, user.username));
  if (!g) { g = guildsOf(d, user.username)[0] || null; s.guild = g ? g.id : null; writeDb(d); }
  const p = g && personIn(g, user.username);
  return { d, key, session: s, username: user.username, guild: g, role: p ? p.role : null, person: p };
}
const can = (ctx, role) => ctx && ctx.guild && ROLES[ctx.role] >= ROLES[role];
function startSession(req, res, d, username, guild = null) {
  const t = crypto.randomBytes(32).toString('hex');
  d.sessions[sha(t)] = { user: username, exp: Date.now() + SESSION_DAYS * 864e5, guild: guild || (guildsOf(d, username)[0] || {}).id || null };
  writeDb(d);
  res.setHeader('Set-Cookie', `${COOKIE}=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
}
// Blocks other websites from making a logged-in browser change things here.
function sameOrigin(req) {
  const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

// Slow down password guessing and mass sign-ups, per IP.
const limits = new Map();
function limited(kind, ip, max, ms) { const f = limits.get(kind + ip); return f && f.n >= max && Date.now() - f.t < ms; }
function note(kind, ip, ms) { const k = kind + ip; const f = limits.get(k); if (!f || Date.now() - f.t > ms) limits.set(k, { n: 1, t: Date.now() }); else f.n++; }

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 20e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) { try { return JSON.parse(await readBody(req)); } catch { return {}; } }

const meInfo = (ctx) => ({
  user: ctx.username,
  admin: !!findUser(ctx.d, ctx.username).admin,
  canCreate: mayCreateGuild(ctx.d, findUser(ctx.d, ctx.username)),
  inviteOnly: ctx.d.site.inviteOnly,
  guilds: guildsOf(ctx.d, ctx.username).map(g => ({ id: g.id, name: g.name, role: personIn(g, ctx.username).role })),
  active: ctx.guild ? { id: ctx.guild.id, name: ctx.guild.name, role: ctx.role, memberId: ctx.person.memberId || null } : null,
});

// ---------- account and guild API ----------
async function handleApi(req, res, p) {
  if (p === '/api/me') {
    const ctx = auth(req);
    if (ctx) return send(res, 200, meInfo(ctx));
    const d = readDb();
    return send(res, 401, { error: 'login required', signup: d.site.inviteOnly && d.users.length ? 'invite' : 'open' });
  }
  if (p === '/api/signup' && req.method === 'POST') {
    const d = readDb(); const ip = clientIp(req);
    if (limited('signup', ip, 5, 3600e3)) return send(res, 429, { error: 'Too many new accounts from here. Try again later.' });
    const b = await readJson(req);
    // Invite-only: a guild invite (joins that guild) or a new-guild link from the admin is needed. The very first account is always allowed.
    const joinTo = b.code && d.guilds.find(g => g.invite === b.code);
    const start = findStart(d, b.code);
    if (d.site.inviteOnly && d.users.length && !joinTo && !start) return send(res, 403, { error: 'Sign-up is by invite only. Ask your guild leader for an invite link.' });
    const err = validNewUser(d, b.username, b.password);
    if (err) return send(res, 400, { error: err });
    const username = b.username.trim();
    const user = addUser(d, username, b.password); note('signup', ip, 3600e3);
    if (joinTo) joinTo.people.push({ username, role: 'member', memberId: null });
    else if (start) { user.canCreateGuild = true; d.starts = d.starts.filter(x => x !== start); }
    // Data moved over from before guilds existed goes to the first account made on the server's own computer.
    const orphan = !joinTo && isDirectLocal(req) && d.guilds.find(g => g.unclaimed);
    if (orphan) { delete orphan.unclaimed; orphan.people.push({ username, role: 'leader', memberId: null }); }
    startSession(req, res, d, username);
    return send(res, 200, { ok: true, claimed: orphan ? orphan.name : null });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (limited('login', ip, 10, 15 * 60e3)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
    const b = await readJson(req); const d = readDb(); const user = findUser(d, b.username);
    if (!user || !checkPassword(user, b.password || '')) { note('login', ip, 15 * 60e3); return send(res, 401, { error: 'Wrong username or password.' }); }
    limits.delete('login' + ip); startSession(req, res, d, user.username);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const t = cookieToken(req);
    if (t) { const d = readDb(); delete d.sessions[sha(t)]; writeDb(d); }
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return send(res, 200, { ok: true });
  }
  const inv = p.match(/^\/api\/invite\/([\w-]+)$/);
  if (inv && req.method === 'GET') {
    const d = readDb(); const g = d.guilds.find(x => x.invite === inv[1]);
    if (g) return send(res, 200, { kind: 'join', guild: g.name });
    if (findStart(d, inv[1])) return send(res, 200, { kind: 'start' });
    return send(res, 404, { error: 'This invite link is not valid anymore.' });
  }

  // Everything below needs a login.
  const ctx = auth(req);
  if (!ctx) return send(res, 401, { error: 'login required' });
  const { d } = ctx;

  if (p === '/api/account/delete' && req.method === 'POST') {
    const b = await readJson(req); const user = findUser(d, ctx.username);
    if (!checkPassword(user, b.password || '')) return send(res, 400, { error: 'That password is wrong.' });
    const problem = accountDeleteProblem(d, ctx.username); if (problem) return send(res, 400, { error: problem });
    deleteAccount(d, ctx.username); writeDb(d);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/password' && req.method === 'POST') {
    const b = await readJson(req); const user = findUser(d, ctx.username);
    if (!checkPassword(user, b.current || '')) return send(res, 400, { error: 'Your current password is wrong.' });
    if (String(b.next || '').length < 8) return send(res, 400, { error: 'New password must be at least 8 characters.' });
    Object.assign(user, hashPassword(b.next));
    Object.keys(d.sessions).forEach(k => { if (d.sessions[k].user === user.username && k !== ctx.key) delete d.sessions[k]; });
    writeDb(d);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/guilds' && req.method === 'POST') {
    const b = await readJson(req); const user = findUser(d, ctx.username);
    if (guildsOf(d, ctx.username).length) return send(res, 400, { error: 'You are already in a guild. One account can only be in one guild.' });
    if (!mayCreateGuild(d, user)) return send(res, 403, { error: 'Starting a guild needs a new-guild link from the site admin.' });
    if (!String(b.name || '').trim()) return send(res, 400, { error: 'Give your guild a name.' });
    const g = createGuild(d, b.name, ctx.username);
    delete user.canCreateGuild;
    ctx.session.guild = g.id; writeDb(d);
    return send(res, 200, { ok: true, id: g.id });
  }
  if (p === '/api/guilds/switch' && req.method === 'POST') {
    const b = await readJson(req); const g = d.guilds.find(x => x.id === b.id && personIn(x, ctx.username));
    if (!g) return send(res, 404, { error: 'You are not in that guild.' });
    ctx.session.guild = g.id; writeDb(d);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/join' && req.method === 'POST') {
    const b = await readJson(req); const g = d.guilds.find(x => x.invite && x.invite === b.code);
    if (!g) return send(res, 404, { error: 'This invite link is not valid anymore.' });
    if (!personIn(g, ctx.username)) {
      const cur = guildsOf(d, ctx.username)[0];
      if (cur) return send(res, 400, { error: `You are already in ${cur.name}. One account can only be in one guild, so leave it first (Settings → Guild members).` });
      g.people.push({ username: ctx.username, role: 'member', memberId: null });
    }
    ctx.session.guild = g.id; writeDb(d);
    return send(res, 200, { ok: true, guild: g.name });
  }

  if (p === '/api/start' && req.method === 'POST') {
    const b = await readJson(req); const start = findStart(d, b.code); const user = findUser(d, ctx.username);
    if (!start) return send(res, 404, { error: 'This new-guild link is not valid anymore.' });
    if (guildsOf(d, ctx.username).length) return send(res, 400, { error: 'You are already in a guild. One account can only be in one guild.' });
    user.canCreateGuild = true; d.starts = d.starts.filter(x => x !== start); writeDb(d);
    return send(res, 200, { ok: true });
  }
  if (p.startsWith('/api/site')) {
    if (!findUser(d, ctx.username).admin) return send(res, 403, { error: 'Only the site admin can do that.' });
    if (p === '/api/site' && req.method === 'GET') return send(res, 200, { inviteOnly: d.site.inviteOnly, starts: d.starts, guilds: d.guilds.length, users: d.users.length });
    if (p === '/api/site' && req.method === 'POST') { const b = await readJson(req); d.site.inviteOnly = !!b.inviteOnly; writeDb(d); return send(res, 200, { ok: true }); }
    if (p === '/api/site/start' && req.method === 'POST') {
      const st = { code: 's' + newInvite(), exp: Date.now() + START_DAYS * 864e5 }; d.starts.push(st); writeDb(d);
      return send(res, 200, { ok: true, ...st });
    }
    if (p === '/api/site/accounts' && req.method === 'GET') {
      return send(res, 200, { me: ctx.username, accounts: d.users.map(u => {
        const g = guildsOf(d, u.username)[0];
        return { username: u.username, admin: !!u.admin, createdAt: u.createdAt || null, guild: g ? g.name : null, role: g ? personIn(g, u.username).role : null };
      }) });
    }
    if (p === '/api/site/accounts/delete' && req.method === 'POST') {
      const b = await readJson(req);
      if (same(b.username, ctx.username)) return send(res, 400, { error: 'To delete your own account, use My account.' });
      const problem = accountDeleteProblem(d, b.username); if (problem) return send(res, 400, { error: problem });
      const r = deleteAccount(d, b.username); writeDb(d);
      return send(res, 200, { ok: true, emptied: r.emptied });
    }
    if (p === '/api/site/start/revoke' && req.method === 'POST') { const b = await readJson(req); d.starts = d.starts.filter(x => x.code !== b.code); writeDb(d); return send(res, 200, { ok: true }); }
  }

  // Everything below works on the active guild.
  if (!ctx.guild) return send(res, 403, { error: 'Create or join a guild first.', noGuild: true });
  const g = ctx.guild;

  if (p === '/api/guild' && req.method === 'GET') {
    if (!can(ctx, 'officer')) return send(res, 403, { error: 'Officers only.' });
    return send(res, 200, { id: g.id, name: g.name, me: ctx.username, role: ctx.role, invite: g.invite, people: g.people });
  }
  if (p === '/api/guild/invite' && req.method === 'POST') {
    if (!can(ctx, 'leader')) return send(res, 403, { error: 'Only a guild leader can do that.' });
    g.invite = newInvite(); writeDb(d);
    return send(res, 200, { ok: true, invite: g.invite });
  }
  if (p === '/api/guild/role' && req.method === 'POST') {
    if (!can(ctx, 'leader')) return send(res, 403, { error: 'Only a guild leader can change roles.' });
    const b = await readJson(req); const target = personIn(g, b.username);
    if (!target) return send(res, 404, { error: 'That person is not in this guild.' });
    if (!ROLES[b.role]) return send(res, 400, { error: 'Unknown role.' });
    if (target.role === 'leader' && b.role !== 'leader' && g.people.filter(x => x.role === 'leader').length === 1) return send(res, 400, { error: 'A guild needs at least one leader. Make someone else leader first.' });
    target.role = b.role; writeDb(d);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/guild/link' && req.method === 'POST') {
    if (!can(ctx, 'officer')) return send(res, 403, { error: 'Officers only.' });
    const b = await readJson(req); const target = personIn(g, b.username);
    if (!target) return send(res, 404, { error: 'That person is not in this guild.' });
    const s = readState(g.id) || {};
    if (b.memberId && !(s.members || []).some(m => m.id === b.memberId)) return send(res, 400, { error: 'No such roster member.' });
    if (b.memberId) { const taken = g.people.find(x => x !== target && x.memberId === b.memberId); if (taken) return send(res, 400, { error: `That roster member is already linked to ${taken.username}.` }); }
    target.memberId = b.memberId || null; writeDb(d);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/guild/remove' && req.method === 'POST') {
    const b = await readJson(req); const self = same(b.username, ctx.username);
    if (!self && !can(ctx, 'leader')) return send(res, 403, { error: 'Only a guild leader can remove people.' });
    const target = personIn(g, b.username);
    if (!target) return send(res, 404, { error: 'That person is not in this guild.' });
    if (g.people.length === 1) return send(res, 400, { error: "You're the only one in this guild, so it can't be left empty." });
    if (target.role === 'leader' && g.people.filter(x => x.role === 'leader').length === 1) return send(res, 400, { error: 'Make someone else leader before leaving.' });
    g.people = g.people.filter(x => x !== target);
    Object.values(d.sessions).forEach(s => { if (same(s.user, target.username) && s.guild === g.id) s.guild = null; });
    writeDb(d);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/state') {
    if (!can(ctx, 'officer')) return send(res, 403, { error: 'Officers only.', role: ctx.role });
    if (req.method === 'GET') {
      const s = readState(g.id);
      return send(res, 200, { state: s, rev: s ? s._rev || 0 : 0 });
    }
    if (req.method === 'PUT') {
      try {
        const body = JSON.parse(await readBody(req));
        const current = readState(g.id);
        const curRev = current ? current._rev || 0 : 0;
        let added = [], edited = [], gone = [];
        if (typeof body.baseRev === 'number' && body.baseRev !== curRev) {
          // If only members changed reservations since this client's copy, keep their changes and accept the save.
          if (!current || current._officerRev == null || body.baseRev < current._officerRev || body.baseRev > curRev || !body.state || !body.state.auction) {
            return send(res, 409, { error: 'conflict', rev: curRev, state: current });
          }
          const ca = current.auction || {};
          gone = (ca.gone || []).filter(x => x.rev > body.baseRev).map(x => x.id);
          const goneSet = new Set(gone);
          const incoming = (body.state.auction.entries || []).filter(e => !goneSet.has(e.id));
          const byId = new Map(incoming.map(e => [e.id, e]));
          const cats = new Set((body.state.auction.categories || []).map(c => c.id));
          body.state.auction.entries = incoming;
          (ca.entries || []).filter(e => e.selfRev > body.baseRev).forEach(e => {
            const there = byId.get(e.id);
            if (there) { if (there.status === 'waiting' && there.item !== e.item) { there.item = e.item; there.selfRev = e.selfRev; edited.push({ id: e.id, item: e.item }); } }
            else if (cats.has(e.catId)) { e.pos = nextPos(body.state.auction, e.catId); incoming.push(e); added.push(e); }
          });
        }
        // The app doesn't keep the removal log, so carry it over from the saved copy.
        if (current && current.auction && current.auction.gone && body.state && body.state.auction) body.state.auction.gone = current.auction.gone;
        const next = { ...body.state, _rev: curRev + 1, _officerRev: curRev + 1, _savedAt: new Date().toISOString() };
        backup(g.id);
        writeState(g.id, next);
        const name = next.guild && String(next.guild.name || '').trim().slice(0, 60);
        if (name && name !== g.name) { g.name = name; writeDb(d); }
        return send(res, 200, { ok: true, rev: next._rev, added, edited, gone });
      } catch (e) {
        return send(res, 400, { error: String(e.message || e) });
      }
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  // Live change signal for the active guild (any role).
  if (p === '/api/live' && req.method === 'GET') return liveSubscribe(req, res, g.id);

  // What a member sees: lineups and reservation lists, plus their own linked roster name.
  if (p === '/api/member/view' && req.method === 'GET') {
    const s = readState(g.id) || {};
    const myId = ctx.person.memberId; const ids = new Set(myId ? [myId] : []);
    const events = (s.events || []).map(ev => { ev.fields.forEach(f => f.parties.forEach(pt => pt.slots.forEach(id => id && ids.add(id)))); return { ...ev, attendance: undefined, shareToken: undefined }; });
    const members = (s.members || []).filter(m => ids.has(m.id)).map(({ id, name, job, level, gs }) => ({ id, name, job, level, gs }));
    const a = s.auction || {};
    const meRoster = (s.members || []).find(m => m.id === myId) || null;
    return send(res, 200, {
      guild: { name: g.name }, roles: s.roles || {}, events, members, me: members.find(m => m.id === myId) || null,
      auction: { categories: (a.categories || []).map(({ id, name, note }) => ({ id, name, note })), entries: publicEntries(s, meRoster), selfAdd: !!a.selfAdd },
    });
  }
  if (p === '/api/member/reserve' && req.method === 'POST') {
    const s = readState(g.id);
    if (!s || !s.auction || !s.auction.selfAdd) return send(res, 403, { error: 'Signing yourself up is turned off. Ask an officer.' });
    const m = (s.members || []).find(x => x.id === ctx.person.memberId);
    if (!m) return send(res, 400, { error: 'Your account is not linked to a roster name yet. Ask an officer.' });
    const b = await readJson(req); const r = addReservation(g.id, s, m, b.catId, b.item);
    return r.error ? send(res, r.code || 400, { error: r.error }) : send(res, 200, { ok: true, place: r.place });
  }
  // A member edits what they want, or removes their spot. Only their own spots, never anyone else's.
  if ((p === '/api/member/reserve/edit' || p === '/api/member/reserve/remove') && req.method === 'POST') {
    const s = readState(g.id);
    const m = s && (s.members || []).find(x => x.id === ctx.person.memberId);
    if (!m) return send(res, 400, { error: 'Your account is not linked to a roster name yet. Ask an officer.' });
    const b = await readJson(req);
    const r = changeOwnReservation(g.id, s, m, b.id, b.item, p.endsWith('/remove'));
    return r.error ? send(res, r.code || 400, { error: r.error }) : send(res, 200, { ok: true });
  }
  return null;
}

// The only files the server hands out; users.json and the guilds folder stay private.
const STATIC = new Set(['/index.html', '/app.js', '/styles.css', '/favicon.ico']);
function pageWith(script) {
  return fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace('<!--SHARE-->', `<script>${script}</script>`)
    .replace(/(href|src)="\.\//g, '$1="/');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Bad origin.' });

  // Public share links: /share/<token> serves the app in view mode.
  if (p.startsWith('/share/')) {
    const token = p.slice(7);
    if (!findShare(token)) return send(res, 404, 'This share link is not valid anymore.', 'text/plain; charset=utf-8');
    return send(res, 200, pageWith(`window.RONW_SHARE=${JSON.stringify(token)}`), TYPES['.html']);
  }
  // Invite links: /join/<code> shows sign-up or log-in, then joins the guild.
  // New-guild links: /start/<code> lets one person make an account and start a guild.
  if (p.startsWith('/start/')) {
    return send(res, 200, pageWith(`window.RONW_START=${JSON.stringify(p.slice(7))}`), TYPES['.html']);
  }
  if (p.startsWith('/join/')) {
    return send(res, 200, pageWith(`window.RONW_JOIN=${JSON.stringify(p.slice(6))}`), TYPES['.html']);
  }

  // Live change signal for a share link's guild.
  const shareLive = p.match(/^\/api\/share\/([^/]+)\/live$/);
  if (shareLive && req.method === 'GET') {
    const sh = findShare(shareLive[1]);
    if (!sh) return send(res, 404, { error: 'not found' });
    return liveSubscribe(req, res, sh.gid);
  }

  // Anyone with the share link adds themselves to a reservation list (only when the officer allowed it).
  const reserve = p.match(/^\/api\/share\/([^/]+)\/reserve$/);
  if (reserve) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const sh = findShare(reserve[1]);
    if (!sh || !sh.auction || !sh.s.auction.selfAdd) return send(res, 403, { error: 'Self sign-up is turned off.' });
    const body = await readJson(req);
    const m = selfAddRoster(sh.s).find(m => same(m.name, body.name));
    if (!m) return send(res, 400, { error: 'Pick your name from the roster.' });
    const r = addReservation(sh.gid, sh.s, m, body.catId, body.item);
    return r.error ? send(res, r.code || 400, { error: r.error }) : send(res, 200, { ok: true, place: r.place });
  }
  if (p.startsWith('/api/share/')) {
    const sh = findShare(p.slice(11));
    if (!sh) return send(res, 404, { error: 'not found' });
    const s = sh.s;
    if (sh.auction) {
      const a = s.auction;
      const entries = publicEntries(s);
      const roster = a.selfAdd ? selfAddRoster(s).map(m => m.name).sort((x, y) => x.localeCompare(y)) : [];
      return send(res, 200, { guild: s.guild, auction: { categories: (a.categories || []).map(({ id, name, note }) => ({ id, name, note })), entries, selfAdd: !!a.selfAdd, roster } });
    }
    const ids = new Set();
    sh.ev.fields.forEach(f => f.parties.forEach(pt => pt.slots.forEach(id => id && ids.add(id))));
    const members = (s.members || []).filter(m => ids.has(m.id)).map(({ id, name, job, level, gs }) => ({ id, name, job, level, gs }));
    return send(res, 200, { guild: s.guild, roles: s.roles, event: { ...sh.ev, attendance: undefined }, members });
  }

  if (p.startsWith('/api/')) {
    if ((await handleApi(req, res, p)) === null) send(res, 404, { error: 'not found' });
    return;
  }

  // Static files
  const file = p === '/' ? '/index.html' : p;
  if (!STATIC.has(file)) return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(path.join(ROOT, file), (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
  });
});

// Before guilds existed everything lived in ./data.json. Move it into the first guild once.
function moveOldData() {
  const old = path.join(ROOT, 'data.json');
  const d = readDb();
  // Older users.json files: whoever signed up first becomes the site admin.
  if (d.users.length && !d.users.some(u => u.admin)) { d.users[0].admin = true; writeDb(d); console.log(`  ${d.users[0].username} is the site admin.`); }
  if (!fs.existsSync(old) || d.guilds.length) return;
  let s; try { s = JSON.parse(fs.readFileSync(old, 'utf8')); } catch { return; }
  const g = createGuild(d, (s.guild && s.guild.name) || 'My Guild', null);
  writeState(g.id, { ...s, _officerRev: s._rev || 0 });
  const oldBackups = path.join(ROOT, 'backups');
  if (fs.existsSync(oldBackups)) fs.renameSync(oldBackups, path.join(GUILDS, g.id, 'backups'));
  fs.renameSync(old, path.join(ROOT, 'data.json.moved'));
  // Accounts made before guilds: the first one leads, the rest are officers.
  d.users.forEach((u, i) => g.people.push({ username: u.username, role: i === 0 ? 'leader' : 'officer', memberId: null }));
  if (!d.users.length) g.unclaimed = true;
  writeDb(d);
  console.log(`  Moved data.json into guild "${g.name}" (${path.join('guilds', g.id)}).`);
}

// Command line: add-user <name> | reset-password <name> | make-leader <name> <guild name or id> | make-admin <name> | delete-user <name>
async function cli(cmd, name, guildArg) {
  const d = readDb();
  if (!name || (cmd === 'make-leader' && !guildArg)) { console.log(`Usage: node server.js ${cmd} <username>${cmd === 'make-leader' ? ' <guild name or id>' : ''}`); process.exit(1); }
  if (cmd === 'delete-user') {
    const problem = accountDeleteProblem(d, name); if (problem) { console.log(problem); process.exit(1); }
    const shown = findUser(d, name).username; const r = deleteAccount(d, name); writeDb(d);
    console.log(`Deleted ${shown}.${r.emptied.length ? ` ${r.emptied.join(', ')} now has no one in it; its data is kept, and make-leader can give it a new leader.` : ''}`);
    return;
  }
  if (cmd === 'make-admin') {
    const user = findUser(d, name); if (!user) { console.log(`No account named "${name}".`); process.exit(1); }
    user.admin = true; writeDb(d); console.log(`${user.username} is now a site admin.`); return;
  }
  if (cmd === 'make-leader') {
    const user = findUser(d, name); if (!user) { console.log(`No account named "${name}".`); process.exit(1); }
    const g = d.guilds.find(x => x.id === guildArg || same(x.name, guildArg)); if (!g) { console.log(`No guild "${guildArg}". Guilds: ${d.guilds.map(x => `${x.name} (${x.id})`).join(', ') || 'none'}`); process.exit(1); }
    const other = guildsOf(d, user.username).find(x => x !== g); if (other) { console.log(`${user.username} is already in ${other.name}. One account can only be in one guild.`); process.exit(1); }
    const pp = personIn(g, user.username); if (pp) pp.role = 'leader'; else g.people.push({ username: user.username, role: 'leader', memberId: null });
    delete g.unclaimed; writeDb(d);
    console.log(`${user.username} now leads ${g.name}.`); return;
  }
  if (cmd === 'reset-password' && !findUser(d, name)) { console.log(`No account named "${name}".`); process.exit(1); }
  // One reader for both prompts; typed characters are hidden.
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  rl._writeToOutput = () => {};
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => { process.stdout.write(q); const { value } = await lines.next(); process.stdout.write('\n'); return value || ''; };
  const pw = await ask(`Password for ${name}: `);
  const again = await ask('Type it again: ');
  rl.close();
  if (pw !== again) { console.log('The passwords did not match.'); process.exit(1); }
  if (cmd === 'add-user') {
    const err = validNewUser(d, name, pw); if (err) { console.log(err); process.exit(1); }
    addUser(d, name, pw);
  } else {
    if (pw.length < 8) { console.log('Password must be at least 8 characters.'); process.exit(1); }
    const user = findUser(d, name); Object.assign(user, hashPassword(pw));
    Object.keys(d.sessions).forEach(k => { if (d.sessions[k].user === user.username) delete d.sessions[k]; });
  }
  writeDb(d);
  console.log(cmd === 'add-user' ? `Added ${name}. They can log in now.` : `Password changed for ${name}.`);
}

const [cmd, arg, arg2] = process.argv.slice(2);
if (['add-user', 'reset-password', 'make-leader', 'make-admin', 'delete-user'].includes(cmd)) cli(cmd, arg, arg2);
else {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  moveOldData();
  server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    const d = readDb();
    console.log(`\n  ronw-planner is running → http://localhost:${PORT}\n  Data folder: ${DATA_DIR}${TRUST_PROXY ? ' · trusting the hosting proxy' : ''}\n  ${d.users.length} account(s), ${d.guilds.length} guild(s) · sign-up is ${d.site.inviteOnly ? 'invite-only' : 'open'}\n`);
  });
}
