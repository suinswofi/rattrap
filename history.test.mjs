import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ViewerTracker } from './tracker.js';
import { RoomHistory, historyFile, loadRoomIndex } from './history.js';
import { scoreUser, WEIGHTS } from './burner.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

test('tracker keeps profile fields and time in room', () => {
  const t = new ViewerTracker({ timeoutMs: 10 * MIN });
  t.join('a', { followers: 0, following: 3, privateAccount: true }, 0);
  t.activity('a', { followers: 2 }, 'chat', { text: 'x' }, 3 * MIN);
  assert.equal(t.get('a').followers, 2);
  assert.equal(t.get('a').following, 3);
  assert.equal(t.get('a').privateAccount, true);
  assert.equal(t.timeInRoom(t.get('a'), 5 * MIN), 5 * MIN);
  t.sweep(20 * MIN); // left at last seen (3 min)
  assert.equal(t.timeInRoom(t.get('a'), 30 * MIN), 3 * MIN);
  t.join('a', {}, 40 * MIN);
  assert.equal(t.timeInRoom(t.get('a'), 41 * MIN), 4 * MIN);
});

test('history persists across days, sums totals and tracks renames', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bouncer-'));
  try {
    const file = historyFile(dir, 'host');
    const h1 = new RoomHistory('host', file);
    const t1 = new ViewerTracker();
    t1.join('oldname', { userId: '42', nickname: 'N', followers: 0 }, DAY + 100);
    t1.activity('oldname', {}, 'chat', { text: 'hi' }, DAY + 200);
    h1.update(t1.all(), '2026-09-01', DAY + 300);
    h1.update(t1.all(), '2026-09-01', DAY + 400); // second autosave same day: no double counting
    h1.save();

    const h2 = new RoomHistory('host', file);
    assert.equal(h2.load(), 1);
    const t2 = new ViewerTracker();
    t2.join('newname', { userId: '42' }, 3 * DAY);
    t2.activity('newname', {}, 'chat', { text: 'again' }, 3 * DAY + 1);
    h2.update(t2.all(), '2026-09-03', 3 * DAY + 2);
    const s = h2.summary(t2.get('newname'));
    assert.equal(s.daysSeen, 2);
    assert.equal(s.firstSeenEver, DAY + 100);
    assert.equal(s.totals.chats, 2);
    assert.deepEqual(s.aliases, ['oldname']);
    assert.equal(s.profile.followers, 0);
    assert.equal(h2.get('oldname').username, 'newname'); // alias lookup still works
    assert.equal(h2.get('@newname').userId, '42');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('records without an id are adopted once the id is known', () => {
  const h = new RoomHistory('host', null);
  const t = new ViewerTracker();
  t.join('x', {}, 0);
  h.update(t.all(), '2026-09-01', 1);
  assert.ok(h.users.has('@x'));
  t.activity('x', { userId: '7' }, 'like', {}, 2);
  h.update(t.all(), '2026-09-02', 3);
  assert.ok(!h.users.has('@x'));
  assert.equal(h.summary({ userId: '7', username: 'x' }).daysSeen, 2);
});

test('cross-room index reports follow status towards other hosts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bouncer-'));
  try {
    const bad = new RoomHistory('badguy', historyFile(dir, 'badguy'));
    const t = new ViewerTracker();
    t.join('burner1', { userId: '1', isFollower: true }, 0);
    t.join('visitor', { userId: '2', isFollower: false }, 0);
    bad.update(t.all(), '2026-09-01', 1);
    bad.save();
    writeFileSync(join(dir, 'history-broken.json'), '{not json'); // must be skipped
    const idx = loadRoomIndex(dir, 'host');
    assert.deepEqual(idx.rooms, ['badguy']);
    assert.equal(idx.lookup({ userId: '1', username: 'renamed' })[0].follows, true);
    assert.equal(idx.lookup({ userId: '2', username: 'visitor' })[0].follows, false);
    assert.equal(idx.lookup({ userId: null, username: 'BURNER1' }).length, 1); // name fallback
    assert.equal(idx.lookup({ userId: '999', username: 'nobody' }).length, 0);
    assert.equal(loadRoomIndex(dir, 'badguy').rooms.length, 0); // own room excluded
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('burner score adds up with reasons', () => {
  const now = 100 * DAY;
  const t = new ViewerTracker();
  t.join('user8237461920', { userId: '1', nickname: 'user8237461920', followers: 0, following: 0, privateAccount: true }, now - 30_000);
  const u = t.get('user8237461920');
  const r = scoreUser(u, { now, timeInRoom: 30_000, history: { daysSeen: 1, aliases: ['older'], profile: {} },
    rooms: [{ room: 'BadGuy', follows: true, daysSeen: 2 }, { room: 'fine', follows: true, daysSeen: 1 }], blacklist: new Set(['badguy']) });
  const expected = WEIGHTS.followsBlacklisted + WEIGHTS.renamed + WEIGHTS.noFollowers + WEIGHTS.followsNobody
    + WEIGHTS.defaultUsername + WEIGHTS.defaultNickname + WEIGHTS.privateAccount + WEIGHTS.newToRoom + WEIGHTS.lurker;
  assert.equal(r.score, expected);
  assert.deepEqual(r.blacklisted, ['BadGuy']);
  assert.ok(r.reasons.some(x => x.includes('follows blacklisted @BadGuy')));
  assert.ok(!r.reasons.some(x => x.includes('@fine')));

  const t2 = new ViewerTracker();
  t2.join('regular_jane', { userId: '2', nickname: 'Jane', followers: 500, following: 200 }, 0);
  t2.activity('regular_jane', {}, 'chat', { text: 'hello' }, 1);
  const r2 = scoreUser(t2.get('regular_jane'), { now, timeInRoom: 60 * MIN, history: { daysSeen: 12, aliases: [], profile: {} } });
  assert.equal(r2.score, 0);
  assert.deepEqual(r2.reasons, []);

  // unknown profile: no bio/follower penalties, only behaviour
  const r3 = scoreUser(t.get('user8237461920'), { now, timeInRoom: 30_000, history: null });
  assert.ok(r3.reasons.includes('first day in this room'));
});
