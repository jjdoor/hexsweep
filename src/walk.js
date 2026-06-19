'use strict';

const fs = require('fs');
const path = require('path');

/**
 * hexsweep IO — directory walking and file reading. No scanning logic.
 *
 * Both builds must discover the SAME set of files (findings are sorted by path
 * afterwards, so visit order doesn't affect output — but the file SET must match):
 * identical ignore dirs, identical extension filter, identical symlink policy
 * (never follow), and identical "skip non-UTF-8 / binary" policy.
 */

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  'coverage', '.next', '.nuxt', 'vendor', '.cache',
]);

const DEFAULT_EXTS = [
  'css', 'scss', 'sass', 'less', 'vue', 'svelte',
  'jsx', 'tsx', 'js', 'ts', 'html', 'htm', 'astro',
];

function toPosix(p) {
  const s = p.split(path.sep).join('/');
  return s.startsWith('./') ? s.slice(2) : s; // normalize `.`-root like Node path.join does
}

function collectFiles(roots, exts, excludeDirs) {
  const extSet = new Set(exts.map((e) => e.toLowerCase()));
  const ignore = new Set([...IGNORE_DIRS, ...(excludeDirs || [])]);
  const out = [];

  function visit(p, isRoot) {
    let st;
    try { st = isRoot ? fs.statSync(p) : fs.lstatSync(p); } catch (e) { return; }
    if (!isRoot && st.isSymbolicLink()) return; // never follow symlinks during recursion
    if (st.isDirectory()) {
      if (!isRoot && ignore.has(path.basename(p))) return;
      let entries;
      try { entries = fs.readdirSync(p); } catch (e) { return; }
      entries.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
      for (const e of entries) visit(path.join(p, e), false);
    } else if (st.isFile()) {
      const ext = path.extname(p).slice(1).toLowerCase();
      if (extSet.has(ext)) out.push(p);
    }
  }

  for (const r of roots) visit(r, true);
  return out;
}

// Read a file as UTF-8 text, or null if it's binary / not valid UTF-8 (skipped
// identically in both builds: Python decode('utf-8') would raise; here we detect
// invalid bytes by a round-trip re-encode comparison).
function readFileText(p) {
  let buf;
  try { buf = fs.readFileSync(p); } catch (e) { return null; }
  if (buf.includes(0)) return null; // NUL byte -> binary
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) return null; // invalid UTF-8
  return text;
}

module.exports = { IGNORE_DIRS, DEFAULT_EXTS, toPosix, collectFiles, readFileText };
