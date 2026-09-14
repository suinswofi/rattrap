import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewerTracker } from './tracker.js';

const MIN = 60_000;

test('join / activity: nobody is ever marked as gone', () => {
  const t = new ViewerTracker();
  t.join('alice', { nickname: 'Alice' }, 0);
  t.activity('alice', null, 'chat', { text: 'hi' }, 5 * MIN);
  const a = t.get('alice');
  assert.equal(a.joins, 1);
  assert.equal(a.lastJoin, 0);
  assert.equal(a.lastSeen, 5 * MIN);
  assert.equal(a.chats, 1);
  assert.deepEqual(a.chatLog, [{ t: 5 * MIN, text: 'hi' }]);
  assert.equal(a.present, undefined, 'no presence field');
});

test('repeated joins are counted', () => {
  const t = new ViewerTracker();
  t.join('bob', {}, 0);
  t.activity('bob', null, 'like', { count: 5 }, 2 * MIN);
  t.join('bob', {}, 7 * MIN);
  const b = t.get('@bob');
  assert.equal(b.joins, 2);
  assert.equal(b.lastJoin, 7 * MIN);
  assert.equal(b.likes, 5);
});

test('gift coins, follow flag, top()', () => {
  const t = new ViewerTracker();
  t.activity('c', {}, 'gift', { count: 3, coins: 30 }, 0);
  t.activity('d', {}, 'gift', { count: 1, coins: 500 }, 0);
  t.activity('d', {}, 'follow', {}, 0);
  assert.deepEqual(t.top('coins').map(u => u.username), ['d', 'c']);
  assert.equal(t.get('d').followed, true);
  assert.equal(t.get('d').isFollower, true);
});

test('chat history is capped', () => {
  const t = new ViewerTracker({ chatHistory: 2 });
  for (let i = 0; i < 5; i++) t.activity('e', {}, 'chat', { text: String(i) }, i);
  assert.deepEqual(t.get('e').chatLog.map(c => c.text), ['3', '4']);
});

test('hops are recorded, with duplicates within a minute ignored', () => {
  const t = new ViewerTracker();
  assert.equal(t.hop('ghost', 'from', 'rival', 1000, 0), null, 'unknown accounts are ignored');
  t.join('h', {}, 0);
  assert.ok(t.hop('h', 'from', 'rival', 3 * MIN, 10 * MIN));
  assert.equal(t.hop('h', 'from', 'rival', 3 * MIN, 10 * MIN + 30_000), null);
  assert.ok(t.hop('h', 'to', 'rival', -5, 11 * MIN), 'a different direction is a new move');
  assert.ok(t.hop('h', 'from', 'rival', 2 * MIN, 12 * MIN));
  assert.deepEqual(t.get('h').hops.map(x => [x.dir, x.gapMs]), [['from', 3 * MIN], ['to', 0], ['from', 2 * MIN]]);
});

test('save and load round-trip merges records and drops presence fields of older versions', () => {
  const t = new ViewerTracker();
  t.join('f', { nickname: 'F' }, 100);
  t.activity('f', {}, 'chat', { text: 'x' }, 200);
  t.hop('f', 'to', 'rival', 50, 250);
  const saved = JSON.parse(JSON.stringify(t));
  saved.users[0].present = true; saved.users[0].leftHow = 'timeout'; saved.users[0].presentMs = 5; // as written by 1.0.x
  const t2 = new ViewerTracker();
  t2.join('f', {}, 50);
  t2.load(saved);
  const f = t2.get('f');
  assert.equal(f.firstSeen, 50);
  assert.equal(f.lastSeen, 200, 'a hop is not a sighting');
  assert.equal(f.chats, 1);
  assert.equal(f.nickname, 'F');
  assert.equal(f.hops.length, 1);
  for (const k of ['present', 'leftHow', 'presentMs', 'sessionStart']) assert.equal(k in f, false, k);
});
