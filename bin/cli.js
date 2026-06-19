#!/usr/bin/env node
'use strict';

const core = require('../src/core.js');
const walk = require('../src/walk.js');
const VERSION = require('../package.json').version;

process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const mkPaint = (on) => {
  const col = (c, s) => (on ? `\x1b[${c}m${s}\x1b[0m` : s);
  return {
    red: (s) => col('31', s), green: (s) => col('32', s), yellow: (s) => col('33', s),
    dim: (s) => col('2', s), bold: (s) => col('1', s), cyan: (s) => col('36', s),
  };
};

const HELP = `${mkPaint(useColor).bold('hexsweep')} — find hardcoded colors that should be design tokens. Zero dependencies.

Scans your source for raw color literals (#hex, rgb()/hsl()) that escaped a
design-token migration — the \`background: #3f82f0\` that should be \`var(--primary)\`.
Token definitions (\`--primary: #3f82f0\`) are allowed by default; usages are flagged.

${mkPaint(useColor).bold('Usage')}
  hexsweep [path...]          Scan paths (default: current directory)
  hexsweep src/ --json        Machine-readable output, for CI

${mkPaint(useColor).bold('Options')}
  --ext css,scss,tsx     Override the scanned extension set
  --allow "#000,#fff"    Allowlist literals that are OK to hardcode
  --strict               Also flag token DEFINITIONS (--x/$x/@x), not just usages
  --exclude dirA,dirB    Extra directory names to skip (node_modules/.git/dist… already skipped)
  --json                 JSON output (byte-identical across the Node and Python builds)
  --quiet                Only print the summary line
  --no-color             Disable ANSI color
  --help | --version

${mkPaint(useColor).bold('Exit')}  0 clean · 1 hardcoded colors found · 2 error
`;

function main() {
  const argv = process.argv.slice(2);
  const ddIdx = argv.indexOf('--');
  const pre = ddIdx === -1 ? argv : argv.slice(0, ddIdx);
  if (pre.includes('-h') || pre.includes('--help')) { process.stdout.write(HELP); return 0; }
  if (pre.includes('-v') || pre.includes('--version')) { process.stdout.write(VERSION + '\n'); return 0; }

  let asJson = false, strict = false, quiet = false, noColor = false;
  let exts = null, allowList = [], excludeDirs = [];
  const roots = [];
  let dd = false;
  const takeValue = (inline, i) => (inline !== null ? inline : argv[i + 1]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (dd) { roots.push(a); continue; }
    if (a === '--') { dd = true; continue; }
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq !== -1 ? a.slice(0, eq) : a;
    const inline = a.startsWith('--') && eq !== -1 ? a.slice(eq + 1) : null;
    if (flag === '--json') { asJson = true; continue; }
    if (flag === '--strict') { strict = true; continue; }
    if (flag === '--quiet') { quiet = true; continue; }
    if (flag === '--no-color') { noColor = true; continue; }
    if (flag === '--ext') { exts = (takeValue(inline, i) || '').split(',').map((s) => s.trim().replace(/^\.+/, '')).filter(Boolean); if (inline === null) i++; continue; }
    if (flag === '--allow') { allowList = allowList.concat(core.splitColorList(takeValue(inline, i) || '')); if (inline === null) i++; continue; }
    if (flag === '--exclude') { excludeDirs = excludeDirs.concat((takeValue(inline, i) || '').split(',').map((s) => s.trim()).filter(Boolean)); if (inline === null) i++; continue; }
    if (a === '-h' || a === '--help' || a === '-v' || a === '--version') continue;
    if (a.startsWith('-') && a !== '-') { die(`unknown option: ${a} (use -- to end options)`); }
    roots.push(a);
  }

  if (roots.length === 0) roots.push('.');
  const scanExts = exts && exts.length ? exts : walk.DEFAULT_EXTS;
  const allow = core.buildAllow(allowList);
  const paint = mkPaint(useColor && !noColor);

  let files;
  try { files = walk.collectFiles(roots, scanExts, excludeDirs); } catch (e) { die(e.message); }

  let findings = [];
  for (const f of files) {
    const text = walk.readFileText(f);
    if (text === null) continue;
    const ext = (f.split('.').pop() || '').toLowerCase();
    findings = findings.concat(core.scanText(text, walk.toPosix(f), ext, { allow, strict }));
  }
  findings = core.sortFindings(findings);
  const summary = core.summarize(findings, files.length);

  if (asJson) {
    process.stdout.write(JSON.stringify(core.toJson(findings, summary), null, 2) + '\n');
  } else {
    process.stdout.write(core.formatReport(findings, summary, paint, { quiet }) + '\n');
  }
  return findings.length > 0 ? 1 : 0;
}

function die(msg) { process.stderr.write(mkPaint(useColor).red(`hexsweep: ${msg}\n`)); process.exit(2); }

process.exit(main());
