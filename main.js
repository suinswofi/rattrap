// TikTok Rat Trap — Electron main process. Owns the room monitors and config.json; the renderer talks to
// it only through the IPC channels exposed in preload.cjs.

import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Monitor, readConfigFile, normalizeConfig, configToJSON, normalizeUsername, nameSet, roomLists } from './monitor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Running from the repo: config.json and data/ live next to the code. Packaged (AppImage, installer):
// the bundle is read-only, so they live in the per-user app data folder instead.
const APP_DIR = app.isPackaged ? app.getPath('userData') : HERE;
const CONFIG_FILE = join(APP_DIR, 'config.json');

let fileCfg, cfg;
try {
  fileCfg = readConfigFile(CONFIG_FILE);
  cfg = normalizeConfig({ ...fileCfg }, APP_DIR);
} catch (e) {
  app.whenReady().then(() => { dialog.showErrorBox('TikTok Rat Trap', `Could not read ${CONFIG_FILE}:\n${e.message}`); app.quit(); });
}

const monitors = new Map(); // room -> Monitor
const persistedRooms = new Set(); // rooms remembered in config.json (command-line rooms are session-only)
let win = null;

const send = payload => { if (win && !win.isDestroyed()) win.webContents.send('rattrap:event', payload); };

function saveConfig() {
  const out = { ...configToJSON(cfg), dataDir: fileCfg.dataDir, rooms: [...persistedRooms].filter(r => monitors.has(r)) };
  try { mkdirSync(APP_DIR, { recursive: true }); writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2)); }
  catch (e) { send({ type: 'log', room: null, entry: { t: Date.now(), kind: 'error', text: `could not save config: ${e.message}`, alert: true } }); }
}

function roomSummary(m) {
  return { room: m.username, state: m.state, message: m.stateMessage, viewers: m.room.viewers, live: m.room.live, title: m.room.title,
    seen: m.tracker.users.size, present: m.tracker.present().length, flagged: m.flagged.size };
}
const roomList = () => [...monitors.values()].map(roomSummary);

function addRoom(name) {
  const room = normalizeUsername(name);
  if (!room) throw new Error('empty username');
  if (monitors.has(room)) return roomSummary(monitors.get(room));
  const m = new Monitor(room, cfg, { peers: () => monitors.values() });
  monitors.set(room, m);
  m.on('join', ({ user }) => { for (const other of monitors.values()) if (other !== m) other.peerJoined(room, user); });
  m.on('log', entry => send({ type: 'log', room, entry }));
  m.on('status', s => send({ type: 'status', ...s, rooms: roomList() }));
  m.on('flag', f => send({ type: 'flag', ...f }));
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
  const allowed = ['idleTimeoutMinutes', 'burnerAlertScore', 'autosaveMinutes', 'signApiKey', 'reconnectWhenLive', 'livePollSeconds', 'chatHistory', 'resume', 'chatToFile', 'eventsToFile', 'pruneAfterDays'];
  const next = { ...cfg };
  for (const k of allowed) if (patch && patch[k] !== undefined) next[k] = patch[k];
  normalizeConfig(next, null); // throws on bad values; dataDir already absolute
  Object.assign(cfg, next);
  for (const m of monitors.values()) m.tracker.timeoutMs = cfg.idleTimeoutMinutes * 60_000;
  saveConfig();
  return configToJSON(cfg);
});
ipcMain.handle('rooms:list', () => roomList());
ipcMain.handle('rooms:add', (_e, name) => { const r = addRoom(name); persistedRooms.add(r.room); saveConfig(); send({ type: 'rooms', rooms: roomList() }); return r; });
ipcMain.handle('rooms:remove', (_e, name) => { const r = removeRoom(name); persistedRooms.delete(normalizeUsername(name)); saveConfig(); send({ type: 'rooms', rooms: roomList() }); return r; });
ipcMain.handle('rooms:reconnect', (_e, name) => { getMonitor(name).reconnect(); return true; });
ipcMain.handle('room:snapshot', (_e, name) => getMonitor(name).snapshot());
ipcMain.handle('room:detail', (_e, name, id) => getMonitor(name).detail(id));
ipcMain.handle('room:log', (_e, name) => getMonitor(name).logLines);
ipcMain.handle('room:chat', (_e, name) => getMonitor(name).recentChat);
ipcMain.handle('room:flags', (_e, name) => [...getMonitor(name).flagged.values()]);
ipcMain.handle('room:save', (_e, name) => getMonitor(name).save());
ipcMain.handle('room:dismiss', (_e, name, users) => getMonitor(name).dismiss(Array.isArray(users) ? users : [users]));
ipcMain.handle('room:undismiss', (_e, name, users) => getMonitor(name).undismiss(Array.isArray(users) ? users : [users]));
ipcMain.handle('list:edit', (_e, room, list, op, names) => {
  if (!['watch', 'blacklist', 'pinned'].includes(list)) throw new Error('unknown list');
  const lists = roomLists(cfg, room);
  const set = lists[list];
  for (const n of nameSet(Array.isArray(names) ? names : String(names).split(/[\s,]+/))) op === 'remove' ? set.delete(n) : set.add(n);
  saveConfig();
  send({ type: 'lists', room: normalizeUsername(room), watch: [...lists.watch], blacklist: [...lists.blacklist], pinned: [...lists.pinned] });
  return [...set];
});
ipcMain.handle('open:data', () => shell.openPath(cfg.dataDir));
ipcMain.handle('open:external', (_e, url) => {
  if (!/^https:\/\/(www\.)?tiktok\.com\//.test(String(url))) throw new Error('refusing to open non-TikTok URL');
  return shell.openExternal(url);
});

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

  // Development aid: RATTRAP_SCREENSHOT=/path/out.png captures the window after a few seconds and quits.
  if (process.env.RATTRAP_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        if (process.env.RATTRAP_SCREENSHOT_JS) { await win.webContents.executeJavaScript(process.env.RATTRAP_SCREENSHOT_JS); await new Promise(r => setTimeout(r, 800)); }
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
app.on('window-all-closed', () => app.quit());
