/* RONW Planner — guild party planner. Plain JS, no build step. */
(() => {
'use strict';

// ---------- small helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 0) => { const n = Number(String(v ?? '').replace(/[, ]/g, '')); return Number.isFinite(n) ? n : d; };
const fmtNum = (n) => (Number(n) || 0).toLocaleString();
const pretty = (job) => String(job || '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const fmtWhen = (iso) => { if (!iso) return 'No date'; const d = new Date(iso); return isNaN(d) ? 'No date' : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const toLocalInput = (iso) => { const d = iso ? new Date(iso) : new Date(); if (isNaN(d)) return ''; const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

function openModal(html, { wide = false, onMount } = {}) {
  const m = $('#modal');
  m.innerHTML = `<div class="dialog ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  const close = () => { m.hidden = true; m.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  m.onclick = (e) => { if (e.target === m) close(); };
  $$('[data-close]', m).forEach(b => (b.onclick = close));
  const first = $('input, select, textarea', m); if (first) setTimeout(() => first.focus(), 0);
  if (onMount) onMount(m.firstElementChild, close);
  return close;
}

function confirmBox(text, okLabel = 'Delete') {
  return new Promise(res => {
    openModal(`<h2>Are you sure?</h2><p class="muted" style="margin:0">${esc(text)}</p>
      <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ok">${esc(okLabel)}</button></div>`,
      { onMount: (el, close) => { $('#ok', el).onclick = () => { close(); res(true); }; $$('[data-close]', el).forEach(b => b.addEventListener('click', () => res(false))); } });
  });
}

function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ---------- defaults ----------
const JOBS = ['SWORDSMAN','KNIGHT','LORD_KNIGHT','CRUSADER','PALADIN','MAGE','WIZARD','HIGH_WIZARD','ARCHER','HUNTER','SNIPER','BARD','MINSTREL','DANCER','GYPSY','ACOLYTE','PRIEST','HIGH_PRIEST','MONK','CHAMPION','THIEF','ASSASSIN','ASSASSIN_CROSS','ROGUE','STALKER','MERCHANT','BLACKSMITH','WHITESMITH','ALCHEMIST','CREATOR','GUNSLINGER','REBELLION','NIGHT_WATCH','DRUID','KARNOS','ALITHEA'];
const DEFAULT_ROLES = (() => {
  const r = Object.fromEntries(JOBS.map(j => [j, 'dps']));
  ['SWORDSMAN','KNIGHT','LORD_KNIGHT','CRUSADER','PALADIN'].forEach(j => (r[j] = 'tank'));
  ['ACOLYTE','PRIEST','HIGH_PRIEST','BARD','MINSTREL','DANCER','GYPSY'].forEach(j => (r[j] = 'support'));
  return r;
})();
const DEFAULT_MODES = [
  { key: 'league', label: 'Guild League', fields: [{ name: 'Main Field', cap: 60 }, { name: 'Sub Field', cap: 90 }], needTank: false, needSupport: false },
  { key: 'polarity', label: 'Polarity', fields: [{ name: 'Elite', cap: 50 }], needTank: false, needSupport: true },
  { key: 'siege', label: 'Siege War', fields: [{ name: 'Siege', cap: 0, rosterSized: true }], needTank: true, needSupport: true },
];
const blankState = () => ({
  schema: 1,
  guild: { name: 'My Guild' },
  partySize: 5,
  roles: { ...DEFAULT_ROLES },
  modes: JSON.parse(JSON.stringify(DEFAULT_MODES)),
  members: [], groups: [], events: [], strikes: [],
  auction: { categories: [], entries: [], shareToken: null },
});

// ---------- storage (server if available, else this browser) ----------
let S = blankState();
let mode = 'local';      // 'server' | 'local'
let rev = 0;
const LS_KEY = 'ronw.state.v1';
const OLD_LS_KEY = 'muster.state.v1'; // before the rename; read once, then saved under LS_KEY

function setSaveState(text, err = false) { const el = $('#saveState'); if (el) { el.textContent = text; el.classList.toggle('err', err); } }

// Returns false when something other than the officer app is showing (login, guild picker, member view).
async function load() {
  if (location.protocol.startsWith('http')) {
    let r = null;
    try { r = await fetch('/api/me', { cache: 'no-store' }); } catch { /* no server: browser-only mode */ }
    if (r && (r.ok || r.status === 401)) {
      mode = 'server';
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { await showLogin(j); return false; }
      me = j;
      if (window.RONW_JOIN) { await joinGuild(window.RONW_JOIN); return false; }
      if (window.RONW_START) { await claimStart(window.RONW_START); return false; }
      if (!me.active) { showNoGuild(); return false; }
      if (me.active.role === 'member') { await bootMember(); return false; }
      const st = await api('/api/state');
      if (!st.ok) { toast(st.error || 'Could not load guild data'); return false; }
      rev = st.rev || 0;
      S = st.state ? migrate(st.state) : blankState();
      if (!st.state) S.guild.name = me.active.name;
      setSaveState('Saved to the server');
      showUser();
      return true;
    }
  }
  const local = readLocal(); if (local) S = local;
  setSaveState('Saved in this browser');
  return true;
}

// ---------- accounts and guilds ----------
let appReady = false; // true once the officer app is showing
let me = null; // { user, guilds: [{id, name, role}], active: {id, name, role, memberId} }
const ROLE_LABEL = { leader: 'Guild Leader', officer: 'Officer', member: 'Member' };
const api = async (url, method = 'GET', body) => {
  try {
    const r = await fetch(url, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { ...j, ok: r.ok, status: r.status };
  } catch { return { ok: false, status: 0, error: 'Could not reach the server.' }; }
};
const goHome = () => { location.href = '/'; };

function loginForm(signup) {
  return `<label class="field">Username<input type="text" id="lu" autocomplete="username" maxlength="32"></label>
    <label class="field">Password${signup ? ' (at least 8 characters)' : ''}<input type="password" id="lp" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
    ${signup ? '<label class="field">Password again<input type="password" id="lp2" autocomplete="new-password"></label>' : ''}
    <div class="muted" id="lmsg" style="font-size:13px;min-height:1em"></div>
    <button class="btn primary" id="lgo">${signup ? 'Create account' : 'Log in'}</button>`;
}
function wireLogin(root, signup, onDone, code = null) {
  const go = async () => {
    const username = $('#lu', root).value.trim(), password = $('#lp', root).value, msg = $('#lmsg', root);
    msg.style.color = '';
    if (!username || !password) { msg.textContent = 'Enter a username and password.'; return; }
    if (signup && password !== $('#lp2', root).value) { msg.textContent = 'The passwords don’t match.'; return; }
    $('#lgo', root).disabled = true; msg.textContent = '';
    const r = await api(signup ? '/api/signup' : '/api/login', 'POST', signup ? { username, password, code } : { username, password });
    if (r.ok) return onDone(r);
    msg.textContent = r.error || 'Something went wrong.'; msg.style.color = 'var(--danger)'; $('#lgo', root).disabled = false;
  };
  $('#lgo', root).onclick = go;
  $$('input', root).forEach(i => (i.onkeydown = (e) => { if (e.key === 'Enter') go(); }));
  setTimeout(() => $('#lu', root).focus(), 0);
}
async function showLogin(info, tab) {
  document.body.classList.add('share');
  const code = window.RONW_JOIN || window.RONW_START || null;
  const link = code ? (showLogin.link = showLogin.link || await api(`/api/invite/${encodeURIComponent(code)}`)) : null;
  // Invite-only sites only offer sign-up through a valid invite or new-guild link.
  const canSignup = info.signup === 'open' || (link && link.ok);
  tab = tab || (link && link.ok ? 'signup' : 'login');
  if (!canSignup) tab = 'login';
  const v = $('#view');
  v.innerHTML = `<div class="login card"><h1>RONW Planner</h1>
    ${link ? (link.ok ? `<div class="share-banner" style="margin:0">${link.kind === 'start' ? 'You’re invited to <b>start a new guild</b>.' : `You're invited to join <b>${esc(link.guild)}</b>.`} ${tab === 'signup' ? 'Make an account' : 'Log in or make an account'} to accept.</div>` : `<div class="share-banner" style="margin:0;color:var(--danger)">${esc(link.error)}</div>`) : ''}
    ${canSignup ? `<div class="seg"><button class="${tab === 'login' ? 'on' : ''}" data-tab="login">Log in</button><button class="${tab === 'signup' ? 'on' : ''}" data-tab="signup">Sign up</button></div>` : ''}
    ${loginForm(tab === 'signup')}
    ${!canSignup ? '<div class="muted" style="font-size:12px">New here? Sign-up is by invite only. Ask your guild leader for an invite link.</div>' : ''}</div>`;
  $$('[data-tab]', v).forEach(b => (b.onclick = () => showLogin(info, b.dataset.tab)));
  wireLogin(v, tab === 'signup', (r) => {
    if (r.claimed) toast(`You're the leader of ${r.claimed}`);
    // Sign-up already used the code; logging in still needs to use it.
    if (tab === 'signup') goHome(); else location.reload();
  }, link && link.ok ? code : null);
}
async function claimStart(code) {
  const r = await api('/api/start', 'POST', { code });
  if (!r.ok) { document.body.classList.add('share'); $('#view').innerHTML = `<div class="login card"><h1>New-guild link</h1><p class="muted">${esc(r.error || 'Could not use this link.')}</p><button class="btn" onclick="location.href='/'">Go to RONW Planner</button></div>`; return; }
  goHome();
}
async function joinGuild(code) {
  const r = await api('/api/join', 'POST', { code });
  if (!r.ok) { document.body.classList.add('share'); $('#view').innerHTML = `<div class="login card"><h1>Invite link</h1><p class="muted">${esc(r.error || 'Could not join.')}</p><button class="btn" onclick="location.href='/'">Go to RONW Planner</button></div>`; return; }
  goHome();
}
function guildForms() {
  return `${me.canCreate ? `<label class="field">New guild name<input type="text" id="gn" maxlength="60" placeholder="e.g. Valhalla"></label>
    <button class="btn primary" id="gcreate">Create guild (you'll be its leader)</button>
    <div class="muted" style="text-align:center;font-size:12px">or</div>` : ''}
    <label class="field">Invite link or code from your guild leader<input type="text" id="gj" placeholder="https://…/join/…"></label>
    <button class="btn" id="gjoin">Join guild</button>
    <div class="muted" id="gmsg" style="font-size:13px;color:var(--danger)"></div>`;
}
function wireGuildForms(root) {
  if ($('#gcreate', root)) $('#gcreate', root).onclick = async () => {
    const r = await api('/api/guilds', 'POST', { name: $('#gn', root).value.trim() });
    if (r.ok) goHome(); else $('#gmsg', root).textContent = r.error;
  };
  $('#gjoin', root).onclick = async () => {
    const code = $('#gj', root).value.trim().replace(/^.*\/join\//, '').replace(/[/?#].*$/, '');
    if (!code) { $('#gmsg', root).textContent = 'Paste the invite link first.'; return; }
    const r = await api('/api/join', 'POST', { code });
    if (r.ok) goHome(); else $('#gmsg', root).textContent = r.error;
  };
}
function showNoGuild() {
  document.body.classList.add('share');
  const v = $('#view');
  v.innerHTML = `<div class="login card"><h1>Welcome, ${esc(me.user)}</h1>
    <p class="muted" style="margin:0">You're not in a guild yet. ${me.canCreate ? 'Start your own, or join one with the invite link your guild leader sent you.' : 'Join one with the invite link your guild leader sent you. To start your own guild, ask the site admin for a new-guild link.'}</p>
    ${guildForms()}
    <button class="btn ghost sm" id="logout">Log out</button></div>`;
  wireGuildForms(v);
  $('#logout', v).onclick = logout;
}
async function logout() { await api('/api/logout', 'POST'); goHome(); }
async function switchGuild(id) { const r = await api('/api/guilds/switch', 'POST', { id }); if (r.ok) goHome(); else toast(r.error); }
function guildMenuDialog() {
  openModal(`<h2>Your guild</h2>
    <div style="display:grid;gap:6px">${me.guilds.map(g => `<button class="btn" data-g="${g.id}" style="display:flex;justify-content:space-between;gap:10px" ${g.id === me.active?.id ? 'disabled' : ''}><b>${esc(g.name)}</b><span class="muted">${ROLE_LABEL[g.role]}${g.id === me.active?.id ? ' · current' : ''}</span></button>`).join('')}</div>
    <p class="muted" style="margin:0;font-size:12px">One account belongs to one guild. To move to another guild, leave this one in Settings → Guild members, then open the new guild's invite link.</p>
    <div class="actions"><button class="btn" data-close>Close</button></div>`,
  { onMount: (el) => { $$('[data-g]', el).forEach(b => (b.onclick = () => switchGuild(b.dataset.g))); } });
}
// Session ran out mid-use: log in again in a dialog and keep the unsaved changes.
function reauth() {
  if (reauth.open) return; reauth.open = true;
  openModal(`<h2>Log in again</h2><p class="muted" style="margin:0">You were logged out. Your changes are kept and will save once you log in.</p>${loginForm(false)}`, {
    onMount: (el, close) => wireLogin(el, false, () => { reauth.open = false; close(); persist(); }),
  });
  const m = $('#modal'); const obs = new MutationObserver(() => { if (m.hidden) { reauth.open = false; obs.disconnect(); } }); obs.observe(m, { attributes: true });
}
function userBox() {
  return `<div class="ub-guild"><button class="btn sm ghost" id="guildMenu" title="Switch or add a guild">${esc(me.active.name)} ▾</button></div>
    <div class="ub-me"><span>${esc(me.user)}</span><span class="pill">${ROLE_LABEL[me.active.role]}</span><button class="btn sm ghost" id="logout">Log out</button></div>`;
}
function showUser() {
  const el = $('#navUser'); if (!el || !me) return;
  el.hidden = false; el.innerHTML = userBox();
  $('#logout', el).onclick = logout; $('#guildMenu', el).onclick = guildMenuDialog;
}
function readLocal() { try { const raw = localStorage.getItem(LS_KEY) ?? localStorage.getItem(OLD_LS_KEY); return raw ? migrate(JSON.parse(raw)) : null; } catch { return null; } }
function migrate(s) {
  const b = blankState();
  const out = { ...b, ...s };
  out.roles = { ...b.roles, ...(s.roles || {}) };
  out.modes = Array.isArray(s.modes) && s.modes.length ? s.modes : b.modes;
  ['members', 'groups', 'events', 'strikes'].forEach(k => (out[k] = Array.isArray(s[k]) ? s[k] : []));
  const a = s.auction || {};
  out.auction = { categories: Array.isArray(a.categories) ? a.categories : [], entries: Array.isArray(a.entries) ? a.entries : [], shareToken: a.shareToken || null, selfAdd: !!a.selfAdd };
  delete out._rev; delete out._savedAt; delete out._officerRev;
  return out;
}

// dirty = edits not saved yet. A live update from someone else never replaces those.
let dirty = false, editSeq = 0;
function persist() { dirty = true; editSeq++; persistNow(); }
const persistNow = debounce(async () => {
  if (mode === 'server') {
    const seq = editSeq;
    try {
      setSaveState('Saving…');
      const r = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: S, baseRev: rev }) });
      if (r.status === 409) { setSaveState('Changed elsewhere — reload', true); toast('Data changed in another tab. Reload to see it.', 4000); return; }
      if (r.status === 401) { setSaveState('Logged out — not saved', true); reauth(); return; }
      if (!r.ok) throw new Error(r.status);
      const j = await r.json(); rev = j.rev; setSaveState('Saved to the server');
      if (seq === editSeq) dirty = false;
      if (j.added?.length || j.edited?.length || j.gone?.length) adoptMemberChanges(j);
    } catch { setSaveState('Save failed — is the server running?', true); try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch {} }
  } else {
    try { localStorage.setItem(LS_KEY, JSON.stringify(S)); setSaveState('Saved in this browser'); dirty = false; }
    catch { setSaveState('Could not save', true); }
  }
}, 350);
function commit(rerender = true) { persist(); if (rerender) render(); }

// Members' own changes to reservations (sign-ups, edits, removals) arrive here, either merged into a save or picked up by the poll.
function adoptMemberChanges({ added = [], edited = [], gone = [] }) {
  const A = S.auction; const notes = [];
  const goneSet = new Set(gone);
  const before = A.entries.length; A.entries = A.entries.filter(e => !goneSet.has(e.id));
  if (A.entries.length < before) notes.push(`${before - A.entries.length} removed by members`);
  let changed = 0;
  edited.forEach(x => { const e = A.entries.find(y => y.id === x.id); if (e && e.item !== x.item) { e.item = x.item; changed++; } });
  if (changed) notes.push(`${changed} edited by members`);
  const have = new Set(A.entries.map(e => e.id));
  const fresh = added.filter(e => !have.has(e.id) && !goneSet.has(e.id) && A.categories.some(c => c.id === e.catId));
  A.entries.push(...fresh);
  if (fresh.length === 1) notes.unshift(`${atName(fresh[0])} joined ${A.categories.find(c => c.id === fresh[0].catId).name}`);
  else if (fresh.length) notes.unshift(`${fresh.length} new reservations from members`);
  if (!notes.length) return;
  toast(notes.join(' · '), 3500);
  if (route().name === 'auction') render();
}
// ---------- live updates ----------
// The server sends a tiny "changed" signal when this guild's data is saved; the page then fetches what changed.
function startLive(url, onChange) {
  if (!window.EventSource) return null;
  const es = new EventSource(url); // reconnects by itself if the connection drops
  es.onmessage = (e) => { let d; try { d = JSON.parse(e.data); } catch { return; } onChange(d); };
  return es;
}
// Waits until the person isn't typing, in a dialog or dragging, so an update never eats their input.
// The focused box (if any) gets its focus back after the page redraws.
function busyNow() {
  const a = document.activeElement;
  return !$('#modal').hidden || !!document.querySelector('.dragging')
    || (!!a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && !['checkbox', 'radio'].includes(a.type) && String(a.value || '').length > 0);
}
function whenIdle(fn) {
  clearTimeout(whenIdle.t);
  if (busyNow()) { whenIdle.t = setTimeout(() => whenIdle(fn), 1200); return; }
  const focusId = document.activeElement && document.activeElement.id;
  Promise.resolve(fn()).then(() => { const el = focusId && document.getElementById(focusId); if (el && document.activeElement !== el) el.focus(); });
}
// Officer pages: take members' own reservation changes, or another officer's saved changes when we have none of our own.
async function refreshFromServer() {
  if (mode !== 'server' || !appReady) return;
  try {
    const j = await (await fetch('/api/state', { cache: 'no-store' })).json();
    if (!j.state || j.rev <= rev) return;
    if ((j.state._officerRev ?? Infinity) > rev) {
      // Another officer saved. Keep our unsaved edits; the next save reports the conflict as before.
      if (dirty) return;
      S = migrate(j.state); rev = j.rev;
      render();
      return;
    }
    const base = rev; rev = j.rev;
    const ca = j.state.auction || {};
    const mine = new Map(S.auction.entries.map(e => [e.id, e]));
    const changed = (ca.entries || []).filter(e => e.selfRev > base);
    adoptMemberChanges({
      added: changed.filter(e => !mine.has(e.id)),
      edited: changed.filter(e => mine.has(e.id)).map(e => ({ id: e.id, item: e.item })),
      gone: (ca.gone || []).filter(x => x.rev > base).map(x => x.id),
    });
  } catch { /* server offline */ }
}

// ---------- domain helpers ----------
const roleOf = (m) => (m && S.roles[m.job]) || 'dps';
const memberById = () => Object.fromEntries(S.members.map(m => [m.id, m]));
const activeMembers = () => S.members.filter(m => m.active !== false);
const strikeCount = (id) => S.strikes.filter(s => s.memberId === id).length;
const eventById = (id) => S.events.find(e => e.id === id);
const modeByKey = (k) => S.modes.find(m => m.key === k);

function newParty(i) { return { id: uid('pt'), label: `P${i + 1}`, leader: null, locked: false, note: '', slots: Array(S.partySize).fill(null), pins: Array(S.partySize).fill(false) }; }

function buildFields(md) {
  return md.fields.map(f => {
    const cap = f.rosterSized ? activeMembers().length : num(f.cap);
    const n = Math.max(1, Math.ceil(cap / S.partySize));
    return { id: uid('fd'), name: f.name, parties: Array.from({ length: n }, (_, i) => newParty(i)) };
  });
}

function placedIds(ev) { const s = new Set(); ev.fields.forEach(f => f.parties.forEach(p => p.slots.forEach(id => id && s.add(id)))); return s; }
function eventStats(ev) {
  let filled = 0, total = 0;
  ev.fields.forEach(f => f.parties.forEach(p => { total += p.slots.length; filled += p.slots.filter(Boolean).length; }));
  return { filled, total };
}
function removeFromEvent(ev, id) {
  ev.fields.forEach(f => f.parties.forEach(p => p.slots.forEach((s, i) => { if (s === id) { p.slots[i] = null; p.pins[i] = false; if (p.leader === id) p.leader = null; } })));
}
function partyGs(p, mm) { return p.slots.reduce((a, id) => a + (id && mm[id] ? num(mm[id].gs) : 0), 0); }

// Auto-fill: keeps locked parties and pinned slots, puts tanks/supports first if the mode
// asks for them, then spreads everyone else so each party's total gear score stays close.
function autofill(ev) {
  const mm = memberById();
  const md = modeByKey(ev.mode) || {};
  const absent = new Set(ev.absent || []);
  const groupIds = ev.groupId ? new Set((S.groups.find(g => g.id === ev.groupId) || { memberIds: [] }).memberIds) : null;

  const keep = new Set();
  ev.fields.forEach(f => f.parties.forEach(p => p.slots.forEach((id, i) => {
    if (!id) return;
    if (p.locked || p.pins[i]) keep.add(id);
    else { p.slots[i] = null; if (p.leader === id) p.leader = null; }
  })));

  let pool = activeMembers()
    .filter(m => !keep.has(m.id) && !absent.has(m.id) && (!groupIds || groupIds.has(m.id)))
    .sort((a, b) => num(b.gs) - num(a.gs) || num(b.level) - num(a.level));
  const take = (pred) => { const i = pool.findIndex(pred); return i < 0 ? null : pool.splice(i, 1)[0]; };

  for (const f of ev.fields) {
    const open = f.parties.filter(p => !p.locked);
    const has = (p, role) => p.slots.some(id => id && roleOf(mm[id]) === role);
    const put = (p, m) => { const i = p.slots.indexOf(null); if (i >= 0) p.slots[i] = m.id; return i >= 0; };

    for (const role of ['tank', 'support']) {
      const need = role === 'tank' ? (ev.needTank ?? md.needTank) : (ev.needSupport ?? md.needSupport);
      if (!need) continue;
      for (const p of open) if (!has(p, role) && p.slots.includes(null)) { const m = take(x => roleOf(x) === role); if (m) put(p, m); }
    }
    let free = open.reduce((a, p) => a + p.slots.filter(s => s === null).length, 0);
    const chosen = pool.splice(0, free);
    for (const m of chosen) {
      let best = null, bestGs = Infinity;
      for (const p of open) { if (!p.slots.includes(null)) continue; const g = partyGs(p, mm); if (g < bestGs) { bestGs = g; best = p; } }
      if (!best) break;
      put(best, m);
    }
    for (const p of open) if (!p.leader) {
      const top = p.slots.filter(Boolean).sort((a, b) => num(mm[b].gs) - num(mm[a].gs))[0];
      if (top) p.leader = top;
    }
  }
  ev.updatedAt = new Date().toISOString();
}

// ---------- CSV ----------
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
const HEADER_ALIASES = {
  name: ['name', 'ign', 'ingame name', 'in-game name', 'character', 'player', 'nickname'],
  job: ['job', 'class', 'jobclass', 'job class', 'profession'],
  level: ['level', 'lvl', 'base level'],
  gs: ['gs', 'gear score', 'gearscore', 'power', 'cp', 'combat power', 'bp'],
  position: ['position', 'rank', 'guild rank', 'role in guild'],
  title: ['title'],
  contribution: ['contribution', 'total contribution', 'contrib'],
  weekly: ['weekly', 'weekly contribution', 'week'],
  discord: ['discord', 'discord name', 'discord id', 'discord user'],
  notes: ['notes', 'note', 'remarks'],
};
function mapHeaders(header) {
  const norm = header.map(h => h.trim().toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' '));
  const map = {};
  for (const [key, al] of Object.entries(HEADER_ALIASES)) { const i = norm.findIndex(h => al.includes(h)); if (i >= 0) map[key] = i; }
  return map;
}
function normalizeJob(v) {
  const k = String(v || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!k) return 'NOVICE';
  if (S.roles[k]) return k;
  const hit = Object.keys(S.roles).find(j => j.replace(/_/g, '') === k.replace(/_/g, ''));
  return hit || k;
}

// ---------- router ----------
const routes = {};
function route() { const h = location.hash.replace(/^#\/?/, '') || 'events'; const [name, ...rest] = h.split('/'); return { name, args: rest.map(decodeURIComponent) }; }
function render() {
  const { name, args } = route();
  $('#guildName').textContent = S.guild.name || 'Guild';
  document.title = `RONW Planner · ${S.guild.name || 'Guild'}`;
  $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === name || (name === 'board' && a.dataset.nav === 'events')));
  const fn = routes[name] || routes.events;
  const scroll = window.scrollY;
  fn($('#view'), ...args);
  if (route().name === name) window.scrollTo(0, scroll);
}
window.addEventListener('hashchange', () => { if (!appReady) return; window.scrollTo(0, 0); render(); });

// ---------- views: events ----------
routes.events = (v) => {
  const evs = [...S.events].sort((a, b) => String(b.when).localeCompare(String(a.when)));
  v.innerHTML = `
    <div class="head"><div><h1>Events</h1><div class="sub">${S.events.length} events · ${activeMembers().length} active members</div></div>
      <div class="row"><button class="btn" id="impEvCsv">Import CSV</button><button class="btn primary" id="newEv">New event</button></div></div>
    ${evs.length ? `<div class="grid-cards">${evs.map(e => {
      const st = eventStats(e); const md = modeByKey(e.mode);
      return `<a class="card ev" href="#/board/${e.id}">
        <div class="row"><span class="pill ${e.status === 'done' ? 'done' : 'draft'}">${e.status === 'done' ? 'Done' : 'Draft'}</span><span class="muted" style="font-size:12px">${esc(md ? md.label : e.mode)}</span></div>
        <h3>${esc(e.title)}</h3>
        <div class="muted" style="font-size:12px">${esc(fmtWhen(e.when))}</div>
        <div class="meter"><i style="width:${st.total ? Math.round(st.filled / st.total * 100) : 0}%"></i></div>
        <div class="row muted" style="font-size:12px"><span class="mono">${st.filled}/${st.total}</span> filled<span class="grow"></span>${e.attendance && Object.keys(e.attendance).length ? 'Attendance taken' : ''}</div>
      </a>`; }).join('')}</div>`
    : `<div class="empty-state"><h3>No events yet</h3>${S.members.length ? 'Create one and hit Auto-fill.' : 'Start by importing your roster, then create an event.'}<div class="row" style="justify-content:center;margin-top:14px">${S.members.length ? '' : '<a class="btn" href="#/roster">Go to roster</a>'}</div></div>`}`;
  $('#newEv').onclick = () => eventDialog();
  $('#impEvCsv').onclick = () => lineupCsvDialog();
};

function eventDialog(existing) {
  const ev = existing || null;
  const md0 = ev ? ev.mode : S.modes[0]?.key;
  openModal(`<h2>${ev ? 'Edit event' : 'New event'}</h2>
    <div class="form-grid">
      <label class="field">Mode<select id="f-mode" ${ev ? 'disabled' : ''}>${S.modes.map(m => `<option value="${esc(m.key)}" ${m.key === md0 ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
      <label class="field">Starts<input type="datetime-local" id="f-when" value="${esc(toLocalInput(ev?.when || nextHour()))}"></label>
      <label class="field" style="grid-column:1/-1">Title<input type="text" id="f-title" value="${esc(ev?.title || '')}" placeholder="Leave blank for “Mode — date”"></label>
      <label class="field">Only use group<select id="f-group"><option value="">Whole roster</option>${S.groups.map(g => `<option value="${g.id}" ${ev?.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
    </div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="save">${ev ? 'Save' : 'Create'}</button></div>`,
  { onMount: (el, close) => {
    $('#save', el).onclick = () => {
      const key = $('#f-mode', el).value; const md = modeByKey(key);
      const whenRaw = $('#f-when', el).value; const when = whenRaw ? new Date(whenRaw).toISOString() : null;
      const title = $('#f-title', el).value.trim() || `${md.label} — ${when ? new Date(when).toLocaleDateString() : 'TBD'}`;
      const groupId = $('#f-group', el).value || null;
      if (ev) { Object.assign(ev, { when, title, groupId, updatedAt: new Date().toISOString() }); close(); commit(); return; }
      const e = { id: uid('ev'), mode: key, title, when, groupId, status: 'draft', fields: buildFields(md), absent: [], attendance: {}, needTank: md.needTank, needSupport: md.needSupport, shareToken: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      S.events.push(e); close(); persist(); location.hash = `#/board/${e.id}`;
    };
  } });
}
function nextHour() { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d.toISOString(); }

// ---------- views: board ----------
let benchFilter = { q: '', role: 'all', group: '' };
routes.board = (v, id) => {
  const ev = eventById(id);
  if (!ev) { v.innerHTML = `<div class="empty-state"><h3>Event not found</h3><a class="btn" href="#/events">Back to events</a></div>`; return; }
  renderBoard(v, ev, false);
};

function renderBoard(v, ev, readOnly, ctx = {}) {
  const mm = ctx.mm || memberById();
  const md = ctx.mode || modeByKey(ev.mode);
  const roleFn = ctx.roleOf || roleOf;
  const placed = placedIds(ev);
  const absent = new Set(ev.absent || []);
  const st = eventStats(ev);
  const shareUrl = ev.shareToken && mode === 'server' ? `${location.origin}/share/${ev.shareToken}` : '';

  const slotHtml = (f, p, i) => {
    const id = p.slots[i]; const m = id && mm[id];
    if (!id) return `<div class="slot empty" data-slot="${f.id}|${p.id}|${i}">${readOnly ? '—' : '+ add'}</div>`;
    if (!m) return `<div class="slot" data-slot="${f.id}|${p.id}|${i}"><span class="muted">Removed member</span></div>`;
    const r = roleFn(m);
    return `<div class="slot" ${readOnly ? '' : 'draggable="true"'} data-slot="${f.id}|${p.id}|${i}" data-mid="${m.id}" title="${esc(pretty(m.job))} · ${r}">
      <span class="dot ${r}"></span>${p.leader === id ? '<span class="crown" title="Leader">★</span>' : ''}
      <span class="nm">${esc(m.name)}</span><span class="jb">${esc(pretty(m.job))}</span>
      ${p.pins[i] ? '<span class="pin" title="Pinned">●</span>' : ''}<span class="gs">${fmtNum(m.gs)}</span></div>`;
  };
  const partyHtml = (f, p) => `
    <div class="party ${p.locked ? 'locked' : ''}" data-party="${f.id}|${p.id}">
      <div class="party-top" ${readOnly ? '' : 'draggable="true" title="Drag to move this whole party"'}>${readOnly ? '' : '<span class="grip" aria-hidden="true">⠿</span>'}<b>${esc(p.label)}</b>${p.note ? `<span class="muted" title="${esc(p.note)}">· ${esc(p.note.slice(0, 18))}</span>` : ''}
        <span class="gs" title="Total gear score">${fmtNum(partyGs(p, mm))}</span>
        ${readOnly ? '' : `<button class="icon-btn ${p.locked ? 'on' : ''}" data-act="lock" title="${p.locked ? 'Unlock' : 'Lock'} party">${p.locked ? '🔒' : '🔓'}</button><button class="icon-btn" data-act="party" title="Party options">⋯</button>`}
      </div>
      ${p.slots.map((_, i) => slotHtml(f, p, i)).join('')}
    </div>`;

  // A bench group filter pointing at a group that was deleted just shows everyone.
  const benchGroup = benchFilter.group && S.groups.find(g => g.id === benchFilter.group);
  const benchMembers = readOnly ? [] : activeMembers().filter(m => !placed.has(m.id))
    .filter(m => !ev.groupId || (S.groups.find(g => g.id === ev.groupId)?.memberIds || []).includes(m.id))
    .filter(m => benchFilter.role === 'all' || roleOf(m) === benchFilter.role)
    .filter(m => !benchGroup || benchGroup.memberIds.includes(m.id))
    .filter(m => !benchFilter.q || (m.name + ' ' + m.job).toLowerCase().includes(benchFilter.q.toLowerCase()))
    .sort((a, b) => (absent.has(a.id) - absent.has(b.id)) || num(b.gs) - num(a.gs));

  const roleCount = (role) => [...placed].filter(id => mm[id] && roleFn(mm[id]) === role).length;

  v.innerHTML = `
    ${readOnly ? `<div class="share-banner">${ctx.banner || `Read-only lineup shared from <b>${esc(ctx.guild || S.guild.name)}</b>.`} Ask an officer for changes.</div>` : ''}
    <div class="head">
      <div><h1>${esc(ev.title)}</h1>
        <div class="sub">${esc(md ? md.label : ev.mode)} · ${esc(fmtWhen(ev.when))} · <span class="mono">${st.filled}/${st.total}</span> filled ·
          <span class="dot tank"></span> ${roleCount('tank')} <span class="dot support"></span> ${roleCount('support')} <span class="dot dps"></span> ${roleCount('dps')}</div></div>
      ${readOnly ? '<div class="row no-print"><button class="btn" onclick="print()">Print</button></div>' : `
      <div class="row no-print">
        <a class="btn ghost" href="#/events">← Events</a>
        <button class="btn" id="statusBtn">${ev.status === 'done' ? 'Reopen' : 'Mark done'}</button>
        <button class="btn" id="attBtn">Attendance</button>
        <button class="btn" id="moreBtn">More</button>
        ${S.groups.length ? '<button class="btn" id="addGroupBtn" title="Put a whole group into empty slots">Add group</button>' : ''}
        <button class="btn primary" id="fillBtn">Auto-fill</button>
      </div>`}
    </div>
    ${!readOnly ? `<div class="row no-print" style="margin:-6px 0 16px;font-size:13px">
      <label class="check"><input type="checkbox" id="needTank" ${ev.needTank ? 'checked' : ''}> One tank per party</label>
      <label class="check"><input type="checkbox" id="needSupport" ${ev.needSupport ? 'checked' : ''}> One support per party</label>
      ${shareUrl ? `<span class="grow"></span><span class="muted">Share link:</span> <input type="text" readonly value="${esc(shareUrl)}" style="width:280px" onclick="this.select()">` : ''}
    </div>` : ''}
    <div class="board">
      <div class="fields">
        ${ev.fields.map(f => `<section><div class="field-head"><h2>${esc(f.name)}</h2><span class="muted mono" style="font-size:12px">${f.parties.reduce((a, p) => a + p.slots.filter(Boolean).length, 0)}/${f.parties.length * S.partySize}</span>
          ${readOnly ? '' : `<span class="grow"></span><button class="btn sm ghost no-print" data-addparty="${f.id}">+ party</button>`}</div>
          <div class="parties" data-field="${f.id}">${f.parties.map(p => partyHtml(f, p)).join('')}</div></section>`).join('')}
      </div>
      ${readOnly ? '' : `<aside class="card bench no-print">
        <div class="bench-head">
          <div class="row"><b>Bench</b><span class="muted mono">${benchMembers.length}</span><span class="grow"></span>
            <div class="tabs" id="roleTabs">${['all', 'tank', 'support', 'dps'].map(r => `<button data-r="${r}" class="${benchFilter.role === r ? 'on' : ''}">${r === 'all' ? 'All' : r[0].toUpperCase() + r.slice(1)}</button>`).join('')}</div></div>
          <input type="search" id="benchQ" placeholder="Search name or job" value="${esc(benchFilter.q)}">
          ${S.groups.length ? `<select id="benchGroup" title="Show only one group on the bench"><option value="">All groups</option>${S.groups.map(g => `<option value="${g.id}" ${benchGroup && benchGroup.id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>` : ''}
          <div class="muted" style="font-size:12px">Drag onto a slot. Click a name to mark absent.</div>
        </div>
        <div class="bench-list" id="bench" data-bench="1">
          ${benchMembers.map(m => `<div class="chip ${absent.has(m.id) ? 'absent' : ''}" draggable="true" data-mid="${m.id}" title="${absent.has(m.id) ? 'Marked absent — click to undo' : 'Click to mark absent'}"><span class="dot ${roleOf(m)}"></span><span>${esc(m.name)}</span><span class="muted" style="font-size:11px">${esc(pretty(m.job))}</span><span class="gs">${fmtNum(m.gs)}</span></div>`).join('') || '<div class="muted" style="padding:10px">Everyone is placed.</div>'}
        </div>
      </aside>`}
    </div>`;
  if (readOnly) return;
  wireBoard(v, ev);
}

function findParty(ev, fid, pid) { const f = ev.fields.find(x => x.id === fid); return { f, p: f && f.parties.find(x => x.id === pid) }; }

function wireBoard(v, ev) {
  const touch = () => { ev.updatedAt = new Date().toISOString(); commit(); };
  $('#fillBtn').onclick = () => { autofill(ev); touch(); toast('Parties filled'); };
  $('#statusBtn').onclick = () => { ev.status = ev.status === 'done' ? 'draft' : 'done'; touch(); };
  $('#attBtn').onclick = () => (location.hash = `#/attendance/${ev.id}`);
  $('#needTank').onchange = (e) => { ev.needTank = e.target.checked; touch(); };
  $('#needSupport').onchange = (e) => { ev.needSupport = e.target.checked; touch(); };
  $('#moreBtn').onclick = () => moreDialog(ev);
  if ($('#addGroupBtn')) $('#addGroupBtn').onclick = () => addGroupDialog(ev);
  if ($('#benchGroup')) $('#benchGroup').onchange = (e) => { benchFilter.group = e.target.value; render(); };
  $('#benchQ').oninput = debounce((e) => { benchFilter.q = e.target.value; render(); setTimeout(() => { const q = $('#benchQ'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }); }, 150);
  $$('#roleTabs button').forEach(b => (b.onclick = () => { benchFilter.role = b.dataset.r; render(); }));
  $$('[data-addparty]').forEach(b => (b.onclick = () => { const f = ev.fields.find(x => x.id === b.dataset.addparty); f.parties.push(newParty(f.parties.length)); touch(); }));

  $$('.party').forEach(el => {
    const [fid, pid] = el.dataset.party.split('|'); const { p } = findParty(ev, fid, pid);
    $('[data-act=lock]', el).onclick = () => { p.locked = !p.locked; touch(); };
    $('[data-act=party]', el).onclick = () => partyDialog(ev, fid, pid);
  });

  $$('#bench .chip').forEach(c => (c.onclick = () => {
    const id = c.dataset.mid; ev.absent = ev.absent || [];
    const i = ev.absent.indexOf(id); if (i >= 0) ev.absent.splice(i, 1); else ev.absent.push(id); touch();
  }));

  $$('.slot').forEach(s => {
    s.onclick = () => {
      const [fid, pid, i] = s.dataset.slot.split('|');
      if (s.dataset.mid) slotDialog(ev, fid, pid, +i); else pickerDialog(ev, fid, pid, +i);
    };
  });

  // drag and drop
  // #view outlives every redraw, so drop the previous board's listeners before adding these;
  // otherwise each redraw stacks another set and every drop runs (and redraws) many times over.
  if (v._dnd) v._dnd.abort();
  v._dnd = new AbortController();
  const on = { signal: v._dnd.signal };
  let drag = null, over = null;
  const setOver = (t) => { if (over === t) return; if (over) over.classList.remove('over'); over = t; if (t) t.classList.add('over'); };
  v.addEventListener('dragstart', (e) => {
    const top = e.target.closest('.party-top');
    if (top) {
      const pe = top.closest('.party'); drag = { party: pe.dataset.party };
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'party');
      pe.classList.add('dragging'); return;
    }
    const el = e.target.closest('[data-mid]'); if (!el) return;
    drag = { mid: el.dataset.mid, from: el.dataset.slot || null };
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', drag.mid);
    el.classList.add('dragging');
  }, on);
  v.addEventListener('dragend', () => { $$('.dragging', v).forEach(x => x.classList.remove('dragging')); setOver(null); drag = null; }, on);
  v.addEventListener('dragover', (e) => {
    if (!drag) return;
    const t = e.target.closest((drag && drag.party ? '.party, .parties' : '.slot, [data-bench]'));
    // A party can't be dropped onto itself. (Only for party drags: slots have no data-party, so the check must not run for people.)
    if (!t || (drag.party && t.dataset.party === drag.party)) return;
    e.preventDefault(); setOver(t);
  }, on);
  v.addEventListener('dragleave', (e) => { if (!drag) return; const t = e.target.closest((drag && drag.party ? '.party, .parties' : '.slot, [data-bench]')); if (t && t === over && !t.contains(e.relatedTarget)) setOver(null); }, on);
  v.addEventListener('drop', (e) => {
    if (drag && drag.party) {
      const t = e.target.closest('.party, .parties'); if (!t) return; e.preventDefault();
      const [sf, sp] = drag.party.split('|'); drag = null; setOver(null);
      const from = ev.fields.find(f => f.id === sf); const moving = from && from.parties.find(p => p.id === sp); if (!moving) return;
      let to, at;
      if (t.classList.contains('party')) {
        const [tf, tp] = t.dataset.party.split('|'); if (tp === sp) return;
        to = ev.fields.find(f => f.id === tf); at = to.parties.findIndex(p => p.id === tp);
      } else { to = ev.fields.find(f => f.id === t.dataset.field); at = to ? to.parties.length : -1; }
      if (!to || at < 0) return;
      // Dropped on a party: take its place (it shifts over). Dropped in a field's empty space: go last.
      const was = from.parties.indexOf(moving);
      from.parties.splice(was, 1);
      if (from === to && !t.classList.contains('party')) at = to.parties.length;
      to.parties.splice(Math.min(at, to.parties.length), 0, moving);
      touch(); return;
    }
    const t = e.target.closest('.slot, [data-bench]'); if (!t || !drag) return; e.preventDefault();
    const { mid, from } = drag; drag = null;
    if (t.dataset.bench) { if (from) { removeFromEvent(ev, mid); touch(); } return; }
    const [fid, pid, i] = t.dataset.slot.split('|'); const { p } = findParty(ev, fid, pid);
    const target = p.slots[+i];
    if (from) {
      const [ff, fp, fi] = from.split('|'); const src = findParty(ev, ff, fp).p;
      if (src === p && +fi === +i) return;
      src.slots[+fi] = target || null; src.pins[+fi] = false; p.slots[+i] = mid; p.pins[+i] = false;
      if (src.leader === mid && src !== p) src.leader = null;
      if (target && p.leader === target && src !== p) p.leader = null;
    } else {
      removeFromEvent(ev, mid); p.slots[+i] = mid; p.pins[+i] = false;
      if (target && p.leader === target) p.leader = null;
      (ev.absent || []).includes(mid) && ev.absent.splice(ev.absent.indexOf(mid), 1);
    }
    touch();
  }, on);
}

// ---------- add a whole group to the board ----------
// Puts a group's members into empty slots of one field, skipping anyone already placed or marked absent.
// "Together" fills whole empty parties first (so a static of 5 lands in one party) and gives the rest
// new parties; otherwise people take the first empty slots in order.
function placeGroup(ev, group, fieldId, { together, addParties }) {
  const mm = memberById(); const placed = placedIds(ev); const absent = new Set(ev.absent || []);
  const people = group.memberIds.map(id => mm[id]).filter(m => m && m.active !== false);
  const already = people.filter(m => placed.has(m.id));
  const away = people.filter(m => !placed.has(m.id) && absent.has(m.id));
  const queue = people.filter(m => !placed.has(m.id) && !absent.has(m.id));
  const f = ev.fields.find(x => x.id === fieldId);
  const size = f.parties[0]?.slots.length || S.partySize;
  const put = (p, i) => { p.slots[i] = queue.shift().id; p.pins[i] = false; };
  const fillEmpty = (p) => { if (p.locked) return; p.slots.forEach((id, i) => { if (!id && queue.length) put(p, i); }); };
  const addParty = () => { const p = newParty(f.parties.length); p.slots = Array(size).fill(null); p.pins = Array(size).fill(false); f.parties.push(p); return p; };
  const count = queue.length; let newParties = 0;
  if (together) {
    f.parties.filter(p => !p.locked && p.slots.every(id => !id)).forEach(p => queue.length && fillEmpty(p));
    if (addParties) while (queue.length) { fillEmpty(addParty()); newParties++; }
    else f.parties.forEach(fillEmpty);
  } else {
    f.parties.forEach(fillEmpty);
    if (addParties) while (queue.length) { fillEmpty(addParty()); newParties++; }
  }
  return { placed: count - queue.length, already, away, left: queue, newParties };
}
function addGroupDialog(ev) {
  const groups = [...S.groups].sort((a, b) => a.name.localeCompare(b.name));
  openModal(`<h2>Add a group</h2>
    <p class="muted" style="margin:0">Puts everyone from a group into empty slots. People already on this board, or marked absent, are skipped.</p>
    <div class="form-grid">
      <label class="field">Group<select id="agGroup">${groups.map(g => `<option value="${g.id}">${esc(g.name)} · ${g.memberIds.length}</option>`).join('')}</select></label>
      <label class="field">Into<select id="agField">${ev.fields.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></label>
    </div>
    <label class="check"><input type="checkbox" id="agTogether" checked> Keep them together (fill empty parties first, so a static stays in one party)</label>
    <label class="check"><input type="checkbox" id="agAdd" checked> Add parties if there isn't room</label>
    <div id="agPrev" class="muted" style="font-size:13px"></div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="agGo">Add to board</button></div>`,
  { onMount: (el, close) => {
    const opts = () => ({ together: $('#agTogether', el).checked, addParties: $('#agAdd', el).checked });
    const pick = () => groups.find(g => g.id === $('#agGroup', el).value);
    const names = (list) => esc(list.slice(0, 6).map(m => m.name).join(', ')) + (list.length > 6 ? ` and ${list.length - 6} more` : '');
    const preview = () => {
      // Try it on a copy first, so the preview shows exactly what Add will do.
      const r = placeGroup(JSON.parse(JSON.stringify(ev)), pick(), $('#agField', el).value, opts());
      $('#agPrev', el).innerHTML = `<div style="color:var(--ink)"><b>${r.placed}</b> will be placed${r.newParties ? ` in ${r.newParties} new part${r.newParties === 1 ? 'y' : 'ies'} and any empty slots` : ''}.</div>
        ${r.already.length ? `<div>${r.already.length} already on the board: ${names(r.already)}</div>` : ''}
        ${r.away.length ? `<div>${r.away.length} marked absent: ${names(r.away)}</div>` : ''}
        ${r.left.length ? `<div style="color:var(--warn)">${r.left.length} won't fit (no empty slots left): ${names(r.left)}. Tick "Add parties" to make room.</div>` : ''}`;
      $('#agGo', el).disabled = !r.placed;
    };
    ['#agGroup', '#agField', '#agTogether', '#agAdd'].forEach(sel => ($(sel, el).onchange = preview));
    preview();
    $('#agGo', el).onclick = () => {
      const g = pick(); const r = placeGroup(ev, g, $('#agField', el).value, opts());
      ev.updatedAt = new Date().toISOString();
      close(); commit();
      toast(`Added ${r.placed} from ${g.name}${r.left.length ? ` · ${r.left.length} didn't fit` : ''}`, 3500);
    };
  } });
}


function pickerDialog(ev, fid, pid, i) {
  const placed = placedIds(ev); const absent = new Set(ev.absent || []);
  const list = activeMembers().filter(m => !placed.has(m.id)).sort((a, b) => num(b.gs) - num(a.gs));
  openModal(`<h2>Add to slot</h2><input type="search" id="pq" placeholder="Search name or job">
    <div id="plist" style="max-height:50vh;overflow:auto"></div>
    <div class="actions"><button class="btn" data-close>Close</button></div>`,
  { onMount: (el, close) => {
    const draw = (q = '') => {
      const rows = list.filter(m => !q || (m.name + ' ' + m.job).toLowerCase().includes(q.toLowerCase()));
      $('#plist', el).innerHTML = rows.map(m => `<div class="chip ${absent.has(m.id) ? 'absent' : ''}" data-id="${m.id}"><span class="dot ${roleOf(m)}"></span>${esc(m.name)}<span class="muted" style="font-size:11px">${esc(pretty(m.job))}</span><span class="gs">${fmtNum(m.gs)}</span></div>`).join('') || '<div class="muted">No one left on the bench.</div>';
      $$('[data-id]', el).forEach(c => (c.onclick = () => { const { p } = findParty(ev, fid, pid); p.slots[i] = c.dataset.id; ev.absent = (ev.absent || []).filter(x => x !== c.dataset.id); close(); commit(); }));
    };
    draw(); $('#pq', el).oninput = (e) => draw(e.target.value);
  } });
}

function slotDialog(ev, fid, pid, i) {
  const { p } = findParty(ev, fid, pid); const m = memberById()[p.slots[i]];
  openModal(`<h2>${esc(m ? m.name : 'Removed member')}</h2>
    ${m ? `<div class="muted">${esc(pretty(m.job))} · Lv ${esc(m.level || '?')} · GS ${fmtNum(m.gs)} · ${strikeCount(m.id)} strikes</div>` : ''}
    <div class="row">
      ${m ? `<button class="btn" id="lead">${p.leader === m.id ? 'Remove leader' : 'Make leader'}</button>` : ''}
      <button class="btn" id="pin">${p.pins[i] ? 'Unpin' : 'Pin to this slot'}</button>
      <button class="btn" id="swap">Replace…</button>
      <button class="btn danger" id="rm">Move to bench</button>
    </div>
    <div class="muted" style="font-size:12px">Pinned members stay put when you auto-fill.</div>
    <div class="actions"><button class="btn" data-close>Close</button></div>`,
  { onMount: (el, close) => {
    if (m) $('#lead', el).onclick = () => { p.leader = p.leader === m.id ? null : m.id; close(); commit(); };
    $('#pin', el).onclick = () => { p.pins[i] = !p.pins[i]; close(); commit(); };
    $('#rm', el).onclick = () => { if (p.leader === p.slots[i]) p.leader = null; p.slots[i] = null; p.pins[i] = false; close(); commit(); };
    $('#swap', el).onclick = () => { if (p.leader === p.slots[i]) p.leader = null; p.slots[i] = null; p.pins[i] = false; close(); pickerDialog(ev, fid, pid, i); };
  } });
}

function partyDialog(ev, fid, pid) {
  const { f, p } = findParty(ev, fid, pid);
  openModal(`<h2>${esc(f.name)} · ${esc(p.label)}</h2>
    <div class="form-grid"><label class="field">Label<input type="text" id="lb" value="${esc(p.label)}"></label>
    <label class="field" style="grid-column:1/-1">Note (shows on the card)<input type="text" id="nt" value="${esc(p.note || '')}" placeholder="e.g. Hold left gate"></label></div>
    <div class="row"><button class="btn" id="clr">Empty party</button><button class="btn danger" id="del">Delete party</button></div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="sv">Save</button></div>`,
  { onMount: (el, close) => {
    $('#sv', el).onclick = () => { p.label = $('#lb', el).value.trim() || p.label; p.note = $('#nt', el).value.trim(); close(); commit(); };
    $('#clr', el).onclick = () => { p.slots = p.slots.map(() => null); p.pins = p.pins.map(() => false); p.leader = null; close(); commit(); };
    $('#del', el).onclick = () => { f.parties = f.parties.filter(x => x !== p); close(); commit(); };
  } });
}

function moreDialog(ev) {
  openModal(`<h2>${esc(ev.title)}</h2>
    <div class="row">
      <button class="btn" id="edit">Edit details</button>
      <button class="btn" id="dup">Duplicate</button>
      <button class="btn" id="clear">Clear unlocked parties</button>
    </div>
    <div class="row">
      ${mode === 'server' ? `<button class="btn" id="share">${ev.shareToken ? 'New share link' : 'Create share link'}</button>${ev.shareToken ? '<button class="btn" id="unshare">Turn off share link</button>' : ''}` : '<span class="muted" style="font-size:12px">Share links need the server (node server.js).</span>'}
      <button class="btn" id="csv" title="Same columns as Events → Import CSV">Export lineup (.csv)</button>
      <button class="btn" id="txt">Copy as text</button>
      <button class="btn" onclick="print()">Print</button>
    </div>
    <div class="row"><button class="btn danger" id="del">Delete event</button></div>
    <div class="actions"><button class="btn" data-close>Close</button></div>`,
  { onMount: (el, close) => {
    $('#edit', el).onclick = () => { close(); eventDialog(ev); };
    $('#dup', el).onclick = () => {
      const copy = JSON.parse(JSON.stringify(ev)); copy.id = uid('ev'); copy.title = ev.title + ' (copy)'; copy.status = 'draft'; copy.attendance = {}; copy.absent = []; copy.shareToken = null;
      copy.fields.forEach(f => { f.id = uid('fd'); f.parties.forEach(p => (p.id = uid('pt'))); });
      S.events.push(copy); close(); persist(); location.hash = `#/board/${copy.id}`;
    };
    $('#clear', el).onclick = () => { ev.fields.forEach(f => f.parties.forEach(p => { if (!p.locked) { p.slots = p.slots.map(() => null); p.pins = p.pins.map(() => false); p.leader = null; } })); close(); commit(); };
    if ($('#share', el)) $('#share', el).onclick = () => { ev.shareToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); close(); commit(); toast('Share link ready — it only works while your computer runs the server'); };
    if ($('#unshare', el)) $('#unshare', el).onclick = () => { ev.shareToken = null; close(); commit(); };
    $('#csv', el).onclick = () => { download(`${ev.title.replace(/[^\w\- ]+/g, '').trim() || 'lineup'}.csv`, lineupCsv(ev), 'text/csv'); };
    $('#txt', el).onclick = async () => { try { await navigator.clipboard.writeText(lineupText(ev)); toast('Lineup copied'); } catch { download('lineup.txt', lineupText(ev), 'text/plain'); } };
    $('#del', el).onclick = async () => { close(); if (await confirmBox(`Delete “${ev.title}” and its attendance?`)) { S.events = S.events.filter(x => x !== ev); persist(); location.hash = '#/events'; } };
  } });
}

function lineupText(ev) {
  const mm = memberById(); const out = [`${ev.title} — ${fmtWhen(ev.when)}`];
  ev.fields.forEach(f => { out.push('', `== ${f.name} ==`); f.parties.forEach(p => {
    const names = p.slots.filter(Boolean).map(id => (p.leader === id ? '★' : '') + (mm[id]?.name || '?') + ` (${pretty(mm[id]?.job)})`);
    if (names.length) out.push(`${p.label}${p.note ? ' [' + p.note + ']' : ''}: ${names.join(', ')}`);
  }); });
  return out.join('\n');
}

// Exports the lineup with the same columns Events → Import CSV reads, so it can move to another event or site.
function lineupCsv(ev) {
  const mm = memberById();
  const q = (v) => { const s = String(v ?? ''); return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [['Field', 'Party', 'IGN', 'Class', 'Leader', 'Level', 'Gear Score']];
  ev.fields.forEach(f => {
    // Party names must be unique within a field, or the import would merge them.
    const used = new Map();
    f.parties.forEach((p, i) => {
      let label = String(p.label || `P${i + 1}`); const n = (used.get(label) || 0) + 1; used.set(label, n); if (n > 1) label = `${label} (${n})`;
      p.slots.forEach(id => { const m = id && mm[id]; if (m) rows.push([f.name, label, m.name, pretty(m.job), p.leader === id ? 'yes' : '', m.level ?? '', m.gs || '']); });
    });
  });
  // The BOM lets Excel show names like Sapphireヅ correctly; the import ignores it.
  return '\uFEFF' + rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
}

// ---------- views: roster ----------
let rosterSort = { key: 'gs', dir: -1 }; let rosterQ = '';
routes.roster = (v) => {
  const att = attendanceStats();
  const cols = [['name', 'Name'], ['job', 'Job'], ['role', 'Role'], ['level', 'Lv', 1], ['gs', 'Gear score', 1], ['position', 'Rank'], ['contribution', 'Contribution', 1], ['att', 'Attendance', 1], ['strikes', 'Strikes', 1]];
  const val = (m, k) => k === 'role' ? roleOf(m) : k === 'att' ? (att[m.id]?.rate ?? -1) : k === 'strikes' ? strikeCount(m.id) : m[k];
  const rows = S.members.filter(m => !rosterQ || [m.name, m.job, m.position, m.discord].join(' ').toLowerCase().includes(rosterQ.toLowerCase()))
    .sort((a, b) => { const x = val(a, rosterSort.key), y = val(b, rosterSort.key); return (typeof x === 'number' || typeof y === 'number' ? num(x) - num(y) : String(x || '').localeCompare(String(y || ''))) * rosterSort.dir; });
  const roles = { tank: 0, support: 0, dps: 0 }; activeMembers().forEach(m => roles[roleOf(m)]++);
  v.innerHTML = `
    <div class="head"><div><h1>Roster</h1><div class="sub">${S.members.length} members · ${activeMembers().length} active ·
      <span class="dot tank"></span> ${roles.tank} tanks <span class="dot support"></span> ${roles.support} supports <span class="dot dps"></span> ${roles.dps} dps</div></div>
      <div class="row"><input type="search" id="rq" placeholder="Search" value="${esc(rosterQ)}"><button class="btn" id="exp">Export CSV</button><button class="btn" id="imp">Import CSV</button><button class="btn primary" id="add">Add member</button></div></div>
    ${S.members.length ? `<div class="table-wrap"><table class="t"><thead><tr>${cols.map(([k, l, n]) => `<th data-k="${k}" class="${n ? 'num' : ''}">${l}${rosterSort.key === k ? (rosterSort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}<th></th></tr></thead>
    <tbody>${rows.map(m => { const a = att[m.id]; return `<tr data-id="${m.id}" style="${m.active === false ? 'opacity:.5' : ''}">
      <td><b>${esc(m.name)}</b>${m.active === false ? ' <span class="pill">inactive</span>' : ''}</td><td>${esc(pretty(m.job))}</td><td><span class="dot ${roleOf(m)}"></span> ${roleOf(m)}</td>
      <td class="num">${esc(m.level ?? '')}</td><td class="num">${fmtNum(m.gs)}</td><td>${esc(m.position || '')}</td><td class="num">${m.contribution != null ? fmtNum(m.contribution) : ''}</td>
      <td class="num">${a ? `${Math.round(a.rate * 100)}% <span class="muted">(${a.present + a.late}/${a.total})</span>` : '<span class="muted">—</span>'}</td>
      <td class="num">${strikeCount(m.id) || ''}</td><td><button class="btn sm ghost" data-edit="${m.id}">Edit</button></td></tr>`; }).join('')}</tbody></table></div>`
    : `<div class="empty-state"><h3>Your roster is empty</h3>Import a spreadsheet (CSV or pasted from Excel / Google Sheets) or add members one by one.</div>`}`;
  $('#rq').oninput = debounce((e) => { rosterQ = e.target.value; render(); setTimeout(() => { const q = $('#rq'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 150);
  $('#add').onclick = () => memberDialog();
  $('#imp').onclick = () => importDialog();
  $('#exp').onclick = () => exportRosterCsv();
  $$('th[data-k]').forEach(th => (th.onclick = () => { const k = th.dataset.k; rosterSort = { key: k, dir: rosterSort.key === k ? -rosterSort.dir : (['name', 'job', 'role', 'position'].includes(k) ? 1 : -1) }; render(); }));
  $$('[data-edit]').forEach(b => (b.onclick = () => memberDialog(S.members.find(m => m.id === b.dataset.edit))));
};

function memberDialog(m) {
  const jobs = [...new Set([...Object.keys(S.roles), ...(m ? [m.job] : [])])];
  openModal(`<h2>${m ? 'Edit member' : 'Add member'}</h2>
    <div class="form-grid">
      <label class="field">Name<input type="text" id="m-name" value="${esc(m?.name || '')}"></label>
      <label class="field">Job<select id="m-job">${jobs.map(j => `<option value="${j}" ${m?.job === j ? 'selected' : ''}>${esc(pretty(j))}</option>`).join('')}</select></label>
      <label class="field">Level<input type="number" id="m-level" value="${esc(m?.level ?? '')}"></label>
      <label class="field">Gear score<input type="number" id="m-gs" value="${esc(m?.gs ?? '')}"></label>
      <label class="field">Guild rank<input type="text" id="m-pos" value="${esc(m?.position || '')}"></label>
      <label class="field">Contribution<input type="number" id="m-con" value="${esc(m?.contribution ?? '')}"></label>
      <label class="field">Discord<input type="text" id="m-dc" value="${esc(m?.discord || '')}"></label>
      <label class="field" style="grid-column:1/-1">Notes<input type="text" id="m-notes" value="${esc(m?.notes || '')}"></label>
    </div>
    <label class="check"><input type="checkbox" id="m-active" ${m?.active === false ? '' : 'checked'}> Active (used by auto-fill)</label>
    <div class="actions">${m ? '<button class="btn danger" id="del" style="margin-right:auto">Remove</button>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" id="sv">Save</button></div>`,
  { onMount: (el, close) => {
    $('#sv', el).onclick = () => {
      const name = $('#m-name', el).value.trim(); if (!name) { toast('Name is required'); return; }
      const data = { name, job: $('#m-job', el).value, level: num($('#m-level', el).value, null), gs: num($('#m-gs', el).value), position: $('#m-pos', el).value.trim(), contribution: $('#m-con', el).value === '' ? null : num($('#m-con', el).value), discord: $('#m-dc', el).value.trim(), notes: $('#m-notes', el).value.trim(), active: $('#m-active', el).checked, updatedAt: new Date().toISOString() };
      if (m) Object.assign(m, data); else S.members.push({ id: uid('mb'), createdAt: data.updatedAt, ...data });
      close(); commit();
    };
    if (m) $('#del', el).onclick = async () => {
      close();
      if (await confirmBox(`Remove ${m.name} from the roster? They'll be taken out of every lineup and group.`, 'Remove')) {
        S.members = S.members.filter(x => x !== m);
        S.events.forEach(e => removeFromEvent(e, m.id));
        S.groups.forEach(g => (g.memberIds = g.memberIds.filter(x => x !== m.id)));
        S.strikes = S.strikes.filter(s => s.memberId !== m.id);
        commit();
      }
    };
  } });
}

function importDialog() {
  openModal(`<h2>Import roster</h2>
    <p class="muted" style="margin:0">Paste rows straight from Excel or Google Sheets, or pick a .csv file. The first row should be headers. Recognized: <span class="mono" style="font-size:12px">name/IGN, job/class, level, gear score/GS/power, rank, contribution, weekly, discord, notes</span>.</p>
    <div class="row"><input type="file" id="file" accept=".csv,.tsv,.txt"></div>
    <textarea id="csv" placeholder="IGN,Class,Level,Gear Score&#10;Aria,High Priest,92,184500"></textarea>
    <div id="preview" class="muted" style="font-size:13px"></div>
    <div class="row"><label class="check"><input type="radio" name="how" value="merge" checked> Merge (update by name, add new)</label>
      <label class="check"><input type="radio" name="how" value="replace"> Replace whole roster</label>
      <label class="check"><input type="checkbox" id="deact"> Mark members missing from the file inactive</label></div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go" disabled>Import</button></div>`,
  { wide: true, onMount: (el, close) => {
    let parsed = null;
    const check = () => {
      const rows = parseCSV($('#csv', el).value.trim());
      if (rows.length < 2) { parsed = null; $('#preview', el).textContent = ''; $('#go', el).disabled = true; return; }
      const map = mapHeaders(rows[0]);
      if (map.name == null) { parsed = null; $('#preview', el).innerHTML = `<span style="color:var(--danger)">Couldn't find a name column. Headers seen: ${esc(rows[0].join(', '))}</span>`; $('#go', el).disabled = true; return; }
      parsed = rows.slice(1).map(r => {
        const g = (k) => (map[k] != null ? (r[map[k]] ?? '').trim() : '');
        return { name: g('name'), job: normalizeJob(g('job')), level: g('level') ? num(g('level')) : null, gs: num(g('gs')), position: g('position'), title: g('title'), contribution: g('contribution') ? num(g('contribution')) : null, weekly: g('weekly') ? num(g('weekly')) : null, discord: g('discord'), notes: g('notes') };
      }).filter(x => x.name);
      const unknown = [...new Set(parsed.map(p => p.job).filter(j => !S.roles[j]))];
      const existing = new Set(S.members.map(m => m.name.toLowerCase()));
      const fresh = parsed.filter(p => !existing.has(p.name.toLowerCase())).length;
      $('#preview', el).innerHTML = `${parsed.length} rows · ${fresh} new · ${parsed.length - fresh} updates. Columns matched: ${Object.keys(map).join(', ')}.${unknown.length ? ` <br>Unknown jobs (will count as DPS until you set them in Settings): ${esc(unknown.join(', '))}` : ''}`;
      $('#go', el).disabled = false;
    };
    $('#csv', el).oninput = debounce(check, 200);
    $('#file', el).onchange = async (e) => { const f = e.target.files[0]; if (f) { $('#csv', el).value = await f.text(); check(); } };
    $('#go', el).onclick = () => {
      if (!parsed) return;
      const how = $('input[name=how]:checked', el).value; const now = new Date().toISOString();
      parsed.forEach(p => { if (!S.roles[p.job]) S.roles[p.job] = 'dps'; });
      if (how === 'replace') {
        const old = Object.fromEntries(S.members.map(m => [m.name.toLowerCase(), m]));
        S.members = parsed.map(p => ({ ...(old[p.name.toLowerCase()] || { id: uid('mb'), createdAt: now }), ...p, active: true, updatedAt: now }));
        const ids = new Set(S.members.map(m => m.id));
        S.events.forEach(e => e.fields.forEach(f => f.parties.forEach(pt => pt.slots.forEach((id, i) => { if (id && !ids.has(id)) { pt.slots[i] = null; pt.pins[i] = false; } }))));
        S.groups.forEach(g => (g.memberIds = g.memberIds.filter(x => ids.has(x))));
      } else {
        const byName = Object.fromEntries(S.members.map(m => [m.name.toLowerCase(), m]));
        const seen = new Set();
        parsed.forEach(p => {
          const ex = byName[p.name.toLowerCase()]; seen.add(p.name.toLowerCase());
          const clean = Object.fromEntries(Object.entries(p).filter(([k, v]) => v !== '' && v !== null && !(k === 'gs' && v === 0 && ex)));
          if (ex) Object.assign(ex, clean, { active: true, updatedAt: now });
          else S.members.push({ id: uid('mb'), createdAt: now, active: true, ...p, updatedAt: now });
        });
        if ($('#deact', el).checked) S.members.forEach(m => { if (!seen.has(m.name.toLowerCase())) m.active = false; });
      }
      close(); commit(); toast(`Imported ${parsed.length} members`);
    };
  } });
}

// ---------- import a lineup (an event) from CSV ----------
// One row per person in slot order: Field (optional), Party, IGN, Class, Leader (optional).
const LINEUP_ALIASES = {
  field: ['field', 'map', 'area', 'side', 'zone'],
  party: ['party', 'party name', 'group', 'pt', 'squad', 'team'],
  leader: ['leader', 'party leader', 'is leader', 'lead'],
};
const LINEUP_SAMPLE = 'Field,Party,IGN,Class,Leader\nMain Field,Party 1,Aria,High Priest,yes\nMain Field,Party 1,Bran,Lord Knight,\nSub Field,Party 2,Cole,Sniper,';
const lineupKey = (name) => String(name || '').trim().toLowerCase();
function parseLineupCSV(text) {
  const rows = parseCSV(String(text || '').trim());
  if (rows.length < 2) return { error: 'Paste a header row and at least one person.' };
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' '));
  const col = (k) => { const i = head.findIndex(h => LINEUP_ALIASES[k].includes(h)); return i >= 0 ? i : null; };
  const base = mapHeaders(rows[0]);
  const c = { name: base.name, job: base.job, level: base.level, gs: base.gs, field: col('field'), party: col('party'), leader: col('leader') };
  if (c.name == null) return { error: `Couldn't find a name column (IGN or Name). Headers seen: ${rows[0].join(', ')}` };
  if (c.party == null) return { error: `Couldn't find a Party column. Headers seen: ${rows[0].join(', ')}` };
  const get = (r, k) => (c[k] != null ? String(r[c[k]] ?? '').trim() : '');
  const fields = []; const people = new Map(); let dupes = 0;
  rows.slice(1).forEach(r => {
    const name = get(r, 'name'); if (!name) return;
    const fName = get(r, 'field') || 'Main'; const pName = get(r, 'party') || 'Party';
    let f = fields.find(x => x.name === fName); if (!f) fields.push(f = { name: fName, parties: [] });
    let p = f.parties.find(x => x.name === pName); if (!p) f.parties.push(p = { name: pName, members: [] });
    const k = lineupKey(name);
    if (people.has(k)) { dupes++; return; }
    const person = { key: k, name, job: normalizeJob(get(r, 'job')), hasJob: !!get(r, 'job'), leader: /^(y|yes|true|1|x|leader|★)$/i.test(get(r, 'leader')),
      level: get(r, 'level') ? num(get(r, 'level')) : null, gs: get(r, 'gs') ? num(get(r, 'gs')) : null };
    people.set(k, person); p.members.push(person);
  });
  if (!people.size) return { error: 'No names found under the name column.' };
  const byName = Object.fromEntries(S.members.map(m => [lineupKey(m.name), m]));
  const list = [...people.values()].map(p => ({ ...p, existing: byName[p.key] || null }));
  return { fields, people: list, dupes,
    fresh: list.filter(p => !p.existing),
    jobChanges: list.filter(p => p.existing && p.hasJob && p.existing.job !== p.job),
    biggest: Math.max(...fields.flatMap(f => f.parties.map(p => p.members.length))) };
}
// The mode whose field names match the CSV's fields best (Main Field + Sub Field → Guild League).
function guessLineupMode(fields) {
  const names = new Set(fields.map(f => lineupKey(f.name)));
  let best = S.modes[0], score = -1;
  S.modes.forEach(md => { const s = md.fields.filter(f => names.has(lineupKey(f.name))).length; if (s > score) { best = md; score = s; } });
  return best;
}
function lineupCsvDialog() {
  openModal(`<h2>Import lineup from CSV</h2>
    <p class="muted" style="margin:0">One row per person, in slot order. Columns: <span class="mono" style="font-size:12px">Field</span> (optional), <span class="mono" style="font-size:12px">Party</span>, <span class="mono" style="font-size:12px">IGN</span>, <span class="mono" style="font-size:12px">Class</span>, and optionally <span class="mono" style="font-size:12px">Leader</span> (“yes”), <span class="mono" style="font-size:12px">Level</span>, <span class="mono" style="font-size:12px">Gear Score</span>. A board's More → Export lineup (.csv) makes exactly this. Names are matched to your roster exactly; anyone who isn't in it leaves their slot empty.</p>
    <div class="row"><input type="file" id="lcFile" accept=".csv,.tsv,.txt"><span class="grow"></span><button class="btn sm ghost" id="lcSample">Show an example</button></div>
    <textarea id="lcCsv" placeholder="${esc(LINEUP_SAMPLE)}"></textarea>
    <div id="lcPrev" class="muted" style="font-size:13px"></div>
    <div id="lcOpts" style="display:none;gap:10px">
      <div class="form-grid">
        <label class="field" style="grid-column:1/-1">Event title<input type="text" id="lcTitle" placeholder="Leave blank for “Mode — date”"></label>
        <label class="field">Mode<select id="lcMode">${S.modes.map(m => `<option value="${esc(m.key)}">${esc(m.label)}</option>`).join('')}</select></label>
        <label class="field">Starts<input type="datetime-local" id="lcWhen" value="${esc(toLocalInput(nextHour()))}"></label>
      </div>
      <label class="check"><input type="checkbox" id="lcJobs" checked> Update job, level and gear score of people already in the roster (when the file has them)</label>
    </div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="lcGo" disabled>Create event</button></div>`,
  { wide: true, onMount: (el, close) => {
    let plan = null;
    const prev = $('#lcPrev', el), go = $('#lcGo', el);
    const check = () => {
      plan = null; go.disabled = true; $('#lcOpts', el).style.display = 'none'; prev.style.color = '';
      if (!$('#lcCsv', el).value.trim()) { prev.textContent = ''; return; }
      const r = parseLineupCSV($('#lcCsv', el).value);
      if (r.error) { prev.style.color = 'var(--danger)'; prev.textContent = r.error; return; }
      plan = r;
      const jobs = r.jobChanges.slice(0, 6).map(p => `${esc(p.name)} (${esc(pretty(p.existing.job))} → ${esc(pretty(p.job))})`).join(', ');
      const unknown = [...new Set(r.people.filter(p => p.hasJob && !S.roles[p.job]).map(p => p.job))];
      prev.innerHTML = `<div style="color:var(--ink)">${r.fields.map(f => `<b>${esc(f.name)}</b>: ${f.parties.length} parties, ${f.parties.reduce((a, p) => a + p.members.length, 0)} people`).join(' · ')}</div>
        <div><b style="color:var(--ink-2)">${r.people.length - r.fresh.length}</b> of ${r.people.length} people are in your roster and will be placed${r.jobChanges.length ? ` · ${r.jobChanges.length} with a different job` : ''}</div>
        ${r.fresh.length ? `<div style="color:var(--warn)">${r.fresh.length} not in your roster, so their slots stay empty: ${esc(r.fresh.slice(0, 12).map(p => p.name).join(', '))}${r.fresh.length > 12 ? ` and ${r.fresh.length - 12} more` : ''}. Add them in Roster first if you want them placed.</div>` : ''}
        ${r.jobChanges.length ? `<div>Job changes: ${jobs}${r.jobChanges.length > 6 ? ` and ${r.jobChanges.length - 6} more` : ''}</div>` : ''}
        ${r.biggest > S.partySize ? `<div style="color:var(--warn)">Some parties have ${r.biggest} people, so parties in this event get ${Math.min(12, r.biggest)} slots.</div>` : ''}
        ${r.dupes ? `<div style="color:var(--warn)">${r.dupes} repeated name(s) skipped: each person goes in one slot.</div>` : ''}
        ${unknown.length ? `<div>Unknown jobs (count as DPS until you set them in Settings): ${esc(unknown.map(pretty).join(', '))}</div>` : ''}`;
      $('#lcMode', el).value = guessLineupMode(r.fields).key;
      $('#lcOpts', el).style.display = 'grid'; go.disabled = false;
    };
    $('#lcCsv', el).oninput = debounce(check, 200);
    $('#lcFile', el).onchange = async (e) => { const f = e.target.files[0]; if (f) { $('#lcCsv', el).value = await f.text(); check(); } };
    $('#lcSample', el).onclick = () => { $('#lcCsv', el).value = LINEUP_SAMPLE; check(); };
    go.onclick = () => {
      if (!plan) return;
      const now = new Date().toISOString(); const byKey = {}; const updateJobs = $('#lcJobs', el).checked;
      // Only people already in the roster are placed; the roster itself never gains anyone here.
      plan.people.forEach(p => {
        const m = p.existing; if (!m) return;
        if (updateJobs && p.hasJob && m.job !== p.job) { if (!S.roles[p.job]) S.roles[p.job] = 'dps'; m.job = p.job; m.updatedAt = now; }
        if (updateJobs && p.level != null && m.level !== p.level) { m.level = p.level; m.updatedAt = now; }
        if (updateJobs && p.gs && m.gs !== p.gs) { m.gs = p.gs; m.updatedAt = now; }
        if (m.active === false) { m.active = true; m.updatedAt = now; }
        byKey[p.key] = m;
      });
      const size = Math.max(1, Math.min(12, Math.max(S.partySize, plan.biggest)));
      const md = modeByKey($('#lcMode', el).value) || S.modes[0];
      const whenRaw = $('#lcWhen', el).value; const when = whenRaw ? new Date(whenRaw).toISOString() : null;
      const title = $('#lcTitle', el).value.trim() || `${md.label} — ${when ? new Date(when).toLocaleDateString() : 'TBD'}`;
      const fields = plan.fields.map(f => ({ id: uid('fd'), name: f.name, parties: f.parties.map((p, i) => {
        const slots = Array(size).fill(null); let leader = null;
        p.members.slice(0, size).forEach((x, j) => { const m = byKey[x.key]; if (!m) return; slots[j] = m.id; if (x.leader) leader = m.id; });
        return { id: uid('pt'), label: p.name || `P${i + 1}`, leader, locked: false, note: '', slots, pins: Array(size).fill(false) };
      }) }));
      const ev = { id: uid('ev'), mode: md.key, title, when, groupId: null, status: 'draft', fields, absent: [], attendance: {},
        needTank: md.needTank, needSupport: md.needSupport, shareToken: null, createdAt: now, updatedAt: now };
      S.events.push(ev);
      close(); persist();
      const placedCount = plan.people.length - plan.fresh.length;
      toast(`Event created: ${placedCount} placed${plan.fresh.length ? `, ${plan.fresh.length} empty slot(s) for names not in the roster` : ''}`, 4000);
      location.hash = `#/board/${ev.id}`;
    };
  } });
}


function exportRosterCsv() {
  const att = attendanceStats();
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['Name', 'Job', 'Role', 'Level', 'Gear Score', 'Rank', 'Contribution', 'Weekly', 'Discord', 'Active', 'Attendance %', 'Strikes', 'Notes'];
  const rows = S.members.map(m => [m.name, pretty(m.job), roleOf(m), m.level, m.gs, m.position, m.contribution, m.weekly, m.discord, m.active === false ? 'no' : 'yes', att[m.id] ? Math.round(att[m.id].rate * 100) : '', strikeCount(m.id), m.notes]);
  download(`roster-${new Date().toISOString().slice(0, 10)}.csv`, [head, ...rows].map(r => r.map(q).join(',')).join('\n'), 'text/csv');
}

// ---------- views: groups ----------
routes.groups = (v) => {
  const mm = memberById();
  v.innerHTML = `
    <div class="head"><div><h1>Groups</h1><div class="sub">Static teams, mains/alts, or anyone you want to fill an event from.</div></div>
      <div class="row"><button class="btn primary" id="ng">New group</button></div></div>
    ${S.groups.length ? `<div class="grid-cards">${S.groups.map(g => `<div class="card pad" style="display:flex;flex-direction:column;gap:8px">
      <div class="row"><b style="font:600 16px var(--serif)">${esc(g.name)}</b><span class="muted mono">${g.memberIds.length}</span><span class="grow"></span><button class="btn sm" data-g="${g.id}">Edit</button></div>
      <div style="font-size:13px;color:var(--ink-2)">${g.memberIds.map(id => mm[id]).filter(Boolean).map(m => `<span style="white-space:nowrap"><span class="dot ${roleOf(m)}"></span> ${esc(m.name)}</span>`).join(' · ') || '<span class="muted">No members yet</span>'}</div></div>`).join('')}</div>`
    : '<div class="empty-state"><h3>No groups</h3>Groups let you fill an event from just part of the roster.</div>'}`;
  $('#ng').onclick = () => groupDialog();
  $$('[data-g]').forEach(b => (b.onclick = () => groupDialog(S.groups.find(g => g.id === b.dataset.g))));
};

function groupDialog(g) {
  const sel = new Set(g ? g.memberIds : []);
  const list = [...S.members].sort((a, b) => a.name.localeCompare(b.name));
  openModal(`<h2>${g ? 'Edit group' : 'New group'}</h2>
    <label class="field">Name<input type="text" id="gn" value="${esc(g?.name || '')}"></label>
    <div class="row"><input type="search" id="gq" placeholder="Filter" class="grow"><span class="muted" id="gc"></span></div>
    <div id="gl" style="max-height:45vh;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:2px 10px"></div>
    <div class="actions">${g ? '<button class="btn danger" id="del" style="margin-right:auto">Delete</button>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" id="sv">Save</button></div>`,
  { wide: true, onMount: (el, close) => {
    const draw = (q = '') => {
      $('#gl', el).innerHTML = list.filter(m => !q || (m.name + m.job).toLowerCase().includes(q.toLowerCase()))
        .map(m => `<label class="check" style="padding:3px 0"><input type="checkbox" value="${m.id}" ${sel.has(m.id) ? 'checked' : ''}><span class="dot ${roleOf(m)}"></span>${esc(m.name)} <span class="muted" style="font-size:11px">${esc(pretty(m.job))}</span></label>`).join('');
      $$('#gl input', el).forEach(c => (c.onchange = () => { c.checked ? sel.add(c.value) : sel.delete(c.value); $('#gc', el).textContent = `${sel.size} selected`; }));
      $('#gc', el).textContent = `${sel.size} selected`;
    };
    draw(); $('#gq', el).oninput = (e) => draw(e.target.value);
    $('#sv', el).onclick = () => {
      const name = $('#gn', el).value.trim() || 'Untitled group';
      if (g) Object.assign(g, { name, memberIds: [...sel] }); else S.groups.push({ id: uid('gp'), name, memberIds: [...sel] });
      close(); commit();
    };
    if (g) $('#del', el).onclick = () => { S.groups = S.groups.filter(x => x !== g); S.events.forEach(e => { if (e.groupId === g.id) e.groupId = null; }); close(); commit(); };
  } });
}

// ---------- views: attendance ----------
function attendanceStats() {
  const out = {};
  S.events.filter(e => e.attendance && Object.keys(e.attendance).length).forEach(e => {
    Object.entries(e.attendance).forEach(([id, st]) => {
      const o = out[id] || (out[id] = { present: 0, late: 0, absent: 0, total: 0, rate: 0 });
      if (o[st] != null) o[st]++; o.total++;
    });
  });
  Object.values(out).forEach(o => (o.rate = o.total ? (o.present + o.late) / o.total : 0));
  return out;
}

routes.attendance = (v, eventId) => {
  if (eventId) return attendanceEvent(v, eventById(eventId));
  const taken = S.events.filter(e => e.attendance && Object.keys(e.attendance).length).sort((a, b) => String(b.when).localeCompare(String(a.when)));
  const att = attendanceStats();
  const rows = S.members.filter(m => att[m.id]).sort((a, b) => att[a.id].rate - att[b.id].rate || att[b.id].absent - att[a.id].absent);
  v.innerHTML = `
    <div class="head"><div><h1>Attendance</h1><div class="sub">${taken.length} events with attendance taken</div></div>
      <div class="row"><select id="pick"><option value="">Take attendance for…</option>${[...S.events].sort((a, b) => String(b.when).localeCompare(String(a.when))).map(e => `<option value="${e.id}">${esc(e.title)}</option>`).join('')}</select></div></div>
    ${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Member</th><th>Job</th><th class="num">Present</th><th class="num">Late</th><th class="num">Absent</th><th class="num">Rate</th><th></th><th class="num">Strikes</th></tr></thead><tbody>
      ${rows.map(m => { const a = att[m.id]; return `<tr><td><b>${esc(m.name)}</b></td><td>${esc(pretty(m.job))}</td><td class="num">${a.present}</td><td class="num">${a.late}</td><td class="num">${a.absent}</td>
        <td class="num">${Math.round(a.rate * 100)}%</td><td><div class="bar"><i style="width:${Math.round(a.rate * 100)}%;${a.rate < .5 ? 'background:var(--danger)' : a.rate < .8 ? 'background:var(--warn)' : ''}"></i></div></td><td class="num">${strikeCount(m.id) || ''}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty-state"><h3>No attendance yet</h3>Pick an event above, or open one and press Attendance.</div>'}`;
  $('#pick').onchange = (e) => { if (e.target.value) location.hash = `#/attendance/${e.target.value}`; };
};

let attScope = 'lineup';
function attendanceEvent(v, ev) {
  if (!ev) { v.innerHTML = '<div class="empty-state"><h3>Event not found</h3></div>'; return; }
  ev.attendance = ev.attendance || {};
  const placed = placedIds(ev);
  const list = (attScope === 'lineup' ? S.members.filter(m => placed.has(m.id) || ev.attendance[m.id]) : activeMembers()).sort((a, b) => a.name.localeCompare(b.name));
  const counts = { present: 0, late: 0, absent: 0 }; Object.values(ev.attendance).forEach(s => counts[s] != null && counts[s]++);
  v.innerHTML = `
    <div class="head"><div><h1>Attendance</h1><div class="sub">${esc(ev.title)} · ${esc(fmtWhen(ev.when))} · ${counts.present} present · ${counts.late} late · ${counts.absent} absent · ${list.length - Object.keys(ev.attendance).filter(id => list.some(m => m.id === id)).length} unmarked</div></div>
      <div class="row"><a class="btn ghost" href="#/board/${ev.id}">← Lineup</a>
        <div class="tabs" id="scope"><button data-s="lineup" class="${attScope === 'lineup' ? 'on' : ''}">Lineup</button><button data-s="all" class="${attScope === 'all' ? 'on' : ''}">Whole roster</button></div>
        <button class="btn" id="allP">Mark unmarked present</button><button class="btn" id="strike">Strike absentees</button></div></div>
    <div class="card">${list.map(m => { const s = ev.attendance[m.id]; return `<div class="att-row"><div><span class="dot ${roleOf(m)}"></span> <b>${esc(m.name)}</b> <span class="muted" style="font-size:12px">${esc(pretty(m.job))}${placed.has(m.id) ? '' : ' · not in lineup'}</span></div>
      <div class="seg" data-id="${m.id}">${['present', 'late', 'absent'].map(k => `<button class="${k} ${s === k ? 'on' : ''}" data-k="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div></div>`; }).join('') || '<div class="muted" style="padding:16px">Nobody in this lineup yet.</div>'}</div>`;
  $$('#scope button').forEach(b => (b.onclick = () => { attScope = b.dataset.s; render(); }));
  $$('.seg').forEach(seg => $$('button', seg).forEach(b => (b.onclick = () => {
    const id = seg.dataset.id; if (ev.attendance[id] === b.dataset.k) delete ev.attendance[id]; else ev.attendance[id] = b.dataset.k; commit();
  })));
  $('#allP').onclick = () => { list.forEach(m => { if (!ev.attendance[m.id]) ev.attendance[m.id] = 'present'; }); commit(); };
  $('#strike').onclick = async () => {
    const abs = Object.entries(ev.attendance).filter(([, s]) => s === 'absent').map(([id]) => id)
      .filter(id => !S.strikes.some(s => s.memberId === id && s.eventId === ev.id));
    if (!abs.length) { toast('No new absentees to strike'); return; }
    if (!(await confirmBox(`Give ${abs.length} absent member(s) a strike for “${ev.title}”?`, 'Add strikes'))) return;
    const date = (ev.when || new Date().toISOString()).slice(0, 10);
    abs.forEach(id => S.strikes.push({ id: uid('st'), memberId: id, eventId: ev.id, date, reason: `Absent: ${ev.title}` }));
    commit(); toast(`${abs.length} strike(s) added`);
  };
}

// ---------- views: strikes ----------
routes.strikes = (v) => {
  const mm = memberById();
  const list = [...S.strikes].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const per = {}; S.strikes.forEach(s => (per[s.memberId] = (per[s.memberId] || 0) + 1));
  const top = Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 8);
  v.innerHTML = `
    <div class="head"><div><h1>Strikes</h1><div class="sub">${S.strikes.length} strikes on ${Object.keys(per).length} members</div></div>
      <div class="row"><button class="btn primary" id="ns">Add strike</button></div></div>
    ${top.length ? `<div class="row" style="margin-bottom:14px">${top.map(([id, n]) => `<span class="pill" style="font-size:12px">${esc(mm[id]?.name || '?')} <b class="mono">${n}</b></span>`).join('')}</div>` : ''}
    ${list.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Date</th><th>Member</th><th>Reason</th><th></th></tr></thead><tbody>
      ${list.map(s => `<tr><td class="mono">${esc(s.date)}</td><td><b>${esc(mm[s.memberId]?.name || 'Removed member')}</b></td><td>${esc(s.reason)}</td><td style="text-align:right"><button class="btn sm ghost" data-rm="${s.id}">Remove</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty-state"><h3>No strikes</h3>Add one by hand, or use “Strike absentees” after taking attendance.</div>'}`;
  $('#ns').onclick = () => {
    const ms = [...S.members].sort((a, b) => a.name.localeCompare(b.name));
    openModal(`<h2>Add strike</h2><div class="form-grid">
      <label class="field">Member<select id="sm">${ms.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
      <label class="field">Date<input type="text" id="sd" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label class="field" style="grid-column:1/-1">Reason<input type="text" id="sr" placeholder="e.g. No-show for Siege War"></label></div>
      <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="sv">Add</button></div>`,
    { onMount: (el, close) => { $('#sv', el).onclick = () => { S.strikes.push({ id: uid('st'), memberId: $('#sm', el).value, date: $('#sd', el).value.trim(), reason: $('#sr', el).value.trim() || 'No reason given', eventId: null }); close(); commit(); }; } });
  };
  $$('[data-rm]').forEach(b => (b.onclick = () => { S.strikes = S.strikes.filter(s => s.id !== b.dataset.rm); commit(); }));
};

// ---------- views: settings ----------
routes.settings = (v) => {
  const jobs = Object.keys(S.roles).sort();
  v.innerHTML = `
    <div class="head"><div><h1>Settings</h1><div class="sub">${mode === 'server' ? `Saved on the server for ${esc(me?.active?.name || 'this guild')} (hourly backups).` : 'Data is saved in this browser only. Run node server.js to save to a file and get share links.'}</div></div></div>
    <div style="display:grid;gap:16px;max-width:900px">
      <div class="card pad" style="display:grid;gap:12px">
        <b style="font:600 16px var(--serif)">Guild</b>
        <div class="form-grid"><label class="field">Guild name<input type="text" id="gname" value="${esc(S.guild.name)}"></label>
        <label class="field">Party size<input type="number" id="psize" min="1" max="12" value="${S.partySize}"></label></div>
        <div class="muted" style="font-size:12px">Changing party size applies to new events.</div>
      </div>
      <div class="card pad" style="display:grid;gap:12px">
        <div class="row"><b style="font:600 16px var(--serif)">Event modes</b><span class="grow"></span><button class="btn sm" id="addMode">+ mode</button></div>
        ${S.modes.map((md, i) => `<div style="display:grid;gap:8px;padding:10px;border:1px solid var(--line);border-radius:8px" data-mode="${i}">
          <div class="row"><input type="text" data-f="label" value="${esc(md.label)}" style="font-weight:600">
            <label class="check"><input type="checkbox" data-f="needTank" ${md.needTank ? 'checked' : ''}> tank per party</label>
            <label class="check"><input type="checkbox" data-f="needSupport" ${md.needSupport ? 'checked' : ''}> support per party</label><span class="grow"></span>
            <button class="btn sm ghost danger" data-delmode="${i}">Remove</button></div>
          <div class="row" style="font-size:13px">Fields:
            ${md.fields.map((f, j) => `<span class="row" style="gap:4px"><input type="text" data-fn="${j}" value="${esc(f.name)}" style="width:130px"><input type="number" data-fc="${j}" value="${f.rosterSized ? '' : f.cap}" placeholder="roster" title="Slots (blank = whole active roster)" style="width:80px"><button class="icon-btn" data-delf="${j}" title="Remove field">✕</button></span>`).join('')}
            <button class="btn sm ghost" data-addf="${i}">+ field</button></div></div>`).join('')}
      </div>
      <div class="card pad" style="display:grid;gap:12px">
        <b style="font:600 16px var(--serif)">Job roles</b>
        <div class="muted" style="font-size:12px">Auto-fill uses these to put a tank or support in each party.</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px 14px">
          ${jobs.map(j => `<label class="row" style="justify-content:space-between;font-size:13px"><span><span class="dot ${S.roles[j]}"></span> ${esc(pretty(j))}</span>
            <select data-job="${j}" style="padding:3px 6px">${['tank', 'support', 'dps'].map(r => `<option ${S.roles[j] === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>`).join('')}
        </div>
        <div class="row"><input type="text" id="newJob" placeholder="Add a job (e.g. Soul Linker)"><button class="btn sm" id="addJob">Add</button></div>
      </div>
      ${mode === 'server' ? `<div class="card pad" style="display:grid;gap:12px">
        <div class="row"><b style="font:600 16px var(--serif)">Guild members</b><span class="grow"></span><button class="btn sm" id="myPw">My account</button></div>
        <div class="muted" style="font-size:12px"><b>Guild Leader</b>: everything, plus roles and removing people. <b>Officer</b>: edits roster, events, attendance and auction. <b>Member</b>: sees lineups and their own reservations, and can sign up when self sign-up is on.</div>
        <div id="people" class="muted">Loading…</div>
      </div>` : ''}
      ${mode === 'server' && me?.admin ? `<div class="card pad" style="display:grid;gap:12px">
        <b style="font:600 16px var(--serif)">Site (admin only)</b>
        <div id="site" class="muted">Loading…</div>
      </div>` : ''}
      <div class="card pad" style="display:grid;gap:12px">
        <b style="font:600 16px var(--serif)">Backup</b>
        <div class="row"><button class="btn" id="bk">Download backup (.json)</button>${mode !== 'server' || me?.active?.role === 'leader' ? `<label class="btn">Restore from backup<input type="file" id="rs" accept=".json" hidden></label>
          <span class="grow"></span><button class="btn danger" id="reset">Erase everything</button>` : '<span class="muted" style="font-size:12px">Only a guild leader can restore or erase.</span>'}</div>
      </div>
    </div>`;
  $('#gname').onchange = (e) => { S.guild.name = e.target.value.trim() || 'My Guild'; commit(); };
  $('#psize').onchange = (e) => { S.partySize = Math.min(12, Math.max(1, num(e.target.value, 5))); commit(); };
  $$('[data-job]').forEach(s => (s.onchange = () => { S.roles[s.dataset.job] = s.value; commit(); }));
  $('#addJob').onclick = () => { const j = normalizeJob($('#newJob').value); if (j && j !== 'NOVICE') { S.roles[j] = S.roles[j] || 'dps'; commit(); } };
  $('#addMode').onclick = () => { S.modes.push({ key: uid('md'), label: 'New mode', fields: [{ name: 'Main', cap: 40 }], needTank: false, needSupport: false }); commit(); };
  $$('[data-mode]').forEach(box => {
    const md = S.modes[+box.dataset.mode];
    $('[data-f=label]', box).onchange = (e) => { md.label = e.target.value.trim() || md.label; commit(false); };
    $('[data-f=needTank]', box).onchange = (e) => { md.needTank = e.target.checked; commit(false); };
    $('[data-f=needSupport]', box).onchange = (e) => { md.needSupport = e.target.checked; commit(false); };
    $$('[data-fn]', box).forEach(inp => (inp.onchange = () => { md.fields[+inp.dataset.fn].name = inp.value.trim() || 'Field'; commit(false); }));
    $$('[data-fc]', box).forEach(inp => (inp.onchange = () => { const f = md.fields[+inp.dataset.fc]; if (inp.value === '') { f.rosterSized = true; f.cap = 0; } else { f.rosterSized = false; f.cap = num(inp.value); } commit(false); }));
    $$('[data-delf]', box).forEach(b => (b.onclick = () => { if (md.fields.length > 1) { md.fields.splice(+b.dataset.delf, 1); commit(); } else toast('A mode needs at least one field'); }));
    $$('[data-addf]', box).forEach(b => (b.onclick = () => { md.fields.push({ name: 'Field', cap: 20 }); commit(); }));
  });
  $$('[data-delmode]').forEach(b => (b.onclick = () => { if (S.modes.length > 1) { S.modes.splice(+b.dataset.delmode, 1); commit(); } else toast('Keep at least one mode'); }));
  $('#bk').onclick = () => download(`ronw-planner-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(S, null, 2));
  if ($('#rs')) $('#rs').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const data = migrate(JSON.parse(await f.text())); if (await confirmBox('Replace all current data with this backup?', 'Restore')) { S = data; commit(); toast('Backup restored'); } }
    catch { toast('That file is not a RONW Planner backup'); }
  };
  if ($('#reset')) $('#reset').onclick = async () => { if (await confirmBox('Erase the roster, events, groups and strikes?', 'Erase')) { const name = S.guild.name; S = blankState(); S.guild.name = name; commit(); } };
  if (mode === 'server') { guildPanel(); $('#myPw').onclick = passwordDialog; if (me?.admin) sitePanel(); }
};

// Settings → Guild members: who's in the guild, their role, and which roster name is theirs.
async function guildPanel() {
  const box = $('#people'); if (!box) return;
  const r = await api('/api/guild');
  if (!r.ok) { box.textContent = r.error || 'Could not load guild members.'; return; }
  const leader = r.role === 'leader'; const mm = memberById();
  const order = { leader: 0, officer: 1, member: 2 };
  const people = [...r.people].sort((a, b) => order[a.role] - order[b.role] || a.username.localeCompare(b.username));
  const inviteUrl = `${location.origin}/join/${r.invite}`;
  box.classList.remove('muted');
  box.innerHTML = `
    <div class="row" style="font-size:13px"><span class="muted">Invite link:</span><input type="text" readonly value="${esc(inviteUrl)}" style="flex:1;min-width:220px" onclick="this.select()">
      <button class="btn sm" id="copyInv">Copy</button>${leader ? '<button class="btn sm ghost" id="newInv" title="The old link stops working">New link</button>' : ''}</div>
    <div class="muted" style="font-size:12px">Anyone who opens it can make an account and joins as a Member. People already in another guild must leave it first. ${leader ? 'Then set their role here.' : 'A guild leader sets roles.'}</div>
    <div class="table-wrap"><table class="t"><thead><tr><th>Account</th><th>Role</th><th>Roster name</th><th></th></tr></thead><tbody>
      ${people.map(p => { const m = mm[p.memberId]; const self = p.username === r.me;
        return `<tr><td><b>${esc(p.username)}</b>${self ? ' <span class="pill">you</span>' : ''}</td>
          <td>${leader ? `<select data-role="${esc(p.username)}">${Object.keys(ROLE_LABEL).map(k => `<option value="${k}" ${p.role === k ? 'selected' : ''}>${ROLE_LABEL[k]}</option>`).join('')}</select>` : ROLE_LABEL[p.role]}</td>
          <td><button class="btn sm ghost" data-link="${esc(p.username)}">${m ? `${esc(m.name)} · ${esc(pretty(m.job))}` : '<span style="color:var(--warn)">Link to roster…</span>'}</button></td>
          <td style="text-align:right">${self ? '<button class="btn sm ghost" id="leave">Leave guild</button>' : leader ? `<button class="btn sm ghost danger" data-rm="${esc(p.username)}">Remove</button>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>`;
  $('#copyInv', box).onclick = async () => { try { await navigator.clipboard.writeText(inviteUrl); toast('Invite link copied'); } catch { toast('Select the link and copy it'); } };
  if ($('#newInv', box)) $('#newInv', box).onclick = async () => { const x = await api('/api/guild/invite', 'POST'); toast(x.ok ? 'New invite link made. The old one no longer works.' : x.error); guildPanel(); };
  $$('[data-role]', box).forEach(s => (s.onchange = async () => {
    const x = await api('/api/guild/role', 'POST', { username: s.dataset.role, role: s.value });
    toast(x.ok ? `${s.dataset.role} is now ${ROLE_LABEL[s.value]}` : x.error);
    if (x.ok && s.dataset.role === r.me) return goHome();
    guildPanel();
  }));
  $$('[data-rm]', box).forEach(b => (b.onclick = async () => {
    if (!(await confirmBox(`Remove ${b.dataset.rm} from ${r.name}? Their account stays, but they lose access to this guild.`, 'Remove'))) return;
    const x = await api('/api/guild/remove', 'POST', { username: b.dataset.rm }); toast(x.ok ? 'Removed from the guild' : x.error); guildPanel();
  }));
  if ($('#leave', box)) $('#leave', box).onclick = async () => {
    if (!(await confirmBox(`Leave ${r.name}? You'll need a new invite link to come back.`, 'Leave'))) return;
    const x = await api('/api/guild/remove', 'POST', { username: r.me }); if (x.ok) goHome(); else toast(x.error);
  };
  $$('[data-link]', box).forEach(b => (b.onclick = () => {
    const p = r.people.find(x => x.username === b.dataset.link);
    openModal(`<h2>Roster name for ${esc(p.username)}</h2>
      <p class="muted" style="margin:0">Members see their own spots and can sign up for reservations under this name.</p>
      <label class="field">Member<input type="text" id="lk" value="${esc(mm[p.memberId]?.name || '')}" placeholder="Search the roster"></label>
      <div class="actions">${p.memberId ? '<button class="btn danger" id="unlk" style="margin-right:auto">Unlink</button>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" id="lkgo">Save</button></div>`,
    { onMount: (el, close) => {
      let picked = mm[p.memberId] || null;
      const lk = $('#lk', el);
      nameCombo(lk, memberComboItems(), (it) => { picked = mm[it.id]; });
      lk.addEventListener('input', () => { if (picked && lk.value.trim() !== picked.name) picked = null; });
      const save = async (memberId) => { const x = await api('/api/guild/link', 'POST', { username: p.username, memberId }); if (!x.ok) return toast(x.error); close(); guildPanel(); };
      $('#lkgo', el).onclick = () => { if (!picked) picked = rosterLookup()[normName(lk.value)] || null; if (!picked) return toast('Pick a member from the roster'); save(picked.id); };
      if ($('#unlk', el)) $('#unlk', el).onclick = () => save(null);
    } });
  }));
}
// Settings → Site: who may sign up, and links that let one person start a new guild.
async function sitePanel() {
  const box = $('#site'); if (!box) return;
  const r = await api('/api/site');
  if (!r.ok) { box.textContent = r.error || 'Could not load site settings.'; return; }
  box.classList.remove('muted');
  const url = (c) => `${location.origin}/start/${c}`;
  box.innerHTML = `<div class="muted" style="font-size:12px">${r.users} account(s) · ${r.guilds} guild(s)</div>
    <label class="check"><input type="checkbox" id="io" ${r.inviteOnly ? 'checked' : ''}> Invite only: people can only sign up with a guild invite link or a new-guild link</label>
    <div class="row"><b style="font-size:13px">New-guild links</b><span class="muted" style="font-size:12px">Each one lets one person start one guild. They expire after 7 days.</span><span class="grow"></span><button class="btn sm" id="mkStart">+ new-guild link</button></div>
    ${r.starts.map(st => `<div class="row" style="font-size:13px"><input type="text" readonly value="${esc(url(st.code))}" style="flex:1;min-width:220px" onclick="this.select()">
      <span class="muted" style="font-size:12px">until ${esc(new Date(st.exp).toLocaleDateString())}</span><button class="btn sm" data-cp="${esc(st.code)}">Copy</button><button class="btn sm ghost danger" data-rv="${esc(st.code)}">Cancel</button></div>`).join('') || '<div class="muted" style="font-size:12px">No open links.</div>'}
    <div class="row" style="margin-top:6px"><b style="font-size:13px">Accounts</b><span class="muted" style="font-size:12px">Deleting removes the login and its place in a guild. Guild data and roster names stay.</span></div>
    <div id="accounts" class="muted" style="font-size:13px">Loading…</div>`;
  accountsList();
  $('#io', box).onchange = async (e) => { const x = await api('/api/site', 'POST', { inviteOnly: e.target.checked }); toast(x.ok ? (e.target.checked ? 'Sign-up is now invite only' : 'Anyone can sign up and start a guild now') : x.error); sitePanel(); };
  $('#mkStart', box).onclick = async () => { const x = await api('/api/site/start', 'POST'); if (!x.ok) return toast(x.error); try { await navigator.clipboard.writeText(url(x.code)); toast('New-guild link copied'); } catch { toast('New-guild link made'); } sitePanel(); };
  $$('[data-cp]', box).forEach(b => (b.onclick = async () => { try { await navigator.clipboard.writeText(url(b.dataset.cp)); toast('Copied'); } catch { toast('Select the link and copy it'); } }));
  $$('[data-rv]', box).forEach(b => (b.onclick = async () => { await api('/api/site/start/revoke', 'POST', { code: b.dataset.rv }); sitePanel(); }));
}
async function accountsList() {
  const box = $('#accounts'); if (!box) return;
  const r = await api('/api/site/accounts');
  if (!r.ok) { box.textContent = r.error || 'Could not load accounts.'; return; }
  box.classList.remove('muted');
  const accounts = [...r.accounts].sort((a, b) => a.username.localeCompare(b.username));
  box.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr><th>Account</th><th>Guild</th><th>Role</th><th>Since</th><th></th></tr></thead><tbody>
    ${accounts.map(a => `<tr><td><b>${esc(a.username)}</b>${a.admin ? ' <span class="pill">admin</span>' : ''}${a.username === r.me ? ' <span class="pill">you</span>' : ''}</td>
      <td>${a.guild ? esc(a.guild) : '<span class="muted">none</span>'}</td><td>${a.role ? ROLE_LABEL[a.role] : '—'}</td>
      <td class="mono">${esc(String(a.createdAt || '').slice(0, 10))}</td>
      <td style="text-align:right">${a.username === r.me ? '' : `<button class="btn sm ghost danger" data-delacct="${esc(a.username)}">Delete</button>`}</td></tr>`).join('')}
  </tbody></table></div>`;
  $$('[data-delacct]', box).forEach(b => (b.onclick = async () => {
    const name = b.dataset.delacct;
    if (!(await confirmBox(`Delete the account “${name}”? They're logged out everywhere and can't log in again. Their guild's data and roster name stay.`, 'Delete account'))) return;
    const x = await api('/api/site/accounts/delete', 'POST', { username: name });
    if (!x.ok) return toast(x.error || 'Could not delete it', 4500);
    toast(`Deleted ${name}${x.emptied && x.emptied.length ? ` · ${x.emptied.join(', ')} now has no one in it` : ''}`, 4500);
    sitePanel(); guildPanel();
  }));
}
// My account: change password, or delete the account (needs the password).
function passwordDialog() {
  openModal(`<h2>My account</h2>
    <b style="font-size:13px">Change password</b>
    <label class="field">Current password<input type="password" id="cp" autocomplete="current-password"></label>
    <label class="field">New password (at least 8 characters)<input type="password" id="np1" autocomplete="new-password"></label>
    <label class="field">New password again<input type="password" id="np2" autocomplete="new-password"></label>
    <div class="muted" id="pmsg" style="font-size:13px"></div>
    <div class="row"><span class="grow"></span><button class="btn primary" id="pgo">Change password</button></div>
    <details style="border-top:1px solid var(--line);padding-top:10px"><summary style="cursor:pointer;color:var(--danger);font-size:13px">Delete my account</summary>
      <div style="display:grid;gap:8px;margin-top:8px">
        <div class="muted" style="font-size:12px">Your login is deleted and you're taken out of your guild. The guild's data and your roster name stay. A guild's only leader has to make someone else leader first.</div>
        <label class="field">Type your password to confirm<input type="password" id="dpw" autocomplete="current-password"></label>
        <div class="muted" id="dmsg" style="font-size:13px"></div>
        <div class="row"><span class="grow"></span><button class="btn danger" id="dgo">Delete my account</button></div>
      </div></details>
    <div class="actions"><button class="btn" data-close>Close</button></div>`,
  { onMount: (el, close) => {
    $('#pgo', el).onclick = async () => {
      if ($('#np1', el).value !== $('#np2', el).value) { $('#pmsg', el).textContent = 'The new passwords don’t match.'; return; }
      const x = await api('/api/password', 'POST', { current: $('#cp', el).value, next: $('#np1', el).value });
      if (!x.ok) { $('#pmsg', el).textContent = x.error || 'Could not change it'; return; }
      close(); toast('Password changed. Other devices were logged out.');
    };
    $('#dgo', el).onclick = async () => {
      const msg = $('#dmsg', el); msg.style.color = 'var(--danger)';
      const password = $('#dpw', el).value;
      if (!password) { msg.textContent = 'Type your password first.'; return; }
      // The confirm replaces this dialog, so errors after it show as a toast.
      if (!(await confirmBox('Delete your account for good? This can’t be undone.', 'Delete my account'))) return;
      const x = await api('/api/account/delete', 'POST', { password });
      if (!x.ok) { toast(x.error || 'Could not delete it', 5000); return; }
      goHome();
    };
  } });
}

// ---------- auction / reservation queues ----------
// Each category is a first-come queue. When an item drops, search it to see who's next.
const AUC_ALIAS = { rogue: 'rouge', rogues: 'rouge', rouges: 'rouge', orleans: 'orlean', drac: 'dracula', morriganes: 'morrigane', lvl: '', level: '', set: '' };
function aucTokens(s) {
  return String(s || '').toLowerCase().replace(/[’'`]/g, '')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2').replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean)
    .map(t => (t in AUC_ALIAS ? AUC_ALIAS[t] : t)).filter(Boolean);
}
function aucMatch(item, q) {
  const qt = aucTokens(q); if (!qt.length) return false;
  const it = aucTokens(item);
  return qt.every(t => it.some(x => x.startsWith(t) || (t.length > 3 && x.length > 3 && t.startsWith(x))));
}
function highlight(text, q) {
  const qt = aucTokens(q); let out = esc(text);
  qt.forEach(t => { if (t.length < 2) return; out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>'); });
  return out;
}
const normName = (s) => { const a = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); return a || String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); };
// The roster member a reservation belongs to, if any. Names not in the roster keep their Discord-style "@".
const aucMember = (e, mm = memberById(), idx = rosterLookup()) => (e.memberId && mm[e.memberId]) || idx[normName(e.name)] || null;
const atName = (e, mm, idx) => (aucMember(e, mm, idx) ? '' : '@') + e.name;
function rosterLookup() { const idx = {}; S.members.forEach(m => { const k = normName(m.name); if (k && !idx[k]) idx[k] = m; }); return idx; }
// Searchable name picker under a text input: type to filter, ↑↓ + Enter or click to pick.
// items: [{ label, sub, keys, ...anything }]; onPick gets the chosen item.
function nameCombo(input, items, onPick) {
  const box = document.createElement('div'); box.className = 'combo-list'; box.hidden = true;
  input.after(box); input.setAttribute('autocomplete', 'off');
  let rows = [], at = 0;
  const draw = () => {
    const q = input.value.trim().replace(/^@/, '').toLowerCase(), nq = normName(q);
    rows = items.filter(it => !q || it.keys.some(k => k.toLowerCase().includes(q) || (nq && normName(k).includes(nq)))).slice(0, 50);
    at = Math.min(at, Math.max(0, rows.length - 1));
    box.innerHTML = rows.map((it, i) => `<div class="combo-opt ${i === at ? 'on' : ''}" data-i="${i}"><b>${esc(it.label)}</b>${it.sub ? `<span class="muted">${esc(it.sub)}</span>` : ''}</div>`).join('')
      || '<div class="muted" style="padding:6px 10px">No one in the roster matches.</div>';
    box.hidden = false;
    const on = $('.combo-opt.on', box); if (on) on.scrollIntoView({ block: 'nearest' });
  };
  const pick = (it) => { input.value = it.label; box.hidden = true; onPick(it); };
  box.onmousedown = (e) => { e.preventDefault(); const o = e.target.closest('[data-i]'); if (o) pick(rows[+o.dataset.i]); };
  input.addEventListener('focus', draw);
  input.addEventListener('input', () => { at = 0; draw(); });
  input.addEventListener('blur', () => (box.hidden = true));
  input.addEventListener('keydown', (e) => {
    if (box.hidden && e.key === 'ArrowDown') { draw(); e.preventDefault(); return; }
    if (box.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { at = (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(1, rows.length); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && rows[at]) { pick(rows[at]); e.preventDefault(); }
    else if (e.key === 'Escape') { box.hidden = true; e.stopPropagation(); }
  });
}
const memberComboItems = () => [...S.members].sort((a, b) => (a.active === false) - (b.active === false) || a.name.localeCompare(b.name))
  .map(m => ({ id: m.id, label: m.name, sub: [pretty(m.job), m.active === false ? 'inactive' : ''].filter(Boolean).join(' · '), keys: [m.name, m.job || ''] }));

const aucWaiting = (cid) => S.auction.entries.filter(e => e.catId === cid && e.status === 'waiting').sort((a, b) => a.pos - b.pos);
const aucNextPos = (cid) => S.auction.entries.filter(e => e.catId === cid).reduce((m, e) => Math.max(m, e.pos), 0) + 1;
const cleanCatName = (s) => String(s).replace(/:\s*$/, '').replace(/\s*reservation list\s*$/i, '').trim() || 'Reservations';

// Parses the numbered Discord list: "1. Category", then "3. @Name : item" lines.
function parseAuctionText(text) {
  const rosterNames = S.members.map(m => m.name).filter(n => /\s/.test(n)).sort((a, b) => b.length - a.length);
  const cats = []; let cur = null, last = null; const skipped = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/["“”]/g, '').trim();
    if (!line) continue;
    line = line.replace(/^[-*•]\s*/, '');
    const stripped = line.replace(/^\d+\s*[.:)]\s*/, '').trim();
    const numbered = stripped !== line;
    if (stripped.includes('@')) {
      let rest = stripped.slice(stripped.indexOf('@') + 1).trim(); let name = '';
      for (const rn of rosterNames) { if (rest.toLowerCase().startsWith(rn.toLowerCase()) && /^([\s:]|$)/.test(rest.slice(rn.length))) { name = rest.slice(0, rn.length); break; } }
      if (!name) name = (rest.match(/^[^\s:]+/) || [''])[0];
      const item = rest.slice(name.length).replace(/^[\s:\-–—]+/, '').trim();
      if (!name) { skipped.push(raw.trim()); continue; }
      if (!cur) { cur = { name: 'Reservations', entries: [] }; cats.push(cur); }
      last = { name, item }; cur.entries.push(last);
    } else if (numbered || /:$/.test(stripped) || !last) {
      cur = { name: cleanCatName(stripped), entries: [] }; cats.push(cur); last = null;
    } else {
      last.item = last.item ? `${last.item} / ${stripped}` : stripped;
    }
  }
  return { cats: cats.filter(c => c.entries.length), skipped };
}

function aucDiscordText() {
  return S.auction.categories.map((c, ci) => {
    const rows = aucWaiting(c.id).map((e, i) => `   ${i + 1}. @${e.name}${e.item ? ` : ${e.item}` : ''}`);
    return [`${ci + 1}. ${c.name}`, ...(c.note ? [`   _${c.note}_`] : []), ...rows].join('\n');
  }).join('\n\n');
}

let aucCat = null, aucQ = '', aucHist = false;
routes.auction = (v) => {
  const A = S.auction;
  if (!A.categories.find(c => c.id === aucCat)) aucCat = A.categories[0]?.id || null;
  const cat = A.categories.find(c => c.id === aucCat);
  const list = cat ? aucWaiting(cat.id) : [];
  const idx = rosterLookup(); const mm = memberById(); const hasRoster = S.members.length > 0;
  const who = (e) => (e.memberId && mm[e.memberId]) || idx[normName(e.name)] || null;
  const totalWaiting = A.entries.filter(e => e.status === 'waiting').length;
  const given = A.entries.filter(e => e.status === 'given').sort((a, b) => String(b.givenAt).localeCompare(String(a.givenAt)));
  const hits = aucQ.trim() ? A.categories.flatMap(c => aucWaiting(c.id).map((e, i) => ({ e, i, c })).filter(x => aucMatch(x.e.item, aucQ))) : [];
  const counts = {}; list.forEach(e => { const k = normName(e.name); counts[k] = (counts[k] || 0) + 1; });
  const shareUrl = A.shareToken && mode === 'server' ? `${location.origin}/share/${A.shareToken}` : '';

  const nameHtml = (e) => { const m = who(e); return `<b>${m ? '' : '@'}${esc(e.name)}</b>${m ? `<span class="muted" style="font-size:12px">${esc(pretty(m.job))}</span>` : hasRoster ? '<span class="pill warn" title="No roster member with this name — Edit to link one">not in roster</span>' : ''}`; };

  v.innerHTML = `
    <div class="head"><div><h1>Auction</h1><div class="sub">${totalWaiting} reservations waiting · ${A.categories.length} lists · ${given.length} given out</div></div>
      <div class="row">
        <button class="btn" id="paste">Paste Discord list</button>
        <button class="btn" id="copy" ${A.categories.length ? '' : 'disabled'}>Copy for Discord</button>
        ${mode === 'server' ? `<button class="btn" id="share">${A.shareToken ? 'Share link…' : 'Create share link'}</button>` : ''}
        <button class="btn primary" id="add" ${A.categories.length ? '' : 'disabled'}>Add reservation</button></div></div>
    ${!A.categories.length ? `<div class="empty-state"><h3>No reservation lists yet</h3>Paste your list from Discord and it gets split into categories automatically, or start an empty list.
        <div class="row" style="justify-content:center;margin-top:14px"><button class="btn primary" id="paste2">Paste Discord list</button><button class="btn" id="newCat2">New empty list</button></div></div>` : `
    <div class="auc-top">
      <div class="card finder">
        <div class="row"><b>Item dropped?</b><span class="muted" style="font-size:13px">Type it to see who's next in line, across every list.</span></div>
        <input type="search" id="aq" placeholder="e.g. orc hero, dex 10, rouge, orlean gloves" value="${esc(aucQ)}">
        ${aucQ.trim() ? (hits.length ? hits.slice(0, 12).map((h, n) => `<div class="hit ${n === 0 ? 'first' : ''}">
            <span class="mono" style="width:22px;text-align:right;color:var(--ink-3)">${n + 1}</span>
            <div class="grow"><div class="q-name">${nameHtml(h.e)}</div><div class="q-item">${highlight(h.e.item, aucQ)}</div></div>
            <span class="where">#${h.i + 1} in ${esc(h.c.name)}</span><button class="btn sm ${n === 0 ? 'primary' : ''}" data-give="${h.e.id}">Give</button></div>`).join('')
          + (hits.length > 12 ? `<div class="muted" style="font-size:12px">+ ${hits.length - 12} more</div>` : '')
          : '<div class="muted" style="font-size:13px">Nobody has reserved that. Try fewer words, like just “orc” or “dex”.</div>') : ''}
      </div>
    </div>
    <div class="cat-tabs">
      ${A.categories.map(c => `<button class="ct ${c.id === aucCat ? 'on' : ''}" data-cat="${c.id}">${esc(c.name)}<span class="mono">${aucWaiting(c.id).length}</span></button>`).join('')}
      <button class="btn sm ghost" id="newCat">+ list</button>${cat ? '<button class="btn sm ghost" id="editCat">Edit list</button>' : ''}
    </div>
    ${cat?.note ? `<div class="cat-note">${esc(cat.note)}</div>` : ''}
    <div class="card">${list.map((e, i) => { const dup = counts[normName(e.name)];
      return `<div class="q-row"><span class="q-pos">${i + 1}</span>
        <div><div class="q-name">${nameHtml(e)}${dup > 1 ? `<span class="pill" title="This person has ${dup} spots in this list">×${dup}</span>` : ''}</div>
          ${e.item ? `<div class="q-item">${esc(e.item)}</div>` : ''}</div>
        <div class="q-act"><button class="icon-btn" data-up="${e.id}" title="Move up" ${i === 0 ? 'disabled' : ''}>▲</button><button class="icon-btn" data-down="${e.id}" title="Move down" ${i === list.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="btn sm" data-give="${e.id}">Give</button><button class="icon-btn" data-edit="${e.id}" title="Edit">⋯</button></div></div>`; }).join('')
      || '<div class="muted" style="padding:16px">This list is empty.</div>'}</div>
    ${shareUrl ? `<div class="row" style="margin-top:12px;font-size:13px"><span class="muted">${A.selfAdd ? 'Sign-up link' : 'Read-only link'} for the guild:</span><input type="text" readonly value="${esc(shareUrl)}" style="width:300px" onclick="this.select()"></div>` : ''}
    <div style="margin-top:22px">
      <button class="btn ghost" id="hist">${aucHist ? '▾' : '▸'} Given out (${given.length})</button>
      ${aucHist ? `<div class="table-wrap" style="margin-top:8px"><table class="t"><thead><tr><th>Date</th><th>Member</th><th>List</th><th>Got</th><th></th></tr></thead><tbody>
        ${given.map(e => `<tr><td class="mono">${esc(String(e.givenAt || '').slice(0, 10))}</td><td><b>${esc(atName(e, mm, idx))}</b></td><td>${esc(A.categories.find(c => c.id === e.catId)?.name || '—')}</td><td>${esc(e.givenNote || e.item)}</td>
          <td style="text-align:right"><button class="btn sm ghost" data-undo="${e.id}" title="Put back in the queue at their old spot">Undo</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing given out yet.</td></tr>'}
      </tbody></table></div>` : ''}
    </div>`}`;

  const byId = (id) => A.entries.find(e => e.id === id);
  ['#paste', '#paste2'].forEach(s => $(s) && ($(s).onclick = () => aucPasteDialog()));
  ['#newCat', '#newCat2'].forEach(s => $(s) && ($(s).onclick = () => aucCatDialog()));
  if ($('#editCat')) $('#editCat').onclick = () => aucCatDialog(cat);
  if ($('#add')) $('#add').onclick = () => aucEntryDialog(null, aucCat);
  if ($('#copy')) $('#copy').onclick = async () => { const t = aucDiscordText(); try { await navigator.clipboard.writeText(t); toast('Copied — paste it into Discord'); } catch { download('reservations.txt', t, 'text/plain'); } };
  if ($('#share')) $('#share').onclick = () => aucShareDialog();
  if ($('#aq')) $('#aq').oninput = debounce((e) => { aucQ = e.target.value; render(); setTimeout(() => { const q = $('#aq'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }); }, 150);
  $$('[data-cat]').forEach(b => (b.onclick = () => { aucCat = b.dataset.cat; render(); }));
  $$('[data-give]').forEach(b => (b.onclick = () => aucGiveDialog(byId(b.dataset.give))));
  $$('[data-edit]').forEach(b => (b.onclick = () => aucEntryDialog(byId(b.dataset.edit))));
  const move = (id, dir) => { const e = byId(id); const q = aucWaiting(e.catId); const i = q.indexOf(e); const o = q[i + dir]; if (!o) return; [e.pos, o.pos] = [o.pos, e.pos]; commit(); };
  $$('[data-up]').forEach(b => (b.onclick = () => move(b.dataset.up, -1)));
  $$('[data-down]').forEach(b => (b.onclick = () => move(b.dataset.down, 1)));
  if ($('#hist')) $('#hist').onclick = () => { aucHist = !aucHist; render(); };
  $$('[data-undo]').forEach(b => (b.onclick = () => { const e = byId(b.dataset.undo); e.status = 'waiting'; delete e.givenAt; delete e.givenNote; commit(); toast(`${atName(e)} is back in line`); }));
};

function aucGiveDialog(e) {
  const c = S.auction.categories.find(x => x.id === e.catId);
  openModal(`<h2>Give to ${esc(atName(e))}</h2>
    <div class="muted">${esc(c?.name || '')} · reserved: ${esc(e.item || '—')}</div>
    <label class="field">What they got<input type="text" id="gv" value="${esc(e.item)}"></label>
    <label class="check"><input type="checkbox" id="rq"> They still want more — add them again at the end of the list</label>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ok">Mark as given</button></div>`,
  { onMount: (el, close) => {
    $('#ok', el).onclick = () => {
      const now = new Date().toISOString();
      Object.assign(e, { status: 'given', givenAt: now, givenNote: $('#gv', el).value.trim() });
      if ($('#rq', el).checked) S.auction.entries.push({ id: uid('rs'), catId: e.catId, name: e.name, memberId: e.memberId || null, item: e.item, status: 'waiting', pos: aucNextPos(e.catId), addedAt: now });
      close(); commit(); toast(`Given to ${atName(e)}`);
    };
  } });
}

function aucEntryDialog(e, catId) {
  const A = S.auction; const isNew = !e;
  if (!S.members.length) {
    openModal(`<h2>No roster yet</h2><p class="muted" style="margin:0">Reservations are for members in your roster. Add or import members on the Roster page first.</p>
      <div class="actions"><button class="btn" data-close>Close</button><a class="btn primary" href="#/roster" data-close>Go to Roster</a></div>`);
    return;
  }
  const mm = memberById();
  // The roster member this reservation belongs to. An old entry whose name isn't in the roster starts with no one picked.
  let picked = e ? (e.memberId && mm[e.memberId]) || rosterLookup()[normName(e.name)] || null : null;
  openModal(`<h2>${isNew ? 'Add reservation' : 'Edit reservation'}</h2>
    <div class="form-grid">
      <label class="field">List<select id="ec">${A.categories.map(c => `<option value="${c.id}" ${(e ? e.catId : catId) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field">Member<input type="text" id="en" value="${esc(picked ? picked.name : '')}" placeholder="Search the roster"></label>
      <div id="elink" class="muted" style="grid-column:1/-1;font-size:12px;margin-top:-4px"></div>
      <label class="field" style="grid-column:1/-1">Wants<input type="text" id="ei" value="${esc(e?.item || '')}" placeholder="e.g. Rouge set lvl 90"></label>
    </div>
    <div class="actions">${isNew ? '' : '<button class="btn danger" id="del" style="margin-right:auto">Remove from list</button>'}<button class="btn" data-close>Cancel</button><button class="btn primary" id="sv">${isNew ? 'Add to end of list' : 'Save'}</button></div>`,
  { onMount: (el, close) => {
    const en = $('#en', el);
    const showPick = () => {
      if (picked && en.value.trim() !== picked.name) picked = null;
      $('#elink', el).innerHTML = picked ? `${esc(pretty(picked.job))}${picked.level ? ` · Lv ${esc(picked.level)}` : ''}${picked.active === false ? ' · inactive' : ''}`
        : e && !isNew && !en.value.trim() ? `<span style="color:var(--warn)">“${esc(e.name)}” isn't in the roster. Pick who this is.</span>` : '';
    };
    nameCombo(en, memberComboItems(), (it) => { picked = mm[it.id]; showPick(); $('#ei', el).focus(); });
    en.addEventListener('input', showPick); showPick();
    if (isNew) setTimeout(() => en.focus(), 0);
    $('#sv', el).onclick = () => {
      if (!picked) picked = rosterLookup()[normName(en.value)] || null;
      if (!picked) { toast('Pick a member from the roster'); en.focus(); return; }
      const name = picked.name, memberId = picked.id;
      const cid = $('#ec', el).value; const item = $('#ei', el).value.trim();
      if (isNew) A.entries.push({ id: uid('rs'), catId: cid, name, memberId, item, status: 'waiting', pos: aucNextPos(cid), addedAt: new Date().toISOString() });
      else { if (e.catId !== cid) e.pos = aucNextPos(cid); Object.assign(e, { catId: cid, name, item, memberId }); }
      aucCat = cid; close(); commit();
    };
    if (!isNew) $('#del', el).onclick = () => { A.entries = A.entries.filter(x => x !== e); close(); commit(); };
  } });
}

function aucCatDialog(c) {
  const A = S.auction;
  openModal(`<h2>${c ? 'Edit list' : 'New list'}</h2>
    <label class="field">Name<input type="text" id="cn" value="${esc(c?.name || '')}" placeholder="e.g. Relics"></label>
    <label class="field">Rules / note (optional, shows above the list and in the Discord copy)<input type="text" id="cnote" value="${esc(c?.note || '')}" placeholder="e.g. 1 spot per person, lvl 90 only"></label>
    ${c ? `<div class="row"><button class="btn sm" id="up">Move list left</button><button class="btn sm" id="clr">Empty this list</button></div>` : ''}
    <div class="actions">${c ? '<button class="btn danger" id="del" style="margin-right:auto">Delete list</button>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" id="sv">Save</button></div>`,
  { onMount: (el, close) => {
    $('#sv', el).onclick = () => {
      const name = $('#cn', el).value.trim() || 'Untitled list'; const note = $('#cnote', el).value.trim();
      if (c) Object.assign(c, { name, note }); else { const n = { id: uid('ac'), name, note }; A.categories.push(n); aucCat = n.id; }
      close(); commit();
    };
    if (c) {
      $('#up', el).onclick = () => { const i = A.categories.indexOf(c); if (i > 0) { A.categories.splice(i, 1); A.categories.splice(i - 1, 0, c); } close(); commit(); };
      $('#clr', el).onclick = async () => { close(); if (await confirmBox(`Remove everyone waiting in “${c.name}”? Given-out history stays.`, 'Empty list')) { A.entries = A.entries.filter(e => !(e.catId === c.id && e.status === 'waiting')); commit(); } };
      $('#del', el).onclick = async () => { close(); if (await confirmBox(`Delete “${c.name}” and all its reservations and history?`)) { A.categories = A.categories.filter(x => x !== c); A.entries = A.entries.filter(e => e.catId !== c.id); commit(); } };
    }
  } });
}

function aucPasteDialog() {
  openModal(`<h2>Paste Discord list</h2>
    <p class="muted" style="margin:0">Paste the whole message. Numbered headings like <span class="mono">1. Relics</span> become lists, and lines like <span class="mono">5. @Name : item</span> become reservations, kept in the same order.</p>
    <textarea id="pt" placeholder="1. Relics&#10;   1. @Someone : Vit 10 relic&#10;   2. @Another : int 10"></textarea>
    <div id="pv" style="font-size:13px"></div>
    <div class="row"><label class="check"><input type="radio" name="pm" value="replace" checked> Replace lists with the same name</label>
      <label class="check"><input type="radio" name="pm" value="append"> Add to the end of existing lists</label></div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go" disabled>Import</button></div>`,
  { wide: true, onMount: (el, close) => {
    let parsed = null;
    $('#pt', el).oninput = debounce(() => {
      parsed = parseAuctionText($('#pt', el).value);
      const n = parsed.cats.reduce((a, c) => a + c.entries.length, 0);
      $('#pv', el).innerHTML = parsed.cats.length
        ? `<b>${n} reservations in ${parsed.cats.length} lists:</b> ${parsed.cats.map(c => `${esc(c.name)} (${c.entries.length})`).join(' · ')}
           <div style="max-height:200px;overflow:auto;margin-top:6px" class="muted">${parsed.cats.map(c => `<div style="margin-top:6px;color:var(--ink)">${esc(c.name)}</div>${c.entries.map((e, i) => `<div>${i + 1}. <b style="color:var(--ink-2)">${esc(atName(e))}</b> — ${esc(e.item || '(no item)')}</div>`).join('')}`).join('')}</div>
           ${parsed.skipped.length ? `<div style="color:var(--warn);margin-top:6px">Skipped ${parsed.skipped.length} line(s): ${esc(parsed.skipped.join(' | '))}</div>` : ''}`
        : '<span class="muted">Nothing recognized yet.</span>';
      $('#go', el).disabled = !parsed.cats.length;
    }, 200);
    $('#go', el).onclick = () => {
      const A = S.auction; const how = $('input[name=pm]:checked', el).value; const now = new Date().toISOString(); let added = 0;
      parsed.cats.forEach(pc => {
        let c = A.categories.find(x => normName(x.name) === normName(pc.name));
        if (!c) { c = { id: uid('ac'), name: pc.name, note: '' }; A.categories.push(c); }
        else if (how === 'replace') A.entries = A.entries.filter(e => !(e.catId === c.id && e.status === 'waiting'));
        let pos = aucNextPos(c.id);
        pc.entries.forEach(pe => { A.entries.push({ id: uid('rs'), catId: c.id, name: pe.name, memberId: null, item: pe.item, status: 'waiting', pos: pos++, addedAt: now }); added++; });
        if (!aucCat) aucCat = c.id;
      });
      close(); commit(); toast(`Imported ${added} reservations`);
    };
  } });
}

function aucShareDialog() {
  const A = S.auction;
  openModal(`<h2>Share reservation lists</h2>
    <p class="muted" style="margin:0">Guildmates get a page with every list and the “who's next” search. It only works while your computer runs the server and they can reach it, so for most guilds “Copy for Discord” is the easier option.</p>
    <label class="check"><input type="checkbox" id="sa" ${A.selfAdd ? 'checked' : ''}> Let members add themselves: they pick their name from the roster, choose a list and say what they want. They join the end of the list and can't change anyone else's spot.</label>
    <div class="row">${A.shareToken ? '<button class="btn" id="new">Make a new link (old one stops working)</button><button class="btn danger" id="off">Turn off link</button>' : '<button class="btn primary" id="new">Create link</button>'}</div>
    <div class="actions"><button class="btn" data-close>Close</button></div>`,
  { onMount: (el, close) => {
    $('#sa', el).onchange = (ev) => { A.selfAdd = ev.target.checked; commit(); toast(A.selfAdd ? 'Members can now add themselves from the share link' : 'Self sign-up turned off'); };
    $('#new', el).onclick = () => { A.shareToken = 'a' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); close(); commit(); };
    if ($('#off', el)) $('#off', el).onclick = () => { A.shareToken = null; close(); commit(); };
  } });
}

// Public share link, or a logged-in member (opts.asName = their linked roster name).
// Everyone gets one spot per list. Logged-in members can also edit or remove their own spots (opts.edit / opts.remove).
function renderAuctionShare(v, d, opts = shareLinkOpts()) {
  const q = renderAuctionShare.q || '';
  const waiting = (cid) => d.auction.entries.filter(e => e.catId === cid).sort((a, b) => a.pos - b.pos);
  const hits = q.trim() ? d.auction.categories.flatMap(c => waiting(c.id).map((e, i) => ({ e, i, c })).filter(x => aucMatch(x.e.item, q))) : [];
  const A = d.auction; const member = opts.asName !== undefined; const linked = member && !!opts.asName;
  const canAdd = A.selfAdd && A.categories.length && (member ? linked : A.roster.length);
  let me = ''; try { me = (localStorage.getItem('ronw.me') ?? localStorage.getItem('muster.me')) || ''; } catch {}
  // Which lists a name already holds a spot in, and where: { catId: position }.
  const heldBy = (nm) => {
    const out = {}; const k = normName(nm); if (!member && !k) return out;
    A.categories.forEach(c => { const i = waiting(c.id).findIndex(e => (member ? e.mine : normName(e.name) === k)); if (i >= 0) out[c.id] = i + 1; });
    return out;
  };
  const listOptions = (held) => {
    const firstFree = A.categories.find(c => !held[c.id]);
    const want = held[renderAuctionShare.cat] ? firstFree?.id : (renderAuctionShare.cat || firstFree?.id);
    return A.categories.map(c => `<option value="${c.id}" ${held[c.id] ? 'disabled' : ''} ${c.id === want ? 'selected' : ''}>${esc(c.name)}${held[c.id] ? ` (you're #${held[c.id]})` : ''}</option>`).join('');
  };
  const startName = member ? opts.asName : (A.roster.find(n => normName(n) === normName(me)) || '');
  const held = heldBy(startName);
  const mine = member ? A.categories.flatMap(c => waiting(c.id).map((e, i) => ({ e, i, c })).filter(x => x.e.mine)) : [];
  const who = (e) => `${e.inRoster ? '' : '@'}${esc(e.name)}${e.mine ? ' <span class="pill">you</span>' : ''}`;
  v.innerHTML = `<div class="share-banner">${member ? '' : `Reservation lists from <b>${esc(d.guild.name)}</b>. `}${canAdd ? 'You can add yourself below, one spot per list. ' : ''}${member && !linked ? 'Ask an officer to link your account to your roster name so you can sign up. ' : ''}${linked && !A.selfAdd ? 'Signing yourself up is turned off by your officers. ' : ''}${linked ? 'You can edit or remove your own spots.' : 'Ask an officer to change or remove your spot.'}</div>
    <div class="head"><div><h1>Reservations</h1></div></div>
    ${mine.length ? `<div class="card finder" style="margin-bottom:16px"><b>Your spots</b>
      ${mine.map(x => `<div class="hit"><div class="grow"><div style="color:var(--ink)">${esc(x.e.item || '—')}</div></div><span class="where">#${x.i + 1} in ${esc(x.c.name)}</span>
        <button class="btn sm" data-myedit="${esc(x.e.id)}">Edit</button><button class="btn sm ghost danger" data-myrm="${esc(x.e.id)}">Remove</button></div>`).join('')}</div>` : ''}
    ${canAdd ? `<div class="card finder" style="margin-bottom:16px"><b>Reserve a spot${member ? ` as ${esc(opts.asName)}` : ''}</b>
      <div class="form-grid">
        ${member ? '' : `<label class="field">Your name<input type="text" id="rn" value="${esc(startName)}" placeholder="Search the roster"></label>`}
        <label class="field">List<select id="rc">${listOptions(held)}</select></label>
        <label class="field" style="grid-column:1/-1">Wants<input type="text" id="ri" maxlength="120" placeholder="e.g. Rouge set lvl 90"></label>
      </div>
      <div class="row"><button class="btn primary" id="rgo">Join the end of the list</button><span class="muted" id="rmsg" style="font-size:13px"></span></div></div>` : ''}
    <div class="card finder" style="margin-bottom:16px"><input type="search" id="sq" placeholder="Search an item or your name" value="${esc(q)}">
      ${q.trim() ? (hits.map((h, n) => `<div class="hit ${n === 0 ? 'first' : ''}"><div class="grow"><b>${who(h.e)}</b><div class="q-item">${highlight(h.e.item, q)}</div></div><span class="where">#${h.i + 1} in ${esc(h.c.name)}</span></div>`).join('')
        || d.auction.categories.flatMap(c => waiting(c.id).map((e, i) => ({ e, i, c })).filter(x => normName(x.e.name).includes(normName(q)))).map(h => `<div class="hit"><div class="grow"><b>${who(h.e)}</b><div class="q-item">${esc(h.e.item)}</div></div><span class="where">#${h.i + 1} in ${esc(h.c.name)}</span></div>`).join('')
        || '<div class="muted">No match.</div>') : ''}</div>
    <div class="grid-cards">${d.auction.categories.map(c => `<div class="card"><div style="padding:12px 12px 4px"><b style="font:600 16px var(--serif)">${esc(c.name)}</b>${c.note ? `<div class="cat-note" style="margin:4px 0 0">${esc(c.note)}</div>` : ''}</div>
      ${waiting(c.id).map((e, i) => `<div class="q-row ${e.mine ? 'mine' : ''}" style="grid-template-columns:28px 1fr"><span class="q-pos">${i + 1}</span><div><b>${who(e)}</b>${e.item ? `<div class="q-item">${esc(e.item)}</div>` : ''}</div></div>`).join('') || '<div class="muted" style="padding:12px">Empty</div>'}</div>`).join('')}</div>`;
  const redraw = async () => { const fresh = await opts.refresh(); if (fresh) renderAuctionShare(v, fresh, opts); };
  $('#sq').oninput = debounce((e) => { renderAuctionShare.q = e.target.value; renderAuctionShare(v, d, opts); const s = $('#sq'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 150);
  // Share link: the lists someone already holds depend on the name they pick.
  if (canAdd && !member) {
    const updateLists = () => { const nm = A.roster.find(n => normName(n) === normName($('#rn').value)) || ''; $('#rc').innerHTML = listOptions(heldBy(nm)); };
    nameCombo($('#rn'), A.roster.map(n => ({ label: n, keys: [n] })), () => { updateLists(); $('#ri').focus(); });
    $('#rn').addEventListener('input', updateLists);
  }
  if (canAdd) $('#rgo').onclick = async () => {
    const name = member ? opts.asName : A.roster.find(n => normName(n) === normName($('#rn').value)), sel = $('#rc'), catId = sel.value, item = $('#ri').value.trim(), msg = $('#rmsg');
    if (!name) { msg.textContent = 'Pick your name from the roster.'; $('#rn').focus(); return; }
    if (!catId || sel.selectedOptions[0]?.disabled) { msg.textContent = 'You already have a spot in every list.'; return; }
    if (!item) { msg.textContent = 'Say what you want.'; return; }
    $('#rgo').disabled = true; msg.textContent = 'Adding…';
    const j = await opts.reserve({ name, catId, item });
    if (!j.ok) { msg.textContent = j.error || 'Could not add you. Try again.'; $('#rgo').disabled = false; return; }
    if (!member) { try { localStorage.setItem('ronw.me', name); } catch {} }
    renderAuctionShare.cat = catId; if (!member) renderAuctionShare.q = name;
    await redraw();
    toast(`You're #${j.place} in ${A.categories.find(c => c.id === catId).name}`, 4000);
  };
  // Your spots: edit what you want, or give the spot up.
  $$('[data-myedit]', v).forEach(b => (b.onclick = () => {
    const x = mine.find(m => m.e.id === b.dataset.myedit);
    openModal(`<h2>Edit your spot</h2><div class="muted">#${x.i + 1} in ${esc(x.c.name)}. Your place in line stays the same.</div>
      <label class="field">Wants<input type="text" id="myItem" maxlength="120" value="${esc(x.e.item || '')}"></label>
      <div class="muted" id="myMsg" style="font-size:13px"></div>
      <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="mySave">Save</button></div>`,
    { onMount: (el, close) => {
      const save = async () => {
        const item = $('#myItem', el).value.trim(); if (!item) { $('#myMsg', el).textContent = 'Say what you want.'; return; }
        const r = await opts.edit(x.e.id, item);
        if (!r.ok) { $('#myMsg', el).textContent = r.error || 'Could not save it.'; return; }
        close(); toast('Spot updated'); redraw();
      };
      $('#mySave', el).onclick = save; $('#myItem', el).onkeydown = (e) => { if (e.key === 'Enter') save(); };
      setTimeout(() => $('#myItem', el).select(), 0);
    } });
  }));
  $$('[data-myrm]', v).forEach(b => (b.onclick = async () => {
    const x = mine.find(m => m.e.id === b.dataset.myrm);
    if (!(await confirmBox(`Give up your spot #${x.i + 1} in ${x.c.name}? If you join again later, you go to the end of the line.`, 'Remove my spot'))) return;
    const r = await opts.remove(x.e.id);
    if (!r.ok) return toast(r.error || 'Could not remove it.', 4000);
    toast('Spot removed'); redraw();
  }));
}
function shareLinkOpts() {
  const t = encodeURIComponent(window.RONW_SHARE);
  return { reserve: (b) => api(`/api/share/${t}/reserve`, 'POST', b), refresh: async () => { const r = await api(`/api/share/${t}`); return r.ok ? r : null; } };
}

// ---------- member view (logged in, role Member) ----------
async function bootMember() {
  document.body.classList.add('share');
  const v = $('#view');
  const d = await api('/api/member/view');
  if (!d.ok) { v.innerHTML = `<div class="empty-state"><h3>Could not load your guild</h3>${esc(d.error || '')}</div>`; return; }
  const draw = (data) => {
    const [tab, id] = location.hash.replace(/^#\/?/, '').split('/');
    v.innerHTML = `<div class="member-bar card">${userBox()}<span class="grow"></span>
        <nav class="seg"><a href="#/lineups" class="${tab !== 'reservations' ? 'on' : ''}">Lineups</a><a href="#/reservations" class="${tab === 'reservations' ? 'on' : ''}">Reservations</a></nav>
        <button class="btn sm ghost" id="myPw">My account</button></div>
      <div id="mview"></div>`;
    $('#logout', v).onclick = logout; $('#guildMenu', v).onclick = guildMenuDialog; $('#myPw', v).onclick = passwordDialog;
    const mv = $('#mview', v);
    document.title = `${data.guild.name} · RONW Planner`;
    if (tab === 'reservations') {
      return renderAuctionShare(mv, data, { asName: data.me ? data.me.name : null,
        reserve: (b) => api('/api/member/reserve', 'POST', { catId: b.catId, item: b.item }),
        edit: (id, item) => api('/api/member/reserve/edit', 'POST', { id, item }),
        remove: (id) => api('/api/member/reserve/remove', 'POST', { id }),
        refresh: async () => { const r = await api('/api/member/view'); return r.ok ? r : null; } });
    }
    const ev = id && data.events.find(e => e.id === id);
    if (ev) {
      const mm = Object.fromEntries(data.members.map(m => [m.id, m]));
      S.partySize = ev.fields[0]?.parties[0]?.slots.length || 5;
      renderBoard(mv, ev, true, { mm, roleOf: (m) => (m && data.roles[m.job]) || 'dps', guild: data.guild.name, mode: null, banner: 'Read-only lineup.' });
      mv.insertAdjacentHTML('afterbegin', '<a class="btn sm ghost" href="#/lineups" style="margin-bottom:10px">← All lineups</a>');
      return;
    }
    const mine = (e) => data.me && e.fields.some(f => f.parties.some(p => p.slots.includes(data.me.id)));
    const events = [...data.events].sort((a, b) => String(b.when || b.createdAt).localeCompare(String(a.when || a.createdAt)));
    mv.innerHTML = `<div class="head"><div><h1>Lineups</h1><div class="sub">${data.me ? `You're <b>${esc(data.me.name)}</b> · ${esc(pretty(data.me.job))}` : 'Ask an officer to link your account to your roster name so your spots are highlighted.'}</div></div></div>
      ${events.length ? `<div class="grid-cards">${events.map(e => `<a class="card pad" href="#/lineups/${e.id}" style="text-decoration:none;display:grid;gap:4px">
          <b style="font:600 16px var(--serif)">${esc(e.title)}</b><span class="muted" style="font-size:12px">${esc(e.when || '')}</span>
          ${mine(e) ? '<span class="pill done" style="justify-self:start">You’re in this</span>' : ''}</a>`).join('')}</div>`
        : '<div class="empty-state"><h3>No lineups yet</h3>Your officers haven’t made any events.</div>'}`;
  };
  draw(d);
  window.onhashchange = async () => { const r = await api('/api/member/view'); draw(r.ok ? r : d); };
  startLive('/api/live', () => whenIdle(async () => { const r = await api('/api/member/view'); if (r.ok) draw(r); }));
}

// ---------- share view ----------
async function bootShare(token) {
  document.body.classList.add('share');
  const t = encodeURIComponent(token);
  const show = (d) => {
    if (d.auction) { document.title = `Reservations · ${d.guild.name}`; return renderAuctionShare($('#view'), d); }
    const mm = Object.fromEntries(d.members.map(m => [m.id, m]));
    const rf = (m) => (m && d.roles[m.job]) || 'dps';
    document.title = `${d.event.title} · ${d.guild.name}`;
    S.partySize = d.event.fields[0]?.parties[0]?.slots.length || 5;
    renderBoard($('#view'), d.event, true, { mm, roleOf: rf, guild: d.guild.name, mode: null });
  };
  try {
    const r = await fetch(`/api/share/${t}`); if (!r.ok) throw 0;
    show(await r.json());
    startLive(`/api/share/${t}/live`, () => whenIdle(async () => { const x = await fetch(`/api/share/${t}`, { cache: 'no-store' }); if (x.ok) show(await x.json()); }));
  } catch { $('#view').innerHTML = '<div class="empty-state"><h3>This link isn\'t available</h3>It may have been turned off, or the organizer\'s computer is offline.</div>'; }
}

// ---------- boot ----------
(async () => {
  if (window.RONW_SHARE) return bootShare(window.RONW_SHARE);
  if (!(await load())) return;
  appReady = true;
  render();
  if (mode === 'server') {
    startLive('/api/live', (d) => { if (d.rev > rev) whenIdle(refreshFromServer); });
    setInterval(() => { if (!document.hidden) whenIdle(refreshFromServer); }, 60000);
  }
})();
})();
