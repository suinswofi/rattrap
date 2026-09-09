// Heuristics for spotting throwaway ("burner") accounts in a LIVE room.
//
// Nothing here proves anything. Each signal adds points and a human-readable reason; the score
// is meant to rank who deserves a closer look, not to condemn anyone. Weights are deliberately
// visible so they can be tuned in one place.

const DAY = 24 * 60 * 60 * 1000;

export const WEIGHTS = {
  followsBlacklisted: 5,   // TikTok reported them as following a blacklisted streamer
  seenInBlacklistedRoom: 2, // showed up in a blacklisted streamer's room (follow status unknown / no)
  renamed: 3,              // same account seen under a different username before
  accountUnder7d: 4,       // account created less than a week ago
  accountUnder30d: 2,      // ... less than a month ago
  noFollowers: 2,          // 0 followers
  fewFollowers: 1,         // < 10 followers
  followsNobody: 1,        // 0 following (and 0 followers)
  defaultUsername: 2,      // TikTok-generated name such as user8237461920
  defaultNickname: 1,      // nickname never changed from the username
  noBio: 1,                // empty bio (only counted when profile data was delivered)
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
 * @param {Set}    [ctx.blacklist] lowercase streamer usernames
 * @param {number} [ctx.timeInRoom] ms spent in the room today
 * @param {number} [ctx.now]
 * @returns {{score:number, reasons:string[], blacklisted:string[]}}
 */
export function scoreUser(u, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const reasons = [];
  let score = 0;
  const hit = (key, text) => { score += WEIGHTS[key]; reasons.push(text); };

  const blacklisted = [];
  for (const r of ctx.rooms ?? []) {
    if (!ctx.blacklist?.has(r.room.toLowerCase())) continue;
    blacklisted.push(r.room);
    if (r.follows === true) hit('followsBlacklisted', `follows blacklisted @${r.room}`);
    else hit('seenInBlacklistedRoom', `seen in blacklisted @${r.room}'s room (${r.daysSeen} day${r.daysSeen === 1 ? '' : 's'})`);
  }

  const h = ctx.history;
  if (h?.aliases?.length) hit('renamed', `previously named ${h.aliases.map(a => '@' + a).join(', ')}`);

  const created = u.accountCreated ?? h?.profile?.accountCreated ?? null;
  if (created) {
    const ageDays = (now - created) / DAY;
    if (ageDays < 7) hit('accountUnder7d', `account is ${ageDays < 1 ? 'less than a day' : Math.floor(ageDays) + ' days'} old`);
    else if (ageDays < 30) hit('accountUnder30d', `account is ${Math.floor(ageDays)} days old`);
  }

  const followers = u.followers ?? h?.profile?.followers ?? null;
  const following = u.following ?? h?.profile?.following ?? null;
  if (followers === 0) hit('noFollowers', 'no followers');
  else if (followers !== null && followers < 10) hit('fewFollowers', `only ${followers} followers`);
  if (followers === 0 && following === 0) hit('followsNobody', 'follows nobody');

  if (DEFAULT_NAME.test(u.username)) hit('defaultUsername', 'auto-generated username');
  if (u.nickname && (u.nickname === u.username || DEFAULT_NAME.test(u.nickname))) hit('defaultNickname', 'default nickname');

  const profileKnown = followers !== null;
  const bio = u.bio ?? h?.profile?.bio ?? null;
  if (profileKnown && !bio) hit('noBio', 'empty bio');
  if (u.privateAccount ?? h?.profile?.privateAccount) hit('privateAccount', 'private account');

  if (!h || h.daysSeen <= 1) hit('newToRoom', 'first day in this room');
  if (u.joins > 0 && !u.chats && !u.likes && !u.gifts && !u.shares) hit('lurker', 'never interacted');

  const inRoom = ctx.timeInRoom ?? 0;
  if (u.joins > 0 && !u.present && inRoom < 2 * 60_000) hit('driveBy', 'stayed under 2 minutes');
  if (u.joins >= 3 && inRoom < 5 * 60_000) hit('repeatDriveBy', `${u.joins} joins, under 5 minutes total`);

  return { score, reasons, blacklisted };
}

/** Age of an account in whole days, or null. */
export const accountAgeDays = (created, now = Date.now()) => created ? Math.floor((now - created) / DAY) : null;
