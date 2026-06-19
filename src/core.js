'use strict';

/**
 * hexsweep core — pure scanning logic. No fs, no walking, no clock.
 *
 * Finds hardcoded color literals (hex + rgb/hsl functional notation) that should
 * be design tokens. The differentiation vs a raw grep lives here: comment-aware
 * blanking (but strings are KEPT, since CSS-in-JS colors live in strings), an
 * id-selector / url() gate, an allowlist, and a "definition vs usage" split that
 * exempts `--token: #fff` token definitions by default.
 *
 * Every regex uses explicit ASCII classes ([0-9A-Fa-f], never \d/\w/\s/\b) and
 * columns are counted in UTF-8 bytes, so the Node and Python builds emit
 * byte-for-byte identical output.
 */

// ---- color matching (shared explicit-class patterns) -----------------------

// Hex: 3/4/6/8 digits, longest-first; left guard blocks #id chaining / $interp /
// .class / SHAs-with-#; right guard blocks 5/7-digit runs and word continuation.
const HEX = '(?<![0-9A-Za-z_#.$-])#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})(?![0-9A-Za-z_])';
// Functional rgb()/rgba()/hsl()/hsla() — explicit case classes (no /i, avoids
// Unicode case-folding divergence), single-line argument list. The left guard
// (like HEX's) stops identifiers ending in rgb/hsl from matching (brgb(), to-hsl()).
const FUNC = '(?<![0-9A-Za-z_$@-])(?:[Rr][Gg][Bb][Aa]?|[Hh][Ss][Ll][Aa]?)\\([^)\\n]*\\)';
const COLOR_RE_SRC = `${HEX}|${FUNC}`;
function colorRegex() { return new RegExp(COLOR_RE_SRC, 'g'); }

// ---- comment blanking ------------------------------------------------------

function commentStyles(ext) {
  const e = String(ext).toLowerCase();
  const js = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(e);
  const cssPre = ['scss', 'sass', 'less'].includes(e);
  const css = e === 'css';
  const html = ['html', 'htm', 'vue', 'svelte', 'astro'].includes(e);
  return {
    // Track '/" (and ` for js) so comment openers inside strings are ignored.
    // HTML text is full of apostrophes, so don't track quotes there.
    strings: js || cssPre || css,
    template: js,
    line: js || cssPre,                    // //
    block: js || cssPre || css || html,    // /* */
    html: html,                            // <!-- -->
  };
}

/**
 * Replace comment characters with spaces (newlines preserved) so the color regex
 * never matches inside a comment, while keeping string contents intact and all
 * positions 1:1. Operates on newline-normalized text (\n only).
 *
 * @param {string} text
 * @param {string} ext
 * @returns {string}
 */
function stripComments(text, ext) {
  const st = commentStyles(ext);
  // Iterate by CODE POINT (not UTF-16 unit) so an astral char in a comment is
  // blanked to one space in both Node and Python — keeps columns byte-identical.
  const chars = Array.from(text);
  const out = [];
  let state = 'normal'; // normal | str | line | block | html
  let delim = '';
  let i = 0;
  const n = chars.length;
  const at = (k) => (k < n ? chars[k] : '');
  const blank = (c) => (c === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = chars[i];
    const c2 = at(i + 1);
    if (state === 'normal') {
      if (st.strings && (c === "'" || c === '"' || (st.template && c === '`'))) {
        state = 'str'; delim = c; out.push(c); i++; continue;
      }
      if (st.line && c === '/' && c2 === '/') { state = 'line'; out.push(' ', ' '); i += 2; continue; }
      if (st.block && c === '/' && c2 === '*') { state = 'block'; out.push(' ', ' '); i += 2; continue; }
      if (st.html && c === '<' && c2 === '!' && at(i + 2) === '-' && at(i + 3) === '-') { state = 'html'; out.push(' ', ' ', ' ', ' '); i += 4; continue; }
      out.push(c); i++; continue;
    }
    if (state === 'str') {
      if (c === '\\') { out.push(c); if (i + 1 < n) out.push(chars[i + 1]); i += 2; continue; }
      if (c === delim) { state = 'normal'; out.push(c); i++; continue; }
      out.push(c); i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'normal'; out.push('\n'); i++; continue; }
      out.push(blank(c)); i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'normal'; out.push(' ', ' '); i += 2; continue; }
      out.push(blank(c)); i++; continue;
    }
    if (state === 'html') {
      if (c === '-' && c2 === '-' && at(i + 2) === '>') { state = 'normal'; out.push(' ', ' ', ' '); i += 3; continue; }
      out.push(blank(c)); i++; continue;
    }
  }
  return out.join('');
}

// ---- text normalization ----------------------------------------------------

// Strip one leading BOM, normalize newlines to \n, split into lines.
function toLines(text) {
  let t = text;
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return t.split('\n');
}

// UTF-8 byte length of a string (parity-stable column unit).
function byteLen(s) { return Buffer.byteLength(s, 'utf8'); }

// ---- classification --------------------------------------------------------

function categoryOf(literal) {
  if (literal[0] === '#') return 'hex' + (literal.length - 1);
  const m = /^[A-Za-z]+/.exec(literal);
  return m[0].toLowerCase();
}

// Normalize a hex literal for allowlist comparison: lowercase + expand shorthand
// (#abc -> #aabbcc, #abcd -> #aabbccdd). Functional notation: lowercase, spaces removed.
function normalizeColor(lit) {
  const s = lit.toLowerCase();
  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 3 || h.length === 4) {
      return '#' + [...h].map((ch) => ch + ch).join('');
    }
    return s;
  }
  return s.replace(/[ \t]/g, '');
}

// Determine the declaration property to the left of a match, and whether the
// match is a token DEFINITION (property is a custom property / $ / @ variable).
function propertyAndDefinition(pre) {
  // last declaration fragment on the line, then the identifier left of its colon
  const frag = pre.split(/[;{]/).pop();
  const m = /([-_$@A-Za-z0-9]+)[ \t]*:[ \t]*[^:]*$/.exec(frag);
  if (!m) return { property: null, isDefinition: false };
  const property = m[1];
  const isDefinition = property.startsWith('--') || property.startsWith('$') || property.startsWith('@');
  return { property, isDefinition };
}

// Should this hex match be skipped as a CSS id-selector or a url() reference?
function isStructuralHex(pre, post) {
  // Followed by `{` => an id-selector (a color VALUE is never immediately
  // followed by `{`). Handles `#fff {`, `input:focus #fff {`, minified `}#b{`.
  if (/^[ \t]*\{/.test(post)) return true;
  // Followed by `,` => a selector list OR a value list (box-shadow). It's a
  // selector only if its own fragment (after the last , { ;) has no `:` value
  // separator — so `#a,#b {` is suppressed but `box-shadow: #a, #b` is flagged.
  if (/^[ \t]*,/.test(post) && pre.split(/[,{;]/).pop().indexOf(':') === -1) return true;
  // url(#id) / mask:url(#m) paint reference
  if (/url\([ \t]*['"]?$/.test(pre)) return true;
  return false;
}

/**
 * Scan a single file's text for hardcoded colors.
 *
 * @param {string} text   raw file text
 * @param {string} file   path to report (already normalized to forward slashes)
 * @param {string} ext    extension (no dot), lowercased
 * @param {{allow:Set<string>, strict:boolean}} opts
 * @returns {Array<object>} findings
 */
function scanText(text, file, ext, opts) {
  const allow = opts.allow || new Set();
  const strict = !!opts.strict;
  const lines = toLines(stripComments(text, ext));
  const findings = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const re = colorRegex();
    let m;
    while ((m = re.exec(line)) !== null) {
      const literal = m[0];
      const start = m.index;
      const pre = line.slice(0, start);
      const post = line.slice(start + literal.length);
      const isHex = literal[0] === '#';
      if (isHex && isStructuralHex(pre, post)) continue;
      if (allow.has(normalizeColor(literal))) continue;
      const { property, isDefinition } = propertyAndDefinition(pre);
      if (isDefinition && !strict) continue;
      findings.push({
        file,
        line: li + 1,
        column: byteLen(pre) + 1,
        literal,
        category: categoryOf(literal),
        property: property,
        isDefinition,
      });
      if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
    }
  }
  return findings;
}

// Stable order so output is identical regardless of filesystem walk order.
function sortFindings(findings) {
  return findings.slice().sort((a, b) => {
    const fa = Buffer.from(a.file, 'utf8'), fb = Buffer.from(b.file, 'utf8');
    const c = Buffer.compare(fa, fb);
    if (c !== 0) return c;
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });
}

function buildAllow(list) {
  const s = new Set();
  for (const item of list || []) {
    const t = item.trim();
    if (t) s.add(normalizeColor(t));
  }
  return s;
}

// Split a comma list, but NOT on commas inside rgb()/hsl() parens, so a
// functional color like `rgb(0,0,0)` survives as one allowlist entry.
function splitColorList(s) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of String(s)) {
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { if (depth > 0) depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---- rendering -------------------------------------------------------------

const PLAIN = { red: (s) => s, green: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s, cyan: (s) => s };

function summarize(findings, filesScanned) {
  const files = new Set(findings.map((f) => f.file));
  return { filesScanned, filesWithFindings: files.size, findingCount: findings.length };
}

function toJson(findings, summary) {
  return {
    version: 1,
    summary,
    findings: findings.map((f) => ({
      file: f.file, line: f.line, column: f.column, literal: f.literal,
      category: f.category, property: f.property, isDefinition: f.isDefinition,
    })),
  };
}

function formatReport(findings, summary, paint, opts) {
  const p = paint || PLAIN;
  const quiet = opts && opts.quiet;
  if (findings.length === 0) {
    return p.green('✓ no hardcoded colors found') + ` (${summary.filesScanned} file${summary.filesScanned === 1 ? '' : 's'} scanned)`;
  }
  const lines = [];
  if (!quiet) {
    let current = null;
    for (const f of findings) {
      if (f.file !== current) {
        if (current !== null) lines.push('');
        current = f.file;
        const n = findings.filter((x) => x.file === f.file).length;
        lines.push(p.bold(f.file) + p.dim(`  (${n})`));
      }
      const loc = p.dim(`${f.line}:${f.column}`);
      const lit = p.yellow(f.literal);
      const tag = p.cyan(`[${f.category}]`);
      const prop = f.property ? p.dim(`  ${f.property}`) : '';
      lines.push(`  ${loc}  ${lit}  ${tag}${prop}`);
    }
    lines.push('');
  }
  const fc = summary.findingCount;
  const ff = summary.filesWithFindings;
  const clean = summary.filesScanned - ff;
  lines.push(p.red(`✖ ${fc} hardcoded color${fc === 1 ? '' : 's'} in ${ff} file${ff === 1 ? '' : 's'}`) +
    p.dim(` (${clean} file${clean === 1 ? '' : 's'} clean)`));
  return lines.join('\n');
}

module.exports = {
  scanText, sortFindings, buildAllow, splitColorList, summarize, toJson, formatReport, PLAIN,
  // exported for tests
  stripComments, toLines, normalizeColor, categoryOf, propertyAndDefinition, isStructuralHex,
  byteLen, colorRegex, commentStyles,
};
