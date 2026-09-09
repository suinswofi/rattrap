import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewerTracker } from './tracker.js';

const MIN = 60_000;

test('join / activity / timeout sweep', () => {
  const t = new ViewerTracker({ timeoutMs: 10 * MIN });
  t.join('alice', { nickname: 'Alice' }, 0);
  t.activity('alice', null, 'chat', { text: 'hi' }, 5 * MIN);
  assert.equal(t.sweep(14 * MIN).length, 0);
  const left = t.sweep(16 * MIN);
  assert.equal(left.length, 1);
  const a = t.get('alice');
  assert.equal(a.present, false);
  assert.equal(a.leftHow, 'timeout');
  assert.equal(a.firstLeft, 5 * MIN); // last seen, not sweep time
  assert.equal(a.chats, 1);
  assert.deepEqual(a.chatLog, [{ t: 5 * MIN, text: 'hi' }]);
});

test('re-join implies a leave in between', () => {
  const t = new ViewerTracker({ timeoutMs: 60 * MIN });
  t.join('bob', {}, 0);
  t.activity('bob', null, 'like', { count: 5 }, 2 * MIN);
  t.join('bob', {}, 7 * MIN);
  const b = t.get('@bob');
  assert.equal(b.joins, 2);
  assert.equal(b.present, true);
  assert.equal(b.leftHow, 'rejoin');
  assert.equal(b.firstLeft, 2 * MIN);
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

test('save and load round-trip merges records', () => {
  const t = new ViewerTracker();
  t.join('f', { nickname: 'F' }, 100);
  t.activity('f', {}, 'chat', { text: 'x' }, 200);
  const saved = JSON.parse(JSON.stringify(t));
  const t2 = new ViewerTracker();
  t2.join('f', {}, 50);
  t2.load(saved);
  const f = t2.get('f');
  assert.equal(f.present, false);
  assert.equal(f.firstSeen, 50);
  assert.equal(f.lastSeen, 200);
  assert.equal(f.chats, 1);
  assert.equal(f.nickname, 'F');
});
