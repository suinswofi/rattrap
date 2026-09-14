// Heuristics for spotting throwaway ("burner") accounts in a LIVE room.
//
// Nothing here proves anything. Each signal adds points and a human-readable reason; the score
// is meant to rank who deserves a closer look, not to condemn anyone. Weights are deliberately
// visible so they can be tuned in one place.

export const WEIGHTS = {
  // blacklist signals (cross-checks against other monitored rooms)
  followsBlacklisted: 5,    // TikTok reported them as following a blacklisted streamer
  inBlacklistedStream: 4,   // seen in a blacklisted streamer's current stream as well (both rooms monitored)
  seenInBlacklistedRoom: 2, // showed up in a blacklisted streamer's room in an earlier stream
  // profile signals
  renamed: 3,               // same account seen under a different username before
  noFollowers: 2,           // 0 followers
  fewFollowers: 1,          // < 10 followers
  followsNobody: 1,         // 0 following (and 0 followers)
  defaultUsername: 2,       // TikTok-generated name such as user8237461920
  defaultNickname: 1,       // nickname never changed from the username
  privateAccount: 1,
  // behaviour this stream
  newToRoom: 1,             // never seen in this room in an earlier stream
  lurker: 1,                // joined, never chatted / liked / gifted / shared
  repeatJoins: 1,           // joined three or more times this stream (in and out)
};
const BLACKLIST_KEYS = new Set(['followsBlacklisted', 'inBlacklistedStream', 'seenInBlacklistedRoom']);

const DEFAULT_NAME = /^user\d{6,}$/i;

/** "45s", "3m", "1h05m" */
export const shortDur = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
};

/** Plain-English description of a hop between this room and a blacklisted streamer's stream. */
export function hopText(hop) {
  const gap = shortDur(hop.gapMs);
  return hop.dir === 'from'
    ? `came from blacklisted @${hop.room}'s stream (seen there ${gap} earlier)`
    : `went to blacklisted @${hop.room}'s stream (${gap} after last seen here)`;
}

/**
 * @param {object} u         tracker record
 * @param {object} [ctx]
 * @param {object} [ctx.history]   RoomHistory summary for this user (from RoomHistory.summarize)
 * @param {Array}  [ctx.rooms]     entries from loadRoomIndex().lookup(u)
 * @param {Array}  [ctx.liveIn]    blacklisted rooms whose current stream the user has also been seen in
 * @param {Set}    [ctx.blacklist] lowercase streamer usernames
 * @param {string} [ctx.sid]       id of the current stream (so it is not counted as an earlier visit)
 *
 * TikTok does not deliver account creation dates or bios in LIVE events (checked against real
 * rooms: always empty), so there are deliberately no account-age or bio signals. It sends no
 * "user left" event either, so there are no signals about how long someone stayed.
 * @returns {{score:number, blacklistScore:number, reasons:string[], blacklisted:string[]}}
 */
export function scoreUser(u, ctx = {}) {
  const reasons = [];
  let score = 0, blacklistScore = 0;
  const hit = (key, text) => { score += WEIGHTS[key]; if (BLACKLIST_KEYS.has(key)) blacklistScore += WEIGHTS[key]; reasons.push(text); };

  const blacklisted = [];
  const liveIn = ctx.liveIn ?? [];
  for (const room of liveIn) {
    blacklisted.push(room);
    const hop = [...(u.hops ?? [])].reverse().find(h => h.room === room);
    hit('inBlacklistedStream', hop ? hopText(hop) : `also in blacklisted @${room}'s current stream`);
  }
  for (const r of ctx.rooms ?? []) {
    if (!ctx.blacklist?.has(r.room.toLowerCase())) continue;
    if (!blacklisted.includes(r.room)) blacklisted.push(r.room);
    if (r.follows === true) hit('followsBlacklisted', `follows blacklisted @${r.room}`);
    else if (!liveIn.includes(r.room)) hit('seenInBlacklistedRoom', `seen in blacklisted @${r.room}'s room before (${r.daysSeen} day${r.daysSeen === 1 ? '' : 's'})`);
  }

  const h = ctx.history;
  if (h?.aliases?.length) hit('renamed', `previously named ${h.aliases.map(a => '@' + a).join(', ')}`);

  const followers = u.followers ?? h?.profile?.followers ?? null;
  const following = u.following ?? h?.profile?.following ?? null;
  if (followers === 0) hit('noFollowers', 'no followers');
  else if (followers !== null && followers < 10) hit('fewFollowers', `only ${followers} followers`);
  if (followers === 0 && following === 0) hit('followsNobody', 'follows nobody');

  if (DEFAULT_NAME.test(u.username)) hit('defaultUsername', 'auto-generated username');
  if (u.nickname && (u.nickname === u.username || DEFAULT_NAME.test(u.nickname))) hit('defaultNickname', 'default nickname');

  if (u.privateAccount ?? h?.profile?.privateAccount) hit('privateAccount', 'private account');

  const earlier = (h?.streams ?? []).filter(s => s.sid !== ctx.sid).length;
  if (!earlier) hit('newToRoom', 'first time in this room');
  if (u.joins > 0 && !u.chats && !u.likes && !u.gifts && !u.shares) hit('lurker', 'never interacted');
  if (u.joins >= 3) hit('repeatJoins', `joined ${u.joins} times this stream`);

  return { score, blacklistScore, reasons, blacklisted };
}
