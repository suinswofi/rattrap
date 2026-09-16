// Self-update for the Windows portable build. electron-updater only knows how to replace the installed app
// and the AppImage, so the portable exe fetches the new exe from the GitHub release itself, checks it against
// the sha256 digest GitHub publishes for every release asset, and swaps it into place when the app restarts.
// No Electron imports here so the pieces can be tested with plain Node.
import { createWriteStream } from 'node:fs';
import { rename, unlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

export const OLD_SUFFIX = '.old-rattrap.exe'; // the replaced exe is moved aside under this name until the next start
const API = 'https://api.github.com/repos/suinswofi/rattrap/releases/tags/';
const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'rattrap-updater' };

export const pickPortableAsset = assets => (assets ?? []).find(a => /-portable\.exe$/i.test(a.name ?? '')) ?? null;

// Keeps the user's file name, bumping the version number in it if there is one:
// "TikTok-Rat-Trap-1.1.0-portable.exe" -> "TikTok-Rat-Trap-1.2.0-portable.exe", "rattrap.exe" stays "rattrap.exe".
export function nextPortableName(currentName, currentVersion, newVersion) {
  return currentVersion && currentName.includes(currentVersion) ? currentName.replace(currentVersion, newVersion) : currentName;
}

// Where the new exe is and what it should hash to, from the release's asset list.
export async function fetchPortableAsset(version, fetchFn = fetch) {
  const r = await fetchFn(`${API}v${version}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} when asked about release v${version}`);
  const asset = pickPortableAsset((await r.json()).assets);
  if (!asset) throw new Error(`release v${version} has no portable exe`);
  const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '');
  if (!m) throw new Error('GitHub published no checksum for the download');
  return { url: asset.browser_download_url, size: asset.size, sha256: m[1].toLowerCase(), name: asset.name };
}

// Streams `url` to `dest`, reporting progress as a whole percentage, and verifies the checksum.
// A failed or corrupt download is deleted.
export async function downloadFile(url, dest, { sha256, size, onProgress = () => {}, fetchFn = fetch } = {}) {
  const r = await fetchFn(url, { headers: { 'user-agent': HEADERS['user-agent'] } });
  if (!r.ok || !r.body) throw new Error(`download failed: HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || size || 0;
  const hash = createHash('sha256');
  let got = 0, last = -1;
  const meter = new Transform({ transform(chunk, _enc, cb) {
    hash.update(chunk); got += chunk.length;
    const pct = total ? Math.min(100, Math.floor(got * 100 / total)) : 0;
    if (pct !== last) { last = pct; onProgress(pct, got, total); }
    cb(null, chunk);
  } });
  try {
    await pipeline(r.body instanceof Readable ? r.body : Readable.fromWeb(r.body), meter, createWriteStream(dest));
    if (sha256 && hash.digest('hex') !== sha256) throw new Error('downloaded file is corrupt (checksum mismatch)');
  } catch (e) { await unlink(dest).catch(() => {}); throw e; }
  return dest;
}

// Downloads the release's portable exe next to the running one. Returns the temporary file and the
// name it will take once installed.
export async function downloadPortable({ exePath, currentVersion, version, onProgress, fetchFn }) {
  const asset = await fetchPortableAsset(version, fetchFn);
  const finalPath = join(dirname(exePath), nextPortableName(basename(exePath), currentVersion, version));
  const tmp = `${finalPath}.download`;
  await downloadFile(asset.url, tmp, { sha256: asset.sha256, size: asset.size, onProgress, fetchFn });
  return { tmp, finalPath };
}

// Windows lets a running exe be renamed but not deleted or overwritten. So the running one is moved aside,
// the new one takes its place, and (unless `relaunch` is false) is started; the caller then quits.
// The moved-aside copy is deleted by cleanupOld() on the next start, once nothing runs from it any more.
export async function installPortable({ exePath, tmp, finalPath, relaunch = true, spawnFn = spawn }) {
  const old = exePath.replace(/\.exe$/i, '') + OLD_SUFFIX;
  await rename(exePath, old);
  try { await rename(tmp, finalPath); }
  catch (e) { await rename(old, exePath).catch(() => {}); throw e; }
  if (relaunch) spawnFn(finalPath, [], { detached: true, stdio: 'ignore', cwd: dirname(finalPath) }).unref();
  return finalPath;
}

export async function cleanupOld(dir) {
  for (const f of await readdir(dir).catch(() => [])) if (f.endsWith(OLD_SUFFIX)) await unlink(join(dir, f)).catch(() => {});
}
