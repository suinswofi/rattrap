// Demo mode: a fake TikTok connection that plays back invented activity, so the app can be
// exercised (and screenshotted) without a live stream or real people. Enabled with RATTRAP_DEMO=1.
// Everything here is fictional; names are generated and any resemblance is accidental.

import { EventEmitter } from 'node:events';
import { WebcastEvent } from 'tiktok-live-connector';

export const DEMO_ROOMS = ['sirstreamsalot', 'rival_streamer'];

// [username, nickname, followers, following, followsRival]
const PEOPLE = [
  ['pixel_penny', 'Penny ✨', 1840, 320, false], ['moss_and_matcha', 'Moss 🍵', 412, 388, false],
  ['captain_quokka', 'Quokka Cap', 9120, 150, false], ['lofi_lorenzo', 'Lorenzo', 77, 210, false],
  ['tessa.tinkers', 'Tessa', 2210, 640, false], ['gadget_gus', 'Gus ⚙️', 305, 501, false],
  ['nova_nightowl', 'Nova 🦉', 15600, 90, false], ['bramble_bee', 'Bramble', 128, 260, false],
  ['sunnyside_sam', 'Sam ☀️', 690, 700, false], ['orbit_ollie', 'Ollie', 44, 130, false],
  ['marigold_mae', 'Mae 🌼', 3300, 410, false], ['dune_drifter', 'Drifter', 812, 902, false],
  ['kettle_kai', 'Kai', 58, 61, false], ['fable_fox', 'Fable 🦊', 24100, 75, false],
  ['harbor_hal', 'Hal', 219, 340, false], ['ivy.on.air', 'Ivy', 1002, 233, false],
  ['juniper_jules', 'Jules 🌲', 371, 180, false], ['shadowfax_77', 'shadowfax_77', 3, 41, true],
  ['user8237461920', 'user8237461920', 0, 0, true], ['user5510938274', 'user5510938274', 1, 12, false],
  ['quiet_qm', 'quiet_qm', 6, 9, true], ['echo_ember', 'Ember', 540, 512, false],
  ['tundra_toby', 'Toby ❄️', 132, 200, false], ['velvet_vera', 'Vera', 7800, 300, false],
];
const CHAT = ['hello everyone!!', 'lol', 'W stream', 'what game is this', 'first time here 👋', 'gg', 'no way 😂', 'hi from Canada', 'love this', 'can you say hi to my sister', 'brb', '🔥🔥🔥', 'that was clean', 'how long are you live for?', 'HAHAHA', 'this is so good'];
const GIFTS = [['Rose', 1], ['TikTok', 1], ['Finger Heart', 5], ['Perfume', 20], ['Hand Hearts', 100]];

// Small deterministic PRNG so screenshots are reproducible.
const rng = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

export function createDemoConnection(room) {
  const conn = new EventEmitter();
  const rand = rng(room.length * 7919 + 17);
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const isRival = room === DEMO_ROOMS[1];
  const cast = PEOPLE.filter((p, i) => isRival ? (p[4] || i % 7 === 2) : i % 5 !== 4);
  let present = [];
  let memberCount = 60 + Math.floor(rand() * 40);
  let timer = null;

  const user = ([username, nickname, followers, following, followsRival]) => ({
    user: { displayId: username, id: `demo-${username}`, nickname,
      followInfo: { followerCount: String(followers), followingCount: String(following), followStatus: isRival ? (followsRival ? '1' : '0') : (followers > 500 ? '1' : '0') } },
    common: { createTime: String(Date.now()) },
  });

  const tick = () => {
    const r = rand();
    if (present.length < cast.length && (r < 0.3 || present.length < 6)) {
      const p = pick(cast.filter(x => !present.includes(x)));
      present.push(p); memberCount++;
      conn.emit(WebcastEvent.MEMBER, { ...user(p), memberCount });
    } else if (r < 0.65) {
      conn.emit(WebcastEvent.CHAT, { ...user(pick(present)), comment: pick(CHAT) });
    } else if (r < 0.85) {
      conn.emit(WebcastEvent.LIKE, { ...user(pick(present)), count: 1 + Math.floor(rand() * 15), total: 1000 + Math.floor(rand() * 9000) });
    } else if (r < 0.93) {
      const [name, diamondCount] = pick(GIFTS);
      conn.emit(WebcastEvent.GIFT, { ...user(pick(present)), gift: { name, diamondCount, type: 0 }, repeatCount: 1, repeatEnd: 1 });
    } else if (r < 0.97) {
      conn.emit(WebcastEvent.SHARE, user(pick(present)));
    } else {
      conn.emit(WebcastEvent.FOLLOW, user(pick(present)));
    }
    timer = setTimeout(tick, 250 + rand() * 900);
  };

  conn.connect = async () => {
    await new Promise(r => setTimeout(r, 400));
    timer = setTimeout(tick, 300);
    return { roomId: `demo-${room}`, roomInfo: { data: { title: isRival ? 'late night chaos 🌙' : 'cozy build stream 🛠️', user_count: memberCount } } };
  };
  conn.disconnect = () => { clearTimeout(timer); timer = null; };
  conn.waitUntilLive = async () => true;
  return conn;
}
