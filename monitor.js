// Monitor: everything TikTok Rat Trap knows about one TikTok LIVE room, with no user interface attached.
//
// Owns the connection, the current stream's tracker, the long-term history, scoring, the event
// log, and saving. Emits:
//   'status'  { room, state, message, sid }   state: connecting | live | waiting | reconnecting | offline | stopped
//   'log'     { t, kind, text, sid, user?, watched, alert, chat? }   one line for the event log
//   'flag'    { t, user, nickname, score, reasons, blacklisted }     score alert (once per user per stream)
//   'hop'     { t, user, nickname, text, hop, ... }                   moved between here and a blacklisted stream
//   'join'    { room, user, t }               someone entered (used to cross-check other rooms)
//   'saved'   { file, count }
//   'users'   nothing; throttled hint that the user table changed
//
// A *stream* is one TikTok live session. Everything is tracked per stream: the Users list, the
// event log (data/log-<room>-<sid>.jsonl, the whole thing, reloaded on restart) and the history
// stats. A stream is identified by TikTok's room id, so a restart or reconnect mid-stream picks
// the same stream up again; a new room id starts a fresh one.
//
// TikTok sends no "user left" event, so nobody is ever marked as gone. In busy rooms TikTok samples
// join/like events, so not every viewer will appear. On connect TikTok hands over a backlog of
// recent events; those are processed too, stamped with TikTok's own timestamps.

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join as pathJoin, dirname, isAbsolute } from 'node:path';
import { TikTokLiveConnection, WebcastEvent, ControlEvent, UserOfflineError, SignatureRateLimitError } from 'tiktok-live-connector';
import { ViewerTracker } from './tracker.js';
import { RoomHistory, historyFile, loadRoomIndex, makeSid, streamLabel, dateOf, RETAINED_KINDS } from './history.js';
import { scoreUser, hopText } from './burner.js';

export const DEFAULTS = {
  username: 'the_great_sir_stromburg',
  rooms: [],                 // rooms opened on start (falls back to `username`)
  lists: {},                 // per room: { "<room>": { watch: [...], blacklist: [...], pinned: [...] } }
  burnerAlertScore: 6,
  signApiKey: '',
  dataDir: 'data',
  autosaveMinutes: 5,
  resume: true,
  reconnectWhenLive: true,
  livePollSeconds: 60,
  chatHistory: 50,
  pruneAfterDays: 0,         // forget accounts not seen for this many days (0 = keep forever); pinned/watched are kept
  maxUsers: 10000,           // cap on the current stream's list; the oldest accounts are trimmed (kept in history)
  popupSeconds: 8,           // how long activity popups (watched accounts, burners, hops, saves) stay; 0 = none
  logKeepDays: 0,            // delete per-stream log and snapshot files older than this (0 = keep forever); pinned/watched accounts' events are kept in the history
};

export const normalizeUsername = s => String(s ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/, '').replace(/\/.*$/, '').toLowerCase();
export const nameSet = list => new Set((list instanceof Set ? [...list] : list ?? []).map(normalizeUsername).filter(Boolean));

/** Merge DEFAULTS with a config file's contents. Throws on unparsable JSON. */
export function readConfigFile(file) {
  let fromFile = {};
  if (existsSync(file)) fromFile = JSON.parse(readFileSync(file, 'utf8'));
  return { ...DEFAULTS, ...fromFile };
}

/** Validate and normalise a config object in place (Sets for name lists, numbers checked). */
export function normalizeConfig(cfg, baseDir) {
  cfg.username = normalizeUsername(cfg.username);
  cfg.rooms = [...nameSet(cfg.rooms)];
  // Older configs had one global watch/blacklist; they become the starting lists of every room.
  cfg.legacyLists = { watch: nameSet(cfg.watch), blacklist: nameSet(cfg.blacklist) };
  delete cfg.watch; delete cfg.blacklist;
  // keys from older versions: terminal client, idle timeouts (TikTok never reports leaves), plain-text log files
  for (const k of ['logEvents', 'logChat', 'idleTimeoutMinutes', 'chatToFile', 'eventsToFile']) delete cfg[k];
  const lists = {};
  for (const [room, l] of Object.entries(cfg.lists ?? {})) {
    const r = normalizeUsername(room); if (!r) continue;
    lists[r] = { watch: nameSet(l?.watch), blacklist: nameSet(l?.blacklist), pinned: nameSet(l?.pinned) };
  }
  cfg.lists = lists;
  cfg.burnerAlertScore = Number(cfg.burnerAlertScore);
  if (!Number.isFinite(cfg.burnerAlertScore)) throw new Error('burnerAlertScore must be a number');
  cfg.autosaveMinutes = Math.max(0, Number(cfg.autosaveMinutes) || 0);
  cfg.livePollSeconds = Math.max(30, Number(cfg.livePollSeconds) || 60);
  cfg.chatHistory = Math.max(1, Number(cfg.chatHistory) || 50);
  cfg.pruneAfterDays = Math.max(0, Number(cfg.pruneAfterDays) || 0);
  cfg.logKeepDays = Math.max(0, Number(cfg.logKeepDays) || 0);
  cfg.popupSeconds = Math.max(0, Number(cfg.popupSeconds ?? DEFAULTS.popupSeconds) || 0);
  cfg.maxUsers = Math.max(0, Math.floor(Number(cfg.maxUsers)) || 0); // 0 = unlimited
  cfg.signApiKey = String(cfg.signApiKey ?? '');
  if (baseDir && !isAbsolute(cfg.dataDir)) cfg.dataDir = pathJoin(baseDir, cfg.dataDir);
  return cfg;
}

/** The watch/blacklist for one room, created (from the legacy global lists) on first use. */
export function roomLists(cfg, room) {
  const r = normalizeUsername(room);
  if (!cfg.lists[r]) cfg.lists[r] = { watch: new Set(cfg.legacyLists?.watch ?? []), blacklist: new Set(cfg.legacyLists?.blacklist ?? []), pinned: new Set() };
  if (!cfg.lists[r].pinned) cfg.lists[r].pinned = new Set();
  return cfg.lists[r];
}

/** Plain-JSON view of a config (Sets become arrays) for saving or sending to a renderer. */
export function configToJSON(cfg) {
  const { legacyLists, ...rest } = cfg;
  return { ...rest, lists: Object.fromEntries(Object.entries(cfg.lists).map(([r, l]) => [r, { watch: [...l.watch], blacklist: [...l.blacklist], pinned: [...(l.pinned ?? [])] }])) };
}

/**
 * When the current stream started, in ms, from TikTok's room info (`create_time`/`start_time`, unix seconds
 * or ms). Returns null when absent or implausible (in the future, or more than 3 days before `now`).
 */
export function streamStart(info, now = Date.now()) {
  for (const k of ['create_time', 'start_time']) {
    let t = Number(info?.[k]);
    if (!Number.isFinite(t) || t <= 0) continue;
    if (t < 1e12) t *= 1000; // seconds -> ms
    if (t <= now && now - t <= 3 * 24 * 60 * 60_000) return t;
  }
  return null;
}

const DAY_MS = 24 * 60 * 60_000;

export class Monitor extends EventEmitter {
  /**
   * @param {string} username   streamer to monitor
   * @param {object} cfg        shared, normalised config (edited live by the UI)
   * @param {object} [opts]
   * @param {Function} [opts.createConnection]  (username, options) => connection; for tests
   * @param {Function} [opts.peers]             () => other Monitors running in this process (live cross-checks)
   */
  constructor(username, cfg, opts = {}) {
    super();
    this.username = normalizeUsername(username);
    if (!this.username) throw new Error('no username given');
    this.cfg = cfg;
    this.lists = roomLists(cfg, this.username); // this room's own watch list, blacklist and pins
    this.createConnection = opts.createConnection ?? ((u, o) => new TikTokLiveConnection(u, o));
    this.peers = opts.peers ?? (() => []);
    this.tracker = new ViewerTracker({ chatHistory: cfg.chatHistory });
    this.history = new RoomHistory(this.username, historyFile(cfg.dataDir, this.username));
    this.roomIndex = loadRoomIndex(cfg.dataDir, this.username);
    this.room = { id: null, title: null, viewers: null, totalViewers: null, likes: null, live: false, connectedAt: null, streamStartedAt: null };
    this.stream = null;       // { sid, roomId, title, startedAt, monitoredAt, endedAt } — the stream the tracker and log belong to
    this.logLines = [];       // the current stream's whole event log
    this.flagged = new Map(); // username -> { t, score, reasons, blacklisted, hop? }
    this.state = 'stopped';
    this.stateMessage = '';
    this.startedAt = null;
    this.conn = null;
    this.backlog = false; // true while the initial (pre-connection) batch is being replayed
    this.quitting = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 10_000;
    this.timers = [];
  }

  // ---------- files ----------
  snapshotFileFor(sid) { return pathJoin(this.cfg.dataDir, `viewers-${this.username}-${sid}.json`); }
  logFileFor(sid) { return pathJoin(this.cfg.dataDir, `log-${this.username}-${sid}.jsonl`); }
  get snapshotFile() { return this.stream ? this.snapshotFileFor(this.stream.sid) : null; }
  get logFile() { return this.stream ? this.logFileFor(this.stream.sid) : null; }

  // ---------- lifecycle ----------
  start() {
    if (this.state !== 'stopped') return this;
    this.quitting = false;
    this.startedAt = Date.now();
    try {
      const n = this.history.load();
      if (n) this._log('system', `history: ${n} users known in this room, ${Object.keys(this.history.streams).length} streams`);
      this.pruneHistory();
      this.cleanOldFiles();
    } catch (e) { this._log('error', `could not load ${this.history.file}: ${e.message}`); }
    // Pick the last stream back up so its users and log are there while we wait for the next one.
    const latest = this.history.latestStream();
    if (this.cfg.resume && latest) this._loadStream(latest, true);
    this.conn = this.createConnection(this.username, { ...(this.cfg.signApiKey ? { signApiKey: this.cfg.signApiKey } : {}), processInitialData: true });
    this._bind(this.conn);
    if (this.cfg.autosaveMinutes > 0) this.timers.push(setInterval(() => { try { this.save(); } catch (e) { this._log('error', `autosave failed: ${e.message}`); } }, this.cfg.autosaveMinutes * 60_000));
    for (const t of this.timers) t.unref?.();
    this._connect();
    return this;
  }

  /** Save, disconnect, stop timers. */
  stop() {
    if (this.quitting) return;
    this.quitting = true;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    try { if (this.tracker.users.size) this.save(); } catch (e) { this._log('error', `save failed: ${e.message}`); }
    try { this.conn?.disconnect(); } catch { /* ignore */ }
    this.room.live = false; this.room.streamStartedAt = null;
    this._setState('stopped', 'stopped');
  }

  reconnect() {
    try { this.conn?.disconnect(); } catch { /* ignore */ }
    this.reconnectDelay = 10_000;
    setTimeout(() => this._connect(), 1000).unref?.();
  }

  async _connect() {
    if (this.quitting) return;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    try {
      this._setState('connecting', 'connecting…');
      this.backlog = true; // the library replays the initial batch before connect() resolves
      let state;
      // Events replayed during connect() belong to the stream we are about to identify; hold them until then.
      this._pending = [];
      try { state = await this.conn.connect(); } finally { this.backlog = false; }
      this.reconnectDelay = 10_000;
      const now = Date.now();
      this.room.id = state?.roomId ?? null; this.room.live = true; this.room.connectedAt = now;
      const info = state?.roomInfo?.data ?? state?.roomInfo ?? {};
      this.room.title = info.title ?? null;
      this._beginStream(this.room.id, info, now);
      if (info.user_count) this.room.viewers = Number(info.user_count);
      this._setState('live', `connected${this.room.title ? ` — "${this.room.title}"` : ''}`);
      const pending = this._pending; this._pending = null;
      this.backlog = true;
      try { for (const fn of pending) fn(); } finally { this.backlog = false; }
    } catch (err) {
      this._pending = null;
      this.room.live = false;
      if (this.quitting) return;
      if (err instanceof UserOfflineError || /offline|not.*live/i.test(err?.message ?? '')) {
        this.room.streamStartedAt = null;
        if (!this.cfg.reconnectWhenLive) { this._setState('offline', 'not live'); return; }
        this._setState('waiting', `not live, checking every ${this.cfg.livePollSeconds}s`);
        try { await this.conn.waitUntilLive(this.cfg.livePollSeconds); }
        catch (e) { this._log('error', `live check failed: ${e.message}`); return this._scheduleReconnect(); }
        if (this.quitting) return;
        this._log('system', 'went live!');
        return this._connect();
      }
      if (err instanceof SignatureRateLimitError) this.reconnectDelay = Math.max(this.reconnectDelay, 60_000);
      this._log('error', `connect failed: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.quitting || this.reconnectTimer) return;
    this._setState('reconnecting', `retrying in ${Math.round(this.reconnectDelay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._connect(); }, this.reconnectDelay);
    this.reconnectTimer.unref?.();
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5 * 60_000);
  }

  _setState(state, message) {
    this.state = state; this.stateMessage = message;
    this._log(state === 'live' ? 'system' : 'status', message);
    this.emit('status', { room: this.username, state, message, sid: this.stream?.sid ?? null });
  }

  // ---------- streams ----------
  /**
   * Work out which stream we just connected to. The same TikTok room id means the same stream
   * (a reconnect or a restart mid-stream); anything else starts a new one.
   */
  _beginStream(roomId, info, now = Date.now()) {
    const known = roomId ? (this.stream?.roomId === roomId ? this.stream : this.history.findStreamByRoomId(roomId)) : null;
    // No room id from TikTok (rare): assume an unended stream monitored in the last 12 hours is the same one.
    const sameByAge = !roomId && this.stream && !this.stream.endedAt && now - this.stream.monitoredAt < 12 * 3600_000;
    let stream = known ?? (sameByAge ? this.stream : null);
    const fresh = !stream;
    if (fresh) {
      let sid = makeSid(now);
      while (this.history.streams[sid]) sid += 'b'; // two streams in the same minute
      stream = { sid, roomId: roomId ?? null, title: info?.title ?? null, startedAt: streamStart(info, now) ?? now, monitoredAt: now, endedAt: null };
    } else {
      stream.endedAt = null;
      if (info?.title) stream.title = info.title;
      if (!stream.startedAt) stream.startedAt = streamStart(info, now) ?? stream.monitoredAt;
    }
    if (stream !== this.stream) this._loadStream(stream, !fresh);
    this.history.touchStream(stream);
    this.room.streamStartedAt = stream.startedAt;
    this._log('system', fresh ? `new stream, monitored since ${streamLabel(stream.sid)}` : `continuing the stream monitored since ${streamLabel(stream.sid)}`);
    return stream;
  }

  /** Make `stream` the current one: put the old one to bed, then load the new one's snapshot and log (if `resume`). */
  _loadStream(stream, resume) {
    if (this.stream && this.tracker.users.size) { try { this.save(); } catch (e) { this._log('error', `save failed: ${e.message}`); } }
    this.stream = stream;
    this.tracker = new ViewerTracker({ chatHistory: this.cfg.chatHistory });
    this.flagged = new Map();
    this.logLines = this.logLines.filter(e => !e.sid); // keep the start-up lines that belong to no stream
    if (!resume) return;
    const snap = this.snapshotFile;
    if (existsSync(snap)) {
      try { const n = this.tracker.load(JSON.parse(readFileSync(snap, 'utf8'))); this._log('system', `resumed ${n} user records from the stream monitored since ${streamLabel(stream.sid)}`); }
      catch (e) { this._log('error', `could not load ${snap}: ${e.message}`); }
    }
    const lines = this.readLog(stream.sid);
    if (lines.length) this.logLines = [...lines, ...this.logLines]; // the file's lines are older than this run's start-up lines
  }

  /** The log of one stream, from its file. */
  readLog(sid) {
    const file = this.logFileFor(sid);
    if (!existsSync(file)) return [];
    const out = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try { out.push({ ...JSON.parse(line), room: this.username }); } catch { /* a torn last line after a crash */ }
    }
    return out;
  }

  /** Delete per-stream log and snapshot files older than cfg.logKeepDays (if enabled). Retained events live in the history. */
  cleanOldFiles(now = Date.now()) {
    const days = this.cfg.logKeepDays;
    if (!(days > 0)) return 0;
    const cutoff = dateOf(now - days * DAY_MS);
    let n = 0;
    let files = [];
    try { files = readdirSync(this.cfg.dataDir); } catch { return 0; }
    const re = new RegExp(`^(?:log|viewers)-${this.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{4}-\\d\\d-\\d\\d)[^/]*\\.(?:jsonl|json)$`);
    for (const f of files) {
      const m = re.exec(f);
      if (!m || m[1] >= cutoff) continue;
      try { unlinkSync(pathJoin(this.cfg.dataDir, f)); n++; } catch { /* ignore */ }
    }
    if (n) this._log('system', `deleted ${n} log/snapshot file${n === 1 ? '' : 's'} older than ${days} days`);
    return n;
  }

  // ---------- events from TikTok ----------
  /** When the event happened: TikTok's own timestamp if it is sane, otherwise now. */
  eventTime(d, now = Date.now()) {
    const t = Number(d?.common?.createTime);
    if (!Number.isFinite(t) || t <= 0) return now;
    const ms = t < 1e12 ? t * 1000 : t; // seconds vs milliseconds
    return ms > now - 6 * 60 * 60_000 && ms <= now + 60_000 ? ms : now;
  }

  /** Wrap an event handler so events replayed during connect() wait until the stream is identified. */
  _on(conn, ev, fn) {
    conn.on(ev, d => { if (this._pending) this._pending.push(() => fn(d)); else fn(d); });
  }

  _bind(conn) {
    this._on(conn, WebcastEvent.MEMBER, d => {
      const w = who(d); if (!w) return;
      const t = this.eventTime(d);
      const again = this.tracker.users.get(w.username)?.joins > 0;
      const u = this.tracker.join(w.username, w.info, t);
      if (typeof d.memberCount === 'number' && d.memberCount > 0) this.room.viewers = d.memberCount;
      const late = this.backlog ? ' (before Rat Trap connected)' : '';
      this._log(again ? 'rejoin' : 'join', `${again ? `joined again (${ordinal(u.joins)} time)` : 'joined'}${late}`, u, { t, backlog: this.backlog });
      this._checkHops(u, t);
      this._maybeFlag(u);
      this._changed();
      this.emit('join', { room: this.username, user: u.username, t });
    });
    this._on(conn, WebcastEvent.CHAT, d => {
      const w = who(d); if (!w) return;
      const t = this.eventTime(d);
      const text = d.content ?? d.comment ?? '';
      const u = this.tracker.activity(w.username, w.info, 'chat', { text }, t);
      this._log('chat', text, u, { chat: true, t, backlog: this.backlog });
      this._maybeFlag(u);
      this._changed();
    });
    this._on(conn, WebcastEvent.LIKE, d => {
      const w = who(d); if (!w) return;
      this.tracker.activity(w.username, w.info, 'like', { count: Number(d.count) || 1 }, this.eventTime(d));
      if (d.total) this.room.likes = Number(d.total);
      this._changed();
    });
    this._on(conn, WebcastEvent.GIFT, d => {
      const w = who(d); if (!w) return;
      const t = this.eventTime(d);
      // Streak gifts repeat with repeatEnd=0 until the final message (repeatEnd=1); count only the final one.
      const streak = d.gift?.type === 1 || d.gift?.combo === true;
      if (streak && !d.repeatEnd) { this.tracker.activity(w.username, w.info, null, {}, t); return; }
      const count = Number(d.repeatCount) || 1;
      const coins = (Number(d.gift?.diamondCount) || 0) * count;
      const u = this.tracker.activity(w.username, w.info, 'gift', { count, coins }, t);
      this._log('gift', `${d.gift?.name ?? d.giftId} x${count}${coins ? ` (${coins} coins)` : ''}`, u, { t, backlog: this.backlog });
      this._changed();
    });
    this._on(conn, WebcastEvent.FOLLOW, d => {
      const w = who(d); if (!w) return;
      const t = this.eventTime(d);
      const u = this.tracker.activity(w.username, w.info, 'follow', {}, t);
      this._log('follow', 'followed', u, { t, backlog: this.backlog });
      this._changed();
    });
    this._on(conn, WebcastEvent.SHARE, d => {
      const w = who(d); if (!w) return;
      const t = this.eventTime(d);
      const u = this.tracker.activity(w.username, w.info, 'share', {}, t);
      this._log('share', 'shared the stream', u, { t, backlog: this.backlog });
      this._changed();
    });
    for (const ev of [WebcastEvent.EMOTE, WebcastEvent.SOCIAL, WebcastEvent.QUESTION_NEW, WebcastEvent.ENVELOPE]) {
      this._on(conn, ev, d => { const w = who(d); if (w) this.tracker.activity(w.username, w.info, null, {}, this.eventTime(d)); });
    }
    this._on(conn, WebcastEvent.ROOM_USER, d => {
      const total = Number(d.total); if (Number.isFinite(total) && total > 0) this.room.viewers = total;
      const tu = Number(d.totalUser); if (Number.isFinite(tu) && tu > 0) this.room.totalViewers = tu;
      const t = this.eventTime(d);
      for (const r of d.ranks ?? []) { const w = who(r); if (w) this.tracker.activity(w.username, w.info, null, {}, t); }
    });
    conn.on(WebcastEvent.STREAM_END, () => {
      this.room.live = false; this.room.streamStartedAt = null;
      if (this.stream) { this.stream.endedAt = Date.now(); this.history.touchStream(this.stream); }
      try { this.save(); } catch (e) { this._log('error', `save failed: ${e.message}`); }
      this._setState('waiting', 'stream ended');
      this._changed();
      if (!this.quitting && this.cfg.reconnectWhenLive) this._scheduleReconnect();
    });
    conn.on(ControlEvent.DISCONNECTED, ({ code, reason } = {}) => {
      if (this.quitting) return;
      this.room.live = false;
      this._log('status', `disconnected${code ? ` (${code}${reason ? `: ${reason}` : ''})` : ''}`);
      this._scheduleReconnect();
    });
    conn.on(ControlEvent.ERROR, e => {
      if (e?.info === 'Error while connecting') return; // connect() rejects with the same error; handled there
      this._log('error', `error: ${e?.info ?? e?.exception?.message ?? e?.message ?? e}`);
    });
  }

  _changed() {
    if (this.cfg.maxUsers > 0 && this.tracker.users.size > this.cfg.maxUsers) this._trimUsers();
    if (this._changeTimer) return;
    this._changeTimer = setTimeout(() => { this._changeTimer = null; this.emit('users'); }, 500);
    this._changeTimer.unref?.();
  }

  /**
   * The stream's list is over cfg.maxUsers: drop the accounts seen longest ago (never pinned or
   * watched ones) down to 95% of the cap. Their stream stats are written to history first, so
   * only the working record goes; if they come back they start a fresh one.
   */
  _trimUsers() {
    const max = this.cfg.maxUsers;
    const excess = this.tracker.users.size - Math.floor(max * 0.95);
    if (excess <= 0) return 0;
    const stale = [...this.tracker.users.values()].filter(u => !this.pinned(u.username) && !this.watched(u.username)).sort((a, b) => a.lastSeen - b.lastSeen);
    const evict = stale.slice(0, excess);
    if (!evict.length) return 0;
    if (this.stream) this.history.update(evict, this.stream.sid);
    for (const u of evict) this.tracker.users.delete(u.username);
    this._log('system', `list is over ${max} accounts: trimmed the ${evict.length} seen longest ago (they stay in history)`);
    return evict.length;
  }

  _log(kind, text, u = null, extra = {}) {
    const entry = { t: Date.now(), kind, text, room: this.username, sid: this.stream?.sid ?? null, ...extra };
    if (u) { entry.user = u.username; entry.nickname = u.nickname; entry.watched = this.watched(u.username); entry.pinned = this.pinned(u.username); }
    entry.alert = !!(entry.watched || kind === 'flag' || kind === 'hop' || kind === 'error');
    this.logLines.push(entry);
    this._toFile(entry);
    if (u && (entry.pinned || entry.watched) && RETAINED_KINDS.has(kind)) this.history.addEvent(u, entry);
    this.emit('log', entry);
    return entry;
  }

  /** Append the entry to the current stream's log file. Failures are reported once. */
  _toFile(entry) {
    const file = this.logFile;
    if (!file || !entry.sid) return;
    const { room, ...line } = entry;
    try {
      if (!this._fileDirReady) { mkdirSync(dirname(file), { recursive: true }); this._fileDirReady = true; }
      appendFileSync(file, JSON.stringify(line) + '\n');
    } catch (e) {
      if (!this._fileError) { this._fileError = true; this.emit('log', { t: Date.now(), kind: 'error', text: `could not write ${file}: ${e.message}`, room: this.username, alert: true }); }
    }
  }

  _maybeFlag(u) {
    if (this.flagged.has(u.username)) return;
    const a = this.assess(u);
    if (!a.blacklisted.length && a.score < this.cfg.burnerAlertScore) return;
    const flag = { t: Date.now(), user: u.username, nickname: u.nickname, ...a };
    this.flagged.set(u.username, flag);
    this._log('flag', `score ${a.score}: ${a.reasons.join('; ')}`, u);
    this.emit('flag', { room: this.username, ...flag });
  }

  // ---------- cross-room hops ----------
  /** `u` just joined here: was it seen in a blacklisted streamer's current stream? */
  _checkHops(u, t) {
    for (const p of this._peers(true)) {
      const there = p.room.live ? p.tracker.users.get(u.username) : null;
      if (there) this._hop(u, 'from', p.username, t - there.lastSeen, t);
    }
  }

  /**
   * Called when `username` enters another monitored room. If that room is on this room's blacklist
   * and the account has been seen in this stream, announce the move.
   */
  peerJoined(room, username, t = Date.now()) {
    if (!this.lists.blacklist.has(room) || !this.room.live) return;
    const u = this.tracker.users.get(username);
    if (u) this._hop(u, 'to', room, t - u.lastSeen, t);
  }

  _hop(u, dir, room, gapMs, t) {
    if (!this.tracker.hop(u.username, dir, room, gapMs, t)) return; // same move announced under a minute ago
    const hop = u.hops[u.hops.length - 1];
    const a = this.assess(u);
    const text = hopText(hop);
    const flag = { t, user: u.username, nickname: u.nickname, ...a, hop, text };
    this.flagged.set(u.username, flag);
    this._log('hop', text, u, { t, hop, backlog: this.backlog });
    this.emit('hop', { room: this.username, ...flag });
    this._changed();
  }

  // ---------- queries ----------
  watched(username) { return this.lists.watch.has(username.toLowerCase()); }
  pinned(username) { return this.lists.pinned.has(username.toLowerCase()); }

  /** Hide accounts from the suspect lists (until they join again). Pinned accounts are never dismissed. */
  dismiss(usernames, now = Date.now()) {
    let n = 0;
    for (const name of usernames) {
      const u = this.tracker.get(name);
      if (!u || this.pinned(u.username) || u.dismissedAt !== null) continue;
      u.dismissedAt = now; n++;
    }
    if (n) this._changed();
    return n;
  }
  undismiss(usernames) {
    let n = 0;
    for (const name of usernames) { const u = this.tracker.get(name); if (u?.dismissedAt !== null && u) { u.dismissedAt = null; n++; } }
    if (n) this._changed();
    return n;
  }
  /** Seen in the stream that is live right now. */
  seenLive(username) { return this.room.live && this.tracker.users.has(username); }

  /** Other monitored rooms (excluding this one), optionally only blacklisted ones. */
  _peers(blacklistedOnly = false) {
    return [...this.peers()].filter(p => p !== this && p.username !== this.username && (!blacklistedOnly || this.lists.blacklist.has(p.username)));
  }
  /** Blacklisted rooms whose live stream the user has also been seen in. */
  liveIn(username) { return this._peers(true).filter(p => p.seenLive(username)).map(p => p.username); }

  assess(u, h = this.history.summary(u)) {
    return scoreUser(u, { history: h, rooms: this.roomIndex.lookup(u), liveIn: this.liveIn(u.username), blacklist: this.lists.blacklist, sid: this.stream?.sid ?? null });
  }

  refreshRoomIndex() { this.roomIndex = loadRoomIndex(this.cfg.dataDir, this.username); return this.roomIndex; }

  /** Drop history records older than cfg.pruneAfterDays (if enabled), keeping pinned and watched accounts. */
  pruneHistory(now = Date.now()) {
    const days = this.cfg.pruneAfterDays;
    if (!(days > 0)) return 0;
    const keep = new Set([...this.lists.pinned, ...this.lists.watch]);
    const n = this.history.prune(days * DAY_MS, keep, now);
    if (n) this._log('system', `forgot ${n} account${n === 1 ? '' : 's'} not seen in ${days} days`);
    return n;
  }

  /**
   * An account was pinned or watched: gather everything ever logged about it from this room's log
   * files into its history record, so it stays available whatever happens to the files.
   */
  retainEvents(usernames) {
    let n = 0;
    for (const name of usernames) {
      const key = normalizeUsername(name);
      const u = this.tracker.get(key) ?? this.history.get(key);
      if (!u) continue;
      const rec = this.history.get(u) ?? this.history.ensure({ userId: u.userId ?? null, username: u.username, nickname: u.nickname });
      const names = new Set([rec.username, ...(rec.aliases ?? [])].filter(Boolean).map(s => s.toLowerCase()));
      const sids = new Set([...Object.keys(rec.streams ?? {}), ...(this.stream ? [this.stream.sid] : [])]);
      const events = [];
      for (const sid of sids) for (const e of this.readLog(sid)) {
        if (!e.user || !RETAINED_KINDS.has(e.kind) || !names.has(e.user.toLowerCase())) continue;
        events.push({ t: e.t, sid: e.sid ?? sid, kind: e.kind, text: e.text });
      }
      this.history.setEvents(u, events);
      n++;
    }
    if (n) { try { this.history.save(); } catch (e) { this._log('error', `could not save history: ${e.message}`); } }
    return n;
  }

  /** One display row per tracker record: raw numbers, formatting is the caller's job. */
  row(u) {
    const h = this.history.summary(u);
    const a = this.assess(u, h);
    const live = this.liveIn(u.username);
    const hopped = [...new Set(u.hops.map(x => x.room))];
    const flags = [u.isAdmin && 'mod', u.isFollower && 'follower', u.followed && 'followed-live', h?.aliases?.length && 'renamed',
      ...hopped.map(r => `HOP:@${r}`), ...live.filter(r => !hopped.includes(r)).map(r => `NOW:@${r}`),
      ...a.blacklisted.filter(r => !live.includes(r) && !hopped.includes(r)).map(r => `BL:@${r}`), this.watched(u.username) && 'watch'].filter(Boolean);
    return {
      username: u.username, nickname: u.nickname, userId: u.userId,
      joins: u.joins, chats: u.chats, likes: u.likes, gifts: u.gifts, coins: u.coins, shares: u.shares,
      firstSeen: u.firstSeen, lastSeen: u.lastSeen, lastJoin: u.lastJoin,
      hops: u.hops.length, lastHop: u.hops[u.hops.length - 1] ?? null,
      streamsSeen: (h?.streams ?? []).filter(s => s.sid !== this.stream?.sid).length + 1, daysSeen: h?.daysSeen ?? 1,
      firstSeenEver: h?.firstSeenEver ?? u.firstSeen, lastSeenEver: h?.lastSeenEver ?? u.lastSeen,
      followers: u.followers ?? h?.profile?.followers ?? null, following: u.following ?? h?.profile?.following ?? null,
      verified: u.verified, privateAccount: u.privateAccount, gifterLevel: u.gifterLevel,
      isFollower: u.isFollower, isAdmin: u.isAdmin, followed: u.followed,
      score: a.score, blacklistScore: a.blacklistScore, burnerScore: a.score - a.blacklistScore, reasons: a.reasons, blacklisted: a.blacklisted, flags,
      aliases: h?.aliases ?? [], watched: this.watched(u.username),
      pinned: this.pinned(u.username), dismissedAt: u.dismissedAt,
    };
  }

  rows() { return this.tracker.all().map(u => this.row(u)); }

  /** Everything a UI needs to draw this room. */
  snapshot() {
    const now = Date.now();
    const users = this.rows();
    return {
      room: this.username, state: this.state, stateMessage: this.stateMessage, ...this.room,
      startedAt: this.startedAt, stream: this.stream, streams: this.history.streamList(),
      uptime: this.room.live && this.room.streamStartedAt ? Math.max(0, now - this.room.streamStartedAt) : 0,
      counts: { seen: users.length, chatted: users.filter(u => u.chats).length, gifted: users.filter(u => u.gifts).length, flagged: this.flagged.size, known: this.history.users.size },
      otherRooms: this.roomIndex.rooms,
      users,
    };
  }

  /** Full detail for one user: this stream's row (if seen), history, other rooms, chat, retained events. */
  detail(id) {
    const u = this.tracker.get(id);
    const rec = this.history.get(u ?? id);
    if (!u && !rec) return null;
    const h = RoomHistory.summarize(rec);
    const key = u ?? { userId: rec.userId, username: rec.username };
    return {
      username: key.username, nickname: u?.nickname ?? rec?.nickname ?? null, seenThisStream: !!u,
      stream: u ? this.row(u) : null, sid: this.stream?.sid ?? null,
      history: h,
      rooms: this._roomsFor(key),
      chat: u?.chatLog ?? [],
      events: h?.events ?? [],
      retained: this.pinned(key.username) || this.watched(key.username),
      flagged: this.flagged.get(key.username) ?? null,
    };
  }

  /** History entries for other rooms, merged with what rooms monitored right now know. */
  _roomsFor(key) {
    const rooms = this.roomIndex.lookup(key).map(r => ({ ...r, blacklisted: this.lists.blacklist.has(r.room.toLowerCase()), liveNow: false }));
    for (const p of this._peers()) {
      const live = p.seenLive(key.username);
      const rec = p.tracker.users.get(key.username);
      const existing = rooms.find(r => r.room === p.username);
      if (existing) { existing.liveNow = live; if (rec?.isFollower === true) existing.follows = true; }
      else if (rec) rooms.push({ room: p.username, username: key.username, follows: rec.isFollower, daysSeen: 1, streamsSeen: 1, lastSeen: rec.lastSeen, firstSeen: rec.firstSeen, blacklisted: this.lists.blacklist.has(p.username), liveNow: live });
    }
    return rooms.sort((a, b) => (b.liveNow - a.liveNow) || (b.blacklisted - a.blacklisted));
  }

  /** Pinned accounts and everyone with a score, minus dismissed ones; pinned first, then by score. */
  suspects(n = 20, includeDismissed = false) {
    return this.rows().filter(r => (r.score > 0 || r.pinned) && (includeDismissed || r.dismissedAt === null))
      .sort((a, b) => (b.pinned - a.pinned) || (b.score - a.score)).slice(0, n);
  }
  find(q) { return this.tracker.find(q).map(u => this.row(u)); }
  top(field = 'chats', n = 20) { return this.tracker.top(field, n).map(u => this.row(u)); }

  // ---------- persistence ----------
  save() {
    if (!this.stream) { this.history.save(); return { file: null, count: 0 }; }
    const file = this.snapshotFile;
    mkdirSync(dirname(file), { recursive: true });
    const users = this.tracker.all();
    const out = { room: this.username, sid: this.stream.sid, stream: this.stream, savedAt: new Date().toISOString(), monitorStartedAt: this.startedAt, viewerCount: this.room.viewers, users };
    writeFileSync(file, JSON.stringify(out, null, 2));
    this.history.update(users, this.stream.sid);
    this.history.touchStream({ ...this.stream, seen: users.length, joins: users.reduce((n, u) => n + u.joins, 0), chats: users.reduce((n, u) => n + u.chats, 0),
      gifts: users.reduce((n, u) => n + u.gifts, 0), coins: users.reduce((n, u) => n + u.coins, 0), lastSeen: users.reduce((m, u) => Math.max(m, u.lastSeen), this.stream.monitoredAt) });
    this.pruneHistory();
    this.history.save();
    const r = { file, count: users.length };
    this.emit('saved', r);
    return r;
  }
}

const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// v2 of the library: the username is `displayId`, the numeric id is `id`.
const num = v => { const n = Number(v); return v === undefined || v === null || v === '' || !Number.isFinite(n) ? undefined : n; };
export function who(d) {
  const u = d?.user; if (!u) return null;
  const username = u.displayId || u.uniqueId; if (!username) return null;
  const fi = u.followInfo ?? {};
  // createTime and bioDescription exist in the schema but TikTok never fills them in LIVE events.
  // The same goes for `secret` (private account) and `verified`: in a 172-user sample (Sept 2026) neither was
  // ever set. The proto decoder returns 0/false for fields that were never sent, so a falsy value carries no
  // information at all. Only a positive value is reported; anything else stays unknown rather than "no".
  return { username, info: {
    nickname: u.nickname, userId: u.id, isAdmin: !!u.userAttr?.isAdmin,
    isFollower: fi.followStatus !== undefined && fi.followStatus !== null && fi.followStatus !== '' ? Number(fi.followStatus) > 0 : undefined,
    followers: num(fi.followerCount), following: num(fi.followingCount),
    verified: u.verified === true ? true : undefined,
    privateAccount: Number(u.secret) > 0 ? true : undefined,
    gifterLevel: num(u.payGrade?.level),
    secUid: u.secUid || undefined,
  } };
}
