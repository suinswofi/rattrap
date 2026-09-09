// Monitor: everything Bouncer knows about one TikTok LIVE room, with no user interface attached.
//
// Owns the connection, the day tracker, the long-term history, scoring, and saving. Emits:
//   'status'  { room, state, message }        state: connecting | live | waiting | reconnecting | offline | stopped
//   'log'     { t, kind, text, user?, watched, alert, chat? }   one line for the event log
//   'flag'    { t, user, nickname, score, reasons, blacklisted }
//   'saved'   { file, count }
//   'users'   nothing; throttled hint that the user table changed
//
// TikTok sends no "user left" event. A leave is inferred when the user re-joins (they must have
// left in between) or after the idle timeout with no activity. Leave time = last time seen.
// In busy rooms TikTok samples join/like events, so not every viewer will appear.

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join as pathJoin, dirname, isAbsolute } from 'node:path';
import { TikTokLiveConnection, WebcastEvent, ControlEvent, UserOfflineError, SignatureRateLimitError } from 'tiktok-live-connector';
import { ViewerTracker } from './tracker.js';
import { RoomHistory, historyFile, loadRoomIndex } from './history.js';
import { scoreUser, accountAgeDays } from './burner.js';

export const DEFAULTS = {
  username: 'the_great_sir_stromburg',
  rooms: [],                 // rooms the GUI opens on start (falls back to `username`)
  idleTimeoutMinutes: 15,
  watch: [],
  blacklist: [],
  burnerAlertScore: 6,
  signApiKey: '',
  dataDir: 'data',
  autosaveMinutes: 5,
  resume: true,
  reconnectWhenLive: true,
  livePollSeconds: 60,
  chatHistory: 50,
  logEvents: true,
  logChat: false,
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
  cfg.watch = nameSet(cfg.watch);
  cfg.blacklist = nameSet(cfg.blacklist);
  cfg.idleTimeoutMinutes = Number(cfg.idleTimeoutMinutes);
  if (!Number.isFinite(cfg.idleTimeoutMinutes) || cfg.idleTimeoutMinutes <= 0) throw new Error('idleTimeoutMinutes must be a positive number');
  cfg.burnerAlertScore = Number(cfg.burnerAlertScore);
  if (!Number.isFinite(cfg.burnerAlertScore)) throw new Error('burnerAlertScore must be a number');
  cfg.autosaveMinutes = Math.max(0, Number(cfg.autosaveMinutes) || 0);
  cfg.livePollSeconds = Math.max(30, Number(cfg.livePollSeconds) || 60);
  cfg.chatHistory = Math.max(1, Number(cfg.chatHistory) || 50);
  cfg.signApiKey = String(cfg.signApiKey ?? '');
  if (baseDir && !isAbsolute(cfg.dataDir)) cfg.dataDir = pathJoin(baseDir, cfg.dataDir);
  return cfg;
}

/** Plain-JSON view of a config (Sets become arrays) for saving or sending to a renderer. */
export const configToJSON = cfg => ({ ...cfg, watch: [...cfg.watch], blacklist: [...cfg.blacklist] });

const dateOf = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export class Monitor extends EventEmitter {
  /**
   * @param {string} username   streamer to monitor
   * @param {object} cfg        shared, normalised config (edited live by the UI)
   * @param {object} [opts]
   * @param {Function} [opts.createConnection]  (username, options) => connection; for tests
   * @param {number} [opts.logLimit]            log lines kept in memory
   */
  constructor(username, cfg, opts = {}) {
    super();
    this.username = normalizeUsername(username);
    if (!this.username) throw new Error('no username given');
    this.cfg = cfg;
    this.createConnection = opts.createConnection ?? ((u, o) => new TikTokLiveConnection(u, o));
    this.logLimit = opts.logLimit ?? 1000;
    this.tracker = new ViewerTracker({ timeoutMs: cfg.idleTimeoutMinutes * 60_000, chatHistory: cfg.chatHistory });
    this.history = new RoomHistory(this.username, historyFile(cfg.dataDir, this.username));
    this.roomIndex = loadRoomIndex(cfg.dataDir, this.username);
    this.room = { id: null, title: null, viewers: null, totalViewers: null, likes: null, live: false, connectedAt: null };
    this.recentChat = [];   // { t, user, nickname, text }
    this.logLines = [];     // last N log entries
    this.flagged = new Map(); // username -> { t, score, reasons, blacklisted }
    this.state = 'stopped';
    this.stateMessage = '';
    this.startedAt = null;
    this.sessionDate = null;
    this.conn = null;
    this.quitting = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 10_000;
    this.timers = [];
  }

  // ---------- lifecycle ----------
  get snapshotFile() { return pathJoin(this.cfg.dataDir, `viewers-${this.username}-${this.sessionDate ?? dateOf(Date.now())}.json`); }

  start() {
    if (this.state !== 'stopped') return this;
    this.quitting = false;
    this.startedAt = Date.now();
    this.sessionDate = dateOf(this.startedAt);
    this.tracker.timeoutMs = this.cfg.idleTimeoutMinutes * 60_000;
    try { const n = this.history.load(); if (n) this._log('system', `history: ${n} users known in this room`); }
    catch (e) { this._log('error', `could not load ${this.history.file}: ${e.message}`); }
    if (this.cfg.resume && existsSync(this.snapshotFile)) {
      try { const n = this.tracker.load(JSON.parse(readFileSync(this.snapshotFile, 'utf8'))); this._log('system', `resumed ${n} user records from today's snapshot`); }
      catch (e) { this._log('error', `could not load ${this.snapshotFile}: ${e.message}`); }
    }
    this.conn = this.createConnection(this.username, { ...(this.cfg.signApiKey ? { signApiKey: this.cfg.signApiKey } : {}), processInitialData: false });
    this._bind(this.conn);
    this.timers.push(setInterval(() => this._sweep(), 30_000));
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
    this.room.live = false;
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
      const state = await this.conn.connect();
      this.reconnectDelay = 10_000;
      this.room.id = state?.roomId ?? null; this.room.live = true; this.room.connectedAt = Date.now();
      const info = state?.roomInfo?.data ?? state?.roomInfo ?? {};
      this.room.title = info.title ?? null;
      if (info.user_count) this.room.viewers = Number(info.user_count);
      this._setState('live', `connected${this.room.title ? ` — "${this.room.title}"` : ''}`);
    } catch (err) {
      this.room.live = false;
      if (this.quitting) return;
      if (err instanceof UserOfflineError || /offline|not.*live/i.test(err?.message ?? '')) {
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
    this.emit('status', { room: this.username, state, message });
  }

  // ---------- events from TikTok ----------
  _bind(conn) {
    conn.on(WebcastEvent.MEMBER, d => {
      const w = who(d); if (!w) return;
      const wasPresent = this.tracker.users.get(w.username)?.present;
      const u = this.tracker.join(w.username, w.info);
      if (typeof d.memberCount === 'number' && d.memberCount > 0) this.room.viewers = d.memberCount;
      this._log(wasPresent ? 'rejoin' : 'join', `${wasPresent ? 're-joined' : 'joined'}`, u);
      this._maybeFlag(u);
      this._changed();
    });
    conn.on(WebcastEvent.CHAT, d => {
      const w = who(d); if (!w) return;
      const text = d.content ?? d.comment ?? '';
      const u = this.tracker.activity(w.username, w.info, 'chat', { text });
      this.recentChat.push({ t: Date.now(), user: w.username, nickname: u.nickname, text });
      if (this.recentChat.length > 500) this.recentChat.shift();
      this._log('chat', text, u, { chat: true });
      this._maybeFlag(u);
      this._changed();
    });
    conn.on(WebcastEvent.LIKE, d => {
      const w = who(d); if (!w) return;
      this.tracker.activity(w.username, w.info, 'like', { count: Number(d.count) || 1 });
      if (d.total) this.room.likes = Number(d.total);
      this._changed();
    });
    conn.on(WebcastEvent.GIFT, d => {
      const w = who(d); if (!w) return;
      // Streak gifts repeat with repeatEnd=0 until the final message (repeatEnd=1); count only the final one.
      const streak = d.gift?.type === 1 || d.gift?.combo === true;
      if (streak && !d.repeatEnd) { this.tracker.activity(w.username, w.info); return; }
      const count = Number(d.repeatCount) || 1;
      const coins = (Number(d.gift?.diamondCount) || 0) * count;
      const u = this.tracker.activity(w.username, w.info, 'gift', { count, coins });
      this._log('gift', `${d.gift?.name ?? d.giftId} x${count}${coins ? ` (${coins} coins)` : ''}`, u);
      this._changed();
    });
    conn.on(WebcastEvent.FOLLOW, d => {
      const w = who(d); if (!w) return;
      const u = this.tracker.activity(w.username, w.info, 'follow');
      this._log('follow', 'followed', u);
      this._changed();
    });
    conn.on(WebcastEvent.SHARE, d => {
      const w = who(d); if (!w) return;
      const u = this.tracker.activity(w.username, w.info, 'share');
      this._log('share', 'shared the stream', u);
      this._changed();
    });
    for (const ev of [WebcastEvent.EMOTE, WebcastEvent.SOCIAL, WebcastEvent.QUESTION_NEW, WebcastEvent.ENVELOPE]) {
      conn.on(ev, d => { const w = who(d); if (w) this.tracker.activity(w.username, w.info); });
    }
    conn.on(WebcastEvent.ROOM_USER, d => {
      const total = Number(d.total); if (Number.isFinite(total) && total > 0) this.room.viewers = total;
      const tu = Number(d.totalUser); if (Number.isFinite(tu) && tu > 0) this.room.totalViewers = tu;
      for (const r of d.ranks ?? []) { const w = who(r); if (w) this.tracker.activity(w.username, w.info); }
    });
    conn.on(WebcastEvent.STREAM_END, () => {
      this.room.live = false;
      this.tracker.clearPresence();
      try { this.save(); } catch (e) { this._log('error', `save failed: ${e.message}`); }
      this._setState('waiting', 'stream ended, everyone marked as left');
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

  _sweep() {
    const left = this.tracker.sweep();
    for (const u of left) this._log('leave', `left (idle ${this.cfg.idleTimeoutMinutes}m)`, u);
    if (left.length) this._changed();
  }

  _changed() {
    if (this._changeTimer) return;
    this._changeTimer = setTimeout(() => { this._changeTimer = null; this.emit('users'); }, 500);
    this._changeTimer.unref?.();
  }

  _log(kind, text, u = null, extra = {}) {
    const entry = { t: Date.now(), kind, text, room: this.username, ...extra };
    if (u) { entry.user = u.username; entry.nickname = u.nickname; entry.watched = this.watched(u.username); }
    entry.alert = !!(entry.watched || kind === 'flag' || kind === 'error');
    this.logLines.push(entry);
    if (this.logLines.length > this.logLimit) this.logLines.splice(0, this.logLines.length - this.logLimit);
    this.emit('log', entry);
    return entry;
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

  // ---------- queries ----------
  watched(username) { return this.cfg.watch.has(username.toLowerCase()); }

  assess(u, h = this.history.summary(u), now = Date.now()) {
    return scoreUser(u, { history: h, rooms: this.roomIndex.lookup(u), blacklist: this.cfg.blacklist, timeInRoom: this.tracker.timeInRoom(u, now), now });
  }

  refreshRoomIndex() { this.roomIndex = loadRoomIndex(this.cfg.dataDir, this.username); return this.roomIndex; }

  /** One display row per tracker record: raw numbers, formatting is the caller's job. */
  row(u, now = Date.now()) {
    const h = this.history.summary(u);
    const a = this.assess(u, h, now);
    const created = u.accountCreated ?? h?.profile?.accountCreated ?? null;
    const flags = [u.isAdmin && 'mod', u.isFollower && 'follower', u.followed && 'followed-live', h?.aliases?.length && 'renamed',
      ...a.blacklisted.map(r => `BL:@${r}`), this.watched(u.username) && 'watch'].filter(Boolean);
    return {
      username: u.username, nickname: u.nickname, userId: u.userId, present: u.present,
      joins: u.joins, chats: u.chats, likes: u.likes, gifts: u.gifts, coins: u.coins, shares: u.shares,
      firstSeen: u.firstSeen, lastSeen: u.lastSeen, firstLeft: u.firstLeft, lastLeft: u.lastLeft, leftHow: u.leftHow,
      timeInRoom: this.tracker.timeInRoom(u, now),
      daysSeen: h?.daysSeen ?? 1, firstSeenEver: h?.firstSeenEver ?? u.firstSeen, lastSeenEver: h?.lastSeenEver ?? u.lastSeen,
      followers: u.followers ?? h?.profile?.followers ?? null, following: u.following ?? h?.profile?.following ?? null,
      accountCreated: created, accountAgeDays: accountAgeDays(created, now),
      verified: u.verified, bio: u.bio, privateAccount: u.privateAccount, gifterLevel: u.gifterLevel,
      isFollower: u.isFollower, isAdmin: u.isAdmin, followed: u.followed,
      score: a.score, reasons: a.reasons, blacklisted: a.blacklisted, flags,
      aliases: h?.aliases ?? [], watched: this.watched(u.username),
    };
  }

  rows(now = Date.now()) { return this.tracker.all().map(u => this.row(u, now)); }

  /** Everything a UI needs to draw this room. */
  snapshot() {
    const now = Date.now();
    const users = this.rows(now);
    return {
      room: this.username, state: this.state, stateMessage: this.stateMessage, ...this.room,
      startedAt: this.startedAt, sessionDate: this.sessionDate, uptime: this.startedAt ? now - this.startedAt : 0,
      counts: { seen: users.length, present: users.filter(u => u.present).length, chatted: users.filter(u => u.chats).length, gifted: users.filter(u => u.gifts).length, flagged: this.flagged.size, known: this.history.users.size },
      otherRooms: this.roomIndex.rooms,
      users,
    };
  }

  /** Full detail for one user: today's row (if seen today), history, other rooms, recent chat. */
  detail(id) {
    const u = this.tracker.get(id);
    const rec = this.history.get(u ?? id);
    if (!u && !rec) return null;
    const h = RoomHistory.summarize(rec);
    const key = u ?? { userId: rec.userId, username: rec.username };
    return {
      username: key.username, nickname: u?.nickname ?? rec?.nickname ?? null, seenToday: !!u,
      today: u ? this.row(u) : null,
      history: h,
      rooms: this.roomIndex.lookup(key).map(r => ({ ...r, blacklisted: this.cfg.blacklist.has(r.room.toLowerCase()) })),
      chat: u?.chatLog ?? [],
      flagged: this.flagged.get(key.username) ?? null,
    };
  }

  suspects(n = 20) { return this.rows().filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, n); }
  present() { return this.rows().filter(r => r.present); }
  find(q) { return this.tracker.find(q).map(u => this.row(u)); }
  top(field = 'chats', n = 20) { return this.tracker.top(field, n).map(u => this.row(u)); }

  // ---------- persistence ----------
  save(file = this.snapshotFile) {
    mkdirSync(dirname(file), { recursive: true });
    const users = this.tracker.all().map(u => ({ ...u, sessionStart: undefined }));
    const out = { room: this.username, savedAt: new Date().toISOString(), monitorStartedAt: this.startedAt, timeoutMs: this.tracker.timeoutMs, viewerCount: this.room.viewers, users };
    writeFileSync(file, JSON.stringify(out, null, 2));
    this.history.update(this.tracker.all(), this.sessionDate ?? dateOf(Date.now()));
    this.history.save();
    const r = { file, count: users.length };
    this.emit('saved', r);
    return r;
  }
}

// v2 of the library: the username is `displayId`, the numeric id is `id`.
const num = v => { const n = Number(v); return v === undefined || v === null || v === '' || !Number.isFinite(n) ? undefined : n; };
export function who(d) {
  const u = d?.user; if (!u) return null;
  const username = u.displayId || u.uniqueId; if (!username) return null;
  const fi = u.followInfo ?? {};
  const created = num(u.createTime);
  return { username, info: {
    nickname: u.nickname, userId: u.id, isAdmin: !!u.userAttr?.isAdmin,
    isFollower: fi.followStatus !== undefined && fi.followStatus !== null && fi.followStatus !== '' ? Number(fi.followStatus) > 0 : undefined,
    followers: num(fi.followerCount), following: num(fi.followingCount),
    accountCreated: created ? (created < 1e12 ? created * 1000 : created) : undefined, // seconds → ms
    verified: typeof u.verified === 'boolean' ? u.verified : undefined,
    bio: typeof u.bioDescription === 'string' ? u.bioDescription : undefined,
    privateAccount: u.secret !== undefined && u.secret !== null ? Number(u.secret) > 0 : undefined,
    gifterLevel: num(u.payGrade?.level),
    secUid: u.secUid || undefined,
  } };
}
