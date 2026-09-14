// Tracks the viewers seen in the current stream and what they did.
//
// TikTok sends no "user left" event, so nobody is ever marked as gone: an account is simply
// "seen this stream" from its first event onwards. A repeated join means they left and came back.

export class ViewerTracker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.chatHistory]   how many recent chat messages to keep per user
   */
  constructor(opts = {}) {
    this.chatHistory = opts.chatHistory ?? 50;
    this.users = new Map(); // username (displayId) -> record
  }

  /** A fresh record with every field present. */
  _blank(username, now) {
    return {
        username, nickname: null, userId: null,
        firstSeen: now, lastSeen: now,
        joins: 0, lastJoin: null,
        chats: 0, likes: 0, gifts: 0, coins: 0, shares: 0, followed: false,
        isAdmin: false, isFollower: null,
        hops: [], // moves between this room and a blacklisted streamer's stream: { t, dir: 'from' | 'to', room, gapMs }
        dismissedAt: null, // hidden from the suspect lists since this time; a later join clears it
        // profile fields TikTok attaches to events (null = never delivered)
        secUid: null, followers: null, following: null,
        verified: null, privateAccount: null, gifterLevel: null,
        chatLog: [], // most recent {t, text}
    };
  }

  _get(username, info, now) {
    let u = this.users.get(username);
    if (!u) { u = this._blank(username, now); this.users.set(username, u); }
    if (info?.nickname) u.nickname = info.nickname;
    if (info?.userId) u.userId = info.userId;
    if (info?.isAdmin) u.isAdmin = true;
    if (typeof info?.isFollower === 'boolean') u.isFollower = info.isFollower;
    for (const k of ['secUid', 'followers', 'following', 'verified', 'privateAccount', 'gifterLevel']) {
      if (info?.[k] !== undefined && info[k] !== null) u[k] = info[k];
    }
    return u;
  }

  _touch(u, now) { if (now > u.lastSeen) u.lastSeen = now; }

  /** WebcastMemberMessage: user entered the room. */
  join(username, info, now = Date.now()) {
    const u = this._get(username, info, now);
    if (u.dismissedAt !== null && now >= u.dismissedAt) u.dismissedAt = null; // back in the room: worth a fresh look
    u.joins++;
    u.lastJoin = now;
    this._touch(u, now);
    return u;
  }

  /** Any activity proves the user is here. `kind` updates the matching counter. */
  activity(username, info, kind = null, extra = {}, now = Date.now()) {
    const u = this._get(username, info, now);
    this._touch(u, now);
    switch (kind) {
      case 'chat':
        u.chats++;
        if (extra.text !== undefined) {
          u.chatLog.push({ t: now, text: extra.text });
          if (u.chatLog.length > this.chatHistory) u.chatLog.splice(0, u.chatLog.length - this.chatHistory);
        }
        break;
      case 'like': u.likes += extra.count ?? 1; break;
      case 'gift': u.gifts += extra.count ?? 1; u.coins += extra.coins ?? 0; break;
      case 'share': u.shares++; break;
      case 'follow': u.followed = true; u.isFollower = true; break;
    }
    return u;
  }

  /**
   * Record a move between this room and a blacklisted streamer's stream. Returns the record, or
   * null when the same move was already recorded less than a minute ago (duplicate events).
   */
  hop(username, dir, room, gapMs, now = Date.now()) {
    const u = this.users.get(username);
    if (!u) return null;
    const last = u.hops[u.hops.length - 1];
    if (last && last.dir === dir && last.room === room && now - last.t < 60_000) return null;
    u.hops.push({ t: now, dir, room, gapMs: Math.max(0, gapMs) });
    if (u.hops.length > 50) u.hops.shift();
    return u;
  }

  all() { return [...this.users.values()].sort((a, b) => a.firstSeen - b.firstSeen); }
  get(username) { return this.users.get(String(username ?? '').replace(/^@/, '')); }
  find(q) {
    q = q.toLowerCase();
    return this.all().filter(u => u.username.toLowerCase().includes(q) || (u.nickname || '').toLowerCase().includes(q));
  }
  /** Most active users by a numeric field. */
  top(field = 'chats', n = 20) {
    return this.all().filter(u => (u[field] ?? 0) > 0).sort((a, b) => b[field] - a[field]).slice(0, n);
  }

  toJSON() { return { users: this.all() }; }

  /** Merge saved records (from toJSON) into this tracker. */
  load(data) {
    const users = Array.isArray(data) ? data : data?.users ?? [];
    for (const r of users) {
      const id = r.username ?? r.uniqueId; if (!id) continue;
      const existing = this.users.get(id);
      const rec = { ...this._blank(id, r.firstSeen ?? Date.now()), ...(existing ?? {}), ...r, username: id, hops: r.hops ?? existing?.hops ?? [], chatLog: r.chatLog ?? existing?.chatLog ?? [] };
      // fields from older versions (presence and idle timeouts no longer exist)
      for (const f of ['uniqueId', 'present', 'firstLeft', 'lastLeft', 'leftHow', 'presentMs', 'sessionStart']) delete rec[f];
      // Snapshots from older versions hold `false` here when TikTok simply left the field out; that is unknown, not "no".
      for (const f of ['privateAccount', 'verified']) if (rec[f] === false) rec[f] = null;
      if (existing) {
        rec.firstSeen = Math.min(existing.firstSeen, r.firstSeen ?? existing.firstSeen);
        rec.lastSeen = Math.max(existing.lastSeen, r.lastSeen ?? 0);
      }
      this.users.set(id, rec);
    }
    return this.users.size;
  }
}
