import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { Monitor, DEFAULTS, normalizeConfig, configToJSON, roomLists, who } from './monitor.js';

class FakeConnection extends EventEmitter {
  constructor(backlog = []) { super(); this.connected = false; this.backlog = backlog; }
  async connect() {
    for (const [ev, d] of this.backlog) this.emit(ev, d); // the real library replays the initial batch here
    this.connected = true;
    return { roomId: 'r1', roomInfo: { data: { title: 'test stream', user_count: 42 } } };
  }
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

test('a viewer in two monitored rooms at once is flagged both ways', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
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
    assert.equal(u.present, true);
    assert.ok(Math.abs(u.firstSeen - (now - 5 * 60_000)) < 1000, 'arrival time comes from TikTok');
    assert.ok(Math.abs(u.lastSeen - (now - 4 * 60_000)) < 1000);
    assert.equal(u.chats, 1);
    const joinLine = m.logLines.find(l => l.kind === 'join' && l.user === 'early_bird');
    assert.ok(joinLine.backlog);
    assert.ok(joinLine.text.includes('before Rat Trap connected'));
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
    m.save(); // dismissal survives a restart the same day
    const m2 = new Monitor('host', cfg, { createConnection: () => new FakeConnection() });
    m2.start(); await tick();
    assert.ok(m2.tracker.get('quiet_one').dismissedAt > 0);
    assert.deepEqual(configToJSON(cfg).lists.host.pinned, ['harmless']);
    m.stop(); m2.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('chat and event log can be appended to per-room text files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const cfg = normalizeConfig({ ...DEFAULTS, dataDir: dir, autosaveMinutes: 0, chatToFile: true, eventsToFile: true }, null);
    const conn = new FakeConnection();
    const m = new Monitor('host', cfg, { createConnection: () => conn });
    m.start(); await tick();
    conn.emit(WebcastEvent.MEMBER, user('talker', { nickname: 'Talky' }));
    conn.emit(WebcastEvent.CHAT, { ...user('talker', { nickname: 'Talky' }), comment: 'hello "world"' });
    conn.emit(WebcastEvent.GIFT, { ...user('talker', { nickname: 'Talky' }), gift: { name: 'Rose', diamondCount: 1, type: 0 }, repeatCount: 2, repeatEnd: 1 });
    const chat = readFileSync(m.chatFile, 'utf8').trim().split('\n');
    const log = readFileSync(m.eventsFile, 'utf8').trim().split('\n');
    assert.equal(chat.length, 1);
    assert.match(chat[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d  talker \(Talky\): hello "world"$/);
    assert.ok(log.some(l => /  join     talker \(Talky\)  joined$/.test(l)), log.join('|'));
    assert.ok(log.some(l => /  gift     talker \(Talky\)  Rose x2 \(2 coins\)$/.test(l)));
    assert.ok(!log.some(l => l.includes('hello')), 'chat stays out of the event file');

    cfg.chatToFile = false; // toggled off live: nothing more is written
    conn.emit(WebcastEvent.CHAT, { ...user('talker'), comment: 'again' });
    assert.equal(readFileSync(m.chatFile, 'utf8').trim().split('\n').length, 1);
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
    seed.history.update(t.all(), '2025-01-01', now); seed.history.save();
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

test('today\'s list is capped at maxUsers, trimming the oldest that left', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rattrap-'));
  try {
    const cfg = normalizeConfig({ ...DEFAULTS, dataDir: dir, autosaveMinutes: 0, idleTimeoutMinutes: 1, maxUsers: 6, lists: { host: { watch: ['keeper'] } } }, null);
    const conn = new FakeConnection();
    const m = new Monitor('host', cfg, { createConnection: () => conn });
    m.start(); await tick();
    const t0 = Date.now() - 10 * 60_000;
    // eight accounts that all joined ten minutes ago, in order; then the sweep marks them gone
    for (let i = 0; i < 8; i++) conn.emit(WebcastEvent.MEMBER, { ...user(i === 2 ? 'keeper' : `old${i}`), common: { createTime: String(t0 + i * 1000) } });
    assert.equal(m.tracker.users.size, 8); // nobody has left yet, so nothing can be trimmed
    m.tracker.sweep(Date.now());
    conn.emit(WebcastEvent.MEMBER, user('newcomer'));
    const names = [...m.tracker.users.keys()];
    assert.ok(names.length <= 6, `expected at most 6, got ${names.length}`);
    assert.ok(names.includes('newcomer'), 'the present newcomer stays');
    assert.ok(names.includes('keeper'), 'watched accounts are never trimmed');
    assert.ok(!names.includes('old0') && !names.includes('old1'), 'the oldest gone accounts go first');
    assert.ok(m.history.get('old0'), 'trimmed accounts were written to history');
    assert.ok(m.logLines.some(l => l.text.includes('trimmed')));
    m.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
