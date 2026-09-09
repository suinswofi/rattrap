import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { Monitor, DEFAULTS, normalizeConfig, configToJSON, roomLists, who } from './monitor.js';

class FakeConnection extends EventEmitter {
  constructor() { super(); this.connected = false; }
  async connect() { this.connected = true; return { roomId: 'r1', roomInfo: { data: { title: 'test stream', user_count: 42 } } }; }
  disconnect() { this.connected = false; }
  async waitUntilLive() { return true; }
}

const DAY = 864e5;
const user = (displayId, extra = {}) => ({ user: { displayId, id: extra.id ?? `id-${displayId}`, nickname: extra.nickname ?? `Nick ${displayId}`, followInfo: extra.followInfo, secret: extra.secret, userAttr: extra.userAttr } });
const cfgFor = dir => normalizeConfig({ ...DEFAULTS, dataDir: dir, autosaveMinutes: 0, lists: { host: { blacklist: ['badguy'], watch: ['vip'] } } }, null);
const tick = () => new Promise(r => setTimeout(r, 5));

test('who() maps the v2 user shape', () => {
  const w = who(user('alice', { followInfo: { followerCount: '12', followingCount: '3', followStatus: '1' }, secret: 0 }));
  assert.equal(w.username, 'alice');
  assert.equal(w.info.followers, 12);
  assert.equal(w.info.following, 3);
  assert.equal(w.info.isFollower, true);
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

    conn.emit(WebcastEvent.MEMBER, { ...user('regular_jane', { nickname: 'Jane', followInfo: { followerCount: '900', followingCount: '100', followStatus: '1' } }), memberCount: 43 });
    conn.emit(WebcastEvent.CHAT, { ...user('regular_jane'), comment: 'hi there' });
    conn.emit(WebcastEvent.MEMBER, user('user9988776655', { nickname: 'user9988776655', followInfo: { followerCount: '0', followingCount: '0', followStatus: '0' }, secret: 1 }));
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

test('watch list and blacklist are per room; legacy global lists migrate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bouncer-'));
  try {
    const cfg = cfgFor(dir);
    const badConn = new FakeConnection();
    const bad = new Monitor('badguy', cfg, { createConnection: () => badConn });
    bad.start(); await tick();
    badConn.emit(WebcastEvent.MEMBER, user('fan', { id: 'F1', followInfo: { followerCount: '500', followingCount: '300', followStatus: '1' } }));
    bad.stop();

    // a different room with no blacklist of its own: the same fan is not flagged there
    const otherConn = new FakeConnection();
    const other = new Monitor('other', cfg, { createConnection: () => otherConn });
    const otherFlags = [];
    other.on('flag', f => otherFlags.push(f));
    other.start(); await tick();
    otherConn.emit(WebcastEvent.MEMBER, user('fan', { id: 'F1', followInfo: { followerCount: '500', followingCount: '300', followStatus: '0' } }));
    otherConn.emit(WebcastEvent.MEMBER, user('vip'));
    assert.equal(otherFlags.length, 0);
    assert.equal(other.detail('fan').rooms[0].blacklisted, false);
    assert.equal(other.watched('vip'), false);
    other.stop();

    // the host room blacklists badguy and watches vip
    const hostConn = new FakeConnection();
    const host = new Monitor('host', cfg, { createConnection: () => hostConn });
    const hostFlags = [];
    host.on('flag', f => hostFlags.push(f));
    host.start(); await tick();
    hostConn.emit(WebcastEvent.MEMBER, user('fan', { id: 'F1', followInfo: { followerCount: '500', followingCount: '300', followStatus: '0' } }));
    assert.equal(hostFlags.length, 1);
    assert.deepEqual(hostFlags[0].blacklisted, ['badguy']);
    assert.equal(host.watched('vip'), true);
    host.stop();

    // legacy config: a single global watch/blacklist seeds every room's lists
    const legacy = normalizeConfig({ ...DEFAULTS, dataDir: dir, watch: ['Old_VIP'], blacklist: ['@OldRival'] }, null);
    assert.equal(legacy.watch, undefined);
    assert.deepEqual([...roomLists(legacy, 'anyroom').blacklist], ['oldrival']);
    assert.deepEqual([...roomLists(legacy, 'Another').watch], ['old_vip']);
    const json = configToJSON(legacy);
    assert.deepEqual(json.lists.anyroom, { watch: ['old_vip'], blacklist: ['oldrival'] });
    assert.equal(json.legacyLists, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a viewer in two monitored rooms at once is flagged both ways', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bouncer-'));
  try {
    const cfg = cfgFor(dir);
    const all = new Map();
    const mk = name => { const c = new FakeConnection(); const m = new Monitor(name, cfg, { createConnection: () => c, peers: () => all.values() }); all.set(name, m); m.on('join', ({ user }) => { for (const o of all.values()) if (o !== m) o.peerJoined(name, user); }); return [m, c]; };
    const [host, hostConn] = mk('host');
    const [bad, badConn] = mk('badguy');
    const flags = [];
    host.on('flag', f => flags.push(f));
    host.start(); bad.start(); await tick();

    // 1. already in badguy's room, then joins host: flagged on join, with the live reason
    badConn.emit(WebcastEvent.MEMBER, user('dual', { id: 'D1', nickname: 'Dual', followInfo: { followerCount: '800', followingCount: '20', followStatus: '0' } }));
    hostConn.emit(WebcastEvent.MEMBER, user('dual', { id: 'D1', nickname: 'Dual', followInfo: { followerCount: '800', followingCount: '20', followStatus: '0' } }));
    assert.equal(flags.length, 1);
    assert.ok(flags[0].reasons.includes("in blacklisted @badguy's room right now"));
    assert.ok(host.row(host.tracker.get('dual')).flags.includes('NOW:@badguy'));
    const d = host.detail('dual');
    assert.equal(d.rooms[0].room, 'badguy');
    assert.equal(d.rooms[0].presentNow, true);

    // 2. in host first, then walks into badguy's room: host is told
    hostConn.emit(WebcastEvent.MEMBER, user('later', { id: 'L1', nickname: 'Later', followInfo: { followerCount: '800', followingCount: '20', followStatus: '1' } }));
    assert.equal(flags.length, 1);
    badConn.emit(WebcastEvent.MEMBER, user('later', { id: 'L1', nickname: 'Later' }));
    assert.equal(flags.length, 2);
    assert.equal(flags[1].user, 'later');
    assert.ok(host.logLines.some(l => l.kind === 'flag' && l.user === 'later' && l.text.includes('just entered blacklisted @badguy')));
    badConn.emit(WebcastEvent.MEMBER, user('later', { id: 'L1', nickname: 'Later' })); // re-join: no duplicate alert
    assert.equal(flags.length, 2);

    // 3. the blacklisted room itself does not flag host's viewers (its own blacklist is empty)
    assert.equal(bad.flagged.size, 0);
    host.stop(); bad.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
