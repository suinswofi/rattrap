// TikTok Rat Trap renderer. Talks to the main process only through window.rattrap (see preload.cjs).
'use strict';

const $ = s => document.querySelector(s);
const api = window.rattrap;

const LOG_CHUNK = 1500; // log/chat lines drawn at once; "show earlier" adds another chunk

const state = {
  rooms: [], current: null, snap: null, config: null,
  tab: 'users', sort: { key: 'firstSeen', dir: 1 }, search: '',
  // Burners and Blacklist hits each remember their own filters: facet key -> 'yes' | 'no'
  filters: { burners: new Map(), blacklist: new Map() }, showDismissed: false,
  logs: new Map(),      // room -> { sid, entries } — the live stream's whole log
  logSid: null,         // stream shown on the Chat/Log tabs; null = the live one
  pastLog: null,        // { room, sid, entries } fetched for an earlier stream
  hiddenKinds: new Set(['chat']), starredOnly: false, shown: { log: LOG_CHUNK, chat: LOG_CHUNK },
  detailUser: null, refreshTimer: null,
};

// ---------- formatting ----------
const pad2 = n => String(n).padStart(2, '0');
const fmtTime = ts => { if (ts == null) return '–'; const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const fmtHM = ts => { if (ts == null) return '–'; const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtDate = ts => { if (ts == null) return '–'; const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const fmtDateTime = ts => ts == null ? '–' : `${fmtDate(ts)} ${fmtTime(ts)}`;
const dur = ms => { if (ms == null) return '–'; const s = Math.floor(ms / 1000); if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`; return `${Math.floor(s / 3600)}h${pad2(Math.floor(s / 60) % 60)}m`; };
const num = n => n == null ? '–' : Number(n).toLocaleString();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const flagClass = f => f.startsWith('BL:') || f.startsWith('NOW:') || f.startsWith('HOP:') ? 'bl' : esc(f);
const flagText = f => f.startsWith('HOP:') ? `↔ ${f.slice(4)}` : f.startsWith('NOW:') ? `in ${f.slice(4)}'s stream` : f.startsWith('BL:') ? `seen at ${f.slice(3)}` : f;
const alertScore = () => state.config?.burnerAlertScore ?? 6;
const scoreClass = s => s >= alertScore() ? 'high' : s >= 3 ? 'mid' : '';
const reasonClass = r => /blacklisted|previously named|no followers|only \d+ followers/.test(r) ? 'strong' : /private|username|nickname|follows nobody/.test(r) ? 'profile' : '';
// Same as streamLabel() in history.js: "2026-09-08_21-00" -> "2026-09-08 21:00"
const streamLabel = sid => String(sid ?? '').replace(/_(\d\d)-(\d\d)(b*)$/, ' $1:$2$3');
const streamName = s => !s ? '' : `${streamLabel(s.sid)}${s.legacy ? ' (whole day)' : ''}`;

// `target` = { room, user }: clicking the toast jumps to that account.
/** `action` = { label, run } adds a button to the toast; clicking it runs `run` and closes the toast. */
function toast(title, text, kind = '', ttl = 8000, target = null, action = null) {
  const el = document.createElement('div');
  el.className = `toast ${kind} ${target ? 'clickable' : ''}`;
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(text)}</span>${target ? '<em>click to open</em>' : ''}${action ? `<button class="act">${esc(action.label)}</button>` : ''}`;
  el.onclick = e => {
    if (e.target.closest('button.act')) { el.remove(); action.run(); return; }
    el.remove(); if (target) goToUser(target.room, target.user);
  };
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ttl);
}

const isMonitored = name => state.rooms.some(r => r.room === String(name).replace(/^@/, '').toLowerCase());
const roomLists = room => state.config?.lists?.[room] ?? { watch: [], blacklist: [], pinned: [] };
const isStarred = user => { const l = roomLists(state.current); return !!user && (l.pinned.includes(user) || l.watch.includes(user)); };

/** Add a room from a blacklist prompt without leaving the room the user is looking at. */
async function addBlacklistedRoom(name) {
  try { await api.addRoom(name); await refreshRooms(); toast('Room added', `Now sitting in @${name}'s room whenever they are live.`, 'ok'); }
  catch (err) { toast('Could not add room', err.message, 'error'); }
}

/** Which tab an account belongs on: blacklist hits first, then burners, else the plain list. */
const tabFor = u => (u.blacklisted.length || u.hops) ? 'blacklist' : (u.burnerScore > 0 || u.pinned) ? 'burners' : 'users';

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
  state.search = ''; $('#search').value = '';
  if (!u) { await openDetail(user); return; } // only in history: the drawer still works
  const tab = tabFor(u);
  if (tab !== 'users') {
    state.filters[tab].clear();
    if (u.dismissedAt != null && !state.showDismissed) { state.showDismissed = true; $('#show-dismissed').checked = true; }
  }
  setTab(tab);
  await openDetail(user);
  const el = tab !== 'users' ? document.querySelector(`#suspects-list .card[data-user="${CSS.escape(user)}"]`) : scrollTableTo(user);
  if (el) {
    if (tab !== 'users') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
      ${r.flagged ? `<span class="badge" title="flagged accounts this stream">${r.flagged}</span>` : ''}
      <span class="sub" title="accounts seen this stream">${r.seen}</span>
    </li>`).join('');
  $('#empty').hidden = state.rooms.length > 0;
}

function renderLists() {
  const l = roomLists(state.current);
  // Blacklisted streamers only work as reference points while their room is monitored too; say so on the chip.
  const tag = (list, n) => list === 'blacklist' && !isMonitored(n)
    ? `<span class="tagrow"><button class="tag warn" data-add-room="${esc(n)}" title="Rat Trap is not sitting in @${esc(n)}'s room, so it cannot see who is there or who follows them. Click to add them as a room.">not monitored · add room</button></span>` : '';
  const chips = (list, name) => list.map(n => `<li><span class="name">@${esc(n)}</span>${tag(name, n)}<button class="x" data-list="${name}" data-name="${esc(n)}" title="remove">×</button></li>`).join('');
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
    if (s.stream) {
      const live = s.live && !s.stream.endedAt;
      parts.push(`<span class="stream-tag" title="Everything on the Users, Burners and Blacklist tabs is about this stream. Stream id: ${esc(s.stream.sid)}">${live ? 'stream' : 'last stream'} <b>${esc(streamName(s.stream))}</b>${s.stream.endedAt ? ` → ${fmtHM(s.stream.endedAt)}` : ''}</span>`);
    }
    if (s.viewers != null && s.live) parts.push(`<span><b>${num(s.viewers)}</b> viewers</span>`);
    parts.push(`<span title="accounts seen this stream"><b>${s.counts.seen}</b> seen</span>`, `<span title="accounts ever seen in this room"><b>${s.counts.known}</b> ever</span>`);
    if (s.counts.flagged) parts.push(`<span><b class="hot">${s.counts.flagged}</b> flagged</span>`);
    if (s.likes != null && s.live) parts.push(`<span><b>${num(s.likes)}</b> likes</span>`);
    if (s.uptime) parts.push(`<span title="how long the streamer has been live">live <b>${dur(s.uptime)}</b></span>`);
    if (s.title) parts.push(`<span class="title" title="${esc(s.title)}">“${esc(s.title)}”</span>`);
  }
  $('#room-meta').innerHTML = parts.join('');
  for (const id of ['#btn-save', '#btn-reconnect', '#btn-remove']) $(id).disabled = !state.current;
  $('#count-users').textContent = s ? s.counts.seen : '';
  const users = s?.users ?? [];
  const burners = users.filter(u => u.dismissedAt == null && u.score >= alertScore()).length;
  const hits = users.filter(u => u.dismissedAt == null && (u.blacklisted.length || u.hops)).length;
  const cb = $('#count-burners'); cb.textContent = s ? burners : ''; cb.className = `count ${burners ? 'hot' : ''}`;
  const cl = $('#count-blacklist'); cl.textContent = s ? hits : ''; cl.className = `count ${hits ? 'hot' : ''}`;
  renderStreamSelect();
}

/** The stream drop-down on the Chat and Log tabs. */
function renderStreamSelect() {
  const sel = $('#stream-select');
  const s = state.snap;
  const streams = s?.streams ?? [];
  const cur = s?.stream?.sid ?? null;
  const opt = (v, label, selected) => `<option value="${esc(v)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
  const label = x => `${streamName(x)}${x.endedAt ? ` → ${fmtHM(x.endedAt)}` : x.sid === cur && s.live ? ' · live' : ''}${x.seen ? ` · ${x.seen} seen` : ''}${x.title ? ` · ${x.title}` : ''}`;
  const html = streams.map(x => opt(x.sid, `${x.sid === cur ? '● ' : ''}${label(x)}`, (state.logSid ?? cur) === x.sid)).join('');
  if (sel.innerHTML !== html) sel.innerHTML = html || opt('', 'no streams yet', true);
  sel.disabled = !streams.length;
}

// ---------- users table ----------
// `width` is the default column width in px; the user can drag header edges to change it.
const COLUMNS = [
  { key: 'username', label: 'User', width: 260, render: u => `<span title="${esc(u.username)}${u.nickname && u.nickname !== u.username ? ` (${esc(u.nickname)})` : ''}">${esc(u.username)}${u.nickname && u.nickname !== u.username ? `<span class="nick">${esc(u.nickname)}</span>` : ''}</span>`, cls: 'user' },
  { key: 'score', label: 'Score', width: 72, num: true, render: u => `<span class="score ${scoreClass(u.score)}" title="${esc(u.reasons.join('; ') || 'nothing suspicious')}">${u.score}</span>` },
  { key: 'joins', label: 'Joins', width: 68, num: true, render: u => u.joins },
  { key: 'chats', label: 'Chats', width: 70, num: true, render: u => u.chats },
  { key: 'likes', label: 'Likes', width: 70, num: true, render: u => u.likes },
  { key: 'gifts', label: 'Gifts', width: 64, num: true, render: u => u.gifts },
  { key: 'coins', label: 'Coins', width: 72, num: true, render: u => u.coins },
  { key: 'firstSeen', label: 'First', width: 84, render: u => fmtTime(u.firstSeen) },
  { key: 'lastSeen', label: 'Last', width: 84, render: u => fmtTime(u.lastSeen) },
  { key: 'streamsSeen', label: 'Streams', width: 78, num: true, render: u => u.streamsSeen },
  { key: 'firstSeenEver', label: 'First ever', width: 100, render: u => fmtDate(u.firstSeenEver) },
  { key: 'followers', label: 'Flw / ing', width: 110, num: true, render: u => u.followers == null ? '–' : `${num(u.followers)} / ${num(u.following)}` },
  { key: 'flags', label: 'Flags', width: 220, render: u => u.flags.map(f => `<span class="flag ${flagClass(f)}">${esc(flagText(f))}</span>`).join('') },
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

const matchesSearch = (u, q) => !q || u.username.toLowerCase().includes(q) || (u.nickname ?? '').toLowerCase().includes(q);

function sortedUsers() {
  const q = state.search.trim().toLowerCase();
  const list = (state.snap?.users ?? []).filter(u => matchesSearch(u, q));
  const { key, dir } = state.sort;
  const val = u => key === 'flags' ? u.flags.length : u[key];
  return [...list].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
}

// The table only renders the rows that are scrolled into view (plus a buffer), so thousands of
// viewers cost the same as a screenful. Rows have a fixed height, measured from the first render.
const table = { rows: [], rowH: 37, buffer: 12, lastStart: -1, lastEnd: -1, raf: null };
const rowHtml = u => `<tr data-user="${esc(u.username)}" class="${u.username === state.detailUser ? 'selected' : ''}">${COLUMNS.map(c => `<td class="${c.cls ?? ''} ${c.num ? 'num' : ''}">${c.render(u)}</td>`).join('')}</tr>`;

function renderTable() {
  const thead = $('#users-table thead');
  thead.innerHTML = `<tr>${COLUMNS.map(c => `<th data-key="${c.key}" class="${c.num ? 'num' : ''} ${state.sort.key === c.key ? 'sorted' : ''}"><span class="th-label">${c.label}${state.sort.key === c.key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</span><span class="col-resize" data-resize="${c.key}" title="Drag to resize, double-click to reset"></span></th>`).join('')}</tr>`;
  applyColWidths();
  table.rows = sortedUsers();
  table.lastStart = -1; // force a redraw of the window
  renderTableWindow();
}

function renderTableWindow(force = true) {
  const wrap = $('#tab-users .table-wrap'), tbody = $('#users-table tbody');
  const rows = table.rows;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${COLUMNS.length}" class="note">${!state.snap ? 'loading…' : state.snap.users.length ? 'nobody matches' : state.snap.state === 'live' ? 'connected, waiting for viewers…' : 'nobody seen yet'}</td></tr>`;
    table.lastStart = -1; return;
  }
  const headH = $('#users-table thead').offsetHeight || 33;
  const start = Math.max(0, Math.floor((wrap.scrollTop - headH) / table.rowH) - table.buffer);
  const end = Math.min(rows.length, Math.ceil((wrap.scrollTop - headH + wrap.clientHeight) / table.rowH) + table.buffer);
  if (!force && start === table.lastStart && end === table.lastEnd) return;
  table.lastStart = start; table.lastEnd = end;
  const spacer = h => h > 0 ? `<tr class="spacer" style="height:${h}px"><td colspan="${COLUMNS.length}"></td></tr>` : '';
  tbody.innerHTML = spacer(start * table.rowH) + rows.slice(start, end).map(rowHtml).join('') + spacer((rows.length - end) * table.rowH);
  const first = tbody.querySelector('tr[data-user]');
  if (first) { const h = first.getBoundingClientRect().height; if (h > 10 && Math.abs(h - table.rowH) > 0.5) { table.rowH = h; table.lastStart = -1; renderTableWindow(); } }
}

$('#tab-users .table-wrap').addEventListener('scroll', () => {
  if (table.raf) return;
  table.raf = requestAnimationFrame(() => { table.raf = null; renderTableWindow(false); });
});
window.addEventListener('resize', () => { table.lastStart = -1; if (state.tab === 'users') renderTableWindow(); });

/** Scroll the users table so `username` is centred, rendering that window. Returns the row element. */
function scrollTableTo(username) {
  const i = table.rows.findIndex(u => u.username === username);
  if (i < 0) return null;
  const wrap = $('#tab-users .table-wrap');
  wrap.scrollTop = Math.max(0, i * table.rowH - wrap.clientHeight / 2 + table.rowH);
  renderTableWindow();
  return $(`#users-table tbody tr[data-user="${CSS.escape(username)}"]`);
}

// ---------- burners & blacklist hits ----------
// Facets for the two suspect tabs. Each can be required ('yes'), excluded ('no') or off; they combine with AND.
const FACETS = [
  { key: 'flagged', label: 'Flagged', test: u => u.score >= alertScore() },
  { key: 'hopped', label: 'Hopped from/to blacklisted', test: u => u.hops > 0 },
  { key: 'now', label: 'In blacklisted stream now', test: u => u.flags.some(f => f.startsWith('NOW:') || f.startsWith('HOP:')) },
  { key: 'follows', label: 'Follows blacklisted', test: u => u.reasons.some(r => r.startsWith('follows blacklisted')) },
  { key: 'seenbl', label: 'Seen at blacklisted before', test: u => u.reasons.some(r => r.startsWith('seen in blacklisted')) },
  { key: 'chatted', label: 'Chatted', test: u => u.chats > 0 },
  { key: 'gifted', label: 'Gifted', test: u => u.gifts > 0 },
  { key: 'liked', label: 'Liked', test: u => u.likes > 0 },
  { key: 'shared', label: 'Shared', test: u => u.shares > 0 },
  { key: 'rejoined', label: 'Joined 2+ times', test: u => u.joins >= 2 },
  { key: 'follower', label: 'Follows this host', test: u => u.isFollower === true },
  { key: 'new', label: 'First time here', test: u => u.streamsSeen <= 1 },
  { key: 'renamed', label: 'Renamed', test: u => u.flags.includes('renamed') },
  { key: 'nofollowers', label: 'No followers', test: u => u.followers === 0 },
  { key: 'defaultname', label: 'Auto-generated name', test: u => u.reasons.includes('auto-generated username') },
  { key: 'watch', label: 'Watched', test: u => u.watched },
  { key: 'pinned', label: 'Pinned', test: u => u.pinned },
];
const suspectMode = () => state.tab === 'blacklist' ? 'blacklist' : 'burners';
const onTab = { burners: u => u.burnerScore > 0 || u.pinned, blacklist: u => u.blacklisted.length > 0 || u.hops > 0 };
const passes = (u, filters, except = null) => [...filters].every(([k, v]) => k === except || FACETS.find(f => f.key === k).test(u) === (v === 'yes'));

function suspectRows(mode = suspectMode()) {
  const q = state.search.trim().toLowerCase();
  const filters = state.filters[mode];
  const all = (state.snap?.users ?? []).filter(onTab[mode]);
  const base = all.filter(u => matchesSearch(u, q) && (state.showDismissed || u.dismissedAt == null));
  const list = base.filter(u => passes(u, filters));
  const order = mode === 'blacklist'
    ? (a, b) => (b.pinned - a.pinned) || ((a.dismissedAt != null) - (b.dismissedAt != null)) || (b.hops - a.hops) || (b.blacklistScore - a.blacklistScore) || (b.score - a.score)
    : (a, b) => (b.pinned - a.pinned) || ((a.dismissedAt != null) - (b.dismissedAt != null)) || (b.score - a.score);
  list.sort(order);
  return { all, base, list, dismissed: all.filter(u => u.dismissedAt != null).length };
}

const NOTES = {
  burners: 'Accounts with throwaway signals, ranked by score. Points are added for each signal; the score ranks who deserves a look and proves nothing on its own. In busy rooms most one-time visitors earn a couple of points just for being new and quiet, so weigh the profile reasons more.',
  blacklist: 'Accounts that overlap with a blacklisted streamer: hopped between their stream and this one, are in their live stream now, follow them, or were seen in their room in an earlier stream. Hops are announced every time they happen; the time gap is in the reason.',
};

function renderSuspects() {
  const mode = suspectMode();
  const filters = state.filters[mode];
  const { all, base, list, dismissed } = suspectRows(mode);
  $('#suspects-note').textContent = NOTES[mode];
  // Each chip's number says how many accounts would remain if it were switched to "yes", given the other filters.
  $('#suspect-filters').innerHTML = FACETS.map(f => {
    const v = filters.get(f.key);
    const n = base.filter(u => passes(u, filters, f.key) && f.test(u)).length;
    const title = v === 'yes' ? `only accounts that ${f.label.toLowerCase()} — click to show only those that do not` : v === 'no' ? `hiding accounts that ${f.label.toLowerCase()} — click to switch off` : `click to show only accounts that ${f.label.toLowerCase()}`;
    return `<button class="chip ${v ?? ''}" data-filter="${f.key}" title="${esc(title)}">${v === 'yes' ? '✓ ' : v === 'no' ? '✗ ' : ''}${f.label}<span class="n">${n}</span></button>`;
  }).join('') + (filters.size ? '<button class="chip clear" data-filter="">clear filters</button>' : '');
  $('#dismissed-count').textContent = dismissed ? `(${dismissed})` : '';
  $('#btn-dismiss-all').disabled = !all.some(u => !u.pinned && u.dismissedAt == null);
  $('#suspects-list').innerHTML = list.slice(0, 300).map(u => `
    <div class="card ${u.pinned ? 'pinned' : ''} ${u.dismissedAt != null ? 'dismissed' : ''}" data-user="${esc(u.username)}">
      <span class="score ${scoreClass(u.score)}" title="burner score${u.blacklistScore ? ` (${u.blacklistScore} of it from blacklist hits)` : ''}">${u.score}</span>
      <div class="who">${u.pinned ? '📌 ' : ''}${esc(u.username)}${u.nickname && u.nickname !== u.username ? `<span class="nick">${esc(u.nickname)}</span>` : ''}
        ${u.flags.map(f => `<span class="flag ${flagClass(f)}">${esc(flagText(f))}</span>`).join('')}${u.dismissedAt != null ? `<span class="flag">dismissed ${fmtTime(u.dismissedAt)}</span>` : ''}</div>
      <div class="card-actions">
        <button class="pin ${u.pinned ? 'on' : ''}" data-action="pin" title="${u.pinned ? 'Unpin: this account can be dismissed again' : 'Pin: keep this account on the list and keep its full history forever'}">${u.pinned ? 'Pinned' : 'Pin'}</button>
        ${u.dismissedAt != null ? '<button data-action="restore" title="Put this account back on the list">Restore</button>' : `<button data-action="dismiss" title="Hide this account until it joins again" ${u.pinned ? 'disabled' : ''}>Dismiss</button>`}
      </div>
      <div class="stats">${plural(u.joins, 'join')} · ${plural(u.chats, 'chat')} · ${plural(u.likes, 'like')} · ${plural(u.gifts, 'gift')}${u.coins ? ` (${u.coins} coins)` : ''} · ${plural(u.shares, 'share')} · seen ${fmtTime(u.firstSeen)}–${fmtTime(u.lastSeen)} · ${plural(u.streamsSeen, 'stream')}${u.followers != null ? ` · ${num(u.followers)} followers` : ''}</div>
      <div class="reasons">${u.reasons.map(r => `<span class="reason ${reasonClass(r)}">${esc(r)}</span>`).join('') || '<span class="reason">nothing suspicious</span>'}</div>
    </div>`).join('') || `<p class="note">${base.length ? 'Nothing matches every selected filter.' : dismissed && !state.showDismissed ? 'Everything is dismissed. Tick "show dismissed" to see them.' : mode === 'blacklist' ? (roomLists(state.current).blacklist.length ? 'No overlap with a blacklisted streamer this stream.' : 'No blacklisted streamers yet. Add one in the sidebar (and add them as a room) to cross-check.') : 'Nobody has a burner score above 0.'}</p>`;
}

$('#suspect-filters').addEventListener('click', e => {
  const b = e.target.closest('button[data-filter]'); if (!b) return;
  const k = b.dataset.filter, filters = state.filters[suspectMode()];
  if (!k) filters.clear();
  else { const v = filters.get(k); if (!v) filters.set(k, 'yes'); else if (v === 'yes') filters.set(k, 'no'); else filters.delete(k); }
  renderSuspects();
});
$('#show-dismissed').addEventListener('change', e => { state.showDismissed = e.target.checked; renderSuspects(); });
// Dismisses every account on this tab that is not pinned, including ones hidden by the search box or filters.
$('#btn-dismiss-all').addEventListener('click', async () => {
  const mode = suspectMode();
  const everyone = (state.snap?.users ?? []).filter(onTab[mode]);
  const names = everyone.filter(u => !u.pinned && u.dismissedAt == null).map(u => u.username);
  if (!names.length) return;
  const pinnedCount = everyone.filter(u => u.pinned).length;
  const hidden = state.search.trim() || state.filters[mode].size ? ' This includes accounts hidden by the search box or filters.' : '';
  if (!confirm(`Dismiss all ${plural(names.length, 'account')} on this tab?${pinnedCount ? ` ${plural(pinnedCount, 'pinned account')} will stay.` : ''}${hidden} Dismissed accounts come back if they join again.`)) return;
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
const KIND_GROUPS = [
  { key: 'join', label: 'Joins', kinds: ['join', 'rejoin'] },
  { key: 'chat', label: 'Chat', kinds: ['chat'] },
  { key: 'gift', label: 'Gifts', kinds: ['gift'] },
  { key: 'social', label: 'Follows & shares', kinds: ['follow', 'share'] },
  { key: 'alert', label: 'Alerts', kinds: ['flag', 'hop'] },
  { key: 'system', label: 'System', kinds: ['system', 'status', 'error'] },
];
const groupOf = kind => KIND_GROUPS.find(g => g.kinds.includes(kind))?.key ?? 'system';
const nearBottom = el => el.scrollHeight - el.scrollTop - el.clientHeight < 40;
const lineHtml = e => `<div class="line ${esc(e.kind)} ${isStarred(e.user) ? 'watched' : ''} ${e.backlog ? 'backlog' : ''}"><span class="t" title="${esc(fmtDateTime(e.t))}">${fmtTime(e.t)}</span><span class="k">${esc(e.kind)}</span>${e.user ? `<span class="u" data-user="${esc(e.user)}">${esc(e.user)}</span>` : ''}<span class="m">${esc(e.text)}</span></div>`;
const chatHtml = c => `<div class="line chat ${isStarred(c.user) ? 'watched' : ''}"><span class="t" title="${esc(fmtDateTime(c.t))}">${fmtTime(c.t)}</span><span class="u" data-user="${esc(c.user)}">${esc(c.nickname && c.nickname !== c.user ? `${c.nickname} (${c.user})` : c.user)}</span><span class="m">${esc(c.text)}</span></div>`;

/** The log being looked at: the live stream's, or an earlier stream fetched from its file. */
function displayedLog() {
  if (state.logSid && state.pastLog && state.pastLog.room === state.current && state.pastLog.sid === state.logSid) return state.pastLog.entries;
  return state.logs.get(state.current)?.entries ?? [];
}
const showingLive = () => !state.logSid || state.logSid === state.snap?.stream?.sid;

function logLines() {
  const q = state.search.trim().toLowerCase();
  return displayedLog().filter(e => !state.hiddenKinds.has(groupOf(e.kind)) && (!state.starredOnly || isStarred(e.user))
    && (!q || (e.user ?? '').toLowerCase().includes(q) || (e.nickname ?? '').toLowerCase().includes(q)));
}
function chatLines() {
  const q = state.search.trim().toLowerCase();
  return displayedLog().filter(e => e.kind === 'chat' && (!q || e.user.toLowerCase().includes(q) || (e.nickname ?? '').toLowerCase().includes(q) || e.text.toLowerCase().includes(q)));
}

/** Draw the newest `shown` lines with a "show earlier" button above them; keeps the scroll position when expanding. */
function renderLines(el, lines, which, html, empty) {
  const stick = nearBottom(el);
  const start = Math.max(0, lines.length - state.shown[which]);
  const more = start ? `<button class="more" data-more="${which}">Show ${Math.min(LOG_CHUNK, start).toLocaleString()} earlier (${start.toLocaleString()} more above)</button>` : '';
  el.innerHTML = more + lines.slice(start).map(html).join('') || `<p class="note">${empty}</p>`;
  if (stick) el.scrollTop = el.scrollHeight;
}
function renderLog() {
  const all = displayedLog(), lines = logLines();
  $('#log-kinds').innerHTML = KIND_GROUPS.map(g => { const n = all.filter(e => g.kinds.includes(e.kind)).length; return `<button class="chip ${state.hiddenKinds.has(g.key) ? '' : 'on'}" data-kind="${g.key}" title="${state.hiddenKinds.has(g.key) ? 'show' : 'hide'} these">${g.label}<span class="n">${n}</span></button>`; }).join('')
    + `<button class="chip star ${state.starredOnly ? 'on' : ''}" data-kind="star" title="Only lines about pinned or watched accounts">★ pinned &amp; watched</button>`;
  $('#log-count').textContent = `${lines.length.toLocaleString()} of ${all.length.toLocaleString()} lines${showingLive() ? '' : ' · earlier stream'}`;
  renderLines($('#log-list'), lines, 'log', lineHtml, all.length ? 'Nothing matches.' : showingLive() ? 'Nothing yet.' : 'No log was kept for this stream.');
}
function renderChat() {
  renderLines($('#chat-list'), chatLines(), 'chat', chatHtml, displayedLog().length ? 'No chat matches.' : showingLive() ? 'No chat yet.' : 'No log was kept for this stream.');
}
for (const [id, which] of [['#log-list', 'log'], ['#chat-list', 'chat']]) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button[data-more]'); if (!b) return;
    const el = $(id); const before = el.scrollHeight, top = el.scrollTop;
    state.shown[which] += LOG_CHUNK;
    which === 'log' ? renderLog() : renderChat();
    el.scrollTop = top + (el.scrollHeight - before);
  });
}
$('#log-kinds').addEventListener('click', e => {
  const b = e.target.closest('button[data-kind]'); if (!b) return;
  const k = b.dataset.kind;
  if (k === 'star') state.starredOnly = !state.starredOnly;
  else if (state.hiddenKinds.has(k)) state.hiddenKinds.delete(k); else state.hiddenKinds.add(k);
  state.shown.log = LOG_CHUNK;
  renderLog();
});
$('#stream-select').addEventListener('change', async e => {
  const sid = e.target.value;
  state.logSid = sid && sid !== state.snap?.stream?.sid ? sid : null;
  state.shown = { log: LOG_CHUNK, chat: LOG_CHUNK };
  if (state.logSid) {
    try { state.pastLog = { room: state.current, sid, entries: await api.log(state.current, sid) }; }
    catch (err) { toast('Could not read that stream\'s log', err.message, 'error'); state.pastLog = { room: state.current, sid, entries: [] }; }
  }
  if (state.tab === 'log') renderLog(); if (state.tab === 'chat') renderChat();
});

/** Fetch the live log for a room (once per stream). */
async function ensureLog(room, force = false) {
  if (!force && state.logs.has(room)) return;
  let entries = [];
  try { entries = await api.log(room); } catch { /* not monitored any more */ }
  const sid = [...entries].reverse().find(e => e.sid)?.sid ?? null;
  state.logs.set(room, { sid, entries });
}

function appendLine(room, entry) {
  const store = state.logs.get(room);
  if (!store) return; // not loaded yet; selectRoom fetches the whole thing
  if (entry.sid && store.sid && entry.sid !== store.sid) { // a new stream began: start over with its log
    state.logs.delete(room);
    if (room === state.current) ensureLog(room).then(() => { if (state.tab === 'log') renderLog(); if (state.tab === 'chat') renderChat(); });
    return;
  }
  if (entry.sid && !store.sid) store.sid = entry.sid;
  store.entries.push(entry);
  if (room !== state.current || !showingLive()) return;
  if (state.tab === 'log' && !state.hiddenKinds.has(groupOf(entry.kind)) && (!state.starredOnly || isStarred(entry.user))) {
    const q = state.search.trim().toLowerCase();
    if (q && !(entry.user ?? '').toLowerCase().includes(q) && !(entry.nickname ?? '').toLowerCase().includes(q)) return;
    const el = $('#log-list'); const stick = nearBottom(el);
    if (el.firstElementChild?.classList.contains('note')) el.innerHTML = '';
    el.insertAdjacentHTML('beforeend', lineHtml(entry)); if (stick) el.scrollTop = el.scrollHeight;
    $('#log-count').textContent = `${logLines().length.toLocaleString()} of ${displayedLog().length.toLocaleString()} lines`;
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
  const t = d.stream, h = d.history, p = { ...(h?.profile ?? {}) };
  if (t) for (const k of ['followers', 'following', 'verified', 'privateAccount', 'gifterLevel']) if (t[k] != null) p[k] = t[k];
  const yn = v => v == null ? '–' : v ? 'yes' : 'no';
  const kv = pairs => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const watched = roomLists(state.current).watch.includes(d.username);
  const pinned = roomLists(state.current).pinned?.includes(d.username);
  const score = t ? `<div class="scorebox"><span class="score ${scoreClass(t.score)}">${t.score}</span><div class="reasons">${t.reasons.length ? t.reasons.map(r => `<span class="reason ${reasonClass(r)}">${esc(r)}</span>`).join('') : '<span class="none">nothing suspicious</span>'}</div></div>`
    : '<p class="note">Not seen this stream, so no score. Showing history only.</p>';
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
  if (t) parts.push('<h4>This stream</h4>', kv([
    ['first seen', fmtTime(t.firstSeen)], ['last seen', fmtTime(t.lastSeen)],
    ['joins', `${t.joins}${t.lastJoin && t.joins > 1 ? ` (last ${fmtTime(t.lastJoin)})` : ''}`], ['chats', t.chats], ['likes', t.likes], ['gifts', `${t.gifts} (${t.coins} coins)`], ['shares', t.shares],
    ['hops', t.hops ? `${t.hops}, last: ${esc(t.lastHop ? `${fmtTime(t.lastHop.t)} ${t.lastHop.dir} @${t.lastHop.room}` : '')}` : '–'],
    ['flags', t.flags.map(f => `<span class="flag ${flagClass(f)}">${esc(flagText(f))}</span>`).join('') || '–'],
  ]));
  if (h) {
    const cur = d.sid;
    parts.push('<h4>History in this room</h4>', kv([
      ['first seen ever', fmtDateTime(h.firstSeenEver)], ['last seen ever', fmtDateTime(h.lastSeenEver)],
      ['streams seen', `${h.streamsSeen}${t && !h.streams.some(s => s.sid === cur) ? ' + this one' : ''} (${plural(h.daysSeen, 'day')})`],
      ['totals', `${h.totals.joins} joins, ${h.totals.chats} chats, ${h.totals.likes} likes, ${h.totals.gifts} gifts (${h.totals.coins} coins), ${h.totals.hops} hops`],
      ['previous names', h.aliases.length ? h.aliases.map(a => '@' + esc(a)).join(', ') : '–'],
      ['previous nicknames', h.nicknames.length ? esc(h.nicknames.join(', ')) : '–'],
    ]));
    if (h.streams.length) parts.push(`<table class="streams"><thead><tr><th>stream</th><th>joins</th><th>chats</th><th>likes</th><th>gifts</th><th>hops</th></tr></thead><tbody>${[...h.streams].reverse().map(s =>
      `<tr class="${s.sid === cur ? 'current' : ''}" title="seen ${fmtTime(s.firstSeen)}–${fmtTime(s.lastSeen)}"><td>${esc(streamLabel(s.sid))}</td><td>${s.joins}</td><td>${s.chats}</td><td>${s.likes}</td><td>${s.gifts}${s.coins ? ` (${s.coins})` : ''}</td><td>${s.hops ?? 0}</td></tr>`).join('')}</tbody></table>`);
  }
  parts.push('<h4>Other monitored rooms</h4>', d.rooms.length
    ? `<ul class="rooms-list">${d.rooms.map(r => `<li class="${r.blacklisted ? 'bl' : ''}">@${esc(r.room)}${r.blacklisted ? ' <span class="flag bl">blacklisted</span>' : ''}${r.liveNow ? ' <span class="flag bl">in their stream now</span>' : ''}: <span class="${r.follows === true ? 'follows' : 'nofollow'}">${r.follows === true ? 'FOLLOWS host' : r.follows === false ? 'does not follow host' : 'follow status unknown'}</span>, seen ${plural(r.streamsSeen ?? r.daysSeen, 'stream')}, last ${fmtDate(r.lastSeen)}${r.username !== d.username ? ` (as @${esc(r.username)})` : ''}</li>`).join('')}</ul>`
    : `<p class="note">Not seen in any other monitored room${state.snap?.otherRooms?.length ? '' : ' (no other room histories yet)'}.</p>`);

  // Timeline: everything ever logged for pinned/watched accounts; otherwise what this stream's log holds.
  const timeline = (events, title, note) => {
    if (!events.length) return [`<h4>${title}</h4>`, `<p class="note">${note}</p>`];
    const groups = [];
    for (const e of events) { const g = groups[groups.length - 1]; if (g && g.sid === (e.sid ?? null)) g.items.push(e); else groups.push({ sid: e.sid ?? null, items: [e] }); }
    return [`<h4>${title} (${events.length.toLocaleString()})</h4>`, `<div class="timeline">${groups.map(g => `<div class="tl-stream">${g.sid ? `stream ${esc(streamLabel(g.sid))}` : 'no stream'} · ${plural(g.items.length, 'event')}</div>${g.items.map(e => `<div class="line ${esc(e.kind)}"><span class="t" title="${esc(fmtDateTime(e.t))}">${fmtTime(e.t)}</span><span class="k">${esc(e.kind)}</span><span class="m">${esc(e.text)}</span></div>`).join('')}`).join('')}</div>`];
  };
  if (d.retained) parts.push(...timeline(d.events, 'Everything logged', 'Nothing logged yet. Events are kept from now on.'));
  else {
    const names = new Set([d.username, ...(h?.aliases ?? [])]);
    const mine = (state.logs.get(state.current)?.entries ?? []).filter(e => e.user && names.has(e.user) && !['system', 'status', 'error'].includes(e.kind));
    const fallback = mine.length ? mine : d.chat.map(c => ({ t: c.t, sid: d.sid, kind: 'chat', text: c.text }));
    parts.push(...timeline(fallback, 'This stream', 'Nothing logged this stream.'), '<p class="note">Pin or watch this account to keep everything it does, across streams, forever.</p>');
  }
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
  renderRooms(); renderHeader(); renderLists();
}

async function refreshSnapshot() {
  if (!state.current) { state.snap = null; renderHeader(); renderTable(); return; }
  try { state.snap = await api.snapshot(state.current); } catch { state.snap = null; }
  renderHeader();
  if (state.tab === 'users') renderTable();
  if (state.tab === 'burners' || state.tab === 'blacklist') renderSuspects();
  if (state.detailUser && !$('#detail').hidden) renderDetail();
}

async function selectRoom(room) {
  state.current = room;
  state.logSid = null; state.pastLog = null; state.shown = { log: LOG_CHUNK, chat: LOG_CHUNK };
  closeDetail();
  await ensureLog(room);
  renderRooms(); renderLists();
  await refreshSnapshot();
  renderLog(); renderChat();
}

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tab-btn')) b.classList.toggle('active', b.dataset.tab === tab);
  const panel = { users: 'tab-users', burners: 'tab-suspects', blacklist: 'tab-suspects', chat: 'tab-chat', log: 'tab-log' }[tab];
  for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== panel;
  $('#stream-wrap').hidden = !(tab === 'log' || tab === 'chat');
  $('#search').placeholder = tab === 'chat' ? 'search username or message' : 'search username or nickname';
  if (tab === 'users') renderTable(); if (panel === 'tab-suspects') renderSuspects(); if (tab === 'log') renderLog(); if (tab === 'chat') renderChat();
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
    case 'hop':
      toast(`↔ @${ev.user} in @${ev.room}`, ev.text, 'flag', 15000, { room: ev.room, user: ev.user });
      if (ev.room === state.current) scheduleRefresh();
      break;
    case 'status': case 'rooms': {
      state.rooms = ev.rooms ?? state.rooms; renderRooms(); renderHeader(); renderLists();
      // a room moved on to a new stream: its log starts over
      const store = ev.type === 'status' ? state.logs.get(ev.room) : null;
      if (store && ev.sid && store.sid && ev.sid !== store.sid) { state.logs.delete(ev.room); if (ev.room === state.current) ensureLog(ev.room).then(() => { if (state.tab === 'log') renderLog(); if (state.tab === 'chat') renderChat(); }); }
      if (ev.type === 'status' && ev.room === state.current) scheduleRefresh();
      if (!state.current && state.rooms.length) selectRoom(state.rooms[0].room);
      break;
    }
    case 'users': if (ev.room === state.current) scheduleRefresh(); break;
    case 'lists': state.config = { ...state.config, lists: { ...(state.config?.lists ?? {}), [ev.room]: { watch: ev.watch, blacklist: ev.blacklist, pinned: ev.pinned ?? [] } } }; renderLists(); scheduleRefresh(); break;
    case 'saved': if (ev.room === state.current) toast(`@${ev.room} saved`, `${ev.count} users written to the stream snapshot and the room history`, 'ok', 4000); break;
  }
});

// ---------- help ----------
const HELP = {
  blacklist: {
    title: 'Blacklist: streamers to cross-check against',
    body: `
<p>The blacklist holds <b>other streamers</b>, not viewers. Rat Trap uses their rooms as reference points: for everyone in this room it checks whether they overlap with a blacklisted streamer, and puts them on the <b>Blacklist hits</b> tab if so.</p>
<p>It belongs to <b>this room only</b>. Each room you monitor has its own blacklist.</p>
<p><b>Setup:</b> add the other streamer as a room in the Rooms list <i>and</i> put them on this room's blacklist. Rat Trap can only learn who is in their room, and who follows them, by sitting in that room while they are live. A blacklist entry whose room is not in the Rooms list shows a <b>not monitored</b> tag; click it to add the room.</p>
<p>A viewer here is a hit when any of these is true:</p>
<ul>
  <li><b>Hopped.</b> They were seen in the blacklisted streamer's live stream and then joined here, or the other way round. Announced <i>every</i> time it happens, with the time gap ("came from @x's stream, seen there 3m earlier"). This is the strongest sign that someone is going between the two rooms.</li>
  <li><b>In their stream now.</b> Both streams are live and the same account has been seen in both.</li>
  <li><b>Follows them.</b> TikTok reports, inside the streamer's own room, whether each viewer follows that host. Rat Trap remembers it, so this keeps working on later days even when the streamer is offline.</li>
  <li><b>Seen in their room before.</b> The account appears in that room's history from an earlier stream.</li>
</ul>
<p>A hit adds points to the burner score, fires an alert, and tags the viewer <code>↔ @name</code>, <code>in @name's stream</code> or <code>seen at @name</code> in the tables and the detail drawer.</p>
<div class="example"><b>Example.</b> You monitor <code>@alice</code> and <code>@bob</code>. Add <code>@bob</code> to <code>@alice</code>'s blacklist. When someone sitting in <code>@bob</code>'s stream walks into <code>@alice</code>'s room, you get an alert in <code>@alice</code>'s room saying how long ago they were seen at <code>@bob</code>'s.</div>
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
  <li>is highlighted in the Log tab (and the <b>★ pinned &amp; watched</b> filter there shows only them),</li>
  <li>and the account is tagged <code>watch</code> in the tables.</li>
</ul>
<p>Watched accounts, like pinned ones, keep <b>everything they have ever done</b> in this room in the history: every chat message, join, gift and hop, across streams, however old the logs get.</p>
<p>Add someone by typing their username below, or with the <b>Watch</b> button in a viewer's detail drawer.</p>
<div class="example"><b>Typical flow.</b> The Blacklist hits or Burners tab surfaces an account. Put it on the watch list, and from then on every move it makes in this room is announced and kept.</div>
<p><b>Pinning</b> (Burners and Blacklist hits tabs) keeps an account on those lists when you press <b>Dismiss all</b>, shows it even with a score of 0, and keeps its full history like the watch list does, but without the toasts. Pin what you want to keep looking at; watch what you want to be told about.</p>`,
  },
  streams: {
    title: 'Streams and the log',
    body: `
<p>A <b>stream</b> is one TikTok live session. Rat Trap names each one by the moment it started monitoring it, for example <code>2026-09-08 21:00</code>. The Users, Burners and Blacklist hits tabs always show the <b>current (or most recent) stream</b>; the header says which. A restart in the middle of a stream picks the same stream back up.</p>
<p>The <b>Log</b> and <b>Chat</b> tabs show one stream at a time: pick it with the <b>Stream</b> drop-down. The whole log is kept, nothing rolls off. Only the newest lines are drawn at first; <b>Show earlier</b> loads more. Filter by kind with the chips, by account with the search box, and use <b>★ pinned &amp; watched</b> to see only the accounts you care about.</p>
<p>TikTok never says when someone <b>leaves</b>, so Rat Trap does not guess: there are no "left" lines and no idle timeouts. A repeated join means the account left and came back; the log says which time it is.</p>
<p>Each stream's log is a file in the data folder (<code>log-&lt;room&gt;-&lt;stream&gt;.jsonl</code>, one JSON object per line). They are kept forever unless <b>Delete stream logs older than</b> is set in Settings. Pinned and watched accounts keep their events inside the room history regardless, so their full record never goes away.</p>
<p>The detail drawer of any account lists every stream it was seen in, with its joins, chats, likes, gifts and hops for each, so you can tell a first-timer from a regular at a glance.</p>`,
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
    const clean = name.replace(/^@/, '').toLowerCase();
    if (list === 'blacklist' && !isMonitored(clean)) toast('Blacklisted, but not monitored', `Rat Trap can only see who is in @${clean}'s stream, and who follows them, by sitting in their room. Add them as a room too.`, '', 15000, null, { label: `Add @${clean} as a room`, run: () => addBlacklistedRoom(clean) });
  });
}
document.addEventListener('click', async e => {
  const x = e.target.closest('button.x[data-list]');
  if (x) { await api.editList(state.current, x.dataset.list, 'remove', [x.dataset.name]); await loadConfig(); scheduleRefresh(); return; }
  const add = e.target.closest('button[data-add-room]');
  if (add) { add.disabled = true; await addBlacklistedRoom(add.dataset.addRoom); return; }
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
$('#search').addEventListener('input', e => {
  state.search = e.target.value; state.shown = { log: LOG_CHUNK, chat: LOG_CHUNK };
  if (state.tab === 'users') renderTable(); else if (state.tab === 'burners' || state.tab === 'blacklist') renderSuspects(); else if (state.tab === 'chat') renderChat(); else if (state.tab === 'log') renderLog();
});
$('#detail-close').addEventListener('click', closeDetail);
$('#btn-save').addEventListener('click', async () => { try { await api.save(state.current); } catch (err) { toast('Save failed', err.message, 'error'); } });
$('#btn-reconnect').addEventListener('click', () => api.reconnectRoom(state.current));
$('#btn-remove').addEventListener('click', async () => {
  if (!state.current || !confirm(`Stop monitoring @${state.current}? This stream's data is saved first.`)) return;
  await api.removeRoom(state.current); state.current = null; await refreshRooms(); await refreshSnapshot(); renderLists(); renderLog(); renderChat();
});
$('#btn-data').addEventListener('click', () => api.openData());

// settings
$('#btn-settings').addEventListener('click', async () => {
  await loadConfig();
  const f = $('#settings-form');
  for (const el of f.elements) { if (!el.name) continue; if (el.type === 'checkbox') el.checked = !!state.config[el.name]; else el.value = state.config[el.name] ?? ''; }
  $('#settings-path').textContent = `Saved to ${state.config.configFile}. Rooms, blacklist, watch list and pins are saved as you edit them.`;
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
