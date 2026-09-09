// Heuristics for spotting throwaway ("burner") accounts in a LIVE room.
//
// Nothing here proves anything. Each signal adds points and a human-readable reason; the score
// is meant to rank who deserves a closer look, not to condemn anyone. Weights are deliberately
// visible so they can be tuned in one place.

export const WEIGHTS = {
  inBlacklistedRoomNow: 4, // in a blacklisted streamer's room at this moment (both rooms monitored)
  followsBlacklisted: 5,   // TikTok reported them as following a blacklisted streamer
  seenInBlacklistedRoom: 2, // showed up in a blacklisted streamer's room before (follow status unknown / no)
  renamed: 3,              // same account seen under a different username before
  noFollowers: 2,          // 0 followers
  fewFollowers: 1,         // < 10 followers
  followsNobody: 1,        // 0 following (and 0 followers)
  defaultUsername: 2,      // TikTok-generated name such as user8237461920
  defaultNickname: 1,      // nickname never changed from the username
  privateAccount: 1,
  newToRoom: 1,            // first day we have ever seen them here
  lurker: 1,               // joined, never chatted / liked / gifted / shared
  driveBy: 1,              // total time in room under 2 minutes
  repeatDriveBy: 1,        // 3+ joins today but still under 5 minutes in room
};

const DEFAULT_NAME = /^user\d{6,}$/i;

/**
 * @param {object} u         tracker record
 * @param {object} [ctx]
 * @param {object} [ctx.history]   RoomHistory summary for this user (from RoomHistory.summarize)
 * @param {Array}  [ctx.rooms]     entries from loadRoomIndex().lookup(u)
 * @param {Array}  [ctx.liveIn]    blacklisted rooms the user is present in right now
 * @param {Set}    [ctx.blacklist] lowercase streamer usernames
 * @param {number} [ctx.timeInRoom] ms spent in the room today
 * @param {number} [ctx.now]
 *
 * TikTok does not deliver account creation dates or bios in LIVE events (checked against real
 * rooms: always empty), so there are deliberately no account-age or bio signals.
 * @returns {{score:number, reasons:string[], blacklisted:string[]}}
 */
export function scoreUser(u, ctx = {}) {
  const reasons = [];
  let score = 0;
  const hit = (key, text) => { score += WEIGHTS[key]; reasons.push(text); };

  const blacklisted = [];
  const liveIn = ctx.liveIn ?? [];
  for (const room of liveIn) { blacklisted.push(room); hit('inBlacklistedRoomNow', `in blacklisted @${room}'s room right now`); }
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

  if (!h || h.daysSeen <= 1) hit('newToRoom', 'first day in this room');
  if (u.joins > 0 && !u.chats && !u.likes && !u.gifts && !u.shares) hit('lurker', 'never interacted');

  const inRoom = ctx.timeInRoom ?? 0;
  if (u.joins > 0 && !u.present && inRoom < 2 * 60_000) hit('driveBy', 'stayed under 2 minutes');
  if (u.joins >= 3 && inRoom < 5 * 60_000) hit('repeatDriveBy', `${u.joins} joins, under 5 minutes total`);

  return { score, reasons, blacklisted };
}
