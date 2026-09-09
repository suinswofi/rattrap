// Bouncer renderer. Talks to the main process only through window.bouncer (see preload.cjs).
'use strict';

const $ = s => document.querySelector(s);
const api = window.bouncer;

const state = {
  rooms: [], current: null, snap: null, config: null,
  tab: 'users', sort: { key: 'firstSeen', dir: 1 }, search: '', presentOnly: false, showChat: false,
  logs: new Map(), chats: new Map(), detailUser: null, refreshTimer: null,
};

// ---------- formatting ----------
const pad2 = n => String(n).padStart(2, '0');
const fmtTime = ts => { if (ts == null) return '–'; const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const fmtDate = ts => { if (ts == null) return '–'; const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const fmtDateTime = ts => ts == null ? '–' : `${fmtDate(ts)} ${fmtTime(ts)}`;
const dur = ms => { if (ms == null) return '–'; const s = Math.floor(ms / 1000); if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`; return `${Math.floor(s / 3600)}h${pad2(Math.floor(s / 60) % 60)}m`; };
const num = n => n == null ? '–' : Number(n).toLocaleString();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flagClass = f => f.startsWith('BL:') || f.startsWith('NOW:') ? 'bl' : esc(f);
const scoreClass = s => s >= (state.config?.burnerAlertScore ?? 6) ? 'high' : s >= 3 ? 'mid' : '';
const reasonClass = r => /blacklisted|right now|previously named|no followers|only \d+ followers/.test(r) ? 'strong' : /private|username|nickname|follows nobody/.test(r) ? 'profile' : '';

function toast(title, text, kind = '', ttl = 8000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(text)}</span>`;
  el.onclick = () => el.remove();
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ttl);
}

// ---------- sidebar ----------
function renderRooms() {
  const ul = $('#room-list');
  ul.innerHTML = state.rooms.map(r => `
    <li data-room="${esc(r.room)}" class="${r.room === state.current ? 'active' : ''}">
      <span class="dot ${esc(r.state)}" title="${esc(r.message ?? '')}"></span>
      <span class="name">@${esc(r.room)}</span>
      ${r.flagged ? `<span class="badge" title="flagged accounts">${r.flagged}</span>` : ''}
      <span class="sub">${r.present}/${r.seen}</span>
    </li>`).join('');
  $('#empty').hidden = state.rooms.length > 0;
}

const roomLists = room => state.config?.lists?.[room] ?? { watch: [], blacklist: [] };

function renderLists() {
  const l = roomLists(state.current);
  const chips = (list, name) => list.map(n => `<li><span class="name">@${esc(n)}</span><button class="x" data-list="${name}" data-name="${esc(n)}" title="remove">×</button></li>`).join('');
  $('#blacklist').innerHTML = chips(l.blacklist, 'blacklist') || (state.current ? '' : '<li class="sub">select a room</li>');
  $('#watchlist').innerHTML = chips(l.watch, 'watch') || (state.current ? '' : '<li class="sub">select a room</li>');
  for (const id of ['#blacklist-room', '#watchlist-room']) $(id).textContent = state.current ? `· @${state.current}` : '';
  for (const f of ['#add-blacklist', '#add-watch']) for (const el of $(f).elements) el.disabled = !state.current;
}

// ---------- header ----------
function renderHeader() {
  const s = state.snap;
  const r = state.rooms.find(x => x.room === state.current);
  $('#room-name').textContent = state.current ? `@${state.current}` : 'No room';
  const st = $('#room-status');
  st.className = `status ${s?.state ?? r?.state ?? ''}`;
  st.textContent = s?.state ?? r?.state ?? '';
  st.title = s?.stateMessage ?? '';
  const parts = [];
  if (s) {
    if (s.viewers != null) parts.push(`<span><b>${num(s.viewers)}</b> viewers</span>`);
    parts.push(`<span><b>${s.counts.present}</b> present</span>`, `<span><b>${s.counts.seen}</b> seen today</span>`, `<span><b>${s.counts.known}</b> ever</span>`);
    if (s.counts.flagged) parts.push(`<span><b class="hot">${s.counts.flagged}</b> flagged</span>`);
    if (s.likes != null) parts.push(`<span><b>${num(s.likes)}</b> likes</span>`);
    if (s.uptime) parts.push(`<span>up <b>${dur(s.uptime)}</b></span>`);
    if (s.title) parts.push(`<span class="title" title="${esc(s.title)}">“${esc(s.title)}”</span>`);
  }
  $('#room-meta').innerHTML = parts.join('');
  for (const id of ['#btn-save', '#btn-reconnect', '#btn-remove']) $(id).disabled = !state.current;
  $('#count-users').textContent = s ? s.counts.seen : '';
  const sus = s ? s.users.filter(u => u.score >= (state.config?.burnerAlertScore ?? 6)).length : 0;
  const c = $('#count-suspects'); c.textContent = s ? sus : ''; c.className = `count ${sus ? 'hot' : ''}`;
}

// ---------- users table ----------
const COLUMNS = [
  { key: 'username', label: 'User', render: u => `${esc(u.username)}${u.nickname && u.nickname !== u.username ? `<span class="nick">${esc(u.nickname)}</span>` : ''}`, cls: 'user' },
  { key: 'present', label: 'Here', render: u => `<span class="here ${u.present ? 'yes' : ''}" title="${u.present ? 'believed present' : 'gone'}"></span>` },
  { key: 'score', label: 'Score', num: true, render: u => `<span class="score ${scoreClass(u.score)}" title="${esc(u.reasons.join('; ') || 'nothing suspicious')}">${u.score}</span>` },
  { key: 'joins', label: 'Joins', num: true, render: u => u.joins },
  { key: 'chats', label: 'Chats', num: true, render: u => u.chats },
  { key: 'likes', label: 'Likes', num: true, render: u => u.likes },
  { key: 'coins', label: 'Coins', num: true, render: u => u.coins },
  { key: 'firstSeen', label: 'First', render: u => fmtTime(u.firstSeen) },
  { key: 'lastSeen', label: 'Last', render: u => fmtTime(u.lastSeen) },
  { key: 'timeInRoom', label: 'In room', num: true, render: u => dur(u.timeInRoom) },
  { key: 'daysSeen', label: 'Days', num: true, render: u => u.daysSeen },
  { key: 'firstSeenEver', label: 'First ever', render: u => fmtDate(u.firstSeenEver) },
  { key: 'followers', label: 'Flw / ing', num: true, render: u => u.followers == null ? '–' : `${num(u.followers)} / ${num(u.following)}` },
  { key: 'flags', label: 'Flags', render: u => u.flags.map(f => `<span class="flag ${flagClass(f)}">${esc(f)}</span>`).join('') },
];

function sortedUsers() {
  const q = state.search.trim().toLowerCase();
  let list = state.snap?.users ?? [];
  if (state.presentOnly) list = list.filter(u => u.present);
  if (q) list = list.filter(u => u.username.toLowerCase().includes(q) || (u.nickname ?? '').toLowerCase().includes(q));
  const { key, dir } = state.sort;
  const val = u => key === 'flags' ? u.flags.length : key === 'present' ? (u.present ? 1 : 0) : u[key];
  return [...list].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
}

function renderTable() {
  const thead = $('#users-table thead');
  thead.innerHTML = `<tr>${COLUMNS.map(c => `<th data-key="${c.key}" class="${c.num ? 'num' : ''} ${state.sort.key === c.key ? 'sorted' : ''}">${c.label}${state.sort.key === c.key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>`;
  const rows = sortedUsers();
  $('#users-table tbody').innerHTML = rows.map(u => `<tr data-user="${esc(u.username)}" class="${u.present ? '' : 'gone'} ${u.username === state.detailUser ? 'selected' : ''}">${COLUMNS.map(c => `<td class="${c.cls ?? ''} ${c.num ? 'num' : ''}">${c.render(u)}</td>`).join('')}</tr>`).join('')
    || `<tr><td colspan="${COLUMNS.length}" class="note">${!state.snap ? 'loading…' : state.snap.users.length ? 'nobody matches' : state.snap.state === 'live' ? 'connected, waiting for viewers…' : 'no viewers seen yet today'}</td></tr>`;
}

function renderSuspects() {
  const q = state.search.trim().toLowerCase();
  const list = (state.snap?.users ?? []).filter(u => u.score > 0 && (!q || u.username.toLowerCase().includes(q) || (u.nickname ?? '').toLowerCase().includes(q)))
    .sort((a, b) => b.score - a.score).slice(0, 200);
  $('#suspects-list').innerHTML = list.map(u => `
    <div class="card" data-user="${esc(u.username)}">
      <span class="score ${scoreClass(u.score)}">${u.score}</span>
      <div class="who">${esc(u.username)}${u.nickname && u.nickname !== u.username ? `<span class="nick">${esc(u.nickname)}</span>` : ''}
        ${u.flags.map(f => `<span class="flag ${flagClass(f)}">${esc(f)}</span>`).join('')}</div>
      <div class="reasons">${u.reasons.map(r => `<span class="reason ${reasonClass(r)}">${esc(r)}</span>`).join('')}</div>
    </div>`).join('') || '<p class="note">Nobody scored above 0.</p>';
}

// ---------- chat & log ----------
const nearBottom = el => el.scrollHeight - el.scrollTop - el.clientHeight < 40;
const lineHtml = e => `<div class="line ${esc(e.kind)} ${e.watched ? 'watched' : ''} ${e.backlog ? 'backlog' : ''}"><span class="t">${fmtTime(e.t)}</span><span class="k">${esc(e.kind)}</span>${e.user ? `<span class="u" data-user="${esc(e.user)}">${esc(e.user)}</span>` : ''}<span class="m">${esc(e.text)}</span></div>`;
const chatHtml = c => `<div class="line chat"><span class="t">${fmtTime(c.t)}</span><span class="u" data-user="${esc(c.user)}">${esc(c.nickname && c.nickname !== c.user ? `${c.nickname} (${c.user})` : c.user)}</span><span class="m">${esc(c.text)}</span></div>`;

function renderLog() {
  const el = $('#log-list'); const stick = nearBottom(el);
  const lines = (state.logs.get(state.current) ?? []).filter(e => state.showChat || e.kind !== 'chat');
  el.innerHTML = lines.slice(-1000).map(lineHtml).join('') || '<p class="note">Nothing yet.</p>';
  if (stick) el.scrollTop = el.scrollHeight;
}
function renderChat() {
  const el = $('#chat-list'); const stick = nearBottom(el);
  const q = state.search.trim().toLowerCase();
  const lines = (state.chats.get(state.current) ?? []).filter(c => !q || c.user.toLowerCase().includes(q) || c.text.toLowerCase().includes(q));
  el.innerHTML = lines.slice(-500).map(chatHtml).join('') || '<p class="note">No chat yet.</p>';
  if (stick) el.scrollTop = el.scrollHeight;
}
function appendLine(room, entry) {
  if (!state.logs.has(room)) state.logs.set(room, []);
  const arr = state.logs.get(room); arr.push(entry); if (arr.length > 2000) arr.splice(0, arr.length - 2000);
  if (entry.kind === 'chat') {
    if (!state.chats.has(room)) state.chats.set(room, []);
    const ch = state.chats.get(room); ch.push({ t: entry.t, user: entry.user, nickname: entry.nickname, text: entry.text }); if (ch.length > 1000) ch.shift();
  }
  if (room !== state.current) return;
  if (state.tab === 'log' && (state.showChat || entry.kind !== 'chat')) {
    const el = $('#log-list'); const stick = nearBottom(el);
    if (el.firstElementChild?.classList.contains('note')) el.innerHTML = '';
    el.insertAdjacentHTML('beforeend', lineHtml(entry)); if (stick) el.scrollTop = el.scrollHeight;
  }
  if (state.tab === 'chat' && entry.kind === 'chat') renderChat();
}

// ---------- detail drawer ----------
async function openDetail(username) {
  if (!state.current || !username) return;
  state.detailUser = username;
  $('#detail').hidden = false;
  await renderDetail();
  renderTable();
}
function closeDetail() { state.detailUser = null; $('#detail').hidden = true; renderTable(); }

async function renderDetail() {
  if (!state.detailUser || !state.current) return;
  let d;
  try { d = await api.detail(state.current, state.detailUser); } catch { d = null; }
  $('#detail-name').textContent = `@${state.detailUser}`;
  if (!d) { $('#detail-nick').textContent = ''; $('#detail-body').innerHTML = '<p class="note">Not found.</p>'; return; }
  $('#detail-nick').textContent = d.nickname && d.nickname !== d.username ? d.nickname : '';
  const t = d.today, h = d.history, p = { ...(h?.profile ?? {}) };
  if (t) for (const k of ['followers', 'following', 'verified', 'privateAccount', 'gifterLevel']) if (t[k] != null) p[k] = t[k];
  const yn = v => v == null ? '–' : v ? 'yes' : 'no';
  const kv = pairs => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const watched = roomLists(state.current).watch.includes(d.username);
  const score = t ? `<div class="scorebox"><span class="score ${scoreClass(t.score)}">${t.score}</span><div class="reasons">${t.reasons.length ? t.reasons.map(r => `<span class="reason ${reasonClass(r)}">${esc(r)}</span>`).join('') : '<span class="none">nothing suspicious</span>'}</div></div>`
    : '<p class="note">Not seen today, so no score. Showing history only.</p>';
  const parts = [
    score,
    `<div class="actions"><button class="btn" id="d-watch">${watched ? 'Unwatch' : 'Watch'}</button><button class="btn" id="d-open">Open on TikTok</button></div>`,
    '<h4>Profile (as reported by TikTok)</h4>',
    kv([
      ['followers', num(p.followers)], ['following', num(p.following)],
      ['verified', yn(p.verified)], ['private', yn(p.privateAccount)], ['gifter level', p.gifterLevel ?? '–'],
      ['follows this host', yn(t?.isFollower ?? h?.isFollower)], ['user id', esc(t?.userId ?? '–')],
    ]),
  ];
  if (t) parts.push('<h4>Today</h4>', kv([
    ['status', t.present ? 'in the room' : `gone${t.leftHow ? ` (${t.leftHow})` : ''}`], ['first seen', fmtTime(t.firstSeen)], ['last seen', fmtTime(t.lastSeen)],
    ['time in room', dur(t.timeInRoom)], ['joins', t.joins], ['chats', t.chats], ['likes', t.likes], ['gifts', `${t.gifts} (${t.coins} coins)`], ['shares', t.shares],
    ['flags', t.flags.map(f => `<span class="flag ${flagClass(f)}">${esc(f)}</span>`).join('') || '–'],
  ]));
  if (h) parts.push('<h4>History in this room</h4>', kv([
    ['first seen ever', fmtDateTime(h.firstSeenEver)], ['last seen ever', fmtDateTime(h.lastSeenEver)],
    ['days seen', `${h.daysSeen}${h.dates.length ? ` (${h.dates.slice(-6).join(', ')}${h.dates.length > 6 ? ', …' : ''})` : ''}`],
    ['totals', `${h.totals.joins} joins, ${h.totals.chats} chats, ${h.totals.likes} likes, ${h.totals.gifts} gifts (${h.totals.coins} coins), ${dur(h.totals.presentMs)} in room`],
    ['previous names', h.aliases.length ? h.aliases.map(a => '@' + esc(a)).join(', ') : '–'],
    ['previous nicknames', h.nicknames.length ? esc(h.nicknames.join(', ')) : '–'],
  ]));
  parts.push('<h4>Other monitored rooms</h4>', d.rooms.length
    ? `<ul class="rooms-list">${d.rooms.map(r => `<li class="${r.blacklisted ? 'bl' : ''}">@${esc(r.room)}${r.blacklisted ? ' <span class="flag bl">blacklisted</span>' : ''}${r.presentNow ? ' <span class="flag bl">in the room right now</span>' : ''}: <span class="${r.follows === true ? 'follows' : 'nofollow'}">${r.follows === true ? 'FOLLOWS host' : r.follows === false ? 'does not follow host' : 'follow status unknown'}</span>, seen ${r.daysSeen} day${r.daysSeen === 1 ? '' : 's'}, last ${fmtDate(r.lastSeen)}${r.username !== d.username ? ` (as @${esc(r.username)})` : ''}</li>`).join('')}</ul>`
    : `<p class="note">Not seen in any other monitored room${state.snap?.otherRooms?.length ? '' : ' (no other room histories yet)'}.</p>`);
  if (d.chat.length) parts.push(`<h4>Recent chat (${d.chat.length})</h4>`, `<div class="chatlog">${d.chat.map(c => `<div class="line"><span class="t">${fmtTime(c.t)}</span><span class="m">${esc(c.text)}</span></div>`).join('')}</div>`);
  $('#detail-body').innerHTML = parts.join('');
  $('#d-watch').onclick = async () => { await api.editList(state.current, 'watch', watched ? 'remove' : 'add', [d.username]); await loadConfig(); renderDetail(); };
  $('#d-open').onclick = () => api.openExternal(`https://www.tiktok.com/@${encodeURIComponent(d.username)}`);
}

// ---------- data loading ----------
async function loadConfig() { state.config = await api.getConfig(); renderLists(); }

async function refreshRooms() {
  state.rooms = await api.rooms();
  if (state.current && !state.rooms.some(r => r.room === state.current)) state.current = null;
  if (!state.current && state.rooms.length) await selectRoom(state.rooms[0].room);
  renderRooms(); renderHeader();
}

async function refreshSnapshot() {
  if (!state.current) { state.snap = null; renderHeader(); renderTable(); return; }
  try { state.snap = await api.snapshot(state.current); } catch { state.snap = null; }
  renderHeader();
  if (state.tab === 'users') renderTable();
  if (state.tab === 'suspects') renderSuspects();
  if (state.detailUser && !$('#detail').hidden) renderDetail();
}

async function selectRoom(room) {
  state.current = room;
  closeDetail();
  if (!state.logs.has(room)) { try { state.logs.set(room, await api.log(room)); } catch { state.logs.set(room, []); } }
  if (!state.chats.has(room)) { try { state.chats.set(room, await api.chat(room)); } catch { state.chats.set(room, []); } }
  renderRooms(); renderLists();
  await refreshSnapshot();
  renderLog(); renderChat();
}

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tab-btn')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== `tab-${tab}`;
  $('#logchat-wrap').hidden = tab !== 'log';
  $('#present-wrap').hidden = tab !== 'users';
  if (tab === 'users') renderTable(); if (tab === 'suspects') renderSuspects(); if (tab === 'log') renderLog(); if (tab === 'chat') renderChat();
}

const scheduleRefresh = () => { if (state.refreshTimer) return; state.refreshTimer = setTimeout(() => { state.refreshTimer = null; refreshSnapshot(); }, 300); };

// ---------- events from main ----------
api.onEvent(ev => {
  switch (ev.type) {
    case 'log':
      if (ev.room) appendLine(ev.room, ev.entry);
      if (ev.entry.kind === 'error') toast(ev.room ? `@${ev.room}` : 'Bouncer', ev.entry.text, 'error');
      else if (ev.entry.watched && ['join', 'rejoin', 'chat', 'gift', 'follow', 'share'].includes(ev.entry.kind)) toast(`★ @${ev.entry.user} in @${ev.room}`, `${ev.entry.kind}: ${ev.entry.text}`);
      break;
    case 'flag':
      toast(`⚑ @${ev.user} in @${ev.room} — score ${ev.score}`, ev.reasons.join('; '), 'flag', 12000);
      if (ev.room === state.current) scheduleRefresh();
      break;
    case 'status': case 'rooms':
      state.rooms = ev.rooms ?? state.rooms; renderRooms(); renderHeader();
      if (ev.type === 'status' && ev.room === state.current) scheduleRefresh();
      if (!state.current && state.rooms.length) selectRoom(state.rooms[0].room);
      break;
    case 'users': if (ev.room === state.current) scheduleRefresh(); break;
    case 'lists': state.config = { ...state.config, lists: { ...(state.config?.lists ?? {}), [ev.room]: { watch: ev.watch, blacklist: ev.blacklist } } }; renderLists(); scheduleRefresh(); break;
    case 'saved': if (ev.room === state.current) toast(`@${ev.room} saved`, `${ev.count} users written to today's snapshot and the room history`, 'ok', 4000); break;
  }
});

// ---------- UI wiring ----------
$('#room-list').addEventListener('click', e => { const li = e.target.closest('li[data-room]'); if (li) selectRoom(li.dataset.room); });
$('#add-room').addEventListener('submit', async e => {
  e.preventDefault(); const input = e.target.querySelector('input'); const name = input.value.trim(); if (!name) return;
  try { const r = await api.addRoom(name); input.value = ''; await refreshRooms(); await selectRoom(r.room); }
  catch (err) { toast('Could not add room', err.message, 'error'); }
});
for (const [form, list] of [['#add-blacklist', 'blacklist'], ['#add-watch', 'watch']]) {
  $(form).addEventListener('submit', async e => {
    e.preventDefault(); const input = e.target.querySelector('input'); const name = input.value.trim(); if (!name || !state.current) return;
    try { await api.editList(state.current, list, 'add', [name]); input.value = ''; await loadConfig(); scheduleRefresh(); }
    catch (err) { toast('Could not update list', err.message, 'error'); }
    if (list === 'blacklist' && !state.rooms.some(r => r.room === name.replace(/^@/, '').toLowerCase())) toast('Blacklisted', `Add @${name.replace(/^@/, '')} as a room too, so Bouncer can record who follows them.`, '', 10000);
  });
}
document.addEventListener('click', async e => {
  const x = e.target.closest('button.x[data-list]');
  if (x) { await api.editList(state.current, x.dataset.list, 'remove', [x.dataset.name]); await loadConfig(); scheduleRefresh(); return; }
  const row = e.target.closest('[data-user]');
  if (row && !e.target.closest('.side-list')) openDetail(row.dataset.user);
});
$('#users-table thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-key]'); if (!th) return;
  const key = th.dataset.key;
  state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: ['username', 'firstSeen', 'lastSeen', 'firstSeenEver'].includes(key) ? 1 : -1 };
  renderTable();
});
for (const b of document.querySelectorAll('.tab-btn')) b.addEventListener('click', () => setTab(b.dataset.tab));
$('#search').addEventListener('input', e => { state.search = e.target.value; if (state.tab === 'users') renderTable(); else if (state.tab === 'suspects') renderSuspects(); else if (state.tab === 'chat') renderChat(); });
$('#present-only').addEventListener('change', e => { state.presentOnly = e.target.checked; renderTable(); });
$('#log-chat').addEventListener('change', e => { state.showChat = e.target.checked; renderLog(); });
$('#detail-close').addEventListener('click', closeDetail);
$('#btn-save').addEventListener('click', async () => { try { await api.save(state.current); } catch (err) { toast('Save failed', err.message, 'error'); } });
$('#btn-reconnect').addEventListener('click', () => api.reconnectRoom(state.current));
$('#btn-remove').addEventListener('click', async () => {
  if (!state.current || !confirm(`Stop monitoring @${state.current}? Today's data is saved first.`)) return;
  await api.removeRoom(state.current); state.current = null; await refreshRooms(); await refreshSnapshot(); renderLists(); renderLog(); renderChat();
});
$('#btn-data').addEventListener('click', () => api.openData());

// settings
$('#btn-settings').addEventListener('click', async () => {
  await loadConfig();
  const f = $('#settings-form');
  for (const el of f.elements) { if (!el.name) continue; if (el.type === 'checkbox') el.checked = !!state.config[el.name]; else el.value = state.config[el.name] ?? ''; }
  $('#settings-path').textContent = `Saved to ${state.config.configFile}. Rooms, blacklist and watch list are saved as you edit them.`;
  $('#settings').hidden = false;
});
$('#settings-cancel').addEventListener('click', () => { $('#settings').hidden = true; });
$('#settings').addEventListener('click', e => { if (e.target.id === 'settings') $('#settings').hidden = true; });
$('#settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const patch = {};
  for (const el of e.target.elements) { if (!el.name) continue; patch[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value; }
  try { await api.setConfig(patch); await loadConfig(); $('#settings').hidden = true; toast('Settings saved', '', 'ok', 3000); scheduleRefresh(); }
  catch (err) { toast('Settings not saved', err.message, 'error'); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#settings').hidden) $('#settings').hidden = true; else closeDetail(); } });

// ---------- boot ----------
(async () => {
  await loadConfig();
  await refreshRooms();
  setTab('users');
  setInterval(refreshSnapshot, 2000);
  setInterval(refreshRooms, 5000);
})();
