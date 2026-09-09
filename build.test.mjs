// Guards the packaged build: every local module reachable from the entry points must be
// covered by the electron-builder `files` list, or the installed app crashes on startup
// (that is exactly what happened when demo.js was added without listing it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const patterns = pkg.build.files;

// Minimal matcher for the pattern styles used in package.json: "*.ext", "!*.ext", "dir/**/*", "name".
function included(file) {
  let ok = false;
  for (const p of patterns) {
    const neg = p.startsWith('!'); const pat = neg ? p.slice(1) : p;
    let m;
    if (pat.endsWith('/**/*')) m = file.startsWith(pat.slice(0, -4));
    else if (pat.startsWith('*.')) m = !file.includes('/') && file.endsWith(pat.slice(1));
    else m = file === pat;
    if (m) ok = !neg;
  }
  return ok;
}

function localImports(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:from|import|require\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const dep = normalize(join(dirname(file), m[1]));
    assert.ok(existsSync(dep), `${file} imports ${m[1]} which does not exist`);
    localImports(dep, seen);
  }
  return seen;
}

test('every module the packaged app imports is in build.files', () => {
  const files = new Set([...localImports('main.js'), ...localImports('preload.cjs')]);
  for (const f of files) assert.ok(included(f), `${f} is imported by the app but not covered by build.files ${JSON.stringify(patterns)}`);
  for (const f of ['renderer/index.html', 'renderer/app.js', 'renderer/style.css', 'renderer/icon.png', 'package.json']) assert.ok(included(f), `${f} not covered`);
  for (const f of ['monitor.test.mjs', 'history.test.mjs']) assert.ok(!included(f), `${f} should not be shipped`);
});
