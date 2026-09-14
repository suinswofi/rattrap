// Long-term memory for one room, kept across streams and restarts.
//
// One file per monitored room (data/history-<room>.json). A user is keyed by TikTok user id
// (falling back to "@username" when no id was delivered), so a burner that renames itself keeps
// one record and its previous usernames end up in `aliases`.
//
// Activity is stored per stream (one TikTok live session, identified by when Rat Trap started
// monitoring it), and a stream's entry is *replaced* on every save, so repeated autosaves never
// double-count. Totals are summed from the streams. Files written by older versions stored
// activity per day instead; those days are read as streams named by their date.
//
// Pinned and watched accounts also keep `events`: every join, chat, gift, follow, share, flag and
// hop ever logged for them, so their full record survives log clean-ups and restarts.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join as pathJoin, dirname, basename } from 'node:path';

const STREAM_FIELDS = ['joins', 'chats', 'likes', 'gifts', 'coins', 'shares', 'hops'];
const PROFILE_FIELDS = ['followers', 'following', 'verified', 'privateAccount', 'gifterLevel', 'secUid'];
// A stored `false` for these two only ever meant "TikTok did not send it"; report it as unknown.
const cleanProfile = p => { const out = { ...(p ?? {}) }; for (const f of ['privateAccount', 'verified']) if (out[f] === false) delete out[f]; return out; };

export const RETAINED_KINDS = new Set(['join', 'rejoin', 'chat', 'gift', 'follow', 'share', 'flag', 'hop']);
export const MAX_EVENTS = 20_000; // per retained account; the oldest go first

export const historyFile = (dataDir, room) => pathJoin(dataDir, `history-${room}.json`);
export const streamsOf = rec => rec?.streams ?? rec?.days ?? {};

const pad2 = n => String(n).padStart(2, '0');
export const dateOf = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
/** Stream id: local date and time monitoring started, e.g. "2026-09-08_21-00" (safe in file names). */
export const makeSid = ts => { const d = new Date(ts); return `${dateOf(ts)}_${pad2(d.getHours())}-${pad2(d.getMinutes())}`; };
/** "2026-09-08 21:00" for a stream id, or the bare date for streams migrated from per-day files. */
export const streamLabel = sid => String(sid ?? '').replace(/_(\d\d)-(\d\d)(b*)$/, ' $1:$2$3');

export class RoomHistory {
  constructor(room, file) {
    this.room = room;
    this.file = file;
    this.users = new Map(); // key -> record
    this.byName = new Map(); // lowercase username/alias -> key
    this.streams = {};      // sid -> { sid, roomId, title, startedAt, monitoredAt, endedAt, seen, joins, chats, gifts, coins, legacy? }
  }

  static key(userId, username) { return userId ? String(userId) : `@${String(username).toLowerCase()}`; }

  load() {
    if (!this.file || !existsSync(this.file)) return 0;
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    this.streams = data.streams ?? {};
    for (const [k, r] of Object.entries(data.users ?? {})) this._index(k, this._migrate(r));
    return this.users.size;
  }

  /** Per-day records from older versions become one stream per day. */
  _migrate(rec) {
    if (!rec.streams) { rec.streams = rec.days ?? {}; }
    delete rec.days;
    for (const [sid, s] of Object.entries(rec.streams)) {
      delete s.presentMs;
      if (s.hops === undefined) s.hops = 0;
      const st = this.streams[sid];
      if (!st) this.streams[sid] = { sid, roomId: null, title: null, startedAt: s.firstSeen, monitoredAt: s.firstSeen, endedAt: s.lastSeen, legacy: true };
      else if (st.legacy) { st.startedAt = st.monitoredAt = Math.min(st.monitoredAt, s.firstSeen); st.endedAt = Math.max(st.endedAt ?? 0, s.lastSeen); }
    }
    return rec;
  }

  _index(key, rec) {
    this.users.set(key, rec);
    for (const n of [rec.username, ...(rec.aliases ?? [])]) if (n) this.byName.set(n.toLowerCase(), key);
  }

  /** The record for a tracker-like object { userId, username, nickname? }, created (or adopted from an id-less one) if needed. */
  ensure(u) {
    const key = RoomHistory.key(u.userId, u.username);
    let rec = this.users.get(key);
    if (!rec && u.userId) {
      // records saved before we knew the id live under "@username"; adopt them
      const old = this.users.get(`@${u.username.toLowerCase()}`);
      if (old) { this.users.delete(`@${u.username.toLowerCase()}`); rec = old; }
    }
    if (!rec) rec = { userId: u.userId ?? null, username: u.username, nickname: u.nickname ?? null, aliases: [], nicknames: [], profile: {}, isFollower: null, isAdmin: false, streams: {} };
    if (u.userId) rec.userId = u.userId;
    if (rec.username !== u.username) {
      if (rec.username && !rec.aliases.includes(rec.username)) rec.aliases.push(rec.username);
      rec.username = u.username;
    }
    rec.aliases = rec.aliases.filter(a => a !== rec.username);
    if (u.nickname && u.nickname !== rec.nickname) {
      if (rec.nickname && !rec.nicknames.includes(rec.nickname)) rec.nicknames.push(rec.nickname);
      rec.nickname = u.nickname;
    }
    this._index(key, rec);
    return rec;
  }

  /** Merge the current tracker records under stream `sid`. */
  update(users, sid) {
    for (const u of users) {
      const rec = this.ensure(u);
      for (const f of PROFILE_FIELDS) if (u[f] !== null && u[f] !== undefined) rec.profile[f] = u[f];
      // Older versions recorded privateAccount/verified as false whenever TikTok simply left the field out.
      // Those values mean "unknown", not "no", so drop them (see who() in monitor.js).
      for (const f of ['privateAccount', 'verified']) if (rec.profile[f] === false) delete rec.profile[f];
      if (typeof u.isFollower === 'boolean') rec.isFollower = u.isFollower;
      if (u.followed) rec.isFollower = true;
      if (u.isAdmin) rec.isAdmin = true;
      const s = { firstSeen: u.firstSeen, lastSeen: u.lastSeen };
      for (const f of STREAM_FIELDS) s[f] = f === 'hops' ? (u.hops?.length ?? 0) : (u[f] ?? 0);
      rec.streams[sid] = s;
    }
  }

  /** Create or update a stream record. */
  touchStream(info) {
    if (!info?.sid) return null;
    this.streams[info.sid] = { ...(this.streams[info.sid] ?? {}), ...info };
    return this.streams[info.sid];
  }
  /** Streams, newest first. */
  streamList() { return Object.values(this.streams).sort((a, b) => (b.monitoredAt ?? 0) - (a.monitoredAt ?? 0)); }
  latestStream() { return this.streamList()[0] ?? null; }
  findStreamByRoomId(roomId) { return roomId ? Object.values(this.streams).find(s => s.roomId === roomId) ?? null : null; }

  /** Keep a log entry for a pinned/watched account. */
  addEvent(u, entry) {
    if (!RETAINED_KINDS.has(entry.kind)) return null;
    const rec = this.get(u) ?? this.ensure(u);
    if (!rec.events) rec.events = [];
    rec.events.push({ t: entry.t, sid: entry.sid ?? null, kind: entry.kind, text: entry.text });
    if (rec.events.length > MAX_EVENTS) rec.events.splice(0, rec.events.length - MAX_EVENTS);
    return rec;
  }
  /** Replace an account's retained events (after re-reading the log files). */
  setEvents(u, events) {
    const rec = this.get(u) ?? this.ensure(u);
    rec.events = [...events].sort((a, b) => a.t - b.t).slice(-MAX_EVENTS);
    return rec;
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const users = Object.fromEntries([...this.users.entries()].sort((a, b) => (firstSeen(a[1]) ?? Infinity) - (firstSeen(b[1]) ?? Infinity)));
    writeFileSync(this.file, JSON.stringify({ room: this.room, updatedAt: new Date().toISOString(), streams: this.streams, users }, null, 2));
    return this.users.size;
  }

  /** Look up by a tracker record, user id, or username. */
  get(u) {
    if (!u) return null;
    if (typeof u === 'object') return this.users.get(RoomHistory.key(u.userId, u.username)) ?? this.users.get(this.byName.get(u.username.toLowerCase())) ?? null;
    const s = String(u).replace(/^@/, '');
    return this.users.get(s) ?? this.users.get(this.byName.get(s.toLowerCase())) ?? null;
  }

  /** Derived, display-friendly view of a record. */
  static summarize(rec) {
    if (!rec) return null;
    const all = streamsOf(rec);
    const sids = Object.keys(all).sort();
    const totals = Object.fromEntries(STREAM_FIELDS.map(f => [f, 0]));
    const streams = sids.map(sid => { const s = all[sid]; for (const f of STREAM_FIELDS) totals[f] += s[f] ?? 0; return { sid, label: streamLabel(sid), ...s }; });
    const dates = [...new Set(streams.map(s => dateOf(s.firstSeen)))].sort();
    return {
      firstSeenEver: firstSeen(rec), lastSeenEver: lastSeen(rec),
      daysSeen: dates.length, dates, streamsSeen: streams.length, streams, totals,
      aliases: rec.aliases ?? [], nicknames: rec.nicknames ?? [], profile: cleanProfile(rec.profile),
      isFollower: rec.isFollower ?? null,
      events: rec.events ?? [],
    };
  }

  summary(u) { return RoomHistory.summarize(this.get(u)); }

  /**
   * Forget accounts whose last sighting is older than `maxAgeMs`. Usernames (or aliases) in
   * `keep` are never removed. Returns the number of records dropped.
   */
  prune(maxAgeMs, keep = new Set(), now = Date.now()) {
    if (!(maxAgeMs > 0)) return 0;
    const cutoff = now - maxAgeMs;
    let dropped = 0;
    for (const [key, rec] of [...this.users.entries()]) {
      if ((lastSeen(rec) ?? now) >= cutoff) continue;
      if ([rec.username, ...(rec.aliases ?? [])].some(n => n && keep.has(n.toLowerCase()))) continue;
      this.users.delete(key);
      for (const n of [rec.username, ...(rec.aliases ?? [])]) if (n && this.byName.get(n.toLowerCase()) === key) this.byName.delete(n.toLowerCase());
      dropped++;
    }
    return dropped;
  }
}

const firstSeen = rec => { const v = Object.values(streamsOf(rec)).map(d => d.firstSeen).filter(Number.isFinite); return v.length ? Math.min(...v) : null; };
const lastSeen = rec => { const v = Object.values(streamsOf(rec)).map(d => d.lastSeen).filter(Number.isFinite); return v.length ? Math.max(...v) : null; };

/**
 * Read every other room's history file so a viewer can be looked up across rooms.
 * Returns { rooms, lookup(u) -> [{ room, follows, daysSeen, lastSeen, username }] }.
 * `follows` is what TikTok reported about the viewer's follow status towards *that* room's host.
 */
export function loadRoomIndex(dataDir, excludeRoom = null) {
  const byKey = new Map(); // history key -> [{room, ...}]
  const byName = new Map(); // lowercase username -> Set(keys)
  const add = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  let files = [];
  try { files = readdirSync(dataDir).filter(f => /^history-.+\.json$/.test(f)); } catch { /* no data dir yet */ }
  for (const f of files) {
    const room = basename(f, '.json').replace(/^history-/, '');
    if (room === excludeRoom) continue;
    let data;
    try { data = JSON.parse(readFileSync(pathJoin(dataDir, f), 'utf8')); } catch { continue; }
    for (const [key, rec] of Object.entries(data.users ?? {})) {
      const s = RoomHistory.summarize(rec);
      const entry = { room, username: rec.username, follows: s.isFollower, daysSeen: s.daysSeen, streamsSeen: s.streamsSeen, lastSeen: s.lastSeenEver, firstSeen: s.firstSeenEver };
      add(byKey, key, entry);
      for (const n of [rec.username, ...(rec.aliases ?? [])]) if (n) add(byName, n.toLowerCase(), { key, entry });
    }
  }
  return {
    rooms: [...new Set([...byKey.values()].flat().map(e => e.room))],
    lookup(u) {
      const key = RoomHistory.key(u?.userId, u?.username ?? u);
      const out = byKey.get(key) ?? [];
      if (u?.userId) return out;
      // no id: match by name, but avoid duplicates
      const seen = new Set(out);
      for (const { entry } of byName.get(String(u?.username ?? u).replace(/^@/, '').toLowerCase()) ?? []) if (!seen.has(entry)) { seen.add(entry); out.push(entry); }
      return out;
    },
  };
}
