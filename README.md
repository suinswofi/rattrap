# Bouncer

A doorman for your TikTok LIVE room. Bouncer watches who comes in, remembers them across
streams, and points out accounts that look like throwaways: brand-new profiles, zero followers,
auto-generated names, drive-by visits, renamed accounts, and viewers who follow streamers you
have blacklisted. It exists to help a streamer work out which accounts are likely burners used
to file bogus abuse reports.

Bouncer is an Electron desktop app with a Twitch-style dark interface. The same engine also runs
at a terminal prompt for headless use.

```sh
npm install
npm start                        # desktop app, opens the rooms saved in config.json
npm start -- someone_else        # also open @someone_else for this session only
npm run cli -- someone_else      # terminal client instead of the GUI
npm test
```

## The app

- **Rooms** (sidebar): every streamer being monitored, with a status dot (red = live, yellow =
  waiting for them to go live, purple = connecting) and present/seen counts. Add a room with the
  box below the list. Rooms added here are remembered in `config.json`.
- **Blacklist** and **Watch list** (sidebar): edited in place, saved immediately.
- **Users** tab: everyone seen today. Click a column to sort, type to search, tick "present only".
  Click a row for the detail drawer.
- **Suspects** tab: today's users ranked by burner score with the reasons spelled out.
- **Chat** and **Log** tabs: live chat and the join/leave/gift/flag event log.
- **Detail drawer**: today's activity, TikTok-reported profile (followers, following, account
  age, bio, verified, private), the room history (first seen ever, days seen, totals, previous
  usernames), other monitored rooms the account appeared in and whether it follows their host,
  and recent chat. Buttons to watch the account or open it on TikTok.
- **Toasts** pop up for flagged joins, watched users, saves and errors.
- **Settings**: idle timeout, alert score, autosave, live polling, Euler Stream API key.

If a streamer is offline the monitor waits and connects when they go live. It reconnects after
drops, marks everyone as gone when the stream ends, autosaves, and resumes today's snapshot on
restart.

## What is remembered

Two kinds of files live in `data/`:

- **Daily snapshots** `viewers-<room>-<date>.json`: everything seen today, including recent chat.
- **Room history** `history-<room>.json`: one record per account ever seen in that room, keyed by
  TikTok user id, with per-day activity (joins, chats, likes, gifts, coins, shares, time in room),
  first/last seen ever, previous usernames and nicknames, follow status towards the host, and the
  latest profile details TikTok delivered.

Each room has its own history file, written only by that room's monitor, so several rooms can be
open at once without conflicts. Days are stored separately and replaced on each save, so
autosaves never double-count. A stream that runs past midnight still counts as one day.

## Blacklisted streamers

TikTok does not expose who follows whom, but every event a viewer generates in a room carries
their follow status towards *that room's host*. So the way to learn whether someone follows
@rival is to let Bouncer sit in @rival's room: add `rival` as a room **and** to the blacklist.
While @rival is live, Bouncer records who was there and who follows them. In your own room,
anyone recorded as following @rival is announced on join and tagged `BL:@rival`. Being seen in a
blacklisted room without a confirmed follow counts too, with fewer points. Other rooms' histories
are re-read whenever any room saves.

## Burner score

Every account gets a transparent score. Each signal adds points and a plain-English reason.
Weights live at the top of `burner.js`:

| signal | points |
|---|---|
| follows a blacklisted streamer | 5 |
| seen in a blacklisted streamer's room | 2 |
| account created under 7 days ago / under 30 days | 4 / 2 |
| 0 followers / fewer than 10 followers | 2 / 1 |
| 0 followers and 0 following | 1 |
| auto-generated username (`user8237461920`) | 2 |
| nickname never changed from the username | 1 |
| empty bio (only when TikTok sent profile data) | 1 |
| private account | 1 |
| first day ever seen in this room | 1 |
| joined but never chatted, liked, gifted or shared | 1 |
| under 2 minutes in the room | 1 |
| 3+ joins today, still under 5 minutes total | 1 |
| seen under a different username before (same account) | 3 |

Joins that reach the alert score (`burnerAlertScore`, default 6) are announced once per run.
Higher means more burner-like signals stacked on one account. Roughly: 0 to 2 is nothing
notable, 3 to 5 is a typical first-time visitor in a busy room, 6 and up needs a profile signal
or a blacklist hit, 10 and up is several strong signals together.

The score ranks who deserves a second look. It proves nothing on its own: a shy newcomer on a
fresh account looks the same as a burner until they do something. In busy rooms TikTok samples
join and like events, so many honest viewers appear once and never again, which alone earns a
couple of points. Rely on the profile-based reasons and the blacklist, not on the lurker signals.

## Configuration

`config.json` next to the app (all keys optional). The GUI edits it for you; the terminal client
takes the flags shown in brackets.

| key                  | default                    | meaning |
|----------------------|----------------------------|---------|
| `rooms`              | `[]`                       | rooms the app opens on start; falls back to `username` |
| `username`           | `the_great_sir_stromburg`  | default room for the terminal client (first argument, or env `TIKTOK_USER`) |
| `idleTimeoutMinutes` | `15`                       | inactivity after which a viewer is assumed gone (`--timeout`) |
| `watch`              | `[]`                       | viewers whose joins/chats/gifts always alert (`--watch a,b`) |
| `blacklist`          | `[]`                       | streamers whose followers and viewers are flagged (`--blacklist a,b`) |
| `burnerAlertScore`   | `6`                        | score at which a join is announced (`--alert n`) |
| `signApiKey`         | `""`                       | optional Euler Stream API key for higher connect limits (`--key`, env `EULER_API_KEY`) |
| `dataDir`            | `data`                     | snapshot and history directory (`--data`) |
| `autosaveMinutes`    | `5`                        | autosave interval, `0` to disable |
| `resume`             | `true`                     | load today's snapshot on start (`--no-resume`) |
| `reconnectWhenLive`  | `true`                     | if offline, wait for the stream instead of giving up |
| `livePollSeconds`    | `60`                       | how often to check for the stream while waiting (min 30) |
| `chatHistory`        | `50`                       | recent chat messages kept per user |
| `logEvents`          | `true`                     | terminal client: print joins/leaves/gifts (`--quiet` to start off) |
| `logChat`            | `false`                    | terminal client: also print every chat message (`--chat`) |

## Terminal client

`node viewers.mjs [username] [flags]` gives the same monitor at a prompt. Commands:

```
list / present / find <text> / show <user> / score <user>
suspects [n]         today's users ranked by burner score, with reasons
rooms [user]         other rooms with history files; with a user: where else they were seen
blacklist [add|rm <user…>]
chat [n] / top [chats|likes|coins|gifts|joins] [n]
watch [user…] / unwatch <user> / stats / log on|off / logchat on|off
save [file] / reconnect / quit
```

## Layout

| file | role |
|---|---|
| `main.js`, `preload.cjs`, `renderer/` | Electron app: main process, IPC bridge, HTML/CSS/JS interface |
| `monitor.js` | one room: connection, events, scoring, saving; no UI |
| `tracker.js` | today's presence and activity per viewer |
| `history.js` | cross-day, cross-room memory |
| `burner.js` | scoring heuristics and weights |
| `viewers.mjs` | terminal client |

## Accuracy

TikTok sends no "user left" event. A leave is inferred either when a user re-joins
(they must have left in between) or after the idle timeout with no chat/like/gift/share.
The recorded leave time is the last moment they were seen, so it is never later than reality.
In busy rooms TikTok samples join and like events, so not every viewer will appear.

Follower counts, account age, bio and the other profile fields are whatever TikTok attaches
to the viewer's own events; a dash means it was never delivered. Follow status towards another
streamer is only known for rooms Bouncer has monitored.
