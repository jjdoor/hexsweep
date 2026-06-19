'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');

function scan(text, ext, opts) {
  opts = opts || {};
  return core.scanText(text, 'f.' + ext, ext, { allow: core.buildAllow(opts.allow || []), strict: !!opts.strict });
}
const lits = (fs) => fs.map((f) => f.literal);

test('hex lengths: 3/4/6/8 match, 5/7 rejected, word-continuation rejected', () => {
  const f = scan('a: #abc #abcd #aabbcc #aabbccdd #12345 #1234567 #deadbeef0;', 'css');
  assert.deepEqual(lits(f), ['#abc', '#abcd', '#aabbcc', '#aabbccdd']);
});

test('categories', () => {
  const f = scan('a: #abc; b: #aabb; c: #aabbcc; d: #aabbccdd; e: rgb(1,2,3); g: hsla(1,2%,3%,.4);', 'css');
  assert.deepEqual(f.map((x) => x.category), ['hex3', 'hex4', 'hex6', 'hex8', 'rgb', 'hsla']);
});

test('functional rgb/rgba/hsl/hsla with spaces, percent, slash-alpha', () => {
  const f = scan('a: rgb(255, 0, 0); b: rgba(0,0,0,.5); c: hsl(210 100% 50% / 50%);', 'scss');
  assert.deepEqual(lits(f), ['rgb(255, 0, 0)', 'rgba(0,0,0,.5)', 'hsl(210 100% 50% / 50%)']);
});

test('id-selector #fff{ is skipped but value #fff is flagged', () => {
  const f = scan('#fff { color: #fff; }', 'css');
  assert.equal(f.length, 1);
  assert.equal(f[0].column, core.byteLen('#fff { color: ') + 1);
});

test('selector list #abc, #def { is skipped; box-shadow values are flagged', () => {
  assert.equal(scan('#abc, #def { x: 1 }', 'css').length, 0);
  assert.equal(scan('a { box-shadow: 0 0 #000, 0 0 #111; }', 'css').length, 2);
});

test('url(#id) paint reference is skipped', () => {
  assert.equal(scan('a { fill: url(#a1b2c3); }', 'css').length, 0);
  assert.equal(scan('a { mask: url(#deadbe) }', 'css').length, 0);
});

test('token definitions exempt by default, flagged under --strict', () => {
  const css = ':root { --primary: #3f82f0; } .x { color: #3f82f0; }';
  assert.deepEqual(scan(css, 'css').map((x) => x.property), ['color']);
  const strict = scan(css, 'css', { strict: true });
  assert.deepEqual(strict.map((x) => x.isDefinition), [true, false]);
});

test('scss $var and less @var definitions exempt by default', () => {
  assert.equal(scan('$brand: #3f82f0;', 'scss').length, 0);
  assert.equal(scan('@brand: #3f82f0;', 'less').length, 0);
  assert.equal(scan('$brand: #3f82f0;', 'scss', { strict: true }).length, 1);
});

test('comments are blanked (css block, scss line, js line/block, html)', () => {
  assert.equal(scan('a { color: #fff; /* #deadbe */ }', 'css').length, 1);
  assert.equal(scan('a: #fff // #deadbe\n', 'scss').length, 1);
  assert.equal(scan('x; // #deadbe\nconst c = "#abc";', 'js').length, 1);
  assert.equal(scan('a /* #dead\n beef */ b: #fff;', 'css').length, 1);
  assert.equal(scan('<p>x</p><!-- #deadbe -->', 'html').length, 0);
});

test('strings are KEPT (CSS-in-JS colors flagged); // inside string is not a comment', () => {
  assert.equal(scan("const s = { color: '#abc' };", 'tsx').length, 1);     // color in string -> flagged
  assert.equal(scan('const s = `color:#abcdef`;', 'tsx').length, 1);        // template CSS-in-JS -> flagged
  assert.equal(scan('const u = "http://x#abcdef";', 'js').length, 0);       // URL fragment (# after a letter) -> not a color
});

test('column is a 1-based UTF-8 byte offset (astral-safe)', () => {
  const f = scan('x😀: #fff;', 'css'); // 😀 = 4 utf-8 bytes
  assert.equal(f.length, 1);
  assert.equal(f[0].column, core.byteLen('x😀: ') + 1);
});

test('line numbers normalize CRLF/CR', () => {
  const f = scan('a:#fff;\r\nb:#000;\rc:#111;', 'css');
  assert.deepEqual(f.map((x) => x.line), [1, 2, 3]);
});

test('allowlist normalizes case + shorthand', () => {
  assert.equal(scan('a: #FFF; b: #ffffff; c: #000;', 'css', { allow: ['#fff'] }).length, 1); // #fff & #ffffff allowed, #000 flagged
});

test('stripComments keeps positions (same length, newlines preserved)', () => {
  const src = 'a/* xx */b\n// y\nc';
  const out = core.stripComments(src, 'js');
  assert.equal(out.length, src.length);
  assert.equal(out, 'a        b\n    \nc');
});

test('normalizeColor', () => {
  assert.equal(core.normalizeColor('#ABC'), '#aabbcc');
  assert.equal(core.normalizeColor('#AbCd'), '#aabbccdd');
  assert.equal(core.normalizeColor('#A1B2C3'), '#a1b2c3');
  assert.equal(core.normalizeColor('RGB(1, 2, 3)'), 'rgb(1,2,3)');
});

test('sortFindings is byte-order by file then line/column', () => {
  const fs = [
    { file: 'b.css', line: 1, column: 1 }, { file: 'a.css', line: 2, column: 1 },
    { file: 'a.css', line: 1, column: 5 }, { file: 'a.css', line: 1, column: 2 },
  ];
  const s = core.sortFindings(fs);
  assert.deepEqual(s.map((x) => `${x.file}:${x.line}:${x.column}`), ['a.css:1:2', 'a.css:1:5', 'a.css:2:1', 'b.css:1:1']);
});

test('F1: --allow functional notation survives paren-aware split', () => {
  assert.deepEqual(core.splitColorList('#000,rgb(0,0,0),#fff'), ['#000', 'rgb(0,0,0)', '#fff']);
  assert.equal(scan('.a { color: rgb(0, 0, 0); }', 'css', { allow: ['rgb(0,0,0)'] }).length, 0);
});

test('F2: id-selector gate scoped to fragment, not whole line', () => {
  assert.equal(scan('a:hover, #beef { color: red; }', 'css').length, 0);
  assert.equal(scan('.foo::before, #abc123 { x: 1 }', 'css').length, 0);
  assert.equal(scan('input:focus #fff { x: 1 }', 'css').length, 0);
  assert.equal(scan('a:hover { color: #beef0a; }', 'css').length, 1); // real value still flagged
});

test('F3: functional regex has a left boundary', () => {
  assert.equal(scan('.a { width: brgb(0,0,0); }', 'scss').length, 0);
  assert.equal(scan('.a { x: to-hsl(10deg); }', 'scss').length, 0);
  assert.equal(scan('.a { color: rgb(0,0,0); }', 'css').length, 1);
});

test('toJson + formatReport shapes', () => {
  const f = scan('a { color: #fff; }', 'css');
  const summary = core.summarize(f, 1);
  const j = core.toJson(f, summary);
  assert.equal(j.version, 1);
  assert.deepEqual(j.summary, { filesScanned: 1, filesWithFindings: 1, findingCount: 1 });
  assert.equal(j.findings[0].literal, '#fff');
  assert.match(core.formatReport(f, summary, null, {}), /1 hardcoded color in 1 file/);
  assert.match(core.formatReport([], core.summarize([], 3), null, {}), /no hardcoded colors found/);
});
