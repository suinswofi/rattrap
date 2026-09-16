// TikTok Rat Trap — Electron main process. Owns the room monitors and config.json; the renderer talks to
// it only through the IPC channels exposed in preload.cjs.

import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Monitor, readConfigFile, normalizeConfig, configToJSON, normalizeUsername, nameSet, roomLists } from './monitor.js';
import { createDemoConnection, DEMO_ROOMS } from './demo.js';
import electronUpdater from 'electron-updater'; // CommonJS package: named imports do not work from ESM
import { downloadPortable, installPortable, cleanupOld } from './portable-update.js';

// RATTRAP_DEMO=1 runs against invented activity instead of TikTok, with throwaway data, and never
// touches config.json. Handy for UI work and screenshots.
const DEMO = process.env.RATTRAP_DEMO === '1';

const HERE = dirname(fileURLToPath(import.meta.url));
// Running from the repo: config.json and data/ live next to the code. Packaged (AppImage, installer):
// the bundle is read-only, so they live in the per-user app data folder instead.
const APP_DIR = app.isPackaged ? app.getPath('userData') : HERE;
const CONFIG_FILE = join(APP_DIR, 'config.json');

let fileCfg, cfg;
try {
  fileCfg = DEMO ? { ...readConfigFile(''), dataDir: join(tmpdir(), 'rattrap-demo'), rooms: DEMO_ROOMS, lists: { [DEMO_ROOMS[0]]: { blacklist: [DEMO_ROOMS[1]], watch: ['captain_quokka'] } } } : readConfigFile(CONFIG_FILE);
  cfg = normalizeConfig({ ...fileCfg }, APP_DIR);
} catch (e) {
  app.whenReady().then(() => { dialog.showErrorBox('TikTok Rat Trap', `Could not read ${CONFIG_FILE}:\n${e.message}`); app.quit(); });
}

const monitors = new Map(); // room -> Monitor
const persistedRooms = new Set(); // rooms remembered in config.json (command-line rooms are session-only)
let win = null;

const send = payload => { if (win && !win.isDestroyed()) win.webContents.send('rattrap:event', payload); };

function saveConfig() {
  if (DEMO) return;
  const out = { ...configToJSON(cfg), dataDir: fileCfg.dataDir, rooms: [...persistedRooms].filter(r => monitors.has(r)) };
  try { mkdirSync(APP_DIR, { recursive: true }); writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2)); }
  catch (e) { send({ type: 'log', room: null, entry: { t: Date.now(), kind: 'error', text: `could not save config: ${e.message}`, alert: true } }); }
}

function roomSummary(m) {
  return { room: m.username, state: m.state, message: m.stateMessage, viewers: m.room.viewers, live: m.room.live, title: m.room.title,
    sid: m.stream?.sid ?? null, seen: m.tracker.users.size, flagged: m.flagged.size };
}
const roomList = () => [...monitors.values()].map(roomSummary);

function addRoom(name) {
  const room = normalizeUsername(name);
  if (!room) throw new Error('empty username');
  if (monitors.has(room)) return roomSummary(monitors.get(room));
  const m = new Monitor(room, cfg, { peers: () => monitors.values(), ...(DEMO ? { createConnection: createDemoConnection } : {}) });
  monitors.set(room, m);
  m.on('join', ({ user, t }) => { for (const other of monitors.values()) if (other !== m) other.peerJoined(room, user, t); });
  m.on('log', entry => send({ type: 'log', room, entry }));
  m.on('status', s => send({ type: 'status', ...s, rooms: roomList() }));
  m.on('flag', f => send({ type: 'flag', ...f }));
  m.on('hop', f => send({ type: 'hop', ...f }));
  m.on('users', () => send({ type: 'users', room }));
  m.on('saved', r => {
    for (const other of monitors.values()) if (other !== m) other.refreshRoomIndex();
    send({ type: 'saved', room, ...r });
  });
  m.start();
  return roomSummary(m);
}

function removeRoom(name) {
  const room = normalizeUsername(name);
  const m = monitors.get(room);
  if (!m) return false;
  m.stop();
  monitors.delete(room);
  m.removeAllListeners();
  return true;
}

const getMonitor = name => {
  const m = monitors.get(normalizeUsername(name));
  if (!m) throw new Error(`not monitoring @${name}`);
  return m;
};

// ---------- IPC ----------
ipcMain.handle('config:get', () => ({ ...configToJSON(cfg), configFile: CONFIG_FILE }));
ipcMain.handle('config:set', (_e, patch) => {
  const allowed = ['burnerAlertScore', 'autosaveMinutes', 'signApiKey', 'reconnectWhenLive', 'livePollSeconds', 'chatHistory', 'resume', 'pruneAfterDays', 'maxUsers', 'logKeepDays', 'popupSeconds'];
  const next = { ...cfg };
  for (const k of allowed) if (patch && patch[k] !== undefined) next[k] = patch[k];
  normalizeConfig(next, null); // throws on bad values; dataDir already absolute
  Object.assign(cfg, next);
  for (const m of monitors.values()) m.tracker.chatHistory = cfg.chatHistory;
  saveConfig();
  return configToJSON(cfg);
});
ipcMain.handle('rooms:list', () => roomList());
ipcMain.handle('rooms:add', (_e, name) => { const r = addRoom(name); persistedRooms.add(r.room); saveConfig(); send({ type: 'rooms', rooms: roomList() }); return r; });
ipcMain.handle('rooms:remove', (_e, name) => { const r = removeRoom(name); persistedRooms.delete(normalizeUsername(name)); saveConfig(); send({ type: 'rooms', rooms: roomList() }); return r; });
ipcMain.handle('rooms:reconnect', (_e, name) => { getMonitor(name).reconnect(); return true; });
ipcMain.handle('room:snapshot', (_e, name) => getMonitor(name).snapshot());
ipcMain.handle('room:detail', (_e, name, id) => getMonitor(name).detail(id));
// The current stream's log lives in memory; an earlier stream's is read from its file.
ipcMain.handle('room:log', (_e, name, sid) => { const m = getMonitor(name); return sid && sid !== m.stream?.sid ? m.readLog(String(sid)) : m.logLines; });
ipcMain.handle('room:flags', (_e, name) => [...getMonitor(name).flagged.values()]);
ipcMain.handle('room:save', (_e, name) => getMonitor(name).save());
ipcMain.handle('room:dismiss', (_e, name, users) => getMonitor(name).dismiss(Array.isArray(users) ? users : [users]));
ipcMain.handle('room:undismiss', (_e, name, users) => getMonitor(name).undismiss(Array.isArray(users) ? users : [users]));
ipcMain.handle('list:edit', (_e, room, list, op, names) => {
  if (!['watch', 'blacklist', 'pinned'].includes(list)) throw new Error('unknown list');
  const lists = roomLists(cfg, room);
  const set = lists[list];
  const clean = nameSet(Array.isArray(names) ? names : String(names).split(/[\s,]+/));
  for (const n of clean) op === 'remove' ? set.delete(n) : set.add(n);
  saveConfig();
  // A newly pinned or watched account gets its whole logged past copied into the history.
  if (op !== 'remove' && list !== 'blacklist') monitors.get(normalizeUsername(room))?.retainEvents([...clean]);
  send({ type: 'lists', room: normalizeUsername(room), watch: [...lists.watch], blacklist: [...lists.blacklist], pinned: [...lists.pinned] });
  return [...set];
});
ipcMain.handle('open:data', () => shell.openPath(cfg.dataDir));
ipcMain.handle('update:get', () => update);
ipcMain.handle('update:check', () => checkForUpdates(true));
ipcMain.handle('update:download', () => downloadUpdate());
ipcMain.handle('update:install', () => installUpdate());
ipcMain.handle('update:open', () => shell.openExternal(RELEASES_URL));
ipcMain.handle('open:external', (_e, url) => {
  if (!/^https:\/\/(www\.)?tiktok\.com\//.test(String(url))) throw new Error('refusing to open non-TikTok URL');
  return shell.openExternal(url);
});

// ---------- updates ----------
// A packaged build asks GitHub for a newer release shortly after start (and when the user presses Check for
// updates). It only tells the user; nothing is downloaded or installed until they choose to from the notice.
// electron-updater handles the Windows installer and the AppImage. The Windows portable exe is not something
// it can update, so portable-update.js fetches the new exe from the release and swaps it in on restart.
// RATTRAP_NO_UPDATE=1 switches the check off.
const RELEASES_URL = 'https://github.com/suinswofi/rattrap/releases/latest';
const PORTABLE_EXE = process.env.PORTABLE_EXECUTABLE_FILE; // set by the electron-builder portable launcher
const PORTABLE = !!PORTABLE_EXE;
let portableFiles = null; // { tmp, finalPath } once the portable exe is downloaded
const UPDATES = app.isPackaged && !DEMO && process.env.RATTRAP_NO_UPDATE !== '1';
const autoUpdater = UPDATES ? electronUpdater.autoUpdater : null; // the getter builds the platform updater; only wanted when packaged
// state: idle | checking | none | available | downloading | ready | error
let update = { state: 'idle', version: null, current: app.getVersion(), portable: PORTABLE, enabled: UPDATES };
const sendUpdate = patch => { update = { ...update, ...patch }; send({ type: 'update', ...update }); };

if (UPDATES) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true; // a downloaded update the user chose still installs if they just close the app
  autoUpdater.on('update-available', info => sendUpdate({ state: 'available', version: info.version, message: null }));
  autoUpdater.on('update-not-available', info => sendUpdate({ state: 'none', version: info.version, message: null }));
  autoUpdater.on('download-progress', p => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => sendUpdate({ state: 'ready', version: info.version }));
  // A failed automatic check (offline, GitHub down) is not worth bothering the user about; a failed manual check or download is.
  autoUpdater.on('error', e => { console.error('update:', e.message); sendUpdate(update.state === 'checking' && !update.manual ? { state: 'idle' } : { state: 'error', message: e.message }); });
}

async function downloadUpdate() {
  if (update.state !== 'available') throw new Error('nothing to download');
  sendUpdate({ state: 'downloading', percent: 0 });
  if (!PORTABLE) { await autoUpdater.downloadUpdate(); return true; } // progress and 'ready' arrive through the events above
  try {
    portableFiles = await downloadPortable({ exePath: PORTABLE_EXE, currentVersion: app.getVersion(), version: update.version,
      onProgress: percent => sendUpdate({ state: 'downloading', percent }) });
    sendUpdate({ state: 'ready' });
  } catch (e) { console.error('update:', e.message); sendUpdate({ state: 'error', message: e.message }); }
  return true;
}

async function installUpdate() {
  if (update.state !== 'ready') throw new Error('no update downloaded');
  if (!PORTABLE) { autoUpdater.quitAndInstall(true, true); return true; } // silent install, then relaunch
  const files = portableFiles; portableFiles = null;
  try { await installPortable({ exePath: PORTABLE_EXE, ...files }); }
  catch (e) { portableFiles = files; sendUpdate({ state: 'error', message: `could not replace ${PORTABLE_EXE}: ${e.message}` }); return false; }
  app.quit();
  return true;
}

async function checkForUpdates(manual = false) {
  if (!UPDATES) return update;
  if (['checking', 'downloading', 'ready'].includes(update.state)) return update;
  sendUpdate({ state: 'checking', manual });
  try { await autoUpdater.checkForUpdates(); } catch (e) { sendUpdate(manual ? { state: 'error', message: e.message } : { state: 'idle' }); }
  return update;
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: '#0e0e10', title: 'TikTok Rat Trap', icon: join(HERE, 'build', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(join(HERE, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\/(www\.)?tiktok\.com\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
  win.webContents.once('did-finish-load', () => setTimeout(() => checkForUpdates(false), 3000));

  // Development aid: RATTRAP_SCREENSHOT=/path/out.png captures the window after a few seconds and quits.
  if (process.env.RATTRAP_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        if (process.env.RATTRAP_SCREENSHOT_JS) { const r = await win.webContents.executeJavaScript(process.env.RATTRAP_SCREENSHOT_JS); if (r !== undefined) console.log('screenshot js:', r); await new Promise(r => setTimeout(r, 800)); }
        const img = await win.webContents.capturePage(); writeFileSync(process.env.RATTRAP_SCREENSHOT, img.toPNG());
      }
      catch (e) { console.error('screenshot failed:', e.message); }
      app.quit();
    }, Number(process.env.RATTRAP_SCREENSHOT_DELAY) || 4000));
  }
}

app.whenReady().then(() => {
  if (!cfg) return;
  createWindow();
  if (PORTABLE) cleanupOld(dirname(PORTABLE_EXE));
  // Rooms from config, plus any given on the command line for this session only (`npm start -- someone`).
  const extra = process.argv.slice(app.isPackaged ? 1 : 2).filter(a => !a.startsWith('-'));
  for (const r of (cfg.rooms.length ? cfg.rooms : [cfg.username])) { try { persistedRooms.add(addRoom(r).room); } catch (e) { console.error(e.message); } }
  for (const r of extra) { try { addRoom(r); } catch (e) { console.error(e.message); } }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

let quitting = false;
app.on('before-quit', () => {
  if (quitting) return; quitting = true;
  for (const m of monitors.values()) { try { m.stop(); } catch (e) { console.error(e.message); } }
});
// A downloaded portable update the user never pressed Restart for still goes in when the app closes, like the installer's does.
app.on('will-quit', e => {
  if (!PORTABLE || !portableFiles) return;
  const files = portableFiles; portableFiles = null;
  e.preventDefault();
  installPortable({ exePath: PORTABLE_EXE, ...files, relaunch: false }).catch(err => console.error('update:', err.message)).finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
