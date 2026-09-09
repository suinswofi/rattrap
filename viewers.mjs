// Bouncer — terminal client. The GUI is `npm start`; this is the same monitor at a text prompt.
//
// Usage:  node viewers.mjs [username] [options]
//   Defaults come from config.json (username defaults to the_great_sir_stromburg).
//
// Options (override config.json):
//   --config <file>        config file (default ./config.json)
//   --timeout <minutes>    idle minutes before a viewer is assumed gone
//   --watch a,b,c          usernames to highlight when they join / chat / gift
//   --blacklist a,b        streamers whose followers / viewers should be flagged (monitor their rooms too)
//   --alert <score>        burner score at which a join is announced (default 6)
//   --key <euler api key>  Euler Stream sign API key (or env EULER_API_KEY / SIGN_API_KEY)
//   --data <dir>           where JSON snapshots and history are written
//   --no-resume            do not load today's saved snapshot on start
//   --quiet                start with the live event log off
//   --chat                 also print every chat message in the event log
//   --prune <days>         forget accounts not seen for this many days (pinned/watched are kept)
//   --chat-file            append every chat message to data/chat-<room>-<date>.txt
//   --log-file             append the event log to data/log-<room>-<date>.txt
//
// Accuracy notes:
//  - TikTok sends no "user left" event. A leave is inferred when the user re-joins (they must have
//    left in between) or after the idle timeout with no activity. Leave time = last time seen.
//  - In busy rooms TikTok samples join/like events, so not every viewer will appear.
//  - Follower counts, account age etc. are whatever TikTok attaches to the viewer's own events.
//  - "follows @x" is only known for rooms this tool has monitored: run one instance per blacklisted streamer.

import readline from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { join as pathJoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Monitor, readConfigFile, normalizeConfig, normalizeUsername, nameSet, roomLists } from './monitor.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const takesValue = ['config', 'timeout', 'watch', 'blacklist', 'alert', 'key', 'data', 'prune'].includes(key);
    out[key] = takesValue ? argv[++i] : true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 22).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const configFile = args.config ?? pathJoin(HERE, 'config.json');
if (args.config && !existsSync(configFile)) { console.error(`config file not found: ${configFile}`); process.exit(1); }
let cfg;
try { cfg = readConfigFile(configFile); } catch (e) { console.error(`could not parse ${configFile}: ${e.message}`); process.exit(1); }
if (args._[0]) cfg.username = args._[0];
else if (process.env.TIKTOK_USER) cfg.username = process.env.TIKTOK_USER;
if (args.timeout) cfg.idleTimeoutMinutes = Number(args.timeout);
if (args.alert) cfg.burnerAlertScore = Number(args.alert);
if (args.prune) cfg.pruneAfterDays = Number(args.prune);
if (args.data) cfg.dataDir = args.data;
if (args['no-resume']) cfg.resume = false;
if (args.quiet) cfg.logEvents = false;
if (args.chat) cfg.logChat = true;
if (args['chat-file']) cfg.chatToFile = true;
if (args['log-file']) cfg.eventsToFile = true;
cfg.signApiKey = args.key || process.env.EULER_API_KEY || process.env.SIGN_API_KEY || cfg.signApiKey || '';
try { normalizeConfig(cfg, HERE); } catch (e) { console.error(e.message); process.exit(1); }
if (!cfg.username) { console.error('no username given (argument, config.json or TIKTOK_USER)'); process.exit(1); }
const lists = roomLists(cfg, cfg.username); // this room's watch list and blacklist
if (args.watch) lists.watch = nameSet(args.watch.split(','));
if (args.blacklist) lists.blacklist = nameSet(args.blacklist.split(','));

let logEvents = cfg.logEvents;
let logChat = cfg.logChat;

// ---------- formatting ----------
const pad2 = n => String(n).padStart(2, '0');
const fmt = ts => {
  if (ts === null || ts === undefined) return '-';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const timeOnly = ts => fmt(ts).slice(11);
const dateOnly = ts => fmt(ts).slice(0, 10);
const dur = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}h${pad2(Math.floor(s / 60) % 60)}m`; };
const shortDur = ms => { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : dur(ms); };
const trunc = (s, n) => { s = String(s ?? ''); return [...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s; };

function table(rows) {
  if (!rows.length) { console.log('(no users)'); return; }
  const out = rows.map(u => ({
    user: u.username, nick: trunc(u.nickname, 18), here: u.present ? 'yes' : 'no',
    joins: String(u.joins), chats: String(u.chats), likes: String(u.likes), coins: String(u.coins),
    first: timeOnly(u.firstSeen), last: timeOnly(u.lastSeen), inRoom: shortDur(u.timeInRoom),
    days: String(u.daysSeen), firstEver: dateOnly(u.firstSeenEver),
    'flw/ing': u.followers === null ? '-' : `${u.followers}/${u.following ?? '?'}`,
    score: String(u.score), flags: u.flags.join(','),
  }));
  const cols = Object.keys(out[0]);
  const width = s => [...s].length;
  const w = Object.fromEntries(cols.map(c => [c, Math.max(c.length, ...out.map(r => width(r[c])))]));
  const line = r => cols.map(c => r[c] + ' '.repeat(w[c] - width(r[c]))).join('  ');
  console.log(line(Object.fromEntries(cols.map(c => [c, c]))));
  console.log(cols.map(c => '-'.repeat(w[c])).join('  '));
  out.forEach(r => console.log(line(r)));
}

// ---------- monitor + output ----------
const monitor = new Monitor(cfg.username, cfg);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `@${monitor.username}> ` });
let promptShown = false;
const print = msg => {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  console.log(msg);
  if (promptShown) rl.prompt(true);
};
const counts = () => { const s = monitor.snapshot(); return `present ${s.counts.present}, seen ${s.counts.seen}${s.viewers !== null ? `, room ${s.viewers}` : ''}`; };
const tag = e => `${e.watched ? '★ ' : ''}${e.user}${e.nickname && e.nickname !== e.user ? ` (${trunc(e.nickname, 20)})` : ''}`;

monitor.on('log', e => {
  const stamp = `[${timeOnly(e.t)}]`;
  const label = e.kind === 'rejoin' ? 'RE-JOIN' : e.kind.padEnd(7);
  if (e.kind === 'flag') return print(`${stamp} *** FLAG    ${tag(e)}  ${e.text}`);
  if (e.kind === 'error') return print(`${stamp} ${e.text}`);
  if (e.kind === 'status' || e.kind === 'system') return print(`${stamp} ${e.text}`);
  if (e.kind === 'chat') {
    if (e.watched) return print(`${stamp} *** chat    ${tag(e)}: ${e.text}`);
    return logChat && logEvents ? print(`${stamp} chat    ${tag(e)}: ${e.text}`) : undefined;
  }
  const extra = ['join', 'rejoin', 'leave'].includes(e.kind) ? `  [${counts()}]` : '';
  const line = `${stamp} ${e.watched ? '*** ' : ''}${label} ${tag(e)}${e.kind === 'join' || e.kind === 'rejoin' ? '' : `: ${e.text}`}${extra}`;
  if (e.watched || logEvents) print(line);
});

// ---------- commands ----------
const commands = {
  help() {
    console.log(`commands:
  list                all users seen today, in order of first appearance
  present             users currently believed to be in the room
  find <text>         users whose username or nickname contains <text>
  show <user>         full record for one user, including history and their recent chat
  score <user>        why a user has the score they have
  suspects [n]        users seen today ranked by burner score, with reasons (default 20)
  pin <user…> / unpin <user…>   keep accounts on the suspects list when clearing
  dismiss <user…>|all           hide accounts from the suspects list until they join again
  rooms [user]        other rooms with history files; with a user: where else they were seen
  blacklist [add|rm <user…>]   show or edit the blacklisted streamers (flags their followers/viewers)
  chat [n]            last n chat messages in the room (default 20)
  top [chats|likes|coins|gifts|joins|shares] [n]   most active users (default chats, 20)
  watch [user…]       show the watch list, or add users to it (alerts always print)
  unwatch <user>      remove a user from the watch list
  stats               room status, counts and uptime
  log on|off          toggle the live join/leave/gift log (now ${logEvents ? 'on' : 'off'})
  logchat on|off      also print every chat message (now ${logChat ? 'on' : 'off'})
  save [file]         write all records to JSON (default ${monitor.snapshotFile})
  reconnect           force a reconnect
  quit                save and exit`);
  },
  list() { table(monitor.rows()); },
  present() { table(monitor.present()); },
  find(q) { if (!q) return console.log('usage: find <text>'); table(monitor.find(q)); },
  show(id) {
    const d = monitor.detail(id);
    if (!d) return console.log('not found');
    if (d.today) {
      const t = d.today;
      console.log({ ...t, reasons: undefined, firstSeen: fmt(t.firstSeen), lastSeen: fmt(t.lastSeen), firstLeft: fmt(t.firstLeft), lastLeft: fmt(t.lastLeft),
        timeInRoom: shortDur(t.timeInRoom), firstSeenEver: fmt(t.firstSeenEver), lastSeenEver: fmt(t.lastSeenEver) });
      if (d.chat.length) { console.log(`recent chat (${d.chat.length}):`); for (const c of d.chat) console.log(`  ${timeOnly(c.t)}  ${c.text}`); }
    } else console.log(`(not seen today; showing history for ${d.username})`);
    const h = d.history;
    if (h) {
      console.log(`history: first seen ever ${fmt(h.firstSeenEver)}, last ${fmt(h.lastSeenEver)}, ${h.daysSeen} day${h.daysSeen === 1 ? '' : 's'} (${h.dates.slice(-10).join(', ')}${h.dates.length > 10 ? ', …' : ''})`);
      console.log(`         totals: ${h.totals.joins} joins, ${h.totals.chats} chats, ${h.totals.likes} likes, ${h.totals.gifts} gifts (${h.totals.coins} coins), ${h.totals.shares} shares, ${shortDur(h.totals.presentMs)} in room`);
      if (h.aliases.length) console.log(`         previous usernames: ${h.aliases.map(a => '@' + a).join(', ')}`);
      if (h.nicknames.length) console.log(`         previous nicknames: ${h.nicknames.join(', ')}`);
    }
    commands.rooms(id);
    commands.score(id);
  },
  score(id) {
    const d = monitor.detail(id);
    if (!d?.today) return console.log('not seen today (score needs today\'s record)');
    console.log(`score ${d.today.score}${d.today.score >= cfg.burnerAlertScore ? ' (above alert threshold)' : ''}: ${d.today.reasons.join('; ') || 'nothing suspicious'}`);
  },
  suspects(n) {
    const rows = monitor.suspects(Number(n) || 20);
    if (!rows.length) return console.log('(nobody scored above 0)');
    table(rows);
    console.log('');
    for (const u of rows) console.log(`${String(u.score).padStart(3)}  ${u.username}: ${u.reasons.join('; ')}`);
  },
  pin(a) { for (const w of a.split(/[\s,]+/).map(normalizeUsername).filter(Boolean)) lists.pinned.add(w); console.log(`pinned: ${[...lists.pinned].join(', ') || '-'}`); },
  unpin(a) { for (const w of a.split(/[\s,]+/).map(normalizeUsername).filter(Boolean)) lists.pinned.delete(w); commands.pin(''); },
  dismiss(a) {
    const names = a.trim() === 'all' ? monitor.suspects(Infinity).filter(u => !u.pinned).map(u => u.username) : a.split(/[\s,]+/).filter(Boolean);
    console.log(`dismissed ${monitor.dismiss(names)} account(s)`);
  },
  rooms(id) {
    const idx = monitor.refreshRoomIndex();
    if (!id) {
      if (!idx.rooms.length) return console.log(`(no other room histories in ${cfg.dataDir}; run "node viewers.mjs <streamer>" to build one)`);
      return console.log(`other rooms with history: ${idx.rooms.map(r => `@${r}${lists.blacklist.has(r.toLowerCase()) ? ' [blacklisted]' : ''}`).join(', ')}`);
    }
    const d = monitor.detail(id) ?? { username: normalizeUsername(id), rooms: idx.lookup({ username: normalizeUsername(id) }).map(r => ({ ...r, blacklisted: lists.blacklist.has(r.room.toLowerCase()) })) };
    if (!d.rooms.length) return console.log(`${d.username}: not seen in any other monitored room`);
    for (const r of d.rooms) console.log(`  @${r.room}${r.blacklisted ? ' [BLACKLISTED]' : ''}: ${r.follows === true ? 'FOLLOWS host' : r.follows === false ? 'does not follow host' : 'follow status unknown'}, seen ${r.daysSeen} day${r.daysSeen === 1 ? '' : 's'}, last ${fmt(r.lastSeen)}${r.username !== d.username ? ` (as @${r.username})` : ''}`);
  },
  blacklist(a) {
    const [op, ...names] = a.split(/[\s,]+/).filter(Boolean);
    const clean = names.map(normalizeUsername).filter(Boolean);
    if (op === 'add') for (const w of clean) lists.blacklist.add(w);
    else if (op === 'rm' || op === 'remove') for (const w of clean) lists.blacklist.delete(w);
    else if (op) return console.log('usage: blacklist [add|rm <user…>]');
    const known = monitor.refreshRoomIndex().rooms.map(r => r.toLowerCase());
    const missing = [...lists.blacklist].filter(b => !known.includes(b));
    console.log(lists.blacklist.size ? `blacklisted: ${[...lists.blacklist].map(b => '@' + b).join(', ')}` : '(blacklist empty — "blacklist add <streamer>")');
    if (missing.length) console.log(`no history yet for ${missing.map(b => '@' + b).join(', ')}: run "node viewers.mjs ${missing[0]}" while they are live to record their viewers and followers`);
    if (op) console.log('(edit config.json to make this permanent)');
  },
  chat(n) {
    const rows = monitor.recentChat.slice(-(Number(n) || 20));
    if (!rows.length) return console.log('(no chat yet)');
    for (const c of rows) console.log(`${timeOnly(c.t)}  ${c.user}: ${c.text}`);
  },
  top(a) {
    const [field = 'chats', n = '20'] = a.split(/\s+/).filter(Boolean);
    if (!['chats', 'likes', 'coins', 'gifts', 'joins', 'shares'].includes(field)) return console.log('usage: top [chats|likes|coins|gifts|joins|shares] [n]');
    table(monitor.top(field, Number(n) || 20));
  },
  watch(a) {
    for (const w of a.split(/[\s,]+/).map(normalizeUsername).filter(Boolean)) lists.watch.add(w);
    console.log(lists.watch.size ? `watching: ${[...lists.watch].join(', ')}` : '(watch list empty — "watch <user>" to add)');
  },
  unwatch(a) { for (const w of a.split(/[\s,]+/).map(normalizeUsername).filter(Boolean)) lists.watch.delete(w); commands.watch(''); },
  stats() {
    const s = monitor.snapshot();
    console.log(`room: @${s.room}${s.id ? ` (${s.id})` : ''}   ${s.live ? `LIVE, connected ${dur(Date.now() - s.connectedAt)}` : `${s.state} (${s.stateMessage})`}   monitor up ${dur(s.uptime)}
title: ${s.title ?? '-'}
viewers now: ${s.viewers ?? '?'}   total viewers (tiktok): ${s.totalViewers ?? '?'}   likes: ${s.likes ?? '?'}
tracked: ${s.counts.seen} users seen, ${s.counts.present} believed present, ${s.counts.chatted} chatted, ${s.counts.gifted} gifted, ${s.counts.flagged} flagged
history: ${s.counts.known} users ever seen here (${cfg.pruneAfterDays ? `forgotten after ${cfg.pruneAfterDays} days` : 'kept forever'})   other rooms: ${s.otherRooms.length}   blacklist: ${[...lists.blacklist].join(', ') || '-'}   alert at score: ${cfg.burnerAlertScore}
idle timeout: ${cfg.idleTimeoutMinutes}m   autosave: ${cfg.autosaveMinutes ? `every ${cfg.autosaveMinutes}m` : 'off'}   watch: ${[...lists.watch].join(', ') || '-'}
files: chat ${cfg.chatToFile ? monitor.chatFile : 'off'}   events ${cfg.eventsToFile ? monitor.eventsFile : 'off'}`);
  },
  log(v) { logEvents = v !== 'off'; console.log(`event log ${logEvents ? 'on' : 'off'}`); },
  logchat(v) { logChat = v !== 'off'; console.log(`chat log ${logChat ? 'on' : 'off'}`); },
  save(file) { const r = monitor.save(file || undefined); console.log(`saved ${r.count} users to ${r.file}`); },
  reconnect() { monitor.reconnect(); },
  quit() { quit(); },
  exit() { quit(); },
};

function quit() {
  monitor.stop();
  rl.close();
  process.exit(0);
}

rl.on('line', line => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (cmd) {
    const fn = commands[cmd.toLowerCase()];
    if (fn) { try { fn(rest.join(' ')); } catch (e) { console.error(`error: ${e.message}`); } }
    else console.log(`unknown command "${cmd}" — type "help"`);
  }
  rl.prompt();
});
rl.on('close', quit);
process.on('SIGINT', quit);

console.log(`Bouncer — @${monitor.username}  (idle timeout ${cfg.idleTimeoutMinutes}m${lists.watch.size ? `, watching ${[...lists.watch].join(', ')}` : ''})`);
monitor.start();
rl.prompt();
promptShown = true;
