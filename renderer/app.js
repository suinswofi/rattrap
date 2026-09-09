// TikTok Rat Trap renderer. Talks to the main process only through window.rattrap (see preload.cjs).
'use strict';

const $ = s => document.querySelector(s);
const api = window.rattrap;

const state = {
  rooms: [], current: null, snap: null, config: null,
  tab: 'users', sort: { key: 'firstSeen', dir: 1 }, search: '', presentOnly: false, showChat: false,
  suspectFilters: new Set(), showDismissed: false,
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

// `target` = { room, user }: clicking the toast jumps to that account's card on the Suspects tab.
function toast(title, text, kind = '', ttl = 8000, target = null) {
  const el = document.createElement('div');
  el.className = `toast ${kind} ${target ? 'clickable' : ''}`;
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(text)}</span>${target ? '<em>click to open</em>' : ''}`;
  el.onclick = () => { el.remove(); if (target) goToUser(target.room, target.user); };
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ttl);
}

/** Show one account: switch room and tab, undo anything hiding it, scroll to it, flash it, open the drawer. */
async function goToUser(room, user) {
  if (!room || !user) return;
  if (room !== state.current) {
    if (!state.rooms.some(r => r.room === room)) await refreshRooms();
    if (!state.rooms.some(r => r.room === room)) return;
    await selectRoom(room);
  }
  await refreshSnapshot();
  const u = state.snap?.users.find(x => x.username === user);
  if (!u) return;
  state.search = ''; $('#search').value = '';
  const onSuspects = u.score > 0 || u.pinned;
  if (onSuspects) {
    state.suspectFilters.clear();
    if (u.dismissedAt != null && !state.showDismissed) { state.showDismissed = true; $('#show-dismissed').checked = true; }
    setTab('suspects');
  } else {
    state.presentOnly = false; $('#present-only').checked = false;
    setTab('users');
  }
  await openDetail(user);
  const el = document.querySelector(onSuspects ? `#suspects-list .card[data-user="${CSS.escape(user)}"]` : `#users-table tbody tr[data-user="${CSS.escape(user)}"]`);
  if (el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('highlight'); void el.offsetWidth; el.classList.add('highlight');
    setTimeout(() => el.classList.remove('highlight'), 2500);
  }
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

const roomLists = room => state.config?.lists?.[room] ?? { watch: [], blacklist: [], pinned: [] };

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
// `width` is the default column width in px; the user can drag header edges to change it.
const COLUMNS = [
  { key: 'username', label: 'User', width: 260, render: u => `<span title="${esc(u.username)}${u.nickname && u.nickname !== u.username ? ` (${esc(u.nickname)})` : ''}">${esc(u.username)}${u.nickname && u.nickname !== u.username ? `<span class="nick">${esc(u.nickname)}</span>` : ''}</span>`, cls: 'user' },
  { key: 'present', label: 'Here', width: 62, render: u => `<span class="here ${u.present ? 'yes' : ''}" title="${u.present ? 'believed present' : 'gone'}"></span>` },
  { key: 'score', label: 'Score', width: 72, num: true, render: u => `<span class="score ${scoreClass(u.score)}" title="${esc(u.reasons.join('; ') || 'nothing suspicious')}">${u.score}</span>` },
  { key: 'joins', label: 'Joins', width: 68, num: true, render: u => u.joins },
  { key: 'chats', label: 'Chats', width: 70, num: true, render: u => u.chats },
  { key: 'likes', label: 'Likes', width: 70, num: true, render: u => u.likes },
  { key: 'coins', label: 'Coins', width: 72, num: true, render: u => u.coins },
  { key: 'firstSeen', label: 'First', width: 84, render: u => fmtTime(u.firstSeen) },
  { key: 'lastSeen', label: 'Last', width: 84, render: u => fmtTime(u.lastSeen) },
  { key: 'timeInRoom', label: 'In room', width: 86, num: true, render: u => dur(u.timeInRoom) },
  { key: 'daysSeen', label: 'Days', width: 62, num: true, render: u => u.daysSeen },
  { key: 'firstSeenEver', label: 'First ever', width: 100, render: u => fmtDate(u.firstSeenEver) },
  { key: 'followers', label: 'Flw / ing', width: 110, num: true, render: u => u.followers == null ? '–' : `${num(u.followers)} / ${num(u.following)}` },
  { key: 'flags', label: 'Flags', width: 200, render: u => u.flags.map(f => `<span class="flag ${flagClass(f)}">${esc(f)}</span>`).join('') },
];

// ---------- column widths (drag the header edge; double-click resets; remembered per machine) ----------
const MIN_COL = 40;
const colWidths = (() => { try { return JSON.parse(localStorage.getItem('rattrap.colWidths') || '{}'); } catch { return {}; } })();
const colWidth = c => Math.max(MIN_COL, Number(colWidths[c.key]) || c.width);
const saveColWidths = () => { try { localStorage.setItem('rattrap.colWidths', JSON.stringify(colWidths)); } catch { /* private mode etc. */ } };

function applyColWidths() {
  const table = $('#users-table');
  let cg = table.querySelector('colgroup');
  if (!cg) { cg = document.createElement('colgroup'); cg.innerHTML = COLUMNS.map(() => '<col>').join(''); table.prepend(cg); }
  const cols = cg.children;
  let total = 0;
  COLUMNS.forEach((c, i) => { const w = colWidth(c); cols[i].style.width = `${w}px`; total += w; });
  table.style.width = `${total}px`;
}

function startColResize(e, key) {
  e.preventDefault(); e.stopPropagation();
  const col = COLUMNS.find(c => c.key === key);
  const startX = e.clientX, startW = colWidth(col);
  document.body.classList.add('resizing');
  const move = ev => { colWidths[key] = Math.max(MIN_COL, startW + ev.clientX - startX); applyColWidths(); };
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('resizing'); saveColWidths(); };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

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
  thead.innerHTML = `<tr>${COLUMNS.map(c => `<th data-key="${c.key}" class="${c.num ? 'num' : ''} ${state.sort.key === c.key ? 'sorted' : ''}"><span class="th-label">${c.label}${state.sort.key === c.key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</span><span class="col-resize" data-resize="${c.key}" title="Drag to resize, double-click to reset"></span></th>`).join('')}</tr>`;
  applyColWidths();
  const rows = sortedUsers();
  $('#users-table tbody').innerHTML = rows.map(u => `<tr data-user="${esc(u.username)}" class="${u.present ? '' : 'gone'} ${u.username === state.detailUser ? 'selected' : ''}">${COLUMNS.map(c => `<td class="${c.cls ?? ''} ${c.num ? 'num' : ''}">${c.render(u)}</td>`).join('')}</tr>`).join('')
    || `<tr><td colspan="${COLUMNS.length}" class="note">${!state.snap ? 'loading…' : state.snap.users.length ? 'nobody matches' : state.snap.state === 'live' ? 'connected, waiting for viewers…' : 'no viewers seen yet today'}</td></tr>`;
}

// Tag filters for the suspects list: label, and the test a row must pass.
const SUSPECT_TAGS = [
  { key: 'flagged', label: 'Flagged', test: u => u.score >= (state.config?.burnerAlertScore ?? 6) },
  { key: 'blacklist', label: 'Blacklist', test: u => u.blacklisted.length > 0 },
  { key: 'now', label: 'In room now', test: u => u.flags.some(f => f.startsWith('NOW:')) },
  { key: 'follows', label: 'Follows blacklisted', test: u => u.reasons.some(r => r.startsWith('follows blacklisted')) },
  { key: 'renamed', label: 'Renamed', test: u => u.flags.includes('renamed') },
  { key: 'nofollowers', label: 'No followers', test: u => u.followers === 0 },
  { key: 'defaultname', label: 'Auto-generated name', test: u => u.reasons.includes('auto-generated username') },
  { key: 'follower', label: 'Follows this host', test: u => u.isFollower === true },
  { key: 'watch', label: 'Watched', test: u => u.watched },
  { key: 'pinned', label: 'Pinned', test: u => u.pinned },
  { key: 'present', label: 'Present', test: u => u.present },
];

function suspectRows() {
  const q = state.search.trim().toLowerCase();
  const all = (state.snap?.users ?? []).filter(u => (u.score > 0 || u.pinned) && (!q || u.username.toLowerCase().includes(q) || (u.nickname ?? '').toLowerCase().includes(q)));
  const visible = all.filter(u => state.showDismissed || u.dismissedAt == null);
  const active = SUSPECT_TAGS.filter(t => state.suspectFilters.has(t.key));
  const list = (active.length ? visible.filter(u => active.some(t => t.test(u))) : visible)
    .sort((a, b) => (b.pinned - a.pinned) || ((a.dismissedAt != null) - (b.dismissedAt != null)) || (b.score - a.score));
  return { all, visible, list, dismissed: all.filter(u => u.dismissedAt != null).length };
}

function renderSuspects() {
  const { visible, list, dismissed } = suspectRows();
  $('#suspect-filters').innerHTML = SUSPECT_TAGS.map(t => { const n = visible.filter(t.test).length; return n || state.suspectFilters.has(t.key)
    ? `<button class="chip ${state.suspectFilters.has(t.key) ? 'on' : ''}" data-filter="${t.key}">${t.label}<span class="n">${n}</span></button>` : ''; }).join('')
    + (state.suspectFilters.size ? '<button class="chip" data-filter="">clear filters</button>' : '');
  $('#dismissed-count').textContent = dismissed ? `(${dismissed})` : '';
  $('#btn-clear-suspects').disabled = !list.some(u => !u.pinned && u.dismissedAt == null);
  $('#suspects-list').innerHTML = list.slice(0, 300).map(u => `
    <div class="card ${u.pinned ? 'pinned' : ''} ${u.dismissedAt != null ? 'dismissed' : ''}" data-user="${esc(u.username)}">
      <span class="score ${scoreClass(u.score)}">${u.score}</span>
      <div class="who">${u.pinned ? '📌 ' : ''}${esc(u.username)}${u.nickname && u.nickname !== u.username ? `<span class="nick">${esc(u.nickname)}</span>` : ''}
        ${u.flags.map(f => `<span class="flag ${flagClass(f)}">${esc(f)}</span>`).join('')}${u.dismissedAt != null ? `<span class="flag">dismissed ${fmtTime(u.dismissedAt)}</span>` : ''}</div>
      <div class="card-actions">
        <button class="pin ${u.pinned ? 'on' : ''}" data-action="pin" title="${u.pinned ? 'Unpin: this account can be cleared again' : 'Pin: keep this account on the list when clearing'}">${u.pinned ? 'Pinned' : 'Pin'}</button>
        ${u.dismissedAt != null ? '<button data-action="restore" title="Put this account back on the list">Restore</button>' : `<button data-action="dismiss" title="Hide this account until it joins again" ${u.pinned ? 'disabled' : ''}>Dismiss</button>`}
      </div>
      <div class="reasons">${u.reasons.map(r => `<span class="reason ${reasonClass(r)}">${esc(r)}</span>`).join('') || '<span class="reason">nothing suspicious</span>'}</div>
    </div>`).join('') || `<p class="note">${visible.length ? 'Nothing matches the selected tags.' : dismissed ? 'Everything is dismissed. Tick "show dismissed" to see them.' : 'Nobody scored above 0.'}</p>`;
}

$('#suspect-filters').addEventListener('click', e => {
  const b = e.target.closest('button[data-filter]'); if (!b) return;
  const k = b.dataset.filter;
  if (!k) state.suspectFilters.clear(); else if (state.suspectFilters.has(k)) state.suspectFilters.delete(k); else state.suspectFilters.add(k);
  renderSuspects();
});
$('#show-dismissed').addEventListener('change', e => { state.showDismissed = e.target.checked; renderSuspects(); });
$('#btn-clear-suspects').addEventListener('click', async () => {
  const { list } = suspectRows();
  const names = list.filter(u => !u.pinned && u.dismissedAt == null).map(u => u.username);
  if (!names.length) return;
  const pinnedCount = list.filter(u => u.pinned).length;
  if (!confirm(`Dismiss ${names.length} account${names.length === 1 ? '' : 's'} from the list?${pinnedCount ? ` ${pinnedCount} pinned account${pinnedCount === 1 ? '' : 's'} will stay.` : ''} They come back if they join again.`)) return;
  await api.dismiss(state.current, names);
  await refreshSnapshot();
});
$('#suspects-list').addEventListener('click', async e => {
  const b = e.target.closest('button[data-action]'); if (!b) return;
  e.stopPropagation();
  const user = b.closest('[data-user]').dataset.user;
  if (b.dataset.action === 'pin') { const on = b.classList.contains('on'); await api.editList(state.current, 'pinned', on ? 'remove' : 'add', [user]); await loadConfig(); }
  else if (b.dataset.action === 'dismiss') await api.dismiss(state.current, [user]);
  else if (b.dataset.action === 'restore') await api.undismiss(state.current, [user]);
  await refreshSnapshot();
}, true);

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
  const pinned = roomLists(state.current).pinned?.includes(d.username);
  const score = t ? `<div class="scorebox"><span class="score ${scoreClass(t.score)}">${t.score}</span><div class="reasons">${t.reasons.length ? t.reasons.map(r => `<span class="reason ${reasonClass(r)}">${esc(r)}</span>`).join('') : '<span class="none">nothing suspicious</span>'}</div></div>`
    : '<p class="note">Not seen today, so no score. Showing history only.</p>';
  const parts = [
    score,
    `<div class="actions"><button class="btn" id="d-watch">${watched ? 'Unwatch' : 'Watch'}</button><button class="btn" id="d-pin">${pinned ? 'Unpin' : 'Pin'}</button><button class="btn" id="d-open">Open on TikTok</button></div>`,
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
  $('#d-pin').onclick = async () => { await api.editList(state.current, 'pinned', pinned ? 'remove' : 'add', [d.username]); await loadConfig(); renderDetail(); scheduleRefresh(); };
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
      if (ev.entry.kind === 'error') toast(ev.room ? `@${ev.room}` : 'Rat Trap', ev.entry.text, 'error');
      else if (ev.entry.watched && ['join', 'rejoin', 'chat', 'gift', 'follow', 'share'].includes(ev.entry.kind)) toast(`★ @${ev.entry.user} in @${ev.room}`, `${ev.entry.kind}: ${ev.entry.text}`, '', 8000, { room: ev.room, user: ev.entry.user });
      break;
    case 'flag':
      toast(`⚑ @${ev.user} in @${ev.room} — score ${ev.score}`, ev.reasons.join('; '), 'flag', 12000, { room: ev.room, user: ev.user });
      if (ev.room === state.current) scheduleRefresh();
      break;
    case 'status': case 'rooms':
      state.rooms = ev.rooms ?? state.rooms; renderRooms(); renderHeader();
      if (ev.type === 'status' && ev.room === state.current) scheduleRefresh();
      if (!state.current && state.rooms.length) selectRoom(state.rooms[0].room);
      break;
    case 'users': if (ev.room === state.current) scheduleRefresh(); break;
    case 'lists': state.config = { ...state.config, lists: { ...(state.config?.lists ?? {}), [ev.room]: { watch: ev.watch, blacklist: ev.blacklist, pinned: ev.pinned ?? [] } } }; renderLists(); scheduleRefresh(); break;
    case 'saved': if (ev.room === state.current) toast(`@${ev.room} saved`, `${ev.count} users written to today's snapshot and the room history`, 'ok', 4000); break;
  }
});

// ---------- help ----------
const HELP = {
  blacklist: {
    title: 'Blacklist: streamers to cross-check against',
    body: `
<p>The blacklist holds <b>other streamers</b>, not viewers. Rat Trap uses their rooms as reference points: for everyone in this room it checks whether they overlap with a blacklisted streamer, and flags them if so.</p>
<p>It belongs to <b>this room only</b>. Each room you monitor has its own blacklist.</p>
<p><b>Setup:</b> add the other streamer as a room in the Rooms list <i>and</i> put them on this room's blacklist. Rat Trap can only learn who is in their room, and who follows them, by sitting in that room while they are live.</p>
<p>A viewer here is flagged when any of these is true:</p>
<ul>
  <li><b>In their room right now.</b> Both rooms are open and the same account is present in both. Fires whichever room they enter second.</li>
  <li><b>Follows them.</b> TikTok reports, inside the streamer's own room, whether each viewer follows that host. Rat Trap remembers it, so this keeps working on later days even when the streamer is offline.</li>
  <li><b>Seen in their room before.</b> The account appears in that room's history from an earlier day.</li>
</ul>
<p>A hit adds points to the burner score, fires an alert on join, and tags the viewer <code>NOW:@name</code> or <code>BL:@name</code> in the tables and the detail drawer.</p>
<div class="example"><b>Example.</b> You monitor <code>@alice</code> and <code>@bob</code>. Add <code>@bob</code> to <code>@alice</code>'s blacklist. When someone who follows <code>@bob</code>, or who is sitting in <code>@bob</code>'s room, joins <code>@alice</code>'s room, you get an alert in <code>@alice</code>'s room.</div>
<p>Rat Trap never reads anyone's following list. It only learns follows from the blacklisted streamer's own room.</p>`,
  },
  watch: {
    title: 'Watch list: viewers you want to keep an eye on',
    body: `
<p>The watch list holds <b>specific viewer accounts</b>. It does not change anyone's score; it just makes sure you never miss what they do in this room.</p>
<p>It belongs to <b>this room only</b>. Each room you monitor has its own watch list.</p>
<p>For a watched viewer, every <b>join, chat, gift, follow and share</b>:</p>
<ul>
  <li>pops up as a toast,</li>
  <li>is highlighted in the Log tab,</li>
  <li>and the account is tagged <code>watch</code> in the tables.</li>
</ul>
<p>Add someone by typing their username below, or with the <b>Watch</b> button in a viewer's detail drawer.</p>
<div class="example"><b>Typical flow.</b> The blacklist or the Suspects tab surfaces an account that looks like a burner. Put it on the watch list, and from then on every move it makes in this room is announced.</div>
<p>Cross-room alerts do not need the watch list: anyone who overlaps with a blacklisted streamer is flagged, watched or not.</p>
<p><b>Pinning</b> (Suspects tab) is different again: a pinned account simply stays on the Suspects list when you clear it, and always shows there even with a score of 0. Pin what you want to keep looking at; watch what you want to be told about.</p>`,
  },
};
function openHelp(key) {
  const h = HELP[key]; if (!h) return;
  $('#help-title').textContent = h.title;
  $('#help-body').innerHTML = h.body;
  $('#help').hidden = false;
}
document.addEventListener('click', e => { const b = e.target.closest('button[data-help]'); if (b) openHelp(b.dataset.help); });
$('#help-close').addEventListener('click', () => { $('#help').hidden = true; });
$('#help').addEventListener('click', e => { if (e.target.id === 'help') $('#help').hidden = true; });

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
    if (list === 'blacklist' && !state.rooms.some(r => r.room === name.replace(/^@/, '').toLowerCase())) toast('Blacklisted', `Add @${name.replace(/^@/, '')} as a room too, so Rat Trap can record who follows them.`, '', 10000);
  });
}
document.addEventListener('click', async e => {
  const x = e.target.closest('button.x[data-list]');
  if (x) { await api.editList(state.current, x.dataset.list, 'remove', [x.dataset.name]); await loadConfig(); scheduleRefresh(); return; }
  const row = e.target.closest('[data-user]');
  if (row && !e.target.closest('.side-list') && !e.target.closest('button[data-action]')) openDetail(row.dataset.user);
});
$('#users-table thead').addEventListener('mousedown', e => { const h = e.target.closest('.col-resize'); if (h && e.button === 0) startColResize(e, h.dataset.resize); });
$('#users-table thead').addEventListener('dblclick', e => { const h = e.target.closest('.col-resize'); if (!h) return; e.stopPropagation(); delete colWidths[h.dataset.resize]; saveColWidths(); applyColWidths(); });
$('#users-table thead').addEventListener('click', e => {
  if (e.target.closest('.col-resize')) return;
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
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#help').hidden) $('#help').hidden = true; else if (!$('#settings').hidden) $('#settings').hidden = true; else closeDetail(); } });

// ---------- boot ----------
(async () => {
  await loadConfig();
  await refreshRooms();
  setTab('users');
  setInterval(refreshSnapshot, 2000);
  setInterval(refreshRooms, 5000);
})();
