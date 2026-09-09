// Tracks viewer presence and activity from TikTok LIVE events.
//
// TikTok sends no "user left" event, so a leave is inferred either when the user
// re-joins (they must have left in between) or after `timeoutMs` with no activity.
// The recorded leave time is the last moment we saw the user, so it is never later than reality.

export class ViewerTracker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]     inactivity after which a present user is assumed gone
   * @param {number} [opts.chatHistory]   how many recent chat messages to keep per user
   */
  constructor(opts = {}) {
    if (typeof opts === 'number') opts = { timeoutMs: opts };
    this.timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
    this.chatHistory = opts.chatHistory ?? 50;
    this.users = new Map(); // username (displayId) -> record
  }

  /** A fresh record with every field present. */
  _blank(username, now) {
    return {
        username, nickname: null, userId: null,
        firstSeen: now, lastSeen: now,
        firstLeft: null, lastLeft: null,
        joins: 0, present: false,
        leftHow: null, // 'rejoin' | 'timeout'
        chats: 0, likes: 0, gifts: 0, coins: 0, shares: 0, followed: false,
        isAdmin: false, isFollower: null,
        presentMs: 0, sessionStart: null, // time spent in the room (completed visits) and start of the current visit
        // profile fields TikTok attaches to events (null = never delivered)
        secUid: null, followers: null, following: null, accountCreated: null,
        verified: null, bio: null, privateAccount: null, gifterLevel: null,
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
    for (const k of ['secUid', 'followers', 'following', 'accountCreated', 'verified', 'bio', 'privateAccount', 'gifterLevel']) {
      if (info?.[k] !== undefined && info[k] !== null) u[k] = info[k];
    }
    return u;
  }

  _markLeft(u, when, how) {
    u.present = false;
    u.leftHow = how;
    if (u.sessionStart !== null) { u.presentMs += Math.max(0, when - u.sessionStart); u.sessionStart = null; }
    if (u.firstLeft === null) u.firstLeft = when;
    u.lastLeft = when;
  }

  _touch(u, now) {
    if (!u.present) u.sessionStart = now;
    u.present = true;
    if (now > u.lastSeen) u.lastSeen = now;
  }

  /** Total time a user has spent in the room today, including the current visit. */
  timeInRoom(u, now = Date.now()) {
    return u.presentMs + (u.present && u.sessionStart !== null ? Math.max(0, now - u.sessionStart) : 0);
  }

  /** WebcastMemberMessage: user entered the room. */
  join(username, info, now = Date.now()) {
    const u = this._get(username, info, now);
    if (u.present) this._markLeft(u, u.lastSeen, 'rejoin'); // must have left before re-joining
    u.joins++;
    this._touch(u, now);
    return u;
  }

  /** Any activity proves the user is still here. `kind` updates the matching counter. */
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

  /** Call periodically. Marks present users idle for > timeoutMs as left. Returns those users. */
  sweep(now = Date.now()) {
    const left = [];
    for (const u of this.users.values()) {
      if (u.present && now - u.lastSeen > this.timeoutMs) {
        this._markLeft(u, u.lastSeen, 'timeout');
        left.push(u);
      }
    }
    return left;
  }

  /** Mark everyone as gone (stream ended / we disconnected for long). */
  clearPresence(now = Date.now()) {
    for (const u of this.users.values()) if (u.present) this._markLeft(u, Math.min(u.lastSeen, now), 'timeout');
  }

  all() { return [...this.users.values()].sort((a, b) => a.firstSeen - b.firstSeen); }
  present() { return this.all().filter(u => u.present); }
  get(username) { return this.users.get(String(username ?? '').replace(/^@/, '')); }
  find(q) {
    q = q.toLowerCase();
    return this.all().filter(u => u.username.toLowerCase().includes(q) || (u.nickname || '').toLowerCase().includes(q));
  }
  /** Most active users by a numeric field. */
  top(field = 'chats', n = 20) {
    return this.all().filter(u => (u[field] ?? 0) > 0).sort((a, b) => b[field] - a[field]).slice(0, n);
  }

  toJSON() { return { timeoutMs: this.timeoutMs, users: this.all() }; }

  /** Merge saved records (from toJSON) into this tracker. Nobody is marked present. */
  load(data) {
    const users = Array.isArray(data) ? data : data?.users ?? [];
    for (const r of users) {
      const id = r.username ?? r.uniqueId; if (!id) continue;
      const existing = this.users.get(id);
      const rec = { ...this._blank(id, r.firstSeen ?? Date.now()), ...(existing ?? {}), ...r, username: id, present: false, sessionStart: null, presentMs: r.presentMs ?? existing?.presentMs ?? 0, chatLog: r.chatLog ?? existing?.chatLog ?? [] };
      delete rec.uniqueId;
      if (existing) {
        rec.firstSeen = Math.min(existing.firstSeen, r.firstSeen ?? existing.firstSeen);
        rec.lastSeen = Math.max(existing.lastSeen, r.lastSeen ?? 0);
      }
      this.users.set(id, rec);
    }
    return this.users.size;
  }
}
