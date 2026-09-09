import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { Monitor, DEFAULTS, normalizeConfig, who } from './monitor.js';

class FakeConnection extends EventEmitter {
  constructor() { super(); this.connected = false; }
  async connect() { this.connected = true; return { roomId: 'r1', roomInfo: { data: { title: 'test stream', user_count: 42 } } }; }
  disconnect() { this.connected = false; }
  async waitUntilLive() { return true; }
}

const DAY = 864e5;
const user = (displayId, extra = {}) => ({ user: { displayId, id: extra.id ?? `id-${displayId}`, nickname: extra.nickname ?? `Nick ${displayId}`, followInfo: extra.followInfo, createTime: extra.createTime, bioDescription: extra.bio, secret: extra.secret, userAttr: extra.userAttr } });
const cfgFor = dir => normalizeConfig({ ...DEFAULTS, dataDir: dir, autosaveMinutes: 0, blacklist: ['badguy'], watch: ['vip'] }, null);
const tick = () => new Promise(r => setTimeout(r, 5));

test('who() maps the v2 user shape', () => {
  const w = who(user('alice', { followInfo: { followerCount: '12', followingCount: '3', followStatus: '1' }, createTime: '1700000000', bio: '', secret: 0 }));
  assert.equal(w.username, 'alice');
  assert.equal(w.info.followers, 12);
  assert.equal(w.info.following, 3);
  assert.equal(w.info.isFollower, true);
  assert.equal(w.info.accountCreated, 1700000000000);
  assert.equal(w.info.bio, '');
  assert.equal(w.info.privateAccount, false);
  assert.equal(who({}), null);
});

test('monitor tracks events, flags burners, and saves history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bouncer-'));
  try {
    const conn = new FakeConnection();
    const cfg = cfgFor(dir);
    const m = new Monitor('Host', cfg, { createConnection: () => conn });
    const states = [], flags = [], logs = [];
    m.on('status', s => states.push(s.state));
    m.on('flag', f => flags.push(f));
    m.on('log', l => logs.push(l));
    m.start();
    await tick();
    assert.equal(m.state, 'live');
    assert.deepEqual(states, ['connecting', 'live']);
    assert.equal(m.room.title, 'test stream');
    assert.equal(m.room.viewers, 42);

    conn.emit(WebcastEvent.MEMBER, { ...user('regular_jane', { nickname: 'Jane', followInfo: { followerCount: '900', followingCount: '100', followStatus: '1' }, createTime: String(Math.floor((Date.now() - 800 * DAY) / 1000)), bio: 'hello' }), memberCount: 43 });
    conn.emit(WebcastEvent.CHAT, { ...user('regular_jane'), comment: 'hi there' });
    conn.emit(WebcastEvent.MEMBER, user('user9988776655', { nickname: 'user9988776655', followInfo: { followerCount: '0', followingCount: '0', followStatus: '0' }, createTime: String(Math.floor((Date.now() - 2 * DAY) / 1000)), bio: '' }));
    conn.emit(WebcastEvent.GIFT, { ...user('regular_jane'), gift: { name: 'Rose', diamondCount: 1, type: 0 }, repeatCount: 3, repeatEnd: 1 });
    conn.emit(WebcastEvent.MEMBER, user('vip'));

    assert.equal(m.room.viewers, 43);
    const jane = m.detail('regular_jane');
    assert.equal(jane.today.chats, 1);
    assert.equal(jane.today.coins, 3);
    assert.equal(jane.today.followers, 900);
    assert.equal(jane.today.score, 1); // first day in this room only
    assert.equal(flags.length, 1);
    assert.equal(flags[0].user, 'user9988776655');
    assert.ok(flags[0].score >= cfg.burnerAlertScore);
    assert.ok(flags[0].reasons.includes('no followers'));
    assert.ok(logs.some(l => l.kind === 'flag' && l.user === 'user9988776655'));
    assert.ok(logs.some(l => l.kind === 'join' && l.user === 'vip' && l.watched && l.alert));
    assert.equal(m.recentChat.length, 1);
    assert.equal(m.suspects(1)[0].username, 'user9988776655');
    assert.equal(m.snapshot().counts.present, 3);

    conn.emit(WebcastEvent.STREAM_END, {});
    assert.equal(m.snapshot().counts.present, 0);
    assert.ok(existsSync(m.snapshotFile));
    assert.ok(existsSync(m.history.file));
    const hist = JSON.parse(readFileSync(m.history.file, 'utf8'));
    assert.equal(Object.keys(hist.users).length, 3);
    assert.equal(hist.users['id-regular_jane'].profile.followers, 900);

    m.stop();
    assert.equal(m.state, 'stopped');
    assert.equal(conn.connected, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('monitor cross-references a blacklisted room and reconnects after a drop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bouncer-'));
  try {
    const cfg = cfgFor(dir);
    // 1. sit in the blacklisted streamer's room and record a follower
    const badConn = new FakeConnection();
    const bad = new Monitor('badguy', cfg, { createConnection: () => badConn });
    bad.start(); await tick();
    badConn.emit(WebcastEvent.MEMBER, user('sneaky', { id: 'S1', followInfo: { followerCount: '50', followingCount: '50', followStatus: '1' } }));
    bad.stop();

    // 2. same account (renamed) shows up in the host's room
    const conn = new FakeConnection();
    const m = new Monitor('host', cfg, { createConnection: () => conn });
    const flags = [];
    m.on('flag', f => flags.push(f));
    m.start(); await tick();
    conn.emit(WebcastEvent.MEMBER, user('sneaky_v2', { id: 'S1', followInfo: { followerCount: '50', followingCount: '50', followStatus: '0' } }));
    assert.equal(flags.length, 1);
    assert.deepEqual(flags[0].blacklisted, ['badguy']);
    assert.ok(flags[0].reasons.some(r => r.includes('follows blacklisted @badguy')));
    const d = m.detail('sneaky_v2');
    assert.equal(d.rooms[0].room, 'badguy');
    assert.equal(d.rooms[0].follows, true);
    assert.equal(d.rooms[0].username, 'sneaky');
    assert.ok(d.today.flags.includes('BL:@badguy'));

    // 3. connection drops: monitor schedules a reconnect instead of dying
    conn.emit(ControlEvent.DISCONNECTED, { code: 1006 });
    assert.equal(m.state, 'reconnecting');
    m.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
