import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { nextPortableName, pickPortableAsset, fetchPortableAsset, downloadFile, downloadPortable, installPortable, cleanupOld, OLD_SUFFIX } from './portable-update.js';

const dir = () => mkdtempSync(join(tmpdir(), 'rattrap-upd-'));
const sha = buf => createHash('sha256').update(buf).digest('hex');
const body = buf => Readable.from([buf.subarray(0, Math.ceil(buf.length / 2)), buf.subarray(Math.ceil(buf.length / 2))]);
const okResponse = (buf, headers = {}) => ({ ok: true, status: 200, body: body(buf), headers: new Map(Object.entries({ 'content-length': String(buf.length), ...headers })) });

test('nextPortableName bumps the version in the file name and leaves other names alone', () => {
  assert.equal(nextPortableName('TikTok-Rat-Trap-1.1.0-portable.exe', '1.1.0', '1.2.0'), 'TikTok-Rat-Trap-1.2.0-portable.exe');
  assert.equal(nextPortableName('rattrap.exe', '1.1.0', '1.2.0'), 'rattrap.exe');
  assert.equal(nextPortableName('rattrap.exe', '', '1.2.0'), 'rattrap.exe');
});

test('pickPortableAsset finds the portable exe among the release assets', () => {
  const assets = [{ name: 'latest.yml' }, { name: 'TikTok-Rat-Trap-1.2.0-setup.exe' }, { name: 'TikTok-Rat-Trap-1.2.0-portable.exe' }, { name: 'x.AppImage' }];
  assert.equal(pickPortableAsset(assets).name, 'TikTok-Rat-Trap-1.2.0-portable.exe');
  assert.equal(pickPortableAsset([{ name: 'latest.yml' }]), null);
  assert.equal(pickPortableAsset(undefined), null);
});

test('fetchPortableAsset reads url and sha256 digest from the GitHub release, and refuses without a checksum', async () => {
  const asset = { name: 'TikTok-Rat-Trap-1.2.0-portable.exe', size: 5, digest: 'sha256:' + 'AB'.repeat(32), browser_download_url: 'https://example/p.exe' };
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push(url); return { ok: true, json: async () => ({ assets: [asset] }) }; };
  const got = await fetchPortableAsset('1.2.0', fetchFn);
  assert.deepEqual(got, { url: 'https://example/p.exe', size: 5, sha256: 'ab'.repeat(32), name: asset.name });
  assert.match(calls[0], /releases\/tags\/v1\.2\.0$/);
  await assert.rejects(fetchPortableAsset('1.2.0', async () => ({ ok: true, json: async () => ({ assets: [{ ...asset, digest: undefined }] }) })), /no checksum/);
  await assert.rejects(fetchPortableAsset('1.2.0', async () => ({ ok: true, json: async () => ({ assets: [] }) })), /no portable exe/);
  await assert.rejects(fetchPortableAsset('1.2.0', async () => ({ ok: false, status: 404 })), /404/);
});

test('downloadFile streams to disk, reports progress and verifies the checksum', async () => {
  const d = dir(); const data = Buffer.from('hello portable world');
  const dest = join(d, 'new.exe'); const progress = [];
  await downloadFile('https://example/p.exe', dest, { sha256: sha(data), onProgress: p => progress.push(p), fetchFn: async () => okResponse(data) });
  assert.equal(readFileSync(dest, 'utf8'), 'hello portable world');
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.length >= 2 && progress[0] < 100, `progress should be reported along the way: ${progress}`);
});

test('downloadFile deletes a corrupt or failed download', async () => {
  const d = dir(); const data = Buffer.from('hello');
  const dest = join(d, 'new.exe');
  await assert.rejects(downloadFile('u', dest, { sha256: sha(Buffer.from('other')), fetchFn: async () => okResponse(data) }), /corrupt/);
  assert.ok(!existsSync(dest));
  await assert.rejects(downloadFile('u', dest, { fetchFn: async () => ({ ok: false, status: 500 }) }), /HTTP 500/);
  assert.ok(!existsSync(dest));
});

test('downloadPortable puts the new exe next to the running one under the bumped name', async () => {
  const d = dir(); const data = Buffer.from('v2');
  const exePath = join(d, 'TikTok-Rat-Trap-1.1.0-portable.exe'); writeFileSync(exePath, 'v1');
  const asset = { name: 'TikTok-Rat-Trap-1.2.0-portable.exe', size: 2, digest: 'sha256:' + sha(data), browser_download_url: 'https://example/p.exe' };
  const fetchFn = async url => url.includes('api.github.com') ? { ok: true, json: async () => ({ assets: [asset] }) } : okResponse(data);
  const r = await downloadPortable({ exePath, currentVersion: '1.1.0', version: '1.2.0', fetchFn });
  assert.equal(r.finalPath, join(d, 'TikTok-Rat-Trap-1.2.0-portable.exe'));
  assert.equal(r.tmp, r.finalPath + '.download');
  assert.equal(readFileSync(r.tmp, 'utf8'), 'v2');
});

test('installPortable moves the running exe aside, puts the new one in place, starts it; cleanupOld removes the old copy', async () => {
  const d = dir();
  const exePath = join(d, 'TikTok-Rat-Trap-1.1.0-portable.exe'); writeFileSync(exePath, 'v1');
  const finalPath = join(d, 'TikTok-Rat-Trap-1.2.0-portable.exe'); const tmp = finalPath + '.download'; writeFileSync(tmp, 'v2');
  const spawned = [];
  const spawnFn = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; };
  await installPortable({ exePath, tmp, finalPath, spawnFn });
  assert.deepEqual(readdirSync(d).sort(), ['TikTok-Rat-Trap-1.1.0-portable' + OLD_SUFFIX, 'TikTok-Rat-Trap-1.2.0-portable.exe']);
  assert.equal(readFileSync(finalPath, 'utf8'), 'v2');
  assert.equal(spawned.length, 1); assert.equal(spawned[0].cmd, finalPath); assert.equal(spawned[0].opts.detached, true);
  await cleanupOld(d);
  assert.deepEqual(readdirSync(d), ['TikTok-Rat-Trap-1.2.0-portable.exe']);
});

test('installPortable with the same file name replaces it in place, and puts the old exe back if the swap fails', async () => {
  const d = dir();
  const exePath = join(d, 'rattrap.exe'); writeFileSync(exePath, 'v1');
  const tmp = exePath + '.download'; writeFileSync(tmp, 'v2');
  let spawned = 0;
  await installPortable({ exePath, tmp, finalPath: exePath, relaunch: false, spawnFn: () => { spawned++; return { unref() {} }; } });
  assert.equal(readFileSync(exePath, 'utf8'), 'v2'); assert.equal(spawned, 0);
  await cleanupOld(d);
  // the downloaded file is missing: the running exe must be restored under its own name
  await assert.rejects(installPortable({ exePath, tmp: join(d, 'missing.download'), finalPath: exePath, spawnFn: () => ({ unref() {} }) }));
  assert.deepEqual(readdirSync(d), ['rattrap.exe']);
  assert.equal(readFileSync(exePath, 'utf8'), 'v2');
});
