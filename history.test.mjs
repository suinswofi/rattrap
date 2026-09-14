import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ViewerTracker } from './tracker.js';
import { RoomHistory, historyFile, loadRoomIndex, makeSid, streamLabel, MAX_EVENTS } from './history.js';
import { scoreUser, WEIGHTS, hopText } from './burner.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

test('tracker keeps profile fields', () => {
  const t = new ViewerTracker();
  t.join('a', { followers: 0, following: 3, privateAccount: true }, 0);
  t.activity('a', { followers: 2 }, 'chat', { text: 'x' }, 3 * MIN);
  assert.equal(t.get('a').followers, 2);
  assert.equal(t.get('a').following, 3);
  assert.equal(t.get('a').privateAccount, true);
});

test('stream ids are readable and sort chronologically', () => {
  const t = new Date(2026, 8, 8, 21, 5).getTime();
  assert.equal(makeSid(t), '2026-09-08_21-05');
  assert.equal(streamLabel('2026-09-08_21-05'), '2026-09-08 21:05');
  assert.equal(streamLabel('2026-09-08'), '2026-09-08', 'streams migrated from per-day files keep the bare date');
  assert.ok(makeSid(t) < makeSid(t + DAY));
});

test('history persists across streams, sums totals and tracks renames', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const file = historyFile(dir, 'host');
    const h1 = new RoomHistory('host', file);
    const t1 = new ViewerTracker();
    t1.join('oldname', { userId: '42', nickname: 'N', followers: 0 }, DAY + 100);
    t1.activity('oldname', {}, 'chat', { text: 'hi' }, DAY + 200);
    h1.update(t1.all(), '2026-09-01_20-00');
    h1.update(t1.all(), '2026-09-01_20-00'); // second autosave same stream: no double counting
    h1.touchStream({ sid: '2026-09-01_20-00', roomId: 'r1', monitoredAt: DAY + 50, startedAt: DAY, endedAt: null });
    h1.save();

    const h2 = new RoomHistory('host', file);
    assert.equal(h2.load(), 1);
    assert.equal(h2.streams['2026-09-01_20-00'].roomId, 'r1');
    assert.equal(h2.findStreamByRoomId('r1').sid, '2026-09-01_20-00');
    assert.equal(h2.findStreamByRoomId('nope'), null);
    const t2 = new ViewerTracker();
    t2.join('newname', { userId: '42' }, 3 * DAY);
    t2.activity('newname', {}, 'chat', { text: 'again' }, 3 * DAY + 1);
    h2.update(t2.all(), '2026-09-03_09-30');
    h2.touchStream({ sid: '2026-09-03_09-30', roomId: 'r2', monitoredAt: 3 * DAY });
    const s = h2.summary(t2.get('newname'));
    assert.equal(s.streamsSeen, 2);
    assert.equal(s.daysSeen, 2);
    assert.deepEqual(s.streams.map(x => x.sid), ['2026-09-01_20-00', '2026-09-03_09-30']);
    assert.equal(s.streams[0].label, '2026-09-01 20:00');
    assert.equal(s.firstSeenEver, DAY + 100);
    assert.equal(s.totals.chats, 2);
    assert.deepEqual(s.aliases, ['oldname']);
    assert.equal(s.profile.followers, 0);
    assert.equal(h2.get('oldname').username, 'newname'); // alias lookup still works
    assert.equal(h2.get('@newname').userId, '42');
    assert.deepEqual(h2.streamList().map(x => x.sid), ['2026-09-03_09-30', '2026-09-01_20-00'], 'newest first');
    assert.equal(h2.latestStream().sid, '2026-09-03_09-30');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('per-day files from older versions are read as one stream per day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const file = historyFile(dir, 'host');
    writeFileSync(file, JSON.stringify({ room: 'host', users: {
      '1': { userId: '1', username: 'a', nickname: 'A', aliases: [], nicknames: [], profile: { followers: 3, privateAccount: false }, isFollower: true, isAdmin: false,
        days: { '2026-09-07': { firstSeen: 1000, lastSeen: 5000, joins: 1, chats: 2, likes: 0, gifts: 0, coins: 0, shares: 0, presentMs: 4000 }, '2026-09-08': { firstSeen: DAY + 1000, lastSeen: DAY + 2000, joins: 1, chats: 0, likes: 0, gifts: 0, coins: 0, shares: 0, presentMs: 0 } } },
      '2': { userId: '2', username: 'b', aliases: [], nicknames: [], profile: {}, isFollower: null, isAdmin: false, days: { '2026-09-07': { firstSeen: 500, lastSeen: 9000, joins: 3, chats: 0, likes: 0, gifts: 0, coins: 0, shares: 0, presentMs: 0 } } },
    } }));
    const h = new RoomHistory('host', file);
    assert.equal(h.load(), 2);
    const s = h.summary('a');
    assert.equal(s.streamsSeen, 2);
    assert.equal(s.daysSeen, 2);
    assert.equal(s.totals.chats, 2);
    assert.equal(s.streams[0].presentMs, undefined);
    assert.equal(s.streams[0].hops, 0);
    assert.equal(s.profile.privateAccount, undefined, 'false meant "not sent"');
    assert.deepEqual(h.streamList().map(x => x.sid), ['2026-09-08', '2026-09-07']);
    const day = h.streams['2026-09-07'];
    assert.equal(day.legacy, true);
    assert.equal(day.monitoredAt, 500, 'earliest sighting that day');
    assert.equal(day.endedAt, 9000, 'latest sighting that day');
    h.save();
    const again = new RoomHistory('host', file); again.load();
    assert.equal(again.get('a').days, undefined);
    assert.equal(again.summary('a').streamsSeen, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('records without an id are adopted once the id is known', () => {
  const h = new RoomHistory('host', null);
  const t = new ViewerTracker();
  t.join('x', {}, 0);
  h.update(t.all(), '2026-09-01_10-00');
  assert.ok(h.users.has('@x'));
  t.activity('x', { userId: '7' }, 'like', {}, 2);
  h.update(t.all(), '2026-09-02_10-00');
  assert.ok(!h.users.has('@x'));
  assert.equal(h.summary({ userId: '7', username: 'x' }).streamsSeen, 2);
});

test('retained events are kept per account and capped', () => {
  const h = new RoomHistory('host', null);
  const u = { userId: '9', username: 'pinned_one', nickname: 'P' };
  assert.equal(h.addEvent(u, { t: 1, sid: 's1', kind: 'like', text: 'x' }), null, 'likes are not logged, so not retained');
  h.addEvent(u, { t: 2, sid: 's1', kind: 'chat', text: 'hello' });
  h.addEvent(u, { t: 3, sid: 's1', kind: 'hop', text: 'came from…' });
  assert.deepEqual(h.summary(u).events.map(e => e.kind), ['chat', 'hop']);
  assert.equal(h.summary(u).streamsSeen, 0, 'an events-only record has no stream stats yet');
  assert.equal(h.summary(u).firstSeenEver, null);
  h.setEvents(u, [{ t: 5, sid: 's2', kind: 'join', text: 'joined' }, { t: 4, sid: 's1', kind: 'chat', text: 'later' }]);
  assert.deepEqual(h.summary(u).events.map(e => e.t), [4, 5], 'sorted by time');
  for (let i = 0; i < MAX_EVENTS + 10; i++) h.addEvent(u, { t: 100 + i, sid: 's2', kind: 'chat', text: String(i) });
  assert.equal(h.summary(u).events.length, MAX_EVENTS);
  assert.equal(h.summary(u).events[0].text, '10');
  assert.equal(h.prune(1, new Set(), 1000), 0, 'an events-only record is not pruned as stale');
});

test('cross-room index reports follow status towards other hosts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const bad = new RoomHistory('badguy', historyFile(dir, 'badguy'));
    const t = new ViewerTracker();
    t.join('burner1', { userId: '1', isFollower: true }, 0);
    t.join('visitor', { userId: '2', isFollower: false }, 0);
    bad.update(t.all(), '2026-09-01_20-00');
    bad.save();
    writeFileSync(join(dir, 'history-broken.json'), '{not json'); // must be skipped
    const idx = loadRoomIndex(dir, 'host');
    assert.deepEqual(idx.rooms, ['badguy']);
    assert.equal(idx.lookup({ userId: '1', username: 'renamed' })[0].follows, true);
    assert.equal(idx.lookup({ userId: '1', username: 'renamed' })[0].streamsSeen, 1);
    assert.equal(idx.lookup({ userId: '2', username: 'visitor' })[0].follows, false);
    assert.equal(idx.lookup({ userId: null, username: 'BURNER1' }).length, 1); // name fallback
    assert.equal(idx.lookup({ userId: '999', username: 'nobody' }).length, 0);
    assert.equal(loadRoomIndex(dir, 'badguy').rooms.length, 0); // own room excluded
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('burner score adds up with reasons', () => {
  const t = new ViewerTracker();
  t.join('user8237461920', { userId: '1', nickname: 'user8237461920', followers: 0, following: 0, privateAccount: true }, 0);
  const u = t.get('user8237461920');
  const r = scoreUser(u, { sid: 'now', history: { streams: [{ sid: 'now' }], aliases: ['older'], profile: {} },
    rooms: [{ room: 'BadGuy', follows: true, daysSeen: 2 }, { room: 'fine', follows: true, daysSeen: 1 }], blacklist: new Set(['badguy']) });
  const expected = WEIGHTS.followsBlacklisted + WEIGHTS.renamed + WEIGHTS.noFollowers + WEIGHTS.followsNobody
    + WEIGHTS.defaultUsername + WEIGHTS.defaultNickname + WEIGHTS.privateAccount + WEIGHTS.newToRoom + WEIGHTS.lurker;
  assert.equal(r.score, expected);
  assert.equal(r.blacklistScore, WEIGHTS.followsBlacklisted);
  assert.deepEqual(r.blacklisted, ['BadGuy']);
  assert.ok(r.reasons.some(x => x.includes('follows blacklisted @BadGuy')));
  assert.ok(r.reasons.includes('first time in this room'), 'the current stream does not count as an earlier visit');
  assert.ok(!r.reasons.some(x => x.includes('@fine')));

  const t2 = new ViewerTracker();
  t2.join('regular_jane', { userId: '2', nickname: 'Jane', followers: 500, following: 200 }, 0);
  t2.activity('regular_jane', {}, 'chat', { text: 'hello' }, 1);
  const r2 = scoreUser(t2.get('regular_jane'), { sid: 'now', history: { streams: [{ sid: 'a' }, { sid: 'b' }], aliases: [], profile: {} } });
  assert.equal(r2.score, 0);
  assert.deepEqual(r2.reasons, []);

  // unknown profile: no follower penalties, only behaviour
  const r3 = scoreUser(t.get('user8237461920'), { history: null });
  assert.ok(r3.reasons.includes('first time in this room'));
  assert.ok(!r3.reasons.some(x => /minutes|stayed/.test(x)), 'no time-in-room signals: TikTok never reports leaves');

  // seen in a blacklisted stream right now, with and without a recorded hop
  t.hop('user8237461920', 'from', 'badguy', 2 * MIN, 5 * MIN);
  const r4 = scoreUser(t.get('user8237461920'), { liveIn: ['badguy'], blacklist: new Set(['badguy']), rooms: [{ room: 'badguy', follows: false, daysSeen: 1 }] });
  assert.ok(r4.reasons.includes(hopText({ dir: 'from', room: 'badguy', gapMs: 2 * MIN })));
  assert.equal(r4.blacklistScore, WEIGHTS.inBlacklistedStream, 'the earlier-visit points are not added on top of the live overlap');
  const r5 = scoreUser(t2.get('regular_jane'), { liveIn: ['badguy'], blacklist: new Set(['badguy']) });
  assert.ok(r5.reasons.includes("also in blacklisted @badguy's current stream"));
  assert.equal(hopText({ dir: 'to', room: 'x', gapMs: 65 * MIN }), "went to blacklisted @x's stream (1h05m after last seen here)");
});
