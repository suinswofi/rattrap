import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { Monitor, DEFAULTS, normalizeConfig, configToJSON, roomLists, who } from './monitor.js';
import { makeSid, streamLabel } from './history.js';

class FakeConnection extends EventEmitter {
  constructor(backlog = [], roomId = 'r1') { super(); this.connected = false; this.backlog = backlog; this.roomId = roomId; }
  async connect() {
    for (const [ev, d] of this.backlog) this.emit(ev, d); // the real library replays the initial batch here
    this.connected = true;
    return { roomId: this.roomId, roomInfo: { data: { title: 'test stream', user_count: 42 } } };
  }
  disconnect() { this.connected = false; }
  async waitUntilLive() { return true; }
}

const DAY = 864e5;
const user = (displayId, extra = {}) => ({ user: { displayId, id: extra.id ?? `id-${displayId}`, nickname: extra.nickname ?? `Nick ${displayId}`, followInfo: extra.followInfo, secret: extra.secret, userAttr: extra.userAttr } });
const cfgFor = (dir, extra = {}) => normalizeConfig({ ...DEFAULTS, dataDir: dir, autosaveMinutes: 0, lists: { host: { blacklist: ['badguy'], watch: ['vip'] } }, ...extra }, null);
const tick = () => new Promise(r => setTimeout(r, 5));

test('who() maps the v2 user shape', () => {
  const w = who(user('alice', { followInfo: { followerCount: '12', followingCount: '3', followStatus: '1' }, secret: 0 }));
  assert.equal(w.username, 'alice');
  assert.equal(w.info.followers, 12);
  assert.equal(w.info.following, 3);
  assert.equal(w.info.isFollower, true);
  assert.equal(w.info.privateAccount, undefined, 'secret 0 is indistinguishable from "not sent", so it stays unknown');
  assert.equal(w.info.verified, undefined);
  assert.equal(who(user('bob', { secret: 1 })).info.privateAccount, true);
  assert.equal(who({ user: { displayId: 'carol', verified: true } }).info.verified, true);
  assert.equal(who({}), null);
});

test('config drops the idle-timeout and text-log keys of older versions', () => {
  const cfg = normalizeConfig({ ...DEFAULTS, idleTimeoutMinutes: 15, chatToFile: true, eventsToFile: true, logEvents: true, logKeepDays: '7' }, null);
  for (const k of ['idleTimeoutMinutes', 'chatToFile', 'eventsToFile', 'logEvents']) assert.equal(cfg[k], undefined, k);
  assert.equal(cfg.logKeepDays, 7);
  assert.equal(normalizeConfig({ ...DEFAULTS }, null).logKeepDays, 0);
});

test('monitor tracks events, flags burners, and saves per-stream history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
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
    assert.ok(m.stream, 'a stream exists once connected');
    assert.equal(m.stream.roomId, 'r1');
    assert.equal(m.stream.sid, makeSid(m.stream.monitoredAt));
    assert.match(streamLabel(m.stream.sid), /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    assert.ok(logs.some(l => l.kind === 'system' && l.text.startsWith('new stream, monitored since')));

    conn.emit(WebcastEvent.MEMBER, { ...user('regular_jane', { nickname: 'Jane', followInfo: { followerCount: '900', followingCount: '100', followStatus: '1' } }), memberCount: 43 });
    conn.emit(WebcastEvent.CHAT, { ...user('regular_jane'), comment: 'hi there' });
    conn.emit(WebcastEvent.MEMBER, user('user9988776655', { nickname: 'user9988776655', followInfo: { followerCount: '0', followingCount: '0', followStatus: '0' }, secret: 1 }));
    conn.emit(WebcastEvent.GIFT, { ...user('regular_jane'), gift: { name: 'Rose', diamondCount: 1, type: 0 }, repeatCount: 3, repeatEnd: 1 });
    conn.emit(WebcastEvent.MEMBER, user('vip'));
    conn.emit(WebcastEvent.MEMBER, user('vip'));
    conn.emit(WebcastEvent.MEMBER, user('vip'));

    assert.equal(m.room.viewers, 43);
    const jane = m.detail('regular_jane');
    assert.equal(jane.stream.chats, 1);
    assert.equal(jane.stream.coins, 3);
    assert.equal(jane.stream.followers, 900);
    assert.equal(jane.stream.score, 1); // first time in this room only
    assert.equal(jane.stream.streamsSeen, 1);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].user, 'user9988776655');
    assert.ok(flags[0].score >= cfg.burnerAlertScore);
    assert.ok(flags[0].reasons.includes('no followers'));
    assert.ok(logs.some(l => l.kind === 'flag' && l.user === 'user9988776655'));
    assert.ok(logs.some(l => l.kind === 'join' && l.user === 'vip' && l.watched && l.alert));
    const third = logs.find(l => l.kind === 'rejoin' && l.user === 'vip' && l.text.includes('3rd time'));
    assert.ok(third, 'repeated joins are counted, never "leaves"');
    assert.ok(!logs.some(l => l.kind === 'leave'));
    assert.ok(m.detail('vip').stream.reasons.includes('joined 3 times this stream'));
    assert.ok(logs.filter(l => l.user).every(l => l.sid === m.stream.sid), 'every event line carries the stream id');
    assert.equal(m.suspects(1)[0].username, 'user9988776655');
    assert.equal(m.snapshot().counts.seen, 3);
    assert.equal(m.snapshot().stream.sid, m.stream.sid);

    conn.emit(WebcastEvent.STREAM_END, {});
    assert.ok(states.includes('waiting'));
    assert.ok(m.stream.endedAt > 0);
    assert.equal(m.snapshot().counts.seen, 3, 'the stream\'s users stay visible after it ends');
    assert.ok(existsSync(m.snapshotFile));
    assert.ok(existsSync(m.history.file));
    const hist = JSON.parse(readFileSync(m.history.file, 'utf8'));
    assert.equal(Object.keys(hist.users).length, 3);
    assert.equal(hist.users['id-regular_jane'].profile.followers, 900);
    assert.deepEqual(Object.keys(hist.users['id-regular_jane'].streams), [m.stream.sid]);
    assert.equal(hist.users['id-regular_jane'].streams[m.stream.sid].chats, 1);
    assert.equal(hist.streams[m.stream.sid].seen, 3);
    assert.equal(hist.streams[m.stream.sid].coins, 3);
    assert.ok(hist.streams[m.stream.sid].endedAt > 0);

    m.stop();
    assert.equal(m.state, 'stopped');
    assert.equal(conn.connected, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a new room id starts a new stream; the same room id continues the old one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const cfg = cfgFor(dir);
    const conn = new FakeConnection([], 'r1');
    const m = new Monitor('host', cfg, { createConnection: () => conn });
    m.start(); await tick();
    const first = m.stream.sid;
    conn.emit(WebcastEvent.MEMBER, user('alice'));
    conn.emit(WebcastEvent.CHAT, { ...user('alice'), comment: 'first stream' });
    m.save();
    m.stop();

    // restart while the same stream is still live: same stream, users and log come back
    const conn2 = new FakeConnection([], 'r1');
    const m2 = new Monitor('host', cfg, { createConnection: () => conn2 });
    m2.start(); await tick();
    assert.equal(m2.stream.sid, first);
    assert.equal(m2.stream.endedAt, null);
    assert.equal(m2.tracker.get('alice').chats, 1);
    assert.ok(m2.logLines.some(l => l.kind === 'chat' && l.text === 'first stream'), 'the log is reloaded from its file');
    assert.ok(m2.logLines.some(l => l.text.startsWith('continuing the stream')));
    conn2.emit(WebcastEvent.MEMBER, user('bob'));
    conn2.emit(WebcastEvent.STREAM_END, {});
    assert.equal(m2.tracker.users.size, 2);

    // the next stream: a different room id
    conn2.roomId = 'r2';
    m2.reconnect(); await new Promise(r => setTimeout(r, 1100));
    assert.equal(m2.state, 'live');
    assert.notEqual(m2.stream.sid, first);
    assert.equal(m2.stream.roomId, 'r2');
    assert.equal(m2.tracker.users.size, 0, 'the users list starts fresh');
    assert.ok(!m2.logLines.some(l => l.text === 'first stream'), 'the in-memory log starts fresh');
    conn2.emit(WebcastEvent.MEMBER, user('alice'));
    assert.equal(m2.detail('alice').stream.streamsSeen, 2);
    assert.ok(!m2.detail('alice').stream.reasons.includes('first time in this room'));
    assert.ok(m2.detail('bob').stream === null && m2.detail('bob').history.streamsSeen === 1, 'bob is only in history');
    m2.save();
    const streams = m2.snapshot().streams;
    assert.equal(streams.length, 2);
    assert.equal(streams[0].sid, m2.stream.sid, 'newest first');
    assert.equal(streams[1].endedAt > 0, true);
    assert.equal(m2.readLog(first).filter(l => l.kind === 'chat').length, 1, 'an earlier stream\'s log is read from its file');
    assert.equal(m2.readLog(m2.stream.sid).some(l => l.kind === 'join' && l.user === 'alice'), true);
    m2.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('monitor cross-references a blacklisted room and reconnects after a drop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
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
    assert.ok(flags[0].blacklistScore > 0 && flags[0].blacklistScore < flags[0].score);
    const d = m.detail('sneaky_v2');
    assert.equal(d.rooms[0].room, 'badguy');
    assert.equal(d.rooms[0].follows, true);
    assert.equal(d.rooms[0].username, 'sneaky');
    assert.ok(d.stream.flags.includes('BL:@badguy'));

    // 3. connection drops: monitor schedules a reconnect instead of dying
    conn.emit(ControlEvent.DISCONNECTED, { code: 1006 });
    assert.equal(m.state, 'reconnecting');
    m.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('watch list and blacklist are per room; legacy global lists migrate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
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
    assert.deepEqual(json.lists.anyroom, { watch: ['old_vip'], blacklist: ['oldrival'], pinned: [] });
    assert.equal(json.legacyLists, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hopping between a blacklisted stream and this one is announced both ways, every time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const cfg = cfgFor(dir);
    const all = new Map();
    const mk = name => { const c = new FakeConnection([], `room-${name}`); const m = new Monitor(name, cfg, { createConnection: () => c, peers: () => all.values() }); all.set(name, m); m.on('join', ({ user, t }) => { for (const o of all.values()) if (o !== m) o.peerJoined(name, user, t); }); return [m, c]; };
    const [host, hostConn] = mk('host');
    const [bad, badConn] = mk('badguy');
    const hops = [], flags = [];
    host.on('hop', h => hops.push(h));
    host.on('flag', f => flags.push(f));
    host.start(); bad.start(); await tick();
    const now = Date.now();
    const at = (d, t) => ({ ...d, common: { createTime: String(t) } });

    // 1. seen in badguy's stream, then joins host three minutes later: "came from"
    badConn.emit(WebcastEvent.MEMBER, at(user('dual', { id: 'D1', nickname: 'Dual', followInfo: { followerCount: '800', followingCount: '20', followStatus: '0' } }), now - 3 * 60_000));
    hostConn.emit(WebcastEvent.MEMBER, at(user('dual', { id: 'D1', nickname: 'Dual', followInfo: { followerCount: '800', followingCount: '20', followStatus: '0' } }), now));
    assert.equal(hops.length, 1);
    assert.equal(hops[0].hop.dir, 'from');
    assert.equal(hops[0].hop.room, 'badguy');
    assert.ok(Math.abs(hops[0].hop.gapMs - 3 * 60_000) < 1000, `gap ${hops[0].hop.gapMs}`);
    assert.match(hops[0].text, /came from blacklisted @badguy's stream \(seen there 3m earlier\)/);
    assert.ok(hops[0].reasons.some(r => r.startsWith('came from blacklisted @badguy')));
    assert.equal(flags.length, 0, 'the hop is the alert; no second score alert for the same join');
    assert.ok(host.flagged.has('dual'));
    const row = host.row(host.tracker.get('dual'));
    assert.ok(row.flags.includes('HOP:@badguy'));
    assert.equal(row.hops, 1);
    assert.equal(row.lastHop.dir, 'from');
    assert.ok(host.logLines.some(l => l.kind === 'hop' && l.user === 'dual' && l.alert));
    assert.equal(host.detail('dual').rooms[0].liveNow, true);

    // 2. in host first, then walks into badguy's stream: "went to"
    hostConn.emit(WebcastEvent.MEMBER, at(user('later', { id: 'L1', nickname: 'Later' }), now - 10 * 60_000));
    assert.equal(hops.length, 1);
    badConn.emit(WebcastEvent.MEMBER, at(user('later', { id: 'L1', nickname: 'Later' }), now));
    assert.equal(hops.length, 2);
    assert.equal(hops[1].user, 'later');
    assert.equal(hops[1].hop.dir, 'to');
    assert.match(hops[1].text, /went to blacklisted @badguy's stream \(10m after last seen here\)/);
    badConn.emit(WebcastEvent.MEMBER, at(user('later', { id: 'L1', nickname: 'Later' }), now + 10_000)); // same move seconds later: not repeated
    assert.equal(hops.length, 2);
    // ...but a real move back and forth is announced again
    hostConn.emit(WebcastEvent.MEMBER, at(user('later', { id: 'L1', nickname: 'Later' }), now + 5 * 60_000));
    assert.equal(hops.length, 3);
    assert.equal(hops[2].hop.dir, 'from');
    assert.equal(host.row(host.tracker.get('later')).hops, 2);

    // 3. the blacklisted room itself does not flag host's viewers (its own blacklist is empty)
    assert.equal(bad.flagged.size, 0);

    // 4. once badguy's stream ends, being in its old list no longer counts as "in their stream"
    badConn.emit(WebcastEvent.STREAM_END, {});
    hostConn.emit(WebcastEvent.MEMBER, at(user('afterwards', { id: 'A1' }), now + 6 * 60_000));
    assert.equal(hops.length, 3);
    assert.deepEqual(host.liveIn('dual'), []);
    host.save();
    assert.equal(JSON.parse(readFileSync(host.history.file, 'utf8')).users.D1.streams[host.stream.sid].hops, 1, 'hops are part of the per-stream stats');
    host.stop(); bad.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the pre-connection backlog is replayed with TikTok timestamps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const now = Date.now();
    const early = { ...user('early_bird', { nickname: 'Early' }), common: { createTime: String(now - 5 * 60_000) } };
    const chat = { ...user('early_bird', { nickname: 'Early' }), comment: 'hello', common: { createTime: String(now - 4 * 60_000) } };
    const bogus = { ...user('bogus_time', { nickname: 'Bogus' }), common: { createTime: '12345' } }; // far in the past: ignored
    const conn = new FakeConnection([[WebcastEvent.MEMBER, early], [WebcastEvent.CHAT, chat], [WebcastEvent.MEMBER, bogus]]);
    const m = new Monitor('host', cfgFor(dir), { createConnection: () => conn });
    m.start(); await tick();
    assert.equal(m.backlog, false);
    const u = m.tracker.get('early_bird');
    assert.ok(u, 'backlog events are applied once the stream is known');
    assert.ok(Math.abs(u.firstSeen - (now - 5 * 60_000)) < 1000, 'arrival time comes from TikTok');
    assert.ok(Math.abs(u.lastSeen - (now - 4 * 60_000)) < 1000);
    assert.equal(u.chats, 1);
    const joinLine = m.logLines.find(l => l.kind === 'join' && l.user === 'early_bird');
    assert.ok(joinLine.backlog);
    assert.ok(joinLine.text.includes('before Rat Trap connected'));
    assert.equal(joinLine.sid, m.stream.sid, 'backlog lines belong to the stream');
    assert.ok(Math.abs(joinLine.t - (now - 5 * 60_000)) < 1000);
    assert.ok(Math.abs(m.tracker.get('bogus_time').firstSeen - now) < 1000, 'absurd timestamps fall back to now');
    // a live event after connect is not marked as backlog
    conn.emit(WebcastEvent.MEMBER, user('live_one', { nickname: 'Live' }));
    const live = m.logLines.find(l => l.kind === 'join' && l.user === 'live_one');
    assert.equal(live.backlog, false);
    assert.ok(!live.text.includes('before'));
    m.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pinning and dismissing shape the suspects list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const cfg = cfgFor(dir);
    const conn = new FakeConnection();
    const m = new Monitor('host', cfg, { createConnection: () => conn });
    m.start(); await tick();
    conn.emit(WebcastEvent.MEMBER, user('user1111111111', { nickname: 'user1111111111', followInfo: { followerCount: '0', followingCount: '0', followStatus: '0' } }));
    conn.emit(WebcastEvent.MEMBER, user('quiet_one'));
    conn.emit(WebcastEvent.MEMBER, user('harmless', { followInfo: { followerCount: '900', followingCount: '10', followStatus: '1' } }));
    assert.deepEqual(m.suspects().map(u => u.username), ['user1111111111', 'quiet_one', 'harmless']);

    m.lists.pinned.add('harmless');
    assert.equal(m.suspects()[0].username, 'harmless'); // pinned sorts first regardless of score
    assert.equal(m.dismiss(['harmless', 'quiet_one', 'nobody']), 1); // pinned and unknown are skipped
    assert.deepEqual(m.suspects().map(u => u.username), ['harmless', 'user1111111111']);
    assert.equal(m.suspects(20, true).length, 3);
    assert.ok(m.row(m.tracker.get('quiet_one')).dismissedAt > 0);

    conn.emit(WebcastEvent.MEMBER, user('quiet_one')); // joins again: back on the list
    assert.equal(m.tracker.get('quiet_one').dismissedAt, null);
    assert.equal(m.suspects().length, 3);

    assert.equal(m.dismiss(['quiet_one']), 1);
    assert.equal(m.undismiss(['quiet_one']), 1);
    assert.equal(m.suspects().length, 3);

    m.dismiss(['quiet_one']);
    m.save(); // dismissal survives a restart during the same stream
    const m2 = new Monitor('host', cfg, { createConnection: () => new FakeConnection() });
    m2.start(); await tick();
    assert.ok(m2.tracker.get('quiet_one').dismissedAt > 0);
    assert.deepEqual(configToJSON(cfg).lists.host.pinned, ['harmless']);
    m.stop(); m2.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pinned and watched accounts keep every logged event, across streams and restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const cfg = cfgFor(dir);
    const conn = new FakeConnection([], 'r1');
    let m = new Monitor('host', cfg, { createConnection: () => conn });
    m.start(); await tick();
    const sid1 = m.stream.sid;
    conn.emit(WebcastEvent.MEMBER, user('suspect', { id: 'S1' }));
    conn.emit(WebcastEvent.CHAT, { ...user('suspect', { id: 'S1' }), comment: 'old message' });
    conn.emit(WebcastEvent.CHAT, { ...user('bystander'), comment: 'unrelated' });
    conn.emit(WebcastEvent.LIKE, { ...user('suspect', { id: 'S1' }), count: 3 });
    assert.equal(m.detail('suspect').events.length, 0, 'nothing is retained before pinning');
    assert.equal(m.detail('suspect').retained, false);
    m.save();
    conn.emit(WebcastEvent.STREAM_END, {});
    conn.roomId = 'r2';
    m.reconnect(); await new Promise(r => setTimeout(r, 1100));
    const sid2 = m.stream.sid;
    conn.emit(WebcastEvent.MEMBER, user('suspect', { id: 'S1' }));
    conn.emit(WebcastEvent.CHAT, { ...user('suspect', { id: 'S1' }), comment: 'new message' });

    // pin now: the past is gathered from the log files of every stream the account was seen in
    m.lists.pinned.add('suspect');
    assert.equal(m.retainEvents(['@Suspect']), 1);
    let d = m.detail('suspect');
    assert.equal(d.retained, true);
    assert.deepEqual(d.events.map(e => [e.sid, e.kind, e.text]), [[sid1, 'join', 'joined'], [sid1, 'chat', 'old message'], [sid2, 'join', 'joined'], [sid2, 'chat', 'new message']]);
    assert.ok(!d.events.some(e => e.text === 'unrelated'));

    // from now on events are kept as they happen
    conn.emit(WebcastEvent.GIFT, { ...user('suspect', { id: 'S1' }), gift: { name: 'Rose', diamondCount: 1, type: 0 }, repeatCount: 1, repeatEnd: 1 });
    conn.emit(WebcastEvent.CHAT, { ...user('bystander'), comment: 'still unrelated' });
    d = m.detail('suspect');
    assert.equal(d.events.length, 5);
    assert.equal(d.events[4].kind, 'gift');
    m.stop();

    // even with the log files gone, the retained events survive a restart
    for (const f of readdirSync(dir)) if (f.startsWith('log-')) rmSync(join(dir, f));
    const conn3 = new FakeConnection([], 'r3');
    m = new Monitor('host', cfg, { createConnection: () => conn3 });
    m.start(); await tick();
    d = m.detail('suspect');
    assert.equal(d.seenThisStream, false);
    assert.equal(d.events.length, 5);
    assert.equal(d.history.streamsSeen, 2);
    assert.equal(d.history.streams[0].sid, sid1);
    m.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('old per-stream log and snapshot files are deleted when logKeepDays is set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const old = makeSid(Date.now() - 40 * DAY), recent = makeSid(Date.now() - 2 * DAY);
    for (const sid of [old, recent]) { writeFileSync(join(dir, `log-host-${sid}.jsonl`), '{"t":1,"kind":"system","text":"x"}\n'); writeFileSync(join(dir, `viewers-host-${sid}.json`), '{"users":[]}'); }
    writeFileSync(join(dir, `log-other-${old}.jsonl`), ''); // another room: untouched
    const keep = new Monitor('host', cfgFor(dir), { createConnection: () => new FakeConnection() });
    keep.start(); await tick();
    assert.ok(readdirSync(dir).includes(`log-host-${old}.jsonl`) && readdirSync(dir).includes(`viewers-host-${old}.json`), 'default keeps everything');
    keep.stop();
    const m = new Monitor('host', cfgFor(dir, { logKeepDays: 30 }), { createConnection: () => new FakeConnection() });
    m.start(); await tick();
    const files = readdirSync(dir);
    assert.ok(!files.includes(`log-host-${old}.jsonl`) && !files.includes(`viewers-host-${old}.json`));
    assert.ok(files.includes(`log-host-${recent}.jsonl`) && files.includes(`viewers-host-${recent}.json`));
    assert.ok(files.includes(`log-other-${old}.jsonl`));
    assert.ok(m.logLines.some(l => l.text.includes('deleted 2 log/snapshot files')));
    m.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('old accounts are pruned from history when enabled, except pinned and watched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const now = Date.now();
    const seed = new Monitor('host', normalizeConfig({ ...DEFAULTS, dataDir: dir, autosaveMinutes: 0 }, null), { createConnection: () => new FakeConnection() });
    const t = seed.tracker;
    t.join('ancient', { userId: 'A' }, now - 400 * DAY); t.get('ancient').lastSeen = now - 400 * DAY;
    t.join('old_pinned', { userId: 'P' }, now - 300 * DAY); t.get('old_pinned').lastSeen = now - 300 * DAY;
    t.join('old_watched', { userId: 'W' }, now - 300 * DAY); t.get('old_watched').lastSeen = now - 300 * DAY;
    t.join('recent', { userId: 'R' }, now - 10 * DAY); t.get('recent').lastSeen = now - 10 * DAY;
    seed.history.update(t.all(), '2025-01-01'); seed.history.save();
    assert.equal(seed.history.users.size, 4);

    // default: nothing is forgotten
    const keepAll = new Monitor('host', normalizeConfig({ ...DEFAULTS, dataDir: dir, autosaveMinutes: 0 }, null), { createConnection: () => new FakeConnection() });
    keepAll.start(); await tick();
    assert.equal(keepAll.history.users.size, 4);
    keepAll.stop();

    // 180 days, with one old account pinned and one watched
    const cfg = normalizeConfig({ ...DEFAULTS, dataDir: dir, autosaveMinutes: 0, pruneAfterDays: 180, lists: { host: { pinned: ['old_pinned'], watch: ['old_watched'] } } }, null);
    const m = new Monitor('host', cfg, { createConnection: () => new FakeConnection() });
    m.start(); await tick();
    assert.deepEqual([...m.history.users.values()].map(r => r.username).sort(), ['old_pinned', 'old_watched', 'recent']);
    assert.equal(m.history.get('ancient'), null);
    assert.ok(m.logLines.some(l => l.text.includes('forgot 1 account not seen in 180 days')));
    m.save();
    const onDisk = JSON.parse(readFileSync(m.history.file, 'utf8'));
    assert.equal(Object.keys(onDisk.users).length, 3);
    m.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the stream\'s list is capped at maxUsers, trimming those seen longest ago', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const cfg = normalizeConfig({ ...DEFAULTS, dataDir: dir, autosaveMinutes: 0, maxUsers: 6, lists: { host: { watch: ['keeper'] } } }, null);
    const conn = new FakeConnection();
    const m = new Monitor('host', cfg, { createConnection: () => conn });
    m.start(); await tick();
    const t0 = Date.now() - 10 * 60_000;
    // eight accounts that all joined ten minutes ago, in order, then a newcomer
    for (let i = 0; i < 8; i++) conn.emit(WebcastEvent.MEMBER, { ...user(i === 2 ? 'keeper' : `old${i}`), common: { createTime: String(t0 + i * 1000) } });
    conn.emit(WebcastEvent.MEMBER, user('newcomer'));
    const names = [...m.tracker.users.keys()];
    assert.ok(names.length <= 6, `expected at most 6, got ${names.length}`);
    assert.ok(names.includes('newcomer'), 'the newcomer stays');
    assert.ok(names.includes('keeper'), 'watched accounts are never trimmed');
    assert.ok(!names.includes('old0') && !names.includes('old1'), 'the accounts seen longest ago go first');
    assert.ok(m.history.get('old0'), 'trimmed accounts were written to history');
    assert.ok(m.logLines.some(l => l.text.includes('trimmed')));
    m.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('uptime follows the stream, not the app', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const startedSec = Math.floor(Date.now() / 1000) - 2 * 3600; // TikTok reports create_time in unix seconds
    class Conn extends FakeConnection {
      async connect() { this.connected = true; return { roomId: 'r9', roomInfo: { data: { title: 't', create_time: startedSec } } }; }
    }
    const conn = new Conn();
    const cfg = { ...cfgFor(dir), reconnectWhenLive: false };
    const m = new Monitor('host', cfg, { createConnection: () => conn });
    assert.equal(m.snapshot().uptime, 0, 'nothing before connecting');
    m.start(); await tick();
    const up = m.snapshot().uptime;
    assert.ok(up >= 2 * 3600_000 && up < 2 * 3600_000 + 60_000, `uptime from create_time, got ${up}`);
    assert.ok(Math.abs(m.stream.startedAt - startedSec * 1000) < 1000, 'the stream record keeps TikTok\'s start time');
    conn.emit(WebcastEvent.STREAM_END, {});
    assert.equal(m.snapshot().uptime, 0, 'reset when the stream ends');
    m.stop();

    // no timestamp from TikTok: fall back to when we connected
    const plain = new FakeConnection();
    const m2 = new Monitor('host2', cfg, { createConnection: () => plain });
    m2.start(); await tick();
    assert.ok(m2.snapshot().uptime >= 0 && m2.snapshot().uptime < 5_000);
    assert.equal(m2.room.streamStartedAt, m2.stream.monitoredAt);
    m2.stop();
    assert.equal(m2.snapshot().uptime, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('streamStart() parses seconds and ms and rejects implausible values', async () => {
  const { streamStart } = await import('./monitor.js');
  const now = 1_700_000_000_000;
  assert.equal(streamStart({ create_time: 1_699_999_000 }, now), 1_699_999_000_000);
  assert.equal(streamStart({ start_time: 1_699_999_000_000 }, now), 1_699_999_000_000);
  assert.equal(streamStart({ create_time: now / 1000 + 60 }, now), null, 'future');
  assert.equal(streamStart({ create_time: 1_600_000_000 }, now), null, 'years ago = account age, not stream');
  assert.equal(streamStart({}, now), null);
});
