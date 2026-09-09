// Long-term memory for one room, kept across days and restarts.
//
// One file per monitored room (data/history-<room>.json). A user is keyed by TikTok user id
// (falling back to "@username" when no id was delivered), so a burner that renames itself keeps
// one record and its previous usernames end up in `aliases`.
//
// Activity is stored per day, and a day's entry is *replaced* on every save, so repeated
// autosaves never double-count. Totals are summed from the days.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join as pathJoin, dirname, basename } from 'node:path';

const DAY_FIELDS = ['joins', 'chats', 'likes', 'gifts', 'coins', 'shares', 'presentMs'];
const PROFILE_FIELDS = ['followers', 'following', 'accountCreated', 'verified', 'bio', 'privateAccount', 'gifterLevel', 'secUid'];

export const historyFile = (dataDir, room) => pathJoin(dataDir, `history-${room}.json`);

export class RoomHistory {
  constructor(room, file) {
    this.room = room;
    this.file = file;
    this.users = new Map(); // key -> record
    this.byName = new Map(); // lowercase username/alias -> key
  }

  static key(userId, username) { return userId ? String(userId) : `@${String(username).toLowerCase()}`; }

  load() {
    if (!this.file || !existsSync(this.file)) return 0;
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    for (const [k, r] of Object.entries(data.users ?? {})) this._index(k, r);
    return this.users.size;
  }

  _index(key, rec) {
    this.users.set(key, rec);
    for (const n of [rec.username, ...(rec.aliases ?? [])]) if (n) this.byName.set(n.toLowerCase(), key);
  }

  /** Merge today's tracker records under `date` (YYYY-MM-DD). */
  update(users, date, now = Date.now()) {
    for (const u of users) {
      let key = RoomHistory.key(u.userId, u.username);
      let rec = this.users.get(key);
      if (!rec && u.userId) {
        // records saved before we knew the id live under "@username"; adopt them
        const old = this.users.get(`@${u.username.toLowerCase()}`);
        if (old) { this.users.delete(`@${u.username.toLowerCase()}`); rec = old; }
      }
      if (!rec) rec = { userId: u.userId ?? null, username: u.username, nickname: u.nickname ?? null, aliases: [], nicknames: [], profile: {}, isFollower: null, isAdmin: false, days: {} };
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
      for (const f of PROFILE_FIELDS) if (u[f] !== null && u[f] !== undefined) rec.profile[f] = u[f];
      if (typeof u.isFollower === 'boolean') rec.isFollower = u.isFollower;
      if (u.followed) rec.isFollower = true;
      if (u.isAdmin) rec.isAdmin = true;
      const day = { firstSeen: u.firstSeen, lastSeen: u.lastSeen };
      for (const f of DAY_FIELDS) day[f] = u[f] ?? 0;
      if (u.present && u.sessionStart !== null) day.presentMs += Math.max(0, now - u.sessionStart);
      rec.days[date] = day;
      this._index(key, rec);
    }
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const users = Object.fromEntries([...this.users.entries()].sort((a, b) => firstSeen(a[1]) - firstSeen(b[1])));
    writeFileSync(this.file, JSON.stringify({ room: this.room, updatedAt: new Date().toISOString(), users }, null, 2));
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
    const dates = Object.keys(rec.days).sort();
    const totals = Object.fromEntries(DAY_FIELDS.map(f => [f, 0]));
    for (const d of dates) for (const f of DAY_FIELDS) totals[f] += rec.days[d][f] ?? 0;
    return {
      firstSeenEver: firstSeen(rec), lastSeenEver: lastSeen(rec),
      daysSeen: dates.length, dates, totals,
      aliases: rec.aliases ?? [], nicknames: rec.nicknames ?? [], profile: rec.profile ?? {},
      isFollower: rec.isFollower ?? null,
    };
  }

  summary(u) { return RoomHistory.summarize(this.get(u)); }
}

const firstSeen = rec => Math.min(...Object.values(rec.days).map(d => d.firstSeen ?? Infinity));
const lastSeen = rec => Math.max(...Object.values(rec.days).map(d => d.lastSeen ?? 0));

/**
 * Read every other room's history file so a viewer can be looked up across rooms.
 * Returns { lookup(u) -> [{ room, follows, daysSeen, lastSeen, username }] }.
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
      const entry = { room, username: rec.username, follows: s.isFollower, daysSeen: s.daysSeen, lastSeen: s.lastSeenEver, firstSeen: s.firstSeenEver };
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
